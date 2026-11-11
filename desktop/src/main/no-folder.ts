// src/main/no-folder.ts
//
// Where a "No folder" session actually runs: <userData>/No folder, created on
// first use. See shared/no-folder.ts for why the renderer sends a sentinel.
import fs from 'fs';
import path from 'path';
import { NO_FOLDER_DIR_NAME, isNoFolderCwd } from '../shared/no-folder';
import { homeIsAppPrivate } from './saved-folders';

/** The sentinel becomes the app-owned empty folder; any other cwd passes through.
 *  `emptyIsNoFolder` (the phone): a NEW session with no folder at all is treated as "No folder" too.
 *  WHY (card #213, Destin 2026-11-08 "just do the simplest fix we can for now"): on the phone the
 *  session manager's empty-cwd fallback, the home folder, is the app's own private top folder. It
 *  holds the app's settings files (providers.json and others), so the Files tab showed clutter the
 *  user never made and Claude could edit app settings. On a computer, home is the user's own folder,
 *  so desktop keeps its fallback. A resume names its own folder and is left alone. */
export function resolveNoFolderCwd<T extends { cwd?: string; resumeSessionId?: string }>(
  opts: T, userDataDir: string, { emptyIsNoFolder = homeIsAppPrivate() }: { emptyIsNoFolder?: boolean } = {},
): T {
  const emptyNew = emptyIsNoFolder && !opts.cwd && !opts.resumeSessionId;
  if (!isNoFolderCwd(opts.cwd) && !emptyNew) return opts;
  const dir = path.join(userDataDir, NO_FOLDER_DIR_NAME);
  // recursive: a no-op when it exists; created on the first "No folder" session.
  fs.mkdirSync(dir, { recursive: true });
  return { ...opts, cwd: dir };
}
