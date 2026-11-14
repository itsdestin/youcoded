// Extras: opaque blobs filed by the SHA-256 of their bytes (split out of store.ts to keep it inside its line budget). No locking
// here: ChatStore serialises every call. A file that does not hash to its name is never served and never deleted (review N6).
import * as nodePath from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirDurable, sweepTemps, writeFileAtomic, type Fs } from './fsio';
import { StoreError } from './errors';
import { isHash64 } from './chain';
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

export class Extras {
  private total: number | null = null;
  private readonly swept = new Set<string>();
  constructor(private readonly fs: Fs, private readonly tools: BodyTools, private readonly root: string, private readonly maxOne: number, private readonly maxTotal: number) {}

  path(h: string): string {
    if (!isHash64(h)) throw new StoreError('bad-argument', 'extra hash must be 64 lowercase hex');
    return nodePath.join(this.root, 'extras', h.slice(0, 2), h);
  }
  has(hash: string): Promise<boolean> { return this.fs.exists(this.path(hash)); }

  /**
   * The extra's bytes, checked against the hash that names them (N6). A file that does not hash to its name is moved to
   * extras-bad/ (kept) and reported as `corrupt` once; after that the extra reads as absent, so a peer's copy can be fetched
   * and `put` stores it. Null when there is none.
   */
  async read(hash: string): Promise<Buffer | null> {
    const p = this.path(hash);
    const b = await this.fs.readFile(p);
    if (!b) return null;
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
      if (have && sha(have) === hash) return 'present';
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
    return 'stored';
  }
  /** Total bytes under extras/ (scanned once per open, then kept by put). */
  async bytes(): Promise<number> {
    if (this.total === null) this.total = await bytesUnder(this.fs, this.tools, nodePath.join(this.root, 'extras'));
    return this.total;
  }
}
