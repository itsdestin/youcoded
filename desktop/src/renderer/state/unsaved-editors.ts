// Which edits in this window are unsaved: a text file open for editing in the file viewer, a draft
// parked after its editor went away (draft-store), or an Office document not saved yet (office-store,
// Task 8). Main reads the file names through `office:other-unsaved` before a quit tears anything
// down, and before the last window closes (Task 6 fix rounds 9–11; main/unsaved-quit.ts).
//
// WHY main has to know up front: such an editor vetoes its window's unload (ActiveArtifactView's
// beforeunload guard) — rightly — but a quit only meets that veto AFTER teardown, when every
// chat session has already been stopped; and a parked draft has no editor to veto anything, so
// it was dropped without a word. So each unsaved edit holds an entry here, the window tells main
// the file names whenever they change, and main refuses a quit (or the last window's close) while
// any window has one — showing this window's list (OfficeAlerts), with a way to open each parked
// draft and a way to discard them all.
import { useSyncExternalStore } from 'react';

/** How a parked draft's Save ended: saved, the file changed on disk since (or that can't be
 *  told — `unknown`), a settings file that needs a yes first, or a specific failure message. */
export type ParkedSaveResult = { ok: true } | { conflict: true; unknown?: boolean } | { needsConfirm: true } | { protected: true } | { error: string };
/** Whether a parked draft's file can take it: yes; no — gone or not editable any more (the only
 *  "no longer available" case, fix round 14); or the check itself failed (shown, with Retry). */
export type DraftFileStatus = 'editable' | 'gone' | 'protected' | { error: string };
/** Save options: force = Save anyway (no changed-on-disk check); confirmed = yes to a settings file. */
export interface ParkedSaveOptions { force?: boolean; confirmed?: boolean }

export interface UnsavedEdit {
  /** The file's name only — never its folder (it is shown on screen and sent to main). */
  name: string;
  /** A parked draft (no editor on screen): whether its file could still take it, and saving it
   *  there from the prompt (fix round 13). Absent for an editor that is on screen. */
  parked?: { available(): Promise<DraftFileStatus>; save(o?: ParkedSaveOptions): Promise<ParkedSaveResult> };
  /** Throw these edits away (the discard choice in the refused prompt). */
  discard(): void;
}

const holders = new Map<symbol, UnsavedEdit>();
let snapshot: UnsavedEdit[] = [];
let reported = '';
const listeners = new Set<() => void>();

function changed(): void {
  snapshot = [...holders.values()];
  listeners.forEach((l) => l());
  const names = snapshot.map((e) => e.name);
  const key = JSON.stringify(names);
  if (key === reported) return;
  reported = key;
  // WHY the guard: Office's save-state store reports here too (Task 8), and it also runs in tests
  // and code paths without a window.
  if (typeof window !== 'undefined') window.claude?.office?.setOtherUnsaved?.(names);
}

/** An unsaved edit holds this until it is saved, discarded or restored: call the release. */
export function holdUnsavedEditor(edit: UnsavedEdit): () => void {
  const key = Symbol('unsaved-edit');
  // WHY discard lets go at once: the discard choice tells main to go ahead right after, so main
  // must already have heard "nothing unsaved" — the editor's own cleanup runs a render later.
  holders.set(key, { ...edit, discard: () => { if (holders.delete(key)) changed(); edit.discard(); } });
  changed();
  return () => { if (holders.delete(key)) changed(); };
}

/** The same list, outside a render (the prompt's photo preview). */
export function unsavedEditsNow(): readonly UnsavedEdit[] { return snapshot; }

/** Every unsaved edit in this window, for the refused prompt's list. */
export function useUnsavedEdits(): UnsavedEdit[] {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => snapshot, () => snapshot);
}

/** "Discard and quit" / "Discard and close": throw away the edits the person saw listed when
 *  they chose to (fix round 12) — one that appeared since is kept, and main refuses again. */
export function discardUnsaved(listed: readonly UnsavedEdit[]): void {
  const current = new Set(holders.values());
  listed.forEach((e) => { if (current.has(e)) e.discard(); });
}

/** Tests only. */
export function resetUnsavedEditorsForTests(): void {
  holders.clear();
  snapshot = [];
  reported = '';
}
