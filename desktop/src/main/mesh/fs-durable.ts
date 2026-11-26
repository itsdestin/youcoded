// Durable file helpers for the mesh: "fsynced before any acknowledgement" (design S2, 6.1).
//
// WHY not atomic-write.ts: that helper renames but never fsyncs, so a power cut after the rename can leave an
// empty file. Mesh files (keys, roster, receiver state) must be on disk before anything is acknowledged.
// All calls are asynchronous (the main process has one thread; tests/main-blocking-calls.test.ts).
import fs from 'fs';
import path from 'path';

/** Make a private folder (0700 where the OS supports it). */
export async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
}

/** fsync a folder so a rename or a new file in it survives a crash. Not supported on Windows: ignored there. */
export async function syncDir(dir: string): Promise<void> {
  let h: fs.promises.FileHandle | undefined;
  try {
    h = await fs.promises.open(dir, 'r');
    await h.sync();
  } catch (e) {
    // WHY only Windows may ignore it (review of the silent catches): on Linux and macOS a failed directory fsync means the rename or new file may NOT survive a crash, so it must fail loudly like the chat store's own
    // fsyncDir (store/fsio.ts). Windows cannot open a directory at all (EISDIR/EPERM/EACCES/EINVAL); the rename is still atomic there.
    if (!(process.platform === 'win32' && ['EISDIR', 'EPERM', 'EACCES', 'EINVAL'].includes((e as { code?: string }).code ?? ''))) throw e;
  } finally {
    await h?.close();
  }
}

let seq = 0;
/**
 * Replace a file atomically and durably: write a temp file (mode set at creation, so a secret is never
 * readable even for an instant), fsync it, rename over the target, fsync the folder. A reader sees the old
 * whole file or the new whole file. `mode` defaults to owner-only.
 */
export async function writeFileDurable(target: string, bytes: Uint8Array, mode = 0o600): Promise<void> {
  const dir = path.dirname(target);
  await ensureDir(dir);
  const tmp = `${target}.tmp.${process.pid}.${seq++}`;
  const h = await fs.promises.open(tmp, 'wx', mode);
  try {
    await h.writeFile(bytes);
    await h.sync();
  } catch (e) {
    await h.close();
    await fs.promises.rm(tmp, { force: true });
    throw e;
  }
  await h.close();
  try {
    await fs.promises.rename(tmp, target);
  } catch (e) {
    await fs.promises.rm(tmp, { force: true });
    throw e;
  }
  await syncDir(dir);
}

/** Read a whole file, or undefined if it does not exist. Any other error is thrown. */
export async function readFileIfExists(file: string): Promise<Buffer | undefined> {
  try {
    return await fs.promises.readFile(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}
