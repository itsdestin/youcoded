// Extras: opaque blobs filed by the SHA-256 of their bytes (split out of store.ts to keep it inside its line budget). No locking
// THE INDEPENDENT RECORD (review 4, F2): a blob file that is DELETED looks exactly like one that was never stored, so the store also keeps extras/manifest.bin, a
// run of checksummed 37-byte records (add or remove, one hash each). An extra recorded as stored whose file is gone is REPORTED (`corrupt`), never read as "never had it".
// A truncated, damaged or missing manifest loses only that evidence (every blob is still there); it is rebuilt from the folder the first time it is read in a run.
// No locking here: ChatStore serialises every call. A file that does not hash to its name is never served and never deleted (review N6).
import * as nodePath from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirDurable, sweepTemps, writeFileAtomic, type Fs } from './fsio';
import { StoreError } from './errors';
import { crc32, isHash64 } from './chain';
import { isDiskFull } from './storeutil';
import type { BodyTools } from './recovery';

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** Bytes of every file under `path` (a file, or a folder walked recursively). */
export async function bytesUnder(fs: Fs, tools: BodyTools, path: string): Promise<number> {
  let names: string[];
  try { names = await fs.readdir(path); } catch { return await tools.fileSize(path).catch(() => 0); }
  let total = 0;
  for (const n of names) total += await bytesUnder(fs, tools, nodePath.join(path, n));
  return total;
}

const MANIFEST = 'manifest.bin';
const MREC = 37;

export class Extras {
  private total: number | null = null;
  private manifestSet: Set<string> | null = null;
  private readonly swept = new Set<string>();
  constructor(private readonly fs: Fs, private readonly tools: BodyTools, private readonly root: string, private readonly maxOne: number, private readonly maxTotal: number) {}

  path(h: string): string {
    if (!isHash64(h)) throw new StoreError('bad-argument', 'extra hash must be 64 lowercase hex');
    return nodePath.join(this.root, 'extras', h.slice(0, 2), h);
  }
  private manifestPath(): string { return nodePath.join(this.root, 'extras', MANIFEST); }
  private async appendManifest(op: 1 | 2, hash: string): Promise<void> {
    const rec = Buffer.alloc(MREC); rec[0] = op; Buffer.from(hash, 'hex').copy(rec, 1); rec.writeUInt32BE(crc32(rec, 0, 33), 33);
    await mkdirDurable(this.fs, nodePath.join(this.root, 'extras'));
    const created = !(await this.fs.exists(this.manifestPath()));
    const f = await this.fs.open(this.manifestPath(), { create: true });
    try { await f.write(rec, Math.floor((await f.size()) / MREC) * MREC); await f.sync(); } finally { await f.close(); }   // DESTRUCTIVE-OK(hint): appends one record at the first whole-record boundary; only a half-written tail record can be overwritten
    if (created) await this.fs.fsyncDir(nodePath.join(this.root, 'extras'));
  }
  /** The hashes recorded as stored. Read once per run; blobs found in the folder but missing from the record are added (a truncated or deleted manifest loses nothing real). */
  private async manifest(): Promise<Set<string>> {
    if (this.manifestSet) return this.manifestSet;
    const set = new Set<string>();
    const b = await this.fs.readFile(this.manifestPath());
    if (b) for (let at = 0; at + MREC <= b.length; at += MREC) {
      if (crc32(b, at, at + 33) !== b.readUInt32BE(at + 33) || (b[at] !== 1 && b[at] !== 2)) continue;
      const h = b.subarray(at + 1, at + 33).toString('hex');
      if (b[at] === 1) set.add(h); else set.delete(h);
    }
    this.manifestSet = set;
    try {
      for (const d of await this.fs.readdir(nodePath.join(this.root, 'extras'))) {
        if (!/^[0-9a-f]{2}$/.test(d)) continue;
        for (const n of await this.fs.readdir(nodePath.join(this.root, 'extras', d))) if (/^[0-9a-f]{64}$/.test(n) && !set.has(n)) { await this.appendManifest(1, n); set.add(n); }
      }
    } catch (e) { if (!isDiskFull(e)) throw e; }   // a read never fails for lack of space; the next put or read adds them
    return set;
  }
  has(hash: string): Promise<boolean> { return this.fs.exists(this.path(hash)); }

  /**
   * The extra's bytes, checked against the hash that names them (N6). A file that does not hash to its name is moved to
   * extras-bad/ (kept) and reported as `corrupt` once; after that the extra reads as absent, so a peer's copy can be fetched
   * and `put` stores it. Null when there is none.
   */
  async read(hash: string): Promise<Buffer | null> {
    const p = this.path(hash);
    // the record is loaded (and rebuilt from the folder when it lost something) on the FIRST read of a run, whether or not this blob is there
    const recorded = await this.manifest();
    const b = await this.fs.readFile(p);
    if (!b) {
      if (recorded.has(hash)) throw new StoreError('corrupt', `extra ${hash.slice(0, 8)} was stored but its file is gone`);
      return null;
    }
    if (sha(b) !== hash) { await this.quarantine(p, hash); throw new StoreError('corrupt', `extra ${hash.slice(0, 8)} did not match its hash and was set aside`); }
    return b;
  }
  private async quarantine(path: string, hash: string): Promise<void> {
    const bad = nodePath.join(this.root, 'extras-bad');
    await mkdirDurable(this.fs, bad);
    let n = 1; while (await this.fs.exists(nodePath.join(bad, `${hash}-${n}`))) n++;
    // DESTRUCTIVE-OK(kept-copy-first): the extra's name is its SHA-256 and the bytes failed it (checked by the caller); moved to a NEW name in extras-bad/, kept
    await this.fs.rename(path, nodePath.join(bad, `${hash}-${n}`));
    await this.fs.fsyncDir(bad); await this.fs.fsyncDir(nodePath.dirname(path));
    // the rotted file is reported ONCE (the caller throws) and then the extra reads as absent until a peer's copy is put: the record forgets it
    const m = await this.manifest();
    if (m.has(hash)) { await this.appendManifest(2, hash); m.delete(hash); }
  }
  /** Argument checks that must reject before anything is queued. */
  check(hash: string, bytes: Uint8Array): void {
    this.path(hash);
    if (bytes.length > this.maxOne) throw new StoreError('limit', `extra of ${bytes.length} bytes exceeds the ${this.maxOne} byte cap`);
    if (sha(bytes) !== hash) throw new StoreError('bad-argument', 'extra bytes do not match their hash');
  }
  async put(hash: string, bytes: Uint8Array): Promise<'stored' | 'present'> {
    const path = this.path(hash);
    if (await this.fs.exists(path)) {
      // N6: "present" must mean present AND intact. A rotted file is set aside and replaced by the correct bytes.
      const have = await this.fs.readFile(path);
      if (have && sha(have) === hash) { const m = await this.manifest(); if (!m.has(hash)) { await this.appendManifest(1, hash); m.add(hash); } return 'present'; }
      await this.quarantine(path, hash);
    }
    const total = await this.bytes();
    if (total + bytes.length > this.maxTotal) throw new StoreError('limit', `extras would reach ${total + bytes.length} bytes, past the ${this.maxTotal} byte cap`);
    const dir = nodePath.dirname(path);
    await mkdirDurable(this.fs, dir);
    // interrupted writes into an extras folder are swept the first time it is written to in this run (L9)
    if (!this.swept.has(dir)) { await sweepTemps(this.fs, dir); this.swept.add(dir); }
    // DESTRUCTIVE-OK(verified-record): the target is absent or was just moved to extras-bad/ because it did not match its hash; the new bytes were checked against it
    await writeFileAtomic(this.fs, path, bytes);
    this.total = total + bytes.length;
    // the record second: a kill between the two leaves a blob nothing remembers, which is harmless (it is added back when the record is next read)
    const m = await this.manifest(); if (!m.has(hash)) { await this.appendManifest(1, hash); m.add(hash); }
    return 'stored';
  }
  /** Total bytes under extras/ (scanned once per open, then kept by put). */
  async bytes(): Promise<number> {
    if (this.total === null) this.total = await bytesUnder(this.fs, this.tools, nodePath.join(this.root, 'extras'));
    return this.total;
  }
}
