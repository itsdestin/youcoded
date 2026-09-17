// The keyboard-shortcut gate for full-screen views.
//
// The page view (Destin, 2026-09-17: "block keyboard shortcuts") is a screen
// of its own, but the app's global shortcuts — Shift+Space model cycle,
// Shift+Tab permission cycle, Ctrl+` chat/terminal, Ctrl+O expand-all, the
// Shift-hold session switcher, arrow-key chat scroll, the composer's
// type-to-focus — are all window-level capture listeners that know nothing
// about screens. Each one would need its own "unless a page is open" clause,
// and the next one written would forget it.
//
// Instead ONE capture listener, registered at module load — before any React
// effect can register — stops every later keydown listener while the gate is
// closed. stopImmediatePropagation only reaches listeners registered after
// this one on the same target, which is why registration happens at import
// time and not in an effect: App.tsx imports this module (transitively,
// through App's own components) before its first render.
//
// What still gets through:
//   - Escape, so the dismissal stack (use-esc-close) still leaves the view;
//   - keys typed into a field (isTypingTarget), so a search box in Settings
//     over the view keeps working — the gate is not meant to be on then
//     anyway (App closes it while Settings, the library or a dialog is up);
//   - Ctrl/Cmd zoom (=, +, -, 0), which is the window's, not the chat's;
//   - the browser's own defaults (nothing is preventDefault'd), so Ctrl+R,
//     F11 and friends behave as before.
import { isTypingTarget } from './is-typing-target';

let blocked = false;

export function setGlobalShortcutsBlocked(next: boolean): void {
  blocked = next;
}

export function globalShortcutsBlocked(): boolean {
  return blocked;
}

const ZOOM_KEYS = new Set(['=', '+', '-', '_', '0']);

/** Exported for the test; the module registers it itself. */
export function shortcutGateHandler(e: KeyboardEvent): void {
  if (!blocked) return;
  if (e.key === 'Escape') return;
  if ((e.ctrlKey || e.metaKey) && ZOOM_KEYS.has(e.key)) return;
  if (isTypingTarget(e.target as Element | null)) return;
  e.stopImmediatePropagation();
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', shortcutGateHandler, true);
}
