// Which documents are open in Office, and which is in front. A module store
// (performance rule 3: a slice store, not a Context) so the tabs outlive the
// page view: going back to chat and returning finds the same documents.
//
// It is also the ONE place that knows where each file is being edited — an Office tab, or an
// Edit in a file panel — so no file ever gets two editors at once (design §5, review 1 R1-2),
// and it holds each file's save state for the tab strip's "Saved" label (Task 6).
import { useSyncExternalStore } from 'react';
import type { OfficeFile } from '../../../shared/office-types';
import { holdUnsavedEditor } from '../../state/unsaved-editors';

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
// WHY: autosave waits 3–20 s after the last change, so anything that ends an editor — Done, the
// briefcase, closing the panel, leaving a tab, the hand-off to an Office tab, a reload — would
// leave the last few seconds of typing only in the recovery journal (Task 8). Those paths wait
// for this first (≤5 s), so the file itself holds them.
const flushers = new Map<string, (capMs?: number) => Promise<FlushResult>>();
// Each mounted editor's "throw these unsaved changes away" (Discard and quit, Task 8).
const discarders = new Map<string, () => void | Promise<void>>();
// Each mounted editor's "send your newest edits to the recovery journal now" (fix round 1).
const journalers = new Map<string, () => Promise<void>>();
/** WHY 4 s: a reload waits for every document's save at once, each capped, never longer. */
const RELOAD_FLUSH_CAP_MS = 4_000;

export function registerFlush(
  path: string, flush: (capMs?: number) => Promise<FlushResult>,
  opts: { discard?: () => void | Promise<void>; journal?: () => Promise<void> } = {},
): () => void {
  flushers.set(path, flush);
  if (opts.discard) discarders.set(path, opts.discard); else discarders.delete(path);
  if (opts.journal) journalers.set(path, opts.journal); else journalers.delete(path);
  return () => { if (flushers.get(path) === flush) { flushers.delete(path); discarders.delete(path); journalers.delete(path); } };
}

/**
 * Reload the window once every Office document has saved (or 4 s passed): the app's "reload"
 * Retry buttons go through this instead of location.reload(). WHY no prompt any more (Task 8): a
 * save that fails or runs late loses nothing — its edits are in the document's recovery journal,
 * and the next open of the file offers them back.
 */
export function reloadAfterOfficeSave(reload: () => void = () => window.location.reload()): void {
  void Promise.all([...flushers.values()].map((f) => f(RELOAD_FLUSH_CAP_MS).catch(() => null))).then(() => reload());
}

// ── Unsaved Office documents count in the one quit prompt (Task 8) ──
// WHY: a quit, or closing the last window, asks first while any file has unsaved changes
// (UnsavedBeforeQuit, main/unsaved-quit.ts). An Office document is unsaved from the editor's
// "modified" until its save lands — the strip's state below, anything but "Saved". Discard there
// throws the changes away (its editor's discard, which also drops its recovery journal).
const unsavedHolds = new Map<string, () => void>();
function syncUnsavedHold(path: string): void {
  const unsaved = (saves[path]?.phase ?? 'saved') !== 'saved';
  const release = unsavedHolds.get(path);
  if (unsaved && !release) {
    unsavedHolds.set(path, holdUnsavedEditor({ name: path.split(/[\\/]/).pop() ?? path, discard: () => discarders.get(path)?.() }));
  } else if (!unsaved && release) {
    unsavedHolds.delete(path);
    release();
  }
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

/** Save the file's unsaved changes, if an editor has it open. */
export function flushOffice(path: string): Promise<FlushResult> {
  return flushers.get(path)?.() ?? Promise.resolve({ ok: true });
}

// A quit (or the last window's close) refused for unsaved files (main/unsaved-quit.ts): show
// their list. Subscribed once, from OfficeAlerts — in every window, Office page or not; the host
// without Office (remote, phone) has no such push and nothing subscribes.
let promptWatched = false;
export function watchUnsavedPrompt(): void {
  const office = typeof window === 'undefined' ? undefined : window.claude?.office;
  if (promptWatched || !office?.onUnsavedPrompt) return;
  promptWatched = true;
  office.onUnsavedPrompt((p) => {
    setAlerts({ ...alerts, quitRefused: { mode: p.mode === 'close' ? 'close' : 'quit', afterTeardown: p.afterTeardown === true, restartDropped: p.restartDropped === true, confirming: false } });
    // WHY save the Office documents now: each one listed is only waiting for its autosave, so the
    // list empties by itself a moment later ("Nothing left unsaved here." → Quit).
    flushers.forEach((f) => void f().catch(() => null));
  });
  // The window is closing (main/office/office-journal-sync.ts, fix round 1): every editor sends its
  // newest edits to the journal and starts saving any unsaved changes (EditorFrame's journal), then
  // main hears that they went (main caps the wait at 1.5 s).
  office.onJournalRequest?.((id) => {
    void Promise.all([...journalers.values()].map((j) => j().catch(() => {}))).then(() => office.journalDone?.(id));
  });
}

// ── Edits kept for a file that changed outside Office (Task 8 fix round 1) ──
// Main offers them when the file opens (office:open's recoverOffer); the strip shows Recover
// unsaved changes / Discard until the person answers (OfficeRecoverOffer).
let recoverOffers: ReadonlySet<string> = new Set();
const offerListeners = new Set<() => void>();
export function noteRecoverOffer(path: string, on: boolean): void {
  if (recoverOffers.has(path) === on) return;
  const next = new Set(recoverOffers);
  if (on) next.add(path); else next.delete(path);
  recoverOffers = next;
  offerListeners.forEach((l) => l());
}
export function useRecoverOffer(path: string | null): boolean {
  const get = () => (path ? recoverOffers.has(path) : false);
  return useSyncExternalStore((l) => { offerListeners.add(l); return () => { offerListeners.delete(l); }; }, get, get);
}

// ── Alerts shown outside the Office page (fix round 2) ──
// The page may be closed (kept invisible), so these render beside it (OfficeAlerts).
//   closeFailed   a tab closed while the page was hidden could not save, so it came back
interface OfficeAlertsState {
  /** A quit (or the last window's close) was refused for unsaved files (fix rounds 9–11);
   *  `confirming` = the in-place "Discard unsaved changes…?" step is showing. */
  quitRefused: QuitRefused | null;
  closeFailed: string | null;
}
export interface QuitRefused { mode: 'quit' | 'close'; afterTeardown: boolean; restartDropped: boolean; confirming: boolean }
let alerts: OfficeAlertsState = { closeFailed: null, quitRefused: null };
const alertListeners = new Set<() => void>();
function setAlerts(next: OfficeAlertsState) { alerts = next; alertListeners.forEach((l) => l()); }
export function useOfficeAlerts(): OfficeAlertsState {
  return useSyncExternalStore((l) => { alertListeners.add(l); return () => { alertListeners.delete(l); }; }, () => alerts, () => alerts);
}
export function clearQuitRefused(): void { setAlerts({ ...alerts, quitRefused: null }); }
export function confirmDiscardForQuit(confirming: boolean): void {
  if (alerts.quitRefused) setAlerts({ ...alerts, quitRefused: { ...alerts.quitRefused, confirming } });
}
/** Photo-only (`shoot`): a refused quit — before teardown, after it (a restart), or at the
 *  discard step. The files are placed by the screen (UnsavedBeforeQuit's preview). */
export function previewQuitRefused(v: Partial<QuitRefused> = {}): void {
  setAlerts({ ...alerts, quitRefused: { mode: 'quit', afterTeardown: false, restartDropped: false, confirming: false, ...(alerts.quitRefused ?? {}), ...v } });
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

// ── Comments through the open editor (finish plan Task 6) ──
// Main sends each comment request for an open document to the window that opened it, naming
// the document by token (main/office/office-comments.ts); the editor holding that token runs it.
// One subscription, fanned out by token, for the same reason as onDocumentReplaced above.
const commentHandlers = new Map<string, (id: string, op: unknown) => void>();
let commentsSubscribed = false;
/** Run `handler` for main's comment requests to the document behind `token`. Returns the unsubscribe. */
export function onCommentsRequest(token: string, handler: (id: string, op: unknown) => void): () => void {
  const office = typeof window === 'undefined' ? undefined : window.claude?.office;
  if (!commentsSubscribed && office?.onCommentsRequest) {
    commentsSubscribed = true;
    office.onCommentsRequest((r) => {
      const h = r && typeof r.token === 'string' ? commentHandlers.get(r.token) : undefined;
      // No editor here for it (it just closed): main keeps the request and tries again.
      if (h) h(r.id, r.op); else office.commentsAnswer?.(r.id, { ok: false, error: 'editor-not-ready' }, r.token);
    });
  }
  commentHandlers.set(token, handler);
  return () => { if (commentHandlers.get(token) === handler) commentHandlers.delete(token); };
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
  /** After Save As / Download as / Export to PDF (finish plan Task 2): where the separate file
   *  went, or main's reason it could not be written. Shown briefly; the document's own save
   *  state is unchanged by it. */
  note?: string;
  /** failed because a restore replaced the file while this editor held unsaved typing: the only
   *  ways out are Save a copy… and Close without saving — a Retry would undo the restore. */
  keptAfterRestore?: boolean;
}

const SAVED: OfficeSaveState = { phase: 'saved' };
let saves: Record<string, OfficeSaveState> = {};
const saveListeners = new Set<() => void>();
function setSave(path: string, next: OfficeSaveState) {
  // A Save As note outlives the save states around it (the document's own autosave follows a Save
  // As within seconds); only its own timer, or a new note, replaces it.
  if (!('note' in next) && saves[path]?.note) next = { ...next, note: saves[path].note };
  // WHY an identical state changes nothing (perf investigation 2026-10-01): every call made a new
  // object and told every listener, so OfficeView and each open editor redrew per keystroke while
  // the editor kept saying "modified". Only a real change of the state reaches them now.
  if (sameSave(saves[path], next)) return;
  saves = { ...saves, [path]: next };
  saveListeners.forEach((l) => l());
  syncUnsavedHold(path);
}
/** The same save state field for field (an absent field and an undefined one are the same). */
function sameSave(a: OfficeSaveState | undefined, b: OfficeSaveState): boolean {
  if (!a) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as Array<keyof OfficeSaveState>);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}
function forgetSaveState(path: string) {
  if (!(path in saves)) return;
  const { [path]: _gone, ...rest } = saves;
  saves = rest;
  saveListeners.forEach((l) => l());
  syncUnsavedHold(path);
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
/** Save As wrote (or could not write) a separate file: say so briefly, keeping the document's own
 *  save state — a Save As never saves the document itself (finish plan Task 2). */
const noteSeq: Record<string, number> = {};
export function markNote(path: string, note: string): void {
  // WHY a number per note (Task 2 fix round 1): two Save As with the same result in a row used to
  // share one text, so the first note's timer cleared the second one early.
  const seq = (noteSeq[path] = (noteSeq[path] ?? 0) + 1);
  setSave(path, { ...saveStateFor(path), note });
  setTimeout(() => { if (noteSeq[path] === seq && saves[path]?.note) setSave(path, { ...saves[path], note: undefined }); }, COPIED_NOTE_MS);
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
  commentsPreview = false;
  const recent = (await window.claude?.office?.status(null))?.recent ?? [];
  const docs = recent.slice(0, 3).map((file, i) => ({ file, asleep: i === 2 && front !== 2 }));
  const f = docs[front]?.file;
  setOfficeTabsForPreview(docs, f?.path ?? HOME_TAB, withVersions && f ? f : null);
}

// Photo-only (`shoot`, finish plan Task 6): one document with Office's comments panel open — a
// workbench fixture whose comments were made through the live editor (the Word one holds the same
// comments as the reading view's launch brief, for comparison).
let commentsPreview = false;
export function officeCommentsPreview(): boolean { return commentsPreview; }
export function previewOfficeComments(kind: 'document' | 'spreadsheet'): void {
  const name = kind === 'document' ? 'Launch brief.docx' : 'Q3 sales by rep.xlsx';
  const path = `/home/you/Projects/community-garden/${name}`;
  commentsPreview = true;
  setOfficeTabsForPreview([{ file: { path, name, kind, folder: 'community-garden', at: new Date().toISOString() }, asleep: false }], path);
}

/** Tests only: back to no documents and no save states. */
export function resetOfficeStoreForTests(): void {
  state = { docs: [], active: HOME_TAB, versionsFor: null };
  saves = {};
  inlineHolders.clear();
  flushers.clear();
  discarders.clear();
  journalers.clear();
  recoverOffers = new Set();
  unsavedHolds.forEach((release) => release());
  unsavedHolds.clear();
  inlineCopies.clear();
  inlineRevealers.clear();
  promptWatched = false;
  reloaders.clear();
  changedSubscribed = false;
  commentHandlers.clear();
  commentsSubscribed = false;
  copyingPaths = new Set();
  alerts = { closeFailed: null, quitRefused: null };
  listeners.forEach((l) => l());
  saveListeners.forEach((l) => l());
}
