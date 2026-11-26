// Cross-component channel for the D3 unsaved-changes guard. The dialog and
// dirty state live inside the artifact host (SessionDrawer / ProjectView
// overlay), but several DISCARD paths are triggered from outside it:
// the HeaderBar/OverflowMenu drawer toggle, and session switching (which
// remounts the drawer wholesale). Those callers cannot reach the host's
// guard directly, so the host registers it here while mounted and outside
// actors route through guardDirtyEditor().
//
// Singleton by design: one window shows one artifact host with edit state at
// a time (the drawer belongs to the active session; the ProjectView overlay
// covers it). Last registrant wins; unregister restores the fall-through.
type Guard = (action: () => void) => void;

let current: Guard | null = null;

export function registerDirtyEditorGuard(guard: Guard): void {
  current = guard;
}

export function unregisterDirtyEditorGuard(guard: Guard): void {
  if (current === guard) current = null;
}

/** Run `action` now, or behind the registered host's Save/Discard/Cancel
 * dialog when that host currently holds a dirty editor. */
export function guardDirtyEditor(action: () => void): void {
  if (current) current(action);
  else action();
}

// ── Office edits in a file panel: save before the panel switches files ──
// WHY (Destin, 2026-11-14: "make sure it's reliable with no path for accidental data loss"; an
// independent review found it): a file link in chat or a file in a tool card switches the panel's
// file directly. An Office editor in that panel saves ~3 s after the last keystroke, so a switch
// inside that window unmounted it and dropped the newest typing. Those routes go through
// whenEditsSaved instead: an Office editor saves first (a failed save keeps it open, with its
// reason); anything else switches at once. WHY not guardDirtyEditor there: for a plain text
// editor that would add a Save/Discard dialog these routes never showed — its draft is parked
// and offered back, so it was never lost.
type Flush = (action: () => void) => void;
let officeFlush: Flush | null = null;

export function registerOfficeEditFlush(flush: Flush): void {
  officeFlush = flush;
}

export function unregisterOfficeEditFlush(flush: Flush): void {
  if (officeFlush === flush) officeFlush = null;
}

/** Run `action` once an Office edit open in the file panel has saved; at once otherwise. */
export function whenEditsSaved(action: () => void): void {
  if (officeFlush) officeFlush(action);
  else action();
}
