// sync.ts — the backup control plane (sync:*) and its guided setup wizard, one body for both doors.
//
// WHY (2026-09-30 one-core R3-4): each of these was written twice, in ipc-handlers.ts and as a `case`
// in remote-server.ts. Before/after for a phone (all of it stays open to a phone, as before):
//   - get-status / get-config / set-config / force / get-log / add / update / push backend and the six
//     setup steps: same calls, same answers.
//   - remove-backend: the phone used to be told {ok:true}; now it gets what the computer got (nothing).
//     No screen reads it. dismiss-warning: same, {ok:true} -> nothing.
//   - The phone used to also accept a bare id (or the whole payload) where the computer needs { id } and
//     { updates }; the phone's own page always sent the wrapped form, so only a hand-made message could
//     have used the bare one. Dropped.
//   - open-folder is the one place the two really differ: the computer opens the folder itself, a phone
//     is handed the address to open (Drive and GitHub only, as before). That stays a door branch below.
import { execFile } from 'child_process';
import { shell } from 'electron';
import { IPC } from '../../shared/backend-contract';
import {
  getSyncStatus, getSyncConfig, setSyncConfig, forceSync, getSyncLog, dismissWarning,
  addBackend, removeBackend, updateBackend, pushBackend,
} from '../sync-state';
import { checkSyncPrereqs, installRclone, checkGdriveRemote, authGdrive, authGithub, createGithubRepo } from '../sync-setup-handlers';
import { defineChannel, type MainChannelDef } from './channel-def';

/** Where a backend's data lives, as something a person can open: a web address, or (iCloud) a folder on this computer. */
async function backendTarget(id: string): Promise<{ url?: string; path?: string } | null> {
  const config = await getSyncConfig();
  const backend = config.backends.find((b: any) => b.id === id);
  if (!backend) return null;
  switch (backend.type) {
    case 'drive': {
      // Deep-link to the actual sync folder on Google Drive by resolving its file ID via rclone, then
      // https://drive.google.com/drive/folders/<id>. Falls back to the Drive homepage if rclone or the
      // folder lookup fails.
      const rcloneRemote = backend.config?.rcloneRemote || 'gdrive';
      const driveRoot = backend.config?.DRIVE_ROOT || 'Claude';
      const fallbackUrl = 'https://drive.google.com';
      try {
        const stdout: string = await new Promise((resolve, reject) => {
          execFile(
            'rclone',
            ['lsjson', `${rcloneRemote}:${driveRoot}/Backup`, '--dirs-only'],
            { timeout: 15000 },
            (err, out) => (err ? reject(err) : resolve(String(out || ''))),
          );
        });
        const entries = JSON.parse(stdout) as Array<{ Name: string; ID?: string }>;
        const match = entries.find((e) => e.Name === 'personal' && e.ID);
        return { url: match?.ID ? `https://drive.google.com/drive/folders/${match.ID}` : fallbackUrl };
      } catch {
        return { url: fallbackUrl };
      }
    }
    case 'github': return { url: backend.config?.PERSONAL_SYNC_REPO || '' };
    case 'icloud': return { path: backend.config?.ICLOUD_PATH || '' };
    default: return {};
  }
}

export const syncChannels: MainChannelDef[] = [
  defineChannel({ name: IPC.SYNC_GET_STATUS, kind: 'handle', handler: () => getSyncStatus() }),
  defineChannel({ name: IPC.SYNC_GET_CONFIG, kind: 'handle', handler: () => getSyncConfig() }),
  defineChannel({ name: IPC.SYNC_SET_CONFIG, kind: 'handle', handler: (p) => setSyncConfig(p.updates) }),
  defineChannel({ name: IPC.SYNC_FORCE, kind: 'handle', handler: () => forceSync() }),
  defineChannel({ name: IPC.SYNC_GET_LOG, kind: 'handle', handler: (p) => getSyncLog(p?.lines) }),
  // The warning code of the row being dismissed; a missing one dismisses nothing (as the phone's copy did).
  defineChannel({ name: IPC.SYNC_DISMISS_WARNING, kind: 'handle', handler: (p) => dismissWarning(p?.warning ?? '') }),

  // Per-instance backend management (storage backends + multi-instance support).
  // sync:pull-backend ("Download now") was removed in sync-legacy-demolition.
  defineChannel({ name: IPC.SYNC_ADD_BACKEND, kind: 'handle', handler: (instance) => addBackend(instance) }),
  defineChannel({ name: IPC.SYNC_REMOVE_BACKEND, kind: 'handle', handler: (p) => removeBackend(p.id) }),
  defineChannel({ name: IPC.SYNC_UPDATE_BACKEND, kind: 'handle', handler: (p) => updateBackend(p.id, p.updates) }),
  defineChannel({ name: IPC.SYNC_PUSH_BACKEND, kind: 'handle', handler: (p) => pushBackend(p.id) }),

  // Open a backend's remote location. The computer opens it in its own browser / file explorer; a
  // phone cannot open anything on the computer, so it is handed the address instead.
  defineChannel({
    name: IPC.SYNC_OPEN_FOLDER, kind: 'handle',
    handler: async (p, ctx) => {
      const target = await backendTarget(p.id);
      if (ctx.door === 'remote') return { url: target?.url ?? '' };
      if (!target) return undefined;
      // Only the computer's own door gets here (a phone returned above), so `shell` is this machine's.
      if (target.url) shell.openExternal(target.url);
      else if (target.path) shell.openPath(target.path);
      return undefined;
    },
  }),

  // Guided setup wizard: prerequisite detection, tool installation, OAuth, repo creation.
  // Each handler runs one specific command — no generic shell exec.
  defineChannel({ name: IPC.SYNC_SETUP_CHECK_PREREQS, kind: 'handle', handler: (p) => checkSyncPrereqs(p.backend) }),
  defineChannel({ name: IPC.SYNC_SETUP_INSTALL_RCLONE, kind: 'handle', handler: () => installRclone() }),
  defineChannel({ name: IPC.SYNC_SETUP_CHECK_GDRIVE, kind: 'handle', handler: () => checkGdriveRemote() }),
  defineChannel({ name: IPC.SYNC_SETUP_AUTH_GDRIVE, kind: 'handle', handler: () => authGdrive() }),
  defineChannel({ name: IPC.SYNC_SETUP_AUTH_GITHUB, kind: 'handle', handler: () => authGithub() }),
  defineChannel({ name: IPC.SYNC_SETUP_CREATE_REPO, kind: 'handle', handler: (p) => createGithubRepo(p.repoName) }),
];
