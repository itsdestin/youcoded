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

// WHY remembered (Destin, 2026-11-09 final review Q-5, picked "Everywhere, remembered"): the tick was forgotten on
// leaving the Files tab, so anyone who works with dot-named files had to tick it again every visit. It is now one
// answer for the whole app on this device, like grid/list view. Reads and writes are wrapped because some Android
// WebView configurations throw on storage access; a blocked store just means the tick is not remembered.
const SHOW_HIDDEN_KEY = 'youcoded.projectView.showHidden';

export function readStoredShowHidden(): boolean {
  try { return localStorage.getItem(SHOW_HIDDEN_KEY) === '1'; } catch { return false; }
}

export function storeShowHidden(show: boolean): void {
  try { if (show) localStorage.setItem(SHOW_HIDDEN_KEY, '1'); else localStorage.removeItem(SHOW_HIDDEN_KEY); } catch { /* storage blocked */ }
}
