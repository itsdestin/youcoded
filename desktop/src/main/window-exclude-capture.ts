import { BrowserWindow } from 'electron';
import os from 'os';
import { log } from './logger';

/**
 * Exclude a window from OS-level screen capture. Keeps the window fully
 * visible to the user but hides it from EVERY screen-capture consumer:
 *
 * - Our own desktopCapturer (used by the buddy's capture-icon action)
 * - Windows+Shift+S, Snipping Tool
 * - Zoom / Teams / Meet screen share
 * - OBS, NVIDIA ShadowPlay, and other recorders
 *
 * Used on the three buddy windows (mascot, chat, capture-icon) so the
 * buddy's own screenshot action captures the desktop underneath without
 * a flicker of "hide to exclude + restore". A pleasant side-effect is
 * that during a screen share the buddy doesn't appear to viewers — the
 * floater is a personal tool, not something to publish to coworkers.
 *
 * Platform coverage:
 * - Windows: WDA_EXCLUDEFROMCAPTURE via user32.SetWindowDisplayAffinity
 *   (Win10 build 19041 / v2004, May 2020+). Older Win10 silently ignores
 *   the flag.
 * - macOS: NSWindowSharingNone via Electron's built-in
 *   setContentProtection (which also implements WDA_MONITOR on Windows —
 *   the wrong thing there, hence the manual native binding).
 * - Linux: no portable API; no-op (caller should fall back to opacity
 *   dimming around the capture).
 *
 * Returns true iff native exclusion was applied. Call sites that need a
 * fallback behaviour (opacity dim around capture) should key off
 * `nativeCaptureExclusionAvailable()` at startup.
 */

// Min Win10 build that supports WDA_EXCLUDEFROMCAPTURE. os.release() on
// win32 returns e.g. "10.0.22631" on Win11 and "10.0.19045" on Win10 22H2,
// so parseInt(parts[2]) is the build number.
const WIN10_MIN_BUILD_FOR_EXCLUDE = 19041;
const WDA_EXCLUDEFROMCAPTURE = 0x11;

let setWindowDisplayAffinity: ((hwnd: Buffer, flag: number) => number) | null = null;
let win32Probed = false;
let win32Available = false;

function probeWin32(): boolean {
  if (win32Probed) return win32Available;
  win32Probed = true;
  if (process.platform !== 'win32') return false;

  const build = parseInt((os.release().split('.')[2] || '0'), 10);
  if (!Number.isFinite(build) || build < WIN10_MIN_BUILD_FOR_EXCLUDE) {
    log('INFO', 'Capture', `WDA_EXCLUDEFROMCAPTURE unsupported on Win build ${build} (<${WIN10_MIN_BUILD_FOR_EXCLUDE})`);
    return false;
  }

  try {
    // `koffi` ships its own prebuilt native ABI-matched addons and is
    // Electron-compatible without a rebuild step. Lazy require so non-Win
    // builds don't load it at all.
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    // stdcall signature — user32 APIs are __stdcall on Windows.
    setWindowDisplayAffinity = user32.func(
      'int __stdcall SetWindowDisplayAffinity(void *hwnd, int dwAffinity)',
    );
    win32Available = true;
    return true;
  } catch (err) {
    log('WARN', 'Capture', 'koffi load failed; falling back to opacity dim', { error: String(err) });
    setWindowDisplayAffinity = null;
    return false;
  }
}

/**
 * True iff this platform supports keeping a window visible while
 * excluding it from screen capture. Call sites use this to decide
 * whether the opacity-dim fallback is needed.
 */
export function nativeCaptureExclusionAvailable(): boolean {
  if (process.platform === 'darwin') return true;
  if (process.platform === 'win32') return probeWin32();
  return false;
}

/**
 * Apply native screen-capture exclusion to `win`. Safe to call during
 * window construction. No-op (returns false) on platforms/versions
 * where exclusion isn't available.
 */
export function excludeFromCapture(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false;

  if (process.platform === 'darwin') {
    // Electron maps setContentProtection(true) to NSWindowSharingNone on
    // macOS — the correct flag. (On Windows it maps to WDA_MONITOR which
    // paints black; we deliberately do NOT use it there.)
    try {
      win.setContentProtection(true);
      return true;
    } catch (err) {
      log('WARN', 'Capture', 'setContentProtection failed on darwin', { error: String(err) });
      return false;
    }
  }

  if (process.platform === 'win32') {
    if (!probeWin32() || !setWindowDisplayAffinity) return false;
    try {
      const hwnd = win.getNativeWindowHandle();
      setWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
      return true;
    } catch (err) {
      log('WARN', 'Capture', 'SetWindowDisplayAffinity failed', { error: String(err) });
      return false;
    }
  }

  return false;
}
