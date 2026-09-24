// desktop/src/main/project-extensions/project-key.ts
//
// Resolves a native conversation's cwd to a PROJECT KEY (technical design
// 2026-09-24 §1/§3): the string that names which project's settings record
// (project-extensions/store.ts) governs that conversation's skills & tools.
//
//   synced project   -> its cross-device sync `name` (ProjectExtensions/<name>.json)
//   unsynced folder  -> its canonical path (project-extensions.local.json key)
//   no match at all  -> null (B-1: outside any project gets NOTHING automatic)
//
// WHY exact match, never an ancestor climb: the app seeds a "Home" saved
// folder at the user's home directory and defaults new conversations into it
// (folders-service.ts listPickerFolders / FolderSwitcher.tsx). An ancestor
// rule would match every cwd under $HOME to Home and silently defeat B-1 for
// almost every conversation. This mirrors ProjectView's matchProjectByPath
// (renderer/components/project-view/ProjectView.tsx) exactly, so the tab and
// this enforcement path always agree on which project a cwd belongs to.
//
// Pure module (no fs/path/os/IPC) — the same pure-core/IO-shell split as
// saved-folder-projects.ts. The caller (T2's NativeSessionHost) is
// responsible for building the candidate list from listPickerFolders() +
// ManagedRoots, and for supplying each managed folder's REAL sync name (the
// directory's basename under ~/YouCoded/Projects/, NOT the user's editable
// nickname — see saved-folder-projects.ts's own nickname-vs-identity split).
import { canonicalize } from '../../shared/artifacts/canonicalize';

export interface ProjectKeyCandidate {
  /** Folder path as stored (youcoded-folders.json entry, or a managed
   *  project's on-disk path) — not yet canonicalized; this module
   *  canonicalizes both sides before comparing. */
  path: string;
  /** Present only when this folder is a managed sync project: its
   *  cross-device sync identity (design §1's `name`). Absent means the
   *  folder is an ordinary (unsynced) saved folder, whose project key is its
   *  own canonical path. */
  syncName?: string;
}

/**
 * Resolve `cwd` to a project key by EXACT canonical-path match against
 * `candidates` — the first match wins (callers should not hand in duplicate
 * canonical paths; matchProjectByPath has the same "first wins" shape).
 *
 * Windows case-insensitivity: `canonicalize()` only lowercases the drive
 * letter, so two spellings of the same NTFS path ("C:\Proj" vs "c:\proj\")
 * can still canonicalize to different strings. Comparing case-insensitively
 * ONLY on win32 (never on POSIX, where case is significant) mirrors
 * folders-service.ts's own `removeFolder` `samePath` helper.
 */
export function resolveProjectKey(
  cwd: string | null | undefined,
  candidates: ProjectKeyCandidate[],
): string | null {
  if (!cwd) return null;
  const canonCwd = canonicalize(cwd, null);
  const compareCwd = process.platform === 'win32' ? canonCwd.toLowerCase() : canonCwd;

  for (const candidate of candidates) {
    const canonFolder = canonicalize(candidate.path, null);
    const compareFolder = process.platform === 'win32' ? canonFolder.toLowerCase() : canonFolder;
    // EXACT match only — no prefix/startsWith check. A folder named "proj"
    // must never match a cwd of "project" (or a subdirectory of either):
    // that would silently reintroduce the ancestor-climb bug this module
    // exists to avoid.
    if (compareFolder !== compareCwd) continue;
    if (candidate.syncName) return candidate.syncName;
    return canonFolder;
  }
  return null;
}
