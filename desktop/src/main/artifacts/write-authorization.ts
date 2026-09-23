// Resolve-and-authorize for the artifacts:get/save handlers — the enforcement
// half of the D5 boundary (the policy itself is shared/artifacts/
// editable-path-policy.ts). Extracted from ipc-handlers so the security-
// critical behavior — symlink resolution, in-root enforcement on the RESOLVED
// path, tier refusal, concurrency token — is unit-testable against a real
// filesystem (see tests/artifacts/write-authorization.test.ts).
//
// Why realpath everywhere: canonicalize() is pure string work and
// readFile/writeFile follow symlinks, so a link inside the project root (a
// notes.md → ~/.ssh/config) would dodge both the traversal guard and the
// deny-list if we checked the unresolved path. realpath also normalizes
// Windows on-disk casing, so `.ENV` resolves to the real `.env` before the
// policy match.
import fs from 'fs';
import path from 'path';
import { canonicalize } from '../../shared/artifacts/canonicalize';
import { editTier, protectedReadPath } from '../../shared/artifacts/editable-path-policy';

export type ReadResolution =
  | { ok: true; realPath: string }
  | { ok: false; error: 'artifact-not-found' | 'protected-path' }
  | { ok: false; orphan: true };

export type WriteResolution =
  | { ok: true; realPath: string }
  | { ok: false; error: 'artifact-not-found' }
  | { ok: false; error: 'protected-path' | 'needs-confirm'; path: string }
  | { ok: false; error: 'conflict' };

/**
 * An external artifact's `absolutePath` is contractually canonical and absolute
 * (shared/artifacts/types.ts). Records written before the 2026-08-12
 * resolveTrackedPath fix violate that — they hold relative strings like
 * 'flappy-bird/play.html'. Every filesystem call resolves a relative path
 * against the PROCESS cwd (/home/destin for a GUI-launched Electron app, never
 * the project root), so such a record can silently address a file outside the
 * project, or — on the write path, whose ENOENT fallback resolves the PARENT —
 * create one.
 *
 * EXPORTED because write-authorization is not the only site that builds a path
 * from a record: artifacts:check-existence (ipc-handlers.ts) and countArtifacts
 * (projects-index.ts) call fs.access on the raw string, and renameArtifact
 * (artifact-store.ts) calls fs.access/fs.rename on it. All five sites share
 * this one definition.
 *
 * path.isAbsolute is deliberately used bare. It is already platform-correct: on
 * Windows it accepts 'C:\...' (a real absolute path there); on POSIX it rejects
 * it, which lands cross-device Windows records on the same orphan outcome their
 * realpath ENOENT already produced.
 */
export function isAbsoluteRecorded(p: string): boolean {
  return path.isAbsolute(p);
}

/** Why a relative external record may not be opened (see judgeRelativeRecord). */
export type RelativeRecordRefusal = 'missing' | 'protected-path' | 'outside-projects';

/**
 * Decide whether a legacy external record whose `absolutePath` is RELATIVE —
 * typically a file the agent wrote through `../` — may be trusted.
 *
 * WHY this exists (Destin, 2026-09-23, option A): those records used to be
 * refused on every platform as "no longer on disk", even when the file was
 * right there. They cannot simply all be trusted: the sidecar lives inside
 * the project (`.youcoded/artifacts.json`), so a folder copied from someone
 * else can carry a PLANTED record like `../../.ssh/id_rsa`. So a record is
 * trusted only when, with symlinks resolved, it lands:
 *   1. inside the record's own project or one of the user's saved project
 *      folders (`allowedRoots`), AND
 *   2. in an ordinary location — `editTier(...) === 'free'`, the app's
 *      existing deny list (credentials, .git/.youcoded internals, .claude and
 *      dotenv all fail it). Deliberately stricter than protectedReadPath:
 *      this is a record nobody chose to open by name.
 * The relative path is resolved against the PROJECT ROOT (what the agent's
 * tools resolved it against), never the process cwd.
 */
export async function judgeRelativeRecord(
  projectRoot: string,
  recordedPath: string,
  allowedRoots: string[],
): Promise<{ ok: true; realPath: string } | { ok: false; reason: RelativeRecordRefusal; realPath?: string }> {
  let realPath: string;
  try {
    realPath = await fs.promises.realpath(path.resolve(projectRoot, recordedPath));
  } catch (e: any) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { ok: false, reason: 'missing' };
    throw e;
  }
  // Checked BEFORE the root test, so a secret never gets its location echoed
  // back as an "outside your projects" path the renderer could reveal.
  if (editTier(canonicalize(realPath, null)) !== 'free') return { ok: false, reason: 'protected-path' };
  for (const root of new Set([projectRoot, ...allowedRoots])) {
    if (root && await inRealRoot(root, realPath)) return { ok: true, realPath };
  }
  return { ok: false, reason: 'outside-projects', realPath };
}

async function inRealRoot(projectRoot: string, realPath: string): Promise<boolean> {
  const realRoot = await fs.promises.realpath(path.resolve(projectRoot)).catch(() => null);
  if (!realRoot) return false;
  return realPath === realRoot || realPath.startsWith(realRoot + path.sep);
}

/**
 * Resolve a GET target. mustStayInRoot applies to discovered files and
 * tracked-INTERNAL artifacts (whose sidecar `path` was never traversal-checked
 * before, spec §12.1); tracked externals are legitimately out-of-root and rely
 * on the protected-read check alone.
 */
export async function authorizeArtifactRead(
  projectRoot: string,
  fullPath: string,
  mustStayInRoot: boolean
): Promise<ReadResolution> {
  // Corrupt sidecar record — same outcome the caller already renders for these
  // (orphan), but without letting realpath resolve it against the process cwd.
  if (!isAbsoluteRecorded(fullPath)) return { ok: false, orphan: true };

  let realPath: string;
  try {
    realPath = await fs.promises.realpath(fullPath);
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    return { ok: false, orphan: true };
  }
  if (mustStayInRoot && !(await inRealRoot(projectRoot, realPath))) {
    return { ok: false, error: 'artifact-not-found' };
  }
  // Sensitive read deny — the set read-binary already refuses, MINUS dotenv:
  // .env stays viewable because it is confirm-tier EDITABLE (the pane is the
  // human escape hatch; the agent's tools stay hard-denied). See D5.
  if (protectedReadPath(canonicalize(realPath, null))) {
    return { ok: false, error: 'protected-path' };
  }
  return { ok: true, realPath };
}

/**
 * Resolve and authorize a SAVE target. Runs, in order: symlink resolution
 * (falling back to parent-resolution when the file was deleted mid-edit —
 * saving then legitimately recreates it), in-root enforcement on the resolved
 * path, the D5 tier policy, and the optimistic-concurrency token.
 */
export async function authorizeArtifactWrite(args: {
  projectRoot: string;
  fullPath: string;
  mustStayInRoot: boolean;
  baseMtimeMs?: number;
  confirmed?: boolean;
}): Promise<WriteResolution> {
  const { projectRoot, fullPath, mustStayInRoot, baseMtimeMs, confirmed } = args;

  // Corrupt sidecar record. Critically, the ENOENT fallback below resolves the
  // PARENT directory — for a bare 'ROADMAP.md' that is realpath('.'), so a save
  // would create a stray file in the process cwd, outside the project, with the
  // in-root check skipped (mustStayInRoot is false for externals).
  if (!isAbsoluteRecorded(fullPath)) return { ok: false, error: 'artifact-not-found' };

  let realPath: string;
  try {
    realPath = await fs.promises.realpath(fullPath);
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    try {
      realPath = path.join(await fs.promises.realpath(path.dirname(fullPath)), path.basename(fullPath));
    } catch {
      return { ok: false, error: 'artifact-not-found' };
    }
  }
  if (mustStayInRoot && !(await inRealRoot(projectRoot, realPath))) {
    return { ok: false, error: 'artifact-not-found' };
  }

  // D5 policy — 'denied' is the security boundary; 'needs-confirm' requires
  // the caller to have shown the confirm dialog and say so (main refuses
  // otherwise, so a caller that skipped the dialog cannot skip the policy).
  const canon = canonicalize(realPath, null);
  const tier = editTier(canon);
  if (tier === 'denied') return { ok: false, error: 'protected-path', path: canon };
  if (tier === 'needs-confirm' && !confirmed) return { ok: false, error: 'needs-confirm', path: canon };

  // Optimistic concurrency (spec §12.9): token mismatch means someone — the
  // agent, another window, an external tool — wrote since this draft's base
  // was read. ENOENT falls through: the file was deleted and saving keeps the
  // user's draft.
  if (typeof baseMtimeMs === 'number') {
    try {
      const cur = await fs.promises.stat(realPath);
      if (cur.mtimeMs !== baseMtimeMs) return { ok: false, error: 'conflict' };
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return { ok: true, realPath };
}
