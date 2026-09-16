// project-file-discovery — surface the DOCUMENTS that already exist on disk in a
// project folder, so the Project View Artifacts tab shows a folder's real files
// (plans, specs, data, notes) and not only the files Claude tracked during a
// session. Merged with the tracked sidecar artifacts in the LIST_PROJECT handler.
//
// Deliberately bounded — see the caps below — so scanning a large or unexpected
// root (e.g. the seeded "Home" folder) can't hang the UI:
//   - SKIP_DIRS denylist + dot-dirs are never walked (node_modules, .git, …)
//   - symlinks are never followed (loop-safe)
//   - hard caps on files, directories visited, depth, AND wall-clock time
//   - results cached briefly so the hero count + the tab don't double-scan, and
//     rapid project re-switches are free.
import fs from 'fs';
import path from 'path';
import { ArtifactRecord } from '../../shared/artifacts/types';
import { canonicalize } from '../../shared/artifacts/canonicalize';

// "All files" is the FULL-BROWSER view — every file type counts (source code,
// configs, docs, images). It MUST be a superset of Artifacts (Claude-authored), so
// we can't filter by extension here: a code file Claude wrote has to appear. We
// only skip a handful of high-noise byproducts no one browses; the heavy lifting
// is the directory-level skips (node_modules, .git, nested repos) above.
const NOISE_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '.ds_store', 'thumbs.db']);
function isNoiseFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (NOISE_FILES.has(lower)) return true;
  // Abandoned import temp file. artifacts/import-file.ts copies to
  // `.youcoded-import-<pid>-<ts>-<basename>.part` in the destination folder and
  // renames over the target, so a killed or crashed import can strand one. The
  // dot-prefix skip above only covers DIRECTORIES, so without this the debris
  // renders as a real card in Project Files and counts toward the badge forever,
  // with nothing to explain it.
  if (lower.startsWith('.youcoded-import-') && lower.endsWith('.part')) return true;
  return lower.endsWith('.map') || lower.endsWith('.min.js') || lower.endsWith('.min.css');
}

// Directories never walked. Build/cache/dependency/system dirs that would be slow
// and noisy. Any dot-directory (name starts with '.') is also skipped.
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.cache',
  'venv', '__pycache__', 'target', 'bin', 'obj', 'vendor', 'Pods', '.terraform',
  // System / OS dirs that show up when a broad root (Home) is a saved folder.
  'AppData', 'Application Data', '$Recycle.Bin', 'System Volume Information',
]);

const MAX_FILES = 2000;     // stop collecting beyond this many docs
const MAX_DIRS = 4000;      // stop after visiting this many directories
const MAX_DEPTH = 6;        // don't descend deeper than this
const TIME_BUDGET_MS = 1500; // hard wall-clock cap regardless of tree size
const CACHE_TTL_MS = 10_000; // dedupe the hero+tab calls and rapid re-switches

export interface DiscoveryResult {
  files: ArtifactRecord[];
  truncated: boolean; // a cap was hit — the list is incomplete
}

const cache = new Map<string, { ts: number; result: DiscoveryResult }>();

// Drop a project's cached scan so the next LIST_PROJECT re-walks the folder
// (called after an edit/create so a changed file shows up promptly).
export function invalidateDiscoveryCache(projectRoot: string): void {
  cache.delete(canonicalize(projectRoot, null));
}

// Is `dir` itself a git repository? (A `.git` directory OR a `.git` file — git
// worktrees and submodules use a file.) Used to stop the scan at NESTED repos.
async function isGitRepo(dir: string): Promise<boolean> {
  try { await fs.promises.access(path.join(dir, '.git')); return true; }
  catch { return false; }
}

/**
 * The ONE shape of a discovered (on disk, never tracked) file record.
 *
 * WHY a builder and not a literal: three places make this record — the walk
 * below, projectAllFiles' union of tracked internals the walk missed
 * (projects-index.ts), and resolveArtifactPath for a file path tapped in chat
 * (read-service.ts). The drawer treats them as the same thing (id == canonical
 * relative path, content read by path), so a field added to one copy and not
 * the others would make one file behave differently depending on how it was
 * found. Pinned by tests/artifacts/resolve-artifact-path.test.ts.
 */
export function discoveredFileRecord(relPath: string, lastModified: string): ArtifactRecord {
  return {
    id: relPath,           // discovered id == canonical relative path
    path: relPath,
    kind: 'internal',
    absolutePath: null,
    lastModified,
    status: 'active',
    versions: [],
    comments: [],
    tags: [],
    discovered: true,
  };
}

export async function discoverProjectFiles(projectRoot: string): Promise<DiscoveryResult> {
  const key = canonicalize(projectRoot, null);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.ts < CACHE_TTL_MS) return hit.result;

  const files: ArtifactRecord[] = [];
  let dirs = 0;
  let truncated = false;
  const deadline = now + TIME_BUDGET_MS;

  async function walk(dir: string, depth: number): Promise<void> {
    if (truncated || depth > MAX_DEPTH) return;
    if (Date.now() > deadline) { truncated = true; return; }
    if (++dirs > MAX_DIRS) { truncated = true; return; }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable (permissions, gone) — skip silently
    }

    for (const e of entries) {
      if (truncated) return;
      if (e.isSymbolicLink()) continue; // never follow symlinks — loop-safe
      const full = path.join(dir, e.name);

      if (e.isDirectory()) {
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
        // Don't descend into NESTED git repos. A project's files are its OWN
        // tree — not a recursive crawl through cloned sub-repos or git worktrees
        // living inside it (the youcoded-dev workspace holds several full repo
        // clones plus a worktree — that crawl is what made the count balloon to
        // ~1209 and, because it hit the time budget at a different spot each run,
        // disagree between the hero and the switcher). Stopping at the nested
        // .git keeps the scan bounded and deterministic FOR TYPICAL PROJECTS —
        // note the wall-clock budget can still truncate a huge non-repo tree at
        // a different spot per run, so determinism is only guaranteed when
        // `truncated` is false (the UI surfaces a truncation note). The root is
        // always walked (we start at it directly), so a project that is itself
        // a repo still lists its files.
        if (await isGitRepo(full)) continue;
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        if (isNoiseFile(e.name)) continue;
        if (files.length >= MAX_FILES) { truncated = true; return; }
        let lastModified = '';
        try { lastModified = (await fs.promises.stat(full)).mtime.toISOString(); } catch { /* leave blank */ }
        const rel = canonicalize(full, projectRoot);
        files.push(discoveredFileRecord(rel, lastModified));
      }
    }
  }

  try { await walk(projectRoot, 0); } catch { /* defensive — return whatever we got */ }

  const result: DiscoveryResult = { files, truncated };
  cache.set(key, { ts: now, result });
  return result;
}
