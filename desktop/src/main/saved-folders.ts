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

// Case-insensitive on Windows for the same reason FOLDERS_REMOVE compares that
// way: callers hold canonical (lowercase-drive) paths while the store holds
// path.resolve (uppercase-drive) form. A case-sensitive compare silently
// fails to match on Windows.
function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
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
