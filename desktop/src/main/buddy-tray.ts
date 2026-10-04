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

export function createBuddyTray(assetsDir: string, handlers: BuddyTrayHandlers): BuddyTrayHandle {
  const isMac = process.platform === 'darwin';
  // WHY separate mac files: menu-bar icons are ~18pt, and a 32px image there
  // renders oversized. nativeImage picks up the @2x twin automatically.
  const load = (name: string): NativeImage =>
    nativeImage.createFromPath(path.join(assetsDir, `${name}${isMac ? '-mac' : ''}.png`));
  const idle = load('tray');
  const alert = load('tray-alert');

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
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}
