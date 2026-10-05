// buddy.ts — the buddy floater's channels (buddy:show / hide / toggle-chat / set-session / subscribe / unsubscribe /
// get-viewed-session / move-mascot / drag-ended / dismiss / get-status / open-main / capture-desktop) and the Linux/KDE
// helper's three (buddy:helper-status / install-helper / remove-helper). The computer's own windows only.
//
// WHY (2026-10-01 one-core R3-8): these were `ipcMain` handlers split between main.ts (the floater, which needs the
// window manager main builds) and ipc-handlers.ts (the helper). They are table entries now. `desktopOnly`: the buddy has
// no Android or remote presence at all, so the table refuses every one for a phone from the entry with the same "not
// available over remote access" answer the old default gave; the phone's SHIM throws "Buddy is desktop-only in this
// version" before a call ever leaves the page, which is the shim's half and unchanged. The bodies are moved as they were;
// main hands over the window manager and the registry, ipc-handlers.ts the helper's cached status.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { screen, type BrowserWindow } from 'electron';
import { IPC } from '../../shared/backend-contract';
import { log } from '../logger';
import { nativeCaptureExclusionAvailable } from '../window-exclude-capture';
import { defineChannel, type MainChannelDef } from './channel-def';

/** The floater's window manager (BuddyWindowManager) as these channels use it. */
interface BuddyManagerLike {
  show(style?: 'floating' | 'tray'): void; hide(): void; toggleChat(): void; dismiss(): void; dragEnded(): void; setMascotHit(over: boolean): void;
  setViewedSession(sessionId: string): void;
  getViewedSession(): string | null;
  moveMascotFromPointer(localDx: number, localDy: number): void;
  getStatus(): { dismissed: boolean; visible: boolean };
  captureWindows(): BrowserWindow[];
  chatWebContents(): { send(channel: string, ...args: unknown[]): void } | null | undefined;
}
interface BuddyDeps {
  buddyManager: BuddyManagerLike;
  /** Which windows are subscribed to a session's events (the buddy chat window follows a session without owning it). */
  windowRegistry: { subscribe(sessionId: string, windowId: number): void; unsubscribe(sessionId: string, windowId: number): void };
  getMainWindow(): BrowserWindow | null;
  /** The Linux/KDE helper: what the settings popup and the consent gate read and change. */
  helper: {
    refresh(): Promise<{ needed: boolean; supported: boolean; installed: boolean; reason?: string }>;
    showRefusal(status: { needed: boolean; supported: boolean; installed: boolean; reason?: string } | null): string | null;
    install(): Promise<{ ok: boolean; error?: string }>;
    remove(): Promise<{ ok: boolean; error?: string }>;
  };
}
// WHY merged: main.ts builds the window manager inside createWindow and hands over the floater half; ipc-handlers.ts hands
// over the helper half at registration. Each binds its own part, and a call before both are in answers "not ready".
const deps: Partial<BuddyDeps> = {};
export function bindBuddy(next: Partial<BuddyDeps>): void { Object.assign(deps, next); }
const manager = (): BuddyManagerLike => { if (!deps.buddyManager) throw new Error('buddy is not ready'); return deps.buddyManager; };
const helper = (): NonNullable<BuddyDeps['helper']> => { if (!deps.helper) throw new Error('buddy helper is not ready'); return deps.helper; };

// Desktop-capture action: screenshot the display the mascot sits on,
// excluding the buddy windows themselves.
//
// Two exclusion strategies, picked at runtime:
//
// 1. NATIVE EXCLUSION (preferred). excludeFromCapture() applied to
//    each buddy window at creation time (Windows 10 build 19041+ via
//    WDA_EXCLUDEFROMCAPTURE; macOS via NSWindowSharingNone). Buddy
//    stays fully visible to the user but invisible to every screen-
//    capture API, including our own desktopCapturer. Zero flicker.
//
// 2. OPACITY-DIM FALLBACK. On older Win10, Linux, or if the koffi
//    binding failed to load, we dip the buddy windows to opacity 0
//    for ~60 ms, capture, and restore. One-frame flicker but still a
//    clean desktop shot. We chose opacity over hide/show because on
//    frameless+transparent+alwaysOnTop windows the hide path can
//    strand them invisible until the app restarts.
//
// Why NOT setContentProtection(true) on Windows: it maps to
// WDA_MONITOR which paints the window solid black during capture —
// three black rectangles in the screenshot.
async function captureDesktop(): Promise<string | null> {
  const { desktopCapturer } = require('electron') as typeof import('electron');
  // captureWindows() filters to alive, non-destroyed windows, mascot first
  // when present — the same set and ordering the older three getters
  // (getMascotWindow/getChatWindow/getBarWindow) produced.
  const liveBuddyWindows = manager().captureWindows();
  const mascotWin = liveBuddyWindows[0] ?? null;
  // Pick the display the mascot lives on — multi-monitor users expect
  // "screenshot my desktop" to mean the one their buddy is sitting on,
  // not every monitor merged into one long strip.
  // WHY (targetDisplay): picks mascot's display when present, or primary
  // display as fallback. Theoretical "mascot gone but chat/bar alive" state
  // would pick the surviving window's display instead — but hide() clears all
  // three windows together, so behavior is unchanged in practice.
  const targetDisplay = mascotWin
    ? screen.getDisplayMatching(mascotWin.getBounds())
    : screen.getPrimaryDisplay();

  // If the platform supports native capture exclusion (set at window
  // creation in createAppWindow), the buddies are already invisible to
  // desktopCapturer and we skip the opacity dip entirely.
  const needsOpacityFallback = !nativeCaptureExclusionAvailable();
  const buddyWindows = needsOpacityFallback ? liveBuddyWindows : [];

  try {
    if (needsOpacityFallback) {
      // One compositor frame (~16 ms) suffices; 60 ms cushions slower
      // machines. The buddy is visually invisible during this window —
      // reads as a single-frame flicker, NOT a vanishing event.
      for (const w of buddyWindows) w.setOpacity(0);
      await new Promise<void>((r) => setTimeout(r, 60));
    }

    // Request thumbnails at physical pixel resolution so the saved
    // PNG is full-res, not a 150×150 thumbnail. display.size is in
    // DIPs — multiply by scaleFactor for HiDPI screens.
    const sf = targetDisplay.scaleFactor || 1;
    const thumbnailSize = {
      width: Math.round(targetDisplay.size.width * sf),
      height: Math.round(targetDisplay.size.height * sf),
    };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
    // Match by display_id. On Electron, display_id is a stringified
    // number equal to Electron's display.id — but on some Linux setups
    // it comes back empty, so we fall back to the first screen source
    // if an exact match isn't found.
    const targetId = String(targetDisplay.id);
    const src = sources.find((s) => s.display_id === targetId) ?? sources[0];
    if (!src) return null;
    const pngBuffer = src.thumbnail.toPNG();

    // Write to a timestamped temp file. InputBar renders the preview
    // with <img src={`file://${path}`}> and sends the path as input to
    // the PTY, so a stable on-disk path is exactly what it wants.
    const tmpName = `youcoded-buddy-capture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    const tmpPath = path.join(os.tmpdir(), tmpName);
    await fs.promises.writeFile(tmpPath, pngBuffer);

    // Push to the chat renderer specifically — it's the only window
    // whose InputBar should auto-attach this capture. We resolve via
    // buddyManager instead of broadcasting because other windows
    // (main, detached peers) shouldn't auto-attach a screenshot the
    // user took from the floater's capture button.
    manager().chatWebContents()?.send(IPC.BUDDY_ATTACH_FILE, tmpPath);
    return tmpPath;
  } catch (err) {
    log('ERROR', 'Buddy', 'capture-desktop failed', { error: String(err) });
    return null;
  } finally {
    // Always restore opacity — even on error — so a failed capture
    // (e.g. macOS screen-recording permission denial) can't leave the
    // buddy invisible. No-op when we didn't dip in the first place.
    for (const w of buddyWindows) {
      if (!w.isDestroyed()) w.setOpacity(1);
    }
  }
}

export const buddyChannels: MainChannelDef[] = [
  // ─── CONSENT IS ENFORCED HERE, not in the settings screen (design §5) ────
  //
  // The product promise is "decline the helper and you get no buddy at all", and a check in the settings screen cannot
  // keep it: the settings screen is not the only thing that turns the buddy on — the app also brings him back at launch
  // from a saved preference, with no helper check anywhere on that path. Without this, a user who declined (or who never
  // got asked, because the status lookup failed) gets a buddy who appears and then refuses to be dragged.
  //
  // It refuses on "a helper is needed here", NEVER on "this is Linux". A KDE user on X11 — or on Wayland whose windows are
  // actually X11-backed, which looks identical from every environment variable — moves his own windows perfectly well and
  // must never lose a buddy that already works. The status is re-read on every show rather than trusted from launch,
  // because the user can switch the script off in KDE's own System Settings while YouCoded is running (design §4).
  defineChannel({
    name: IPC.BUDDY_SHOW, kind: 'handle', desktopOnly: true,
    handler: async (request) => {
      const refusal = helper().showRefusal(await helper().refresh());
      if (refusal) return { ok: false, reason: refusal };
      // WHY (2026-10-02 taskbar-icon buddy): the style is renderer input, so only the two known styles get through;
      // anything else keeps the current style.
      const style = request?.style;
      manager().show(style === 'tray' || style === 'floating' ? style : undefined);
      return { ok: true };
    },
  }),
  defineChannel({ name: IPC.BUDDY_HIDE, kind: 'handle', desktopOnly: true, handler: () => manager().hide() }),
  defineChannel({ name: IPC.BUDDY_TOGGLE_CHAT, kind: 'handle', desktopOnly: true, handler: () => manager().toggleChat() }),
  defineChannel({ name: IPC.BUDDY_SET_SESSION, kind: 'handle', desktopOnly: true, handler: ({ sessionId }) => { manager().setViewedSession(sessionId); } }),
  defineChannel({
    name: IPC.BUDDY_SUBSCRIBE, kind: 'handle', desktopOnly: true,
    // No replay kick is needed here — the renderer calls window.claude.detach.requestTranscriptReplay(sessionId) right
    // after subscribe resolves, which sends transcript:replay-from-start; history streams back via the normal
    // TRANSCRIPT_EVENT channel, which reaches owner plus subscribers (including this new subscription).
    handler: ({ sessionId }, ctx) => { deps.windowRegistry?.subscribe(sessionId, ctx.sender?.id ?? -1); },
  }),
  defineChannel({ name: IPC.BUDDY_UNSUBSCRIBE, kind: 'handle', desktopOnly: true, handler: ({ sessionId }, ctx) => { deps.windowRegistry?.unsubscribe(sessionId, ctx.sender?.id ?? -1); } }),
  defineChannel({ name: IPC.BUDDY_GET_VIEWED_SESSION, kind: 'handle', desktopOnly: true, handler: () => manager().getViewedSession() }),
  // Fire-and-forget drag handler. High-frequency (one event per pointermove); `on` rather than `handle` avoids the async
  // round-trip. CSS -webkit-app-region: drag was removed from BuddyMascot because on Windows Electron implements it via
  // WM_NCHITTEST -> HTCAPTION, which makes the OS consume all pointer events for window dragging — the renderer never gets
  // pointerup, so click-to-toggle-chat never fires. The payload is WINDOW-LOCAL on purpose — how far the cursor has
  // strayed from the pixel it grabbed him by, inside the mascot's own window. A renderer's screen coordinates are a lie
  // on Wayland (probe Round 8: window.screenX stayed 0 through three real moves). See BuddyWindowManager.moveMascotFromPointer.
  defineChannel({ name: IPC.BUDDY_MOVE_MASCOT, kind: 'on', desktopOnly: true, handler: (target) => manager().moveMascotFromPointer(target.localDx, target.localDy) }),
  // Drag release: edge-snap detection against the window's final bounds.
  defineChannel({ name: IPC.BUDDY_DRAG_ENDED, kind: 'on', desktopOnly: true, handler: () => manager().dragEnded() }),
  // Is the pointer over the mascot's drawn body? Main toggles click-through on it (2026-10-02).
  defineChannel({ name: IPC.BUDDY_MASCOT_HIT, kind: 'on', desktopOnly: true, handler: ({ over }) => manager().setMascotHit(over === true) }),
  defineChannel({ name: IPC.BUDDY_DISMISS, kind: 'handle', desktopOnly: true, handler: () => manager().dismiss() }),
  // WHY no `keepAbove` on the status any more (2026-09-16): it rode along for the deleted overlay's KDE "pin above"
  // toggle, whose Settings row went 2026-09-04; the three-window buddy is pinned by the KWin helper, not a saved preference.
  defineChannel({ name: IPC.BUDDY_GET_STATUS, kind: 'handle', desktopOnly: true, handler: () => manager().getStatus() }),
  // Restore + focus the main window, then ask it to switch to the buddy's viewed session so the user lands in the same
  // conversation (spec §4.2).
  defineChannel({
    name: IPC.BUDDY_OPEN_MAIN, kind: 'handle', desktopOnly: true,
    handler: (request) => {
      const main = deps.getMainWindow?.();
      const win = main && !main.isDestroyed() ? main : null;
      if (!win) {
        if (request?.resume) throw new Error('Main window unavailable for handoff.');
        return;
      }
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      // WHY: a buddy explicit handoff must enter main's pending read/draft flow; focusing its old writer would bypass
      // freshness. Main re-reads the row.
      if (typeof request?.resume === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(request.resume)) {
        win.webContents.send(IPC.UI_ACTION_RECEIVED, { type: '_BUDDY_RESUME', sessionId: request.resume });
        return;
      }
      const sid = manager().getViewedSession();
      if (sid) win.webContents.send(IPC.SESSION_FOCUS_REQUEST, sid);
    },
  }),
  defineChannel({ name: IPC.BUDDY_CAPTURE_DESKTOP, kind: 'handle', desktopOnly: true, handler: () => captureDesktop() }),

  // ─── The Linux/KDE buddy helper (design §4) ───
  // Always a LIVE read, never the cache: the user can turn the script off in KDE's own System Settings at any moment, and
  // the settings popup asks for this every time it opens (design §4 — "re-checked on window-show").
  defineChannel({ name: IPC.BUDDY_HELPER_STATUS, kind: 'handle', desktopOnly: true, handler: () => helper().refresh() }),
  defineChannel({
    name: IPC.BUDDY_INSTALL_HELPER, kind: 'handle', desktopOnly: true,
    handler: async () => {
      const res = await helper().install();
      // Re-read after a change, not before: the buddy's drag path reads this cached value on every frame, and until it
      // says "installed" the buddy is still gated off. Doing it here means the user's very next click works.
      if (res.ok) await helper().refresh();
      return res;
    },
  }),
  defineChannel({
    name: IPC.BUDDY_REMOVE_HELPER, kind: 'handle', desktopOnly: true,
    handler: async () => {
      const res = await helper().remove();
      // Same reason in reverse: once the script is out of KDE, the buddy can no longer be moved, so the cache has to know
      // before the next show().
      if (res.ok) await helper().refresh();
      return res;
    },
  }),
];
