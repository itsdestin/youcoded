// Control-log STORAGE. Entries are opaque signed blobs; nothing here verifies a signature, decides who
// the host is or reads an entry's meaning (that is `decide`, owned by another workstream).
//
// What the store does need to know about an entry, supplied by the caller in an envelope:
//   id    the entry's own id (64 hex) - for duplicate detection
//   chat  which chat's log it belongs to
//   seen  ids of entries the author had seen (design 6.2 `seen`); an entry whose `seen` ids are not all
//         stored yet is PARKED and applied when they arrive, so a stored log is always causally closed
//   body  the whole encoded, signed entry, kept byte for byte
// AMBIGUITY resolved here: S2 says `appendControl -> ok | parked | duplicate` without saying what parks.
// Causal gaps via `seen` are the only reading that needs no interpretation of `body`.
import * as nodePath from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirDurable, sweepTemps, writeFileAtomic, type Fs } from './fsio';
import { StoreError } from './errors';
import { crc32, isHash64 } from './chain';

export interface ControlEntry {
  id: string;
  chat: string;
  seen: string[];
  body: Uint8Array;
}

const MAX_BODY = 4 * 1024 * 1024;
const MAX_SEEN = 1024;
const DEFAULT_MAX_PARKED = 1024;
const TORN_KEEP = 8;

function checkEntry(e: ControlEntry): void {
  if (!e || !isHash64(e.id)) throw new StoreError('bad-argument', 'entry id must be 64 lowercase hex');
  if (typeof e.chat !== 'string' || e.chat.length < 1 || e.chat.length > 1024) throw new StoreError('bad-argument', 'chat');
  if (!Array.isArray(e.seen) || e.seen.length > MAX_SEEN || !e.seen.every(isHash64)) throw new StoreError('bad-argument', 'seen');
  if (!(e.body instanceof Uint8Array) || e.body.length > MAX_BODY) throw new StoreError('bad-argument', 'body');
  // WHY (review M3): dedup is decided HERE, so an early forged body filed under a real id would make the
  // real entry later come back as `duplicate`. The id must be the SHA-256 of the body it names. A self
  // reference in `seen` would park forever, and a cycle is impossible because an id cannot name a body
  // that contains its own hash.
  if (createHash('sha256').update(e.body).digest('hex') !== e.id) throw new StoreError('bad-argument', 'entry id is not the SHA-256 of its body');
  if (e.seen.includes(e.id)) throw new StoreError('bad-argument', 'an entry cannot list itself in seen');
}

function encode(e: ControlEntry): Buffer {
  const chat = Buffer.from(e.chat, 'utf8');
  const head = Buffer.alloc(32 + 2); Buffer.from(e.id, 'hex').copy(head, 0); head.writeUInt16BE(e.seen.length, 32);
  const seen = Buffer.concat(e.seen.map((s) => Buffer.from(s, 'hex')));
  const cl = Buffer.alloc(4); cl.writeUInt32BE(chat.length);
  return Buffer.concat([head, seen, cl, chat, Buffer.from(e.body.buffer, e.body.byteOffset, e.body.byteLength)]);
}
function decode(p: Buffer): ControlEntry | null {
  if (p.length < 38) return null;
  const id = p.subarray(0, 32).toString('hex'); const n = p.readUInt16BE(32);
  let at = 34; const seen: string[] = [];
  if (p.length < at + n * 32 + 4) return null;
  for (let i = 0; i < n; i++) { seen.push(p.subarray(at, at + 32).toString('hex')); at += 32; }
  const cl = p.readUInt32BE(at); at += 4;
  if (p.length < at + cl) return null;
  return { id, seen, chat: p.subarray(at, at + cl).toString('utf8'), body: Buffer.from(p.subarray(at + cl)) };
}
const frame = (payload: Buffer): Buffer => { const h = Buffer.alloc(8); h.writeUInt32BE(payload.length); h.writeUInt32BE(crc32(payload), 4); return Buffer.concat([h, payload]); };

interface ChatLog { dir: string; ids: Set<string>; entries: ControlEntry[]; size: number; parked: Map<string, string[]> }

export class ControlStore {
  private readonly cache = new Map<string, ChatLog>();
  private readonly maxParked: number;
  constructor(private readonly fs: Fs, private readonly root: string, o: { maxParked?: number } = {}) { this.maxParked = o.maxParked ?? DEFAULT_MAX_PARKED; }

  private dirOf(chat: string): string { return nodePath.join(this.root, createHash('sha256').update(chat, 'utf8').digest('hex')); }

  /**
   * Read a chat's log. A record that was cut off (fewer bytes than it declares: a kill mid-append, never
   * acknowledged) is removed, its bytes kept in torn-N.bin. A record that is COMPLETE but fails its
   * checksum is not a torn append: nothing is cut, the log reports `damaged` and every byte stays (C1/M3).
   */
  private async load(chat: string): Promise<ChatLog> {
    const hit = this.cache.get(chat);
    if (hit) return hit;
    const dir = this.dirOf(chat);
    await mkdirDurable(this.fs, dir);
    await sweepTemps(this.fs, dir); await sweepTemps(this.fs, nodePath.join(dir, 'parked'));
    const path = nodePath.join(dir, 'log.bin');
    const f = await this.fs.open(path, { create: true });
    const entries: ControlEntry[] = []; const ids = new Set<string>(); let good = 0;
    let torn: Buffer | null = null;
    try {
      const size = await f.size();
      const buf = size ? await f.read(0, size) : Buffer.alloc(0);
      while (good < buf.length) {
        if (good + 8 > buf.length) break; // a header cut off
        const len = buf.readUInt32BE(good);
        if (len > MAX_BODY + 64 * 1024) throw new StoreError('damaged', 'control log: a record declares an impossible length');
        if (good + 8 + len > buf.length) break; // the payload cut off: a torn final record
        const payload = buf.subarray(good + 8, good + 8 + len);
        if (crc32(payload) !== buf.readUInt32BE(good + 4)) throw new StoreError('damaged', 'control log: a complete record fails its checksum');
        const e = decode(payload);
        if (!e) throw new StoreError('damaged', 'control log: a complete record cannot be decoded');
        entries.push(e); ids.add(e.id); good += 8 + len;
      }
      if (good !== size) { torn = Buffer.from(buf.subarray(good)); await this.keepTorn(dir, torn); await f.truncate(good); await f.sync(); }
    } finally { await f.close(); }
    await this.fs.fsyncDir(dir);
    const log: ChatLog = { dir, ids, entries, size: good, parked: new Map() };
    // remember what is parked (the parked folder is read once here, never per append: M3 quadratic)
    for (const n of await this.fs.readdir(nodePath.join(dir, 'parked'))) {
      if (!n.endsWith('.ent')) continue;
      const e = await this.readParked(nodePath.join(dir, 'parked', n));
      if (e) log.parked.set(e.id, e.seen);
    }
    this.cache.set(chat, log);
    // finish applying parked entries whose causes are now present (a kill after an apply but before the unlink)
    await this.drain(chat, log);
    return log;
  }

  private async keepTorn(dir: string, data: Buffer): Promise<void> {
    let max = 0; const names = (await this.fs.readdir(dir)).filter((n) => /^torn-\d+\.bin$/.test(n));
    for (const n of names) max = Math.max(max, parseInt(n.slice(5), 10));
    await writeFileAtomic(this.fs, nodePath.join(dir, `torn-${max + 1}.bin`), data);
    names.push(`torn-${max + 1}.bin`);
    names.sort((a, b) => parseInt(a.slice(5), 10) - parseInt(b.slice(5), 10));
    for (const n of names.slice(0, Math.max(0, names.length - TORN_KEEP))) await this.fs.unlink(nodePath.join(dir, n));
  }

  /** A log reported `damaged`: move log.bin aside (kept) and start empty. Returns the kept file's name. */
  async quarantine(chat: string): Promise<string> {
    this.cache.delete(chat);
    const dir = this.dirOf(chat);
    let n = 1; while (await this.fs.exists(nodePath.join(dir, `quarantine-${n}.bin`))) n++;
    const name = `quarantine-${n}.bin`;
    await this.fs.rename(nodePath.join(dir, 'log.bin'), nodePath.join(dir, name));
    await this.fs.fsyncDir(dir);
    return name;
  }

  async log(chat: string): Promise<ControlEntry[]> { return [...(await this.safe(chat, (l) => l.entries))]; }

  async parked(chat: string): Promise<ControlEntry[]> {
    const log = await this.safe(chat, (l) => l);
    const out: ControlEntry[] = [];
    for (const n of (await this.fs.readdir(nodePath.join(log.dir, 'parked'))).sort()) {
      if (!n.endsWith('.ent')) continue;
      const e = await this.readParked(nodePath.join(log.dir, 'parked', n));
      if (e) out.push(e);
    }
    return out;
  }

  private async safe<T>(chat: string, fn: (l: ChatLog) => T): Promise<T> {
    try { return fn(await this.load(chat)); } catch (e) { this.cache.delete(chat); throw e; }
  }

  async append(e: ControlEntry): Promise<'ok' | 'parked' | 'duplicate'> {
    checkEntry(e);
    try {
      const log = await this.load(e.chat);
      if (log.ids.has(e.id)) return 'duplicate';
      if (!e.seen.every((s) => log.ids.has(s))) {
        if (log.parked.has(e.id)) return 'parked';
        if (log.parked.size >= this.maxParked) throw new StoreError('parked-full', `${log.parked.size} parked control entries`);
        const pdir = nodePath.join(log.dir, 'parked');
        await mkdirDurable(this.fs, pdir);
        await writeFileAtomic(this.fs, nodePath.join(pdir, `${e.id}.ent`), frame(encode(e)));
        log.parked.set(e.id, e.seen);
        return 'parked';
      }
      await this.apply(log, e);
      await this.drain(e.chat, log);
      return 'ok';
    } catch (err) { this.cache.delete(e.chat); throw err; }
  }

  /** Append one record: written and fsynced before it counts; memory updated only afterwards. */
  private async apply(log: ChatLog, e: ControlEntry): Promise<void> {
    const rec = frame(encode(e));
    const f = await this.fs.open(nodePath.join(log.dir, 'log.bin'), { create: false });
    try { await f.write(rec, log.size); await f.sync(); } finally { await f.close(); }
    log.size += rec.length; log.ids.add(e.id); log.entries.push(e);
  }

  private async readParked(path: string): Promise<ControlEntry | null> {
    const b = await this.fs.readFile(path);
    if (!b || b.length < 8) return null;
    const len = b.readUInt32BE(0);
    if (8 + len !== b.length || crc32(b.subarray(8)) !== b.readUInt32BE(4)) return null;
    return decode(b.subarray(8));
  }

  /** Apply parked entries whose `seen` are all present; repeat until none applies. Works from memory: only an entry that can apply is read from disk. */
  private async drain(chat: string, log: ChatLog): Promise<void> {
    const pdir = nodePath.join(log.dir, 'parked');
    for (;;) {
      let progressed = false;
      for (const [id, seen] of [...log.parked].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const path = nodePath.join(pdir, `${id}.ent`);
        if (log.ids.has(id)) { await this.fs.unlink(path); await this.fs.fsyncDir(pdir); log.parked.delete(id); progressed = true; continue; }
        if (!seen.every((s) => log.ids.has(s))) continue;
        const e = await this.readParked(path);
        if (!e) { log.parked.delete(id); continue; } // damaged parked file: left in place, never deleted
        await this.apply(log, e);
        await this.fs.unlink(path); await this.fs.fsyncDir(pdir);
        log.parked.delete(id);
        progressed = true;
      }
      if (!progressed) return;
    }
    void chat;
  }
}
