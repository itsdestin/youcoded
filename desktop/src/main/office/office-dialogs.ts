// The system dialog behind "Save a copy…" (Task 6 fix round 1). Kept out of office-ipc.ts so
// that file stays free of electron and its tests keep driving handlers with fakes.
import { BrowserWindow, app, dialog, type WebContents } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { OfficeFile } from '../../shared/office-types';
import { pickFile } from './office-home';

/** The dialog's answer, made safe (fix round 2). The system dialog confirms overwriting the name
 *  the person typed; a name WE extend with the extension was never shown to them, so replacing
 *  an existing file of that name would be silent — refuse it and ask for another name. */
export function resolveCopyTarget(chosen: string, ext: string, exists: (p: string) => boolean): string | { refused: string } {
  if (path.extname(chosen).toLowerCase() === `.${ext}`) return chosen;
  const withExt = `${chosen}.${ext}`;
  if (exists(withExt)) return { refused: `A file named "${path.basename(withExt)}" already exists there. Choose another name.` };
  return withExt;
}

/** Ask where the copy goes. Parented to the asking window; the default is Documents/<name> (copy).<ext>,
 *  filtered to the same kind of file. null when cancelled. */
export async function pickCopyTarget(sender: unknown, filePath: string): Promise<string | null | { refused: string }> {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const name = path.basename(filePath, path.extname(filePath));
  const win = BrowserWindow.fromWebContents(sender as WebContents);
  const opts = {
    defaultPath: path.join(app.getPath('documents'), `${name} (copy).${ext}`),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    // WHY: the copy replaces whatever file has the chosen name; the person must confirm that.
    properties: ['showOverwriteConfirmation' as const, 'createDirectory' as const],
  };
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (r.canceled || !r.filePath) return null;
  // WHY force the extension: the copy is translated into this kind of file, so a name typed
  // without it (or with another) would hold content its extension misdescribes.
  return resolveCopyTarget(r.filePath, ext, existsSync);
}

/** The system file picker behind the start screen's Open, parented to the asking window and
 *  filtered to Office files (office-home.ts pickFile). null when cancelled. */
export async function pickOfficeFile(sender: unknown): Promise<OfficeFile | null> {
  return pickFile(BrowserWindow.fromWebContents(sender as WebContents));
}
