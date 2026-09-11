// src/main/no-folder.ts
//
// Where a "No folder" session actually runs: <userData>/No folder, created on
// first use. See shared/no-folder.ts for why the renderer sends a sentinel.
import fs from 'fs';
import path from 'path';
import { NO_FOLDER_DIR_NAME, isNoFolderCwd } from '../shared/no-folder';

/** The sentinel becomes the app-owned empty folder; any other cwd passes through. */
export function resolveNoFolderCwd<T extends { cwd?: string }>(opts: T, userDataDir: string): T {
  if (!isNoFolderCwd(opts.cwd)) return opts;
  const dir = path.join(userDataDir, NO_FOLDER_DIR_NAME);
  // recursive: a no-op when it exists; created on the first "No folder" session.
  fs.mkdirSync(dir, { recursive: true });
  return { ...opts, cwd: dir };
}
