// Control-log STORAGE. Entries are opaque signed blobs; nothing here verifies a signature, decides who
// the host is or reads an entry's meaning (that is `decide`, owned by another workstream).
//
// What the store does need to know about an entry, supplied by the caller in an envelope:
//   id    the entry's own id (64 hex) - for duplicate detection
//   chat  which chat's log it belongs to
//   seen  ids of entries the author had seen (design 6.2 `seen`); an entry whose `seen` ids are not all
//         stored yet is PARKED and applied when they arrive, so a stored log is always causally closed
//   body  the whole encoded, signed entry, kept byte for byte
// On disk (N2): log.bin is a run of records `magic | len | payload crc | header crc | payload`. A record is TORN only when its
// header is intact and its payload runs past the end of the file (or fewer than 16 header bytes remain): it is cut and its
// bytes kept in torn-N.bin. Any other unreadable record is DAMAGE: skipped, reported by `damage()`, never cut; the next valid
// record is found by its magic and every later entry is served. Nothing kept is ever pruned; at 1,024 torn files writes are refused.
// AMBIGUITY resolved here: S2 says `appendControl -> ok | parked | duplicate` without saying what parks.
// Causal gaps via `seen` are the only reading that needs no interpretation of `body`.
import * as nodePath from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirDurable, sweepTemps, writeFileAtomic, type Fs } from './fsio';
import { StoreError } from './errors';
import { crc32, isHash64 } from './chain';
import { isDiskFull } from './storeutil';

export interface ControlEntry {
  id: string;
  chat: string;
  seen: string[];
  body: Uint8Array;
}

const MAX_BODY = 4 * 1024 * 1024;
const MAX_SEEN = 1024;
const DEFAULT_MAX_PARKED = 1024;
/** Cap on kept torn-N.bin files per chat. At the cap nothing is pruned and nothing is cut: new writes are refused loudly (N2). */
const MAX_TORN_FILES = 1024;
/** A log record: magic 'YCL1' | len u32 | payload crc u32 | header crc u32 (over the first 12 bytes) | payload. */
const LOG_MAGIC = Buffer.from('YCL1', 'ascii');
const LOG_HDR = 16;

/** One byte range of log.bin that could not be read as a record and was skipped (N2). The bytes stay in the file. */
export interface ControlDamage { offset: number; length: number; why: string }

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
/** Parked files are whole files written atomically, so they keep the plain 8-byte frame (no torn state exists). */
const frame = (payload: Buffer): Buffer => { const h = Buffer.alloc(8); h.writeUInt32BE(payload.length); h.writeUInt32BE(crc32(payload), 4); return Buffer.concat([h, payload]); };
/**
 * WHY a header checksum and a magic (review N2): with only `len | crc(payload)`, one flipped bit in `len` that
 * made the record look longer than the file was read as "a torn final record" and silently cut every later
 * acknowledged entry. The header CRC makes a damaged length detectable, so "torn" can mean exactly one thing:
 * an intact header whose payload runs past the end of the file (or fewer than 16 bytes of header). The magic
 * lets the reader find the next record after a bad one instead of giving up on the rest.
 */
function frameRecord(payload: Buffer): Buffer {
  const h = Buffer.alloc(LOG_HDR);
  LOG_MAGIC.copy(h, 0); h.writeUInt32BE(payload.length, 4); h.writeUInt32BE(crc32(payload), 8);
  h.writeUInt32BE(crc32(h, 0, 12), 12);
  return Buffer.concat([h, payload]);
}

type RecordRead = { kind: 'ok'; entry: ControlEntry; end: number } | { kind: 'torn' } | { kind: 'bad'; why: string; end: number | null };
function readRecord(buf: Buffer, pos: number): RecordRead {
  const left = buf.length - pos;
  if (left < LOG_HDR) {
    // a header cut off mid-write is a prefix of the intended header; anything else is not a torn append
    return buf.subarray(pos, pos + Math.min(left, 4)).equals(LOG_MAGIC.subarray(0, Math.min(left, 4))) ? { kind: 'torn' } : { kind: 'bad', why: 'bad record marker', end: null };
  }
  if (!buf.subarray(pos, pos + 4).equals(LOG_MAGIC)) return { kind: 'bad', why: 'bad record marker', end: null };
  if (crc32(buf, pos, pos + 12) !== buf.readUInt32BE(pos + 12)) return { kind: 'bad', why: 'record header checksum', end: null };
  const len = buf.readUInt32BE(pos + 4);
  if (len > MAX_BODY + 64 * 1024) return { kind: 'bad', why: 'impossible record length', end: null };
  if (pos + LOG_HDR + len > buf.length) return { kind: 'torn' };           // intact header, payload cut off
  const end = pos + LOG_HDR + len;
  const payload = buf.subarray(pos + LOG_HDR, end);
  if (crc32(payload) !== buf.readUInt32BE(pos + 8)) return { kind: 'bad', why: 'record payload checksum', end };
  const e = decode(payload);
  if (!e) return { kind: 'bad', why: 'record cannot be decoded', end };
  // the entry id must name the body it carries (also checked on the way in); a record that does not is not trusted
  if (createHash('sha256').update(e.body).digest('hex') !== e.id) return { kind: 'bad', why: 'entry id is not the SHA-256 of its body', end };
  return { kind: 'ok', entry: e, end };
}
/** The next offset after `from` where a whole, valid record starts, or -1. Only runs after damage. */
function resync(buf: Buffer, from: number): number {
  for (let at = buf.indexOf(LOG_MAGIC, from); at !== -1; at = buf.indexOf(LOG_MAGIC, at + 1)) {
    if (readRecord(buf, at).kind === 'ok') return at;
  }
  return -1;
}

interface ChatLog { dir: string; ids: Set<string>; entries: ControlEntry[]; size: number; parked: Map<string, string[]>; damage: ControlDamage[]; refuseWrites: string | null; /** a torn tail starts here in log.bin but could not be copied aside yet (disk full): the next write does that first */ tornPending: number | null }

const allZero = (b: Buffer, from: number, to: number): boolean => { for (let i = from; i < to; i++) if (b[i] !== 0) return false; return true; };

export class ControlStore {
  private readonly cache = new Map<string, ChatLog>();
  private readonly maxParked: number;
  constructor(private readonly fs: Fs, private readonly root: string, o: { maxParked?: number } = {}) { this.maxParked = o.maxParked ?? DEFAULT_MAX_PARKED; }

  private dirOf(chat: string): string { return nodePath.join(this.root, createHash('sha256').update(chat, 'utf8').digest('hex')); }

  /**
   * Read a chat's log. Only ONE thing is a torn append: the very last record, whose header is intact but whose
   * payload runs past the end of the file, or a header cut short. It is removed and its bytes kept in
   * torn-N.bin. Anything else that does not parse (a flipped bit in a length, a bad checksum, garbage) is
   * DAMAGE (N2): the record is skipped, the reader resumes at the next valid record, every later entry is
   * kept and served, the bad range is reported by `damage()`, and log.bin is never cut or rewritten.
   */
  private async load(chat: string): Promise<ChatLog> {
    const hit = this.cache.get(chat);
    if (hit) return hit;
    const dir = this.dirOf(chat);
    await mkdirDurable(this.fs, dir);
    await sweepTemps(this.fs, dir); await sweepTemps(this.fs, nodePath.join(dir, 'parked'));
    const path = nodePath.join(dir, 'log.bin');
    const f = await this.fs.open(path, { create: true });
    const entries: ControlEntry[] = []; const ids = new Set<string>(); const damage: ControlDamage[] = []; let size = 0;
    let refuseWrites: string | null = null; let tornPending: number | null = null;
    try {
      size = await f.size();
      const buf = size ? await f.read(0, size) : Buffer.alloc(0);
      let pos = 0; let tornFrom: number | null = null;
      while (pos < buf.length) {
        const r = readRecord(buf, pos);
        if (r.kind === 'ok') { if (!ids.has(r.entry.id)) { entries.push(r.entry); ids.add(r.entry.id); } pos = r.end; continue; }
        if (r.kind === 'torn') { tornFrom = pos; break; }
        // damage: resume after this record when its own header said where it ends, else look for the next record
        const next = r.end !== null ? r.end : resync(buf, pos + 1);
        const stop = next === -1 ? buf.length : next;
        // WHY (review 3, F6): a tail of zero bytes with no valid record after it is the usual shape of a power cut (the file size was saved, the data was not).
        // That is a torn write, not damage: cut it (kept) instead of reporting it for ever. Anything that is NOT all zeros could be an acknowledged entry whose
        // marker rotted, so it stays reported damage and is never cut.
        if (stop === buf.length && allZero(buf, r.kind === 'bad' && r.end !== null ? pos + LOG_HDR : pos, buf.length)) { tornFrom = pos; break; }
        damage.push({ offset: pos, length: stop - pos, why: r.why });
        pos = stop;
      }
      if (tornFrom !== null) {
        try {
          const kept = await this.keepTorn(dir, Buffer.from(buf.subarray(tornFrom)));
          // DESTRUCTIVE-OK(kept-copy-first): the cut-off bytes were copied to torn-N.bin (fsynced) just above
          if (kept) { await f.truncate(tornFrom); await f.sync(); size = tornFrom; }
          else refuseWrites = `${MAX_TORN_FILES} torn-write files are already kept for this chat`;
        } catch (e) {
          // WHY (review 3, F7): reading must not need free space. The entries before the torn tail are served; the copy-and-cut is done before the next write.
          if (!isDiskFull(e)) throw e;
          tornPending = tornFrom; size = tornFrom;
        }
      }
    } finally { await f.close(); }
    await this.fs.fsyncDir(dir);
    const log: ChatLog = { dir, ids, entries, size, parked: new Map(), damage, refuseWrites, tornPending };
    // remember what is parked (the parked folder is read once here, never per append: M3 quadratic)
    for (const n of await this.fs.readdir(nodePath.join(dir, 'parked'))) {
      if (!n.endsWith('.ent')) continue;
      const e = await this.readParked(nodePath.join(dir, 'parked', n));
      if (e) log.parked.set(e.id, e.seen);
    }
    this.cache.set(chat, log);
    // finish applying parked entries whose causes are now present (a kill after an apply but before the unlink)
    // WHY tolerant (review 3, F7): applying a parked entry writes; a read must not fail because the disk is full. The next append retries it.
    if (!refuseWrites && tornPending === null) { try { await this.drain(chat, log); } catch (e) { if (!isDiskFull(e)) throw e; } }
    return log;
  }

  /**
   * Keep the cut-off bytes. WHY no pruning (N2/N17): a torn tail can be a real acknowledged entry whose header
   * was damaged in a way that looked torn on some other file system; deleting the oldest kept file is deleting
   * data nobody proved redundant. At the cap this returns false and the caller refuses writes loudly instead.
   */
  private async keepTorn(dir: string, data: Buffer): Promise<boolean> {
    let max = 0; const names = (await this.fs.readdir(dir)).filter((n) => /^torn-\d+\.bin$/.test(n));
    if (names.length >= MAX_TORN_FILES) return false;
    for (const n of names) max = Math.max(max, parseInt(n.slice(5), 10));
    await writeFileAtomic(this.fs, nodePath.join(dir, `torn-${max + 1}.bin`), data); // DESTRUCTIVE-OK(kept-copy-first): a NEW name (max + 1), nothing replaced
    return true;
  }

  /** A log reported `damaged`: move log.bin aside (kept) and start empty. Returns the kept file's name. */
  async quarantine(chat: string): Promise<string> {
    this.cache.delete(chat);
    const dir = this.dirOf(chat);
    let n = 1; while (await this.fs.exists(nodePath.join(dir, `quarantine-${n}.bin`))) n++;
    const name = `quarantine-${n}.bin`;
    // DESTRUCTIVE-OK(explicit-request): the caller asked for the log to be set aside; it moves to a name that does not exist, bytes kept
    await this.fs.rename(nodePath.join(dir, 'log.bin'), nodePath.join(dir, name));
    await this.fs.fsyncDir(dir);
    return name;
  }

  /** Byte ranges of this chat's log that could not be read and were skipped (empty when the log is clean). They stay in log.bin. */
  async damage(chat: string): Promise<ControlDamage[]> { return [...(await this.safe(chat, (l) => l.damage))]; }

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
      if (log.refuseWrites) throw new StoreError('limit', log.refuseWrites);
      if (log.tornPending !== null) await this.settleTorn(log);
      if (!e.seen.every((s) => log.ids.has(s))) {
        if (log.parked.has(e.id)) return 'parked';
        if (log.parked.size >= this.maxParked) throw new StoreError('parked-full', `${log.parked.size} parked control entries`);
        const pdir = nodePath.join(log.dir, 'parked');
        await mkdirDurable(this.fs, pdir);
        await writeFileAtomic(this.fs, nodePath.join(pdir, `${e.id}.ent`), frame(encode(e))); // DESTRUCTIVE-OK(verified-record): the file name is the entry id; the same id means the same body (checked in checkEntry), a rewrite replaces identical bytes
        log.parked.set(e.id, e.seen);
        return 'parked';
      }
      await this.apply(log, e);
      await this.drain(e.chat, log);
      return 'ok';
    } catch (err) { this.cache.delete(e.chat); throw err; }
  }

  /** Copy a torn tail that could not be copied while reading (disk full) and cut it. Throws the typed error again while it still cannot. */
  private async settleTorn(log: ChatLog): Promise<void> {
    const f = await this.fs.open(nodePath.join(log.dir, 'log.bin'), { create: false });
    try {
      const from = log.tornPending!; const size = await f.size();
      if (size > from) {
        if (!(await this.keepTorn(log.dir, await f.read(from, size - from)))) throw new StoreError('limit', `${MAX_TORN_FILES} torn-write files are already kept for this chat`);
        // DESTRUCTIVE-OK(kept-copy-first): the cut-off bytes were copied to torn-N.bin (fsynced) just above
        await f.truncate(from); await f.sync();
      }
      log.tornPending = null;
    } finally { await f.close(); }
  }

  /** Append one record: written and fsynced before it counts; memory updated only afterwards. */
  private async apply(log: ChatLog, e: ControlEntry): Promise<void> {
    const rec = frameRecord(encode(e));
    const f = await this.fs.open(nodePath.join(log.dir, 'log.bin'), { create: false });
    try { await f.write(rec, log.size); await f.sync(); } finally { await f.close(); }
    log.size += rec.length; log.ids.add(e.id); log.entries.push(e);
  }

  private async readParked(path: string): Promise<ControlEntry | null> {
    const b = await this.fs.readFile(path);
    if (!b || b.length < 8) return null;
    const len = b.readUInt32BE(0);
    if (8 + len !== b.length || crc32(b.subarray(8)) !== b.readUInt32BE(4)) return null;
    const e = decode(b.subarray(8));
    return e && createHash('sha256').update(e.body).digest('hex') === e.id ? e : null;
  }

  /** Apply parked entries whose `seen` are all present; repeat until none applies. Works from memory: only an entry that can apply is read from disk. */
  private async drain(chat: string, log: ChatLog): Promise<void> {
    const pdir = nodePath.join(log.dir, 'parked');
    for (;;) {
      let progressed = false;
      for (const [id, seen] of [...log.parked].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const path = nodePath.join(pdir, `${id}.ent`);
        // DESTRUCTIVE-OK(verified-record): the entry is already in the log (log.ids is built from checksummed records), so the parked copy is redundant
        if (log.ids.has(id)) { await this.fs.unlink(path); await this.fs.fsyncDir(pdir); log.parked.delete(id); progressed = true; continue; }
        if (!seen.every((s) => log.ids.has(s))) continue;
        const e = await this.readParked(path);
        if (!e) { log.parked.delete(id); continue; } // damaged parked file: left in place, never deleted
        await this.apply(log, e);
        // DESTRUCTIVE-OK(verified-record): the entry passed its CRC and id check when read above and apply() returned after fsyncing it into the log
        await this.fs.unlink(path); await this.fs.fsyncDir(pdir);
        log.parked.delete(id);
        progressed = true;
      }
      if (!progressed) return;
    }
    void chat;
  }
}
