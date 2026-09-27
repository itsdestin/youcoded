// Generic backup -> atomic-replace -> verify -> automatic-rollback pipeline
// for a whole-file OOXML mutation. T13 of the doc-comments build
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §4.3, mirroring
// §3.3 steps 1 and 6).
//
// WHY this is its own module rather than xlsx-comments.ts re-implementing
// docx-comments.ts's own `writeDocxMutation`: the shape is format-independent
// — read current bytes, apply an in-memory mutation, back up, atomically
// replace, verify by re-reading, and roll back to the backup on any verify
// failure — and the task brief for T13 explicitly asks to "reuse it if it's
// generic, rather than copying." `docx-comments.ts` was originally left
// untouched because it was under a PARALLEL, read-only implementation review
// while this module was being built; that review has since produced its own
// findings (T11 review), and docx's own `writeDocxMutation` (docx-comments.ts)
// is now a thin wrapper AROUND this module's `writeFileMutation` — the
// consolidation this comment used to describe as future work. `xlsx-
// comments.ts` was left unmodified by that consolidation: this module's own
// signature changes (originalBytes threaded to `verify`, the F5 backup
// relocation below) are additive/backward-compatible, so xlsx's behaviour
// picks up the same fixes for free without needing its own edit.
import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import * as os from 'os';
import * as path from 'path';

export type PipelineError = 'read-failed' | 'backup-failed' | 'write-failed' | 'verify-failed';

// F5 (T11 review — major): backups now live in ONE place OUTSIDE every user
// project — `~/.claude/youcoded-doc-backups/`, matching this app's own
// `.claude`-rooted state convention (`youcoded-cache`, `youcoded-config`,
// `youcoded-favorites.json`, ...) — rather than a sibling
// `<file>.bak-<timestamp>` next to the source. The design spec
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §3.3 step 1)
// left the location an open choice ("next to the source... or under
// `.youcoded/backups/`, decided at task time"); a dotdir INSIDE the user's
// project is still inside whatever that project's own git repo or cloud-sync
// tool (Dropbox, iCloud) watches, so it does NOT satisfy review finding F5's
// "not synced/committed" requirement — only a location entirely outside the
// project does. `os.homedir()` is redirected to a per-run sandbox under test
// (vitest.config.ts's `YOUCODED_TEST_HOME`/`HOME` override), so this needs no
// separate test-only path.
const BACKUP_DIR = path.join(os.homedir(), '.claude', 'youcoded-doc-backups');

/**
 * F5: ONE rolling backup per file, not one per write. The filename is derived
 * from a hash of the SOURCE file's absolute path — never a timestamp — so the
 * next write to this same file naturally overwrites the previous backup
 * instead of accumulating one per write forever. `backupSuffix` (e.g.
 * `.docx.bak`) is carried into the name purely so a human browsing the
 * directory can tell what kind of file it backs up; it plays no role in the
 * rolling behaviour itself. Exported so a test can locate a specific file's
 * backup without duplicating this hashing scheme.
 */
export function backupPathFor(absolutePath: string, backupSuffix: string): string {
  const hash = createHash('sha256').update(absolutePath).digest('hex').slice(0, 20);
  return path.join(BACKUP_DIR, `${hash}${backupSuffix}`);
}

/** `ErrorResult` is generic over the WHOLE `{ok:false, ...}` shape, not just
 *  an `error` string — a caller (like xlsx-comments.ts's feature-loss guard)
 *  may need an error variant that carries extra fields (e.g. `features:
 *  string[]`) alongside a DIFFERENT, plainer error variant for everything
 *  else. Constraining this to `{ok:false}` (rather than requiring one fixed
 *  `{ok:false, error: X}` shape) is what lets both live in the same union.
 *  Every call site below names `Extra`/`ErrorResult` EXPLICITLY (never relies
 *  on inference): TypeScript cannot reliably infer a generic split between
 *  "the ok:true branch plus Extra" and "everything else" out of a mutate
 *  function's own union return type. When there is no extra ok:true field,
 *  pass `{}` (a plain empty object type) for `Extra` — NOT `Record<string,
 *  never>`, which forces every property (including `ok`/`error` themselves,
 *  once intersected) to be assignable to `never` and makes the whole
 *  intersection unsatisfiable. */
export type MutateFn<Extra extends Record<string, unknown>, ErrorResult extends { ok: false }> = (
  currentBytes: Buffer
) => Promise<({ ok: true; bytes: Buffer } & Extra) | ErrorResult>;

/** Per-absolute-path in-process serialization — the same "two mutations on one
 *  file serialize, no lost update" guarantee docx-comments.ts's own
 *  `withDocxWriteLock` provides, generalized so a caller supplies the path a
 *  lock is keyed on. Every real xlsx caller (desktop IPC, remote) reaches the
 *  SAME main process, so a plain per-path promise chain is enough —
 *  cross-PROCESS safety is a deliberately separate, not-yet-built concern
 *  (§9.2's pending-mutation queue), same reasoning as docx's own lock. */
const writeLocks = new Map<string, Promise<unknown>>();

function withWriteLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  const prior = writeLocks.get(lockKey) ?? Promise.resolve();
  const settled = prior.then(fn, fn);
  // Chain a NEVER-REJECTING tracker so one failed mutation doesn't poison the
  // lock for the next caller — `settled` itself (returned below) still
  // carries this call's own real outcome, including a rejection.
  writeLocks.set(
    lockKey,
    settled.then(
      () => undefined,
      () => undefined
    )
  );
  return settled;
}

/**
 * Runs `mutate` under a per-`absolutePath` lock, backing up the original
 * bytes before ever touching the real file, replacing it atomically
 * (tmp-write then rename — never a direct overwrite), then calling `verify`
 * on the new bytes. A `verify` that returns `false` (or throws) triggers an
 * AUTOMATIC ROLLBACK: the backup is renamed back over the target before the
 * error surfaces, so the file the caller has open is always either the
 * successfully-mutated version or byte-identical to what it was before,
 * never a half-written third state — the exact contract §3.3 step 6 (F5)
 * specifies for docx, applied here format-independently.
 *
 * `backupSuffix` names the format for the sibling backup file (e.g.
 * `.xlsx.bak`) purely for a human reading the directory mid-failure; it plays
 * no role in the rollback logic itself.
 */
export async function writeFileMutation<Extra extends Record<string, unknown>, ErrorResult extends { ok: false }>(
  absolutePath: string,
  backupSuffix: string,
  mutate: MutateFn<Extra, ErrorResult>,
  // F1 (T11 review — blocker): `originalBytes` is passed to `verify` so a
  // format-specific check (docx's `verifyOoxmlWiring`) can scope itself to
  // what THIS operation changed — e.g. diffing dangling relationship ids
  // before/after — instead of judging the whole file, which would fail on
  // damage the file already had before this app ever touched it. A verify
  // callback with fewer parameters (xlsx-comments.ts's own, unchanged) still
  // type-checks and runs unmodified: TypeScript allows passing a function
  // that IGNORES trailing arguments wherever one that reads them is expected.
  verify: (newBytes: Buffer, extra: Extra, originalBytes: Buffer) => Promise<boolean>
): Promise<({ ok: true } & Extra) | ErrorResult | { ok: false; error: PipelineError }> {
  return withWriteLock(absolutePath, async () => {
    let originalBytes: Buffer;
    try {
      originalBytes = await fs.readFile(absolutePath);
    } catch {
      return { ok: false, error: 'read-failed' };
    }

    const mutated = await mutate(originalBytes);
    if (!mutated.ok) return mutated;
    const { bytes: newBytes, ...extraRest } = mutated;
    const extra = extraRest as unknown as Extra;

    // Step 1 (§3.3/§4.3, F5): backup BEFORE touching the real target at all —
    // ONE rolling backup per file, at a stable path outside the project (see
    // `backupPathFor`'s own doc comment), never a sibling `.bak-<timestamp>`.
    const backupPath = backupPathFor(absolutePath, backupSuffix);
    try {
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.writeFile(backupPath, originalBytes);
    } catch {
      return { ok: false, error: 'backup-failed' };
    }

    // Atomic replace: tmp-write then rename, never a direct overwrite —
    // matches artifacts/cas-write.ts's own atomicWrite shape (and
    // docx-comments.ts's own `writeDocxMutation`).
    const tmpPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tmpPath, newBytes);
      // F1 (T17 implementation review, major/durability): fsync the tmp
      // file's bytes to disk BEFORE the rename that makes them visible as
      // the real target — same idiom as artifacts/cas-write.ts's own
      // `atomicWrite` (`fh.sync()`). A bare `fs.rename` only reorders a
      // directory entry; it says nothing about whether the bytes the new
      // name points at are durable yet, so a crash between the rename
      // returning and the OS's own lazy flush could leave the real document
      // TRUNCATED — the failure mode this finding names. A throw here (the
      // open, or the sync itself) falls into the same catch below as a
      // failed write: the tmp file and the not-yet-needed backup are both
      // cleaned up, and the real target is left exactly as untouched as any
      // other write-failed path leaves it.
      const fh = await fs.open(tmpPath, 'r+');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.rename(tmpPath, absolutePath);
      // F1: best-effort fsync of the PARENT DIRECTORY too, so the rename's
      // own directory-entry update is itself durable, not just the file's
      // bytes (already covered above) — "where supported" per the finding:
      // opening a directory as a file handle and syncing it is POSIX-only
      // (fails on Windows), so this is wrapped in its own try/catch and
      // never allowed to fail a write that has already fully succeeded.
      try {
        const dirHandle = await fs.open(path.dirname(absolutePath), 'r');
        try {
          await dirHandle.sync();
        } finally {
          await dirHandle.close();
        }
      } catch {
        /* not supported on this platform/filesystem — the file-level fsync
           above already guarantees the CONTENT survives a crash */
      }
    } catch {
      try {
        await fs.unlink(tmpPath);
      } catch {
        /* already gone */
      }
      try {
        await fs.unlink(backupPath);
      } catch {
        /* best-effort — the real target was never touched either way */
      }
      return { ok: false, error: 'write-failed' };
    }

    // Verify, with AUTOMATIC ROLLBACK on failure.
    let verified: boolean;
    try {
      verified = await verify(newBytes, extra, originalBytes);
    } catch {
      verified = false;
    }
    if (!verified) {
      await fs.rename(backupPath, absolutePath);
      return { ok: false, error: 'verify-failed' };
    }
    // F5: the backup is KEPT, not deleted, on success — "one rolling backup
    // per file" (spec §3.3/§4.3) is a standing safety net, not just cover for
    // the moment of the write. The NEXT write to this same file overwrites
    // this same path (`backupPathFor` is stable per absolute path), so
    // exactly one backup ever exists per source file.
    return { ok: true, ...extra };
  });
}
