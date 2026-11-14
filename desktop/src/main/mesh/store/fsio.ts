// The only door the store uses to touch the disk.
//
// WHY an interface instead of `node:fs` calls: the store promises to reopen correctly after a kill at
// ANY point. The only way to test that for every write, rename and fsync is to be able to make the Nth
// operation fail. The tests wrap this interface in a fault-injecting shim (fault-fs.ts); production
// uses `realFs`. Every operation that changes the disk is one call here, so "fail after N operations,
// for all N" covers every boundary.
import * as fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import * as nodePath from 'node:path';

export interface FileLike {
  /** Write all of `buf` at absolute `pos`. */
  write(buf: Uint8Array, pos: number): Promise<void>;
  /** Read up to `len` bytes at `pos`; returns the bytes actually read (short at end of file). */
  read(pos: number, len: number): Promise<Buffer>;
  size(): Promise<number>;
  truncate(len: number): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface Fs {
  /** Open for read+write, creating the file when `create` is set. Never follows a final symlink. */
  open(path: string, opts: { create: boolean }): Promise<FileLike>;
  /** Read a whole (small) file, or null when it does not exist. */
  readFile(path: string): Promise<Buffer | null>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  /** fsync a directory so creations, renames and unlinks inside it are durable. */
  fsyncDir(path: string): Promise<void>;
}

class RealFile implements FileLike {
  constructor(private readonly fh: FileHandle) {}
  async write(buf: Uint8Array, pos: number): Promise<void> {
    let done = 0;
    while (done < buf.length) {
      const { bytesWritten } = await this.fh.write(buf, done, buf.length - done, pos + done);
      done += bytesWritten;
    }
  }
  async read(pos: number, len: number): Promise<Buffer> {
    const b = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
      const { bytesRead } = await this.fh.read(b, got, len - got, pos + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return got === len ? b : b.subarray(0, got);
  }
  async size(): Promise<number> { return (await this.fh.stat()).size; }
  // DESTRUCTIVE-OK(door): the Fs door itself; every caller carries its own reason
  truncate(len: number): Promise<void> { return this.fh.truncate(len); }
  sync(): Promise<void> { return this.fh.sync(); }
  close(): Promise<void> { return this.fh.close(); }
}

// WHY the named constants and not numbers: O_CREAT and friends have different values on macOS and Windows.
const C = fsp.constants;
const NOFOLLOW = C.O_NOFOLLOW ?? 0;

export const realFs: Fs = {
  async open(path, { create }) {
    // WHY O_NOFOLLOW: the store's paths are computed from validated ids, but a symlink planted at a
    // store path must not redirect a write elsewhere (design 5.3 import validation). 0 on Windows.
    const fh = await fsp.open(path, C.O_RDWR | (create ? C.O_CREAT : 0) | NOFOLLOW, 0o600);
    return new RealFile(fh);
  },
  async readFile(path) {
    try { return await fsp.readFile(path); } catch (e: any) { if (e.code === 'ENOENT') return null; throw e; }
  },
  async readdir(path) {
    try { return await fsp.readdir(path); } catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
  },
  async exists(path) { try { await fsp.lstat(path); return true; } catch { return false; } },
  // WHY not recursive: a durable directory needs its PARENT fsynced after each level is created, and the
  // caller (mkdirDurable below) creates one level at a time so it can do exactly that.
  async mkdir(path) { try { await fsp.mkdir(path, { mode: 0o700 }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; } },
  // DESTRUCTIVE-OK(door): the Fs door itself; every caller carries its own reason
  rename: (a, b) => fsp.rename(a, b),
  // DESTRUCTIVE-OK(door): the Fs door itself; every caller carries its own reason
  async unlink(path) { try { await fsp.unlink(path); } catch (e: any) { if (e.code !== 'ENOENT') throw e; } },
  async fsyncDir(path) {
    // Directories cannot be opened for fsync on Windows; there (only) the call is a no-op (UNVERIFIED there).
    // WHY not swallow errors elsewhere (review L1): on Linux/macOS an EINVAL/ENOTSUP/EPERM would mean this
    // file system cannot make directory entries durable, and silently carrying on would void every
    // "acknowledged means durable" promise. Better to fail the operation loudly.
    let fh: FileHandle | undefined;
    try { fh = await fsp.open(path, 'r'); await fh.sync(); }
    catch (e: any) { if (!(process.platform === 'win32' && ['EISDIR', 'EPERM', 'EACCES', 'EINVAL'].includes(e.code))) throw e; }
    finally { await fh?.close(); }
  },
};

/**
 * Create a directory (and any missing parents, one level at a time) and make every new entry durable by
 * fsyncing the parent after each level (review M2). WHY: on POSIX a directory entry is only durable once
 * its parent directory is fsynced; without this an acknowledged result (a parked append, a tail, an
 * extra, a control entry) could vanish with its whole new folder after a power cut.
 */
export async function mkdirDurable(fs: Fs, path: string): Promise<void> {
  if (await fs.exists(path)) return;
  const parent = nodePath.dirname(path);
  if (parent !== path) await mkdirDurable(fs, parent);
  await fs.mkdir(path);
  await fs.fsyncDir(parent);
}

/**
 * Atomic whole-file write: temp file, fsync, rename over the target, fsync the directory. A kill
 * leaves either the old file or the new one, never half (and a stray `.tmp-` file that open() sweeps).
 */
export async function writeFileAtomic(fs: Fs, path: string, data: Uint8Array): Promise<void> {
  const dir = nodePath.dirname(path);
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}`;
  const f = await fs.open(tmp, { create: true });
  try { await f.write(data, 0); await f.sync(); } finally { await f.close(); }
  // DESTRUCTIVE-OK(door): replaces the target atomically (the old file or the new one survives a kill); callers say why replacing is safe
  await fs.rename(tmp, path);
  await fs.fsyncDir(dir);
}
let tmpCounter = 0;

/** Remove leftover `*.tmp-*` files in a directory (an interrupted atomic write). */
export async function sweepTemps(fs: Fs, dir: string): Promise<void> {
  // DESTRUCTIVE-OK(scratch): a `.tmp-` file is an interrupted atomic write; the file it was going to replace is untouched
  for (const name of await fs.readdir(dir)) if (/\.tmp-\d+-\d+$/.test(name)) await fs.unlink(nodePath.join(dir, name));
}
