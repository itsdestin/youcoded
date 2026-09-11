// src/shared/no-folder.ts
//
// "No folder": a session that runs in an empty folder the app owns, so the
// assistant starts with no instructions and no files (Destin, first-run guide
// round 2, N-6). The renderer sends this SENTINEL as the session's cwd; main
// swaps it for the real path (main/no-folder.ts) before anything touches disk.
// A sentinel rather than an empty cwd because an empty cwd already means
// "fall back to the home folder" (session-manager.ts), which is the opposite
// of zero context — the home folder can carry a CLAUDE.md.
//
// Shared by main and renderer, so no Node imports here.

export const NO_FOLDER_CWD = 'youcoded://no-folder';

/** The folder's on-disk name under userData. Its basename is what every
 *  session header, strip pill and project card shows, so it reads as words. */
export const NO_FOLDER_DIR_NAME = 'No folder';

export function isNoFolderCwd(cwd: unknown): cwd is typeof NO_FOLDER_CWD {
  return cwd === NO_FOLDER_CWD;
}
