// theme-icon-swap.ts — the active theme's icons on the window, taskbar, Mac Dock and tray.
// The window:set-icon table entry (ipc/window.ts) hands every call here: theme-context (renderer)
// sends the theme's icon bundle (shared/theme-icons.ts) or null whenever the active theme changes.
// WHY its own file (brand rounds 27–31): the window icon is one of four places the icon goes, and
// the taskbar, Dock and tray halves are larger than the rest of the window family put together.
import { app, nativeImage, type BrowserWindow } from 'electron';
import os from 'os';
import path from 'path';
import { loadDefaultAppIcon, fitForMacDock, chooseDockIcon, hasLiquidGlass, type MacIconLook } from './app-icon';
import { readMacIconLook, watchMacIconLook } from './mac-icon-look';
import { setBuddyTrayTheme } from './buddy-tray';
import { applyWindowsTaskbarIcon } from './windows-taskbar-icon';
import type { ThemeIconSet } from '../shared/theme-icons';
import { SAFE_SLUG_RE } from './ipc/appearance';

// Each entry of the bundle is one of:
//   1. theme-asset://<slug>/<relative-path>  — a file in a community/user theme's asset dir
//      (resolved here and confined to that dir, so the renderer cannot read arbitrary files).
//   2. data:image/png;base64,<...> — an icon the renderer draws. Size-capped.
// null, or a file that fails to load, falls back to the app's own icon for that spot.
const ASSETS_DIR = path.join(__dirname, '../../assets');
const THEMES_DIR_FOR_ICON = path.join(os.homedir(), '.claude', 'wecoded-themes');
const MAX_DATA_ICON_BYTES = 1024 * 1024; // 1 MB — a 256px PNG is typically <100KB

/** The confined file path behind a theme-asset:// URL, or null. */
function themeAssetFile(url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith('theme-asset://')) return null;
  try {
    const parsed = new URL(url);
    const slug = parsed.hostname;
    if (!SAFE_SLUG_RE.test(slug)) return null;
    const themeDir = path.join(THEMES_DIR_FOR_ICON, slug);
    const resolved = path.resolve(themeDir, decodeURIComponent(parsed.pathname.replace(/^\//, '')));
    return resolved.startsWith(themeDir + path.sep) ? resolved : null;
  } catch { return null; }
}
function loadIcon(url: unknown): Electron.NativeImage | null {
  try {
    const file = themeAssetFile(url);
    const img = file ? nativeImage.createFromPath(file)
      : typeof url === 'string' && url.startsWith('data:image/png;base64,') && url.length <= MAX_DATA_ICON_BYTES ? nativeImage.createFromDataURL(url)
      : null;
    return img && !img.isEmpty() ? img : null;
  } catch { return null; }
}

// The last bundle, so the Mac Dock can be re-chosen when the user changes their icon look.
let currentIcons: ThemeIconSet | null = null;
let watching = false;
function applyMacDock(): void {
  if (process.platform !== 'darwin' || !app.dock) return;
  // WHY the Darwin check: before macOS 26 there is no Liquid Glass and no icon look, so the
  // theme's icon always shows, as it did before (app-icon.ts → chooseDockIcon).
  const look: MacIconLook = hasLiquidGlass(os.release()) ? readMacIconLook() : 'default';
  const choice = chooseDockIcon(look, !!currentIcons, !!currentIcons?.macGlass);
  const img = choice === 'glass' ? loadIcon(currentIcons?.macGlass) ?? loadIcon(currentIcons?.app)
    : choice === 'app' ? loadIcon(currentIcons?.app) : null;
  // WHY null resets: Electron hands macOS no picture, so it shows the app's own bundled icon —
  // the Liquid Glass one on macOS 26. Setting icon-mac.png instead would flatten it.
  // (Electron's typings say NativeImage | string, but its DockSetIcon treats null as "reset".)
  app.dock.setIcon(img ? fitForMacDock(img) : (null as unknown as Electron.NativeImage));
}

/** Put the theme's icons on the window, taskbar, Mac Dock and tray (null = the app's own). */
export function applyThemeIcons(mainWindow: BrowserWindow | null, icons: ThemeIconSet | null): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // WHY on the first call, not at import: the look watcher hooks app events, and the first theme
  // arrives once the window is up.
  if (!watching) { watching = true; watchMacIconLook(applyMacDock); }
  currentIcons = icons && typeof icons === 'object' && typeof icons.app === 'string' ? icons : null;
  // Window and taskbar button. WHY the .ico on Windows: it carries a sharper drawing for each small
  // size, where one big PNG shrunk to 16px blurs the eyes.
  const winIcon = (process.platform === 'win32' ? loadIcon(currentIcons?.windows) : null) ?? loadIcon(currentIcons?.app);
  mainWindow.setIcon(winIcon ?? loadDefaultAppIcon(ASSETS_DIR));
  // The taskbar BUTTON follows the shortcut, not the window (windows-taskbar-icon.ts). Only a
  // loaded .ico is handed over; anything else puts the shortcuts back on the app's own icon.
  const winIco = process.platform === 'win32' && winIcon ? themeAssetFile(currentIcons?.windows) : null;
  void applyWindowsTaskbarIcon(mainWindow, winIco);
  applyMacDock();
  // The buddy's tray icon follows the theme too (not on the Mac — buddy-tray.ts).
  const trayIdle = themeAssetFile(currentIcons?.tray);
  setBuddyTrayTheme(trayIdle ? { idle: trayIdle, alert: themeAssetFile(currentIcons?.trayAlert) ?? undefined } : null);
}
