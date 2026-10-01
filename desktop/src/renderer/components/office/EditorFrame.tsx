// EditorFrame — one open document: the Euro-Office editor on its own sealed
// origin. Used by the Office page (full editor) and by the file viewers' Edit
// mode (slim: the editor's own chrome hidden, YouCoded's one-row bar instead —
// office-questions#Q-slim "YouCoded's own bar").
//
// Only small messages cross the frame, and only from this frame's window on this document's
// own origin (design §3a, §5; review 3 R3-1):
//   editor → host  {yc:'ready'}                 the editor listens for "open-file" now
//                  {yc:'rpc', id, cmd, args}    one request for main (the add-on's __TAURI__ relay)
//                  {type:'yc:office-loaded' | 'yc:office-state' | 'yc:office-esc'}
//   host → editor  {yc:'rpc-result', id, result | error}, {yc:'event', name, payload}
//                  {type:'yc:office-theme' | 'yc:office-mode' | 'yc:office-cmd' | 'yc:office-save'}
// The host only relays: main re-checks every command and that this window opened the document.
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { EmptyState, ErrorState, LoadingState } from '../ui';
import type { OfficeBridge, OfficeFile, OfficeSaveCopyResult } from '../../../shared/office-types';
import { OFFICE_MODE_MESSAGE, OFFICE_THEME_MESSAGE, editorFontLinks, readOfficeTheme, watchOfficeTheme } from './office-theme';
import { markChanged, markFailed, markNote, markSaved, markSaving, markUnchanged, noteCloseFailedWhileHidden, noteCopying, onDocumentReplaced, registerFlush, withdrawUnloadApproval } from './office-store';
import type { FlushResult } from './office-store';
import { ScreenMark } from '../../shoot-mode';
import { useDismissTop } from '../../hooks/use-esc-close';
import { plainMessage } from '../../utils/ipc-error';

export type OfficeCommand = 'undo' | 'redo' | 'bold' | 'italic' | 'underline' | 'markers' | 'numbering' | 'align-left' | 'align-center' | 'align-right';
export type OfficeCommandState = Partial<Record<OfficeCommand, { on: boolean; enabled: boolean }>>;
export interface EditorFrameHandle {
  command(cmd: OfficeCommand): void;
  /** Save now (the strip's Retry after a failed save). */
  save(): void;
  /** Whether "Save a copy…" can succeed for this document (main knows: an edited copy exists
   *  and the failed save did not fail in the translation itself). */
  canSaveCopy(): Promise<boolean>;
  /** Save once more (so main has the newest edits), then write them to a copy the person picks. */
  saveCopy(): Promise<OfficeSaveCopyResult>;
  /** "Close without saving" was confirmed: forget the unsaved changes so a close lets go. */
  discard(): void;
}

/** WHY 3 s (design §4): long enough that a burst of typing is one save, short enough that
 *  closing the laptop loses almost nothing. Each change restarts it. */
const AUTOSAVE_DELAY_MS = 3_000;
/** WHY a longer wait for big documents (finish plan Task 5, measured in the dev window
 *  2026-09-30): the editor freezes while it gathers the document's bytes for a save — ~0.1 s for a
 *  20 MB Word file, ~0.45 s for a 5 MB workbook, ~1.9 s for a 20 MB one. Saving 3 s into every
 *  pause put that freeze wherever the person paused to think, so a workbook that freezes for 2 s
 *  waits ~20 s instead: the freeze stays under a tenth of the pause that triggers it. Measured as
 *  the time from asking for a save to the bytes arriving; small documents keep 3 s. Closing,
 *  Done and quit still save at once (flush), so nothing waits longer when the person leaves. */
const AUTOSAVE_FREEZE_FACTOR = 10;
const AUTOSAVE_MAX_DELAY_MS = 20_000;
export const autosaveDelay = (handOverMs: number) =>
  Math.min(AUTOSAVE_MAX_DELAY_MS, Math.max(AUTOSAVE_DELAY_MS, Math.round(handOverMs * AUTOSAVE_FREEZE_FACTOR)));
/** WHY 5 s (design §4): the longest a closing tab waits for its last save before it lets go.
 *  Main still drains a save it already has (office-sessions close), so this only bounds how
 *  long the hidden editor lingers. */
const CLOSE_SAVE_WAIT_MS = 5_000;
/** WHY 60 s (fix round 2): the longest an asked-for save may go without its save_file before it
 *  counts as failed. The editor's own save ends in save_file within milliseconds (measured);
 *  anything this late means the editor gave up without telling the host (a failed
 *  get_current_path, an exception in its save path), and "Saving…" must not stay up forever. */
const REQUESTED_SAVE_LIMIT_MS = 60_000;
/** How recently a "not modified" may have dropped unsaved changes and still count as the start of
 *  a Save As (measured: the editor sends it milliseconds before the Save As dialog is asked for). */
const SAVE_AS_START_MS = 5_000;
/** How long after a Save As ends its trailing "not modified" is ignored (measured: milliseconds).
 *  A "not modified" later than this is taken as the editor's own again (a limit, pinned by a test). */
const SAVE_AS_END_MS = 2_000;
/** The longest a Save As's dialog may keep "not modified" from dropping changes (Task 2 fix
 *  round 1): a dialog left open that long, or an editor that never answered, stops holding it. */
const SAVE_AS_MAX_MS = 10 * 60_000;
/** A restore landed while this editor still held unsaved typing (see onDocumentReplaced below). */
const REPLACED_WHILE_EDITING = 'This file was restored while you had unsaved changes here. Save a copy to keep them.';


/** The theme as the editor gets it. WHY fontLinks are rewritten (Task 9): the editor's CSP
 *  (font-src 'self') blocks the Google stylesheets the theme links, so each one goes through
 *  the editor's own origin's font route instead, which main fetches from Google's font hosts. */
const editorTheme = (origin: string) => {
  const theme = readOfficeTheme();
  return { ...theme, fontLinks: editorFontLinks(theme.fontLinks, origin) };
};

function officeBridge(): OfficeBridge | undefined {
  return window.claude?.office;
}

// Slim mode: the frame is drawn a little LARGER than its pane and the pane crops it, so the
// editor's own chunky scroll bars (14px, right and bottom) and the gap it keeps above the first
// page fall just outside what shows (office-review-2#A-inline, Destin: "the scroll bars look
// janky, as does the gap between the top of the doc and the edit bar"). The editor offers no
// setting for either; hiding the bars in its own page leaves their strips empty instead.
// Wheel, trackpad and touch still scroll. Numbers are the editor's own sizes at 100% UI scale.
// An iframe does not stretch between inset edges (it keeps its 300x150 default), so the
// overscan is an explicit size: 14px wider, 18px + 14px taller, lifted 18px.
const SLIM_OVERSCAN: React.CSSProperties = { top: '-1.125rem', left: 0, width: 'calc(100% + 0.875rem)', height: 'calc(100% + 2rem)' };

export function stripExt(name: string): string {
  return name.replace(/\.(docx|xlsx|pptx|odt|ods|odp|doc|xls|ppt|csv)$/i, '');
}

interface EditorFrameProps {
  file: OfficeFile;
  hidden?: boolean;
  slim?: boolean;
  /** Slim mode: which commands are on / available, for the host's bar. */
  onCommandState?: (s: OfficeCommandState) => void;
  /** Photo-only mark once the document is drawn. */
  screen?: string;
  /** The tab was closed: save what is unsaved, then call onClosed (at most 5 s later). */
  closing?: boolean;
  onClosed?: () => void;
  /** The close's save failed: the tab stays, its strip showing the reason with Retry. */
  onCloseFailed?: (message: string) => void;
  /** "Save a copy…" landed: the host moves this slot to the copy (same tab / same in-place slot). */
  onSwitchTo?: (copyPath: string, folder: string) => void;
}

interface RpcMessage { yc: 'rpc'; id: unknown; cmd: string; args?: unknown }
// WHY only save_file (fix round 1): save_changes is sdkjs's crash-recovery change log, sent at
// the START of the editor's own save; counting it as the save let a close settle before the
// real save_file had even been sent.
const isSaveCmd = (cmd: string) => cmd === 'save_file';
/** Save As / Download as / Export to PDF (finish plan Task 2): its dialog and its write. */
const isSaveAsCmd = (cmd: string) => cmd === 'save_dialog' || cmd === 'save_file_as';

export const EditorFrame = forwardRef<EditorFrameHandle, EditorFrameProps>(function EditorFrame(
  { file, hidden = false, slim = false, onCommandState, screen, closing = false, onClosed, onCloseFailed, onSwitchTo }, handleRef,
) {
  const ref = useRef<HTMLIFrameElement>(null);
  // 'unavailable': this host refuses Office outright (remote, phone) — a fact, not a failure.
  const [phase, setPhase] = useState<'starting' | 'open' | 'failed' | 'unavailable'>('starting');
  const [failure, setFailure] = useState('');
  // Every open document has its own sealed office://<token> origin, handed out by office.open.
  // null until main has answered.
  const [opened, setOpened] = useState<{ token: string; origin: string } | null>(null);
  const origin = opened?.origin ?? null;
  const openedRef = useRef(opened);
  openedRef.current = opened;
  // Bumped by Retry, to open the document again from the start.
  const [attempt, setAttempt] = useState(0);
  // I2 (fix round 4): while Save a copy runs, an overlay takes the pointer and the keyboard (and
  // the frame is inert, fix round 5), so nothing typed mid-copy can be left out of it.
  const [copying, setCopying] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const overlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (copying) overlayRef.current?.focus(); }, [copying]);
  // Escape the editor itself had no use for closes the app's top layer, as a page's does.
  const dismissTop = useDismissTop();
  const dismissRef = useRef(dismissTop);
  dismissRef.current = dismissTop;
  const stateCb = useRef(onCommandState);
  stateCb.current = onCommandState;
  const closedCb = useRef(onClosed);
  closedCb.current = onClosed;
  const closeFailedCb = useRef(onCloseFailed);
  closeFailedCb.current = onCloseFailed;
  const switchToCb = useRef(onSwitchTo);
  switchToCb.current = onSwitchTo;
  const originRef = useRef<string | null>(null);
  originRef.current = origin;
  // A restore replaced this document's file (Task 7): from that moment until the editor has
  // reopened it, nothing this editor sends reaches main — its content is the OLD document, and a
  // save of it would undo the restore. (Main refuses such saves too; this is the first line.)
  const replacedRef = useRef(false);
  // Kept after a restore (fix round 2): a restore replaced the file while THIS editor held unsaved
  // typing, so it keeps that typing instead of reloading. From then on nothing it holds may reach
  // the file or the session's Editor.bin (another editor of the same file may be saving from it):
  // its save_file is answered here, and its bytes (write_editor_bin) are kept here, for "Save a
  // copy…" to hand to main directly. Cleared only by the person: Close without saving, or a copy.
  const keptRef = useRef(false);
  const keptBinRef = useRef<string | null>(null);
  const post = (msg: unknown) => { const o = originRef.current; if (o) ref.current?.contentWindow?.postMessage(msg, o); };

  // ── Autosave (design §4), per document ──
  // WHY refs, not state: they change on every keystroke's "modified" and must never re-render.
  //   dirty      changes the editor has not been asked to save yet
  //   requested  the editor was asked (yc:office-save) and its save_file has not arrived yet —
  //              the editor's own save sends save_changes, write_editor_bin and only then save_file
  //   saving     a save_file is with main
  //   failed     the last save failed (its message kept); only Retry, a new change or a flush
  //              tries again — never every 3 s against a read-only file
  // A change while a save is out waits for its result and then triggers exactly ONE follow-up
  // save (coalescing, design §3 "one save in flight").
  const save = useRef({
    dirty: false, requested: false, saving: false, failed: false, failMessage: '',
    // Which asked-for save the editor's bytes last reached main for (fix round 5): each request
    // gets the next number, and a write_editor_bin that succeeds records the number that was
    // current when the editor sent it. Save a copy needs a hand-over for ITS OWN request — a
    // failed one, or none at all before the cap, would copy the older Editor.bin.
    requestSeq: 0, handedOverSeq: 0,
    // The cap let go of a save still with main (a close, a Done): main drains it, and if it then
    // fails, this frame is gone — so the toast says so (fix round 5).
    drainPending: false,
    timer: 0 as ReturnType<typeof setTimeout> | 0,
    requestTimer: 0 as ReturnType<typeof setTimeout> | 0,
    waiters: [] as Array<() => void>,
    // Save As (finish plan Task 2, measured in the dev window 2026-09-29): the editor starts every
    // save — a Save As too — by saying "not modified", and says it again when the copy is done,
    // yet a Save As never writes the document's own file. droppedAt: when a "not modified" last
    // dropped unsaved changes; saveAsDirty: the document had unsaved changes when a Save As began;
    // saveAsUntil: until then a "not modified" is the Save As ending, not the document.
    droppedAt: 0, saveAsDirty: false, saveAsUntil: 0,
    // How long the editor took, last time, from being asked to save to handing its bytes over
    // (its freeze); askedAt is when the outstanding ask was posted (0: none). See autosaveDelay.
    askedAt: 0, handOverMs: 0,
  });
  // A save that failed without save_file failing (fix round 2): the editor's write_editor_bin
  // was refused, the editor's save path gave up, or no save_file ever came. Same outcome as a
  // failed save_file — the strip shows the reason with the save-failed actions.
  const failRequested = (message: string) => {
    const s = save.current;
    if (s.requestTimer) { clearTimeout(s.requestTimer); s.requestTimer = 0; }
    if (!s.requested || s.saving) return;
    s.requested = false;
    s.askedAt = 0;
    s.dirty = true;
    s.failed = true;
    s.failMessage = message;
    markFailed(file.path, message);
    wake();
  };
  const requestSave = () => {
    const s = save.current;
    if (s.timer) { clearTimeout(s.timer); s.timer = 0; }
    s.dirty = false;
    s.failed = false;
    s.requested = true;
    s.requestSeq += 1;
    s.askedAt = Date.now();
    if (s.requestTimer) clearTimeout(s.requestTimer);
    s.requestTimer = setTimeout(() => { s.requestTimer = 0; failRequested("Office didn't finish saving this file."); }, REQUESTED_SAVE_LIMIT_MS);
    post({ type: 'yc:office-save' });
  };
  const armAutosave = () => {
    if (keptRef.current) return; // kept after a restore: nothing is saved to the file (above)
    const s = save.current;
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => { s.timer = 0; requestSave(); }, autosaveDelay(s.handOverMs));
  };
  // Every waiter re-checks after any change of save state.
  const wake = () => save.current.waiters.slice().forEach((w) => w());
  const saveSettled = () => {
    const s = save.current;
    s.saving = false;
    if (s.dirty && !s.failed) {
      // WHY at once when someone waits (C1, fix round 1): a close or Done must not settle
      // while a change made during the save is still unsaved — it gets its follow-up now.
      if (s.waiters.length > 0) requestSave(); else armAutosave();
    }
    wake();
  };
  /**
   * Save whatever is unsaved. Resolves ok only once nothing is dirty, requested or saving —
   * including any follow-up save — and with main's message when a save failed (the caller then
   * keeps the editor open with that error and Retry). After 5 s it resolves ok only if a
   * save_file is with main and nothing changed since (main drains that save before the document
   * closes) — never while anything is dirty (fix round 2); otherwise the save counts as failed.
   */
  // Resolves once no asked-for hand-over is outstanding (kept after a restore), or after capMs.
  const untilNotRequested = (capMs: number) => new Promise<void>((resolve) => {
    const s = save.current;
    const done = () => { clearTimeout(cap); s.waiters = s.waiters.filter((w) => w !== check); resolve(); };
    const check = () => { if (!s.requested) done(); };
    const cap = setTimeout(done, capMs);
    s.waiters.push(check);
    check();
  });
  const flush = (capMs: number = CLOSE_SAVE_WAIT_MS): Promise<FlushResult> => {
    const s = save.current;
    // Kept after a restore: this editor's changes can never be saved to the file, so every flush
    // (a close, Done, quit) reports that — the person chooses Save a copy… or Close without saving.
    if (keptRef.current) return untilNotRequested(capMs).then(() => ({ ok: false, message: REPLACED_WHILE_EDITING }));
    const settled = () => !s.dirty && !s.requested && !s.saving && !s.timer;
    if (!originRef.current || (settled() && !s.failed)) return Promise.resolve({ ok: true });
    return new Promise<FlushResult>((resolve) => {
      const finish = (r: FlushResult) => {
        clearTimeout(cap);
        s.waiters = s.waiters.filter((w) => w !== check);
        resolve(r);
      };
      const check = () => {
        if (s.failed && !s.requested && !s.saving) finish({ ok: false, message: s.failMessage });
        else if (settled()) finish({ ok: true });
      };
      const cap = setTimeout(() => {
        if (s.saving && !s.dirty) { s.drainPending = true; finish({ ok: true }); return; }
        const message = "Office didn't finish saving this file.";
        // Recorded as a failed save, so the tab (or in-place editor) shows it with its actions.
        s.failed = true; s.failMessage = message; s.dirty = true;
        if (s.requested) { s.requested = false; if (s.requestTimer) { clearTimeout(s.requestTimer); s.requestTimer = 0; } }
        markFailed(file.path, message);
        finish({ ok: false, message });
      }, capMs);
      s.waiters.push(check);
      if ((s.dirty || s.failed) && !s.saving && !s.requested) requestSave();
    });
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  /** Ask the editor to save now (its bytes reach main even when the save itself fails again).
   *  Resolves true only when the editor handed its bytes over for a request made by this call
   *  (fix round 5). WHY always dirty: a save already under way was asked for before this call,
   *  so its bytes may predate the newest typing — marking dirty makes it follow up with one more. */
  const handOver = async (): Promise<boolean> => {
    const s = save.current;
    if (keptRef.current) {
      // Ask the editor for its bytes; they are kept here (relay below), and its save_file that
      // follows is answered here — nothing reaches the file or the session's Editor.bin.
      s.requestSeq += 1;
      s.requested = true;
      post({ type: 'yc:office-save' });
      await untilNotRequested(CLOSE_SAVE_WAIT_MS);
      s.requested = false;
      return keptBinRef.current !== null && s.handedOverSeq === s.requestSeq;
    }
    const before = s.requestSeq;
    s.dirty = true;
    await flush();
    return s.requestSeq > before && s.handedOverSeq === s.requestSeq;
  };
  // The person let go of typing kept after a restore (Close without saving, or its copy saved).
  // WHY replacedRef too (fix round 3): this editor still holds the OLD document until it goes
  // away, so from now on it answers everything locally — clearing the kept flag alone would
  // let its next autosave reach the restored file. Main drops the pictures it put aside.
  const letGoOfKept = (token: string | undefined) => {
    keptRef.current = false;
    keptBinRef.current = null;
    replacedRef.current = true;
    if (token) void officeBridge()?.saveCopy(token, 'release').catch(() => {});
  };
  const discardPending = () => {
    const s = save.current;
    if (s.timer) { clearTimeout(s.timer); s.timer = 0; }
    if (s.requestTimer) { clearTimeout(s.requestTimer); s.requestTimer = 0; }
    s.dirty = false; s.failed = false; s.requested = false; s.drainPending = false;
    wake();
  };

  // Open the document in main, and close it again when this frame goes away, so its
  // temporary files do not outlive the tab. A late answer (this frame already gone) is closed
  // too: main counts each open of a token, so that close only ends this frame's share and
  // never the document another frame of the same file is showing.
  useEffect(() => {
    const b = officeBridge();
    let gone = false;
    let token: string | null = null;
    const failWith = (message: string) => { if (!gone) { setFailure(message); setPhase('failed'); } };
    if (!b) { failWith("Office couldn't open this file."); return; }
    b.open(file.path).then((r) => {
      if (!r.ok) { failWith(r.message); return; }
      if (gone) { void b.close(r.token).catch(() => {}); return; }
      token = r.token;
      replacedRef.current = false;
      setOpened({ token: r.token, origin: r.origin });
    }, (e: unknown) => {
      // WHY (Task 5 fix rounds 1-2): on the remote client and the phone the host refuses Office
      // outright. That is known for certain, so say it (plainMessage names the feature and
      // where) rather than the general "couldn't open", which would blame the file — and as a
      // plain notice with no Retry, since retrying can never help.
      if (!/^remote-unsupported:/.test(String((e as Error)?.message ?? ''))) { failWith("Office couldn't open this file."); return; }
      if (!gone) { setFailure(plainMessage(e)); setPhase('unavailable'); }
    });
    return () => {
      gone = true;
      const s = save.current;
      if (s.timer) { clearTimeout(s.timer); s.timer = 0; }
      if (s.requestTimer) { clearTimeout(s.requestTimer); s.requestTimer = 0; }
      if (token) void b.close(token).catch(() => {});
    };
  }, [file.path, attempt]);

  // Registered so a file panel's Done and the header briefcase can wait for the last save
  // before this editor goes (office-store flushOffice).
  // `unsaved` feeds the window's unload guard (office-store, fix round 5): changed, asked to
  // save, saving, or failed — anything a reload would lose.
  useEffect(() => registerFlush(file.path, (capMs) => flushRef.current(capMs), {
    unsaved: () => { const s = save.current; return s.dirty || s.requested || s.saving || s.failed || !!s.timer; },
  }), [file.path]);

  // Restore (Task 7): main replaced the file under this editor. Reopen it from the start — close
  // this token, open again, a fresh editor page on the restored file. WHY nothing unsaved is lost:
  // the Versions window saved this document (flushOffice) before asking for the restore, and it
  // stays open over the editor until the restore answers, so nothing can be typed in between.
  // Any change the editor still reports now is the old document's, and is let go on purpose.
  useEffect(() => {
    const token = opened?.token;
    if (!token) return;
    return onDocumentReplaced(token, () => {
      // Belt and braces (fix round 1): the Versions window saves first and blocks typing until
      // the restore answers, so nothing should be unsaved here. If something is anyway, this
      // editor holds the only copy of it: keep it — never reload over it — and show the
      // save-failed actions (Save a copy…, Close without saving). Main refuses its saves until
      // it reloads, so it cannot land on the restored file either.
      const s = save.current;
      if (keptRef.current) return;
      if (s.dirty || s.requested || s.saving || s.timer) {
        if (s.timer) { clearTimeout(s.timer); s.timer = 0; }
        if (s.requestTimer) { clearTimeout(s.requestTimer); s.requestTimer = 0; }
        keptRef.current = true;
        // A save still with main was queued after the restore: main refuses it, and its answer
        // is ignored here (the relay's answer guards) — it must not leave "Saving…" stuck.
        s.dirty = true; s.failed = true; s.requested = false; s.saving = false; s.failMessage = REPLACED_WHILE_EDITING;
        markFailed(file.path, REPLACED_WHILE_EDITING, { keptAfterRestore: true });
        wake();
        return;
      }
      replacedRef.current = true;
      discardPending();
      markUnchanged(file.path);
      setPhase('starting');
      setOpened(null);
      setAttempt((n) => n + 1);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- discardPending reads refs only
  }, [opened?.token, file.path]);

  // The closed tab saves first, then lets go (design §4: "on tab close").
  useEffect(() => {
    if (!closing) return;
    let cancelled = false;
    // I1 (fix round 1): a save that failed keeps the tab, showing main's reason and Retry —
    // closing must never throw the changes away without saying so.
    void flushRef.current().then((r) => {
      if (cancelled) return;
      if (r.ok) closedCb.current?.(); else closeFailedCb.current?.(r.message);
    });
    return () => { cancelled = true; };
  }, [closing]);

  // The shown document takes focus on a tab switch, so keyboard and screen
  // reader follow what is on screen (UX review 1, U4).
  useEffect(() => { if (!hidden && phase === 'open') ref.current?.focus(); }, [hidden, phase]);

  useImperativeHandle(handleRef, () => ({
    command: (cmd) => post({ type: 'yc:office-cmd', cmd }),
    // No Retry while kept after a restore (the strip hides it too): a save would undo the restore.
    save: () => { const s = save.current; if (!keptRef.current && !s.saving && !s.requested) requestSave(); },
    canSaveCopy: async () => {
      const b = officeBridge();
      const t = openedRef.current?.token;
      if (!b?.saveCopy || !t) return false;
      // Kept after a restore: the copy is made from this editor's own bytes, so it is possible.
      if (keptRef.current) return true;
      const r = await b.saveCopy(t, 'check').catch(() => null);
      return !!r && r.ok && 'possible' in r && r.possible;
    },
    saveCopy: async () => {
      const b = officeBridge();
      const t = openedRef.current?.token;
      if (!b?.saveCopy || !t) return { ok: false, message: "Office couldn't save a copy of this file." };
      // WHY save first (the owner's choice between "trigger the save flow" and "reuse the last
      // Editor.bin"): the save sends the editor's newest bytes to main (write_editor_bin) even
      // when the save itself fails again, so the copy holds every change — not only those up
      // to the last save attempt.
      setCopying(true);
      noteCopying(file.path, true);
      try {
        // Always a fresh hand-over (not just "save if dirty"): the copy is made from these bytes.
        // I3 (fix round 4) / fix round 5: if they did not reach main for this very request (the
        // hand-over failed, or none came before the cap), the copy would miss edits — refuse
        // rather than switch or discard anything.
        // Said on the strip itself (the save-failed actions stay): the strip re-renders between
        // "Saving…" and the failure while this runs, which would drop a message kept only here.
        // Kept after a restore: the strip keeps its own message (the copy's failure shows beside it).
        const refuse = (message: string) => { if (keptRef.current) return { ok: false as const, message }; save.current.failMessage = message; markFailed(file.path, message); return { ok: false as const, message }; };
        // The editor's own bytes when kept after a restore, handed to main for the copy only.
        const copy = (mode: 'save' | 'again') => {
          const bin = keptRef.current ? keptBinRef.current : null;
          return bin === null ? b.saveCopy(t, mode) : b.saveCopy(t, mode, bin);
        };
        const COPY_FAILED = "Office couldn't save a copy of this file.";
        if (!(await handOver())) return refuse(COPY_FAILED);
        const failCopy = (e: unknown) => ({ ok: false as const, message: plainMessage(e, COPY_FAILED) });
        let r: OfficeSaveCopyResult = await copy('save').catch(failCopy);
        // Main refused the copy (e.g. the target is open in Office): say so on the strip.
        if (!r.ok && 'message' in r) return refuse(r.message);
        // WHY one final check, not rounds of catch-up (fix round 4): the overlay below blocks
        // typing while the copy is written, so the editor's bytes can only differ if something
        // slipped in before the overlay took the keyboard. One more hand-over and 'again' (main
        // compares the bytes) covers that; if it still differs, nothing is switched or discarded.
        if (r.ok && 'folder' in r) {
          const again: OfficeSaveCopyResult = (await handOver())
            ? await copy('again').catch(failCopy)
            : { ok: false, message: COPY_FAILED };
          // 'again' rewrote the copy if the bytes differed, so on success the copy is current.
          // WHY say so rather than delete it (fix round 6, M5): the copy from 'save' is complete
          // (written whole, then renamed into place) — only the last moments' typing may be
          // missing. Deleting it could also delete a file the person chose to replace. So it
          // stays, the strip says it is older, and this tab keeps the newest edits.
          if (!again.ok) return refuse(`An older copy was saved to ${r.folder}. Your newest changes are still only here.`);
        }
        if (r.ok && 'folder' in r) {
          // "Save As" (the owner's decision, fix round 2): the changes now live in the copy, and
        // the tab carries on editing the COPY — the original has nothing left to save, and later
        // typing must land in the copy, not in a file that cannot be saved.
          discardPending();
          // The typing is safe in the copy: this slot now edits the copy, an ordinary document.
          if (keptRef.current) letGoOfKept(t);
          switchToCb.current?.(r.path, r.folder);
        }
        return r;
      } finally {
        setCopying(false);
        noteCopying(file.path, false);
      }
    },
    discard: () => { if (keptRef.current) letGoOfKept(openedRef.current?.token); discardPending(); markUnchanged(file.path); },
  }), [file.path]);

  useEffect(() => {
    if (!opened) return;
    const b = officeBridge();
    // Kept after a restore (see keptRef): answer the save's two steps here. true when handled.
    const keptRelay = (m: RpcMessage): boolean => {
      const s = save.current;
      if (m.cmd === 'save_file') {
        post({ yc: 'rpc-result', id: m.id, error: REPLACED_WHILE_EDITING });
        s.requested = false;
        wake();
        return true;
      }
      if (m.cmd === 'write_editor_bin') {
        const data = (m.args as { data?: unknown } | undefined)?.data;
        if (typeof data !== 'string') { post({ yc: 'rpc-result', id: m.id, error: "Office couldn't finish that." }); return true; }
        keptBinRef.current = data;
        s.handedOverSeq = s.requestSeq;
        post({ yc: 'rpc-result', id: m.id, result: 'ok' });
        wake();
        return true;
      }
      // WHY refused (finish plan Task 2): a Save As writes the session's Editor.bin, which a kept
      // editor never feeds (its typing lives only in keptBinRef). "Save a copy" keeps it instead.
      if (isSaveAsCmd(m.cmd)) {
        post({ yc: 'rpc-result', id: m.id, error: REPLACED_WHILE_EDITING });
        return true;
      }
      if (m.cmd === 'set_document_modified') {
        // More typing: still only in this editor. The strip stays as it is.
        if ((m.args as { modified?: unknown } | undefined)?.modified === true) { s.dirty = true; withdrawUnloadApproval(); }
        post({ yc: 'rpc-result', id: m.id, result: null });
        return true;
      }
      return false;
    };
    // WHY (finish plan Task 2): the copy holds the edits, the document's own file does not. The
    // edits it had become unsaved again and autosave writes them where the person opened the
    // file — otherwise closing now would lose them from it (measured: it did). The editor's own
    // closing "not modified" is ignored for a moment; yc-bridge saves even though the editor
    // now thinks nothing changed (add-on v0.1.13).
    const saveAsEnded = () => {
      const s = save.current;
      s.saveAsUntil = Date.now() + SAVE_AS_END_MS;
      // Same guard as every answer (fix round 1): not for a document this editor has let go of.
      if (!mountedRef.current || replacedRef.current || keptRef.current || openedRef.current?.token !== opened.token) { s.saveAsDirty = false; return; }
      if (!s.saveAsDirty) return;
      s.saveAsDirty = false;
      s.dirty = true;
      if (!s.failed) {
        markChanged(file.path);
        if (!s.saving && !s.requested) armAutosave();
      }
    };
    const relay = (m: RpcMessage) => {
      if (!b) return;
      // The file was replaced under this editor (a restore): it is being reopened; answer, send nothing.
      if (replacedRef.current) { post({ yc: 'rpc-result', id: m.id, error: 'This file was restored from a kept version, so Office is reloading it.' }); return; }
      if (keptRef.current && keptRelay(m)) return;
      const args = m.args && typeof m.args === 'object' ? m.args as Record<string, unknown> : {};
      // The editor says when the document changes; the host decides when to save (3 s later).
      if (m.cmd === 'set_document_modified' && args.modified === true) {
        const s = save.current;
        s.dirty = true;
        // Typing again: any Save As is over, and "not modified" is the editor's own again.
        s.saveAsUntil = 0;
        // Any change withdraws a close's pending approval of the unload — also while failed,
        // where markChanged below is skipped (fix round 6, M1). Accepted (fix round 7): the
        // editor's own late "modified" echo after a failed save can arrive just after Close
        // anyway and withdraw it too. Nothing is lost that way — the window stays open with the
        // edits, and the next X asks again about the Office documents (only them: the sessions
        // answer was already carried out with that Close anyway).
        withdrawUnloadApproval();
        // WHY not a new change after a failed save (measured in the dev window, fix round 1):
        // the editor answers its own failed save by marking the document modified again. Taking
        // that as typing retried a read-only file every 3 s and flipped the strip between the
        // error and "Saving…". Its "modified" flag only ever reports a change once, so while
        // failed, only Retry, a flush or the save-failed actions try again.
        if (!s.failed) {
          markChanged(file.path);
          if (!s.saving && !s.requested) armAutosave();
        }
      }
      // WHY: the editor says "modified" and at once "not modified" while it lays a document out
      // (measured 2026-09-28 on a workbook: true then false in the same millisecond), and
      // "not modified" again when an undo returns to the saved state. Nothing is unsaved then,
      // so the pending save is dropped rather than rewriting a file that was only opened.
      // A save already running, or one that failed, keeps its own state.
      if (m.cmd === 'set_document_modified' && args.modified === false) {
        const s = save.current;
        // Not while a requested save is on its way: the editor's own save reports "not
        // modified" BEFORE its save_file (measured), and that save must still be waited for.
        if (s.dirty && !s.saving && !s.failed && !s.requested && Date.now() >= s.saveAsUntil) {
          s.droppedAt = Date.now();
          s.dirty = false;
          if (s.timer) { clearTimeout(s.timer); s.timer = 0; }
          markUnchanged(file.path);
        }
      }
      // A Save As begins (its dialog): were there unsaved changes? Either still pending, or just
      // dropped by the "not modified" the editor sends as it starts (see droppedAt).
      if (m.cmd === 'save_dialog') {
        const s = save.current;
        s.saveAsDirty = s.dirty || Date.now() - s.droppedAt < SAVE_AS_START_MS;
        s.saveAsUntil = Date.now() + SAVE_AS_MAX_MS;
      }
      // The bytes of an asked-for save: how long the editor froze to gather them (autosaveDelay).
      if (m.cmd === 'write_editor_bin' && save.current.requested && save.current.askedAt) {
        save.current.handOverMs = Date.now() - save.current.askedAt;
        save.current.askedAt = 0;
      }
      const saving = isSaveCmd(m.cmd);
      // The request this hand-over answers (see requestSeq): the one current when it arrived.
      const seq = save.current.requestSeq;
      if (saving) {
        const s = save.current;
        s.saving = true;
        s.saveAsUntil = 0; // a real save of the document: no Save As is holding "not modified" now
        // A save is running now; a pending timer would only start a second one behind it.
        s.requested = false;
        s.askedAt = 0; // a later Save As's bytes are no measure of an autosave's freeze
        if (s.requestTimer) { clearTimeout(s.requestTimer); s.requestTimer = 0; }
        if (s.timer) { clearTimeout(s.timer); s.timer = 0; }
        markSaving(file.path);
      }
      b.invoke(opened.token, m.cmd, m.args ?? {}).then((result) => {
        // WHY not main's answer for save_file_as: it names the copy's folder for the note below,
        // and the sealed frame is never told folders; bridge.js only needs it to succeed.
        // Print (finish plan Task 3) likewise: its answer can name the folder a PDF went to.
        post({ yc: 'rpc-result', id: m.id, result: m.cmd === 'save_file_as' || m.cmd === 'print_document' ? 'ok' : result });
        // The Save As is over when its copy is written, or when its dialog was cancelled.
        if (m.cmd === 'save_file_as' || (m.cmd === 'save_dialog' && result === null)) saveAsEnded();
        if (m.cmd === 'save_file_as' && mountedRef.current) {
          const r = result as { name?: unknown; folder?: unknown } | null;
          if (r && typeof r.name === 'string' && typeof r.folder === 'string') markNote(file.path, `Saved a copy as ${r.name} in ${r.folder}.`);
        }
        // Printing couldn't be shown and the person saved a PDF instead (main's offer): same note.
        if (m.cmd === 'print_document' && mountedRef.current) {
          const saved = (result as { saved?: { name?: unknown; folder?: unknown } } | null)?.saved;
          if (saved && typeof saved.name === 'string' && typeof saved.folder === 'string') markNote(file.path, `Saved a copy as ${saved.name} in ${saved.folder}.`);
        }
        // M4 (fix round 4): an answer that lands after this frame unmounted must not write a
        // save state for a file no editor holds any more (it would linger in the store).
        if (!mountedRef.current) return;
        // M2 (fix round 1): an answer for a document this editor has let go of (a restore
        // replaced it, or it reopened on a new token) says nothing about what it holds now.
        if (replacedRef.current || keptRef.current || openedRef.current?.token !== opened.token) return;
        if (m.cmd === 'write_editor_bin') save.current.handedOverSeq = seq;
        if (saving) {
          save.current.drainPending = false;
          // WHY clear `failed` (fix round 3): the 5 s cap or the 60 s guard may already have
          // called this save failed; it landed after all. Anything still dirty is then an
          // ordinary follow-up save (saveSettled re-arms autosave), never a stuck tab.
          save.current.failed = false;
          // A change during the save keeps the strip at "Saving…" for the follow-up save.
          if (save.current.dirty) markChanged(file.path); else markSaved(file.path);
          saveSettled();
        }
      }, (e: unknown) => {
        const message = plainMessage(e, saving || m.cmd === 'save_file_as' ? "Office couldn't save this file." : m.cmd === 'print_document' ? "Office couldn't print this document." : "Office couldn't finish that.");
        post({ yc: 'rpc-result', id: m.id, error: message });
        // Save As (finish plan Task 2): bridge.js answers a failure with a message box the relay
        // does not show, so main's reason (worded for a person) goes on YouCoded's own strip.
        // A bare 'refused' (a handle main did not grant) is no sentence for a person.
        if (isSaveAsCmd(m.cmd)) saveAsEnded();
        if (isSaveAsCmd(m.cmd) && mountedRef.current) markNote(file.path, message === 'refused' ? "Office couldn't save this file." : message);
        // WHY (finish plan Task 3): bridge.js's Print only logs a failure, so main's reason (worded
        // for a person) goes on the strip — or nothing would say why no print dialog came.
        if (m.cmd === 'print_document' && mountedRef.current) markNote(file.path, message === 'refused' ? "Office couldn't print this document." : message);
        if (!mountedRef.current) {
          // See M4 above. But a save the close let go of (drainPending) that then failed in
          // main's drain is said, with the toast a hidden close uses (fix round 5): the tab is
          // gone, and without it the edits would vanish without a word.
          if (saving && save.current.drainPending) noteCloseFailedWhileHidden(file.path);
          return;
        }
        // M2 (fix round 1): see above — no stale "couldn't save" for a document already let go,
        // and none over the kept-after-restore message (main's "restored" refusal of a save sent
        // just before this editor was told) (fix round 2).
        if (replacedRef.current || keptRef.current || openedRef.current?.token !== opened.token) return;
        // Any refused step of an asked-for save (write_editor_bin, get_current_path) ends that
        // save without a save_file: it failed, with main's reason (fix round 2).
        if (!saving && (m.cmd === 'write_editor_bin' || m.cmd === 'get_current_path')) {
          failRequested(m.cmd === 'write_editor_bin' ? message : "Office couldn't save this file.");
        }
        if (saving) {
          // Main's message is already written for a person (office-commands.ts), so the strip
          // shows it as is, with Retry (docs/error-message-standards.md: specific + Retry).
          // WHY no automatic retry: a read-only file or a full disk would fail every 3 s and
          // flicker the strip; the changes stay unsaved (a closing tab still tries once more).
          markFailed(file.path, message);
          save.current.dirty = true;
          save.current.failed = true;
          save.current.failMessage = message;
          saveSettled();
        }
      });
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== opened.origin || e.source !== ref.current?.contentWindow) return;
      const d = e.data as { yc?: string; type?: string; state?: OfficeCommandState } | null;
      if (d?.yc === 'ready') {
        post({ type: OFFICE_THEME_MESSAGE, theme: editorTheme(opened.origin) });
        post({ type: OFFICE_MODE_MESSAGE, slim });
        // WHY the name, never the path (final review, finding 3): bridge.js uses the payload
        // only for the document's name and extension (the tab title, the Save As filters,
        // recovery's format) — open_file ignores it and main always opens the session's own
        // file. The folder would tell the sealed frame where the file lives; get_current_path
        // answers with the name for the same reason.
        post({ yc: 'event', name: 'open-file', payload: file.name });
      }
      if (d?.yc === 'rpc' && typeof (d as RpcMessage).cmd === 'string') relay(d as RpcMessage);
      // The bridge says when the document is really drawn — "opened" only means accepted.
      if (d?.type === 'yc:office-loaded') setPhase('open');
      if (d?.type === 'yc:office-state' && d.state) stateCb.current?.(d.state);
      if (d?.type === 'yc:office-esc') dismissRef.current();
    };
    window.addEventListener('message', onMessage);
    const stopTheme = watchOfficeTheme(() => post({ type: OFFICE_THEME_MESSAGE, theme: editorTheme(opened.origin) }));
    return () => { window.removeEventListener('message', onMessage); stopTheme(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- post/save read refs; slim is fixed per frame
  }, [file.path, opened]);

  return (
    <div className="absolute inset-0 overflow-hidden" hidden={hidden}>
      {phase === 'open' && !hidden && screen && <ScreenMark name={screen} />}
      <iframe
        ref={ref}
        src={origin === null ? undefined : `${origin}/index.html`}
        title={file.name}
        // The editor needs scripts, workers and its own storage — on ITS origin,
        // never the app's (no top navigation, no access to window.claude).
        sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals"
        className={`absolute border-0 ${slim ? '' : 'inset-0 w-full h-full'} ${phase === 'open' ? '' : 'invisible'}`}
        style={slim ? SLIM_OVERSCAN : undefined}
        // Fix round 5: inert while a copy is written, so no click, key or focus reaches the
        // editor behind the overlay (the overlay alone left keyboard focus reachable by Tab).
        inert={copying}
      />
      {copying && (
        <div ref={overlayRef} tabIndex={-1} className="absolute inset-0 bg-panel/70 flex items-center justify-center outline-none" aria-busy="true">
          <LoadingState what="a copy" verb="Saving" />
        </div>
      )}
      {phase === 'starting' && <div className="absolute inset-0"><LoadingState what={stripExt(file.name)} verb="Opening" /></div>}
      {phase === 'failed' && (
        <div className="p-6 max-w-xl mx-auto">
          <ErrorState message={failure} onRetry={() => { setPhase('starting'); setOpened(null); setAttempt((n) => n + 1); }} />
        </div>
      )}
      {phase === 'unavailable' && <div className="p-6 max-w-xl mx-auto"><EmptyState message={failure} /></div>}
    </div>
  );
});
