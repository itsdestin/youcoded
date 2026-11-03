import {
  describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { nativeStoreSlug, ccProjectSlug } from '../src/main/slug-encoding';

// Mock electron before importing ipc-handlers: the families it wires import electron at module scope. (It no
// longer imports main.ts — the permission overrides moved to app-signals.ts, 2026-10-14.)
vi.mock('electron', () => {
  // getAllWindows is a static method on the real BrowserWindow class —
  // broadcastToAllWindows (called after a successful tags:create/update/delete)
  // needs it to return an iterable, or those handlers throw before ever
  // reaching emitConversationMetaChanged.
  const BrowserWindowMock: any = vi.fn(() => ({ loadURL: vi.fn(), on: vi.fn(), webContents: { send: vi.fn() } }));
  BrowserWindowMock.getAllWindows = vi.fn(() => []);
  BrowserWindowMock.fromWebContents = vi.fn(() => ({ focus: vi.fn() }));
  return {
    // whenReady must never resolve — otherwise main.ts runs its entire init chain
    // (createWindow, RemoteServer, SyncService, etc.) which hits unmocked APIs.
    app: { isPackaged: false, getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0-test'), whenReady: vi.fn(() => new Promise(() => {})), on: vi.fn(), quit: vi.fn(), setAppUserModelId: vi.fn(), commandLine: { appendSwitch: vi.fn() }, getGPUInfo: vi.fn(() => new Promise(() => {})) },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    BrowserWindow: BrowserWindowMock,
    webContents: { fromId: vi.fn() },
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
import { registerWithRuntime } from './helpers/register-ipc';
import { findChannel } from '../src/main/ipc/channel-table';

// A phone's session:create: the same table entry a window reaches, with no window behind it.
const phoneCreate = (opts: any) => findChannel('session:create')!.handler(opts, { door: 'remote', runtime: null, broadcast: () => {} } as any);
import * as conversationsService from '../src/main/conversations/service';
import { startConversationStore, stopConversationStore, getConversationStore, pruneNativePhantomRecords } from '../src/main/conversations/service';
import { startTagRegistry } from '../src/main/conversations/tag-registry-service';

// WHY no test here may touch the network: every registerIpcHandlers call starts the app's update
// check, a real request to GitHub. Its reply landing mid-test changed the status payload and failed
// the status-push dedupe test on a loaded machine, and a unit test must not depend on GitHub's
// timing or availability. Any socket or fetch a test opens is recorded and fails the file in afterAll.
const networkAttempts: string[] = [];
let releaseChecks = 0;
beforeAll(async () => {
  // The update check's https.get answers with a network error, as if offline: the app keeps its
  // "no update known" status, exactly as it does on a machine with no connection.
  const https = await import('node:https');
  vi.spyOn(https.default, 'get').mockImplementation((() => {
    releaseChecks++;
    const req = new EventEmitter() as EventEmitter & { destroy: () => void };
    req.destroy = () => {};
    queueMicrotask(() => req.emit('error', new Error('offline (stubbed in ipc-handlers.test.ts)')));
    return req;
  }) as any);
  const net = await import('node:net');
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: any, ...args: any[]) {
    const o = args[0];
    networkAttempts.push(typeof o === 'object' && o ? `${o.host ?? o.path ?? '?'}:${o.port ?? ''}` : String(o));
    throw new Error('ipc-handlers.test.ts: a test opened a network socket');
  } as any);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    networkAttempts.push(`fetch ${String(input?.url ?? input)}`);
    throw new Error('ipc-handlers.test.ts: a test called fetch');
  });
});
afterAll(() => {
  expect(networkAttempts, 'a test in this file reached for the network').toEqual([]);
  expect(releaseChecks, 'the update check no longer goes through https.get: the stub above is not standing in for it').toBeGreaterThan(0);
});

// ── Shared setup ─────────────────────────────────────────────────────────────
// Wires the REAL registerIpcHandlers to fakes. Positional slots after the skill provider:
// p5 unused, p6 hookRelay, p7 remoteConfig, p8 remoteServer, p9 window registry, p10 sync lease, p12 welcomeBack store.
type Wire = {
  manager?: Record<string, unknown>; managerObj?: any; window?: any; skills?: any; hookRelay?: any; remoteConfig?: any;
  remoteServer?: any; registry?: any; lease?: any; welcomeBack?: any;
};
function wire(o: Wire = {}) {
  const ipc = { handle: vi.fn(), on: vi.fn() };
  const manager: any = o.managerObj ?? {
    createSession: vi.fn(), destroySession: vi.fn(() => true), listSessions: vi.fn(() => []), getSession: vi.fn(() => undefined),
    sendInput: vi.fn(), resizeSession: vi.fn(), on: vi.fn(), ...o.manager,
  };
  const window: any = o.window ?? { webContents: { send: vi.fn() }, isDestroyed: () => false };
  const skills = o.skills ?? {
    configStore: { getPackages: vi.fn(() => ({})) }, getInstalled: vi.fn(() => []), install: vi.fn(), installMany: vi.fn(),
    ensureBundledPluginsInstalled: vi.fn(), ensureMigrated: vi.fn(),
  };
  registerWithRuntime(registerIpcHandlers, ipc as any, manager, window, skills as any,
    undefined as any, o.hookRelay, o.remoteConfig, o.remoteServer, o.registry, o.lease, undefined, o.welcomeBack);
  const handler = (channel: string) => (ipc.handle as any).mock.calls.find((c: any) => c[0] === channel)[1];
  return { ipc, manager, window, handler, mockWindow: window, mockSessionManager: manager };
}
const setup = (manager: Record<string, unknown> = {}, welcomeBack?: unknown) => wire({ manager, welcomeBack });

const lease = (acquire: any = vi.fn(async () => ({ ok: true })), release: any = vi.fn(async () => {}), extra: object = {}) =>
  ({ client: { acquire, release }, setHolderTakeover: vi.fn(), requester: {}, syncEnabled: () => true, ...extra });
const resumeOpts = (id: string, extra: object = {}) => ({ name: 'Resume', cwd: '/tmp', skipPermissions: false, resumeSessionId: id, ...extra });
const E1 = { sender: { id: 1 } };
const exitHandlers = (manager: any) => manager.on.mock.calls.filter((c: any) => c[0] === 'session-exit').map((c: any) => c[1]);
const fakeWelcomeStore = () => ({
  ready: Promise.resolve(), track: vi.fn(), untrack: vi.fn(), remap: vi.fn(),
  offerIds: vi.fn(() => []), forget: vi.fn(), flush: vi.fn(async () => {}), startup: vi.fn(async () => {}),
});
// A live-tracking manager: createSession makes `info` live, getSession reports it.
function liveManager(info: any, extra: Record<string, unknown> = {}) {
  const state: { live?: any } = {};
  return { state, manager: { createSession: vi.fn(() => { state.live = info; return info; }), getSession: vi.fn(() => state.live), ...extra } };
}

// One HOME for a whole describe: registerIpcHandlers kicks off background init (ProviderRegistry.init writes
// ~/.youcoded) that no test awaits, so deleting the dir per test raced those writes into unhandled ENOENT.
// $HOME + USERPROFILE, never a homedir spy (native-home.ts imports `* as os`; Windows reads USERPROFILE).
function useTempHome(prefix: string, restoreMocks = true) {
  const s = { home: '', convRoot: '' };
  let prevHome: string | undefined; let prevProfile: string | undefined;
  beforeAll(() => {
    s.home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    prevHome = process.env.HOME; prevProfile = process.env.USERPROFILE;
    process.env.HOME = s.home; process.env.USERPROFILE = s.home;
  });
  afterAll(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
  });
  // A REAL conversation store (a fake would let a write-to-wrong-bucket regression pass), awaited so every call sees 'ready'.
  beforeEach(async () => {
    s.convRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}store-`));
    await startConversationStore({
      conversationsRoot: s.convRoot, projectsDir: path.join(s.home, '.claude', 'projects'),
      topicsDir: path.join(s.home, '.claude', 'topics'), device: 'test-device',
    });
  });
  afterEach(() => {
    stopConversationStore(); if (restoreMocks) vi.restoreAllMocks();
    try { fs.rmSync(s.convRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); } catch {}
  });
  return s;
}

describe('IPC Handlers', () => {
  it('registers session:create, session:destroy and session:list', () => {
    const { ipc } = wire();
    const registered = ipc.handle.mock.calls.map((c: any) => c[0]);
    for (const ch of ['session:create', 'session:destroy', 'session:list']) expect(registered).toContain(ch);
  });
});

describe('skills:uninstall bundled-plugin rejection', () => {
  const uninstallWith = (id: string, skills: object) => wire({ skills: { configStore: { getPackages: vi.fn(() => ({})) },
    install: vi.fn(), installMany: vi.fn(), ensureBundledPluginsInstalled: vi.fn(), ensureMigrated: vi.fn(), ...skills },
    manager: { broadcastReloadPlugins: vi.fn() } }).handler('skills:uninstall')({}, { id });

  it('rejects uninstall for bundled plugin IDs without calling skillProvider.uninstall', async () => {
    const uninstall = vi.fn();
    expect(await uninstallWith('wecoded-themes-plugin', { uninstall })).toEqual({ ok: false, error: 'bundled', type: 'plugin' });
    expect(uninstall).not.toHaveBeenCalled();
  });

  it('falls through to skillProvider.uninstall for non-bundled IDs', async () => {
    const uninstall = vi.fn().mockResolvedValue({ type: 'plugin' });
    await uninstallWith('some-other-plugin', { uninstall, resolveUninstallTarget: vi.fn().mockResolvedValue('some-other-plugin') });
    expect(uninstall).toHaveBeenCalledWith('some-other-plugin');
  });
});

describe('registered holder handoff', () => {
  it('pins until the captured CC PTY exit, despite session-exit removing its mapping', async () => {
    const { TranscriptWatcher } = await import('../src/main/transcript-watcher');
    const source = path.join(os.tmpdir(), 'observed', 'c1.jsonl');
    const watcher = vi.spyOn(TranscriptWatcher.prototype, 'pageSourceFor').mockReturnValue({ jsonlPath: source, subagentsDir: '', startOffset: 0, cwd: '/tmp' });
    try {
      const info = { id: 'desktop-c1', provider: 'claude', cwd: '/tmp', status: 'active' };
      let exitStop!: () => void;
      const stopPending = new Promise<void>((resolve) => { exitStop = resolve; });
      const { state, manager: lm } = liveManager(info);
      const manager: any = { ...lm, listSessions: vi.fn(() => state.live ? [state.live] : []), destroySession: vi.fn(() => true),
        on: vi.fn(), sendInput: vi.fn(() => true), resizeSession: vi.fn(),
        stopSessionForHandoff: vi.fn(async () => { await stopPending; state.live = undefined;
          for (const exit of exitHandlers(manager)) exit(info.id);
          return { status: 'stopped' as const };
        }) };
      const release = vi.fn(async () => {});
      const l = lease(vi.fn(async () => ({ ok: true })), release, { deviceId: 'sender' });
      const { handler } = wire({ managerObj: manager, lease: l });
      await handler('session:create')(E1, { name: 'Resume', cwd: '/tmp', skipPermissions: false, resumeSessionId: 'c1' });
      l.setHolderTakeover.mock.calls[0][0]('c1', { deviceId: 'requester', device: 'Other' }, '88e7c065-15db-43d5-8576-00d13b145c8a');
      await vi.waitFor(() => expect(manager.stopSessionForHandoff).toHaveBeenCalledWith(info.id));
      expect(release).not.toHaveBeenCalled();
      exitStop();
      await vi.waitFor(() => expect(release).toHaveBeenCalledWith('c1'));
      expect(manager.destroySession).not.toHaveBeenCalled();
    } finally { watcher.mockRestore(); }
  });
});

describe('session:create resumed admission', () => {
  it.each(['stops', 'fails'])('ordinary native exit %s before releasing or reopening', async (outcome) => {
    const { NativeSessionHost } = await import('../src/main/harness/native-session-host');
    let finish!: () => void;
    const stop = new Promise<void>((resolve, reject) => { finish = () => outcome === 'fails' ? reject(new Error('writer still appending')) : resolve(); });
    const destroy = vi.spyOn(NativeSessionHost.prototype, 'destroy').mockImplementation(() => stop);
    try {
      const info = { id: 'native-c1', provider: 'native', cwd: '/tmp', status: 'active' };
      const acquire = vi.fn(async () => ({ ok: true }));
      const release = vi.fn(async () => {});
      const { handler, manager } = wire({ manager: { createSession: vi.fn(() => ({ ...info, provider: 'claude' })) }, lease: lease(acquire, release) });
      // Register the identity through creation; the host teardown is a deferred native append-chain drain.
      const open = handler('session:create');
      await open(E1, resumeOpts(info.id));
      acquire.mockClear();
      [...exitHandlers(manager)].reverse()[0](info.id);
      const retry = open(E1, resumeOpts(info.id));
      expect(release).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      finish();
      if (outcome === 'fails') {
        await expect(retry).rejects.toThrow('previous writer could not be stopped');
        expect(release).not.toHaveBeenCalled();
      } else {
        await expect(retry).resolves.toMatchObject({ id: info.id });
        expect(release).toHaveBeenCalledBefore(acquire);
      }
    } finally { finish(); destroy.mockRestore(); }
  });

  it('releases a CC lease when its worker exits before creation settles', async () => {
    const info = { id: 'desktop-c1', provider: 'claude', cwd: '/tmp', status: 'active' };
    let live: any;
    const manager: any = { getSession: vi.fn(() => live), listSessions: vi.fn(() => []), destroySession: vi.fn(() => true),
      on: vi.fn(), sendInput: vi.fn(), resizeSession: vi.fn(),
      createSession: vi.fn(() => {
        live = info;
        queueMicrotask(() => { live = undefined; for (const exit of exitHandlers(manager)) exit(info.id); });
        return info;
      }) };
    const release = vi.fn(async () => {});
    const { handler } = wire({ managerObj: manager, lease: lease(undefined, release) });
    await expect(handler('session:create')(E1, resumeOpts('c1'))).rejects.toThrow('ended before startup completed');
    expect(release).toHaveBeenCalledWith('c1');
  });

  it.each(['exit', 'failed teardown'])('does not release a possible native writer on %s during startup', async (scenario) => {
    const { NativeSessionHost } = await import('../src/main/harness/native-session-host');
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const createNative = vi.spyOn(NativeSessionHost.prototype, 'create').mockImplementation(async () => { await gate; if (scenario === 'failed teardown') throw new Error('startup failed'); return undefined as never; });
    const destroyNative = vi.spyOn(NativeSessionHost.prototype, 'destroy').mockImplementation(async () => {
      if (scenario === 'failed teardown') throw new Error('teardown failed');
    });
    try {
      const info = { id: 'native-c1', provider: 'native', cwd: '/tmp', status: 'active' };
      const { state, manager: lm } = liveManager(info);
      const release = vi.fn(async () => {});
      const { handler, manager } = wire({ manager: { ...lm, destroySession: vi.fn(() => { state.live = undefined; return true; }) }, lease: lease(undefined, release) });
      const opening = handler('session:create')(E1, {
        provider: 'native', resumeSessionId: info.id, cwd: '/tmp', name: 'Resume', skipPermissions: false,
        binding: { providerId: 'test', modelId: 'test' },
      });
      await vi.waitFor(() => expect(createNative).toHaveBeenCalled());
      if (scenario === 'exit') {
        state.live = undefined;
        for (const exit of exitHandlers(manager)) exit(info.id);
      }
      finish();
      await expect(opening).rejects.toThrow(scenario === 'exit' ? 'ended before startup completed' : 'teardown failed');
      expect(destroyNative).toHaveBeenCalledWith(info.id);
      if (scenario === 'exit') expect(release).toHaveBeenCalledWith(info.id);
      else {
        expect(manager.destroySession).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
      }
    } finally { finish(); createNative.mockRestore(); destroyNative.mockRestore(); }
  });

  it('rejects a held lease before calling the real creation site', async () => {
    const acquire = vi.fn(async () => ({ ok: false, holder: { device: 'Other computer' } }));
    const release = vi.fn(async () => {});
    const { handler, manager } = wire({ lease: lease(acquire, release) });
    expect(await handler('session:create')(E1, resumeOpts('c1'))).toEqual({ status: 'lease-denied', device: 'Other computer' });
    expect(acquire).toHaveBeenCalledWith('c1');
    expect(manager.createSession).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('releases admission instead of starting after the requesting window closes', async () => {
    let closed = false;
    const release = vi.fn(async () => {});
    const { handler, manager } = wire({
      manager: { createSession: vi.fn(() => ({ id: 'live', provider: 'claude', cwd: '/tmp', status: 'active' })) },
      lease: lease(vi.fn(async () => { closed = true; return { ok: true }; }), release),
    });
    await expect(handler('session:create')({ sender: { id: 1, isDestroyed: () => closed } }, resumeOpts('c1'))).rejects.toThrow('window closed');
    expect(manager.createSession).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith('c1');
  });

  it.each([{ from: 1, kind: 'main' }, { from: 2, kind: 'main' }, { from: 3, kind: 'buddy' }])('focuses an existing writer from $kind window $from, but not a new buddy session', async ({ from, kind }) => {
    const { webContents } = await import('electron');
    const ownerContents = { send: vi.fn() };
    vi.mocked(webContents.fromId).mockReturnValue(ownerContents as any);
    const info = { id: 'c1', cwd: '/tmp', provider: 'claude', status: 'active' };
    const registry = { on: vi.fn(), assignSession: vi.fn(), getOwner: vi.fn(() => 1), getKind: vi.fn(() => kind), getLeaderId: vi.fn(() => 1) };
    const { handler, manager } = wire({ manager: liveManager(info).manager, registry });
    const create = handler('session:create');
    // First creation stores its identity before any hook or native await.
    expect(await create({ sender: { id: kind === 'buddy' ? from : 1 } }, resumeOpts('c1'))).toBe(info);
    expect(ownerContents.send).not.toHaveBeenCalled();
    expect(await create({ sender: { id: from } }, resumeOpts('c1'))).toMatchObject({ ...info, reused: true });
    expect(ownerContents.send).toHaveBeenCalledWith('session:focus-request', info.id);
    expect(manager.createSession).toHaveBeenCalledOnce();
    expect(registry.assignSession).toHaveBeenCalledOnce();
  });

  // A phone's reopen of a conversation the desktop already has open goes through the REAL RemoteServer into the
  // shared create path and its already-open check: answered `reused`, no second session.
  it('a phone reopening a conversation already open on the desktop gets that session, not a second one', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const info = { id: 'c3', cwd: '/tmp', provider: 'claude', status: 'active' };
    const { state, manager: lm } = liveManager(info);
    const manager = Object.assign(new EventEmitter(), { ...lm, listSessions: vi.fn(() => (state.live ? [state.live] : [])),
      destroySession: vi.fn(() => true), sendInput: vi.fn(), resizeSession: vi.fn() });
    const server: any = new RemoteServer(manager as any, Object.assign(new EventEmitter(), { respond: vi.fn(() => true) }) as any,
      { enabled: true, port: 9900, passwordHash: null, toSafeObject: () => ({}) } as any);
    const { handler } = wire({ managerObj: manager, remoteServer: server });
    expect(await handler('session:create')(E1, resumeOpts('c3'))).toBe(info);
    const sent: any[] = [];
    await server.handleMessage({ ws: { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) } },
      JSON.stringify({ type: 'session:create', id: 'p1', payload: { name: 'x', cwd: '/tmp', skipPermissions: false, resumeSessionId: 'c3' } }));
    expect(sent[0].payload).toMatchObject({ id: 'c3', reused: true });
    expect(manager.createSession).toHaveBeenCalledOnce();
  });

  // A session a phone opened has no owning window; a desktop reopen of it must still ask the primary window (only while
  // it lives) to select it. The leader window (id 7) never lists it and must not be raised.
  it.each([{ mainClosed: false }, { mainClosed: true }])('an ownerless reopened writer focuses the primary window only while it is open (closed: $mainClosed)', async ({ mainClosed }) => {
    const { webContents, BrowserWindow } = await import('electron');
    const leaderContents = { send: vi.fn() };
    vi.mocked(webContents.fromId).mockReset();
    vi.mocked(webContents.fromId).mockImplementation((id: number) => (id === 7 ? leaderContents : undefined) as any);
    const focus = vi.fn();
    (BrowserWindow as any).fromWebContents = vi.fn(() => ({ focus }));
    const info = { id: 'c2', cwd: '/tmp', provider: 'claude', status: 'active' };
    const registry = { on: vi.fn(), assignSession: vi.fn(), getOwner: vi.fn(() => undefined), getKind: vi.fn(() => 'main'), getLeaderId: vi.fn(() => 7) };
    const remoteServer = { broadcast: vi.fn(), setSessionMetaWiring: vi.fn(), setLastTopic: vi.fn(),
      getClientCount: vi.fn(() => 0), broadcastStatusData: vi.fn(), onStatusChange: vi.fn(() => () => {}) };
    const mainSend = vi.fn();
    const { handler, manager } = wire({ manager: liveManager(info).manager, registry, remoteServer,
      window: { webContents: { send: mainSend }, isDestroyed: () => mainClosed } });
    expect(await phoneCreate({ name: 'Resume', cwd: '/tmp', skipPermissions: false, resumeSessionId: 'c2' })).toBe(info);
    expect(registry.assignSession).not.toHaveBeenCalled();
    mainSend.mockClear();
    expect(await handler('session:create')(E1, resumeOpts('c2'))).toMatchObject({ ...info, reused: true });
    expect(mainSend.mock.calls.filter((c) => c[0] === 'session:focus-request')).toEqual(mainClosed ? [] : [['session:focus-request', 'c2']]);
    expect(leaderContents.send).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledTimes(mainClosed ? 0 : 1);
    expect(manager.createSession).toHaveBeenCalledOnce();
  });
});

describe('session:create native resume with no stored header, and No-folder start', () => {
  // A resumed native session whose saved data is gone and has no binding must reject and tear down, or the renderer is
  // left with a live SessionInfo backed by nothing (a silently empty chat).
  it('rejects and tears down a resumed id without a native harness, and untracks it from Welcome back', async () => {
    // createSession's real native branch uses resumeSessionId AS the id; this id was never persisted.
    const store = fakeWelcomeStore();
    const { handler, manager } = setup({
      getSession: undefined, // this test's manager never had one
      createSession: vi.fn(() => ({ id: 'ghost-native-1', name: 'Resuming…', cwd: '/tmp', status: 'active', provider: 'native' })),
    }, store);
    await expect(handler('session:create')(E1,
      { provider: 'native', resumeSessionId: 'ghost-native-1', cwd: '/tmp', name: 'Resuming…', skipPermissions: false },
    )).rejects.toThrow('saved data is missing');
    expect(manager.destroySession).toHaveBeenCalledWith('ghost-native-1');
    // A resume is tracked as "open" at creation; a failed one must be untracked or the next Welcome back re-offers a phantom.
    expect(store.track).toHaveBeenCalledWith('ghost-native-1', 'ghost-native-1', 'native', false);
    expect(store.untrack).toHaveBeenCalledWith('ghost-native-1');
  });

  // The phone door runs the SAME create as a window (admission included).
  it('a session a phone creates runs the same native start: the remote host is handed it', async () => {
    const remoteServer = { broadcast: vi.fn(), setSessionMetaWiring: vi.fn(), setLastTopic: vi.fn(),
      getClientCount: vi.fn(() => 0), broadcastStatusData: vi.fn(), onStatusChange: vi.fn(() => () => {}) };
    const { manager } = wire({ remoteServer,
      manager: { createSession: vi.fn(() => ({ id: 'ghost-native-2', name: 'Resuming…', cwd: '/tmp', status: 'active', provider: 'native' })) } });
    await expect(phoneCreate(
      { provider: 'native', resumeSessionId: 'ghost-native-2', cwd: '/tmp', name: 'Resuming…', skipPermissions: false },
    )).rejects.toThrow('saved data is missing');
    expect(manager.createSession).toHaveBeenCalledOnce();
    expect(manager.destroySession).toHaveBeenCalledWith('ghost-native-2');
  });

  // The shared create applies the swap, so a phone cannot skip it: "No folder" opens in the app-owned empty folder.
  it('a "No folder" conversation a phone starts opens in the app-owned empty folder', async () => {
    const { NO_FOLDER_CWD, NO_FOLDER_DIR_NAME } = await import('../src/shared/no-folder');
    const { manager } = wire({ manager: { createSession: vi.fn((o: any) => ({ id: 'nf-1', name: 'x', cwd: o.cwd, status: 'active', provider: 'claude' })) } });
    await phoneCreate({ name: 'x', cwd: NO_FOLDER_CWD, skipPermissions: false });
    const cwd = (manager.createSession as any).mock.calls[0][0].cwd;
    expect(cwd).not.toBe(NO_FOLDER_CWD);
    expect(cwd.endsWith(NO_FOLDER_DIR_NAME)).toBe(true);
  });
});

// tags:update/delete denormalize into the chatsearch snapshot (tag ids -> labels), so they must tell chatsearch to
// rebuild or the index serves the old/deleted label.
describe('tags:update / tags:delete signal chatsearch', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-tags-ipc-'));
    startTagRegistry({ tagsRoot: tmp }); // a real registry: the handlers short-circuit to {ok:false} without one
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); } catch { /* best-effort cleanup */ }
  });

  it.each([
    ['tags:update signals after a successful rename', 'tags:update', 'Old Label', (id: string) => ({ id, patch: { label: 'New Label' } }), true, 1],
    ['tags:delete signals after a successful delete', 'tags:delete', 'Doomed Tag', (id: string) => ({ id }), true, 1],
  ] as const)('%s', async (_n, channel, label, args, ok, calls) => {
    const spy = vi.spyOn(conversationsService, 'emitConversationMetaChanged');
    const { handler } = wire();
    const created = await handler('tags:create')({}, { label, color: 'tag-gray' });
    const result = await handler(channel)({}, args(created.tag.id));
    expect(result.ok).toBe(ok);
    expect(spy).toHaveBeenCalledTimes(calls);
    spy.mockRestore();
  });

  it('tags:update does not signal chatsearch when the registry rejects the update', async () => {
    const spy = vi.spyOn(conversationsService, 'emitConversationMetaChanged');
    const result = await wire().handler('tags:update')({}, { id: 'tag_does_not_exist', patch: { label: 'New Label' } });
    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// Security: transcript:read-meta once used startsWith(claudeProjects) with no trailing separator, so a SIBLING dir
// like ~/.claude/projects-evil leaked its contents.
describe('transcript:read-meta path containment', () => {
  let tmpHome: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-transcript-meta-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome); // the ~/.claude/projects root lives in the fixture
  });
  afterEach(() => {
    homedirSpy.mockRestore();
    try { fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); } catch { /* best-effort cleanup */ }
  });
  const readMeta = (dir: string, model: string) => {
    const d = path.join(tmpHome, '.claude', dir, ...(dir === 'projects' ? ['some-project'] : []));
    fs.mkdirSync(d, { recursive: true });
    const file = path.join(d, 'x.jsonl');
    fs.writeFileSync(file, JSON.stringify({ model }) + '\n');
    return wire().handler('transcript:read-meta')({}, { path: file });
  };

  it('rejects a transcript in a sibling dir like ~/.claude/projects-evil', async () => {
    expect(await readMeta('projects-evil', 'leaked-model')).toBeNull();
  });
  it('still reads a transcript inside ~/.claude/projects', async () => {
    expect((await readMeta('projects', 'test-model'))?.model).toBe('test-model');
  });
});

describe('dialog:open-file attachment picker filters', () => {
  // The paperclip picker must OPEN on ALL files on every platform: pass NO `filters` key. Any filter list defaults the
  // dialog to the first named category on Windows (electron#19492) and Linux (#43491); a lone '*' becomes '*.*',
  // which on Linux excludes extensionless files like Makefile.
  async function getDialogOptions(channel: string) {
    const { handler } = wire();
    const { dialog } = await import('electron');
    (dialog.showOpenDialog as any).mockResolvedValue({ canceled: true, filePaths: [] });
    await handler(channel)({});
    return (dialog.showOpenDialog as any).mock.calls.at(-1)[1];
  }

  it('passes NO filters key and requests an openFile + multiSelections dialog', async () => {
    const options = await getDialogOptions('dialog:open-file');
    expect('filters' in options).toBe(false);
    expect(options.properties).toEqual(['openFile', 'multiSelections']);
  });

  it('open-sound keeps its audio filter FIRST and wildcard last', async () => {
    const options = await getDialogOptions('dialog:open-sound');
    expect(options.filters.map((f: { name: string }) => f.name)[0]).toBe('Audio Files');
    expect(options.filters.at(-1)).toEqual({ name: 'All Files', extensions: ['*'] });
  });
});

// The 10 s status push: an unchanged payload is not re-sent, the tick idles while no window is visible and no phone is
// connected, and the first look afterwards (a focus, a phone connecting) pushes at once.
describe('status push: deduplicated, paused while nobody can see it, resumed on first look', () => {
  let usageJson: string | null;
  let readFile: ReturnType<typeof vi.spyOn>;
  let stat: ReturnType<typeof vi.spyOn>;
  let updateStatus: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // WHY pinned: the payload carries the shared update service's status; a real check landing mid-test changed the
    // payload between two ticks ("expected 2 to be 1" on a loaded machine).
    const { getUpdateService } = await import('../src/main/update-service');
    updateStatus = vi.spyOn(getUpdateService(), 'getUpdateStatus').mockReturnValue(
      { current: '0.0.0-test', latest: '0.0.0-test', update_available: false, download_url: null } as any,
    );
    usageJson = null;
    readFile = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (p: any) => {
      if (String(p).endsWith('.usage-cache.json') && usageJson != null) return usageJson;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    stat = vi.spyOn(fs.promises, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  });
  afterEach(() => {
    readFile.mockRestore(); stat.mockRestore(); updateStatus.mockRestore();
    vi.useRealTimers();
  });

  async function boot(opts: { clients?: () => number } = {}) {
    const win = { visible: true, webContents: { send: vi.fn() }, isDestroyed: () => false, isVisible() { return win.visible; }, isMinimized: () => false, on: vi.fn() };
    // A SET of listeners like the real server: the status push and the per-session summary push both listen.
    const statusListeners = new Set<(s: any) => void>();
    const remoteServer = opts.clients ? {
      getClientCount: opts.clients, broadcastStatusData: vi.fn(), broadcast: vi.fn(),
      onStatusChange: vi.fn((cb: (s: any) => void) => { statusListeners.add(cb); return () => { statusListeners.delete(cb); }; }),
      setSessionMetaWiring: vi.fn(), setLastTopic: vi.fn(),
    } : undefined;
    wire({ window: win, remoteServer });
    const { app } = await import('electron');
    const focus = (app.on as any).mock.calls.filter((c: any[]) => c[0] === 'browser-window-focus').at(-1)[1] as () => void;
    const sends = () => win.webContents.send.mock.calls.filter((c: any[]) => c[0] === 'status:data').length;
    const tick = () => vi.advanceTimersByTimeAsync(10_000);
    return { win, sends, tick, focus, phoneConnects: () => { for (const l of [...statusListeners]) l({ clientCount: 1 }); }, remoteServer };
  }

  it('sends a changed payload once and does not repeat an identical one', async () => {
    const { sends, tick } = await boot();
    await tick();
    expect(sends()).toBe(1);
    await tick();
    await tick();
    expect(sends()).toBe(1); // same files, same answer
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
    expect(sends()).toBe(2); // right away, not after the next tick
    focus();
    await vi.advanceTimersByTimeAsync(0);
    expect(sends()).toBe(2); // a focus with no missed tick behind it pushes nothing
  });

  it('remote:status over desktop IPC carries clientCount as a number, with or without a server', async () => {
    const { handler } = wire({ remoteConfig: { keepAwakeHours: 0, port: 9900, toSafeObject: () => ({}) } });
    expect(await handler('remote:status')({})).toMatchObject({ state: 'stopped', port: 0, clientCount: 0 });
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

// The split refusal messages of the native resume path, driven through the REAL handler and a REAL conversation store.
describe('session:create native resume refusals', () => {
  const t = useTempHome('yc-refusal-');
  const RESUME_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const nativeInfo = (cwd = '/tmp') => ({ id: RESUME_ID, name: 'Resuming…', cwd, status: 'active', provider: 'native' });
  const createNativeResume = (handler: any, cwd?: string, extra: object = {}) =>
    handler('session:create')(E1, { provider: 'native', resumeSessionId: RESUME_ID, cwd, name: 'Resuming…', skipPermissions: false, ...extra });
  // An existing but EMPTY transcript: it exists, yet gives no readable header.
  const emptyTranscript = () => {
    const folder = path.join(t.home, '.youcoded', 'sessions', nativeStoreSlug(t.home));
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `${RESUME_ID}.jsonl`);
    fs.writeFileSync(file, '');
    return file;
  };

  it("refuses with the 'hasn't synced' message when the folder resolves but its transcript is absent", async () => {
    const { handler } = setup({ createSession: vi.fn(() => nativeInfo()) });
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-refusal-proj-'));
    await getConversationStore()!.upsert({ provider: 'native', id: RESUME_ID, projectName: path.basename(projDir), originalPath: projDir });
    await expect(createNativeResume(handler, '/nonexistent-cwd')).rejects.toThrow(
      "This conversation hasn't synced to this device yet — its transcript isn't here.");
    fs.rmSync(projDir, { recursive: true, force: true });
  });

  it("refuses with the 'project folder isn't on this device' message when nothing resolves the record", async () => {
    const { handler } = setup({ createSession: vi.fn(() => nativeInfo()) });
    await getConversationStore()!.upsert({ provider: 'native', id: RESUME_ID, projectName: 'no-such-project-anywhere', originalPath: '/definitely/not/here' });
    await expect(createNativeResume(handler, '/nonexistent-cwd')).rejects.toThrow(
      "This conversation's project folder ('no-such-project-anywhere') isn't on this device.");
  });

  it('refuses an existing transcript without a readable header instead of returning an empty session', async () => {
    const file = emptyTranscript();
    const destroySession = vi.fn(() => true);
    const { handler } = setup({ createSession: vi.fn(() => nativeInfo(t.home)), destroySession });
    try {
      await expect(createNativeResume(handler, t.home)).rejects.toThrow('saved data could not be read');
      expect(destroySession).toHaveBeenCalledWith(RESUME_ID);
    } finally { fs.rmSync(file, { force: true }); }
  });

  // The fallback branch (no usable cwd, no record) once called create() whenever a binding was given, appending a SECOND
  // header to a file that exists but gave no readable header.
  it('the fallback branch refuses an existing unreadable transcript instead of writing a second header', async () => {
    const file = emptyTranscript();
    const { handler } = setup({ createSession: vi.fn(() => nativeInfo(t.home)) });
    try {
      await expect(createNativeResume(handler, '/nonexistent-cwd', { binding: { providerId: 'openrouter', modelId: 'm' } }))
        .rejects.toThrow('saved data could not be read');
      expect(fs.readFileSync(file, 'utf8')).toBe(''); // nothing appended
    } finally { fs.rmSync(file, { force: true }); }
  });

  it("refuses with the 'saved data is missing' message when there is no record and no binding", async () => {
    const { handler } = setup({ createSession: vi.fn(() => nativeInfo()) });
    await expect(createNativeResume(handler, '/nonexistent-cwd')).rejects.toThrow(
      'This conversation could not be resumed — its saved data is missing.');
  });
});

// A resumed Claude Code session's pill used to stay on the 'Resuming...' placeholder: it must get the stored title,
// else the conversation's opening words (what the Resume browser row shows).
describe('session:create Claude Code resume names the pill', () => {
  const t = useTempHome('yc-cc-title-', false);
  const CONV = '11111111-2222-3333-4444-555555555555';
  beforeEach(() => {
    const dir = path.join(t.home, '.claude', 'projects', ccProjectSlug(t.home));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${CONV}.jsonl`), JSON.stringify({
      type: 'user', promptId: 'p1', timestamp: '2026-09-24T12:00:00.000Z', sessionId: CONV,
      message: { role: 'user', content: 'what did we decide about the scroll bug' },
    }) + '\n');
  });

  it.each([
    ['puts the stored title on the pill', 'Scroll bug decision', true],
    ['with no stored title, uses the opening words the Resume browser row shows', 'what did we decide about the scroll bug', false],
  ])('%s', async (_n, expected, stored) => {
    if (stored) await getConversationStore()!.upsert({ provider: 'claude', id: CONV, projectName: path.basename(t.home), originalPath: t.home, title: expected });
    const { handler, mockWindow } = setup({
      createSession: vi.fn(() => ({ id: 'desktop-cc-1', name: 'Resuming...', cwd: t.home, status: 'active', provider: 'claude' })),
    });
    await handler('session:create')(E1, { provider: 'claude', resumeSessionId: CONV, cwd: t.home, name: 'Resuming...', skipPermissions: false });
    const renamed = () => (mockWindow.webContents.send.mock.calls as any[][])
      .filter((c) => c[0] === 'session:renamed' && c[1] === 'desktop-cc-1').map((c) => c[2]);
    await vi.waitFor(() => expect(renamed()).toEqual([expected]));
  });
});

// Native sessions are real Conversation Store records: write then read the SAME value back through BOTH
// session:get-meta AND session:browse, so a write that silently lands in the WRONG bucket cannot pass.
describe('native session meta through the real store', () => {
  const NATIVE_ID = '11111111-2222-3333-4444-555555555555';
  const CC_ID = '99999999-8888-7777-6666-555555555555';
  const t = useTempHome('yc-meta-parity-');
  // A persisted native session is a file at <home>/.youcoded/sessions/<slug>/<id>.jsonl (what SessionStore.has() scans).
  beforeEach(() => {
    const slugDir = path.join(t.home, '.youcoded', 'sessions', 'test-project');
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, `${NATIVE_ID}.jsonl`),
      JSON.stringify({ v: 1, sessionId: NATIVE_ID, harnessId: 'assistant', cwd: '/tmp/test-project', createdAt: Date.now() }) + '\n');
  });
  const call = (handler: (c: string) => any, channel: string, payload: object) => handler(channel)(E1, payload);

  it('tag → get-meta and browse both return it for a native session', async () => {
    const { handler } = setup();
    expect(await call(handler, 'session:set-tag', { sessionId: NATIVE_ID, tagId: 'tag_physics', value: true })).toEqual({ ok: true });
    expect(await call(handler, 'session:get-meta', { sessionId: NATIVE_ID })).toMatchObject({ tags: ['tag_physics'], note: '', supported: true });
    const row = (await handler('session:browse')()).find((r: any) => r.sessionId === NATIVE_ID);
    expect(row).toBeTruthy();
    expect(row.provider).toBe('native');
    expect(row.tags).toEqual(['tag_physics']);
  });

  it('note → get-meta returns it for a native session', async () => {
    const { handler } = setup();
    expect(await call(handler, 'session:set-note', { sessionId: NATIVE_ID, note: 'debugging the spinner regex' })).toEqual({ ok: true });
    expect(await call(handler, 'session:get-meta', { sessionId: NATIVE_ID })).toMatchObject({ note: 'debugging the spinner regex', supported: true });
  });

  it('a reserved flag round-trips for a native session (previously refused outright)', async () => {
    const { handler } = setup();
    expect(await call(handler, 'session:set-flag', { sessionId: NATIVE_ID, flag: 'priority', value: true })).toEqual({ ok: true });
    const row = (await handler('session:browse')()).find((r: any) => r.sessionId === NATIVE_ID);
    expect(row?.flags).toMatchObject({ priority: true });
  });

  it('broadcast fires only after the record is readable', async () => {
    const { handler, mockWindow } = setup();
    const recordPath = path.join(t.convRoot, 'native', `${NATIVE_ID}.json`);
    let sawTagAtBroadcastTime: boolean | null = null;
    (mockWindow.webContents.send as any).mockImplementation((channel: string) => {
      if (channel !== 'session:meta-changed') return;
      // The handler already AWAITED the write: read the file right here to prove the record landed BEFORE this broadcast
      // (else a listener could refetch and "confirm" a change not yet persisted — the 2026-07-19 incident shape).
      try { sawTagAtBroadcastTime = !!JSON.parse(fs.readFileSync(recordPath, 'utf8'))?.flags?.['tag:tag_physics']?.value; } catch { sawTagAtBroadcastTime = false; }
    });
    const res = await call(handler, 'session:set-tag', { sessionId: NATIVE_ID, tagId: 'tag_physics', value: true });
    expect(res.ok).toBe(true);
    expect(sawTagAtBroadcastTime).toBe(true);
  });

  // A native record can exist in the store WITHOUT a local sessions file (synced from a peer, transcript not yet here).
  // isNativeSessionId() is false for it, so it was once tagged 'claude' and SEEDED a claude/<id>.json phantom that
  // syncs out and shadows the real native record.
  describe('store-only native record routes meta to the native bucket', () => {
    const STORE_ONLY_ID = '22222222-3333-4444-5555-666666666666'; // a store record but NO ~/.youcoded/sessions file
    const seed = () => getConversationStore()!.upsert({ id: STORE_ONLY_ID, provider: 'native', lastActive: new Date().toISOString(),
      title: 'synced native session', transcriptRef: `native/transcripts/test-project/${STORE_ONLY_ID}.jsonl` });
    const rec = (bucket: string) => path.join(t.convRoot, bucket, `${STORE_ONLY_ID}.json`);

    it('set-tag writes native/, creates NO claude phantom, reads back, and survives phantom-prune', async () => {
      const { handler } = setup();
      await seed();
      expect(fs.existsSync(path.join(t.home, '.youcoded', 'sessions', 'test-project', `${STORE_ONLY_ID}.jsonl`))).toBe(false);
      expect(await call(handler, 'session:set-tag', { sessionId: STORE_ONLY_ID, tagId: 'tag_physics', value: true })).toEqual({ ok: true });
      expect(JSON.parse(fs.readFileSync(rec('native'), 'utf8')).flags['tag:tag_physics']?.value).toBe(true);
      expect(fs.existsSync(rec('claude'))).toBe(false);
      expect(await call(handler, 'session:get-meta', { sessionId: STORE_ONLY_ID })).toMatchObject({ tags: ['tag_physics'], supported: true });
      // pruneNativePhantomRecords only ever touches the claude bucket, so the correctly-routed record stays.
      expect(await pruneNativePhantomRecords({ nativeHomeRoot: t.home })).toBe(0);
      expect(JSON.parse(fs.readFileSync(rec('native'), 'utf8')).flags['tag:tag_physics']?.value).toBe(true);
    });

    it('set-note routes to the native bucket too', async () => {
      const { handler } = setup();
      await seed();
      expect(await call(handler, 'session:set-note', { sessionId: STORE_ONLY_ID, note: 'peer-synced note' })).toEqual({ ok: true });
      expect(JSON.parse(fs.readFileSync(rec('native'), 'utf8')).note).toBe('peer-synced note');
      expect(fs.existsSync(rec('claude'))).toBe(false);
    });
  });

  describe('Claude Code sessions are unaffected by the native unlock', () => {
    it('set-flag on a CC id still succeeds', async () => {
      expect((await call(setup().handler, 'session:set-flag', { sessionId: CC_ID, flag: 'complete', value: true })).ok).toBe(true);
    });

    // Its own test: get-meta on a CC id with NO prior write takes a path a preceding set-flag would change.
    it('get-meta on a CC id reports supported:true', async () => {
      expect((await call(setup().handler, 'session:get-meta', { sessionId: CC_ID })).supported).toBe(true);
    });

    // The phantom-record gate skips the store WRITE for a live CC session with no hook mapping yet, but the flag
    // re-applies when SessionStart lands the mapping — it must NOT surface as a failure the renderer reverts.
    it('set-flag on a LIVE CC session with no hook mapping yet still returns ok:true', async () => {
      const { handler } = setup({ getSession: vi.fn(() => ({ id: CC_ID, name: 'live', cwd: '/tmp', status: 'active' })) });
      const res = await call(handler, 'session:set-flag', { sessionId: CC_ID, flag: 'priority', value: true });
      expect(res.ok).toBe(true);
      expect(res.unsupported).toBeUndefined();
    });

    // A validation error, not a provider-derived path: a typo surfaces as a typo even on a native id.
    it('an unknown flag name is still rejected before any provider logic', async () => {
      const res = await call(setup().handler, 'session:set-flag', { sessionId: NATIVE_ID, flag: 'bogus', value: true });
      expect(res.ok).toBe(false);
      expect(res.unsupported).toBeUndefined();
      expect(res.error).toContain('bogus');
    });
  });
});

// Each Welcome back hook is pinned against a fake store (welcome-back-store.test.ts covers the store's own state
// machine): these only prove ipc-handlers.ts calls it at the right moments with the right ids.
describe('Welcome back tracking hooks', () => {
  const claudeManager = (id: string) => ({ createSession: vi.fn(() => ({ id, provider: 'claude', cwd: '/tmp', status: 'active' })) });

  it('a resumed session is tracked at creation (already has messages)', async () => {
    const store = fakeWelcomeStore();
    const { handler } = wire({ manager: claudeManager('desktop-r1'), welcomeBack: store });
    await handler('session:create')(E1, resumeOpts('conv-1'));
    expect(store.track).toHaveBeenCalledWith('desktop-r1', 'conv-1', 'claude', false);
  });

  it('SESSION_DESTROY untracks the session; destroySession alone (an ordinary exit) does not', async () => {
    const store = fakeWelcomeStore();
    const { handler, manager } = wire({ welcomeBack: store });
    // An ordinary exit calls sessionManager.destroySession directly and must NOT untrack: a crash or quit leaves it tracked.
    manager.destroySession('desktop-d1');
    expect(store.untrack).not.toHaveBeenCalled();
    await handler('session:destroy')({}, { sessionId: 'desktop-d1' }); // the user's own X
    expect(store.untrack).toHaveBeenCalledWith('desktop-d1');
  });

  // A phone's own X is the same explicit close: session:destroy is one table entry running the computer's teardown.
  it('a session a phone closes is untracked too, and one whose close fails is not', async () => {
    const store = fakeWelcomeStore();
    const { manager } = wire({ welcomeBack: store });
    const phone = { door: 'remote', runtime: null, broadcast: () => {} } as any;
    const destroy = (id: string) => findChannel('session:destroy')!.handler({ sessionId: id }, phone);
    expect(await destroy('desktop-p1')).toBe(true);
    expect(store.untrack).toHaveBeenCalledWith('desktop-p1');
    store.untrack.mockClear();
    (manager.destroySession as any).mockReturnValueOnce(false);
    expect(await destroy('desktop-p2')).toBe(false);
    expect(store.untrack).not.toHaveBeenCalled();
  });

  // The LAST 'hook-event' listener is the remap one (the first is a status-push trigger not under test).
  const lastHookEvent = (hookRelay: any) => (hookRelay.on as any).mock.calls.findLast((c: any) => c[0] === 'hook-event')![1] as any;

  it('the first user-message transcript event tracks a brand-new session, once', async () => {
    const { TranscriptWatcher } = await import('../src/main/transcript-watcher');
    const listeners: Record<string, Array<(...args: any[]) => void>> = {};
    const onSpy = vi.spyOn(TranscriptWatcher.prototype, 'on').mockImplementation(function (this: any, event: string | symbol, cb: any) {
      (listeners[event as string] ??= []).push(cb);
      return this;
    } as any); // WHY cast: a `this`-returning stub cannot satisfy the EventEmitter overload
    try {
      const hookRelay = { on: vi.fn(), start: vi.fn() };
      const store = fakeWelcomeStore();
      wire({ manager: claudeManager('desktop-c2'), hookRelay, welcomeBack: store });
      // A brand-new session gets its sessionIdMap entry from CC's SessionStart hook, not from creation.
      lastHookEvent(hookRelay)({ sessionId: 'desktop-c2', payload: { session_id: 'conv-2', hook_event_name: 'SessionStart', source: 'startup' } });
      expect(store.track).not.toHaveBeenCalled(); // mapped, but no message yet
      const emit = listeners['transcript-event']?.[0];
      expect(emit).toBeTypeOf('function');
      const event = { type: 'user-message', sessionId: 'desktop-c2', uuid: 'u1', timestamp: 1, data: { text: 'hi' } };
      emit!(event);
      emit!(event); // a second message must not re-track
      expect(store.track).toHaveBeenCalledTimes(1);
      expect(store.track).toHaveBeenCalledWith('desktop-c2', 'conv-2', 'claude', false);
    } finally { onSpy.mockRestore(); }
  });

  it("a SessionStart remap updates a tracked session's remembered conversation id", async () => {
    const hookRelay = { on: vi.fn(), start: vi.fn() };
    const store = fakeWelcomeStore();
    const { handler } = wire({ manager: claudeManager('desktop-c3'), hookRelay, welcomeBack: store });
    await handler('session:create')(E1, resumeOpts('conv-old'));
    store.remap.mockClear();
    // /clear rotation: SessionStart reports a NEW claude id for the same desktop session.
    lastHookEvent(hookRelay)({ sessionId: 'desktop-c3', payload: { session_id: 'conv-new', hook_event_name: 'SessionStart', source: 'clear' } });
    expect(store.remap).toHaveBeenCalledWith('desktop-c3', 'conv-new');
  });
});
