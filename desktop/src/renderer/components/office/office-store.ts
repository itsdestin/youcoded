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
const flushers = new Map<string, (capMs?: number) => Promise<FlushResult>>();
/** WHY 4 s (fix round 4): a window close or quit must answer inside main's 5 s cap, or main
 *  takes silence for a hung window and closes it anyway. Every document is saved at once, each
 *  capped at 4 s, so the answer always beats main's timeout. */
const CLOSE_FLUSH_CAP_MS = 4_000;
// Paths whose flusher only forwards to another editor's (an in-place edit that moved to its
// copy). WHY kept apart (fix round 3): a close or quit counts each failed document once.
const aliasPaths = new Set<string>();

export function registerFlush(
  path: string, flush: (capMs?: number) => Promise<FlushResult>,
  opts: { alias?: boolean; unsaved?: () => boolean } = {},
): () => void {
  flushers.set(path, flush);
  if (opts.alias) aliasPaths.add(path); else aliasPaths.delete(path);
  if (opts.unsaved) unsavedChecks.set(path, opts.unsaved); else unsavedChecks.delete(path);
  answerFlushRequests();
  guardUnload();
  return () => { if (flushers.get(path) === flush) { flushers.delete(path); aliasPaths.delete(path); unsavedChecks.delete(path); } };
}

// ── The window's own unload guard (fix round 5) ──
// WHY: anything that reloads or leaves the page — a Retry that reloads the window, a future
// navigation — would drop an Office edit that is not saved yet, or whose save failed, without a
// word: only main's close and quit ask the editors to save first. So the top window vetoes its
// unload while an editor has unsaved work (changed, asked to save, saving or failed) — unless
// that work was just dealt with: main's close or quit got its answer (every document saved), or
// the person chose Close anyway. That approval lets exactly one unload through (a close vetoed
// by something else, e.g. an unsaved text file, uses it up), and any new change withdraws it.
// Quit's last pass ('final') is the exception: the quit is decided, so nothing may stop it.
// Each mounted editor's "is anything unsaved" (EditorFrame).
const unsavedChecks = new Map<string, () => boolean>();
let unloadApproval: 'none' | 'once' | 'quit' = 'none';
function approveUnload(kind: 'once' | 'quit'): void {
  if (unloadApproval !== 'quit') unloadApproval = kind;
}
/** The editor reported a change (EditorFrame, fix round 6 M1): a pending one-unload approval no
 *  longer covers everything — even for a document whose save failed (markChanged is skipped
 *  there, so withdrawing cannot hang on it). */
export function withdrawUnloadApproval(): void {
  if (unloadApproval === 'once') unloadApproval = 'none';
}
function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (unloadApproval === 'quit') return;
  if (unloadApproval === 'once') { unloadApproval = 'none'; return; }
  if (![...unsavedChecks.values()].some((unsaved) => unsaved())) return;
  e.preventDefault();
  e.returnValue = ''; // older Chromium needs the returnValue set, too
}
let unloadGuarded = false;
function guardUnload(): void {
  if (unloadGuarded || typeof window === 'undefined') return;
  unloadGuarded = true;
  window.addEventListener('beforeunload', onBeforeUnload);
}

/**
 * Reload the window once every Office document is saved (fix round 5): the app's "reload"
 * Retry buttons go through this instead of location.reload(), so they save first and never
 * run into the unload guard. A document that cannot be saved raises the same prompt a window
 * close does; Close anyway then reloads.
 */
export function reloadAfterOfficeSave(reload: () => void = () => window.location.reload()): void {
  const entries = [...flushers.entries()].filter(([path]) => !aliasPaths.has(path));
  void Promise.all(entries.map(([, f]) => f(CLOSE_FLUSH_CAP_MS).catch(() => null))).then((results) => {
    // A flusher that threw (null) counts as failed (fix round 6, M6): nothing says it saved.
    const failed = entries.filter((_, i) => results[i]?.ok !== true).map(([path]) => path);
    if (failed.length === 0) { approveUnload('once'); reload(); return; }
    heldReload = reload;
    setAlerts({ ...alerts, unsaved: { count: failed.length, firstPath: failed[0], reload: true } });
  });
}
// The reload a failed save held, for Close anyway (null when the prompt is main's close or quit).
let heldReload: (() => void) | null = null;

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
    void Promise.all(entries.map(([, f]) => f(CLOSE_FLUSH_CAP_MS).catch(() => null))).then((results) => {
      // WHY report failures (fix round 2): a document whose save failed must not be closed with
      // its window without the person choosing that. Main holds the close (or quit) and sends
      // the prompt (counting every window's documents, office:unsaved-prompt).
      // A flusher that threw (null) counts as failed (fix round 6, M6): nothing says it saved.
      const failed = entries.filter((_, i) => results[i]?.ok !== true).map(([path]) => path);
      // The unload that main's close or quit goes on to may pass the window guard (see above).
      if (reason === 'final') approveUnload('quit'); else if (failed.length === 0) approveUnload('once');
      // WHY 'final' reports none (accepted, fix round 4 — M2): it is quit's last pass, after the
      // person already chose Close anyway. A document that newly fails in this pass is not asked
      // about again; asking would re-open a prompt during shutdown for a choice already made.
      // The editors stay as they are: the add-on keeps them from vetoing the unload (v0.1.2+).
      office.flushDone?.(id, { failed: reason === 'final' ? 0 : failed.length, firstPath: failed[0] });
    });
  });
  office.onUnsavedPrompt?.((p) => {
    // A quit refused for an unsaved text file (fix rounds 9–10) is its own message.
    if (p.other === true) { setAlerts({ ...alerts, quitRefused: { mode: p.mode ?? 'quit', afterTeardown: p.afterTeardown === true, restartDropped: p.restartDropped === true, confirming: false } }); return; }
    heldReload = null;
    setAlerts({ ...alerts, unsaved: { count: p.count, firstPath: p.firstPath } });
  });
}

/** "Close anyway": main goes ahead with the close or quit it held. WHY nothing is taken down
 *  (fix round 4): the editors keep their edits and failed-save state, so if the window survives
 *  (another veto, e.g. an unsaved text file) nothing was lost. The add-on (v0.1.3) keeps an
 *  editor page from vetoing the unload itself. */
export function closeAnyway(): void {
  setAlerts({ ...alerts, unsaved: null });
  // The person chose to let the failed documents go: the unload that follows may pass the guard.
  approveUnload('once');
  const reload = heldReload;
  heldReload = null;
  if (reload) reload(); else window.claude?.office?.proceedClose?.();
}

// ── Alerts shown outside the Office page (fix round 2) ──
// The page may be closed (kept invisible), so these render beside it (OfficeAlerts).
//   unsaved       a window close or quit found documents whose save failed
//   closeFailed   a tab closed while the page was hidden could not save, so it came back
interface OfficeAlertsState {
  /** reload: the prompt is a reload's (fix round 6, M3), so it says "Reload anyway". */
  unsaved: { count: number; firstPath: string; reload?: boolean } | null;
  /** A quit (or the last window's close) was refused for unsaved non-Office edits (fix rounds
   *  9–11); `confirming` = the in-place "Discard unsaved changes…?" step is showing. */
  quitRefused: QuitRefused | null;
  closeFailed: string | null;
}
export interface QuitRefused { mode: 'quit' | 'close'; afterTeardown: boolean; restartDropped: boolean; confirming: boolean }
let alerts: OfficeAlertsState = { unsaved: null, closeFailed: null, quitRefused: null };
const alertListeners = new Set<() => void>();
function setAlerts(next: OfficeAlertsState) { alerts = next; alertListeners.forEach((l) => l()); }
export function useOfficeAlerts(): OfficeAlertsState {
  return useSyncExternalStore((l) => { alertListeners.add(l); return () => { alertListeners.delete(l); }; }, () => alerts, () => alerts);
}
export function clearUnsavedPrompt(): void { heldReload = null; setAlerts({ ...alerts, unsaved: null }); }
export function clearQuitRefused(): void { setAlerts({ ...alerts, quitRefused: null }); }
export function confirmDiscardForQuit(confirming: boolean): void {
  if (alerts.quitRefused) setAlerts({ ...alerts, quitRefused: { ...alerts.quitRefused, confirming } });
}
/** Photo-only (`shoot`): a refused quit — before teardown, after it (a restart), or at the
 *  discard step. The files are placed by the screen (UnsavedBeforeQuit's preview). */
export function previewQuitRefused(v: Partial<QuitRefused> = {}): void {
  setAlerts({ ...alerts, quitRefused: { mode: 'quit', afterTeardown: false, restartDropped: false, confirming: false, ...(alerts.quitRefused ?? {}), ...v } });
}
/** Photo-only (`shoot`): the prompt as a window close with two unsaved documents shows it. */
export function previewUnsavedPrompt(): void {
  setAlerts({ ...alerts, unsaved: { count: 2, firstPath: state.docs[0]?.file.path ?? '' } });
}
export function noteCloseFailedWhileHidden(path: string): void { setAlerts({ ...alerts, closeFailed: path }); }
// Lost saves still to be said, one toast each (final review, finding 4): the last quit can have
// stopped several documents' saves, and each file gets its own toast — the next shows when the
// current one goes.
const lostQueue: string[] = [];
function sayLost(paths: string[]): void {
  for (const p of paths) if (p !== alerts.closeFailed && !lostQueue.includes(p)) lostQueue.push(p);
  if (!alerts.closeFailed && lostQueue.length > 0) noteCloseFailedWhileHidden(lostQueue.shift()!);
}
export function clearCloseFailed(): void { setAlerts({ ...alerts, closeFailed: lostQueue.shift() ?? null }); }

/** Saves that failed after the page that asked for them was reloaded (fix round 6, M4), and —
 *  on the first page after a launch — saves the last quit had to stop (final review, finding 4):
 *  main keeps them; this page takes them on load, and again whenever main says there are more,
 *  and says so with the same toast a hidden close uses, once per file. Returns the unsubscribe. */
export function watchLostSaves(): () => void {
  // Also listen for main's prompts from the start (fix round 9): a quit refused for an unsaved
  // text file must show in a window that never opened an Office document.
  answerFlushRequests();
  const office = typeof window === 'undefined' ? undefined : window.claude?.office;
  if (!office?.lostSaves) return () => {};
  const take = () => void office.lostSaves?.().then((paths) => { if (paths?.length) sayLost(paths); }, () => {});
  const stop = office.onSavesLost?.(take) ?? (() => {});
  take();
  return stop;
}

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
  // Not while its copy is being written (fix round 5): the copy switches this very tab.
  if (copyingPaths.has(path)) return;
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
  // (A copy can never be a file already open in Office: main refuses that target — fix round 4.)
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

// ── A restore replaced an open document's file (Task 7) ──
// Main pushes office:changed {path, token}; the editor holding that token reopens the file.
// WHY one subscription here, fanned out by token, rather than one per editor: a kept-hidden
// editor must not hold its own listener (performance rule 2), and the push names the document
// by token — the one identity main and the frame share (the path the tab uses may be a link).
const reloaders = new Map<string, Set<() => void>>();
let changedSubscribed = false;
/** Run `reload` when main replaces the file behind `token`. Returns the unsubscribe. */
export function onDocumentReplaced(token: string, reload: () => void): () => void {
  const office = typeof window === 'undefined' ? undefined : window.claude?.office;
  if (!changedSubscribed && office?.onChanged) {
    changedSubscribed = true;
    office.onChanged((p) => { reloaders.get(p?.token)?.forEach((r) => r()); });
  }
  const group = reloaders.get(token) ?? new Set();
  group.add(reload);
  reloaders.set(token, group);
  return () => { group.delete(reload); if (group.size === 0 && reloaders.get(token) === group) reloaders.delete(token); };
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
  /** failed because a restore replaced the file while this editor held unsaved typing: the only
   *  ways out are Save a copy… and Close without saving — a Retry would undo the restore. */
  keptAfterRestore?: boolean;
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
  // A new change withdraws a close's approval: that close has not saved it (see the guard).
  withdrawUnloadApproval();
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
export function markFailed(path: string, message: string, opts: { keptAfterRestore?: boolean } = {}): void {
  // WHY sticky: while an editor is kept after a restore, no other failure may replace its message
  // (or bring Retry back) — only the person's choice clears it (markUnchanged / markCopied).
  if (saves[path]?.keptAfterRestore && !opts.keptAfterRestore) return;
  setSave(path, { phase: 'failed', savedAt: saves[path]?.savedAt, message, ...(opts.keptAfterRestore ? { keptAfterRestore: true } : {}) });
}

// ── "Save a copy…" in progress, per file (fix round 5) ──
// WHY a store, not the strip's own state: while a copy runs the strip re-renders between
// "Saving…" and the failure, remounting its actions — they must stay disabled throughout, and
// the tab must not close under the copy.
let copyingPaths: ReadonlySet<string> = new Set();
const copyingListeners = new Set<() => void>();
export function noteCopying(path: string, on: boolean): void {
  if (copyingPaths.has(path) === on) return;
  const next = new Set(copyingPaths);
  if (on) next.add(path); else next.delete(path);
  copyingPaths = next;
  copyingListeners.forEach((l) => l());
}
export function useCopying(path: string | null): boolean {
  const get = () => (path ? copyingPaths.has(path) : false);
  return useSyncExternalStore((l) => { copyingListeners.add(l); return () => { copyingListeners.delete(l); }; }, get, get);
}

/** Workbench and screenshots only: lay out a given set of tabs at once. */
function setOfficeTabsForPreview(docs: OpenDoc[], active: string, versionsFor: OfficeFile | null = null): void {
  set({ docs, active, versionsFor });
}

/** Photo-only (`shoot`): three recent files open, the third asleep, the given
 *  one in front — optionally with its Versions window open. WHY the third wakes when it is the
 *  one in front (office/presentation, polish pass 2026-09-28): an asleep document is not mounted,
 *  so the presentation editor could never be photographed. */
export async function previewOfficeTabs(front: number, withVersions = false): Promise<void> {
  const recent = (await window.claude?.office?.status(null))?.recent ?? [];
  const docs = recent.slice(0, 3).map((file, i) => ({ file, asleep: i === 2 && front !== 2 }));
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
  answering = false;
  reloaders.clear();
  changedSubscribed = false;
  unsavedChecks.clear();
  unloadApproval = 'none';
  heldReload = null;
  copyingPaths = new Set();
  if (unloadGuarded) { window.removeEventListener('beforeunload', onBeforeUnload); unloadGuarded = false; }
  alerts = { unsaved: null, closeFailed: null, quitRefused: null };
  lostQueue.length = 0;
  listeners.forEach((l) => l());
  saveListeners.forEach((l) => l());
}
