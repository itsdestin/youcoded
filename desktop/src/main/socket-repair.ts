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

/**
 * If `socketPath` no longer exists, listens a NEW server (from `createServer`)
 * at it and returns that server; otherwise returns null and changes nothing.
 *
 * The caller must keep its old server OPEN (never close it while running):
 * closing a Unix socket server deletes whatever file is at its path at that
 * moment — the new one (checked 2026-10-22). Closing both at quit is fine.
 *
 * Never deletes anything. Safe to call concurrently: listen() refuses a path
 * that exists, so a second caller (or another program's file that appeared in
 * between) just gets null.
 */
export async function relistenIfDeleted(
  socketPath: string | null | undefined,
  createServer: () => net.Server,
  opts: { fileMode?: number; platform?: NodeJS.Platform } = {},
): Promise<net.Server | null> {
  if (!socketPath || (opts.platform ?? process.platform) === 'win32') return null; // named pipes have no file
  try {
    await fs.promises.lstat(socketPath);
    return null; // still there — the normal case
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
  }
  // The folder may have gone too; 0700 applies only to folders this creates.
  await fs.promises.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 }).catch(() => undefined);
  const server = createServer();
  const ok = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(socketPath, () => resolve(true));
  });
  if (!ok) return null;
  if (opts.fileMode !== undefined) await fs.promises.chmod(socketPath, opts.fileMode).catch(() => undefined);
  return server;
}
