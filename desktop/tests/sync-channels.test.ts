// The sync, syncspaces and github channels (one-core R3-4): one table entry each, served to the
// computer's windows and to a phone by the same handler. The generic "same handler on both doors"
// and "nothing left behind" checks are in channel-table-families.test.ts and cover these names
// automatically; this file pins what those cannot see: who may call what, the one door-specific
// branch (open-folder), and the device/lease guards that must hold for a phone too.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const rootHolder = vi.hoisted(() => ({ personalRoot: null as string | null }));
vi.mock('../src/main/sync-spaces/service', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  getManagedRoots: () => (rootHolder.personalRoot ? { personalRoot: rootHolder.personalRoot } : null),
}));
const shellFns = vi.hoisted(() => ({ openExternal: vi.fn(), openPath: vi.fn() }));
const { openExternal, openPath } = shellFns;
vi.mock('electron', () => {
  const BrowserWindowMock: any = vi.fn(() => ({ loadURL: vi.fn(), on: vi.fn(), webContents: { send: vi.fn() } }));
  BrowserWindowMock.getAllWindows = vi.fn(() => []);
  return {
    app: { isPackaged: false, getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0-test'), whenReady: vi.fn(() => new Promise(() => {})), on: vi.fn(), quit: vi.fn(), setAppUserModelId: vi.fn(), commandLine: { appendSwitch: vi.fn() }, getGPUInfo: vi.fn(() => new Promise(() => {})) },
    ipcMain: { handle: vi.fn(), on: vi.fn() }, BrowserWindow: BrowserWindowMock, Menu: { setApplicationMenu: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() }, dialog: { showOpenDialog: vi.fn() },
    clipboard: { readImage: vi.fn(() => ({ isEmpty: () => true })) }, nativeImage: {},
    shell: { openExternal: shellFns.openExternal, openPath: shellFns.openPath },
    powerSaveBlocker: { start: vi.fn(() => 0), stop: vi.fn() }, webContents: { getAllWebContents: vi.fn(() => []) },
  };
});
const syncConfig = vi.hoisted(() => ({ backends: [] as any[] }));
vi.mock('../src/main/sync-state', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  getSyncConfig: async () => syncConfig,
}));

import { IPC } from '../src/shared/backend-contract';
import { CHANNEL_TABLE, findChannel, serveRemoteChannel } from '../src/main/ipc/channel-table';
import { bindSyncSpacesDeps } from '../src/main/ipc/sync-spaces';
import { DEVICE_REGISTRY_SCHEMA } from '../src/main/sync-spaces/device-registry';

// personalRoot is a plain alias so the tests read naturally; the mock reads the hoisted holder.
let personalRoot: string | null = null;
const setRoot = (p: string | null) => { personalRoot = p; rootHolder.personalRoot = p; };
const FAMILY = /^(sync|syncspaces|github):/;
const desktopCtx: any = { door: 'desktop', runtime: null, broadcast: () => {} };
const phoneCtx: any = { door: 'remote', runtime: null, broadcast: () => {} };
const asDesktop = (name: string, payload?: unknown) => findChannel(name)!.handler(payload, desktopCtx);
const asPhone = async (name: string, payload?: unknown) => {
  const out = await serveRemoteChannel(findChannel(name)!, payload, phoneCtx);
  return out.reply ? out.payload : undefined;
};

describe('sync, syncspaces and github: what is in the table and who may call it', () => {
  it('every request/response name in the contract has an entry (the two pushes are not entries)', () => {
    const inTable = new Set(CHANNEL_TABLE.map((d) => d.name));
    const pushes = new Set<string>([IPC.SYNC_SPACES_EVENT, IPC.GITHUB_CONNECT_DONE]);
    const names = Object.values(IPC).filter((v) => FAMILY.test(v) && !pushes.has(v));
    expect(names.length).toBe(36); // 17 sync + 14 syncspaces + 5 github; a new one must be decided here
    expect(names.filter((n) => !inTable.has(n))).toEqual([]);
  });
  it('all of them are open to a phone, exactly as before (nothing refused, nothing newly opened)', () => {
    const entries = CHANNEL_TABLE.filter((d) => FAMILY.test(d.name));
    expect(entries.length).toBe(36);
    expect(entries.filter((d) => d.desktopOnly || d.remoteAllowed === false).map((d) => d.name)).toEqual([]);
  });
});

describe('sync spaces: leases and devices behave the same for a phone', () => {
  const machineId = 'machine-1';
  const put = (id: string, name: string) => {
    fs.mkdirSync(path.join(personalRoot!, 'Devices'), { recursive: true });
    fs.writeFileSync(path.join(personalRoot!, 'Devices', `${id}.json`), JSON.stringify({ schemaVersion: DEVICE_REGISTRY_SCHEMA, id, name, platform: 'linux', lastSeen: 1, updatedAt: 1 }));
  };
  beforeEach(() => {
    setRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'r34-devices-')));
    put(machineId, 'This computer');
    put('other', 'Laptop');
    bindSyncSpacesDeps({ sessionManager: { listSessions: () => [] } as any, leaseWiring: { client: {} as any, requester: {} as any, deviceId: 'install-1', machineId } });
  });
  afterEach(() => { fs.rmSync(personalRoot!, { recursive: true, force: true }); setRoot(null); });

  it('the devices list marks this computer on both doors', async () => {
    for (const rows of [await asDesktop(IPC.SYNC_SPACES_LIST_DEVICES), await asPhone(IPC.SYNC_SPACES_LIST_DEVICES)]) {
      expect((rows as any[]).map((r) => [r.id, r.self]).sort()).toEqual([['machine-1', true], ['other', false]]);
    }
  });
  it('removing this computer\'s own row is refused for a phone as for the computer, and another device can be removed', async () => {
    const refusal = { ok: false, error: 'cannot remove this device' };
    expect(await asDesktop(IPC.SYNC_SPACES_REMOVE_DEVICE, { id: machineId })).toEqual(refusal);
    expect(await asPhone(IPC.SYNC_SPACES_REMOVE_DEVICE, { id: machineId })).toEqual(refusal);
    expect(fs.existsSync(path.join(personalRoot!, 'Devices', `${machineId}.json`))).toBe(true);
    expect(await asPhone(IPC.SYNC_SPACES_REMOVE_DEVICE, { id: 'other' })).toEqual({ ok: true });
    expect(fs.existsSync(path.join(personalRoot!, 'Devices', 'other.json'))).toBe(false);
  });
  it('with sync off (no lease wiring) leases answer free / error on both doors, so a resume is never blocked', async () => {
    bindSyncSpacesDeps({ sessionManager: { listSessions: () => [] } as any });
    for (const run of [asDesktop, asPhone]) {
      expect(await run(IPC.SYNC_SPACES_LEASE_QUERY, { claudeSessionId: 'x' })).toEqual({ held: false, source: 'none' });
      expect(await run(IPC.SYNC_SPACES_LEASE_TAKEOVER, { claudeSessionId: 'x' })).toEqual({ outcome: 'error' });
      expect(await run(IPC.SYNC_SPACES_LEASE_FORCE, { claudeSessionId: 'x' })).toEqual({ ok: false });
    }
  });
  it('with no managed folders, the device calls answer empty / not-ok rather than throwing', async () => {
    const real = personalRoot; setRoot(null);
    expect(await asPhone(IPC.SYNC_SPACES_LIST_DEVICES)).toEqual([]);
    expect(await asPhone(IPC.SYNC_SPACES_RENAME_DEVICE, { id: 'other', name: 'x' })).toEqual({ ok: false });
    setRoot(real); // afterEach removes it
  });
});

describe('sync:open-folder: the computer opens it, a phone is handed the address', () => {
  beforeEach(() => { openExternal.mockClear(); openPath.mockClear(); });
  it('a GitHub backend: the computer opens the repo in its browser, the phone gets the same address and opens nothing', async () => {
    syncConfig.backends = [{ id: 'g1', type: 'github', config: { PERSONAL_SYNC_REPO: 'https://github.com/x/y' } }];
    expect(await asDesktop(IPC.SYNC_OPEN_FOLDER, { id: 'g1' })).toBeUndefined();
    expect(openExternal).toHaveBeenCalledWith('https://github.com/x/y');
    openExternal.mockClear();
    expect(await asPhone(IPC.SYNC_OPEN_FOLDER, { id: 'g1' })).toEqual({ url: 'https://github.com/x/y' });
    expect(openExternal).not.toHaveBeenCalled();
  });
  it('an iCloud backend: the computer opens the folder; a phone is given no address (there is none to give)', async () => {
    syncConfig.backends = [{ id: 'i1', type: 'icloud', config: { ICLOUD_PATH: '/Users/x/iCloud' } }];
    await asDesktop(IPC.SYNC_OPEN_FOLDER, { id: 'i1' });
    expect(openPath).toHaveBeenCalledWith('/Users/x/iCloud');
    expect(await asPhone(IPC.SYNC_OPEN_FOLDER, { id: 'i1' })).toEqual({ url: '' });
    expect(openPath).toHaveBeenCalledTimes(1);
  });
  it('an unknown backend id opens nothing and gives a phone an empty address', async () => {
    syncConfig.backends = [];
    expect(await asDesktop(IPC.SYNC_OPEN_FOLDER, { id: 'nope' })).toBeUndefined();
    expect(await asPhone(IPC.SYNC_OPEN_FOLDER, { id: 'nope' })).toEqual({ url: '' });
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe('github: the modal drives one shared flow, and asking with none running answers "unavailable"', () => {
  it('connect-start with no orchestrator answers the same on both doors', async () => {
    expect(await asDesktop(IPC.GITHUB_CONNECT_START)).toEqual({ error: 'unavailable' });
    expect(await asPhone(IPC.GITHUB_CONNECT_START)).toEqual({ error: 'unavailable' });
    expect(await asPhone(IPC.GITHUB_CONNECT_CANCEL)).toEqual({ ok: true });
  });
});
