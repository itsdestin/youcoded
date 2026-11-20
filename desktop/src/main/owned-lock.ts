// owned-lock.ts — a "busy" marker that knows who owns it and takes over when the owner is gone.
//
// WHY (R-4 / L-1, 2026-11-18): the backup lock stored a bare process number. After a crash, any unrelated program that
// reused that number made the lock look held forever ("Push skipped — another sync is running", every hour, silently),
// and on a non-English Windows the "is it running" check read a dead process as alive. This records the owner's process
// number, its START TIME (so a reused number is recognised as someone else) and when the lock was made, and decides:
//
//   owner gone, or the number now belongs to a different process      -> stale: take over
//   owner alive and verified (same start time)                        -> held: refuse, name the owner
//   owner alive but NOT verifiable (no start time on this OS, or the
//     lock file is unreadable)                                        -> held until `unverifiableStaleAfterMs`
//                                                                        (backups: 2 hours, Destin L-1), then take over
//
// Layout stays the old one: a DIRECTORY (mkdir is the atomic claim), holding `pid` (what older app versions read) and
// `owner.json` (the full record). Everything is async: the main process must never block (rule performance.md #1).
// This module never signals or kills any process; process.kill(pid, 0) only asks whether the number exists.
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

interface LockOwner { pid: number; startTime: string | null; createdAt: number; token: string; label?: string }

interface OwnedLockDeps {
  pid?: number;
  now?: () => number;
  /** Process start time as an opaque string, null when that pid does not exist, undefined when this OS cannot say. */
  processStart?: (pid: number) => Promise<string | null | undefined>;
  /** Does a process with this number exist? (default: process.kill(pid, 0); EPERM still means yes) */
  isAlive?: (pid: number) => boolean;
}

export interface OwnedLockOptions extends OwnedLockDeps {
  /** How old a lock may get, when its owner cannot be verified, before it is taken over. No default: unset = never. */
  unverifiableStaleAfterMs?: number;
  label?: string;
}

export interface LockHandle { owner: LockOwner; release(): Promise<void>; releaseSync(): void }
export type LockResult =
  | { ok: true; lock: LockHandle; tookOver?: 'dead-owner' | 'reused-pid' | 'unverifiable-aged' }
  | { ok: false; reason: 'held' | 'unverifiable'; holder?: LockOwner };

/** Linux: field 22 of /proc/<pid>/stat. Other systems: undefined (cannot say) — never a spawned process, which would block. */
export async function processStartTime(pid: number): Promise<string | null | undefined> {
  if (process.platform !== 'linux') return undefined;
  let stat: string;
  try { stat = await fs.promises.readFile(`/proc/${pid}/stat`, 'utf8'); }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined; }
  // The command name (field 2) may hold spaces and parentheses, so split after the LAST ')'.
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return /^\d+$/.test(rest[19] ?? '') ? rest[19] : undefined;
}

/** WHY not `tasklist`: parsing its English "No tasks" text read a dead process as alive on every other Windows language. */
export function pidExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

const OWNER_FILE = 'owner.json';
const PID_FILE = 'pid';

async function readOwner(dir: string): Promise<{ owner: LockOwner | null; readable: boolean; mtimeMs: number }> {
  let mtimeMs = Date.now();
  try { mtimeMs = (await fs.promises.stat(dir)).mtimeMs; } catch { /* gone: caller retries */ }
  try {
    const o = JSON.parse(await fs.promises.readFile(path.join(dir, OWNER_FILE), 'utf8'));
    if (Number.isInteger(o?.pid) && typeof o?.createdAt === 'number') {
      return { owner: { pid: o.pid, startTime: typeof o.startTime === 'string' ? o.startTime : null, createdAt: o.createdAt, token: String(o.token ?? ''), label: o.label }, readable: true, mtimeMs };
    }
  } catch { /* fall through to the older format */ }
  // A lock made by an older app version: just a pid file. Its age is the folder's age.
  try {
    const pid = parseInt((await fs.promises.readFile(path.join(dir, PID_FILE), 'utf8')).trim(), 10);
    if (pid > 0) return { owner: { pid, startTime: null, createdAt: mtimeMs, token: '' }, readable: true, mtimeMs };
  } catch { /* nothing readable */ }
  return { owner: null, readable: false, mtimeMs };
}

export async function acquireOwnedLock(lockDir: string, opts: OwnedLockOptions = {}): Promise<LockResult> {
  const myPid = opts.pid ?? process.pid;
  const now = opts.now ?? Date.now;
  const startOf = opts.processStart ?? processStartTime;
  const alive = opts.isAlive ?? pidExists;
  await fs.promises.mkdir(path.dirname(lockDir), { recursive: true });
  let tookOver: 'dead-owner' | 'reused-pid' | 'unverifiable-aged' | undefined;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fs.promises.mkdir(lockDir);          // the atomic claim: exactly one contender succeeds
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const held = await readOwner(lockDir);
      let verdict: 'held' | 'unverifiable' | 'dead-owner' | 'reused-pid' | 'unverifiable-aged';
      const age = now() - (held.owner?.createdAt ?? held.mtimeMs);
      const aged = opts.unverifiableStaleAfterMs !== undefined && age >= opts.unverifiableStaleAfterMs;
      if (!held.owner) {
        verdict = aged ? 'unverifiable-aged' : 'unverifiable';
      } else if (!alive(held.owner.pid)) {
        verdict = 'dead-owner';
      } else {
        const current = await startOf(held.owner.pid);
        if (held.owner.startTime !== null && current !== undefined && current !== null && current !== held.owner.startTime) verdict = 'reused-pid';
        else if (held.owner.startTime !== null && current === held.owner.startTime) verdict = 'held';   // verified: never aged out
        else verdict = aged ? 'unverifiable-aged' : 'held';                                             // cannot verify: the age rule
      }
      if (verdict === 'held' || verdict === 'unverifiable') return { ok: false, reason: verdict, holder: held.owner ?? undefined };
      // Rename first, then delete: two contenders cannot both remove a lock the other has just re-created.
      const aside = `${lockDir}.stale-${myPid}-${now()}-${randomBytes(3).toString('hex')}`;
      try { await fs.promises.rename(lockDir, aside); await fs.promises.rm(aside, { recursive: true, force: true }); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
      tookOver = verdict;
      continue;
    }
    const mine: LockOwner = { pid: myPid, startTime: (await startOf(myPid)) ?? null, createdAt: now(), token: randomBytes(8).toString('hex'), label: opts.label };
    try {
      await fs.promises.writeFile(path.join(lockDir, OWNER_FILE), JSON.stringify(mine));
      await fs.promises.writeFile(path.join(lockDir, PID_FILE), String(myPid));   // what older app versions read
    } catch (e) {
      await fs.promises.rm(lockDir, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
    let released = false;
    return {
      ok: true, tookOver,
      lock: {
        owner: mine,
        async release() {
          if (released) return; released = true;
          try {
            const cur = JSON.parse(await fs.promises.readFile(path.join(lockDir, OWNER_FILE), 'utf8'));
            if (cur.token === mine.token) await fs.promises.rm(lockDir, { recursive: true, force: true });
          } catch { /* already gone */ }
        },
        // Shutdown only: the app is exiting and cannot wait for the async form.
        releaseSync() {
          if (released) return; released = true;
          // Only ever delete a lock that is still OURS (token match): a lock taken over from us must survive our late release.
          try {
            if (JSON.parse(fs.readFileSync(path.join(lockDir, OWNER_FILE), 'utf8')).token === mine.token) fs.rmSync(lockDir, { recursive: true, force: true });
          } catch { /* already gone, or best effort */ }
        },
      },
    };
  }
  return { ok: false, reason: 'held' };   // lost the race three times: another contender is active
}
