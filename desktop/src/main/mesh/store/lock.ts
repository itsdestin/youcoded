// One writer per store root (review finding C2).
//
// WHY a lock FILE and not an OS advisory lock: Node has no flock/fcntl without native code, and the app
// must not gain a native dependency for this. A file created atomically (hard link of a fully written
// temp file, so a reader never sees a half-written lock) holding {pid, start, host, token} gives the same
// guarantee as long as "is the holder still alive?" cannot be fooled:
//  - same host, pid not running                  -> stale (the holder died without releasing)
//  - same host, pid running, start time differs  -> stale (the pid was REUSED by another process).
//    Start time is /proc/<pid>/stat field 22 on Linux, which is what makes pid reuse harmless there.
//  - same host, pid running, start time unknown  -> treated as ALIVE (macOS/Windows: we cannot tell a reused
//    pid from the holder, so a stale lock can refuse to open until someone removes it. That fails LOUD and
//    never loses data. UNVERIFIED on macOS, Windows and Android.)
//  - different host                              -> ALIVE (a shared/synced folder: never take over)
// Taking over a stale lock is serialised by a second, short-lived `LOCK.takeover` file so two openers
// cannot both delete-and-recreate. A crash inside that window leaves a takeover file that the same
// liveness rule clears. The lock is never kept via the injectable Fs: crash tests simulate "process death"
// by editing the lock file (the owner of a real crash is dead; in-process it would still look alive).
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { randomBytes } from 'node:crypto';
import { StoreError } from './errors';

interface LockBody { pid: number; start: string | null; host: string; token: string }

/** Process start time as an opaque string, or null where this platform cannot tell us. */
async function processStart(pid: number): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  try {
    const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
    // the command name is in parentheses and may contain spaces: fields count from after the LAST ')'
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch { return null; }
}

function pidRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; }
}

async function holderAlive(b: LockBody): Promise<boolean> {
  if (b.host !== os.hostname()) return true;
  if (!Number.isInteger(b.pid) || b.pid < 1 || !pidRunning(b.pid)) return false;
  if (typeof b.start === 'string') {
    const now = await processStart(b.pid);
    if (now !== null && now !== b.start) return false; // pid reused
  }
  return true;
}

async function readLock(path: string): Promise<LockBody | 'unreadable' | null> {
  let raw: string;
  try { raw = await fsp.readFile(path, 'utf8'); } catch (e: any) { if (e.code === 'ENOENT') return null; throw e; }
  try {
    const b = JSON.parse(raw);
    if (b && typeof b.pid === 'number' && typeof b.host === 'string' && typeof b.token === 'string') return { pid: b.pid, start: typeof b.start === 'string' ? b.start : null, host: b.host, token: b.token };
  } catch { /* fallthrough */ }
  return 'unreadable';
}

/** Create `path` atomically with `body`; false when it already exists. */
async function createLockFile(path: string, body: string): Promise<boolean> {
  const tmp = `${path}.new-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fh = await fsp.open(tmp, 'wx', 0o600);
  try { await fh.writeFile(body); await fh.sync(); } finally { await fh.close(); }
  try {
    try { await fsp.link(tmp, path); return true; }
    catch (e: any) {
      if (e.code === 'EEXIST') return false;
      // no hard links here (some file systems): fall back to exclusive create (a reader may briefly see it empty)
      try { const f2 = await fsp.open(path, 'wx', 0o600); try { await f2.writeFile(body); await f2.sync(); } finally { await f2.close(); } return true; }
      catch (e2: any) { if (e2.code === 'EEXIST') return false; throw e2; }
    }
  } finally { await fsp.unlink(tmp).catch(() => undefined); }
}

export interface StoreLock { release(): Promise<void> }

/** Take the exclusive lock on a store root or throw StoreError('store-locked'). */
export async function acquireLock(root: string): Promise<StoreLock> {
  const path = nodePath.join(root, 'LOCK');
  const token = randomBytes(8).toString('hex');
  const mine: LockBody = { pid: process.pid, start: await processStart(process.pid), host: os.hostname(), token };
  const body = JSON.stringify(mine);
  const held = (detail: string) => new StoreError('store-locked', detail);
  const release = async () => {
    const cur = await readLock(path);
    if (cur && cur !== 'unreadable' && cur.token === token) await fsp.unlink(path).catch(() => undefined);
  };
  if (await createLockFile(path, body)) return { release };
  const cur = await readLock(path);
  if (cur === null) { if (await createLockFile(path, body)) return { release }; throw held('lost a race for the lock'); }
  if (cur === 'unreadable') {
    // never written by us in full (we link a finished file): a foreign or damaged file. Old enough = stale.
    const st = await fsp.stat(path).catch(() => null);
    if (!st || Date.now() - st.mtimeMs < 30_000) throw held('lock file is unreadable and recent');
  } else if (await holderAlive(cur)) throw held(`held by pid ${cur.pid} on ${cur.host}`);
  // stale: take over under the short takeover lock
  const tpath = `${path}.takeover`;
  if (!(await createLockFile(tpath, body))) {
    const t = await readLock(tpath);
    if (t && t !== 'unreadable' && (await holderAlive(t))) throw held('another opener is taking over a stale lock');
    await fsp.unlink(tpath).catch(() => undefined);
    if (!(await createLockFile(tpath, body))) throw held('lost a race taking over a stale lock');
  }
  try {
    const again = await readLock(path);
    if (again && again !== 'unreadable' && await holderAlive(again) && again.token !== (cur === 'unreadable' ? '' : cur.token)) throw held('the lock changed hands');
    await fsp.unlink(path).catch(() => undefined);
    if (!(await createLockFile(path, body))) throw held('lost a race for the lock');
  } finally { await fsp.unlink(tpath).catch(() => undefined); }
  return { release };
}
