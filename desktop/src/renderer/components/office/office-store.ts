// Which documents are open in Office, and which is in front. A module store
// (performance rule 3: a slice store, not a Context) so the tabs outlive the
// page view: going back to chat and returning finds the same documents.
//
// It is also the ONE place that knows where each file is being edited — an Office tab, or an
// Edit in a file panel — so no file ever gets two editors at once (design §5, review 1 R1-2),
// and it holds each file's save state for the tab strip's "Saved" label (Task 6).
import { useSyncExternalStore } from 'react';
import type { OfficeFile } from '../../../shared/office-types';

export const HOME_TAB = 'home';

interface OpenDoc {
  file: OfficeFile;
  /** Closed in the background to save memory (office-questions#Q-sleep). */
  asleep: boolean;
  /** Closed by the person but still saving its last changes: off the tab strip, its editor
   *  kept (hidden) until the save lands or 5 s pass (design §4 "save on tab close"). */
  closing?: boolean;
}

interface OfficeTabs {
  docs: OpenDoc[];
  active: string;
  /** The file whose Versions window is open, if any. */
  versionsFor: OfficeFile | null;
}

let state: OfficeTabs = { docs: [], active: HOME_TAB, versionsFor: null };
const listeners = new Set<() => void>();
function set(next: OfficeTabs) { state = next; listeners.forEach((l) => l()); }
function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

export function useOfficeTabs(): OfficeTabs {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** The tabs as they are now, outside a render (tests read the store through this). */
export function officeTabsNow(): OfficeTabs {
  return state;
}

// ── One editor per file (design §5) ──
// A file panel's in-place editor registers here while it is mounted, with how to end it.
// WHY: opening the same file in an Office tab from anywhere (the briefcase, Recent, the
// project list) must close the in-place editor first, or two editors would hold one file and
// the older one's autosave would overwrite the newer one's work.
const inlineHolders = new Map<string, () => void>();

/** A file panel's in-place editor holds `path` until the returned function is called.
 *  A second in-place editor of the same file ends the first. */
export function holdInline(path: string, release: () => void): () => void {
  const previous = inlineHolders.get(path);
  if (previous && previous !== release) previous();
  inlineHolders.set(path, release);
  return () => { if (inlineHolders.get(path) === release) inlineHolders.delete(path); };
}

// Each mounted editor's "save what is unsaved, then resolve" (EditorFrame's flush).
// WHY: autosave waits 3 s after the last change, so leaving an in-place edit (Done, or the
// briefcase moving the file to an Office tab) inside that window would drop the last few
// seconds of typing. Those paths wait for this first — at most 5 s.
const flushers = new Map<string, () => Promise<void>>();

export function registerFlush(path: string, flush: () => Promise<void>): () => void {
  flushers.set(path, flush);
  return () => { if (flushers.get(path) === flush) flushers.delete(path); };
}

/** Save the file's unsaved changes, if an editor has it open; resolves when that is done. */
export function flushOffice(path: string): Promise<void> {
  return flushers.get(path)?.() ?? Promise.resolve();
}

/** The file's Office tab, if it has one (a closing tab still counts: its editor is mounted). */
export function officeDocFor(path: string): OpenDoc | null {
  return state.docs.find((d) => d.file.path === path) ?? null;
}

/** Open a file, or bring it forward if it is already open (also taking back a tab that was
 *  closing, so its still-mounted editor is reused rather than a second one started). */
export function openDoc(file: OfficeFile): void {
  inlineHolders.get(file.path)?.();
  const existing = state.docs.find((d) => d.file.path === file.path);
  const docs = existing
    ? state.docs.map((d) => (d.file.path === file.path ? { ...d, asleep: false, closing: false } : d))
    : [...state.docs, { file, asleep: false }];
  set({ ...state, docs, active: file.path });
}

/** Choosing a sleeping tab wakes it: its editor opens again where it was. */
export function selectTab(id: string): void {
  set({ ...state, docs: state.docs.map((d) => (d.file.path === id ? { ...d, asleep: false } : d)), active: id });
}

/** The person closed the tab. It leaves the strip at once; its editor stays mounted, hidden,
 *  until it has saved (EditorFrame calls finishClose). */
export function closeDoc(path: string): void {
  const shown = state.docs.filter((d) => !d.closing);
  const i = shown.findIndex((d) => d.file.path === path);
  if (i < 0) return;
  const rest = shown.filter((d) => d.file.path !== path);
  // Closing the front tab shows its neighbour, like a browser; the last one shows Home.
  const active = state.active !== path ? state.active : (rest[i] ?? rest[i - 1])?.file.path ?? HOME_TAB;
  // An asleep tab has no editor to save through: it goes at once.
  const doc = shown[i];
  const docs = doc.asleep
    ? state.docs.filter((d) => d.file.path !== path)
    : state.docs.map((d) => (d.file.path === path ? { ...d, closing: true } : d));
  set({ ...state, docs, active });
  if (doc.asleep) forgetSaveState(path);
}

/** The closing tab's editor has saved (or given up after 5 s): remove it for good. */
export function finishClose(path: string): void {
  if (!state.docs.some((d) => d.file.path === path && d.closing)) return;
  set({ ...state, docs: state.docs.filter((d) => d.file.path !== path) });
  forgetSaveState(path);
}

export function showVersions(file: OfficeFile | null): void {
  set({ ...state, versionsFor: file });
}

// ── Save state, per file (Task 6; design §4) ──
// Autosave is the only save there is (office-questions#Q-save), so the strip only reports it:
// the last save landed, one is pending or running, or one failed — with main's own reason.
export interface OfficeSaveState {
  phase: 'saved' | 'unsaved' | 'saving' | 'failed';
  /** ISO time of the last successful save. */
  savedAt?: string;
  /** Main's own reason, for `failed` (already worded for a person — office-commands.ts). */
  message?: string;
}

const SAVED: OfficeSaveState = { phase: 'saved' };
let saves: Record<string, OfficeSaveState> = {};
const saveListeners = new Set<() => void>();
function setSave(path: string, next: OfficeSaveState) {
  saves = { ...saves, [path]: next };
  saveListeners.forEach((l) => l());
}
function forgetSaveState(path: string) {
  if (!(path in saves)) return;
  const { [path]: _gone, ...rest } = saves;
  saves = rest;
  saveListeners.forEach((l) => l());
}
function subscribeSaves(l: () => void) { saveListeners.add(l); return () => { saveListeners.delete(l); }; }

export function saveStateFor(path: string): OfficeSaveState {
  return saves[path] ?? SAVED;
}
export function useSaveState(path: string | null): OfficeSaveState {
  const get = () => (path ? saveStateFor(path) : SAVED);
  return useSyncExternalStore(subscribeSaves, get, get);
}
export function markChanged(path: string): void {
  setSave(path, { phase: 'unsaved', savedAt: saves[path]?.savedAt });
}
/** The editor says nothing is unsaved after all (see EditorFrame): back to the last save. */
export function markUnchanged(path: string): void {
  setSave(path, { phase: 'saved', savedAt: saves[path]?.savedAt });
}
export function markSaving(path: string): void {
  setSave(path, { phase: 'saving', savedAt: saves[path]?.savedAt });
}
export function markSaved(path: string): void {
  setSave(path, { phase: 'saved', savedAt: new Date().toISOString() });
}
export function markFailed(path: string, message: string): void {
  setSave(path, { phase: 'failed', savedAt: saves[path]?.savedAt, message });
}

/** Workbench and screenshots only: lay out a given set of tabs at once. */
function setOfficeTabsForPreview(docs: OpenDoc[], active: string, versionsFor: OfficeFile | null = null): void {
  set({ docs, active, versionsFor });
}

/** Photo-only (`shoot`): three recent files open, the third asleep, the given
 *  one in front — optionally with its Versions window open. */
export async function previewOfficeTabs(front: number, withVersions = false): Promise<void> {
  const recent = (await window.claude?.office?.status(null))?.recent ?? [];
  const docs = recent.slice(0, 3).map((file, i) => ({ file, asleep: i === 2 }));
  const f = docs[front]?.file;
  setOfficeTabsForPreview(docs, f?.path ?? HOME_TAB, withVersions && f ? f : null);
}

/** Tests only: back to no documents and no save states. */
export function resetOfficeStoreForTests(): void {
  state = { docs: [], active: HOME_TAB, versionsFor: null };
  saves = {};
  inlineHolders.clear();
  flushers.clear();
  listeners.forEach((l) => l());
  saveListeners.forEach((l) => l());
}
