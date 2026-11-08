// Hidden system files in a project's Files tab.
//
// WHY (Destin, 2026-11-07, picked "Hide them, with a Show hidden files switch"): a project's file list showed every
// file, including settings files for programs whose names start with a dot (.claude.json, .gitignore) — on the phone,
// the app's own. They clutter the list and touching one can break things, so they are hidden like a computer's own
// file browser does, and the Files filter menu's "Show hidden files" brings them back.

/** True when a project-relative path is, or sits inside, a dot-named file or folder. */
export function isHiddenPath(relPath: string): boolean {
  return relPath.replace(/\\/g, '/').split('/').some((seg) => seg.length > 1 && seg.startsWith('.') && seg !== '..');
}
