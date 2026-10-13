// dev.ts — Settings → Development (bug report, contribute), one body for both doors.
//
// WHY (2026-09-30 one-core R3-2): the desktop registered these in ipc-handlers.ts; a phone had no
// case for any of them and got "not available over remote access". Kept exactly: the four
// read/report channels are `remoteAllowed:false`, the ones that clone onto this computer or start
// a session here are `desktopOnly`. (Reading the log or filing a report from a phone is a
// deliberate later decision, not something a move should quietly grant.)
import path from 'path';
import os from 'os';
import { webContents } from 'electron';
import { IPC } from '../../shared/backend-contract';
import { readLogTail, gatherDiagnostics, summarizeIssue, submitIssue, installWorkspace, openDevSessionIn, setupManagedWorkspace, workspaceSetupStatus, clearWorkspaceSetupStatus } from '../dev-tools';
import { readFolders, writeFolders, type SavedFolder } from '../saved-folders';
import { log } from '../logger';
import { defineChannel, type MainChannelDef } from './channel-def';

const defaultsPath = () => path.join(os.homedir(), '.claude', 'youcoded-defaults.json');

/** Register a finished workspace as a saved project folder (NOT a sync space — see setup below). */
function registerWorkspaceFolder(absPath: string, why: string): void {
  try {
    const normalized = path.resolve(absPath);
    const folders = readFolders();
    if (!folders.some((f) => path.resolve(f.path) === normalized)) {
      folders.unshift({ path: normalized, nickname: path.basename(normalized), addedAt: Date.now() } as SavedFolder);
      writeFolders(folders);
    }
  } catch (e) {
    log('WARN', 'dev', `folders.add ${why} failed`, { error: String(e) });
  }
}

export const devChannels: MainChannelDef[] = [
  // The last N lines of the app log, redacted, for the bug-report flow.
  defineChannel({ name: IPC.DEV_LOG_TAIL, kind: 'handle', remoteAllowed: false, handler: (maxLines) => readLogTail(typeof maxLines === 'number' ? maxLines : 200) }),
  // Environment snapshot prepended to the log tail in the bug-report flow.
  defineChannel({ name: IPC.DEV_DIAGNOSTICS, kind: 'handle', remoteAllowed: false, handler: () => gatherDiagnostics() }),
  // Shells out to `claude -p` for a structured summary; falls back gracefully.
  defineChannel({ name: IPC.DEV_SUMMARIZE_ISSUE, kind: 'handle', remoteAllowed: false, handler: (args) => summarizeIssue(args) }),
  // GitHub when signed in, otherwise a prefilled browser URL.
  defineChannel({ name: IPC.DEV_SUBMIT_ISSUE, kind: 'handle', remoteAllowed: false, handler: (args) => submitIssue(args) }),
  defineChannel({
    name: IPC.DEV_INSTALL_WORKSPACE, kind: 'handle', desktopOnly: true,
    // Clone (or update) ~/youcoded-dev, stream progress lines to the CALLING window only.
    handler: async (_payload, ctx) => {
      const send = (line: string) => {
        const target = ctx.windowId === undefined ? undefined : webContents.fromId(ctx.windowId);
        if (target && !target.isDestroyed()) target.send(IPC.DEV_INSTALL_PROGRESS, line);
      };
      try {
        const result = await installWorkspace(send);
        registerWorkspaceFolder(result.path, 'post-install');
        return result;
      } catch (e: any) {
        return { error: String(e?.message || e) };
      }
    },
  }),
  // Managed development workspace (contract R9/R10). Setup lives in main on purpose: the screen
  // says "you can close this, setup keeps going", which is only true if closing the dialog cannot
  // cancel it. Registered as a saved project folder, NOT a sync space: a space under
  // ~/YouCoded/Projects would push this ~1GB tree to the user's backup unannounced.
  defineChannel({
    name: IPC.DEV_SETUP_WORKSPACE, kind: 'handle', desktopOnly: true,
    handler: () => setupManagedWorkspace((absPath) => registerWorkspaceFolder(absPath, 'post-setup')),
  }),
  defineChannel({ name: IPC.DEV_SETUP_STATUS, kind: 'handle', desktopOnly: true, handler: () => workspaceSetupStatus() }),
  defineChannel({ name: IPC.DEV_SETUP_CLEAR, kind: 'handle', desktopOnly: true, handler: () => { clearWorkspaceSetupStatus(); } }),
  defineChannel({
    name: IPC.DEV_OPEN_SESSION_IN, kind: 'handle', desktopOnly: true,
    handler: (args, ctx) => {
      // The session manager only exists in this computer's process; a phone never reaches here.
      if (!ctx.desktop) throw new Error('The session manager is not available.');
      return openDevSessionIn(args, { defaultsPrefPath: defaultsPath(), sessionManager: ctx.desktop.sessionManager, homedir: os.homedir });
    },
  }),
];
