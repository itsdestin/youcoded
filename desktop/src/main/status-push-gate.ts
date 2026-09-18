import { app, BrowserWindow, webContents } from 'electron';

// WHY this module (2026-09-16 audit W2, W12): the 10 s status push re-read every
// status file and sent the same payload to every window and phone, minimised or
// not, and the sync health check probed DNS on the same nobody-is-looking
// schedule. Both now ask one question — can anyone see a status bar? — answered
// by hasAudience(): a main window that is visible and not minimised, or a
// connected phone. Buddy windows stay Electron-shown while CSS-hidden
// (buddy-floater rule), so only main windows count.
//
// The push adds two rules on top: (a) a payload equal to the last one sent is
// dropped unless the set of windows changed (there is no status:get, so a new
// window's only source is this push); (b) a tick skipped for lack of an
// audience is made up the moment someone looks again — a window shown,
// restored or focused, or a phone connecting — so the bar is at most one build
// stale on return instead of waiting out the rest of the 10 s.

interface WindowRegistryLike { getMainWindowIds(): number[]; getWindowIds(): number[] }
interface RemoteServerLike {
  getClientCount(): number;
  onStatusChange(listener: (status: { clientCount: number }) => void): () => void;
}

export interface StatusPushGateOptions {
  /** Builds the payload (single-flight lives with the caller). */
  build: () => Promise<unknown>;
  /** Sends a payload to every window and phone. */
  deliver: (data: any) => void;
  mainWindow: BrowserWindow;
  windowRegistry?: WindowRegistryLike;
  remoteServer?: RemoteServerLike | null;
  intervalMs?: number;
}

export interface StatusPushGate {
  /** Build now and deliver unless identical to the last delivery. */
  push(): void;
  /** Can anyone see a status bar right now? */
  hasAudience(): boolean;
  stop(): void;
}

// A window double without the visibility methods (tests) reads as visible —
// the behaviour before the gate existed.
const windowIsVisible = (win: BrowserWindow | null): boolean =>
  !!win && !win.isDestroyed() && (typeof win.isVisible !== 'function' || (win.isVisible() && !win.isMinimized()));

export function startStatusPushGate(opts: StatusPushGateOptions): StatusPushGate {
  const { mainWindow, windowRegistry, remoteServer } = opts;
  let lastSent = '';
  let lastWindows = '';
  let skipped = false;
  let stopped = false;

  const hasAudience = (): boolean => {
    if ((remoteServer?.getClientCount() ?? 0) > 0) return true;
    if (!windowRegistry) return windowIsVisible(mainWindow);
    return windowRegistry.getMainWindowIds().some((wid) => {
      const wc = webContents.fromId(wid);
      return !!wc && !wc.isDestroyed() && windowIsVisible(BrowserWindow.fromWebContents(wc));
    });
  };

  const push = (): void => {
    void opts.build().then((data) => {
      if (stopped) return;
      const serialized = JSON.stringify(data);
      const windows = windowRegistry ? windowRegistry.getWindowIds().join(',') : '';
      if (serialized === lastSent && windows === lastWindows) return;
      lastSent = serialized;
      lastWindows = windows;
      opts.deliver(data);
    });
  };

  const pushIfMissed = (): void => {
    if (stopped || !skipped) return;
    skipped = false;
    push();
  };

  const timer = setInterval(() => {
    if (hasAudience()) push(); else skipped = true;
  }, opts.intervalMs ?? 10_000);

  const watchWindow = (win: BrowserWindow) => {
    win.on('show', pushIfMissed);
    win.on('restore', pushIfMissed);
  };
  if (typeof mainWindow.on === 'function') watchWindow(mainWindow);
  const onWindowCreated = (_e: unknown, win: BrowserWindow) => watchWindow(win);
  app.on('browser-window-created', onWindowCreated);
  app.on('browser-window-focus', pushIfMissed);
  const offRemote = remoteServer?.onStatusChange((status) => { if (status.clientCount > 0) pushIfMissed(); });

  return {
    push,
    hasAudience,
    stop() {
      stopped = true;
      clearInterval(timer);
      // The Electron double in tests has no removeListener; production always does.
      if (typeof app.removeListener === 'function') {
        app.removeListener('browser-window-created', onWindowCreated);
        app.removeListener('browser-window-focus', pushIfMissed);
      }
      offRemote?.();
    },
  };
}
