import {
  describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock electron before importing ipc-handlers, which transitively imports
// main.ts (for setPermissionOverrides). main.ts uses protocol.registerSchemesAsPrivileged
// and Menu.setApplicationMenu at module scope, both of which crash without this mock.
vi.mock('electron', () => {
  // getAllWindows is a static method on the real BrowserWindow class —
  // broadcastToAllWindows (called after a successful tags:create/update/delete)
  // needs it to return an iterable, or those handlers throw before ever
  // reaching emitConversationMetaChanged.
  const BrowserWindowMock: any = vi.fn(() => ({ loadURL: vi.fn(), on: vi.fn(), webContents: { send: vi.fn() } }));
  BrowserWindowMock.getAllWindows = vi.fn(() => []);
  return {
    // whenReady must never resolve — otherwise main.ts runs its entire init chain
    // (createWindow, RemoteServer, SyncService, etc.) which hits unmocked APIs.
    app: { isPackaged: false, getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0-test'), whenReady: vi.fn(() => new Promise(() => {})), on: vi.fn(), quit: vi.fn(), setAppUserModelId: vi.fn(), commandLine: { appendSwitch: vi.fn() }, getGPUInfo: vi.fn(() => new Promise(() => {})) },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    BrowserWindow: BrowserWindowMock,
    Menu: { setApplicationMenu: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    dialog: { showOpenDialog: vi.fn() },
    clipboard: { readImage: vi.fn(() => ({ isEmpty: () => true })) },
    nativeImage: {},
    shell: { openExternal: vi.fn() },
    powerSaveBlocker: { start: vi.fn(() => 0), stop: vi.fn() },
  };
});

import { registerIpcHandlers } from '../src/main/ipc-handlers';
import * as conversationsService from '../src/main/conversations/service';
import { startConversationStore, stopConversationStore, getConversationStore, pruneNativePhantomRecords } from '../src/main/conversations/service';
import { startTagRegistry } from '../src/main/conversations/tag-registry-service';

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

describe('session:create native resume — missing stored header', () => {
  // Regression for Task 13 review item 1: resuming a native session whose saved
  // data is gone (nativeHost.resume() → false) AND with no binding to start a
  // fresh one must surface a session-error transcript event, or the renderer is
  // left with a live SessionInfo backed by nothing and a silently empty chat.
  it('emits a session-error transcript event for the resumed id', async () => {
    const mockIpcMain = { handle: vi.fn(), on: vi.fn() };
    const mockSessionManager = {
      // Mock a NATIVE SessionInfo for the resumed id — createSession's real
      // native branch uses resumeSessionId AS the id, so we mirror that here.
      // The id points at a session that was never persisted, so the real
      // NativeSessionHost.resume() reads no header from disk and returns false.
      createSession: vi.fn(() => ({ id: 'ghost-native-1', name: 'Resuming…', cwd: '/tmp', status: 'active', provider: 'native' })),
      destroySession: vi.fn(() => true),
      listSessions: vi.fn(() => []),
      sendInput: vi.fn(),
      resizeSession: vi.fn(),
      on: vi.fn(),
    };
    const mockWindow = { webContents: { send: vi.fn() }, isDestroyed: () => false };
    const mockSkillProvider = {
      configStore: { getPackages: vi.fn(() => ({})) },
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
      (c: any) => c[0] === 'session:create',
    )[1];

    // Resume a native id with NO binding → resume() returns false → error path.
    await handler(
      { sender: { id: 1 } },
      { provider: 'native', resumeSessionId: 'ghost-native-1', cwd: '/tmp', name: 'Resuming…', skipPermissions: false },
    );

    // The error emit is deferred via process.nextTick (so it lands after
    // SESSION_CREATED + assignSession) — flush one tick before asserting.
    await new Promise((resolve) => process.nextTick(resolve));

    const errorCall = mockWindow.webContents.send.mock.calls.find(
      (c: any[]) => c[0] === 'transcript:event' && c[1]?.type === 'session-error',
    );
    expect(errorCall).toBeTruthy();
    expect(errorCall![1].sessionId).toBe('ghost-native-1');
    expect(typeof errorCall![1].data.text).toBe('string');
    expect(errorCall![1].data.text.length).toBeGreaterThan(0);
  });

  it('a session a phone creates runs the same native start: the remote host is handed it', async () => {
    const mockIpcMain = { handle: vi.fn(), on: vi.fn() };
    const mockSessionManager = {
      createSession: vi.fn(), destroySession: vi.fn(() => true), listSessions: vi.fn(() => []),
      sendInput: vi.fn(), resizeSession: vi.fn(), on: vi.fn(),
    };
    const mockWindow = { webContents: { send: vi.fn() }, isDestroyed: () => false };
    const mockSkillProvider = { configStore: { getPackages: vi.fn(() => ({})) } };
    let starter: ((info: any, opts: any) => Promise<void>) | null = null;
    const remoteServer = {
      broadcast: vi.fn(),
      setNativeRuntime: vi.fn(), setSessionMetaWiring: vi.fn(), setSessionNamingWiring: vi.fn(), setLastTopic: vi.fn(),
      setSessionStarter: vi.fn((fn: any) => { starter = fn; }),
      getClientCount: vi.fn(() => 0), broadcastStatusData: vi.fn(), onStatusChange: vi.fn(() => () => {}),
    };
    registerIpcHandlers(
      mockIpcMain as any, mockSessionManager as any, mockWindow as any, mockSkillProvider as any,
      undefined as any, undefined, undefined, remoteServer as any,
    );
    expect(starter).toBeTypeOf('function');
    // The resume with no stored data and no binding: the start runs and says so to every screen.
    await starter!(
      { id: 'ghost-native-2', name: 'Resuming…', cwd: '/tmp', status: 'active', provider: 'native' },
      { provider: 'native', resumeSessionId: 'ghost-native-2', cwd: '/tmp', name: 'Resuming…', skipPermissions: false },
    );
    await new Promise((resolve) => process.nextTick(resolve));
    const pushed = remoteServer.broadcast.mock.calls.find(
      (c: any[]) => c[0]?.type === 'transcript:event' && c[0]?.payload?.type === 'session-error',
    );
    expect(pushed?.[0].payload.sessionId).toBe('ghost-native-2');
  });
});

// Task 5 gap (final review): TAGS_UPDATE and TAGS_DELETE denormalize into the
// chatsearch metadata snapshot (meta-builder.ts resolves tag ids -> LABELS once,
// at build time, into each conversation row) but never told chatsearch to
// rebuild — so renaming or deleting a tag left the index serving the old label
// (or a since-deleted one) until an unrelated refresh happened to catch up.
describe('tags:update / tags:delete signal chatsearch', () => {
  let tmp: string;
  let mockIpcMain: { handle: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
  let mockSessionManager: any;
  let mockWindow: any;
  let mockSkillProvider: any;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-tags-ipc-'));
    // Real tag registry against a tmp dir — no fs mocking, and the handlers
    // short-circuit to {ok:false} if getTagRegistry() returns null, so a real
    // registry is required to reach the success path at all.
    startTagRegistry({ tagsRoot: tmp });

    mockIpcMain = { handle: vi.fn(), on: vi.fn() };
    mockSessionManager = {
      createSession: vi.fn(() => ({ id: '1', name: 'test', cwd: '/tmp', status: 'active' })),
      destroySession: vi.fn(() => true),
      listSessions: vi.fn(() => []),
      sendInput: vi.fn(),
      resizeSession: vi.fn(),
      on: vi.fn(),
    };
    mockWindow = { webContents: { send: vi.fn() }, isDestroyed: () => false };
    mockSkillProvider = {
      configStore: { getPackages: vi.fn(() => ({})) },
      install: vi.fn(),
      installMany: vi.fn(),
      ensureBundledPluginsInstalled: vi.fn(),
      ensureMigrated: vi.fn(),
    };
  });

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); } catch { /* best-effort cleanup */ }
  });

  function handlerFor(channel: string) {
    registerIpcHandlers(mockIpcMain as any, mockSessionManager as any, mockWindow as any, mockSkillProvider as any);
    return (mockIpcMain.handle as any).mock.calls.find((c: any) => c[0] === channel)[1];
  }

  it('tags:update signals chatsearch after a successful rename', async () => {
    const spy = vi.spyOn(conversationsService, 'emitConversationMetaChanged');
    const update = handlerFor('tags:update');
    const create = handlerFor('tags:create');
    const created = await create({}, 'Old Label', 'tag-gray');

    const result = await update({}, created.tag.id, { label: 'New Label' });

    expect(result.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('tags:update does not signal chatsearch when the registry rejects the update', async () => {
    const spy = vi.spyOn(conversationsService, 'emitConversationMetaChanged');
    const update = handlerFor('tags:update');

    const result = await update({}, 'tag_does_not_exist', { label: 'New Label' });

    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('tags:delete signals chatsearch after a successful delete', async () => {
    const spy = vi.spyOn(conversationsService, 'emitConversationMetaChanged');
    const del = handlerFor('tags:delete');
    const create = handlerFor('tags:create');
    const created = await create({}, 'Doomed Tag', 'tag-gray');

    const result = await del({}, created.tag.id);

    expect(result.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

// Security regression: transcript:read-meta validated the caller-supplied path
// with startsWith(claudeProjects) and NO trailing path separator, so a SIBLING
// directory like ~/.claude/projects-evil/x.jsonl passed the containment check
// and its contents leaked. The model:read-last handler next door already used
// the correct `claudeProjects + path.sep` prefix — these tests pin the
// transcript:read-meta handler to the same rule.
describe('transcript:read-meta path containment', () => {
  let tmpHome: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;
  let mockIpcMain: { handle: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-transcript-meta-'));
    // Point os.homedir() at the tmp dir so the handler's ~/.claude/projects
    // containment root lives inside the fixture, not the real home.
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    mockIpcMain = { handle: vi.fn(), on: vi.fn() };
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    try { fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); } catch { /* best-effort cleanup */ }
  });

  function handlerFor(channel: string) {
    const mockSessionManager: any = {
      createSession: vi.fn(), destroySession: vi.fn(), listSessions: vi.fn(() => []),
      sendInput: vi.fn(), resizeSession: vi.fn(), on: vi.fn(),
    };
    const mockWindow: any = { webContents: { send: vi.fn() }, isDestroyed: () => false };
    const mockSkillProvider: any = {
      configStore: { getPackages: vi.fn(() => ({})) },
      install: vi.fn(), installMany: vi.fn(),
      ensureBundledPluginsInstalled: vi.fn(), ensureMigrated: vi.fn(),
    };
    registerIpcHandlers(mockIpcMain as any, mockSessionManager, mockWindow, mockSkillProvider);
    return (mockIpcMain.handle as any).mock.calls.find((c: any) => c[0] === channel)[1];
  }

  it('rejects a transcript in a sibling dir like ~/.claude/projects-evil', async () => {
    const evilDir = path.join(tmpHome, '.claude', 'projects-evil');
    fs.mkdirSync(evilDir, { recursive: true });
    const evilFile = path.join(evilDir, 'x.jsonl');
    fs.writeFileSync(evilFile, JSON.stringify({ model: 'leaked-model' }) + '\n');

    const handler = handlerFor('transcript:read-meta');
    expect(await handler({}, evilFile)).toBeNull();
  });

  it('still reads a transcript inside ~/.claude/projects', async () => {
    const okDir = path.join(tmpHome, '.claude', 'projects', 'some-project');
    fs.mkdirSync(okDir, { recursive: true });
    const okFile = path.join(okDir, 'x.jsonl');
    fs.writeFileSync(okFile, JSON.stringify({ model: 'test-model' }) + '\n');

    const handler = handlerFor('transcript:read-meta');
    const meta = await handler({}, okFile);
    expect(meta?.model).toBe('test-model');
  });
});

describe('dialog:open-file attachment picker filters', () => {
  // Pins Destin's 2026-08-12 request: the paperclip picker must OPEN showing
  // ALL files, on every platform. The way to get that from Electron is to pass
  // NO `filters` key at all: on Linux the XDG portal ignores our ordering
  // (wildcard stripped, "*.*" appended last, no current_filter emitted —
  // electron#43491) and on Windows the dialog skips a leading All Files entry
  // when picking its default (electron#19492), so ANY filter list defaults
  // the dialog to the first named category (Images) instead of all files.
  // A lone All-Files filter is no fix either: its '*' becomes the glob '*.*',
  // which on Linux excludes extensionless files like Makefile.
  async function getDialogOptions(channel: string) {
    const mockIpcMain = { handle: vi.fn(), on: vi.fn() };
    const mockSessionManager = {
      createSession: vi.fn(), destroySession: vi.fn(), listSessions: vi.fn(() => []),
      sendInput: vi.fn(), resizeSession: vi.fn(), on: vi.fn(),
    };
    const mockWindow = { webContents: { send: vi.fn() }, isDestroyed: () => false };
    const mockSkillProvider = { configStore: { getPackages: vi.fn(() => ({})) } };
    registerIpcHandlers(
      mockIpcMain as any, mockSessionManager as any, mockWindow as any, mockSkillProvider as any,
    );
    const { dialog } = await import('electron');
    (dialog.showOpenDialog as any).mockResolvedValue({ canceled: true, filePaths: [] });
    const handler = (mockIpcMain.handle as any).mock.calls.find(
      (c: any) => c[0] === channel,
    )[1];
    await handler({});
    return (dialog.showOpenDialog as any).mock.calls.at(-1)[1];
  }

  it('passes NO filters key, so the dialog shows all files on every platform', async () => {
    const options = await getDialogOptions('dialog:open-file');
    expect('filters' in options).toBe(false);
  });

  it('still requests an openFile + multiSelections dialog', async () => {
    const options = await getDialogOptions('dialog:open-file');
    expect(options.properties).toEqual(['openFile', 'multiSelections']);
  });

  it('open-sound keeps its audio filter FIRST and wildcard last', async () => {
    // The sound picker's intended default IS its first concrete filter (Audio
    // Files). Electron's Linux rewrite only strips/moves the wildcard entry to
    // the end — already its position here — so the portal's first listed filter
    // stays Audio Files and the default is correct on all platforms. This pin
    // fails if someone reorders the list or adds a category above Audio Files.
    const options = await getDialogOptions('dialog:open-sound');
    const names = options.filters.map((f: { name: string }) => f.name);
    expect(names[0]).toBe('Audio Files');
    expect(options.filters.at(-1)).toEqual({ name: 'All Files', extensions: ['*'] });
  });
});

// Simplification audit W2: the 10 s status push used to re-read every status
// file and send the same payload to every window, minimised or not. These pin
// the three changes: an unchanged payload is not re-sent, the tick does nothing
// while no window is visible and no phone is connected, and the first look
// afterwards (a focus, a phone connecting) gets a push at once.
describe('status push: deduplicated, paused while nobody can see it, resumed on first look', () => {
  // Every fs read the build makes resolves as a microtask, so one fake-timer
  // advance settles a whole build — no real disk, no sleeps.
  let usageJson: string | null;
  let readFile: ReturnType<typeof vi.spyOn>;
  let stat: ReturnType<typeof vi.spyOn>;
  let httpsGet: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    usageJson = null;
    readFile = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (p: any) => {
      if (String(p).endsWith('.usage-cache.json') && usageJson != null) return usageJson;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    stat = vi.spyOn(fs.promises, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    // The build kicks a release check; keep it off the network.
    const https = await import('node:https');
    httpsGet = vi.spyOn(https.default, 'get').mockImplementation((() => ({ on: () => ({ on: () => ({}) }) })) as any);
  });
  afterEach(() => {
    readFile.mockRestore(); stat.mockRestore(); httpsGet.mockRestore();
    vi.useRealTimers();
  });

  async function boot(opts: { clients?: () => number } = {}) {
    const win = {
      visible: true,
      webContents: { send: vi.fn() },
      isDestroyed: () => false,
      isVisible() { return win.visible; },
      isMinimized: () => false,
      on: vi.fn(),
    };
    let statusListener: ((s: any) => void) | null = null;
    const remoteServer = opts.clients ? {
      getClientCount: opts.clients,
      broadcastStatusData: vi.fn(),
      onStatusChange: vi.fn((cb: (s: any) => void) => { statusListener = cb; return () => {}; }),
      broadcast: vi.fn(),
      // Wiring the handlers hand a real server at boot; inert here.
      setNativeRuntime: vi.fn(), setSessionMetaWiring: vi.fn(), setSessionNamingWiring: vi.fn(), setLastTopic: vi.fn(),
      setSessionStarter: vi.fn(),
    } : undefined;
    const mockSkillProvider = { configStore: { getPackages: vi.fn(() => ({})) }, getInstalled: vi.fn(() => []) };
    registerIpcHandlers(
      { handle: vi.fn(), on: vi.fn() } as any,
      { createSession: vi.fn(), destroySession: vi.fn(), listSessions: vi.fn(() => []), sendInput: vi.fn(), resizeSession: vi.fn(), on: vi.fn() } as any,
      win as any,
      mockSkillProvider as any,
      undefined as any, undefined, undefined, remoteServer as any,
    );
    const { app } = await import('electron');
    const focus = (app.on as any).mock.calls.filter((c: any[]) => c[0] === 'browser-window-focus').at(-1)[1] as () => void;
    const sends = () => win.webContents.send.mock.calls.filter((c: any[]) => c[0] === 'status:data').length;
    const tick = () => vi.advanceTimersByTimeAsync(10_000);
    return { win, sends, tick, focus, phoneConnects: () => statusListener?.({ clientCount: 1 }), remoteServer };
  }

  it('sends a changed payload once and does not repeat an identical one', async () => {
    const { sends, tick } = await boot();
    await tick();
    expect(sends()).toBe(1);
    await tick();
    await tick();
    expect(sends()).toBe(1); // same files, same answer — nothing to tell the windows
    usageJson = '{"five_hour":{"used":1}}';
    await tick();
    expect(sends()).toBe(2);
  });

  it('skips the tick while the window is hidden, then pushes the moment it is focused again', async () => {
    const { win, sends, tick, focus } = await boot();
    await tick();
    expect(sends()).toBe(1);
    win.visible = false;
    usageJson = '{"five_hour":{"used":2}}';
    await tick();
    await tick();
    expect(sends()).toBe(1); // changed on disk, but nobody can see a status bar
    win.visible = true;
    focus();
    await vi.advanceTimersByTimeAsync(0);
    expect(sends()).toBe(2); // right away, not after the next 10 s tick
    focus();
    await vi.advanceTimersByTimeAsync(0);
    expect(sends()).toBe(2); // a focus with no missed tick behind it pushes nothing
  });

  it('remote:status over desktop IPC carries clientCount as a number, with or without a server', async () => {
    const remoteConfig = { keepAwakeHours: 0, port: 9900, toSafeObject: () => ({}) };
    const ipcMain = { handle: vi.fn(), on: vi.fn() };
    registerIpcHandlers(
      ipcMain as any,
      { createSession: vi.fn(), destroySession: vi.fn(), listSessions: vi.fn(() => []), sendInput: vi.fn(), resizeSession: vi.fn(), on: vi.fn() } as any,
      { webContents: { send: vi.fn() }, isDestroyed: () => false } as any,
      { configStore: { getPackages: vi.fn(() => ({})) }, getInstalled: vi.fn(() => []) } as any,
      undefined as any, undefined, remoteConfig as any, undefined,
    );
    const handler = ipcMain.handle.mock.calls.find((c: any[]) => c[0] === 'remote:status')![1];
    expect(await handler({})).toMatchObject({ state: 'stopped', port: 0, clientCount: 0 });
  });

  it('a connected phone counts as an audience, and a phone connecting gets the missed push', async () => {
    let clients = 0;
    const { win, sends, tick, phoneConnects, remoteServer } = await boot({ clients: () => clients });
    win.visible = false;
    await tick();
    expect(sends()).toBe(0);
    clients = 1;
    phoneConnects();
    await vi.advanceTimersByTimeAsync(0);
    expect(sends()).toBe(1);
    expect(remoteServer!.broadcastStatusData).toHaveBeenCalledTimes(1);
    usageJson = '{"five_hour":{"used":3}}';
    await tick(); // window still hidden — the phone keeps the tick alive
    expect(sends()).toBe(2);
  });
});

// A mock ipcMain/session manager/window/skill provider wired through the REAL
// registerIpcHandlers; handler(channel) returns what it registered.
function setup(sessionManagerOverrides: Record<string, unknown> = {}) {
  const mockIpcMain = { handle: vi.fn(), on: vi.fn() };
  const mockSessionManager = {
    createSession: vi.fn(),
    destroySession: vi.fn(() => true),
    listSessions: vi.fn(() => []),
    getSession: vi.fn(() => undefined),
    sendInput: vi.fn(),
    resizeSession: vi.fn(),
    on: vi.fn(),
    ...sessionManagerOverrides,
  };
  const mockWindow = { webContents: { send: vi.fn() }, isDestroyed: () => false };
  const mockSkillProvider = {
    configStore: { getPackages: vi.fn(() => ({})) },
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
  const handler = (channel: string) =>
    (mockIpcMain.handle as any).mock.calls.find((c: any) => c[0] === channel)[1];
  return { handler, mockWindow };
}

// The three split-refusal messages of the native resume path (session:create).
// Each case drives the REAL handler with a REAL conversation store and asserts
// the EXACT copy, so a wording collapse or branch swap fails loudly.
describe('session:create native resume refusals', () => {
  let tmpHome: string;
  let tmpConvRoot: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  // One home for the whole section: registerIpcHandlers kicks off background
  // init (ProviderRegistry.init → writes ~/.youcoded) that no test awaits, so
  // deleting the dir per-test raced those writes and surfaced as unhandled
  // ENOENT rejections. A single dir plus no mid-run deletion avoids it.
  beforeAll(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-refusal-'));
    // Redirect the home via $HOME rather than vi.spyOn(os, 'homedir'):
    // native-home.ts does `import * as os`, and the spy does NOT reach that
    // namespace binding — it left the fixture invisible. USERPROFILE is the
    // Windows equivalent and MUST be set too (desktop CI runs windows-latest).
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterAll(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    // Deliberately not removed — see the note above: nothing
    // exposes a handle to await ProviderRegistry.init()'s background writes.
  });

  beforeEach(async () => {
    // Unlike the native-meta section below, this file does NOT write a native
    // transcript jsonl here — the whole point of these cases is that RESUME_ID's
    // transcript is absent under the redirected home.
    tmpConvRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-refusal-store-'));
    // REAL store (design's acceptance: a fake would let a write-to-wrong-bucket
    // regression pass). noteFlagChanged/noteSessionNote buffer until the store
    // settles 'ready'/'unavailable' (conversations/service.ts) — awaiting start
    // here means every call in a test sees the fast 'ready' path.
    await startConversationStore({
      conversationsRoot: tmpConvRoot,
      projectsDir: path.join(tmpHome, '.claude', 'projects'),
      topicsDir: path.join(tmpHome, '.claude', 'topics'),
      device: 'test-device',
    });
  });

  afterEach(() => {
    stopConversationStore();
    vi.restoreAllMocks();
    try { fs.rmSync(tmpConvRoot, { recursive: true, force: true }); } catch {}
  });

  const RESUME_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  async function createNativeResume(handler: any, cwd?: string) {
    await handler('session:create')(
      { sender: { id: 1 } },
      { provider: 'native', resumeSessionId: RESUME_ID, cwd, name: 'Resuming…', skipPermissions: false },
    );
    // Refusals emit via process.nextTick — flush one tick before asserting.
    await new Promise((resolve) => process.nextTick(resolve));
  }

  function sessionErrorText(mockWindow: any): string | undefined {
    const call = mockWindow.webContents.send.mock.calls.find(
      (c: any[]) => c[0] === 'transcript:event' && c[1]?.type === 'session-error' && c[1]?.sessionId === RESUME_ID,
    );
    return call?.[1]?.data?.text;
  }

  describe('session:create native resume — split refusal messages', () => {
    it("refuses with the 'hasn't synced' message when the folder resolves but its transcript is absent", async () => {
      const { handler, mockWindow } = setup({
        createSession: vi.fn(() => ({ id: RESUME_ID, name: 'Resuming…', cwd: '/tmp', status: 'active', provider: 'native' })),
      });
      // Record resolves via originalPath (an existing dir) but NO
      // <home>/.youcoded/sessions/<slug>/<id>.jsonl exists for that dir.
      const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-refusal-proj-'));
      await getConversationStore()!.upsert({
        provider: 'native', id: RESUME_ID,
        projectName: path.basename(projDir), originalPath: projDir,
      });
      await createNativeResume(handler, '/nonexistent-cwd');
      expect(sessionErrorText(mockWindow)).toBe(
        "This conversation hasn't synced to this device yet — its transcript isn't here.",
      );
      fs.rmSync(projDir, { recursive: true, force: true });
    });

    it("refuses with the 'project folder isn't on this device' message when nothing resolves the record", async () => {
      const { handler, mockWindow } = setup({
        createSession: vi.fn(() => ({ id: RESUME_ID, name: 'Resuming…', cwd: '/tmp', status: 'active', provider: 'native' })),
      });
      // originalPath does not exist; projectName matches no managed root or
      // saved folder under the redirected HOME → resolver returns null.
      await getConversationStore()!.upsert({
        provider: 'native', id: RESUME_ID,
        projectName: 'no-such-project-anywhere', originalPath: '/definitely/not/here',
      });
      await createNativeResume(handler, '/nonexistent-cwd');
      expect(sessionErrorText(mockWindow)).toBe(
        "This conversation's project folder ('no-such-project-anywhere') isn't on this device.",
      );
    });

    it("refuses with the 'saved data is missing' message when there is no record and no binding", async () => {
      const { handler, mockWindow } = setup({
        createSession: vi.fn(() => ({ id: RESUME_ID, name: 'Resuming…', cwd: '/tmp', status: 'active', provider: 'native' })),
      });
      // No store record, cwd fails existsSync, no binding → resume() false path.
      await createNativeResume(handler, '/nonexistent-cwd');
      expect(sessionErrorText(mockWindow)).toBe(
        'This conversation could not be resumed — its saved data is missing.',
      );
    });
  });
});

// Native sessions are real Conversation Store records, so
// session:set-flag/set-tag/set-note/get-meta/browse read and write them like any
// other session. A write-only test would pass against a regression where the
// write silently vanishes into the WRONG bucket, so the acceptance here is a
// full ROUND TRIP: write, then read the SAME value back through BOTH
// session:get-meta AND session:browse.
describe('native session meta through the real store', () => {
  // A persisted native session is one with a file at
  // <home>/.youcoded/sessions/<slug>/<sessionId>.jsonl — that's exactly what
  // SessionStore.has() scans, and what NativeSessionHost.isNativeSessionId()
  // consults for a session that is NOT currently live. Real file, real
  // ConversationStore (createConversationStore against a tmpdir, unmocked) —
  // no fakes standing in for the thing this test exists to prove works.
  const NATIVE_ID = '11111111-2222-3333-4444-555555555555';
  const CC_ID = '99999999-8888-7777-6666-555555555555';

  let tmpHome: string;
  let tmpConvRoot: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  // One home for the whole section — same reason as the refusal section above.
  beforeAll(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-meta-parity-'));
    // $HOME + USERPROFILE, never a homedir spy — see the refusal section.
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterAll(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    // Deliberately not removed — see the refusal section's note: nothing
    // exposes a handle to await ProviderRegistry.init()'s background writes.
  });

  beforeEach(async () => {
    const slugDir = path.join(tmpHome, '.youcoded', 'sessions', 'test-project');
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(
      path.join(slugDir, `${NATIVE_ID}.jsonl`),
      JSON.stringify({ v: 1, sessionId: NATIVE_ID, harnessId: 'assistant', cwd: '/tmp/test-project', createdAt: Date.now() }) + '\n',
    );
    tmpConvRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-meta-parity-store-'));
    // REAL store (design's acceptance: a fake would let a write-to-wrong-bucket
    // regression pass). noteFlagChanged/noteSessionNote buffer until the store
    // settles 'ready'/'unavailable' (conversations/service.ts) — awaiting start
    // here means every call in a test sees the fast 'ready' path.
    await startConversationStore({
      conversationsRoot: tmpConvRoot,
      projectsDir: path.join(tmpHome, '.claude', 'projects'),
      topicsDir: path.join(tmpHome, '.claude', 'topics'),
      device: 'test-device',
    });
  });

  afterEach(() => {
    stopConversationStore();
    vi.restoreAllMocks();
    try { fs.rmSync(tmpConvRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); } catch {}
  });

  describe('native session meta — round trip', () => {
    it('tag → persist → get-meta and browse both return it for a native session', async () => {
      const { handler } = setup();

      const setRes = await handler('session:set-tag')({ sender: { id: 1 } }, NATIVE_ID, 'tag_physics', true);
      expect(setRes).toEqual({ ok: true });

      const meta = await handler('session:get-meta')({ sender: { id: 1 } }, NATIVE_ID);
      expect(meta).toMatchObject({ tags: ['tag_physics'], note: '', supported: true });

      const rows = await handler('session:browse')();
      const row = rows.find((r: any) => r.sessionId === NATIVE_ID);
      expect(row).toBeTruthy();
      expect(row.provider).toBe('native');
      expect(row.tags).toEqual(['tag_physics']);
    });

    it('note → persist → get-meta returns it for a native session', async () => {
      const { handler } = setup();

      const setRes = await handler('session:set-note')({ sender: { id: 1 } }, NATIVE_ID, 'debugging the spinner regex');
      expect(setRes).toEqual({ ok: true });

      const meta = await handler('session:get-meta')({ sender: { id: 1 } }, NATIVE_ID);
      expect(meta).toMatchObject({ note: 'debugging the spinner regex', supported: true });
    });

    it('a reserved flag round-trips for a native session (previously refused outright)', async () => {
      const { handler } = setup();

      const setRes = await handler('session:set-flag')({ sender: { id: 1 } }, NATIVE_ID, 'priority', true);
      expect(setRes).toEqual({ ok: true });

      const rows = await handler('session:browse')();
      const row = rows.find((r: any) => r.sessionId === NATIVE_ID);
      expect(row?.flags).toMatchObject({ priority: true });
    });

    it('broadcast fires only after the record is readable', async () => {
      const { handler, mockWindow } = setup();
      const recordPath = path.join(tmpConvRoot, 'native', `${NATIVE_ID}.json`);
      let sawTagAtBroadcastTime: boolean | null = null;

      (mockWindow.webContents.send as any).mockImplementation((channel: string, ...args: any[]) => {
        if (channel !== 'session:meta-changed') return;
        // By the time sendForSession runs, the handler has already AWAITED
        // noteFlagChanged's write — read the file synchronously right here to
        // prove the record landed BEFORE this broadcast, not concurrently with
        // or after it (which would let a listener refetch and "confirm" a
        // change that hadn't actually persisted yet — the exact 2026-07-19
        // incident shape, just for the persistence-timing dimension).
        try {
          const rec = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
          sawTagAtBroadcastTime = !!rec?.flags?.['tag:tag_physics']?.value;
        } catch {
          sawTagAtBroadcastTime = false;
        }
      });

      const res = await handler('session:set-tag')({ sender: { id: 1 } }, NATIVE_ID, 'tag_physics', true);
      expect(res.ok).toBe(true);
      expect(sawTagAtBroadcastTime).toBe(true);
    });
  });

  // C1 (final review): a native record can exist in the store WITHOUT a local
  // ~/.youcoded/sessions file — the record synced from a peer but its transcript
  // hasn't been materialized here yet (Task 5 exposes full meta controls on such
  // store-only browse rows). isNativeSessionId() returns FALSE for it (SessionStore
  // .has() is live/on-disk only), so the OLD sessionProviderFor(isNativeSessionId
  // ? 'native' : 'claude') tagged it 'claude' → SEEDED a claude/<id>.json phantom
  // (blank transcriptRef, EPOCH lastActive) that syncs out and shadows the real
  // native record. The fix probes the store's native bucket before defaulting.
  describe('store-only native record — meta routes to the native bucket (C1)', () => {
    // UUID-shaped so it passes the store id guard; deliberately NOT the NATIVE_ID
    // that beforeEach lays a sessions file down for — this id has a store record
    // but NO ~/.youcoded/sessions file, so isNativeSessionId() answers false.
    const STORE_ONLY_ID = '22222222-3333-4444-5555-666666666666';

    async function seedStoreOnlyNative() {
      const store = getConversationStore()!;
      // A realistic synced-but-not-materialized native record: real activity, a
      // native-lane transcriptRef pointing at the space copy that hasn't been
      // pulled to ~/.youcoded/sessions on THIS device yet.
      await store.upsert({
        id: STORE_ONLY_ID,
        provider: 'native',
        lastActive: new Date().toISOString(),
        title: 'synced native session',
        transcriptRef: `native/transcripts/test-project/${STORE_ONLY_ID}.jsonl`,
      });
    }

    it('set-tag writes native/, creates NO claude phantom, and survives phantom-prune', async () => {
      const { handler } = setup();
      await seedStoreOnlyNative();
      // Precondition: no sessions file for this id, so it is NOT isNativeSessionId.
      const sessionsFile = path.join(tmpHome, '.youcoded', 'sessions', 'test-project', `${STORE_ONLY_ID}.jsonl`);
      expect(fs.existsSync(sessionsFile)).toBe(false);

      const res = await handler('session:set-tag')({ sender: { id: 1 } }, STORE_ONLY_ID, 'tag_physics', true);
      expect(res).toEqual({ ok: true });

      // The tag landed in the NATIVE bucket...
      const nativePath = path.join(tmpConvRoot, 'native', `${STORE_ONLY_ID}.json`);
      const nativeRec = JSON.parse(fs.readFileSync(nativePath, 'utf8'));
      expect(nativeRec.flags['tag:tag_physics']?.value).toBe(true);
      // ...and NO claude phantom was seeded.
      const claudePath = path.join(tmpConvRoot, 'claude', `${STORE_ONLY_ID}.json`);
      expect(fs.existsSync(claudePath)).toBe(false);

      // get-meta reads it back from the native bucket (same routing on the read).
      const meta = await handler('session:get-meta')({ sender: { id: 1 } }, STORE_ONLY_ID);
      expect(meta).toMatchObject({ tags: ['tag_physics'], supported: true });

      // pruneNativePhantomRecords (which only ever touches the claude bucket)
      // leaves the correctly-routed native record untouched.
      const pruned = await pruneNativePhantomRecords({ nativeHomeRoot: tmpHome });
      expect(pruned).toBe(0);
      expect(fs.existsSync(nativePath)).toBe(true);
      const stillTagged = JSON.parse(fs.readFileSync(nativePath, 'utf8'));
      expect(stillTagged.flags['tag:tag_physics']?.value).toBe(true);
    });

    it('set-note routes to the native bucket too', async () => {
      const { handler } = setup();
      await seedStoreOnlyNative();
      const res = await handler('session:set-note')({ sender: { id: 1 } }, STORE_ONLY_ID, 'peer-synced note');
      expect(res).toEqual({ ok: true });
      const nativeRec = JSON.parse(fs.readFileSync(path.join(tmpConvRoot, 'native', `${STORE_ONLY_ID}.json`), 'utf8'));
      expect(nativeRec.note).toBe('peer-synced note');
      expect(fs.existsSync(path.join(tmpConvRoot, 'claude', `${STORE_ONLY_ID}.json`))).toBe(false);
    });
  });

  describe('Claude Code sessions — unaffected by the native unlock (regression)', () => {
    it('set-flag on a CC id still succeeds', async () => {
      const { handler } = setup();
      const res = await handler('session:set-flag')({ sender: { id: 1 } }, CC_ID, 'complete', true);
      expect(res.ok).toBe(true);
    });

    it('set-flag on a LIVE CC session with no hook mapping yet still returns ok:true', async () => {
      // The pre-existing phantom-record gate skips the store WRITE here (the
      // desktop id isn't mapped to a claude id yet), but the flag re-applies
      // once the SessionStart hook lands the mapping — so this must NOT surface
      // as a failure the renderer reverts. Regression guard carried forward from
      // the retired stopgap test: canWriteStoreRecord's CC live-before-mapping
      // gate is untouched by this task, only its native-false branch was removed.
      const { handler } = setup({
        getSession: vi.fn(() => ({ id: CC_ID, name: 'live', cwd: '/tmp', status: 'active' })),
      });
      const res = await handler('session:set-flag')({ sender: { id: 1 } }, CC_ID, 'priority', true);
      expect(res.ok).toBe(true);
      expect(res.unsupported).toBeUndefined();
    });

    it('get-meta on a CC id reports supported:true', async () => {
      const { handler } = setup();
      const meta = await handler('session:get-meta')({ sender: { id: 1 } }, CC_ID);
      expect(meta.supported).toBe(true);
    });

    it('an unknown flag name is still rejected before any provider logic', async () => {
      // Validation error, not a provider-derived path — ordering matters so a
      // typo surfaces as a typo even on a native session id.
      const { handler } = setup();
      const res = await handler('session:set-flag')({ sender: { id: 1 } }, NATIVE_ID, 'bogus', true);
      expect(res.ok).toBe(false);
      expect(res.unsupported).toBeUndefined();
      expect(res.error).toContain('bogus');
    });
  });
});
