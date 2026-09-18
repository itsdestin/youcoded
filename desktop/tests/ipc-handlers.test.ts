import {
  describe, it, expect, vi, beforeEach, afterEach,
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
});

// Task 5 gap (final review): TAGS_UPDATE and TAGS_DELETE denormalize into the
// chatsearch metadata snapshot (meta-builder.ts resolves tag ids -> LABELS once,
// at build time, into each conversation row) but never told chatsearch to
// rebuild — so renaming or deleting a tag left the index serving the old label
// (or a since-deleted one) until an unrelated refresh happened to catch up.
describe('tags:update / tags:delete signal chatsearch (Task 5 gap)', () => {
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

// Review finding 1 (Task 13): the readiness check that keeps a plan from being
// proposed with a specialist that cannot run reaches NativeSessionHost from one
// line in this file. Deleting that line left the typecheck clean and all 11,905
// tests green while the app silently went back to the bug. This asks the host
// the application actually builds what it was handed, so the wire cannot be
// lost without something going red.
describe('what registerIpcHandlers hands the native session host', () => {
  it('wires the plan readiness check to the real provider registry', async () => {
    const built: any[][] = [];
    vi.resetModules();
    vi.doMock('../src/main/harness/native-session-host', async () => {
      const { EventEmitter } = await import('node:events');
      class FakeHost extends EventEmitter {
        constructor(...args: any[]) {
          super();
          built.push(args);
          // Everything registerIpcHandlers calls on the host is a no-op here:
          // only the constructor arguments are under test.
          return new Proxy(this, {
            get: (target, prop, receiver) => (prop in target
              ? Reflect.get(target, prop, receiver)
              : () => undefined),
          });
        }
      }
      return { NativeSessionHost: FakeHost };
    });
    try {
      const { registerIpcHandlers: register } = await import('../src/main/ipc-handlers');
      register(
        { handle: vi.fn(), on: vi.fn() } as any,
        { createSession: vi.fn(), destroySession: vi.fn(), listSessions: vi.fn(() => []), sendInput: vi.fn(), resizeSession: vi.fn(), on: vi.fn() } as any,
        { webContents: { send: vi.fn() }, isDestroyed: () => false } as any,
        { configStore: { getPackages: vi.fn(() => ({})) }, getInstalled: vi.fn(() => []) } as any,
      );
      expect(built).toHaveLength(1);
      const wiring = built[0].find((a: any) => a && typeof a === 'object' && 'providerReadinessFor' in a);
      expect(wiring, 'the host was built without the provider-readiness wiring').toBeDefined();
      // The answer comes from the real ProviderRegistry, not a stub: a provider
      // that is not in providers.json is not ready, in the registry's words.
      await expect(wiring.providerReadinessFor({ providerId: 'not-a-provider', modelId: 'm' })).resolves.toEqual({
        ok: false, label: 'not-a-provider', message: "Provider 'not-a-provider' is not configured.",
      });
    } finally {
      vi.doUnmock('../src/main/harness/native-session-host');
      vi.resetModules();
    }
  });
});
