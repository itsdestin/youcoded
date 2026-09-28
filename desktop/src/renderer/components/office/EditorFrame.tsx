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
import { OFFICE_MODE_MESSAGE, OFFICE_THEME_MESSAGE, readOfficeTheme, watchOfficeTheme } from './office-theme';
import { markChanged, markFailed, markSaved, markSaving, markUnchanged, registerFlush } from './office-store';
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
/** WHY 5 s (design §4): the longest a closing tab waits for its last save before it lets go.
 *  Main still drains a save it already has (office-sessions close), so this only bounds how
 *  long the hidden editor lingers. */
const CLOSE_SAVE_WAIT_MS = 5_000;
/** WHY 60 s (fix round 2): the longest an asked-for save may go without its save_file before it
 *  counts as failed. The editor's own save ends in save_file within milliseconds (measured);
 *  anything this late means the editor gave up without telling the host (a failed
 *  get_current_path, an exception in its save path), and "Saving…" must not stay up forever. */
const REQUESTED_SAVE_LIMIT_MS = 60_000;


/** The theme as the editor gets it. WHY no fontLinks (build plan Task 6): the editor's CSP
 *  (font-src 'self' data:) blocks the Google stylesheets they point at; Task 9 serves the
 *  theme's font from the editor's own origin instead. */
const editorTheme = () => ({ ...readOfficeTheme(), fontLinks: [] });

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
  // Taken down before its window goes (office-store, fix round 3): no frame, so no editor page
  // can veto the window's unload. It comes back (and reloads the document) if the window stays.
  // I2 (fix round 4): while Save a copy runs, an overlay takes the pointer and the keyboard, so
  // nothing typed mid-copy can be left out of it.
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
    // The editor's last hand-over of its bytes (write_editor_bin) failed (I3, fix round 4).
    writeFailed: false,
    timer: 0 as ReturnType<typeof setTimeout> | 0,
    requestTimer: 0 as ReturnType<typeof setTimeout> | 0,
    waiters: [] as Array<() => void>,
  });
  // A save that failed without save_file failing (fix round 2): the editor's write_editor_bin
  // was refused, the editor's save path gave up, or no save_file ever came. Same outcome as a
  // failed save_file — the strip shows the reason with the save-failed actions.
  const failRequested = (message: string) => {
    const s = save.current;
    if (s.requestTimer) { clearTimeout(s.requestTimer); s.requestTimer = 0; }
    if (!s.requested || s.saving) return;
    s.requested = false;
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
    if (s.requestTimer) clearTimeout(s.requestTimer);
    s.requestTimer = setTimeout(() => { s.requestTimer = 0; failRequested("Office didn't finish saving this file."); }, REQUESTED_SAVE_LIMIT_MS);
    post({ type: 'yc:office-save' });
  };
  const armAutosave = () => {
    const s = save.current;
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => { s.timer = 0; requestSave(); }, AUTOSAVE_DELAY_MS);
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
  const flush = (capMs: number = CLOSE_SAVE_WAIT_MS): Promise<FlushResult> => {
    const s = save.current;
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
        if (s.saving && !s.dirty) { finish({ ok: true }); return; }
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
  /** Ask the editor to save now (its bytes reach main even when the save itself fails again). */
  const saveOnce = (): Promise<FlushResult> => {
    const s = save.current;
    if (!s.saving && !s.requested) s.dirty = true;
    return flush();
  };
  const discardPending = () => {
    const s = save.current;
    if (s.timer) { clearTimeout(s.timer); s.timer = 0; }
    if (s.requestTimer) { clearTimeout(s.requestTimer); s.requestTimer = 0; }
    s.dirty = false; s.failed = false; s.requested = false;
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
  useEffect(() => registerFlush(file.path, (capMs) => flushRef.current(capMs)), [file.path]);

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
    save: () => { const s = save.current; if (!s.saving && !s.requested) requestSave(); },
    canSaveCopy: async () => {
      const b = officeBridge();
      const t = openedRef.current?.token;
      if (!b?.saveCopy || !t) return false;
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
      try {
        // Always a fresh hand-over (not just "save if dirty"): the copy is made from these bytes.
        await saveOnce();
        // I3 (fix round 4): the copy is made from the bytes that save handed over; if handing
        // them over failed, the copy would miss edits — refuse rather than switch.
        // Said on the strip itself (the save-failed actions stay): the strip re-renders between
        // "Saving…" and the failure while this runs, which would drop a message kept only here.
        const refuse = (message: string) => { save.current.failMessage = message; markFailed(file.path, message); return { ok: false as const, message }; };
        if (save.current.writeFailed) return refuse("Office couldn't save a copy of this file.");
        const failCopy = (e: unknown) => ({ ok: false as const, message: plainMessage(e, "Office couldn't save a copy of this file.") });
        let r: OfficeSaveCopyResult = await b.saveCopy(t, 'save').catch(failCopy);
        // Main refused the copy (e.g. the target is open in Office): say so on the strip.
        if (!r.ok && 'message' in r) return refuse(r.message);
        // WHY one final check, not rounds of catch-up (fix round 4): the overlay below blocks
        // typing while the copy is written, so the editor's bytes can only differ if something
        // slipped in before the overlay took the keyboard. One more hand-over and 'again' (main
        // compares the bytes) covers that; if it still differs, nothing is switched or discarded.
        if (r.ok && 'folder' in r) {
          await saveOnce();
          const again: OfficeSaveCopyResult = save.current.writeFailed
            ? { ok: false, message: "Office couldn't save a copy of this file." }
            : await b.saveCopy(t, 'again').catch(failCopy);
          // 'again' rewrote the copy if the bytes differed, so on success the copy is current.
          if (!again.ok) return refuse('message' in again ? again.message : "Office couldn't save a copy of this file.");
        }
        if (r.ok && 'folder' in r) {
          // "Save As" (the owner's decision, fix round 2): the changes now live in the copy, and
        // the tab carries on editing the COPY — the original has nothing left to save, and later
        // typing must land in the copy, not in a file that cannot be saved.
          discardPending();
          switchToCb.current?.(r.path, r.folder);
        }
        return r;
      } finally {
        setCopying(false);
      }
    },
    discard: () => { discardPending(); markUnchanged(file.path); },
  }), [file.path]);

  useEffect(() => {
    if (!opened) return;
    const b = officeBridge();
    const relay = (m: RpcMessage) => {
      if (!b) return;
      const args = m.args && typeof m.args === 'object' ? m.args as Record<string, unknown> : {};
      // The editor says when the document changes; the host decides when to save (3 s later).
      if (m.cmd === 'set_document_modified' && args.modified === true) {
        const s = save.current;
        s.dirty = true;
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
        if (s.dirty && !s.saving && !s.failed && !s.requested) {
          s.dirty = false;
          if (s.timer) { clearTimeout(s.timer); s.timer = 0; }
          markUnchanged(file.path);
        }
      }
      const saving = isSaveCmd(m.cmd);
      if (saving) {
        const s = save.current;
        s.saving = true;
        // A save is running now; a pending timer would only start a second one behind it.
        s.requested = false;
        if (s.requestTimer) { clearTimeout(s.requestTimer); s.requestTimer = 0; }
        if (s.timer) { clearTimeout(s.timer); s.timer = 0; }
        markSaving(file.path);
      }
      b.invoke(opened.token, m.cmd, m.args ?? {}).then((result) => {
        post({ yc: 'rpc-result', id: m.id, result });
        // M4 (fix round 4): an answer that lands after this frame unmounted must not write a
        // save state for a file no editor holds any more (it would linger in the store).
        if (!mountedRef.current) return;
        if (m.cmd === 'write_editor_bin') save.current.writeFailed = false;
        if (saving) {
          // WHY clear `failed` (fix round 3): the 5 s cap or the 60 s guard may already have
          // called this save failed; it landed after all. Anything still dirty is then an
          // ordinary follow-up save (saveSettled re-arms autosave), never a stuck tab.
          save.current.failed = false;
          // A change during the save keeps the strip at "Saving…" for the follow-up save.
          if (save.current.dirty) markChanged(file.path); else markSaved(file.path);
          saveSettled();
        }
      }, (e: unknown) => {
        const message = plainMessage(e, saving ? "Office couldn't save this file." : "Office couldn't finish that.");
        post({ yc: 'rpc-result', id: m.id, error: message });
        if (!mountedRef.current) return; // see M4 above
        // Any refused step of an asked-for save (write_editor_bin, get_current_path) ends that
        // save without a save_file: it failed, with main's reason (fix round 2).
        if (m.cmd === 'write_editor_bin') save.current.writeFailed = true;
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
        post({ type: OFFICE_THEME_MESSAGE, theme: editorTheme() });
        post({ type: OFFICE_MODE_MESSAGE, slim });
        post({ yc: 'event', name: 'open-file', payload: file.path });
      }
      if (d?.yc === 'rpc' && typeof (d as RpcMessage).cmd === 'string') relay(d as RpcMessage);
      // The bridge says when the document is really drawn — "opened" only means accepted.
      if (d?.type === 'yc:office-loaded') setPhase('open');
      if (d?.type === 'yc:office-state' && d.state) stateCb.current?.(d.state);
      if (d?.type === 'yc:office-esc') dismissRef.current();
    };
    window.addEventListener('message', onMessage);
    const stopTheme = watchOfficeTheme(() => post({ type: OFFICE_THEME_MESSAGE, theme: editorTheme() }));
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
