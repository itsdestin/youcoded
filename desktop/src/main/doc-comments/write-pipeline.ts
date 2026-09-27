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
// generic, rather than copying." `docx-comments.ts` is under a PARALLEL,
// read-only implementation review while this module is being built, so it is
// deliberately left untouched (its own `writeDocxMutation` keeps its private
// copy of this same shape) — this module exists so `xlsx-comments.ts` doesn't
// duplicate that logic a second time, and so a future consolidation (having
// docx-comments.ts import this too) has somewhere to land without behaviour
// change.
import { promises as fs } from 'fs';

export type PipelineError = 'read-failed' | 'backup-failed' | 'write-failed' | 'verify-failed';

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
  verify: (newBytes: Buffer, extra: Extra) => Promise<boolean>
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

    // Step 1 (§3.3/§4.3): backup BEFORE touching the real target at all.
    const backupPath = `${absolutePath}${backupSuffix}-${Date.now()}`;
    try {
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
      await fs.rename(tmpPath, absolutePath);
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
      verified = await verify(newBytes, extra);
    } catch {
      verified = false;
    }
    if (!verified) {
      await fs.rename(backupPath, absolutePath);
      return { ok: false, error: 'verify-failed' };
    }
    await fs.unlink(backupPath);
    return { ok: true, ...extra };
  });
}
