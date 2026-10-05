// The system dialog behind "Save a copy…" (Task 6 fix round 1). Kept out of office-ipc.ts so
// that file stays free of electron and its tests keep driving handlers with fakes.
import { BrowserWindow, app, dialog, type WebContents } from 'electron';
import { existsSync, promises as fsp } from 'node:fs';
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

type FileFilter = { name: string; extensions: string[] };

/** The editor's filters, made safe (finish plan Task 1). They come from the editor frame, so only
 *  well-formed entries reach the system dialog: a short name, plain extensions or '*'. */
export function cleanFilters(raw: unknown): FileFilter[] {
  if (!Array.isArray(raw)) return [];
  const out: FileFilter[] = [];
  for (const f of raw.slice(0, 10)) {
    if (!f || typeof f !== 'object') continue;
    const { name, extensions } = f as { name?: unknown; extensions?: unknown };
    if (typeof name !== 'string' || !name || name.length > 60 || !Array.isArray(extensions)) continue;
    const exts = extensions.filter((e): e is string => typeof e === 'string' && /^(\*|[a-z0-9]{1,10})$/i.test(e)).slice(0, 30);
    if (exts.length) out.push({ name, extensions: exts });
  }
  return out;
}

/** The system file picker the editor asks for (Insert → Picture → From file), parented to the
 *  asking window. The chosen paths, or null when cancelled. WHY main shows it: a path the editor
 *  may copy from must be one the person chose in a dialog main itself showed (office-pictures.ts
 *  grants exactly these, for this one document). */
export async function pickEditorFiles(sender: unknown, opts: { multiple: boolean; filters: unknown }): Promise<string[] | null> {
  const win = BrowserWindow.fromWebContents(sender as WebContents);
  const o = {
    properties: opts.multiple ? ['openFile' as const, 'multiSelections' as const] : ['openFile' as const],
    filters: cleanFilters(opts.filters),
  };
  const r = win ? await dialog.showOpenDialog(win, o) : await dialog.showOpenDialog(o);
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths;
}

/** The system save dialog the editor asks for (Save As, Download as, Export to PDF — finish plan
 *  Task 2), parented to the asking window and starting at `folder`/`name`.<first format>. The
 *  editor's filters say which formats it offers (one, on Linux, where the dialog can't report a
 *  chosen filter). null when cancelled, or when the editor offered no format at all. */
export async function pickSaveTarget(sender: unknown, opts: { filters: unknown; folder: string; name: string; ext?: string }): Promise<string | null | { refused: string }> {
  const filters = cleanFilters(opts.filters);
  const exts = filters.flatMap((f) => f.extensions).filter((e) => e !== '*').map((e) => e.toLowerCase());
  if (!exts.length) return null;
  const win = BrowserWindow.fromWebContents(sender as WebContents);
  // WHY "(copy)" in the document's own format (measured in the dev window): Save As offers the
  // document's format first, and its plain name there IS the open file — which a Save As may not
  // write over (office-commands refuses it). Another format (a PDF) keeps the plain name.
  const stem = exts[0] === opts.ext ? `${opts.name} (copy)` : opts.name;
  const o = {
    defaultPath: path.join(opts.folder, `${stem}.${exts[0]}`),
    filters,
    // WHY: the new file replaces whatever has the chosen name; the person must confirm that.
    properties: ['showOverwriteConfirmation' as const, 'createDirectory' as const],
  };
  const r = win ? await dialog.showSaveDialog(win, o) : await dialog.showSaveDialog(o);
  if (r.canceled || !r.filePath) return null;
  // A name typed in one of the offered formats keeps it; any other gets the first format's
  // extension, with the same never-silently-replace rule as "Save a copy" (resolveCopyTarget).
  if (exts.includes(path.extname(r.filePath).slice(1).toLowerCase())) return r.filePath;
  // WHY checked ahead, asynchronously: main's code keeps no blocking file calls of its own.
  const taken = await fsp.access(`${r.filePath}.${exts[0]}`).then(() => true, () => false);
  return resolveCopyTarget(r.filePath, exts[0], () => taken);
}
