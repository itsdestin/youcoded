import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron before importing ipc-handlers, which transitively imports
// main.ts (for setPermissionOverrides). main.ts uses protocol.registerSchemesAsPrivileged
// and Menu.setApplicationMenu at module scope, both of which crash without this mock.
vi.mock('electron', () => ({
  // whenReady must never resolve — otherwise main.ts runs its entire init chain
  // (createWindow, RemoteServer, SyncService, etc.) which hits unmocked APIs.
  app: { isPackaged: false, getPath: vi.fn(() => '/tmp'), whenReady: vi.fn(() => new Promise(() => {})), on: vi.fn(), quit: vi.fn(), setAppUserModelId: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: vi.fn(() => ({ loadURL: vi.fn(), on: vi.fn(), webContents: { send: vi.fn() } })),
  Menu: { setApplicationMenu: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  clipboard: { readImage: vi.fn(() => ({ isEmpty: () => true })) },
  nativeImage: {},
  shell: { openExternal: vi.fn() },
  powerSaveBlocker: { start: vi.fn(() => 0), stop: vi.fn() },
}));

import { registerIpcHandlers } from '../src/main/ipc-handlers';

describe('IPC Handlers', () => {
  it('registers all expected IPC channels', () => {
    const mockIpcMain = {
      handle: vi.fn(),
      on: vi.fn(),
    };
    const mockSessionManager = {
      createSession: vi.fn(() => ({ id: '1', name: 'test', cwd: '/tmp', status: 'active' })),
      destroySession: vi.fn(() => true),
      listSessions: vi.fn(() => []),
      sendInput: vi.fn(),
      resizeSession: vi.fn(),
      on: vi.fn(),
    };
    const mockWindow = { webContents: { send: vi.fn() }, isDestroyed: () => false };
    // Fix: registerIpcHandlers now requires a skillProvider with a configStore
    const mockSkillProvider = {
      configStore: { getPackages: vi.fn(() => ({})) },
      getInstalled: vi.fn(() => []),
      listMarketplace: vi.fn(() => []),
      getSkillDetail: vi.fn(),
      search: vi.fn(() => []),
      install: vi.fn(),
      uninstall: vi.fn(),
      getFavorites: vi.fn(() => []),
      setFavorite: vi.fn(),
      getChips: vi.fn(() => []),
      setChips: vi.fn(),
      getOverrides: vi.fn(() => ({})),
      setOverride: vi.fn(),
      createPromptSkill: vi.fn(),
      deletePromptSkill: vi.fn(),
      publish: vi.fn(),
      generateShareLink: vi.fn(),
      importFromLink: vi.fn(),
      getCuratedDefaults: vi.fn(() => []),
    };

    registerIpcHandlers(mockIpcMain as any, mockSessionManager as any, mockWindow as any, mockSkillProvider as any);

    const registeredChannels = mockIpcMain.handle.mock.calls.map((c: any) => c[0]);
    expect(registeredChannels).toContain('session:create');
    expect(registeredChannels).toContain('session:destroy');
    expect(registeredChannels).toContain('session:list');
  });
});

describe('skills:uninstall bundled-plugin rejection', () => {
  // Shared mock infrastructure for this suite — recreated before each test
  // so handler registrations don't bleed across tests.
  let mockIpcMain: { handle: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
  let mockSessionManager: any;
  let mockWindow: any;

  beforeEach(() => {
    mockIpcMain = { handle: vi.fn(), on: vi.fn() };
    mockSessionManager = {
      createSession: vi.fn(() => ({ id: '1', name: 'test', cwd: '/tmp', status: 'active' })),
      destroySession: vi.fn(() => true),
      listSessions: vi.fn(() => []),
      sendInput: vi.fn(),
      resizeSession: vi.fn(),
      broadcastReloadPlugins: vi.fn(),
      on: vi.fn(),
    };
    mockWindow = { webContents: { send: vi.fn() }, isDestroyed: () => false };
  });

  it('rejects uninstall for bundled plugin IDs without calling skillProvider.uninstall', async () => {
    const uninstall = vi.fn();
    const mockSkillProvider = {
      configStore: { getPackages: vi.fn(() => ({})) },
      uninstall,
      install: vi.fn(),
      installMany: vi.fn(),
      ensureBundledPluginsInstalled: vi.fn(),
      ensureMigrated: vi.fn(),
    };
    registerIpcHandlers(
      mockIpcMain as any,
      mockSessionManager as any,
      mockWindow as any,
      mockSkillProvider as any,
    );
    const handler = (mockIpcMain.handle as any).mock.calls.find(
      (c: any) => c[0] === 'skills:uninstall',
    )[1];
    const result = await handler({}, 'wecoded-themes-plugin');
    expect(result).toEqual({ ok: false, error: 'bundled', type: 'plugin' });
    expect(uninstall).not.toHaveBeenCalled();
  });

  it('falls through to skillProvider.uninstall for non-bundled IDs', async () => {
    const uninstall = vi.fn().mockResolvedValue({ type: 'plugin' });
    const mockSkillProvider = {
      configStore: { getPackages: vi.fn(() => ({})) },
      uninstall,
      install: vi.fn(),
      installMany: vi.fn(),
      ensureBundledPluginsInstalled: vi.fn(),
      ensureMigrated: vi.fn(),
    };
    registerIpcHandlers(
      mockIpcMain as any,
      mockSessionManager as any,
      mockWindow as any,
      mockSkillProvider as any,
    );
    const handler = (mockIpcMain.handle as any).mock.calls.find(
      (c: any) => c[0] === 'skills:uninstall',
    )[1];
    await handler({}, 'some-other-plugin');
    expect(uninstall).toHaveBeenCalledWith('some-other-plugin');
  });
});
