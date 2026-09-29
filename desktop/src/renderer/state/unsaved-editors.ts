// Which non-Office edits in this window are unsaved: a text file open for editing in the file
// viewer, or a draft parked after its editor went away (draft-store). Main reads the file names
// through `office:other-unsaved` before a quit tears anything down, and before the last window
// closes (Task 6 fix rounds 9–11).
//
// WHY main has to know up front: such an editor vetoes its window's unload (ActiveArtifactView's
// beforeunload guard) — rightly — but a quit only meets that veto AFTER teardown, when every
// chat session has already been stopped; and a parked draft has no editor to veto anything, so
// it was dropped without a word. So each unsaved edit holds an entry here, the window tells main
// the file names whenever they change, and main refuses a quit (or the last window's close) while
// any window has one — showing this window's list (OfficeAlerts), with a way to open each parked
// draft and a way to discard them all.
import { useSyncExternalStore } from 'react';

export interface UnsavedEdit {
  /** The file's name only — never its folder (it is shown on screen and sent to main). */
  name: string;
  /** A parked draft: how to open its file again (the editor restores the draft), and whether
   *  that file can still be opened. Absent for an editor that is on screen. */
  parked?: { open(): void; available(): Promise<boolean> };
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
  window.claude?.office?.setOtherUnsaved?.(names);
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

/** Every unsaved edit in this window, for the refused prompt's list. */
export function useUnsavedEdits(): UnsavedEdit[] {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => snapshot, () => snapshot);
}

/** "Discard and quit" / "Discard and close": throw every unsaved edit in this window away. */
export function discardAllUnsaved(): void {
  [...holders.values()].forEach((e) => e.discard());
}

/** Tests only. */
export function resetUnsavedEditorsForTests(): void {
  holders.clear();
  snapshot = [];
  reported = '';
}
