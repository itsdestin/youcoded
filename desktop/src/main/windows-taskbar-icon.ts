// windows-taskbar-icon.ts — make the Windows TASKBAR button wear the theme's icon.
//
// WHY this is not just BrowserWindow.setIcon(): YouCoded runs under the same AppUserModelID as its
// Start-menu shortcut (main.ts), so Windows draws the taskbar button from that SHORTCUT's icon and
// ignores the window's own — setIcon only reaches Alt+Tab and the title bar. Tested on Windows 11
// (2026-10-04, brand round 32): setAppDetails' relaunch icon, editing the shortcut and refreshing the
// shell icon cache all left the button unchanged. What works:
//   1. point YouCoded's own shortcuts (Start menu, desktop, a taskbar pin) at the theme's icon, copied
//      to a file whose NAME is unique per icon — Windows caches shortcut icons by path, so reusing one
//      name would show the old picture;
//   2. when YouCoded is NOT pinned, briefly give the window another AppUserModelID and straight back,
//      so Windows rebuilds the button and re-reads the shortcut — the icon changes on the spot.
// A PINNED button keeps the picture Explorer saved when it was pinned; it changes at the next sign-in
// (or re-pin). We skip step 2 then: it would only flash a second button beside the pin. Destin
// accepted that trade-off (2026-10-04) over restarting Explorer, which would close the user's windows.
import { app, shell, type BrowserWindow } from 'electron';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

const AUMID = 'com.youcoded.desktop';
const ICON_DIR_NAME = 'taskbar-icons';

/** The copied icon's name: the hash of its bytes, so each different picture gets its own path
 *  (a fresh icon-cache key) while re-applying the same theme reuses the file. Exported for tests. */
export function taskbarIconName(bytes: Buffer): string {
  return `theme-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.ico`;
}

/** True when a shortcut launches this very app (so we never touch anyone else's shortcuts). */
export function isOurShortcut(target: string | undefined, exe: string): boolean {
  return !!target && path.normalize(target).toLowerCase() === path.normalize(exe).toLowerCase();
}

async function ourShortcuts(): Promise<{ file: string; pinned: boolean }[]> {
  const appData = app.getPath('appData');
  const exe = process.execPath;
  const out: { file: string; pinned: boolean }[] = [];
  const consider = (file: string, pinned: boolean) => {
    try { if (isOurShortcut(shell.readShortcutLink(file).target, exe)) out.push({ file, pinned }); } catch { /* not a shortcut, or gone */ }
  };
  consider(path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'YouCoded.lnk'), false);
  consider(path.join(app.getPath('desktop'), 'YouCoded.lnk'), false);
  const pinDir = path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar');
  try {
    for (const f of await fs.promises.readdir(pinDir)) if (f.toLowerCase().endsWith('.lnk')) consider(path.join(pinDir, f), true);
  } catch { /* no pins folder */ }
  return out;
}

let pending: Promise<void> = Promise.resolve();

/** Point YouCoded's shortcuts at `icoFile` (a theme's .ico) or, with null, back at the app's own
 *  icon; then, if YouCoded isn't pinned, rebuild the taskbar button so the change shows now.
 *  Calls are queued so quick theme flips never interleave. Never throws. */
export function applyWindowsTaskbarIcon(win: BrowserWindow, icoFile: string | null): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve();
  pending = pending.then(() => apply(win, icoFile)).catch(() => {});
  return pending;
}

async function apply(win: BrowserWindow, icoFile: string | null): Promise<void> {
  const shortcuts = await ourShortcuts();
  if (shortcuts.length === 0) return; // a dev run or a portable copy: no shortcut drives the button
  const dir = path.join(app.getPath('userData'), ICON_DIR_NAME);
  let icon = process.execPath; // the app's own icon, embedded in the .exe
  if (icoFile) {
    const bytes = await fs.promises.readFile(icoFile);
    await fs.promises.mkdir(dir, { recursive: true });
    icon = path.join(dir, taskbarIconName(bytes));
    await fs.promises.writeFile(icon, bytes, { flag: 'wx' }).catch(() => {}); // 'wx': already there → keep it
  }
  let changed = false;
  for (const { file } of shortcuts) {
    const current = shell.readShortcutLink(file);
    if (current.icon && path.normalize(current.icon).toLowerCase() === path.normalize(icon).toLowerCase()) continue;
    // 'update' keeps everything else on the shortcut, including the AppUserModelID that ties it to the app.
    if (shell.writeShortcutLink(file, 'update', { ...current, icon, iconIndex: 0 })) changed = true;
  }
  // Only the current picture is kept, so theme flips don't pile up icon files.
  try {
    for (const f of await fs.promises.readdir(dir)) {
      if (path.join(dir, f) !== icon) await fs.promises.rm(path.join(dir, f), { force: true });
    }
  } catch { /* no folder yet */ }
  if (!changed || shortcuts.some((s) => s.pinned) || win.isDestroyed()) return;
  win.setAppDetails({ appId: `${AUMID}.refresh` });
  await new Promise((r) => setTimeout(r, 400));
  if (!win.isDestroyed()) win.setAppDetails({ appId: AUMID });
}
