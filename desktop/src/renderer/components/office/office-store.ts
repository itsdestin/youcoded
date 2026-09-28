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

/** How a "save what is unsaved" ended. `ok: false` carries main's own reason; the caller keeps
 *  the editor open with it (Retry, Save a copy…, Close without saving — the save-failed actions). */
export type FlushResult = { ok: true } | { ok: false; message: string };

// Each mounted editor's "save what is unsaved, then resolve" (EditorFrame's flush).
// WHY: autosave waits 3 s after the last change, so anything that ends an editor — Done, the
// briefcase, closing the panel, leaving a tab, the hand-off to an Office tab, window close and
// quit — would drop the last few seconds of typing. Those paths wait for this first (≤5 s).
const flushers = new Map<string, () => Promise<FlushResult>>();
// Paths whose flusher only forwards to another editor's (an in-place edit that moved to its
// copy). WHY kept apart (fix round 3): a close or quit counts each failed document once.
const aliasPaths = new Set<string>();

export function registerFlush(path: string, flush: () => Promise<FlushResult>, opts: { alias?: boolean } = {}): () => void {
  flushers.set(path, flush);
  if (opts.alias) aliasPaths.add(path); else aliasPaths.delete(path);
  answerFlushRequests();
  return () => { if (flushers.get(path) === flush) { flushers.delete(path); aliasPaths.delete(path); } };
}

// ── In-place edits that moved to their copy ("Save a copy…", fix round 2) ──
// The file panel still shows the original; its briefcase must open the copy (fix round 3).
const inlineCopies = new Map<string, string>();
export function noteInlineCopy(original: string, copy: string | null): void {
  if (copy) inlineCopies.set(original, copy); else inlineCopies.delete(original);
}
export function inlineCopyFor(original: string): string | null {
  return inlineCopies.get(original) ?? null;
}

// In-place editors can be brought forward for Review (the unsaved prompt, fix round 3).
const inlineRevealers = new Map<string, () => void>();
export function registerInlineReveal(path: string, reveal: () => void): () => void {
  inlineRevealers.set(path, reveal);
  return () => { if (inlineRevealers.get(path) === reveal) inlineRevealers.delete(path); };
}
/** Bring the in-place editor of `path` forward; false when no in-place editor has it. */
export function revealInline(path: string): boolean {
  const r = inlineRevealers.get(path);
  if (!r) return false;
  r();
  return true;
}

// ── Taking the editors down before a window goes (fix round 3) ──
// WHY: an editor page with unsaved changes cancels its window's unload (its own beforeunload),
// and main must not override unload vetoes — an unsaved text-file edit uses the same veto and
// must keep the window open. So once every document is saved (or the person chose Close
// anyway), the renderer removes the editors' frames itself before answering main: no editor
// page, no editor veto. If the window then stays open anyway (another veto, a cancelled
// prompt), the frames come back after a moment and load their documents again.
let suspended = false;
let resumeTimer: ReturnType<typeof setTimeout> | undefined;
const suspendListeners = new Set<() => void>();
const OFFICE_RESUME_MS = 10_000;
export function suspendOfficeEditors(): void {
  suspended = true;
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => { suspended = false; suspendListeners.forEach((l) => l()); }, OFFICE_RESUME_MS);
  suspendListeners.forEach((l) => l());
}
export function officeEditorsSuspended(): boolean { return suspended; }
/** Resolves once no editor frame is left in the page (React removes them on its next render),
 *  so main's close only starts after they are gone. Capped at 1 s: main still has its own cap. */
async function whenEditorFramesGone(): Promise<void> {
  const until = Date.now() + 1_000;
  while (typeof document !== 'undefined' && document.querySelector('iframe[data-office-editor]') && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 16));
  }
}
export function useOfficeEditorsSuspended(): boolean {
  return useSyncExternalStore((l) => { suspendListeners.add(l); return () => { suspendListeners.delete(l); }; }, () => suspended, () => suspended);
}

/** Save the file's unsaved changes, if an editor has it open. */
export function flushOffice(path: string): Promise<FlushResult> {
  return flushers.get(path)?.() ?? Promise.resolve({ ok: true });
}

// Window close and app quit (design §4, main/office/office-flush.ts): main asks this window to
// save every open document and waits for the answer (or 5 s). Subscribed once, on the first
// editor; the host without Office (remote, phone) has no such push and nothing subscribes.
let answering = false;
function answerFlushRequests(): void {
  const office = typeof window === 'undefined' ? undefined : window.claude?.office;
  if (answering || !office?.onFlushRequest || !office.flushDone) return;
  answering = true;
  office.onFlushRequest((id, reason) => {
    const entries = [...flushers.entries()].filter(([path]) => !aliasPaths.has(path));
    void Promise.all(entries.map(([, f]) => f().catch(() => null))).then((results) => {
      // WHY report failures (fix round 2): a document whose save failed must not be closed with
      // its window without the person choosing that. Main holds the close (or quit) and sends
      // the prompt (counting every window's documents, office:unsaved-prompt).
      const failed = entries.filter((_, i) => results[i]?.ok === false).map(([path]) => path);
      // 'final' is quit's last pass after the person chose: take everything down, ask nothing.
      const down = failed.length === 0 || reason === 'final';
      if (down) suspendOfficeEditors();
      void (down ? whenEditorFramesGone() : Promise.resolve()).then(() => {
        office.flushDone?.(id, { failed: reason === 'final' ? 0 : failed.length, firstPath: failed[0] });
      });
    });
  });
  office.onUnsavedPrompt?.((p) => setAlerts({ ...alerts, unsaved: { count: p.count, firstPath: p.firstPath } }));
}

/** "Close anyway": take the editors down, then let main go ahead with the close or quit. */
export function closeAnyway(): void {
  setAlerts({ ...alerts, unsaved: null });
  suspendOfficeEditors();
  void whenEditorFramesGone().then(() => window.claude?.office?.proceedClose?.());
}

// ── Alerts shown outside the Office page (fix round 2) ──
// The page may be closed (kept invisible), so these render beside it (OfficeAlerts).
//   unsaved       a window close or quit found documents whose save failed
//   closeFailed   a tab closed while the page was hidden could not save, so it came back
interface OfficeAlertsState {
  unsaved: { count: number; firstPath: string } | null;
  closeFailed: string | null;
}
let alerts: OfficeAlertsState = { unsaved: null, closeFailed: null };
const alertListeners = new Set<() => void>();
function setAlerts(next: OfficeAlertsState) { alerts = next; alertListeners.forEach((l) => l()); }
export function useOfficeAlerts(): OfficeAlertsState {
  return useSyncExternalStore((l) => { alertListeners.add(l); return () => { alertListeners.delete(l); }; }, () => alerts, () => alerts);
}
export function clearUnsavedPrompt(): void { setAlerts({ ...alerts, unsaved: null }); }
/** Photo-only (`shoot`): the prompt as a window close with two unsaved documents shows it. */
export function previewUnsavedPrompt(): void {
  setAlerts({ ...alerts, unsaved: { count: 2, firstPath: state.docs[0]?.file.path ?? '' } });
}
export function noteCloseFailedWhileHidden(path: string): void { setAlerts({ ...alerts, closeFailed: path }); }
export function clearCloseFailed(): void { setAlerts({ ...alerts, closeFailed: null }); }

/** The file's Office tab, if it has one (a closing tab still counts: its editor is mounted). */
export function officeDocFor(path: string): OpenDoc | null {
  return state.docs.find((d) => d.file.path === path) ?? null;
}

/** Open a file, or bring it forward if it is already open (also taking back a tab that was
 *  closing, so its still-mounted editor is reused rather than a second one started).
 *  A file being edited in place is saved first and only then handed over (C2, fix round 1):
 *  ending the in-place editor at once dropped whatever it had not saved yet. If that save
 *  fails, the file stays in place, where its error and Retry show. */
export function openDoc(file: OfficeFile): void {
  const holder = inlineHolders.get(file.path);
  if (holder) {
    void flushOffice(file.path).then((r) => {
      if (!r.ok) return;
      if (inlineHolders.get(file.path) === holder) holder();
      showDoc(file);
    });
    return;
  }
  showDoc(file);
}

function showDoc(file: OfficeFile): void {
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

/** The closing tab's save failed: it comes back, in front, where its error and actions show. */
export function cancelClose(path: string): void {
  if (!state.docs.some((d) => d.file.path === path && d.closing)) return;
  set({ ...state, docs: state.docs.map((d) => (d.file.path === path ? { ...d, closing: false } : d)), active: path });
}

/** "Save a copy…" landed (fix round 2): the tab now edits the copy — same place in the strip,
 *  in front if it was. The original's editor unmounts with nothing left to save. */
export function replaceDoc(oldPath: string, file: OfficeFile): void {
  // The copy already has a tab (fix round 3): bring that one forward, never a second tab.
  if (oldPath !== file.path && state.docs.some((d) => d.file.path === file.path)) {
    set({ ...state, docs: state.docs.filter((d) => d.file.path !== oldPath), active: file.path });
    forgetSaveState(oldPath);
    return;
  }
  set({
    ...state,
    docs: state.docs.map((d) => (d.file.path === oldPath ? { file, asleep: false } : d)),
    active: state.active === oldPath ? file.path : state.active,
  });
  forgetSaveState(oldPath);
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
  /** After "Save a copy…": the folder the copy went to (its name only, never a full path). */
  copiedTo?: string;
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
/** "Save a copy…" landed: the changes are in the copy, and the file itself is left as it was. */
export function markCopied(path: string, folder: string): void {
  setSave(path, { phase: 'saved', savedAt: saves[path]?.savedAt, copiedTo: folder });
  // "Briefly" (fix round 2): the note goes after a few seconds, or with the next save state.
  setTimeout(() => { if (saves[path]?.copiedTo === folder && saves[path]?.phase === 'saved') setSave(path, { phase: 'saved', savedAt: saves[path]?.savedAt }); }, COPIED_NOTE_MS);
}
const COPIED_NOTE_MS = 8_000;
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
  aliasPaths.clear();
  inlineCopies.clear();
  inlineRevealers.clear();
  suspended = false;
  clearTimeout(resumeTimer);
  answering = false;
  alerts = { unsaved: null, closeFailed: null };
  listeners.forEach((l) => l());
  saveListeners.forEach((l) => l());
}
