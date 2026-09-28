// The system dialog behind "Save a copy…" (Task 6 fix round 1). Kept out of office-ipc.ts so
// that file stays free of electron and its tests keep driving handlers with fakes.
import { BrowserWindow, app, dialog, type WebContents } from 'electron';
import path from 'node:path';

/** Ask where the copy goes. Parented to the asking window; the default is Documents/<name> (copy).<ext>,
 *  filtered to the same kind of file. null when cancelled. */
export async function pickCopyTarget(sender: unknown, filePath: string): Promise<string | null> {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const name = path.basename(filePath, path.extname(filePath));
  const win = BrowserWindow.fromWebContents(sender as WebContents);
  const opts = {
    defaultPath: path.join(app.getPath('documents'), `${name} (copy).${ext}`),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  };
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (r.canceled || !r.filePath) return null;
  // WHY force the extension: the copy is translated into this kind of file, so a name typed
  // without it (or with another) would hold content its extension misdescribes.
  return path.extname(r.filePath).toLowerCase() === `.${ext}` ? r.filePath : `${r.filePath}.${ext}`;
}
