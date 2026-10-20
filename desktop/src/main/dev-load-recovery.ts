import type { BrowserWindow } from 'electron';
import { MOUNT_PROBE_JS } from './dev-mount-probe';

// WHY separate: development's unlimited Vite/network retry policy must never
// become production crash recovery. Keep the existing dev behavior unchanged.
export function wireDevLoadRecovery(win: BrowserWindow, devUrl: string): void {
  let attempts = 0;
  const retry = (why: string) => {
    if (win.isDestroyed()) return;
    attempts += 1;
    // A network flap can exhaust a fixed retry budget before loopback recovers.
    const delaySeconds = Math.min(attempts, 5);
    console.warn(`[dev-recovery] renderer load failed (${why}) — retry ${attempts} in ${delaySeconds}s`);
    setTimeout(() => {
      if (!win.isDestroyed()) void win.loadURL(devUrl).catch(() => {});
    }, delaySeconds * 1000);
  };
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    // ERR_ABORTED also fires for intentional Vite reloads; retrying would loop.
    if (isMainFrame && errorCode !== -3) retry(`did-fail-load ${errorCode} ${errorDescription}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit') retry(`render-process-gone: ${details.reason}`);
  });
  win.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      if (win.isDestroyed()) return;
      win.webContents.executeJavaScript(MOUNT_PROBE_JS)
        .then((mounted) => {
          if (mounted) attempts = 0;
          else retry('blank renderer — React never mounted');
        })
        .catch(() => { /* page closed or its JS context was replaced */ });
    }, 8000);
  });
}
