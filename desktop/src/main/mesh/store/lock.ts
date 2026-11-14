// One writer per store root (review findings C2 and N9).
//
// WHY a lock FILE and not an OS advisory lock: Node has no flock/fcntl without native code, and the app
// must not gain a native dependency for this. A file created atomically (hard link of a fully written
// temp file, so a reader never sees a half-written lock) holding {pid, start, boot, pidns, host, token}
// gives the same guarantee as long as "is the holder still alive?" cannot be fooled.
//
// THREE OUTCOMES when a lock file already exists (judge() below):
//   alive  -> `store-locked`.            Another process (or another open in this one) really holds it.
//   stale  -> taken over automatically.  Only on positive evidence the holder is gone.
//   doubt  -> `store-locked-stale?`.     The store cannot tell. The error carries `evidence` (pid, token, why).
//
// RECOMMENDED CALLER BEHAVIOUR for `store-locked-stale?` (N9: the app must never lock the user out):
//   1. Do not retry in a loop. 2. Tell the user in plain words that another copy of the app may still be
//   running, and ask whether to continue anyway. 3. If they say yes, call `ChatStore.open(root,
//   { breakLockToken: err.evidence.breakLockToken })`. The token names THIS lock, so a lock taken by someone
//   else in the meantime is not broken by mistake. On Android, where the OS kills app processes without
//   warning and a left-over lock is routine, the caller may break it without asking because the app
//   itself is the only possible holder there (UNVERIFIED on a device).
//
// WHAT IS CHECKED, PER PLATFORM (the pid-reuse defence, explicit):
//   Linux    boot id (/proc/sys/kernel/random/boot_id): a different boot id proves a reboot, so the holder is
//            gone (stale, even if its pid now belongs to another process). Same boot: pid namespace id
//            (/proc/self/ns/pid) must match (a holder in another namespace, a container or a sandbox, cannot
//            be checked by pid: doubt); pid not running: stale; pid running and process START TIME
//            (/proc/<pid>/stat field 22) differs from the one recorded: the pid was reused, stale; same start
//            time: alive; start time unreadable: doubt. Fallback when anything is missing: doubt, never steal.
//   macOS, Windows, Android (and any platform without those files): no boot id, no start time. pid not
//            running (kill(pid,0) = ESRCH): stale, but only when the recorded host name matches this
//            machine's (host name is evidence ONLY here, never a hard refusal: a mismatch gives doubt, which
//            the caller can resolve). pid running: DOUBT, because a reused pid cannot be told from the holder.
//            kill(pid,0) answering EPERM counts as running. UNVERIFIED on all four; on Android pids are
//            shared per device, so the same logic applies.
//   Host name is never used when a boot id is available, so renaming the machine cannot lock anyone out.
//
// Same process: a root opened twice in one process is always `store-locked` (an in-memory token, no guessing).
// Heartbeat: every mutation re-reads the lock file (`assertHeld`); if it was deleted or replaced under a
// live holder the write is refused with `store-locked` instead of racing a second writer.
//
// Taking over a stale lock is serialised by a second, short-lived `LOCK.takeover` file so two openers
// cannot both delete-and-recreate. A crash inside that window leaves a takeover file that the same
// liveness rule clears. Leftover `LOCK.new-*` temp files (a crash between create and link) are swept (N14).
// The lock is never kept via the injectable Fs: crash tests simulate "process death" by editing the lock
// file (the owner of a real crash is dead; in-process it would still look alive).
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { randomBytes } from 'node:crypto';
import { StoreError, type LockEvidence } from './errors';

interface LockBody { pid: number; start: string | null; host: string; token: string; boot: string | null; pidns: string | null }

/**
 * Roots this process holds right now -> the token of the lock it wrote. A lock file carrying our pid AND that
 * token is a lock we hold (a second open in this process is refused with certainty, no guessing from pids).
 * WHY a token and not just the pid: tests simulate a killed holder by editing the pid in the file; that must
 * read as dead, not as ours.
 */
const heldRoots = new Map<string, string>();

/** Process start time as an opaque string, or null where this platform cannot tell us. */
async function processStart(pid: number): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  try {
    const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
    // the command name is in parentheses and may contain spaces: fields count from after the LAST ')'
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch { return null; }
}
async function bootId(): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  try { const s = (await fsp.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(); return s || null; } catch { return null; }
}
async function pidNamespace(): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  try { return await fsp.readlink('/proc/self/ns/pid'); } catch { return null; }
}

function pidRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; }
}

type Verdict = { kind: 'alive'; why: string } | { kind: 'stale' } | { kind: 'doubt'; why: string };

async function judge(b: LockBody, root: string): Promise<Verdict> {
  if (b.pid === process.pid && heldRoots.get(root) === b.token) return { kind: 'alive', why: 'this process already holds it' };
  const myBoot = await bootId();
  if (b.boot && myBoot) {
    if (b.boot !== myBoot) return { kind: 'stale' };                      // rebooted since the lock was written
  }
  const myNs = await pidNamespace();
  if (b.pidns && myNs && b.pidns !== myNs) return { kind: 'doubt', why: 'the holder is in a different process namespace (container or sandbox), so its pid cannot be checked from here' };
  if (!Number.isInteger(b.pid) || b.pid < 1) return { kind: 'stale' };
  const bootKnown = !!(b.boot && myBoot);
  if (!pidRunning(b.pid)) {
    // without a boot id the pid number alone does not prove the lock is from THIS machine: host name is the evidence of last resort
    if (!bootKnown && b.host !== os.hostname()) return { kind: 'doubt', why: `the lock was written on a machine named "${b.host}" (this one is "${os.hostname()}") and no boot id is available to compare` };
    return { kind: 'stale' };
  }
  if (process.platform === 'linux') {
    const now = await processStart(b.pid);
    if (typeof b.start === 'string' && now !== null) return now !== b.start ? { kind: 'stale' } : { kind: 'alive', why: `held by pid ${b.pid}` };
    return { kind: 'doubt', why: 'the holder pid is running but its start time could not be compared' };
  }
  return { kind: 'doubt', why: `pid ${b.pid} is running and this platform cannot tell the holder from a process that reused the pid` };
}

async function readLock(path: string): Promise<LockBody | 'unreadable' | null> {
  let raw: string;
  try { raw = await fsp.readFile(path, 'utf8'); } catch (e: any) { if (e.code === 'ENOENT') return null; throw e; }
  try {
    const b = JSON.parse(raw);
    if (b && typeof b.pid === 'number' && typeof b.host === 'string' && typeof b.token === 'string') {
      return { pid: b.pid, start: typeof b.start === 'string' ? b.start : null, host: b.host, token: b.token, boot: typeof b.boot === 'string' ? b.boot : null, pidns: typeof b.pidns === 'string' ? b.pidns : null };
    }
  } catch { /* fallthrough */ }
  return 'unreadable';
}

/** Create `path` atomically with `body`; false when it already exists. */
async function createLockFile(path: string, body: string): Promise<boolean> {
  const tmp = `${path}.new-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fh = await fsp.open(tmp, 'wx', 0o600);
  try { await fh.writeFile(body); await fh.sync(); } finally { await fh.close(); }
  try {
    // DESTRUCTIVE-OK(lock): lock bookkeeping, never chat data; guarded by the token / liveness checks around it
    try { await fsp.link(tmp, path); return true; }
    catch (e: any) {
      if (e.code === 'EEXIST') return false;
      // no hard links here (some file systems): fall back to exclusive create (a reader may briefly see it empty)
      try { const f2 = await fsp.open(path, 'wx', 0o600); try { await f2.writeFile(body); await f2.sync(); } finally { await f2.close(); } return true; }
      catch (e2: any) { if (e2.code === 'EEXIST') return false; throw e2; }
    }
  // DESTRUCTIVE-OK(lock): lock bookkeeping, never chat data; guarded by the token / liveness checks around it
  } finally { await fsp.unlink(tmp).catch(() => undefined); }
}

/** N14: temp files a crash left between "create" and "link". Only old ones (an opener in flight owns a fresh one). */
async function sweepLockLitter(root: string): Promise<void> {
  let names: string[];
  try { names = await fsp.readdir(root); } catch { return; }
  for (const n of names) {
    if (!/^LOCK\.new-\d+-[0-9a-f]+$/.test(n)) continue;
    const p = nodePath.join(root, n);
    const st = await fsp.stat(p).catch(() => null);
    // DESTRUCTIVE-OK(lock): lock bookkeeping, never chat data; guarded by the token / liveness checks around it
    if (st && Date.now() - st.mtimeMs > 60_000) await fsp.unlink(p).catch(() => undefined);
  }
}

export interface StoreLock {
  release(): Promise<void>;
  /** Throws `store-locked` when the lock file is no longer ours (deleted or replaced under a live holder). */
  assertHeld(): Promise<void>;
}

const OLD_ENOUGH_MS = 30_000;

/**
 * Take the exclusive lock on a store root or throw StoreError('store-locked') / ('store-locked-stale?').
 * `breakLockToken` (from a previous `store-locked-stale?`) takes over exactly that lock regardless of liveness.
 */
export async function acquireLock(root: string, opts: { breakLockToken?: string | null; /** test seam only: runs between claiming the takeover file and re-reading the lock */ hooks?: { beforeRecheck?: () => Promise<void> } } = {}): Promise<StoreLock> {
  const key = nodePath.resolve(root);
  const path = nodePath.join(root, 'LOCK');
  const token = randomBytes(8).toString('hex');
  const mine: LockBody = { pid: process.pid, start: await processStart(process.pid), host: os.hostname(), token, boot: await bootId(), pidns: await pidNamespace() };
  const body = JSON.stringify(mine);
  const held = (detail: string) => new StoreError('store-locked', detail);
  const release = async () => {
    if (heldRoots.get(key) === token) heldRoots.delete(key);
    const cur = await readLock(path);
    // DESTRUCTIVE-OK(lock): lock bookkeeping, never chat data; guarded by the token / liveness checks around it
    if (cur && cur !== 'unreadable' && cur.token === token) await fsp.unlink(path).catch(() => undefined);
  };
  const lock: StoreLock = {
    release,
    async assertHeld() {
      const cur = await readLock(path);
      if (!cur || cur === 'unreadable' || cur.token !== token) throw held('the lock file was removed or replaced while this store was open');
    },
  };
  const got = async (): Promise<StoreLock> => { heldRoots.set(key, token); await sweepLockLitter(root); return lock; };
  if (await createLockFile(path, body)) return got();
  const cur = await readLock(path);
  if (cur === null) { if (await createLockFile(path, body)) return got(); throw held('lost a race for the lock'); }
  if (cur === 'unreadable') {
    // never written by us in full (we link a finished file): a foreign or damaged file. Old enough = stale.
    const st = await fsp.stat(path).catch(() => null);
    if (!st || Date.now() - st.mtimeMs < OLD_ENOUGH_MS) throw held('lock file is unreadable and recent');
  } else if (opts.breakLockToken && opts.breakLockToken === cur.token) {
    // the caller looked at this exact lock's evidence and decided to break it
  } else {
    const v = await judge(cur, key);
    if (v.kind === 'alive') throw held(`${v.why} on ${cur.host}`);
    if (v.kind === 'doubt') {
      const evidence: LockEvidence = { pid: cur.pid, token: cur.token, host: cur.host, why: v.why, breakLockToken: cur.token };
      throw new StoreError('store-locked-stale?', `pid ${cur.pid}: ${v.why}`, evidence);
    }
  }
  // stale: take over under the short takeover lock
  const tpath = `${path}.takeover`;
  if (!(await createLockFile(tpath, body))) {
    const t = await readLock(tpath);
    let tStale: boolean;
    if (t === null) tStale = true;
    // WHY the age test (N14): without hard links a takeover file can be seen empty while its owner is still writing it
    else if (t === 'unreadable') { const st = await fsp.stat(tpath).catch(() => null); tStale = !st || Date.now() - st.mtimeMs >= OLD_ENOUGH_MS; }
    else tStale = (await judge(t, key)).kind === 'stale';
    if (!tStale) throw held('another opener is taking over a stale lock');
    // DESTRUCTIVE-OK(lock): lock bookkeeping, never chat data; guarded by the token / liveness checks around it
    await fsp.unlink(tpath).catch(() => undefined);
    if (!(await createLockFile(tpath, body))) throw held('lost a race taking over a stale lock');
  }
  try {
    if (opts.hooks?.beforeRecheck) await opts.hooks.beforeRecheck();
    const again = await readLock(path);
    const same = cur === 'unreadable' ? again === 'unreadable' : !!again && again !== 'unreadable' && again.token === cur.token;
    if (again && !same) throw held('the lock changed hands');
    // DESTRUCTIVE-OK(lock): lock bookkeeping, never chat data; guarded by the token / liveness checks around it
    await fsp.unlink(path).catch(() => undefined);
    if (!(await createLockFile(path, body))) throw held('lost a race for the lock');
  // DESTRUCTIVE-OK(lock): lock bookkeeping, never chat data; guarded by the token / liveness checks around it
  } finally { await fsp.unlink(tpath).catch(() => undefined); }
  return got();
}
