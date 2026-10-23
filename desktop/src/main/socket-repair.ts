// Re-creating a Unix socket file that was deleted while the app runs.
//
// WHY (2026-10-22): something deleted the live app's hook socket file in shared
// /tmp while the app kept running, and every new session sat on "Initializing
// session…" until a restart. The app's long-lived sockets (hook relay, Browser
// relay, askpass) each check their file at session start and re-listen if it is
// gone. macOS also clears temp files untouched for days, so a Mac left open for
// days is exposed the same way.
import fs from 'fs';
import net from 'net';
import path from 'path';
import { log } from './logger';

/**
 * If `socketPath` no longer exists, listens a NEW server (from `createServer`)
 * at it and returns that server; otherwise returns null and changes nothing.
 *
 * The caller must keep its old server OPEN (never close it while running):
 * closing a Unix socket server deletes whatever file is at its path at that
 * moment — the new one (checked 2026-10-22). Closing both at quit is fine.
 *
 * `stillWanted` is re-checked after the awaits: if the owner stopped meanwhile
 * (a session created as the app quits), the new server is closed here instead
 * of outliving shutdown and holding the process open (review finding).
 *
 * Never deletes anything. Safe to call concurrently: listen() refuses a path
 * that exists, so a second caller (or another program's file that appeared in
 * between) just gets null.
 */
export async function relistenIfDeleted(
  socketPath: string | null | undefined,
  createServer: () => net.Server,
  opts: { fileMode?: number; platform?: NodeJS.Platform; stillWanted?: () => boolean } = {},
): Promise<net.Server | null> {
  if (!socketPath || (opts.platform ?? process.platform) === 'win32') return null; // named pipes have no file
  try {
    await fs.promises.lstat(socketPath);
    return null; // still there — the normal case
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
  }
  // The folder may have gone too; 0700 applies only to folders this creates.
  const dir = path.dirname(socketPath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => undefined);
  if (!(await folderIsSafe(dir))) {
    log('WARN', 'SocketRepair', 'socket folder is not private to this user — not re-creating the socket', { path: socketPath });
    return null;
  }
  const server = createServer();
  const ok = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(socketPath, () => resolve(true));
  });
  if (!ok) { server.close(); return null; } // never bound, so this deletes nothing
  // WHY permanent: once 'error' above is spent, a later accept error (EMFILE)
  // would be an unhandled 'error' event and throw in the main process.
  server.on('error', (err) => log('WARN', 'SocketRepair', 'socket server error', { path: socketPath, error: String(err) }));
  if (opts.fileMode !== undefined) await fs.promises.chmod(socketPath, opts.fileMode).catch(() => undefined);
  if (opts.stillWanted && !opts.stillWanted()) { server.close(); return null; }
  return server;
}

/** WHY: if the folder was deleted and someone else re-created it first, a socket
 *  inside it could be swapped by them (review finding). Accept a folder this user
 *  owns that nobody else can enter, or a sticky shared one like /tmp, where other
 *  users cannot delete or rename our file. */
async function folderIsSafe(dir: string): Promise<boolean> {
  try {
    const st = await fs.promises.lstat(dir);
    if (!st.isDirectory()) return false;
    if (st.mode & 0o1000) return true;
    const uid = typeof process.getuid === 'function' ? process.getuid() : st.uid;
    return st.uid === uid && (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}
