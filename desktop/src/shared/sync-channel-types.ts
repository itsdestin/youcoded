// sync-channel-types.ts — the request/response rows of the sync:*, syncspaces:* and github:*
// channels (one-core R3-4).
//
// WHY a file of its own (2026-09-30 one-core R3-4): backend-contract.ts is past its line budget;
// like marketplace-channel-types.ts, ChannelTypes extends this so a row is still found by name.
// Every response is derived from the function that answers it (type-only imports, erased at
// build), so a row cannot drift from the code behind it.
import type * as SyncState from '../main/sync-state';
import type * as SyncSetup from '../main/sync-setup-handlers';
import type * as SpacesService from '../main/sync-spaces/service';
import type { BackendInstance } from '../main/sync-state';
import type * as GithubClient from '../main/github-client';
import type * as GithubAuth from '../main/github-auth';
import type { ConnectStartResult } from '../main/github-connect';

type Res<F extends (...args: any[]) => any> = Awaited<ReturnType<F>>;

/** One row of the "Your devices" list; `self` marks this machine. */
interface SyncDeviceRow { schemaVersion: number; id: string; name: string; platform: string; lastSeen: number; updatedAt: number; self: boolean }
/** Who holds a conversation (`held:false` when nobody, or when sync is off). */
interface LeaseQueryAnswer { held: boolean; device?: string; deviceId?: string; self?: boolean; source?: string }

export interface SyncChannelTypes {
  // sync:* — the toolkit backup control plane. A phone may use all of it (as before).
  'sync:get-status': { request: void; response: Res<typeof SyncState.getSyncStatus> };
  'sync:get-config': { request: void; response: Res<typeof SyncState.getSyncConfig> };
  'sync:set-config': { request: { updates: Parameters<typeof SyncState.setSyncConfig>[0] }; response: Res<typeof SyncState.setSyncConfig> };
  'sync:force': { request: void; response: Res<typeof SyncState.forceSync> };
  'sync:get-log': { request: { lines?: number } | undefined; response: string[] };
  'sync:dismiss-warning': { request: { warning: string }; response: void };
  'sync:add-backend': { request: Omit<BackendInstance, 'id'>; response: Res<typeof SyncState.addBackend> };
  'sync:remove-backend': { request: { id: string }; response: void };
  'sync:update-backend': { request: { id: string; updates: Parameters<typeof SyncState.updateBackend>[1] }; response: Res<typeof SyncState.updateBackend> };
  'sync:push-backend': { request: { id: string }; response: Res<typeof SyncState.pushBackend> };
  // The computer opens the folder itself and answers nothing; a phone is handed the address to open.
  'sync:open-folder': { request: { id: string }; response: { url: string } | undefined };
  'sync:setup:check-prereqs': { request: { backend: Parameters<typeof SyncSetup.checkSyncPrereqs>[0] }; response: Res<typeof SyncSetup.checkSyncPrereqs> };
  'sync:setup:install-rclone': { request: void; response: Res<typeof SyncSetup.installRclone> };
  'sync:setup:check-gdrive': { request: void; response: Res<typeof SyncSetup.checkGdriveRemote> };
  'sync:setup:auth-gdrive': { request: void; response: Res<typeof SyncSetup.authGdrive> };
  'sync:setup:auth-github': { request: void; response: Res<typeof SyncSetup.authGithub> };
  'sync:setup:create-repo': { request: { repoName: string }; response: Res<typeof SyncSetup.createGithubRepo> };

  // syncspaces:* — cross-device sync spaces (projects, leases, the devices list).
  'syncspaces:status': { request: void; response: Res<typeof SpacesService.syncSpacesStatus> };
  'syncspaces:enable': { request: { enabled: boolean }; response: Res<typeof SpacesService.syncSpacesEnable> };
  'syncspaces:sync-now': { request: { spaceId?: string }; response: Res<typeof SpacesService.syncSpacesSyncNow> };
  'syncspaces:create-project': { request: { name: string }; response: Res<typeof SpacesService.syncSpacesCreateProject> };
  'syncspaces:import-project': { request: { sourcePath: string; name: string }; response: Res<typeof SpacesService.syncSpacesImportProject> };
  'syncspaces:rename-project': { request: { name: string; displayName: string }; response: Res<typeof SpacesService.syncSpacesRenameProject> };
  'syncspaces:stop-project': { request: { name: string }; response: Res<typeof SpacesService.syncSpacesStopProject> };
  'syncspaces:set-project-description': { request: { name: string; description: string }; response: Res<typeof SpacesService.syncSpacesSetProjectDescription> };
  'syncspaces:lease-query': { request: { claudeSessionId: string }; response: LeaseQueryAnswer };
  'syncspaces:lease-takeover': { request: { claudeSessionId: string }; response: { outcome: 'ready' | 'timeout' | 'error' | 'undeliverable' } };
  'syncspaces:lease-force': { request: { claudeSessionId: string }; response: { ok: boolean } };
  'syncspaces:list-devices': { request: void; response: SyncDeviceRow[] };
  'syncspaces:rename-device': { request: { id: string; name: string }; response: { ok: boolean } };
  'syncspaces:remove-device': { request: { id: string }; response: { ok: boolean; error?: string } };

  // github:* — the Connect-GitHub modal. The access token never appears in any of these.
  'github:status': { request: void; response: Res<typeof GithubClient.combinedGithubStatus> };
  'github:connect-start': { request: void; response: ConnectStartResult | { error: 'unavailable' } };
  'github:connect-cancel': { request: void; response: { ok: true } };
  'github:install-gh': { request: void; response: Res<typeof GithubAuth.installGh> };
  'github:disconnect': { request: void; response: { ok: true } };
}
