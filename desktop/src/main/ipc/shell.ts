// shell.ts — opening things on the computer and its pickers: shell:open-changelog / open-external / show-item-in-folder /
// open-path, dialog:open-file / open-sound / open-folder, and clipboard:save-image. The computer's own windows only.
//
// WHY (2026-10-01 one-core R3-8): each was an ipcMain handler in ipc-handlers.ts. None was ever bridged to a phone (a
// phone cannot open a window, a picker or the clipboard on the computer), so the table refuses them for a phone with the
// "not available over remote access" answer the old default gave. The bodies are moved as they were.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { clipboard, dialog, shell, type BrowserWindow } from 'electron';
import { IPC } from '../../shared/backend-contract';
import { defineChannel, type MainChannelDef } from './channel-def';

/** The picker dialogs sit on the main window, which main builds. */
let getMainWindow: () => BrowserWindow | null = () => null;
export function bindShell(deps: { getMainWindow: () => BrowserWindow | null }): void { getMainWindow = deps.getMainWindow; }
// Electron's typings want a window; the old handlers passed the (possibly absent) main window straight through.
const parent = () => getMainWindow() as BrowserWindow;

// Pasted images are written here and swept by an hourly timer once a paste has happened.
const CLIPBOARD_MAX_AGE_MS = 60 * 60 * 1000;
const clipboardTmpDir = path.join(os.tmpdir(), 'claude-desktop-attachments');
let clipboardCleanupScheduled = false;

async function cleanupClipboardTemp(): Promise<void> {
  try {
    const files = await fs.promises.readdir(clipboardTmpDir);
    const now = Date.now();
    for (const file of files) {
      if (!file.startsWith('paste-')) continue;
      try {
        const stat = await fs.promises.stat(path.join(clipboardTmpDir, file));
        if (now - stat.mtimeMs > CLIPBOARD_MAX_AGE_MS) await fs.promises.unlink(path.join(clipboardTmpDir, file));
      } catch { /* a file that vanished is fine */ }
    }
  } catch { /* no folder yet */ }
}

export const shellChannels: MainChannelDef[] = [
  // File picker dialog (attachment paperclip).
  defineChannel({
    name: IPC.DIALOG_OPEN_FILE, kind: 'handle', desktopOnly: true,
    handler: async () => {
      // NO `filters` on purpose — do NOT re-add a filter list here. Destin's ask is "default to all files, on all
      // platforms", and Electron's dialog API cannot deliver an All-Files DEFAULT alongside a category dropdown:
      //   - Linux: a live D-Bus capture of org.freedesktop.portal.FileChooser.OpenFile (KDE Plasma, 2026-08-12) showed
      //     Electron strips the wildcard filter (file_dialog_linux.cc GetFilterInfo() keeps only include_all_files,
      //     hardcodes file_type_index=0), Chromium re-appends "*.*" LAST and emits no current_filter key — so the portal
      //     selects the first listed filter (Images), and app-side ordering can never win. electron#43491, closed
      //     not-planned. A lone All-Files filter is no fix either: '*' serializes as the glob '*.*', which excludes
      //     extensionless files like Makefile.
      //   - Windows: same rule by design — the dialog "picks the first filter as default, except the All Files one".
      //     electron#19492, closed not-planned.
      //   - macOS: filters are a selection allowlist, not a dropdown default, so a list adds nothing once All Files is present.
      // If a category dropdown is ever wanted, that means an upstream Electron patch or an in-app picker — not a filters
      // array. Pinned by tests/ipc-handlers.test.ts → "dialog:open-file attachment picker filters".
      const result = await dialog.showOpenDialog(parent(), { properties: ['openFile', 'multiSelections'] });
      return result.canceled ? [] : result.filePaths;
    },
  }),

  // Sound file picker dialog — for custom notification sounds.
  defineChannel({
    name: IPC.DIALOG_OPEN_SOUND, kind: 'handle', desktopOnly: true,
    handler: async () => {
      const result = await dialog.showOpenDialog(parent(), {
        properties: ['openFile'],
        filters: [
          // AIFF/AIF/AIFC covers Apple system sounds in /System/Library/Sounds/. Chromium can't decode AIFF natively;
          // sounds.ts has a JS AIFF parser for it.
          { name: 'Audio Files', extensions: ['mp3', 'wav', 'ogg', 'opus', 'aac', 'm4a', 'flac', 'webm', 'aiff', 'aif', 'aifc'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
  }),

  // Folder picker dialog.
  defineChannel({
    name: IPC.DIALOG_OPEN_FOLDER, kind: 'handle', desktopOnly: true,
    handler: async () => {
      const result = await dialog.showOpenDialog(parent(), { properties: ['openDirectory'] });
      return result.canceled ? null : result.filePaths[0];
    },
  }),

  // Save the clipboard image to a temp file (async I/O, cleanup on a timer).
  defineChannel({
    name: IPC.CLIPBOARD_SAVE_IMAGE, kind: 'handle', desktopOnly: true,
    handler: async () => {
      const img = clipboard.readImage();
      if (img.isEmpty()) return null;
      await fs.promises.mkdir(clipboardTmpDir, { recursive: true });
      if (!clipboardCleanupScheduled) {
        clipboardCleanupScheduled = true;
        setInterval(cleanupClipboardTemp, 3600_000);
      }
      const filePath = path.join(clipboardTmpDir, `paste-${Date.now()}.png`);
      await fs.promises.writeFile(filePath, img.toPNG());
      return filePath;
    },
  }),

  // Open the YouCoded CHANGELOG on GitHub in the default browser.
  defineChannel({
    name: IPC.OPEN_CHANGELOG, kind: 'handle', desktopOnly: true,
    handler: async () => { await shell.openExternal('https://github.com/itsdestin/youcoded/blob/master/CHANGELOG.md'); },
  }),

  // Open any URL in the default browser (allowlisted to http/https — the scheme is the boundary; any HOST is fine, because
  // the model legitimately hands the user localhost/LAN dev-server links via SendUserLink and the user clicks them
  // explicitly. Never file:, javascript:, etc.
  defineChannel({
    name: IPC.OPEN_EXTERNAL, kind: 'handle', desktopOnly: true,
    handler: async ({ url }) => { if (typeof url === 'string' && /^https?:\/\//i.test(url)) await shell.openExternal(url); },
  }),

  // Reveal a local file in the OS file manager (the artifact panel's "Reveal in folder"). No-op for empty / non-string paths.
  defineChannel({
    name: IPC.SHOW_ITEM_IN_FOLDER, kind: 'handle', desktopOnly: true,
    handler: async ({ filePath }) => { if (typeof filePath === 'string' && filePath.length > 0) shell.showItemInFolder(filePath); },
  }),

  // Open a local file with the OS default app (HTML to browser, .docx to Word, ...). shell.openPath resolves with ''
  // on success or an error string on failure.
  defineChannel({
    name: IPC.OPEN_PATH, kind: 'handle', desktopOnly: true,
    handler: async ({ filePath }) => (typeof filePath !== 'string' || filePath.length === 0 ? 'no path' : shell.openPath(filePath)),
  }),
];
