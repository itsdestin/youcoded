// Async-only rebuild of folders-service.ts's listPickerFolders() CANDIDATE
// SET (paths + managed sync names) — for project-key.ts's resolveProjectKey.
//
// WHY a separate async path instead of calling listPickerFolders() directly:
// that function (and saved-folders.ts's readFolders under it) is fully
// SYNCHRONOUS fs (fs.readFileSync, fs.existsSync) — acceptable for the rare,
// explicit "open the folder picker" click it was built for, but
// NativeSessionHost.create()/resume() run on EVERY native session open, a
// path performance rule 1 ("the main process never blocks") forbids adding a
// sync call to. This never SEEDS the Home folder the way listPickerFolders
// does when the store is empty — by the time a conversation exists, the
// picker that chose its cwd already ran, so Home already exists on disk if it
// was ever going to; a session-open path has no business writing to the
// folders store.
//
// Pure-core/IO-shell split mirrors project-key.ts itself: this file does the
// I/O and hands plain ProjectKeyCandidate objects to the pure resolver.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ProjectKeyCandidate } from './project-key';

function defaultFoldersFile(): string {
  return path.join(os.homedir(), '.claude', 'youcoded-folders.json');
}

/** Same shape as saved-folders.ts's SavedFolder, narrowed to the one field
 *  this module reads: the path. (T6, project-plugin-controls, F1 review fix:
 *  this used to also carry `addedAt` for a "since when has this project
 *  existed" seeding signal — deleted. A folder's age has no relationship to
 *  when a plugin was installed into it; see resolve.ts's own header for the
 *  bug that signal caused and feature-first-run.ts for its replacement.) */
interface SavedFolderEntry {
  path: string;
}

async function readSavedFolderEntries(foldersFile: string): Promise<SavedFolderEntry[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.promises.readFile(foldersFile, 'utf8'));
  } catch {
    return []; // absent/corrupt file reads as "no saved folders" — same as readFolders()
  }
  if (!Array.isArray(raw)) return [];
  const out: SavedFolderEntry[] = [];
  for (const entry of raw) {
    const p = (entry as { path?: unknown } | null)?.path;
    if (typeof p !== 'string') continue;
    out.push({ path: p });
  }
  return out;
}

/**
 * Build the candidate list resolveProjectKey needs: every saved folder, plus
 * every managed sync project (~/YouCoded/Projects/<name>) not already among
 * them — mirrors listPickerFolders()'s own two-source union (saved folders
 * badged `managed` when they live under projectsRoot, then any managed
 * project missing from that list appended). Dedup is lowercase-always, same
 * as listPickerFolders's own `known` set — not a platform-conditional
 * case-fold (that set exists only to avoid a duplicate row, not to decide
 * path equality; project-key.ts's own comparison is the one that must be
 * platform-correct, and it re-canonicalizes both sides itself).
 *
 * `projectsRoot: null` (ManagedRoots not constructed — e.g. a bare test host)
 * skips the managed-project half entirely, same as `getManagedRoots()`
 * returning null does for the picker.
 */
export async function listProjectKeyCandidatesAsync(
  projectsRoot: string | null,
  foldersFile: string = defaultFoldersFile(),
): Promise<ProjectKeyCandidate[]> {
  const savedEntries = await readSavedFolderEntries(foldersFile);
  const candidates: ProjectKeyCandidate[] = [];
  const seen = new Set<string>();
  const projectsPrefix = projectsRoot ? path.resolve(projectsRoot).toLowerCase() + path.sep : null;

  for (const { path: p } of savedEntries) {
    const resolved = path.resolve(p);
    seen.add(resolved.toLowerCase());
    const managed = projectsPrefix !== null && resolved.toLowerCase().startsWith(projectsPrefix);
    // syncName is the directory's OWN basename (its cross-device identity),
    // never the saved folder's editable nickname — project-key.ts's own
    // header comment names this exact distinction.
    candidates.push({ path: p, ...(managed ? { syncName: path.basename(resolved) } : {}) });
  }

  if (projectsRoot) {
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(projectsRoot, { withFileTypes: true });
    } catch {
      entries = []; // ~/YouCoded/Projects/ not created yet — no managed projects to add
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(projectsRoot, e.name);
      if (seen.has(path.resolve(full).toLowerCase())) continue;
      candidates.push({ path: full, syncName: e.name });
    }
  }

  return candidates;
}
