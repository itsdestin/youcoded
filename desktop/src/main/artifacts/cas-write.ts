import { promises as fs } from 'fs';
import { basename, dirname, join } from 'path';

export interface CasResult {
  committed: boolean;
  actualUpdatedAt: string | null;
}

/**
 * ROADMAP L696. `expectedUpdatedAt: null` used to carry TWO meanings at one
 * call site — "no sidecar exists, I am creating one" and "the sidecar exists
 * but is unreadable, replace it" — and the only behaviour available to both was
 * "write, no matter what is there". So two first-ever artifact writes in a
 * project that landed concurrently each found nothing, each wrote a fresh
 * page-one, and the second silently overwrote the first. Both reported
 * `committed: true`; one artifact record was lost with no error.
 *
 * Splitting the two meanings is the fix. `null` now means what it reads as —
 * the file must NOT exist — and deliberately replacing something broken has to
 * say so with this sentinel. That direction matters: a caller that forgets to
 * pass anything gets the SAFE behaviour (a refused write it can retry), not the
 * clobber.
 */
export const CAS_REPLACE_ANY = Symbol('cas-replace-any');

/**
 * What a writer expects to find on disk:
 *   a string          — this exact `updatedAt`, or the write is refused
 *   null              — nothing at all; the write is refused if a file appeared
 *   CAS_REPLACE_ANY   — whatever is there, replace it (corruption recovery)
 */
export type CasExpectation = string | null | typeof CAS_REPLACE_ANY;

const LOCK_RETRY_MS = 10;
const LOCK_MAX_WAIT_MS = 3000;
const LOCK_STALE_MS = 30_000;

/**
 * Atomic write-then-rename with CAS check, protected by a mkdir-based lock.
 *
 * The lock closes the TOCTOU race where two concurrent writers could both pass
 * the CAS pre-check and then both reach the rename step — the second rename
 * would silently overwrite the first, causing data loss. With the lock, only
 * one writer runs the read+check+write+rename sequence at a time.
 *
 * Lock mechanism: fs.mkdir is atomic on both POSIX and NTFS. The lock directory
 * is created before the critical section and removed in a finally block. A
 * stale-lock heuristic (>30s old) handles crashed processes.
 *
 * @param target Absolute target path
 * @param expectedUpdatedAt What the caller expects to find — see CasExpectation.
 *                          `null` REQUIRES the file to be absent (creation);
 *                          pass CAS_REPLACE_ANY to overwrite regardless.
 * @param content New file contents
 * @param extractUpdatedAt Function to pull updatedAt out of a JSON string.
 *                        Optional — when undefined, CAS check is skipped
 *                        (use for non-CAS atomic writes like .gitignore).
 */
/**
 * Acquire the mkdir lock for `target`. Returns false on timeout. Shared by
 * casWrite and mutateFileUnderLock so both use identical lock semantics
 * (atomic mkdir on POSIX + NTFS, 30s stale-lock breaking).
 */
async function acquireLock(lock: string): Promise<boolean> {
  const start = Date.now();
  while (true) {
    try {
      await fs.mkdir(lock);
      return true; // Lock acquired
    } catch (e: any) {
      // EEXIST = normal contention (another writer holds the lock). On Windows
      // NTFS, mkdir racing another writer's in-flight lock REMOVAL surfaces
      // EPERM / EACCES / EBUSY instead (the dir sits in a "delete pending"
      // state until the rmdir completes) — same meaning, so retry rather than
      // throw. Anything else (e.g. ENOENT parent missing) is a real error.
      const contention =
        e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY';
      if (!contention) throw e;
      // Stale-lock heuristic: if the lock dir is older than LOCK_STALE_MS,
      // the holding process likely crashed — break the lock and retry.
      try {
        const stat = await fs.stat(lock);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Ignore stat errors (lock may have just been released)
      }
      if (Date.now() - start > LOCK_MAX_WAIT_MS) {
        return false;
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
}

// A crashed writer can orphan a '<target>.<pid>.<ts>.tmp' file — and unlike the
// old fixed '<target>.tmp' name, a pid+time name is never overwritten by the
// next write, so it would linger FOREVER. Worse, '.tmp' is NOT in the sync
// engine's DEFAULT_IGNORES (sync-spaces/guards.ts), so an orphan inside a sync
// space (Conversations/, Tags/) would transport to every device as junk.
// atomicWrite sweeps orphans for the SAME target older than this before each
// write — the same mitigation transcript-mirror.ts uses. An hour is comfortably
// longer than any real write, so a live tmp in flight is never swept.
const STALE_TMP_MS = 60 * 60 * 1000;

/**
 * Best-effort sweep of crash-orphaned tmp files for one target. Isolated in its
 * own try/catch so a cleanup hiccup (permissions, dir race) can never abort the
 * write it precedes — cleanup is opportunistic housekeeping, not correctness.
 * Exported for the other user-visible tree writers (ipc-handlers artifact save,
 * project-manager .gitignore) that share the same tmp-name shape.
 */
export async function sweepStaleTmp(dir: string, targetBase: string): Promise<void> {
  try {
    // Match only OUR tmp shape for THIS target: '<targetBase>.<something>.tmp'.
    // A foreign target's tmp (different basename) — and the '<file>.lock' dirs
    // the mkdir lock creates — are left alone.
    const prefix = `${targetBase}.`;
    const now = Date.now();
    for (const name of await fs.readdir(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
      const full = join(dir, name);
      try {
        if (now - (await fs.stat(full)).mtimeMs > STALE_TMP_MS) await fs.unlink(full);
      } catch { /* vanished or unreadable — nothing to sweep */ }
    }
  } catch { /* dir unreadable — skip the sweep entirely */ }
}

/** Atomic tmp-write + fsync + rename onto `target`. */
// WHY: on Windows, renaming over a file fails with EPERM/EACCES/EBUSY while
// anything else has it open for that instant — a reader of the same file (the
// app polls several of these), antivirus scanning the new temp file, a sync
// client. The collision lasts milliseconds, but one un-retried attempt threw
// and the whole write was lost (the delegation ledger dropped a saved note:
// native-session-host.test.ts failed on Windows CI 2026-09-26 after its 23 s
// wait). Retry briefly; sync-service.ts's own atomicWrite already does the
// same. POSIX rename replaces an open file fine, so there an EACCES is a real
// permission error and is thrown at once.
const RENAME_RETRY_DELAYS_MS = [20, 50, 100, 200, 400];

export async function renameReplacing(tmp: string, target: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, target);
      return;
    } catch (e: any) {
      const transient = platform === 'win32' && (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY');
      if (!transient || attempt >= RENAME_RETRY_DELAYS_MS.length) throw e;
      await new Promise((r) => setTimeout(r, RENAME_RETRY_DELAYS_MS[attempt]));
    }
  }
}

async function atomicWrite(target: string, content: string): Promise<void> {
  await sweepStaleTmp(dirname(target), basename(target));
  // pid+time-suffixed temp name: two processes (dev + built app) writing the
  // same file must not race the same .tmp — the loser's rename would ENOENT.
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    const fh = await fs.open(tmp, 'r+');
    await fh.sync();
    await fh.close();
    await renameReplacing(tmp, target);
  } catch (e) {
    // Non-crash strand (e.g. Windows AV holding the file → EPERM on rename):
    // remove our own tmp so it can't linger — and sync — as junk.
    try { await fs.unlink(tmp); } catch { /* already gone */ }
    throw e;
  }
}

/**
 * Read-modify-write a file entirely INSIDE the mkdir lock. This is the
 * primitive for files without their own CAS version field (e.g. the central
 * projects index): a caller that reads outside the lock and then writes loses
 * updates when two writers interleave (both read v0, both write, second
 * clobbers the first). Both YouCoded instances (dev + built app) share
 * ~/.claude, so cross-process interleaving is a normal state, not a rarity.
 *
 * @param mutate receives the current on-disk content (null when the file
 *               doesn't exist) and returns the new content, or null to skip
 *               the write.
 * @returns false when the lock couldn't be acquired within the timeout.
 */
export async function mutateFileUnderLock(
  target: string,
  mutate: (onDisk: string | null) => string | null
): Promise<boolean> {
  await fs.mkdir(dirname(target), { recursive: true });
  const lock = target + '.lock';
  if (!(await acquireLock(lock))) return false;
  try {
    let onDisk: string | null = null;
    try {
      onDisk = await fs.readFile(target, 'utf8');
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
    const next = mutate(onDisk);
    if (next !== null) await atomicWrite(target, next);
    return true;
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

// 2026-08-27 OOM fix: the comparand is ONE timestamp, but this check used to
// hand the extractor the WHOLE file — for a 6.4 MB artifacts.json that was a
// full read AND (with the store's old `JSON.parse(raw).updatedAt` extractor) a
// full parse, on every write, just to compare 24 bytes. Offer the extractor a
// bounded head first; only when it has no answer there (returns undefined, or
// throws — JSON.parse on a truncated head does) fall back to the whole file.
// Every extractor that worked before still works: the fallback is the old path.
const HEAD_PROBE_BYTES = 4096;

async function readComparand(
  target: string,
  extract: (json: string) => string | undefined
): Promise<string | undefined> {
  const handle = await fs.open(target, 'r');
  let head: string;
  let complete: boolean;
  try {
    const buf = Buffer.alloc(HEAD_PROBE_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEAD_PROBE_BYTES, 0);
    head = buf.subarray(0, bytesRead).toString('utf8');
    complete = bytesRead < HEAD_PROBE_BYTES;
  } finally {
    await handle.close();
  }
  if (complete) return extract(head); // the head IS the file — nothing to fall back to
  try {
    const fromHead = extract(head);
    if (fromHead !== undefined) return fromHead;
  } catch {
    // A whole-file extractor (JSON.parse) chokes on a truncated head — expected.
  }
  return extract(await fs.readFile(target, 'utf8'));
}

export async function casWrite(
  target: string,
  expectedUpdatedAt: CasExpectation,
  content: string,
  extractUpdatedAt?: (json: string) => string | undefined
): Promise<CasResult> {
  const lock = target + '.lock';
  await fs.mkdir(dirname(target), { recursive: true });

  if (!(await acquireLock(lock))) {
    return { committed: false, actualUpdatedAt: null };
  }

  try {
    // ROADMAP L696: the EXISTENCE half, and it needs no extractor — a creating
    // writer has nothing to compare against, only "is anything there". Checked
    // inside the lock, so a file appearing between this stat and the rename
    // below is not possible.
    if (expectedUpdatedAt === null) {
      try {
        await fs.stat(target);
        // Something is there and we expected nothing: the caller read an empty
        // project, someone else created the file, and writing now would drop
        // their record. Refuse; the caller re-reads and merges on its retry.
        return { committed: false, actualUpdatedAt: null };
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
      }
    } else if (extractUpdatedAt && expectedUpdatedAt !== CAS_REPLACE_ANY) {
      // CAS check inside the lock — safe from races now
      try {
        const actual = await readComparand(target, extractUpdatedAt);
        if (actual !== expectedUpdatedAt) {
          return { committed: false, actualUpdatedAt: actual ?? null };
        }
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
        // Expected a specific token; the file is gone. Refuse — whatever this
        // writer was amending no longer exists.
        return { committed: false, actualUpdatedAt: null };
      }
    }

    // Atomic write inside the lock
    await atomicWrite(target, content);

    return { committed: true, actualUpdatedAt: null };
  } finally {
    // Always release the lock, even if an error occurs
    await fs.rm(lock, { recursive: true, force: true });
  }
}
