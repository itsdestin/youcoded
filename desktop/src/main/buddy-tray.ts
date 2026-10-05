/**
 * The buddy's "taskbar icon" style — an alternative to the floating mascot
 * window. The buddy lives as an icon in the OS's own bar: the notification
 * area on Windows, the menu bar on macOS, the system tray (StatusNotifierItem)
 * on Linux. Left-click opens/closes the same buddy chat the floating mascot
 * opens; the icon gains a red dot while something needs you.
 *
 * Kept out of BuddyWindowManager so the manager stays testable without
 * Electron's Tray: the manager only ever sees the BuddyTrayHandle below.
 */
import path from 'path';
import { Menu, Tray, nativeImage, type NativeImage } from 'electron';
import type { Rect } from '../shared/buddy-geometry';

export interface BuddyTrayHandlers {
  onToggleChat(): void;
  onSwitchToFloating(): void;
  onHide(): void;
}

export interface BuddyTrayHandle {
  setAttention(needed: boolean): void;
  /** Where the icon is on screen, or null where the OS won't say (Linux). */
  bounds(): Rect | null;
  destroy(): void;
}

// The active theme's tray pictures (file paths), or null for the app's own. Set by the theme icon
// swap (theme-icon-swap.ts, via the window:set-icon entry in ipc/window.ts) and read by every tray, including one created later — the
// buddy can switch to its taskbar style long after the theme was applied.
let themeTray: { idle: string; alert?: string } | null = null;
const liveTrays = new Set<() => void>();

/** WHY not on macOS: the Mac menu-bar icon is one colour (brand round 31, "J1") so macOS can turn
 *  it black or white with the menu bar; it never follows the theme. */
export function setBuddyTrayTheme(paths: { idle: string; alert?: string } | null): void {
  themeTray = paths;
  for (const refresh of liveTrays) refresh();
}

export function createBuddyTray(assetsDir: string, handlers: BuddyTrayHandlers): BuddyTrayHandle {
  const isMac = process.platform === 'darwin';
  // WHY "-macTemplate": Electron treats a file whose name ends in "Template" as a template image —
  // one colour, which macOS draws black or white to match the menu bar. 18px (+@2x twin, which
  // nativeImage picks up automatically) because menu-bar icons are ~18pt.
  const bundled = (name: string): NativeImage =>
    nativeImage.createFromPath(path.join(assetsDir, `${name}${isMac ? '-macTemplate' : ''}.png`));
  // A theme picture that fails to load falls back to the app's own, never to an empty tray.
  const themed = (file: string | undefined, fallback: NativeImage): NativeImage => {
    if (!file) return fallback;
    const img = nativeImage.createFromPath(file);
    return img.isEmpty() ? fallback : img;
  };
  const baseIdle = bundled('tray'), baseAlert = bundled('tray-alert');
  let idle = baseIdle, alert = baseAlert;
  const pickThemed = () => {
    if (isMac) return;
    idle = themed(themeTray?.idle, baseIdle);
    // A theme with no alert picture keeps the default red-dot icon rather than losing the dot.
    alert = themed(themeTray?.alert, baseAlert);
  };
  pickThemed();

  const tray = new Tray(idle);
  tray.setToolTip('YouCoded buddy');
  tray.on('click', () => handlers.onToggleChat());

  const menu = Menu.buildFromTemplate([
    { label: 'Open chat', click: () => handlers.onToggleChat() },
    { label: 'Switch to floating buddy', click: () => handlers.onSwitchToFloating() },
    { type: 'separator' },
    { label: 'Hide buddy', click: () => handlers.onHide() },
  ]);
  // WHY two menu paths: on macOS a tray with setContextMenu opens the menu on
  // LEFT-click too, which would swallow "click opens chat". Windows and macOS
  // emit 'right-click', so the menu pops up there by hand. Linux emits no
  // 'right-click' at all — its tray hosts show the attached menu on right-click
  // and send left-click as 'click', so attaching it is the only way.
  if (process.platform === 'linux') tray.setContextMenu(menu);
  else tray.on('right-click', () => tray.popUpContextMenu(menu));

  let attention = false;
  const refresh = () => {
    if (tray.isDestroyed()) return;
    pickThemed();
    tray.setImage(attention ? alert : idle);
  };
  liveTrays.add(refresh);
  return {
    setAttention(needed) {
      if (needed === attention || tray.isDestroyed()) return;
      attention = needed;
      tray.setImage(needed ? alert : idle);
    },
    bounds() {
      if (tray.isDestroyed()) return null;
      // Linux returns an all-zero rect — treat that as "unknown".
      const b = tray.getBounds();
      return b.width > 0 && b.height > 0 ? b : null;
    },
    destroy() {
      liveTrays.delete(refresh);
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}
