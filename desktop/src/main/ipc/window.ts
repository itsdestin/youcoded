// window.ts — the computer's own window controls (window:minimize / maximize / close / set-traffic-light-pos / set-icon /
// get-id / get-directory / answer-close) and zoom (zoom:in / out / reset / get).
//
// WHY (2026-10-01 one-core R3-8): these were ipcMain handlers in ipc-handlers.ts and main.ts. The window controls belong
// to the computer's own windows only, so the table refuses them for a phone from the entry (`desktopOnly`), with the same
// "not available over remote access" answer the old default gave; `window` is also absent from a phone's shim by design.
//
// Zoom is the exception, kept exactly as it was: a remote browser paired to this computer drives the computer's own zoom
// (the shim sends zoom:in/out/reset/get over the socket when it has a target; with none it uses a CSS fallback of its
// own, which is the shim's half and unchanged). Each door keeps the window it always acted on: the computer's door zooms
// the main window handed over at startup, a phone's door zooms "the first open window" (the main window in every normal
// case, and a surviving window if the main one has been closed, as happens after its last session is torn off). Every call
// answers the new percentage, or 100 when there is no such window.
import { BrowserWindow } from 'electron';
import { IPC } from '../../shared/backend-contract';
import { applyThemeIcons } from '../theme-icon-swap';
import { defineChannel, type MainChannelDef } from './channel-def';

/** What main hands over: the main window, the window list, and the close-request queue (the "welcome back" prompt). */
interface WindowDeps {
  getMainWindow(): BrowserWindow | null;
  getDirectory(): unknown;
  answerClose(answer: { requestId: string; close: boolean; reopen?: boolean }): void;
}
// WHY merged, not replaced: ipc-handlers.ts hands over the main window and the window list; main.ts hands over the
// close-request queue it owns. Each binds its own part.
const deps: Partial<WindowDeps> = {};
export function bindWindow(next: Partial<WindowDeps>): void { Object.assign(deps, next); }
const mainWindow = (): BrowserWindow | null => deps.getMainWindow?.() ?? null;
/** The window that SENT a call (not the primary one), so window 2's caption buttons act on window 2. */
const senderWindow = (sender: unknown): BrowserWindow | null => BrowserWindow.fromWebContents(sender as Electron.WebContents);

// Zoom: each call returns the new zoom percentage for the overlay UI (Electron's zoom is a logarithmic scale).
const ZOOM_STEP = 0.5; // ~12% per step
const ZOOM_MIN = -3;   // ~50%
const ZOOM_MAX = 5;    // ~300%
const zoomLevelToPercent = (level: number): number => Math.round(Math.pow(1.2, level) * 100);
function zoomBy(delta: number | 'reset' | 'get', door: 'desktop' | 'remote'): number {
  const win = door === 'remote' ? BrowserWindow.getAllWindows()[0] : mainWindow();
  if (!win || win.isDestroyed()) return 100;
  const wc = win.webContents;
  if (delta === 'get') return zoomLevelToPercent(wc.getZoomLevel());
  if (delta === 'reset') { wc.setZoomLevel(0); return 100; }
  const next = delta > 0 ? Math.min(wc.getZoomLevel() + delta, ZOOM_MAX) : Math.max(wc.getZoomLevel() + delta, ZOOM_MIN);
  wc.setZoomLevel(next);
  return zoomLevelToPercent(next);
}

export const windowChannels: MainChannelDef[] = [
  // Window controls — used by the custom caption buttons on Windows/Linux.
  defineChannel({
    name: IPC.WINDOW_MINIMIZE, kind: 'handle', desktopOnly: true,
    handler: (_p, ctx) => { const win = senderWindow(ctx.sender); if (win && !win.isDestroyed()) win.minimize(); },
  }),
  defineChannel({
    name: IPC.WINDOW_MAXIMIZE, kind: 'handle', desktopOnly: true,
    handler: (_p, ctx) => { const win = senderWindow(ctx.sender); if (win && !win.isDestroyed()) { win.isMaximized() ? win.unmaximize() : win.maximize(); } },
  }),
  defineChannel({
    name: IPC.WINDOW_CLOSE, kind: 'handle', desktopOnly: true,
    handler: (_p, ctx) => { const win = senderWindow(ctx.sender); if (win && !win.isDestroyed()) win.close(); },
  }),
  // macOS traffic-light repositioning; a no-op elsewhere. Called when chrome-style changes — floating chrome's rounded
  // header would otherwise leave the OS-default lights stranded over empty space.
  defineChannel({
    name: IPC.WINDOW_SET_TRAFFIC_LIGHT_POS, kind: 'handle', desktopOnly: true,
    handler: ({ pos }, ctx) => {
      if (process.platform !== 'darwin') return;
      const win = senderWindow(ctx.sender);
      if (!win || win.isDestroyed()) return;
      // Electron 28+: setWindowButtonPosition(null) resets to the platform default.
      (win as unknown as { setWindowButtonPosition: (p: Electron.Point | null) => void }).setWindowButtonPosition(pos ?? null);
    },
  }),
  // WHY a one-line hand-off (brand rounds 27–31): the theme's icon now goes to the window, the
  // Windows taskbar shortcuts, the Mac Dock (by the user's icon look) and the tray — theme-icon-swap.ts.
  defineChannel({
    name: IPC.WINDOW_SET_ICON, kind: 'handle', desktopOnly: true,
    handler: ({ icons }) => applyThemeIcons(mainWindow(), icons),
  }),

  // "Which window am I?" — used by SessionStrip to avoid treating its own directory entry as a remote session.
  defineChannel({ name: IPC.WINDOW_GET_ID, kind: 'handle', desktopOnly: true, handler: (_p, ctx) => ctx.sender?.id ?? -1 }),
  // Pull-style directory snapshot — renderers call this on mount to avoid racing the WINDOW_DIRECTORY_UPDATED push that
  // fires before React subscribes.
  defineChannel({
    name: IPC.WINDOW_GET_DIRECTORY, kind: 'handle', desktopOnly: true,
    handler: () => { if (!deps.getDirectory) throw new Error('window list is not ready'); return deps.getDirectory(); },
  }),
  // Welcome back (design §4, plan T3): the renderer's answer to a window:close-request push. One handler for every
  // window — the close-request queue routes the answer to the right pending entry by requestId.
  defineChannel({
    name: IPC.WINDOW_ANSWER_CLOSE, kind: 'handle', desktopOnly: true,
    handler: (answer) => {
      if (!answer || typeof answer.requestId !== 'string') return;
      deps.answerClose?.({ requestId: answer.requestId, close: !!answer.close, reopen: answer.reopen });
    },
  }),

  // Zoom — also answered for a paired phone (see the header).
  defineChannel({ name: IPC.ZOOM_IN, kind: 'handle', handler: (_p, ctx) => zoomBy(ZOOM_STEP, ctx.door) }),
  defineChannel({ name: IPC.ZOOM_OUT, kind: 'handle', handler: (_p, ctx) => zoomBy(-ZOOM_STEP, ctx.door) }),
  defineChannel({ name: IPC.ZOOM_RESET, kind: 'handle', handler: (_p, ctx) => zoomBy('reset', ctx.door) }),
  defineChannel({ name: IPC.ZOOM_GET, kind: 'handle', handler: (_p, ctx) => zoomBy('get', ctx.door) }),
];
