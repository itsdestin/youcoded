// detach.ts — moving a session between windows: window:open-detached, the live tear-off (session:detach-start /
// detach-live), the cross-window drag (drag-started / -window-move / -dropped / -adopt / -ended, drop-resolve),
// window:focus-and-switch and detach:claim-pending. The computer's own windows only.
//
// WHY (2026-10-01 one-core R3-8): these were `ipcMain` handlers inside main.ts's registerDetachIpc, a hand-written
// door of their own beside ipc-handlers.ts and remote-server.ts. They are table entries now (`desktopOnly`: a phone has
// no windows to tear a session out of, so the table refuses them from the entry; the shim's detach calls are no-ops there
// by design and unchanged). The bodies are moved as they were; they lean on main.ts's window plumbing (creating a window,
// the ownership registry, the pending-claim queue), which main hands over through bindDetach.
//
// All session-scoped traffic is routed via windowRegistry.getOwner(). These handlers coordinate ownership transfers
// between windows and broadcast the cross-window cursor during an active drag so peer windows can highlight their strip
// as a drop target.
import { screen, type BrowserWindow } from 'electron';
import { IPC } from '../../shared/backend-contract';
import type { SessionOwnershipAcquired } from '../../shared/types';
import { validateHandoffDraft, type DetachedHandoffDraft } from '../../shared/handoff-draft';
import type { PendingAcquireQueue } from '../pending-acquire';
import type { WindowRegistry } from '../window-registry';
import type { SessionManager } from '../session-manager';
import { defineChannel, type MainChannelDef } from './channel-def';

/** The calling window's web contents, as an ipcMain event carries it. */
type Evt = { sender: { id: number } };

export interface DetachDeps {
  windowRegistry: WindowRegistry;
  sessionManager: Pick<SessionManager, 'getSession'>;
  pendingAcquire: PendingAcquireQueue<SessionOwnershipAcquired>;
  createAppWindow(opts: { x: number; y: number; width: number; height: number; inactive?: boolean }): BrowserWindow;
  windowFromWcId(id: number): BrowserWindow | null | undefined;
}

function makeOps(deps: DetachDeps) {
  const { windowRegistry, sessionManager, pendingAcquire, createAppWindow, windowFromWcId } = deps;
  // Renderer asks "did I inherit anything while I was still booting?"
  //
  // WHY (2026-09-03): a tear-off hands the session to a window created one statement earlier, so
  // `tgt.webContents.send(SESSION_OWNERSHIP_ACQUIRED)` fired at a renderer whose React tree did not exist yet. Electron
  // does NOT queue for a late subscriber — measured on 41.10.7: a message sent right after `new BrowserWindow()` never
  // reaches a listener registered 1.5s later, it is dropped outright. So the handoff, and everything it triggers (history
  // hydration, opening on the dragged session, re-sending open permission asks) silently did nothing on EVERY tear-off
  // into a fresh window.
  //
  // Fix shape: the renderer PULLS once mounted rather than being pushed at before it can listen. `readyWindows` is what
  // makes the two paths exclusive — before a window has pulled, transfers queue; after, they push as before — so a payload
  // is delivered exactly once either way.
  const claimPending = (evt: Evt) => pendingAcquire.claim(evt.sender.id);

  // Transfer a session from its current owner window to a target window.
  // Rejects if the source claim is stale (race protection). Emits ownership
  // events to both windows so renderers can update their reducers.
  function transferOwnership(sessionId: string, srcWindowId: number, targetWindowId: number, freshWindow: boolean,
    draft?: DetachedHandoffDraft) {
    const info = sessionManager.getSession(sessionId);
    if (!info) return;
    // Stale (another event already moved it) → transferSession refuses and changes
    // nothing. Otherwise it assigns the target AND marks the gap: the target has not
    // been receiving this session's live transcript stream, so its first page of
    // history must read to EOF rather than stopping at the watcher's startOffset
    // (WindowRegistry.markInheritedByTransfer), and the remote snapshot omits the
    // session until that page is read (isPendingTransfer).
    if (!windowRegistry.transferSession(sessionId, srcWindowId, targetWindowId)) return;
    const src = windowFromWcId(srcWindowId);
    const tgt = windowFromWcId(targetWindowId);
    src?.webContents.send(IPC.SESSION_OWNERSHIP_LOST, { sessionId });
    // WHY: only this newly admitted detach carries unsent composer state;
    // never mutate the authoritative SessionInfo kept by SessionManager.
    const payload = { sessionId, sessionInfo: draft
      ? { ...info, initialInput: draft.text, initialAttachments: draft.attachments } : info, freshWindow };
    // A window that has not yet pulled (DETACH_CLAIM_PENDING) has no listener —
    // a send would be dropped on the floor. Queue for its pull instead.
    if (pendingAcquire.isReady(targetWindowId)) {
      tgt?.webContents.send(IPC.SESSION_OWNERSHIP_ACQUIRED, payload);
    } else {
      pendingAcquire.enqueue(targetWindowId, payload);
    }
  }

  // If a window was emptied by a detach/re-dock and another peer window
  // exists, close it automatically. The last surviving window may stay empty.
  function maybeAutoCloseEmpty(windowId: number) {
    if (windowRegistry.sessionsForWindow(windowId).length > 0) return;
    if (windowRegistry.getWindowIds().length <= 1) return;
    windowFromWcId(windowId)?.close();
  }

  // Approx. position of the FIRST pill inside a freshly-spawned window's
  // header, measured from the window's top-left in DIPs. Used to offset the
  // new window so the cursor ends up over the pill, not the window corner.
  // Tuned empirically on Windows (hidden titlebar, no REMOTE badge, chat/
  // terminal toggle on the left); bump if the left cluster grows or shrinks.
  const DETACHED_FIRST_PILL_X = 96;
  const DETACHED_FIRST_PILL_Y = 12;

  // Given cursor screen coords + where inside the pill the user grabbed,
  // compute where the new window's top-left should sit so the cursor hovers
  // over the same spot on that session's pill inside the new window.
  const computeDetachedWindowPos = (screenX: number, screenY: number, offsetX: number, offsetY: number) => ({
    x: Math.round(screenX - DETACHED_FIRST_PILL_X - offsetX),
    y: Math.round(screenY - DETACHED_FIRST_PILL_Y - offsetY),
  });

  // Tracks live tear-off state so we can defer source-window auto-close until
  // the user releases (closing mid-drag would kill the pointer-capture path
  // and leave the new window stuck in mouse-passthrough mode).
  let liveDragWindowId: number | null = null;
  let liveDragSourceId: number | null = null;
  let liveDragOffset: { x: number; y: number } = { x: 40, y: 12 };
  // Updated by the post-spawn measurement (see SESSION_DETACH_LIVE) so the
  // streaming setPosition uses the *real* first-pill position in the new
  // window, not the static DETACHED_FIRST_PILL_X/Y guess.
  let measuredFirstPillX: number = DETACHED_FIRST_PILL_X;
  let measuredFirstPillY: number = DETACHED_FIRST_PILL_Y;

  // Active-drag cursor broadcasting: while a source window is dragging a pill,
  // every other window needs to know where the cursor is (OS only delivers
  // pointer events to the active window). Ticker runs ~30Hz; stops on any
  // drop resolution.
  let cursorTicker: NodeJS.Timeout | null = null;
  function stopCursorTicker() {
    if (cursorTicker) { clearInterval(cursorTicker); cursorTicker = null; }
  }

  // "Launch in new window" entry point and the direct-spawn fallback for drops
  // outside any window. Spawns a peer window at/near the cursor and hands it
  // ownership of the session.
  const openDetached = (evt: Evt, { sessionId, draft }: { sessionId: string; draft?: unknown }): void => {
    // A malformed optional draft must never be silently discarded by a move.
    const safeDraft = draft === undefined ? undefined : validateHandoffDraft(draft);
    if (draft !== undefined && !safeDraft) return;
    const { x, y } = screen.getCursorScreenPoint();
    const newWin = createAppWindow({ x: x - 60, y: y - 40, width: 900, height: 700 });
    transferOwnership(sessionId, evt.sender.id, newWin.webContents.id, /*freshWindow*/ true, safeDraft ?? undefined);
    maybeAutoCloseEmpty(evt.sender.id);
  };

  // Cursor left the source window while dragging — spawn a peer at the cursor
  // and hand off the session.
  const detachStart = (evt: Evt, payload: { sessionId: string; screenX: number; screenY: number }): void => {
    const newWin = createAppWindow({ x: payload.screenX - 60, y: payload.screenY - 40, width: 900, height: 700 });
    transferOwnership(payload.sessionId, evt.sender.id, newWin.webContents.id, /*freshWindow*/ true);
    maybeAutoCloseEmpty(evt.sender.id);
    stopCursorTicker();
  };

  const detachLive = (evt: Evt, payload: { sessionId: string; offsetX?: number; offsetY?: number }): { windowId: number } => {
    // Read cursor position from main (DIPs, DPI-correct) instead of trusting
    // renderer-reported screenX/screenY — those can be in physical pixels on
    // scaled Windows displays and put the new window at the wrong screen pos.
    const cursor = screen.getCursorScreenPoint();
    liveDragOffset = { x: payload.offsetX ?? 40, y: payload.offsetY ?? 12 };
    const pos = computeDetachedWindowPos(cursor.x, cursor.y, liveDragOffset.x, liveDragOffset.y);
    // inactive: show without stealing focus so the source window keeps
    // receiving pointer events (the drag isn't finished yet).
    const newWin = createAppWindow({ x: pos.x, y: pos.y, width: 900, height: 700, inactive: true });
    // Make the new window pass pointer events through to whatever sits under
    // the cursor. Combined with setPosition() following the cursor, the source
    // window keeps getting pointermove until the user releases — at which
    // point SESSION_DRAG_ENDED clears this and refocuses.
    try { newWin.setIgnoreMouseEvents(true, { forward: true }); } catch { /* older electron */ }
    liveDragWindowId = newWin.webContents.id;
    liveDragSourceId = evt.sender.id;
    transferOwnership(payload.sessionId, evt.sender.id, newWin.webContents.id, /*freshWindow*/ true);
    // Defer maybeAutoCloseEmpty(source) to SESSION_DRAG_ENDED — if we close
    // the source mid-drag, its renderer dies and never fires pointerup, so
    // dragEnded never reaches main and the new window stays click-through.

    // Once the new window has its React tree up, measure the actual first pill
    // position and re-anchor the window so the cursor sits exactly over the
    // grabbed spot on that pill. The DETACHED_FIRST_PILL_X/Y constants used at
    // initial spawn are only an approximation; this corrects any drift from
    // varying header layouts (REMOTE badge present/absent, mac vs win toggle).
    newWin.webContents.once('did-finish-load', () => {
      // Small delay so React mounts and the pill paints before we measure.
      setTimeout(async () => {
        if (newWin.isDestroyed() || liveDragWindowId !== newWin.webContents.id) return;
        try {
          const pillRect = await newWin.webContents.executeJavaScript(
            `(() => { const el = document.querySelector('[data-session-idx]'); if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`,
          );
          if (!pillRect) return;
          const cursor = screen.getCursorScreenPoint();
          const correctedX = Math.round(cursor.x - pillRect.left - liveDragOffset.x);
          const correctedY = Math.round(cursor.y - pillRect.top - liveDragOffset.y);
          // Update the constants too so the streaming setPosition during the
          // remaining drag uses the measured values, not the initial guess.
          measuredFirstPillX = pillRect.left;
          measuredFirstPillY = pillRect.top;
          newWin.setPosition(correctedX, correctedY);
        } catch { /* measurement is best-effort; constants fall back */ }
      }, 80);
    });

    return { windowId: newWin.webContents.id };
  };

  // Follow-the-cursor. Renderer just signals a frame happened; main reads the
  // authoritative cursor position from the OS and uses the *measured* first-
  // pill position (set after the new window mounts) so the cursor stays over
  // the pill the user grabbed, not over an estimated header offset.
  const dragWindowMove = (): void => {
    if (liveDragWindowId === null) return;
    const win = windowFromWcId(liveDragWindowId);
    if (!win || win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    win.setPosition(
      Math.round(cursor.x - measuredFirstPillX - liveDragOffset.x),
      Math.round(cursor.y - measuredFirstPillY - liveDragOffset.y),
    );
  };

  // Drop landed on another window's SessionStrip — move ownership there.
  const dragDropped = (evt: Evt, payload: { sessionId: string; targetWindowId: number; insertIndex: number }): void => {
    transferOwnership(payload.sessionId, evt.sender.id, payload.targetWindowId, /*freshWindow*/ false);
    maybeAutoCloseEmpty(evt.sender.id);
    stopCursorTicker();
  };

  // ── 'html-drag' tear-off (Linux/Wayland) ──────────────────────────────────
  //
  // Everything above this point resolves a cross-window drag from SCREEN
  // coordinates, and on Wayland every one of those is zero — the cursor's
  // position, each window's position, and setPosition, which is a no-op that
  // still reports success. So peer windows never highlighted, the torn-off
  // window never followed the cursor, and the drop always resolved to "you
  // dropped it on nothing". A pill in a torn-off window could never be dragged
  // back (Destin, 2026-09-03: "permanently stuck with two windows").
  //
  // There, the pill is a browser-native draggable and the compositor carries
  // the whole gesture; the window it lands on is TOLD, in its own window-local
  // coordinates, and claims the session with the message below. Main's only
  // job is ownership. (A previous attempt started the drag from here with
  // webContents.startDrag — abandoned because on Linux that API crops the
  // picture to ~138px and can carry nothing but a file: session-drag-model.ts.)
  //
  // The window that RECEIVED an 'html-drag' drop claims the session. Unlike
  // SESSION_DRAG_DROPPED (sent by the source), this arrives from the TARGET, so
  // the source is resolved from the registry and never taken from the payload —
  // a forged message can only move a session to the window that sent it, and
  // only if some window really owns it.
  const dragAdopt = (evt: Evt, payload: { sessionId: string }): void => {
    const from = windowRegistry.getOwner(payload.sessionId);
    if (from == null || from === evt.sender.id) return;
    transferOwnership(payload.sessionId, from, evt.sender.id, /*freshWindow*/ false);
    maybeAutoCloseEmpty(from);
  };

  // Switcher selected a remote session — focus that window and tell it to
  // switch its active session.
  const focusAndSwitch = ({ windowId, sessionId }: { windowId: number; sessionId: string }): void => {
    const info = sessionManager.getSession(sessionId);
    const win = windowFromWcId(windowId);
    if (!win || !info) return;
    win.focus();
    // refocusOnly tells the target its state already has this session — just switch active.
    win.webContents.send(IPC.SESSION_OWNERSHIP_ACQUIRED, { sessionId, sessionInfo: info, freshWindow: false, refocusOnly: true });
  };

  const dragStarted = (): void => {
    stopCursorTicker();
    cursorTicker = setInterval(() => {
      const { x, y } = screen.getCursorScreenPoint();
      for (const wid of windowRegistry.getWindowIds()) {
        windowFromWcId(wid)?.webContents.send(IPC.CROSS_WINDOW_CURSOR, { screenX: x, screenY: y });
      }
    }, 33);
  };

  const dragEnded = (): void => {
    stopCursorTicker();
    // Finalize any live-detached window: re-enable pointer events and focus
    // it so the user can interact with the session they just tore off.
    if (liveDragWindowId !== null) {
      const win = windowFromWcId(liveDragWindowId);
      if (win && !win.isDestroyed()) {
        try { win.setIgnoreMouseEvents(false); } catch { /* ignore */ }
        win.focus();
      }
      liveDragWindowId = null;
    }
    // Now safe to close the source window if it became empty during the drag.
    // Deferred from SESSION_DETACH_LIVE so the source's renderer survives long
    // enough to fire pointerup and reach this handler.
    if (liveDragSourceId !== null) {
      maybeAutoCloseEmpty(liveDragSourceId);
      liveDragSourceId = null;
    }
    measuredFirstPillX = DETACHED_FIRST_PILL_X;
    measuredFirstPillY = DETACHED_FIRST_PILL_Y;
  };

  // Resolve a drop: ask each window whether its SessionStrip bounding box
  // currently contains the cursor. The source window uses the answer on
  // pointerup to pick between re-dock (other window) vs detach (no hit).
  const dropResolve = async (): Promise<{ targetWindowId: number | null }> => {
    const { x, y } = screen.getCursorScreenPoint();
    for (const wid of windowRegistry.getWindowIds()) {
      const win = windowFromWcId(wid);
      if (!win || win.isDestroyed()) continue;
      try {
        const hit = await win.webContents.executeJavaScript(
          `(() => {
            const el = document.querySelector('[data-session-strip]');
            if (!el) return false;
            const r = el.getBoundingClientRect();
            const lx = ${x} - window.screenX;
            const ly = ${y} - window.screenY;
            return (lx >= r.left && lx <= r.right && ly >= r.top && ly <= r.bottom);
          })()`,
        );
        if (hit) return { targetWindowId: wid };
      } catch { /* window not ready — skip */ }
    }
    return { targetWindowId: null };
  };

  return { claimPending, openDetached, detachStart, detachLive, dragWindowMove, dragDropped, dragAdopt, focusAndSwitch, dragStarted, dragEnded, dropResolve };
}

let ops: ReturnType<typeof makeOps> | null = null;
export function bindDetach(deps: DetachDeps): void { ops = makeOps(deps); }
const need = () => { if (!ops) throw new Error('window detach is not ready'); return ops; };
const evtOf = (ctx: { sender?: { id: number } }): Evt => ({ sender: ctx.sender ?? { id: -1 } });

export const detachChannels: MainChannelDef[] = [
  defineChannel({ name: IPC.DETACH_CLAIM_PENDING, kind: 'handle', desktopOnly: true, handler: (_p, ctx) => need().claimPending(evtOf(ctx)) }),
  defineChannel({ name: IPC.WINDOW_OPEN_DETACHED, kind: 'on', desktopOnly: true, handler: (p, ctx) => need().openDetached(evtOf(ctx), p) }),
  defineChannel({ name: IPC.SESSION_DETACH_START, kind: 'on', desktopOnly: true, handler: (p, ctx) => need().detachStart(evtOf(ctx), p) }),
  defineChannel({ name: IPC.SESSION_DETACH_LIVE, kind: 'handle', desktopOnly: true, handler: (p, ctx) => need().detachLive(evtOf(ctx), p) }),
  defineChannel({ name: IPC.SESSION_DRAG_WINDOW_MOVE, kind: 'on', desktopOnly: true, handler: () => need().dragWindowMove() }),
  defineChannel({ name: IPC.SESSION_DRAG_DROPPED, kind: 'on', desktopOnly: true, handler: (p, ctx) => need().dragDropped(evtOf(ctx), p) }),
  defineChannel({ name: IPC.SESSION_DRAG_ADOPT, kind: 'on', desktopOnly: true, handler: (p, ctx) => need().dragAdopt(evtOf(ctx), p) }),
  defineChannel({ name: IPC.WINDOW_FOCUS_AND_SWITCH, kind: 'on', desktopOnly: true, handler: (p) => need().focusAndSwitch(p) }),
  defineChannel({ name: IPC.SESSION_DRAG_STARTED, kind: 'on', desktopOnly: true, handler: () => need().dragStarted() }),
  defineChannel({ name: IPC.SESSION_DRAG_ENDED, kind: 'on', desktopOnly: true, handler: () => need().dragEnded() }),
  defineChannel({ name: IPC.SESSION_DROP_RESOLVE, kind: 'handle', desktopOnly: true, handler: () => need().dropResolve() }),
];
