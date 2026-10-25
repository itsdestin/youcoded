// The computer's own Open, Save and Choose folder windows for a page's files, parented to the
// asking window, and its bin (pages-finish step 2). Kept apart from page-files.ts so that file
// stays free of electron and its tests drive it with fakes (the office-dialogs.ts split).
import os from 'os';
import path from 'path';
import { BrowserWindow, dialog, shell, type WebContents } from 'electron';
import type { PageFilesDeps } from './page-files';

const winOf = (sender: unknown) => (sender ? BrowserWindow.fromWebContents(sender as WebContents) : null);

/** `.csv` → `csv`, as the Open window's filter wants them. */
const filtersOf = (types?: string[]) => (types?.length ? [{ name: 'Files this page uses', extensions: types.map((t) => t.slice(1)) }] : []);

export const pageFileDialogs: Pick<PageFilesDeps, 'showOpen' | 'showSave' | 'showFolder' | 'trash'> = {
  async showOpen(sender, opts) {
    const win = winOf(sender);
    const o = { properties: opts.multiple ? ['openFile' as const, 'multiSelections' as const] : ['openFile' as const], filters: filtersOf(opts.types) };
    const r = win ? await dialog.showOpenDialog(win, o) : await dialog.showOpenDialog(o);
    return r.canceled || !r.filePaths.length ? null : r.filePaths;
  },
  async showSave(sender, opts) {
    const win = winOf(sender);
    const o = {
      defaultPath: path.join(os.homedir(), 'Documents', opts.suggestedName),
      filters: filtersOf(opts.types),
      // WHY: the page's file replaces whatever has the chosen name; the person must confirm that.
      properties: ['showOverwriteConfirmation' as const, 'createDirectory' as const],
    };
    const r = win ? await dialog.showSaveDialog(win, o) : await dialog.showSaveDialog(o);
    return r.canceled || !r.filePath ? null : r.filePath;
  },
  async showFolder(sender) {
    const win = winOf(sender);
    const o = { properties: ['openDirectory' as const, 'createDirectory' as const] };
    const r = win ? await dialog.showOpenDialog(win, o) : await dialog.showOpenDialog(o);
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  },
  trash: (filePath) => shell.trashItem(filePath),
};
