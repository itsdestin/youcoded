// Spec §3 import flows: move an existing on-device folder into
// ~/YouCoded/Projects/<name>/ so it becomes a synced project. This module owns
// the guards, the move itself, and the remap of every store that keys on the
// folder's absolute path. Space/remote initialization stays in service.ts (it
// owns the engine singletons).
//
// NOTE: checkImport() is a UX PRE-FLIGHT, not an authoritative gate. It runs
// before the move to give a friendly refusal, but the world can change between
// the check and the move (TOCTOU). The move path (Task 4) must independently
// tolerate the source having vanished, the destination name having been claimed,
// or a session having opened in the folder — it cannot assume checkImport's
// answer still holds when it runs.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateSyncName, isIgnoredPath, MAX_IMPORT_FILE_COUNT } from './guards';
import { canonicalize } from '../../shared/artifacts/canonicalize';
import { updateFolderPath } from '../saved-folders';
import { remapProjectPath } from '../artifacts/central-index';
import { readSidecar, writeSidecar } from '../artifacts/artifact-store';
import { ccProjectSlug } from '../slug-encoding';
import type { ManualInclude } from '../../shared/artifacts/types';

export interface ImportCheckOpts {
  sourcePath: string;
  name: string;
  projectsRoot: string;
  youcodedRoot: string;
  /** cwds of live (non-destroyed) sessions — a folder in use must not move */
  liveCwds: string[];
}

// Canonical prefix containment. canonicalize() yields forward slashes + a
// lowercased drive, so string prefix is safe here. (Byte-case differences in
// the REST of a Windows path aren't normalized — acceptable: every caller
// feeds paths from the same pickers/stores, not hand-typed variants.)
// NOTE: the isUnder(ycCanon, srcCanon) check in checkImport is a SAFETY guard
// (it prevents moving a folder that contains ~/YouCoded into itself), not just
// a UX nicety — so it too relies on pickers/stores yielding consistently-cased
// paths. A caller that fed a differently-cased variant could slip past it.
function isUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + '/');
}

/** Async twin of fs.existsSync: true when ANYTHING (file, folder, dangling
 *  symlink excluded — same as existsSync) is at `p`. */
async function pathExists(p: string): Promise<boolean> {
  try { await fs.promises.access(p); return true; } catch { return false; }
}

// Depth + wall-clock caps mirror the sibling bounded walk in
// artifacts/project-file-discovery.ts (which uses files/dirs/depth caps + a
// time budget). The §18 guardrail must never itself hang the Electron main
// thread while probing a folder the user picked.
const MAX_DEPTH = 100;         // 100-deep nesting = pathological or a junction cycle
const WALK_BUDGET_MS = 2000;   // hard wall-clock cap regardless of tree shape

/** Count real files under root, skipping DEFAULT_IGNORES (node_modules etc. —
 *  they never sync so they shouldn't disqualify the folder) and never
 *  following symlinks. Stops at limit+1: callers only need "over or not".
 *
 *  Bounded THREE ways so it can never hang the main process: file count, plus
 *  recursion depth (MAX_DEPTH) and wall-clock time (WALK_BUDGET_MS). WHY the
 *  depth + time caps are load-bearing, not belt-and-suspenders: e.isSymbolicLink()
 *  does NOT detect NTFS junctions — a junction reports isDirectory() === true —
 *  so a junction CYCLE that contains no files would recurse forever (the
 *  file-count limit never trips because it never finds a file to count). On
 *  either cap we return the over-limit signal (limit + 1), NOT the partial
 *  count: a 100-deep tree, or a walk we couldn't finish in 2s, is either
 *  pathological or a cycle, and the honest answer is "too big/weird to
 *  live-sync" — treating it as "fine, N files" would let a monster tree (or an
 *  endless junction loop) through the guardrail. */
//
// ASYNC (2026-09-24, main-blocking-calls B6): the walk used to be readdirSync,
// which by design could hold the Electron main thread — every window — for the
// full 2 s budget on a big folder. Awaiting each readdir lets other windows keep
// drawing while the dialog waits. Still sequential (one readdir in flight) so
// the count, the early stop and the caps behave exactly as before.
export async function countFilesBounded(root: string, limit: number): Promise<number> {
  let count = 0;
  let over = false;
  const deadline = Date.now() + WALK_BUDGET_MS;
  const walk = async (dir: string, rel: string, depth: number): Promise<boolean> => {
    // Depth/time exhaustion => treat the whole walk as over-limit (see fn doc).
    if (depth > MAX_DEPTH || Date.now() > deadline) { over = true; return false; }
    let entries: fs.Dirent[];
    // An unreadable directory yields no files here. If the ROOT itself is
    // unreadable, the count is 0 and the import proceeds past this guard — it
    // then fails at MOVE time with the OS error instead. Accepted trade-off:
    // the pre-flight isn't authoritative (see the module header TOCTOU note).
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return true; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        // isIgnoredPath matches directory patterns like 'node_modules/' against
        // a path SEGMENT, so pass the bare relative path (no trailing slash) —
        // guards.ts splits on separators and checks each segment.
        if (isIgnoredPath(childRel)) continue;
        if (!(await walk(path.join(dir, e.name), childRel, depth + 1))) return false;
      } else if (e.isFile()) {
        if (isIgnoredPath(childRel)) continue;
        count++;
        if (count > limit) return false;
      }
    }
    return true;
  };
  await walk(root, '', 0);
  return over ? limit + 1 : count;
}

/** Every reason an import must be refused, checked BEFORE anything moves.
 *  Returns a user-facing message, or null when the import may proceed. */
export async function checkImport(opts: ImportCheckOpts): Promise<string | null> {
  const { sourcePath, name, projectsRoot, youcodedRoot, liveCwds } = opts;

  let st: fs.Stats;
  try { st = await fs.promises.stat(sourcePath); } catch { return 'That folder no longer exists'; }
  if (!st.isDirectory()) return 'That path is a file, not a folder';

  const nameErr = validateSyncName(name);
  if (nameErr) return nameErr;

  const srcCanon = canonicalize(sourcePath, null);
  const ycCanon = canonicalize(youcodedRoot, null);
  // Moving a folder that's already inside ~/YouCoded is a no-op at best; moving
  // one that CONTAINS ~/YouCoded would recursively move the destination into
  // itself. Both are refused up front.
  if (isUnder(srcCanon, ycCanon)) return 'This folder is already inside your YouCoded folder';
  if (isUnder(ycCanon, srcCanon)) return "This folder contains your YouCoded folder, so it can't be moved inside it";

  if (await pathExists(path.join(projectsRoot, name))) return 'A project with that name already exists';

  // A live session with its cwd inside the source would break mid-move (its
  // working dir vanishes). Refuse and let the user close it first.
  for (const cwd of liveCwds) {
    if (isUnder(canonicalize(cwd, null), srcCanon)) {
      return 'A session is currently open in this folder — close it first, then try again';
    }
  }

  const count = await countFilesBounded(sourcePath, MAX_IMPORT_FILE_COUNT);
  if (count > MAX_IMPORT_FILE_COUNT) {
    return `This folder has too many files to live-sync (more than ${MAX_IMPORT_FILE_COUNT.toLocaleString()}). Move what you need into a smaller folder and import that instead.`;
  }

  return null;
}

export type ImportResult =
  | { ok: true; path: string; warnings: string[] }
  | { ok: false; error: string };

export interface ImportOpts extends ImportCheckOpts {
  /** Injectable for tests; defaults to ~/.claude */
  claudeDir?: string;
}

/** Move src → dest. rename when possible; EXDEV (another drive) falls back to
 *  copy-then-delete — still MOVE semantics per spec §3 (a surviving copy at
 *  the old path silently forks the user's work), so a failed source delete is
 *  surfaced as a warning, never ignored. Returns warnings; throws with a
 *  user-facing message on a blocked move (Windows EBUSY/EPERM when another
 *  process holds the folder). */
async function moveFolder(src: string, dest: string): Promise<string[]> {
  try {
    await fs.promises.rename(src, dest);
    return [];
  } catch (e: any) {
    if (e?.code === 'EXDEV') {
      // Re-check dest existence: rename(2) reports EXDEV from the filesystem
      // comparison BEFORE it ever looks at dest, so a dest created in the
      // checkImport→move window (the sync engine materializing a same-named
      // project from another device, or the dev + built app both running)
      // would be silently MERGED into by cpSync — and then DELETED by the
      // failure cleanup below. Refuse instead: never touch a folder this
      // import didn't create.
      if (await pathExists(dest)) throw new Error('A project with that name already exists');
      try {
        // WHY async: a cross-drive copy is a full-tree copy of however big the
        // folder is — synchronously that froze every window until it finished.
        // Same options as the old cpSync (recursive; symlinks copied as links).
        await fs.promises.cp(src, dest, { recursive: true });
      } catch {
        // A half-copied dest would shadow checkImport's name guard ("A project
        // with that name already exists") on EVERY retry, permanently blocking
        // the import. The source is untouched (the source delete hasn't run yet), so
        // clean up the partial dest best-effort and tell the user to retry.
        try { await fs.promises.rm(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best-effort */ }
        throw new Error('Copying the folder to its new drive failed partway. Nothing was lost — your folder is still in its original place. Free up space (or close whatever is using the files) and try again.');
      }
      try {
        await fs.promises.rm(src, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        return [];
      } catch {
        return [`The folder was copied to its new home, but the original at ${src} could not be fully removed — delete it manually so you don't keep editing the old copy.`];
      }
    }
    // A dest created BETWEEN checkImport and renameSync (TOCTOU — see module
    // header) surfaces as EEXIST/ENOTEMPTY; without this branch it fell into
    // the "another program is using this folder" message, which is wrong.
    if (e?.code === 'EEXIST' || e?.code === 'ENOTEMPTY') {
      throw new Error('A project with that name already exists');
    }
    if (e?.code === 'EBUSY' || e?.code === 'EPERM' || e?.code === 'EACCES') {
      throw new Error('Another program is using this folder (an open terminal, editor, or file). Close it and try again.');
    }
    throw e;
  }
}

/** The sidecar rides inside the folder, so after the move it's already at the
 *  new root — but manualIncludes/manualExcludes hold canonical ABSOLUTE paths
 *  (PITFALLS → Artifact Viewer), which still point at the old location.
 *  Rewrite the old-root prefix. */
async function remapSidecarManualPaths(newRoot: string, oldRoot: string): Promise<void> {
  const cur = await readSidecar(newRoot);
  if (cur === null || 'corrupted' in cur) return;
  const oldCanon = canonicalize(oldRoot, null);
  const newCanon = canonicalize(newRoot, null);
  const remapStr = (p: string) => (isUnder(p, oldCanon) ? newCanon + p.slice(oldCanon.length) : p);
  // manualExcludes is string[]; manualIncludes is ManualInclude[] — objects
  // whose .path is the canonical absolute path. Rewrite only the path; the
  // addedAt/addedBy provenance survives the move untouched.
  const remapInclude = (inc: ManualInclude): ManualInclude => ({ ...inc, path: remapStr(inc.path) });
  const nextIncludes = cur.manualIncludes.map(remapInclude);
  const nextExcludes = cur.manualExcludes.map(remapStr);
  if (JSON.stringify(nextIncludes) === JSON.stringify(cur.manualIncludes) &&
      JSON.stringify(nextExcludes) === JSON.stringify(cur.manualExcludes)) return;
  const expected = cur.updatedAt;
  cur.manualIncludes = nextIncludes;
  cur.manualExcludes = nextExcludes;
  cur.updatedAt = new Date().toISOString();
  const res = await writeSidecar(newRoot, expected, cur);
  // Every remap failure must surface as a warning (this module's contract) —
  // a silently-dropped CAS miss would lose the rewrite invisibly. The
  // orchestrator's catch converts this throw into the user-facing warning.
  if (!res.committed) throw new Error('sidecar-cas-miss');
}

/** CC's transcript dirs are keyed by a slug DERIVED from the cwd
 *  (~/.claude/projects/<slug>/), not stored — so a move silently orphans every
 *  past conversation unless the dir is renamed to the new path's slug. When
 *  the new slug dir already exists (rare), merge file-by-file, never clobber. */
async function remapTranscriptDir(oldPath: string, newPath: string, claudeDir: string): Promise<void> {
  const projectsDir = path.join(claudeDir, 'projects');
  // CC slugs realpath(cwd) (see slug-encoding.ts fixture "symlink resolves to
  // realpath"). Resolve the same way, falling back exactly as CC's Px() does,
  // so a symlinked project folder finds CC's real directory. fs.promises.realpath
  // is the libuv (native) realpath — the async twin of realpathSync.native.
  let resolvedOld: string;
  try { resolvedOld = await fs.promises.realpath(oldPath); } catch { resolvedOld = oldPath; }
  let resolvedNew: string;
  try { resolvedNew = await fs.promises.realpath(newPath); } catch { resolvedNew = newPath; }
  const oldDir = path.join(projectsDir, ccProjectSlug(resolvedOld));
  const newDir = path.join(projectsDir, ccProjectSlug(resolvedNew));
  if (!(await pathExists(oldDir))) return; // no conversations for this folder — nothing to remap
  if (!(await pathExists(newDir))) {
    await fs.promises.rename(oldDir, newDir);
    return;
  }
  for (const entry of await fs.promises.readdir(oldDir)) {
    const from = path.join(oldDir, entry);
    const to = path.join(newDir, entry);
    if (!(await pathExists(to))) await fs.promises.rename(from, to);
  }
  try { await fs.promises.rmdir(oldDir); } catch { /* leftovers (all-duplicate names) — harmless */ }
}

/** Destinations an import in THIS process is currently checking or moving
 *  into (lowercased) — see the claim in importProjectFolder. */
const inFlightImports = new Set<string>();

/** Guards → move → best-effort remaps. Remap failures become warnings, not
 *  errors: the folder has already moved, and each store degrades gracefully
 *  (spec §3) — e.g. a missed index remap only means artifact history restarts. */
export async function importProjectFolder(opts: ImportOpts): Promise<ImportResult> {
  const claudeDir = opts.claudeDir ?? path.join(os.homedir(), '.claude');
  const dest = path.join(opts.projectsRoot, opts.name);
  // WHY this claim: when check + move were synchronous, two imports in this
  // process could never interleave, so the second always saw the first's
  // folder and got "already exists". Now that both await, two imports to the
  // same name (a double-submit, or the desktop + a remote client) could both
  // pass the check — and on Linux/macOS rename() silently REPLACES an empty
  // destination folder. Claim the name for the whole check→move span instead.
  // Keyed lowercased: the sync identity is case-insensitive (repoNameForSpace).
  const claim = dest.toLowerCase();
  if (inFlightImports.has(claim)) return { ok: false, error: 'A folder is already being imported under that name. Wait for it to finish, then try again.' };
  inFlightImports.add(claim);
  let warnings: string[];
  try {
    const err = await checkImport(opts);
    if (err) return { ok: false, error: err };
    try {
      warnings = await moveFolder(opts.sourcePath, dest);
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  } finally {
    inFlightImports.delete(claim);
  }

  const foldersFile = path.join(claudeDir, 'youcoded-folders.json');
  try { updateFolderPath(opts.sourcePath, dest, foldersFile); }
  catch { warnings.push('The saved-folders list could not be updated — remove the old entry from the picker manually.'); }

  try { await remapProjectPath(claudeDir, canonicalize(opts.sourcePath, null), canonicalize(dest, null), opts.name); }
  catch { warnings.push('The artifact index could not be updated — artifact history may restart for this project.'); }

  try { await remapSidecarManualPaths(dest, opts.sourcePath); }
  catch { warnings.push('Manually added files in the artifact drawer may need re-adding.'); }

  try { await remapTranscriptDir(opts.sourcePath, dest, claudeDir); }
  catch { warnings.push('Past conversations could not be re-linked to the new location.'); }

  return { ok: true, path: dest, warnings };
}
