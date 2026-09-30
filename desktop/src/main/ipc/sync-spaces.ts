// sync-spaces.ts — cross-device sync spaces (projects, conversation leases, the devices list), one
// body for both doors.
//
// WHY (2026-09-30 one-core R3-4): written twice (ipc-handlers.ts and remote-server.ts `case`s).
// Nothing a phone can do changed; every channel here stayed open to a phone. What the two copies
// disagreed on, and what the one body does:
//   - lease-takeover: the computer's copy forwarded an optional `transferNonce`; nothing on either
//     wire ever sent one (the preload and the phone's page both send only claudeSessionId), so it is
//     dropped rather than quietly granting a phone a knob it never had.
//   - import-project: both compared the folder against every live session's folder; unchanged.
//   - the self-marking and the "cannot remove this device" guard both use machineId (sync-spaces.md).
// The session manager and the lease wiring are built in registerIpcHandlers, so they arrive through
// bindSyncSpacesDeps; a phone and the computer share the same two objects.
import { IPC } from '../../shared/backend-contract';
import {
  syncSpacesStatus, syncSpacesEnable, syncSpacesSyncNow, syncSpacesCreateProject, syncSpacesImportProject,
  syncSpacesRenameProject, syncSpacesStopProject, syncSpacesSetProjectDescription, getManagedRoots,
} from '../sync-spaces/service';
import { readDevices, renameDevice, removeDevice } from '../sync-spaces/device-registry';
import type { SessionManager } from '../session-manager';
import type { LeaseClient } from '../conversations/lease-client';
import type { RequesterTakeoverType } from '../conversations/takeover';
import { defineChannel, type MainChannelDef } from './channel-def';

export interface SyncSpacesLeaseWiring {
  client: LeaseClient;
  requester: RequesterTakeoverType;
  /** per-INSTALL: leases only. */
  deviceId: string;
  /** per-MACHINE: the device registry's self-marking only. '' matches no row. */
  machineId: string;
}
interface SyncSpacesDeps { sessionManager: Pick<SessionManager, 'listSessions'>; leaseWiring?: SyncSpacesLeaseWiring | undefined }
let deps: SyncSpacesDeps | null = null;

/** Called once by registerIpcHandlers. With no lease wiring (sync disabled) every lease/device answer
 *  degrades to "free / error" so a resume is never blocked (spec §3 never-block). */
export function bindSyncSpacesDeps(next: SyncSpacesDeps): void { deps = next; }

const wiring = () => deps?.leaseWiring;

export const syncSpacesChannels: MainChannelDef[] = [
  defineChannel({ name: IPC.SYNC_SPACES_STATUS, kind: 'handle', handler: () => syncSpacesStatus() }),
  defineChannel({ name: IPC.SYNC_SPACES_ENABLE, kind: 'handle', handler: (p) => syncSpacesEnable(!!p?.enabled) }),
  // spaceId (optional) narrows the sync to one space for the Project View "Sync now" button;
  // SyncPanel calls with no arg = sync everything.
  defineChannel({ name: IPC.SYNC_SPACES_SYNC_NOW, kind: 'handle', handler: (p) => syncSpacesSyncNow(p?.spaceId ? String(p.spaceId) : undefined) }),
  defineChannel({ name: IPC.SYNC_SPACES_CREATE_PROJECT, kind: 'handle', handler: (p) => syncSpacesCreateProject(String(p?.name ?? '')) }),
  defineChannel({
    name: IPC.SYNC_SPACES_IMPORT_PROJECT, kind: 'handle',
    // Live-cwd guard input: the folder must not move under a running session.
    handler: (p) => syncSpacesImportProject(
      String(p?.sourcePath ?? ''), String(p?.name ?? ''),
      (deps?.sessionManager.listSessions() ?? []).filter((s) => s.status !== 'destroyed').map((s) => s.cwd)),
  }),
  // Cross-device rename (display-name only) + stop-syncing (2026-07-12).
  defineChannel({ name: IPC.SYNC_SPACES_RENAME_PROJECT, kind: 'handle', handler: (p) => syncSpacesRenameProject(String(p?.name ?? ''), String(p?.displayName ?? '')) }),
  defineChannel({ name: IPC.SYNC_SPACES_STOP_PROJECT, kind: 'handle', handler: (p) => syncSpacesStopProject(String(p?.name ?? '')) }),
  defineChannel({ name: IPC.SYNC_SPACES_SET_PROJECT_DESCRIPTION, kind: 'handle', handler: (p) => syncSpacesSetProjectDescription(String(p?.name ?? ''), String(p?.description ?? '')) }),

  // Conversation-lease takeover (Plan 2b Task 9): thin passthroughs to the lease client (query) and
  // the requester flow (takeover / force).
  defineChannel({ name: IPC.SYNC_SPACES_LEASE_QUERY, kind: 'handle', handler: async (p) => (await wiring()?.client.query(String(p?.claudeSessionId ?? ''))) ?? { held: false, source: 'none' } }),
  defineChannel({ name: IPC.SYNC_SPACES_LEASE_TAKEOVER, kind: 'handle', handler: async (p) => ((await wiring()?.requester.takeover(String(p?.claudeSessionId ?? ''))) ?? { outcome: 'error' }) as { outcome: 'ready' | 'timeout' | 'error' | 'undeliverable' } }),
  defineChannel({ name: IPC.SYNC_SPACES_LEASE_FORCE, kind: 'handle', handler: async (p) => (await wiring()?.requester.force(String(p?.claudeSessionId ?? ''))) ?? { ok: false } }),

  // Device registry (Plan 2b spec §10a): the "Your devices" list. self:true marks the current machine.
  defineChannel({
    name: IPC.SYNC_SPACES_LIST_DEVICES, kind: 'handle',
    handler: () => {
      const pr = getManagedRoots()?.personalRoot;
      if (!pr) return [];
      // machineId, not deviceId — rows are keyed per-MACHINE, so the per-install lease id would never
      // match and no row would render "(this device)".
      const selfId = wiring()?.machineId ?? '';
      return readDevices(pr).map((d) => ({ ...d, self: !!selfId && d.id === selfId }));
    },
  }),
  defineChannel({
    name: IPC.SYNC_SPACES_RENAME_DEVICE, kind: 'handle',
    handler: async (p) => {
      const pr = getManagedRoots()?.personalRoot;
      if (!pr) return { ok: false };
      try { await renameDevice(pr, String(p?.id ?? ''), String(p?.name ?? '')); return { ok: true }; }
      catch { return { ok: false }; }
    },
  }),
  defineChannel({
    name: IPC.SYNC_SPACES_REMOVE_DEVICE, kind: 'handle',
    handler: async (p) => {
      const pr = getManagedRoots()?.personalRoot;
      if (!pr) return { ok: false };
      const id = String(p?.id ?? '');
      if (!id) return { ok: false };
      // Refuse to remove THIS machine: upsertSelf re-creates the row on the next launch, so it would
      // read as a no-op that "didn't work". The UI hides the affordance for self; this is the
      // enforcement half (phones too).
      if (id === (wiring()?.machineId ?? '')) return { ok: false, error: 'cannot remove this device' };
      try { await removeDevice(pr, id); return { ok: true }; }
      catch { return { ok: false }; }
    },
  }),
];
