// The session picker's saved-folder store (~/.claude/youcoded-folders.json).
// Extracted from ipc-handlers.ts so other main-process code (the sync-spaces
// import flow rewrites an entry's path when a folder is MOVED into
// ~/YouCoded/Projects/) can share one reader/writer instead of duplicating the
// file format. The file is a bare JSON array of SavedFolder.
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { SavedFolder } from '../shared/prefs-types';
export type { SavedFolder };

/** True on the phone (the only host started headless). WHY (card #213, Destin 2026-11-08): there,
 *  home is the app's own private top folder (settings files such as providers.json), not a place the
 *  user keeps work, so it is never offered as a project and a session with no folder opens in the
 *  app-owned empty "No folder" instead (no-folder.ts). */
export function homeIsAppPrivate(): boolean { return !!process.env.YOUCODED_HEADLESS_PORT; }

/** Drops a Home entry where home is the app's private folder (the phone); unchanged elsewhere.
 *  Every phone install before this change already saved one, so filtering (not just skipping the seed) is needed. */
export function withoutPrivateHome<T extends { path: string }>(folders: T[]): T[] {
  if (!homeIsAppPrivate()) return folders;
  const home = path.resolve(os.homedir());
  return folders.filter((f) => path.resolve(f.path) !== home);
}

function foldersFilePath(): string {
  return path.join(os.homedir(), '.claude', 'youcoded-folders.json');
}

export function readFolders(file: string = foldersFilePath()): SavedFolder[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeFolders(folders: SavedFolder[], file: string = foldersFilePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Temp-file + rename: the import flow widened this store's writers, and the
  // dev instance and built app share ~/.claude. rename is atomic, so a
  // concurrent reader (readFolders) never sees a half-written file. The tmp
  // name is unique per writer (pid + time) — a fixed `.tmp` would let two
  // concurrent processes interleave writes to the SAME tmp path.
  // NOTE: the store is best-effort read-modify-write (no file lock like
  // central-index's mutateFileUnderLock) — deliberate given the low write
  // rate, not an oversight.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(folders, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Don't leave the orphaned tmp behind on a failed rename.
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    throw e;
  }
}

/** The ONE way to compare two folder paths for "same folder".
 *  WHY: this was spelled four ways (always lower-case, Windows-only lower-case, a Windows-only
 *  helper, plain ===). Windows and macOS disks ignore letter case (and Project View hands in
 *  a lowercase-drive `c:\\…` while the store holds `C:\\…`), so they compare lower-cased;
 *  Linux disks are case-sensitive, so `/home/a/Docs` and `/home/a/docs` are two folders there.
 *  Unicode is normalised to NFC because macOS spells accented names decomposed. Reads
 *  process.platform per call so tests can stub it. */
export function pathKey(p: string): string {
  const r = path.resolve(p).normalize('NFC');
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
}

function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** Rewrite one entry's path (used when a folder is moved on disk). Returns
 *  false when no entry matched — callers treat that as fine (the folder may
 *  never have been saved; the managed-projects merge will list it anyway). */
export function updateFolderPath(oldPath: string, newPath: string, file: string = foldersFilePath()): boolean {
  const folders = readFolders(file);
  const entry = folders.find(f => samePath(f.path, oldPath));
  if (!entry) return false;
  entry.path = path.resolve(newPath);
  writeFolders(folders, file);
  return true;
}
