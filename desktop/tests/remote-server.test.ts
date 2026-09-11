import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock ws module — use require() inside vi.mock to avoid hoisting issues
vi.mock('ws', async () => {
  const { EventEmitter: EE } = await import('events');
  class MockWebSocketServer extends EE {
    clients = new Set();
    close = vi.fn((cb?: () => void) => cb?.());
    constructor(_opts?: any) { super(); }
  }
  const MockWebSocket: any = vi.fn();
  MockWebSocket.OPEN = 1;
  return { WebSocketServer: MockWebSocketServer, WebSocket: MockWebSocket };
});

// listenBehavior lets a test turn the next listen() into a bind failure
// (EADDRINUSE) instead of a success, so the start-failure path is exercised
// rather than assumed.
const listenBehavior: { mode: 'ok' | 'error'; calls: number; boundHost: string | null } =
  { mode: 'ok', calls: 0, boundHost: null };

// Remote access refuses to start without a private address to listen on, so every start()
// test needs one. Real detection shells out to the tailscale binary.
vi.mock('../src/main/remote-config', async () => {
  const actual = await vi.importActual<typeof import('../src/main/remote-config')>('../src/main/remote-config');
  return {
    ...actual,
    RemoteConfig: Object.assign(
      function RemoteConfigStub() { /* tests pass their own config object */ } as unknown as typeof actual.RemoteConfig,
      actual.RemoteConfig,
      {
        detectTailscale: vi.fn(async () => ({
          installed: true, connected: true, ip: '100.64.0.1',
          hostname: 'test-host', url: 'http://test-host:9900',
        })),
      },
    ),
  };
});

vi.mock('http', async () => {
  const { EventEmitter: EE } = await import('events');
  function createServer(_handler?: any) {
    const emitter: any = new EE();
    return Object.assign(emitter, {
      // Signature matches net.Server: (port, host?, cb?). The server now names a host —
      // the Tailscale address — so a mock that assumed (port, cb) would silently never
      // call back and every start() test would hang.
      listen: vi.fn((_port: number, hostOrCb?: string | (() => void), maybeCb?: () => void) => {
        const cb = typeof hostOrCb === 'function' ? hostOrCb : maybeCb;
        listenBehavior.boundHost = typeof hostOrCb === 'string' ? hostOrCb : null;
        listenBehavior.calls++;
        if (listenBehavior.mode === 'error') {
          const err: any = new Error('listen EADDRINUSE: address already in use :::9900');
          err.code = 'EADDRINUSE';
          // Real net.Server emits asynchronously; do the same so the promise
          // is already awaiting when the error lands.
          setImmediate(() => emitter.emit('error', err));
          return emitter;
        }
        cb?.();
        return emitter;
      }),
      close: vi.fn((cb?: () => void) => cb?.()),
    });
  }
  return { default: { createServer }, createServer };
});

// Task 5 M2 coverage — session:get-meta / set-tag / set-note route through
// conversations/service (the Conversation Store) and session:browse routes
// through session-browser's listPastSessions. Both are mocked so these tests
// exercise remote-server.ts's OWN resolve/canWrite/provider-derivation wiring
// (sessionMetaWiring, sessionProviderFor) rather than the real on-disk store
// or Claude project directories. Declared at module scope (not inside a
// describe) — vi.mock is hoisted above imports, and remote-server.ts loads
// these modules via dynamic `await import(...)` at case-handler time, well
// after this file's top-level `const` initializers have run — same pattern
// the 'http' mock above already relies on for `listenBehavior`.
const mockConversationsService = {
  getConversationStore: vi.fn<any>(),
  noteFlagChanged: vi.fn(async () => ({ ok: true })),
  noteSessionNote: vi.fn(async () => ({ ok: true })),
  emitConversationMetaChanged: vi.fn(),
};
vi.mock('../src/main/conversations/service', () => mockConversationsService);

const mockSessionBrowser = {
  listPastSessions: vi.fn(async () => [] as any[]),
  loadHistory: vi.fn(async () => ({ events: [] })),
};
// Spread the REAL module first so remote-server's SAFE_ID_RE import is the
// actual guard regex (not a test copy that could drift), then override just
// the two functions these tests stub.
vi.mock('../src/main/session-browser', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  ...mockSessionBrowser,
}));

/**
 * Drive the restore sequence for a bare socket, the way the old-client fallback or a
 * `client:ready` would: a restoring client record around the socket, then restoreClient.
 * (Batch 2 replaced `replayBuffers(ws)` + its 500 ms timer with this.)
 */
async function restore(server: any, ws: any) {
  const client = { id: 'test', ws, deviceId: 'd', ip: '', connectedAt: 0, phase: 'restoring', queue: [] };
  await server.restoreClient(client, { reconnect: false, replayBuffers: true });
}

describe('RemoteServer', () => {
  let mockSessionManager: any;
  let mockHookRelay: any;
  let mockConfig: any;

  beforeEach(() => {
    vi.clearAllMocks();
    listenBehavior.mode = 'ok';
    listenBehavior.calls = 0;
    mockSessionManager = Object.assign(new EventEmitter(), {
      listSessions: vi.fn(() => []),
      createSession: vi.fn(() => ({ id: '1', name: 'test', cwd: '/tmp', status: 'active' })),
      destroySession: vi.fn(() => true),
      sendInput: vi.fn(),
      resizeSession: vi.fn(),
    });
    mockHookRelay = Object.assign(new EventEmitter(), {
      respond: vi.fn(() => true),
    });
    mockConfig = {
      enabled: true,
      port: 9900,
      passwordHash: '$2b$10$fakehash',
      verifyPassword: vi.fn(async (pw: string) => pw === 'correct'),
    };
  });

  it('can be instantiated', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    expect(server).toBeDefined();
  });

  it('starts and stops without error', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    await server.start();
    server.stop();
  });

  it('does not start when config.enabled is false', async () => {
    mockConfig.enabled = false;
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    await server.start();
    // Should not throw, just no-op
    server.stop();
  });
});

// A remote client is a browser on the network. Before the shell provider
// existed, the worst a hostile `session:create` payload could reach was Claude
// Code's own TUI, which asks before it acts; a shell asks nothing.
describe('RemoteServer and the shell provider', () => {
  let shellSessionManager: any;
  let shellHookRelay: any;
  let shellConfig: any;

  beforeEach(() => {
    vi.clearAllMocks();
    listenBehavior.mode = 'ok';
    shellSessionManager = Object.assign(new EventEmitter(), {
      listSessions: vi.fn(() => []),
      createSession: vi.fn(() => ({ id: '1', name: 'fish', cwd: '/tmp', status: 'active' })),
      destroySession: vi.fn(() => true),
      sendInput: vi.fn(),
      resizeSession: vi.fn(),
    });
    shellHookRelay = Object.assign(new EventEmitter(), { respond: vi.fn(() => true) });
    shellConfig = { enabled: true, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
  });

  /** Drive handleMessage directly with a fake authenticated client. */
  function drive(server: any, msg: any) {
    const sent: any[] = [];
    const ws: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    return server.handleMessage({ ws }, JSON.stringify(msg)).then(() => sent);
  }

  it('refuses session:create for a shell, which would be a bare shell on the host', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(shellSessionManager, shellHookRelay, shellConfig);
    const sent = await drive(server, {
      type: 'session:create', id: 'c1',
      payload: { name: 'x', cwd: '/', skipPermissions: false, provider: 'shell' },
    });
    expect(shellSessionManager.createSession).not.toHaveBeenCalled();
    expect(sent[0].payload.ok).toBe(false);
    expect(sent[0].payload.error).toMatch(/only be opened from the app itself/);
  });

  it('still creates an ordinary session', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(shellSessionManager, shellHookRelay, shellConfig);
    await drive(server, { type: 'session:create', id: 'c2', payload: { name: 'x', cwd: '/tmp', skipPermissions: false } });
    expect(shellSessionManager.createSession).toHaveBeenCalledTimes(1);
  });

  it('refuses a run-in-terminal command carrying a carriage return', async () => {
    // The whole property: the app does not APPEND a carriage return, but a `\r`
    // already inside the string is the same keypress — measured on real bash,
    // zsh and fish, this runs both halves with nobody at the keyboard.
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(shellSessionManager, shellHookRelay, shellConfig);
    const sent = await drive(server, {
      type: 'engine:run-in-terminal', id: 'r1', payload: { command: 'echo a\recho b' },
    });
    expect(shellSessionManager.createSession).not.toHaveBeenCalled();
    expect(sent[0].payload.ok).toBe(false);
    expect(sent[0].payload.error).toMatch(/carriage return/);
  });

  it('accepts an ordinary install command, semicolon and all', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(shellSessionManager, shellHookRelay, shellConfig);
    const sent = await drive(server, {
      type: 'engine:run-in-terminal', id: 'r2', payload: { command: 'sudo pacman -S rocm; echo done' },
    });
    expect(shellSessionManager.createSession).toHaveBeenCalledTimes(1);
    const opts = shellSessionManager.createSession.mock.calls[0][0];
    expect(opts.provider).toBe('shell');
    expect(opts.initialCommand).toBe('sudo pacman -S rocm; echo done');
    expect(sent[0].payload).toEqual({ sessionId: '1' });
  });
});

// A remote client's save has to arrive at main as the SAME patch it sent.
// Two ways it silently did not, both of which look like a working save on
// screen: passing the whole envelope instead of `payload.patch`, and dropping
// the argument. Main then changes nothing, returns the settings unchanged, and
// the dialog renders that as success — the user toggles "Keep loaded" on,
// reopens the dialog, and it is off again with no error anywhere.
describe('RemoteServer carries a per-model settings save end to end', () => {
  let sm: any; let hr: any; let cfg: any;

  beforeEach(() => {
    vi.clearAllMocks();
    listenBehavior.mode = 'ok';
    sm = Object.assign(new EventEmitter(), {
      listSessions: vi.fn(() => []), createSession: vi.fn(), destroySession: vi.fn(),
      sendInput: vi.fn(), resizeSession: vi.fn(),
    });
    hr = Object.assign(new EventEmitter(), { respond: vi.fn(() => true) });
    cfg = { enabled: true, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
  });

  function drive(server: any, msg: any) {
    const sent: any[] = [];
    const ws: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    return server.handleMessage({ ws }, JSON.stringify(msg)).then(() => sent);
  }

  /** Only the three members these cases touch. */
  function fakeRuntime(engineManager: any, modelManager: any = {}) {
    return { nativeHost: {}, providerRegistry: {}, modelCatalog: {}, engineManager, modelManager,
      searchKeyStore: {}, searchService: {}, permissionStore: {}, specialistCatalog: {} } as any;
  }

  it('passes the patch itself, not the message envelope', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(sm, hr, cfg);
    const setModelSettings = vi.fn(async () => ({ contextLength: null, keepLoaded: true, gpuLayers: 'auto', extraFlags: '', memoryWarningDismissed: null }));
    server.setNativeRuntime(fakeRuntime({ setModelSettings }));

    const sent = await drive(server, {
      type: 'models:set-settings', id: 's1',
      payload: { modelId: 'alpha', patch: { keepLoaded: true } },
    });

    expect(setModelSettings).toHaveBeenCalledWith('alpha', { keepLoaded: true });
    expect(sent[0].payload).toMatchObject({ keepLoaded: true });
  });

  it('reads one model\u2019s settings by id and hands back the stored record', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(sm, hr, cfg);
    const modelSettings = vi.fn(() => ({
      contextLength: 8_192, keepLoaded: false, gpuLayers: 'auto', extraFlags: '',
      memoryWarningDismissed: null, pendingApply: true, lastLoadError: 'out of device memory',
    }));
    server.setNativeRuntime(fakeRuntime({ modelSettings }));

    const sent = await drive(server, { type: 'models:settings', id: 's2', payload: { modelId: 'alpha' } });

    expect(modelSettings).toHaveBeenCalledWith('alpha');
    // The two fields T23's dialog draws must survive the remote hop too.
    expect(sent[0].payload).toMatchObject({ pendingApply: true, lastLoadError: 'out of device memory' });
  });

  it('answers a REFUSED save as a failure, which the shim re-throws', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(sm, hr, cfg);
    server.setNativeRuntime(fakeRuntime({
      setModelSettings: vi.fn(async () => { throw new Error('Context length must be at least 1024 tokens.'); }),
    }));

    const sent = await drive(server, {
      type: 'models:set-settings', id: 's3', payload: { modelId: 'alpha', patch: { contextLength: 512 } },
    });

    expect(sent[0].payload).toEqual({ ok: false, error: 'Context length must be at least 1024 tokens.' });
  });

  it('answers nothing, not a made-up settings record, when there is no engine', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(sm, hr, cfg);
    // No native runtime. A fabricated record here would put invented defaults in
    // the settings dialog and let the user "save" them onto a machine with no
    // engine config to save to.
    const sent = await drive(server, { type: 'models:settings', id: 's5', payload: { modelId: 'alpha' } });
    expect(sent[0].payload).toBeNull();

    const saved = await drive(server, {
      type: 'models:set-settings', id: 's6', payload: { modelId: 'alpha', patch: { keepLoaded: true } },
    });
    expect(saved[0].payload).toBeNull();
  });

  it('does not report a download that never started when there is no engine', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(sm, hr, cfg);
    // No native runtime at all — the state a remote client hits before the
    // engine stack is wired. `{ downloadId: '' }` here would be a fake success:
    // the row would show a download that never begins and never ends.
    const sent = await drive(server, { type: 'models:add-vision', id: 's4', payload: { modelId: 'alpha' } });
    expect(sent[0].payload).toBeNull();
  });
});

describe('RemoteServer auth flow', () => {
  it('can be created with null password (rejects connections at auth time)', async () => {
    const mockSessionManager = Object.assign(new EventEmitter(), {
      listSessions: vi.fn(() => []),
      createSession: vi.fn(),
      destroySession: vi.fn(),
      sendInput: vi.fn(),
      resizeSession: vi.fn(),
    });
    const mockHookRelay = Object.assign(new EventEmitter(), {
      respond: vi.fn(() => true),
    });
    const config = {
      enabled: true,
      port: 9900,
      passwordHash: null,
      verifyPassword: vi.fn(async () => false),
    };
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, config);
    expect(server).toBeDefined();
    // Can start even with no password — connections will be rejected at auth handshake
    await server.start();
    server.stop();
  });
});

// Runtime start/stop. Before this, start() ran exactly once at boot, so
// re-entrancy, bind failures and restart-after-stop were all unreachable
// states. The Settings toggle now drives start()/stop() at runtime and reaches
// every one of them.
describe('RemoteServer runtime start/stop', () => {
  let mockSessionManager: any;
  let mockHookRelay: any;
  let mockConfig: any;

  beforeEach(() => {
    vi.clearAllMocks();
    listenBehavior.mode = 'ok';
    listenBehavior.calls = 0;
    mockSessionManager = Object.assign(new EventEmitter(), {
      listSessions: vi.fn(() => []),
      createSession: vi.fn(),
      destroySession: vi.fn(),
      sendInput: vi.fn(),
      resizeSession: vi.fn(),
    });
    mockHookRelay = Object.assign(new EventEmitter(), { respond: vi.fn(() => true) });
    mockConfig = {
      enabled: true,
      port: 9900,
      passwordHash: '$2b$10$fakehash',
      verifyPassword: vi.fn(async () => false),
    };
  });

  it('reports isRunning across the start/stop cycle', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    expect(server.isRunning()).toBe(false);
    await server.start();
    expect(server.isRunning()).toBe(true);
    server.stop();
    expect(server.isRunning()).toBe(false);
  });

  it('is idempotent — a second start() does not listen or re-subscribe', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    await server.start();
    const listensAfterFirst = listenBehavior.calls;
    const ptyListeners = mockSessionManager.listenerCount('pty-output');

    await server.start();

    expect(listenBehavior.calls).toBe(listensAfterFirst);
    // Double-subscribing would duplicate every broadcast to remote clients.
    expect(mockSessionManager.listenerCount('pty-output')).toBe(ptyListeners);
    server.stop();
  });

  it('can be restarted after stop()', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    await server.start();
    server.stop();
    await server.start();
    expect(server.isRunning()).toBe(true);
    expect(listenBehavior.calls).toBe(2);
    server.stop();
  });

  it('rejects with the real OS error when the port is taken', async () => {
    // The old code passed no error handler at all: the promise never settled
    // and the 'error' event went unhandled. A toggle awaiting that would hang
    // forever with no feedback.
    listenBehavior.mode = 'error';
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);

    await expect(server.start()).rejects.toThrow(/EADDRINUSE/);
    expect(server.isRunning()).toBe(false);
  });

  it('stops meaning stopped, even after a start that failed', async () => {
    // The reason was cleared only by a successful listen, and stop() skipped its own
    // status emit whenever the reason was set. So one failed start left the panel reading
    // "Not running: <that reason>" for the rest of the process — including after the user
    // had switched remote access off, which is a state the server was genuinely in.
    listenBehavior.mode = 'error';
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);

    await expect(server.start()).rejects.toThrow(/EADDRINUSE/);
    expect(server.getStatus().state).toBe('failed');

    const seen: string[] = [];
    server.onStatusChange(st => seen.push(st.state));
    server.stop();

    expect(server.getStatus().state).toBe('stopped');
    expect(server.getStatus().reason).toBeUndefined();
    // And the panel is told, rather than being left on the stale answer until it reopens.
    expect(seen).toContain('stopped');
  });

  it('leaves no subscriptions behind after a failed start', async () => {
    listenBehavior.mode = 'error';
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);

    await expect(server.start()).rejects.toThrow();

    // A failed start that left listeners attached would double-subscribe on the
    // user's next attempt to toggle remote access back on.
    expect(mockSessionManager.listenerCount('pty-output')).toBe(0);
    expect(mockSessionManager.listenerCount('session-exit')).toBe(0);
    expect(mockHookRelay.listenerCount('hook-event')).toBe(0);
    // Batch 2 (T2 review, 7): the relay-expiry listener is subscribed with the others.
    expect(mockHookRelay.listenerCount('permission-expired')).toBe(0);
  });

  it('does not start when config.enabled is false', async () => {
    mockConfig.enabled = false;
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    await server.start();
    expect(server.isRunning()).toBe(false);
    expect(listenBehavior.calls).toBe(0);
  });
});

// The message switch had no default case, so any channel the server doesn't
// implement was silently dropped. The shim (remote-shim.ts invoke()) registers
// a pending promise with a 30s timer, so an unimplemented channel presented as
// a 30-second hang and then a rejection naming nothing — which is why remote
// Project View and the game lobby looked "broken" rather than unimplemented.
describe('RemoteServer unhandled channels', () => {
  let mockSessionManager: any;
  let mockHookRelay: any;
  let mockConfig: any;

  beforeEach(() => {
    mockSessionManager = new EventEmitter();
    Object.assign(mockSessionManager, { listSessions: vi.fn(() => []) });
    mockHookRelay = new EventEmitter();
    mockConfig = { enabled: true, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
  });

  /** Drive handleMessage directly with a fake authenticated client and collect
   *  everything the server writes back. */
  function sendAndCollect(server: any, msg: any) {
    const sent: any[] = [];
    const ws: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    return server.handleMessage({ ws }, JSON.stringify(msg)).then(() => sent);
  }

  it('answers remote:status over the socket a browser actually uses', async () => {
    // This channel reached preload, the shim, the desktop IPC handlers and Android, and
    // not this host. The shim rejects on `unsupported`, and the panel asks for status in
    // the same Promise.all as the config, the Tailscale info and the device list — so the
    // whole Remote Access screen opened blank on a phone, and every reconnect re-asked.
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const sent = await sendAndCollect(server, { type: 'remote:status', id: 'req-status', payload: {} });
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.unsupported).toBeUndefined();
    expect(sent[0].payload.state).toBe('stopped');
    expect(sent[0].payload.port).toBe(9900);
  });

  it('answers about this device\u2019s requests and nobody else\u2019s', async () => {
    // Request ids carry the device that made them. Without the check, any paired device
    // could ask the host whether another device's action had run.
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    server.noteCompleted('phone-a:1:7');
    server.noteCompleted('phone-b:1:9');

    const sent: any[] = [];
    const ws: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    await server.handleMessage({ ws, deviceId: 'phone-a' }, JSON.stringify({
      type: 'remote:request-outcome', id: 'req-o', payload: { ids: ['phone-a:1:7', 'phone-b:1:9'] },
    }));

    expect(sent[0].payload.outcomes['phone-a:1:7']).toBe('completed');
    // Not a lie — the host genuinely will not say. Unknown is what a client shows as
    // "we could not tell", which is the honest answer to a question that isn't its own.
    expect(sent[0].payload.outcomes['phone-b:1:9']).toBe('unknown');
  });

  it('answers an unknown channel instead of dropping it', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const sent = await sendAndCollect(server, { type: 'definitely:not-a-real-channel', id: 'req-1', payload: {} });
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('definitely:not-a-real-channel:response');
    expect(sent[0].id).toBe('req-1');
    expect(sent[0].payload.ok).toBe(false);
    expect(sent[0].payload.unsupported).toBe(true);
  });

  it('names the channel in the error so the gap is diagnosable', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const sent = await sendAndCollect(server, { type: 'social:list-friends', id: 'req-2', payload: {} });
    expect(sent[0].payload.error).toContain('social:list-friends');
  });

  it('stays silent for fire-and-forget messages that carry no id', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const sent = await sendAndCollect(server, { type: 'some:notification', payload: {} });
    expect(sent).toHaveLength(0);
  });

  // Regression: useAttentionClassifier polls the unbridged
  // `terminal:get-screen-text` once a second, so an unconditional warn logged a
  // line per second for the life of the connection. That drowned the log and,
  // because a write to a closed stdout throws EPIPE, helped crash the main
  // process outright on 2026-07-20.
  it('warns once per unhandled channel, not once per request', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      for (let i = 0; i < 5; i++) {
        await sendAndCollect(server, { type: 'terminal:get-screen-text', id: `poll-${i}`, payload: {} });
      }
      expect(warn).toHaveBeenCalledTimes(1);

      // A DIFFERENT channel still warns — dedup must not silence new gaps.
      await sendAndCollect(server, { type: 'social:list-friends', id: 'other', payload: {} });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  // Dedup must not change the protocol: every poll still gets its own answer,
  // or the shim's pending promise leaks and we are back to 30-second hangs.
  it('still responds to every request even when it stops warning', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      for (let i = 0; i < 3; i++) {
        const sent = await sendAndCollect(server, { type: 'terminal:get-screen-text', id: `poll-${i}`, payload: {} });
        expect(sent).toHaveLength(1);
        expect(sent[0].id).toBe(`poll-${i}`);
        expect(sent[0].payload.unsupported).toBe(true);
      }
    } finally {
      warn.mockRestore();
    }
  });
});

// Task 5 review finding: session:get-meta / set-tag / set-note / browse had
// ZERO test coverage even though M2 extended all four — get-meta now resolves
// the id through sessionMetaWiring and derives provider via
// nativeHost.isNativeSessionId; set-tag/set-note gate the write via
// sessionMetaWiring.canWrite and only answer once the service write settles;
// browse feeds nativeHost.list() into listPastSessions. None of that had a
// single pinning test before this suite.
describe('RemoteServer session meta + browse (Task 5 M2 wiring)', () => {
  let mockSessionManager: any;
  let mockHookRelay: any;
  let mockConfig: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConversationsService.getConversationStore.mockReset().mockReturnValue(null);
    mockConversationsService.noteFlagChanged.mockReset().mockResolvedValue({ ok: true });
    mockConversationsService.noteSessionNote.mockReset().mockResolvedValue({ ok: true });
    mockConversationsService.emitConversationMetaChanged.mockReset();
    mockSessionBrowser.listPastSessions.mockReset().mockResolvedValue([]);
    mockSessionBrowser.loadHistory.mockReset().mockResolvedValue({ events: [] });

    mockSessionManager = new EventEmitter();
    Object.assign(mockSessionManager, { listSessions: vi.fn(() => []) });
    mockHookRelay = new EventEmitter();
    mockConfig = { enabled: true, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
  });

  function sendAndCollect(server: any, msg: any) {
    const sent: any[] = [];
    const ws: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    return server.handleMessage({ ws }, JSON.stringify(msg)).then(() => sent);
  }

  /** Minimal native runtime stub — only isNativeSessionId/list matter for these
   *  cases; the rest of the setNativeRuntime shape is asserted by other tests
   *  (native:* / provider:* suites), not this one. */
  function fakeNativeRuntime(nativeIds: Set<string>, listEntries: any[] = []) {
    return {
      nativeHost: {
        isNativeSessionId: (id: string) => nativeIds.has(id),
        list: () => listEntries,
      },
    } as any;
  }

  describe('session:get-meta', () => {
    it('resolves a native id through sessionMetaWiring and reads the store with provider "native"', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setNativeRuntime(fakeNativeRuntime(new Set(['native-1'])));
      server.setSessionMetaWiring({
        resolve: (id: string) => (id === 'desktop-1' ? 'native-1' : id),
        canWrite: () => true,
      });
      const storeGet = vi.fn(async (_provider: string, _id: string) => ({
        flags: { 'tag:tag_a': { value: true, updatedAt: 'x' } },
        note: 'hi',
      }));
      mockConversationsService.getConversationStore.mockReturnValue({ get: storeGet });

      const sent = await sendAndCollect(server, {
        type: 'session:get-meta', id: 'r1', payload: { sessionId: 'desktop-1' },
      });

      // The wiring's resolve() output — not the raw payload id — is what must
      // reach the store, on the 'native' bucket derived from isNativeSessionId.
      expect(storeGet).toHaveBeenCalledWith('native', 'native-1');
      expect(sent[0].payload).toEqual({ tags: ['tag_a'], note: 'hi', supported: true });
    });

    it('resolves a non-native id and reads the store with provider "claude"', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setNativeRuntime(fakeNativeRuntime(new Set())); // nothing is native
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => true });
      const storeGet = vi.fn(async () => null);
      mockConversationsService.getConversationStore.mockReturnValue({ get: storeGet });

      await sendAndCollect(server, {
        type: 'session:get-meta', id: 'r2', payload: { sessionId: 'cc-session-abc' },
      });

      expect(storeGet).toHaveBeenCalledWith('claude', 'cc-session-abc');
    });

    // C1: a store-only native id — NOT live/on-disk (isNativeSessionId false),
    // but a native record exists in the store (synced from a peer, transcript
    // not materialized here). sessionProviderFor must probe the native bucket
    // and resolve 'native' rather than defaulting to 'claude' (which would read
    // — and, on the write path, seed — the wrong bucket). Mirrors ipc-handlers.
    it('resolves a store-only native id (not live/on-disk) to the "native" bucket by probing the store', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setNativeRuntime(fakeNativeRuntime(new Set())); // nothing is live/on-disk native
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => true });
      // A native record exists in the store for this id; the claude bucket is empty.
      const storeGet = vi.fn(async (provider: string) =>
        provider === 'native'
          ? { flags: { 'tag:tag_n': { value: true, updatedAt: 'x' } }, note: 'from peer' }
          : null,
      );
      mockConversationsService.getConversationStore.mockReturnValue({ get: storeGet });

      const sent = await sendAndCollect(server, {
        type: 'session:get-meta', id: 'r-native', payload: { sessionId: 'store-only-native' },
      });

      // The probe hit the native bucket, and the meta read used 'native' too.
      expect(storeGet).toHaveBeenCalledWith('native', 'store-only-native');
      expect(storeGet).not.toHaveBeenCalledWith('claude', 'store-only-native');
      expect(sent[0].payload).toEqual({ tags: ['tag_n'], note: 'from peer', supported: true });
    });

    it('falls back to an empty-but-supported result when no Conversation Store is up', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      mockConversationsService.getConversationStore.mockReturnValue(null);

      const sent = await sendAndCollect(server, {
        type: 'session:get-meta', id: 'r3', payload: { sessionId: 'x' },
      });

      expect(sent[0].payload).toEqual({ tags: [], note: '', supported: true });
    });
  });

  describe('session:set-tag', () => {
    const msg = (overrides: any = {}) => ({
      type: 'session:set-tag', id: 'st', payload: { sessionId: 'desktop-1', tagId: 'tag_abc', value: true, ...overrides },
    });

    it('rejects a malformed tag id without ever calling the store write', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);

      const sent = await sendAndCollect(server, msg({ tagId: 'not-a-tag' }));

      expect(sent[0].payload).toEqual({ ok: false, error: 'invalid tag id' });
      expect(mockConversationsService.noteFlagChanged).not.toHaveBeenCalled();
    });

    // This is the phantom-record gate (ipc-handlers.ts canWriteStoreRecord),
    // mirrored here via sessionMetaWiring.canWrite. A refusal means "don't
    // seed a mis-provider'd record for a live session whose id mapping hasn't
    // landed yet" — the write is skipped, NOT an error: the same gate's
    // ipcMain twin (SESSION_SET_TAG) unconditionally returns `{ok:true}` after
    // the gated block regardless of whether canWrite passed, and the code
    // comment there says the flag simply re-applies once the mapping lands.
    // So this pins "skip the write" — not "answer ok:false" — as the correct,
    // parity-preserving shape.
    it('skips the write but still answers ok:true when canWrite refuses (mirrors ipc-handlers SESSION_SET_TAG parity)', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => false });

      const sent = await sendAndCollect(server, msg());

      expect(mockConversationsService.noteFlagChanged).not.toHaveBeenCalled();
      expect(sent[0].payload).toEqual({ ok: true });
    });

    it('answers ok:true once the service write resolves ok', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => true });
      mockConversationsService.noteFlagChanged.mockResolvedValue({ ok: true });

      const sent = await sendAndCollect(server, msg());

      expect(mockConversationsService.noteFlagChanged).toHaveBeenCalledTimes(1);
      expect(sent[0].payload).toEqual({ ok: true });
    });

    // Task 5 gap (final review): this remote mirror of ipc-handlers.ts's
    // SESSION_SET_TAG never called emitConversationMetaChanged, so a tag
    // applied from a phone/browser stayed invisible to the chatsearch index
    // until an unrelated refresh happened to pick it up.
    it('signals chatsearch that a tag changed once the write succeeds', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => true });
      mockConversationsService.noteFlagChanged.mockResolvedValue({ ok: true });

      await sendAndCollect(server, msg());

      expect(mockConversationsService.emitConversationMetaChanged).toHaveBeenCalledTimes(1);
    });

    // The emit must never fire on a failed write — an early-return failure
    // path must not tell chatsearch anything changed.
    it('does not signal chatsearch when the write fails', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => true });
      mockConversationsService.noteFlagChanged.mockResolvedValue({ ok: false });

      await sendAndCollect(server, msg());

      expect(mockConversationsService.emitConversationMetaChanged).not.toHaveBeenCalled();
    });

    // Honesty invariant (Item 6): a write that actually reports failure must
    // not be smoothed over into ok:true the way the old fire-and-forget did.
    it('honesty invariant: a service write resolving ok:false produces an ok:false response', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => true });
      mockConversationsService.noteFlagChanged.mockResolvedValue({ ok: false });

      const sent = await sendAndCollect(server, msg());

      expect(sent[0].payload.ok).toBe(false);
    });

    // C1: the write passes the SYNCHRONOUS isNativeSessionId(resolved) result
    // (a boolean) — not a resolved provider string — to noteFlagChanged, which
    // defers the store's native-bucket probe to flush time (boot-window
    // correctness). A live/on-disk native id → true.
    it('derives the write provider via nativeHost.isNativeSessionId on the RESOLVED id', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setNativeRuntime(fakeNativeRuntime(new Set(['native-1'])));
      server.setSessionMetaWiring({ resolve: () => 'native-1', canWrite: () => true });

      await sendAndCollect(server, msg({ sessionId: 'desktop-1' }));

      expect(mockConversationsService.noteFlagChanged).toHaveBeenCalledWith('native-1', 'tag:tag_abc', true, true);
    });

    // conversations/service's real noteFlagChanged (metaWrite) always catches
    // internally and resolves {ok:false} rather than rejecting — so this can't
    // happen through the real contract. It documents what happens to THIS
    // case block if that contract were ever violated: there's no local
    // try/catch around the await here (unlike ipcMain's SESSION_SET_TAG,
    // which wraps the whole handler), so a rejection propagates out of
    // handleMessage uncaught rather than answering the request. Not treated
    // as a bug to fix — flagged in the fix report for visibility instead,
    // since changing it would be a behavior change outside this task's scope.
    it('propagates a rejected write instead of answering the request (documents current behavior — see comment)', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => true });
      mockConversationsService.noteFlagChanged.mockRejectedValue(new Error('store exploded'));

      await expect(sendAndCollect(server, msg())).rejects.toThrow('store exploded');
    });

    it('broadcasts session:meta-changed after a successful write (parity with ipcMain SESSION_SET_TAG)', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setNativeRuntime(fakeNativeRuntime(new Set()));
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => true });
      const bSpy = vi.spyOn(server, 'broadcast');

      await sendAndCollect(server, msg());

      // Same frame shape the ipcMain path sends (ipc-handlers SESSION_SET_TAG):
      // a second remote client viewing this session must refetch its meta.
      expect(bSpy).toHaveBeenCalledWith({
        type: 'session:meta-changed',
        payload: { sessionId: 'desktop-1', flag: 'tag:tag_abc', value: true },
      });
    });
  });

  describe('session:set-note', () => {
    const msg = (overrides: any = {}) => ({
      type: 'session:set-note', id: 'sn', payload: { sessionId: 'desktop-1', note: 'hello', ...overrides },
    });

    it('rejects a note over 8000 characters without ever calling the store write', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);

      const sent = await sendAndCollect(server, msg({ note: 'x'.repeat(8001) }));

      expect(sent[0].payload).toEqual({ ok: false, error: 'note too long' });
      expect(mockConversationsService.noteSessionNote).not.toHaveBeenCalled();
    });

    it('skips the write but still answers ok:true when canWrite refuses (same gate shape as set-tag)', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => false });

      const sent = await sendAndCollect(server, msg());

      expect(mockConversationsService.noteSessionNote).not.toHaveBeenCalled();
      expect(sent[0].payload).toEqual({ ok: true });
    });

    it('answers ok:true once the service write resolves ok', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => true });
      mockConversationsService.noteSessionNote.mockResolvedValue({ ok: true });

      const sent = await sendAndCollect(server, msg());

      expect(mockConversationsService.noteSessionNote).toHaveBeenCalledTimes(1);
      expect(sent[0].payload).toEqual({ ok: true });
    });

    // Task 5 gap (final review): this remote mirror of ipc-handlers.ts's
    // SESSION_SET_NOTE never called emitConversationMetaChanged, so a note
    // written from a phone/browser stayed invisible to the chatsearch index
    // until an unrelated refresh happened to pick it up.
    it('signals chatsearch that a note changed once the write succeeds', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => true });
      mockConversationsService.noteSessionNote.mockResolvedValue({ ok: true });

      await sendAndCollect(server, msg());

      expect(mockConversationsService.emitConversationMetaChanged).toHaveBeenCalledTimes(1);
    });

    it('honesty invariant: a service write resolving ok:false produces an ok:false response', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => true });
      mockConversationsService.noteSessionNote.mockResolvedValue({ ok: false });

      const sent = await sendAndCollect(server, msg());

      expect(sent[0].payload.ok).toBe(false);
    });

    // The emit must never fire on a failed write.
    it('does not signal chatsearch when the note write fails', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => true });
      mockConversationsService.noteSessionNote.mockResolvedValue({ ok: false });

      await sendAndCollect(server, msg());

      expect(mockConversationsService.emitConversationMetaChanged).not.toHaveBeenCalled();
    });

    it('derives the write provider via nativeHost.isNativeSessionId on the RESOLVED id', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setNativeRuntime(fakeNativeRuntime(new Set(['native-1'])));
      server.setSessionMetaWiring({ resolve: () => 'native-1', canWrite: () => true });

      await sendAndCollect(server, msg({ sessionId: 'desktop-1', note: 'note text' }));

      // C1: passes the boolean isNativeSessionId result, not a provider string.
      expect(mockConversationsService.noteSessionNote).toHaveBeenCalledWith('native-1', 'note text', true);
    });

    it('broadcasts session:meta-changed after a successful write (parity with ipcMain SESSION_SET_NOTE)', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setNativeRuntime(fakeNativeRuntime(new Set()));
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => true });
      const bSpy = vi.spyOn(server, 'broadcast');

      await sendAndCollect(server, msg());

      expect(bSpy).toHaveBeenCalledWith({
        type: 'session:meta-changed',
        payload: { sessionId: 'desktop-1', note: 'hello' },
      });
    });
  });

  describe('session:browse', () => {
    it('passes nativeHost.list() entries into listPastSessions alongside the live session ids', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      mockSessionManager.listSessions = vi.fn(() => [{ id: 'live-1' }]);
      const nativeEntries = [{ id: 'native-9', provider: 'native' as const, slug: 'foo' }];
      server.setNativeRuntime(fakeNativeRuntime(new Set(), nativeEntries));
      const pastRows = [{ id: 'past-1' }];
      mockSessionBrowser.listPastSessions.mockResolvedValue(pastRows);

      const sent = await sendAndCollect(server, { type: 'session:browse', id: 'b1', payload: {} });

      expect(mockSessionBrowser.listPastSessions).toHaveBeenCalledTimes(1);
      const [activeIdsArg, nativeEntriesArg] = mockSessionBrowser.listPastSessions.mock.calls[0];
      expect(activeIdsArg).toBeInstanceOf(Set);
      expect(activeIdsArg.has('live-1')).toBe(true);
      expect(nativeEntriesArg).toBe(nativeEntries); // same reference — the list() result flows straight through
      expect(sent[0].payload).toEqual(pastRows); // round-tripped through JSON via ws.send — deep, not reference, equality
    });

    it('passes undefined native entries when no native runtime is wired (pre-M2 / not-yet-wired parity)', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);

      await sendAndCollect(server, { type: 'session:browse', id: 'b2', payload: {} });

      const [, nativeEntriesArg] = mockSessionBrowser.listPastSessions.mock.calls[0];
      expect(nativeEntriesArg).toBeUndefined();
    });
  });
});

// The game lobby renders its sign-in screen off account:signed-in. With no
// handler the call hung, so signedIn stayed at its useState(false) default and
// a remote browser showed "signed out" while the host app was signed in.
describe('RemoteServer account bridge', () => {
  let mockSessionManager: any;
  let mockHookRelay: any;
  let mockConfig: any;

  beforeEach(() => {
    mockSessionManager = new EventEmitter();
    Object.assign(mockSessionManager, { listSessions: vi.fn(() => []) });
    mockHookRelay = new EventEmitter();
    mockConfig = { enabled: true, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
  });

  function sendAndCollect(server: any, msg: any) {
    const sent: any[] = [];
    const ws: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    return server.handleMessage({ ws }, JSON.stringify(msg)).then(() => sent);
  }

  it('reports the host signed-in state', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    server.setAccountStore({ getToken: () => 'tok', getUser: () => ({ login: 'destin' }) });
    const sent = await sendAndCollect(server, { type: 'account:signed-in', id: 'a1', payload: {} });
    expect(sent[0].payload).toBe(true);
  });

  it('returns the cached profile', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    server.setAccountStore({ getToken: () => 'tok', getUser: () => ({ login: 'destin' }) });
    const sent = await sendAndCollect(server, { type: 'account:user', id: 'a2', payload: {} });
    expect(sent[0].payload.login).toBe('destin');
  });

  // Must not hang or throw when main.ts hasn't injected the store yet.
  it('reports signed-out when no store is injected', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const sent = await sendAndCollect(server, { type: 'account:signed-in', id: 'a3', payload: {} });
    expect(sent[0].payload).toBe(false);
  });

  // Status data is polled every 10s in ipc-handlers, so without this replay a client
  // that connects between ticks renders a blank status bar for up to 10 seconds.
  // RemoteServer previously stored only `contextMap` here and never read it back.
  describe('status:data replay on connect', () => {
    function fakeWs() {
      const frames: any[] = [];
      return { frames, ws: { readyState: 1, send: (raw: string) => frames.push(JSON.parse(raw)) } as any };
    }

    it('replays the whole last status payload to a connecting client', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      const { frames, ws } = fakeWs();

      server.broadcastStatusData({ contextMap: { s1: 42 }, gitBranchMap: { s1: 'main' }, usage: { x: 1 } });
      await restore(server, ws);

      const status = frames.filter((m) => m.type === 'status:data');
      expect(status).toHaveLength(1);
      // Not just the context slice — every field the poll carries.
      expect(status[0].payload.contextMap).toEqual({ s1: 42 });
      expect(status[0].payload.gitBranchMap).toEqual({ s1: 'main' });
      expect(status[0].payload.usage).toEqual({ x: 1 });
    });

    it('sends no status frame when no poll has happened yet', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      const { frames, ws } = fakeWs();

      await restore(server, ws);

      expect(frames.some((m) => m.type === 'status:data')).toBe(false);
    });
  });
});

// Task 9 (plan 1c) — the phone client hydrates over this WebSocket, never
// through TRANSCRIPT_REPLAY, so it needs its own connect-time catch-up for
// (a) a specialist's run status and (b) an open native permission ask. Both
// mirror the pre-existing hookBuffers/replayBuffers late-join mechanism.
describe('RemoteServer specialist run + native hook replay (Task 9)', () => {
  let mockSessionManager: any;
  let mockHookRelay: any;
  let mockConfig: any;

  beforeEach(() => {
    mockSessionManager = new EventEmitter();
    Object.assign(mockSessionManager, { listSessions: vi.fn(() => []) });
    mockHookRelay = new EventEmitter();
    mockConfig = { enabled: true, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
  });

  function fakeWs() {
    const frames: any[] = [];
    return { frames, ws: { readyState: 1, send: (raw: string) => frames.push(JSON.parse(raw)) } as any };
  }

  // The restore replays PTY/hook/run buffers in the same pass as the hydrate
  // (batch 2 removed the 500 ms guess — the phone says when it is ready).
  async function replayAndWait(server: any, ws: any) {
    await restore(server, ws);
  }

  it('a new client receives the latest specialists:event {kind:"run"} per child, not an append-only log', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const { frames, ws } = fakeWs();

    // Same child, two statuses — only the LATEST should replay (a card shows
    // one current status, not a history of every intermediate one).
    server.bufferSpecialistRun({ kind: 'run', sessionId: 's1', run: { childId: 'c1', status: 'running', title: 'Nadia' } });
    server.bufferSpecialistRun({ kind: 'run', sessionId: 's1', run: { childId: 'c1', status: 'completed', title: 'Nadia' } });
    // A second, different child — must ALSO replay (per-child, not per-session).
    server.bufferSpecialistRun({ kind: 'run', sessionId: 's1', run: { childId: 'c2', status: 'running', title: 'Otis' } });

    await replayAndWait(server, ws);

    const runEvents = frames.filter((m) => m.type === 'specialists:event');
    expect(runEvents).toHaveLength(2);
    const byChild = Object.fromEntries(runEvents.map((e) => [e.payload.run.childId, e.payload.run.status]));
    expect(byChild).toEqual({ c1: 'completed', c2: 'running' });
  });

  it('G-1: a new client receives the latest native:shell-event per shell id, and a destroyed session drops its buffer', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const { frames, ws } = fakeWs();
    server.bufferShellRun({ sessionId: 's1', run: { toolUseId: 't1', shellId: 'sh-1', status: 'running', startedAt: 1, tail: 'a', logPath: '/l' } });
    server.bufferShellRun({ sessionId: 's1', run: { toolUseId: 't1', shellId: 'sh-1', status: 'exited', exitCode: 0, startedAt: 1, endedAt: 2, tail: 'ab', logPath: '/l' } });
    server.bufferShellRun({ sessionId: 's1', run: { toolUseId: 't2', shellId: 'sh-2', status: 'running', startedAt: 1, tail: '', logPath: '/m' } });
    await replayAndWait(server, ws);
    const events = frames.filter((m) => m.type === 'native:shell-event');
    expect(events).toHaveLength(2);
    expect(Object.fromEntries(events.map((e) => [e.payload.run.shellId, e.payload.run.status]))).toEqual({ 'sh-1': 'exited', 'sh-2': 'running' });
    server.onSessionExit('s1');
    const { frames: again, ws: ws2 } = fakeWs();
    await replayAndWait(server, ws2);
    expect(again.filter((m) => m.type === 'native:shell-event')).toHaveLength(0);
  });

  it('G-1: native:kill-shell over WS answers with the host result, and not-live without a runtime', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const { frames, ws } = fakeWs();
    await server.handleMessage({ ws, authenticated: true }, JSON.stringify({ type: 'native:kill-shell', id: 'r1', payload: { sessionId: 's1', shellId: 'sh-1' } }));
    expect(frames.find((m) => m.id === 'r1')?.payload).toEqual({ ok: false, reason: 'not-live' });
    server.setNativeRuntime({ nativeHost: { killShell: vi.fn(async () => ({ ok: true })) } });
    await server.handleMessage({ ws, authenticated: true }, JSON.stringify({ type: 'native:kill-shell', id: 'r2', payload: { sessionId: 's1', shellId: 'sh-1' } }));
    expect(frames.find((m) => m.id === 'r2')?.payload).toEqual({ ok: true });
  });

  it('a reconnecting client receives a held ask\'s PermissionRequest and its PermissionHeld, in that order', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const { frames, ws } = fakeWs();

    // Simulates the ipc-handlers.ts nativeHost.on('hook-event', ...) call
    // site: native asks reach remote clients via a direct broadcast(), never
    // through this class's own onHookEvent (that's wired only to the legacy
    // hookRelay) — bufferHookEvent is the fix, called from that same site.
    server.bufferHookEvent({ sessionId: 's1', type: 'PermissionRequest', payload: { _requestId: 'native-x' }, timestamp: Date.now() });
    server.bufferHookEvent({ sessionId: 's1', type: 'PermissionHeld', payload: { _requestId: 'native-x' }, timestamp: Date.now() });

    await replayAndWait(server, ws);

    const held = frames.filter((m) => m.type === 'hook:event' && m.payload.payload?._requestId === 'native-x');
    expect(held).toHaveLength(2);
    expect(held[0].payload.type).toBe('PermissionRequest');
    expect(held[1].payload.type).toBe('PermissionHeld');
  });

  // Fix pass (2026-08-16 review finding, "the catch-up replays asks that were
  // already answered"): PermissionBroker now emits PermissionResolved from
  // its one removal chokepoint (permission-broker.ts) whenever an entry
  // leaves `pending` — respond() in time, respond() late, or a cancel.
  // bufferHookEvent() must treat that as a purge signal instead of just
  // another event to append, or a reconnecting phone still gets replayed a
  // dead question with live-looking Yes/No buttons.
  it('a reconnecting client is NOT replayed an ask that was already answered', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const { frames, ws } = fakeWs();

    // Simulates the full lifecycle: the ask goes out, then gets answered
    // BEFORE anyone reconnects — mirrors respond() emitting PermissionRequest
    // then (on answer) PermissionResolved, same order permission-broker.ts
    // produces.
    server.bufferHookEvent({ sessionId: 's1', type: 'PermissionRequest', payload: { _requestId: 'native-answered' }, timestamp: Date.now() });
    server.bufferHookEvent({ sessionId: 's1', type: 'PermissionResolved', payload: { _requestId: 'native-answered' }, timestamp: Date.now() });

    await replayAndWait(server, ws);

    const stale = frames.filter((m) => m.type === 'hook:event' && m.payload.payload?._requestId === 'native-answered');
    expect(stale).toHaveLength(0);
  });

  it('purges only the matching request id, leaving a different open ask in the same session alone', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const { frames, ws } = fakeWs();

    server.bufferHookEvent({ sessionId: 's1', type: 'PermissionRequest', payload: { _requestId: 'native-answered' }, timestamp: Date.now() });
    server.bufferHookEvent({ sessionId: 's1', type: 'PermissionResolved', payload: { _requestId: 'native-answered' }, timestamp: Date.now() });
    // A second, still-open ask in the SAME session — must survive the purge.
    server.bufferHookEvent({ sessionId: 's1', type: 'PermissionRequest', payload: { _requestId: 'native-open' }, timestamp: Date.now() });

    await replayAndWait(server, ws);

    const answered = frames.filter((m) => m.type === 'hook:event' && m.payload.payload?._requestId === 'native-answered');
    const open = frames.filter((m) => m.type === 'hook:event' && m.payload.payload?._requestId === 'native-open');
    expect(answered).toHaveLength(0);
    expect(open).toHaveLength(1);
    expect(open[0].payload.type).toBe('PermissionRequest');
  });

  it('PermissionResolved itself is never replayed — it is a purge signal, not a card', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const { frames, ws } = fakeWs();

    server.bufferHookEvent({ sessionId: 's1', type: 'PermissionRequest', payload: { _requestId: 'native-answered' }, timestamp: Date.now() });
    server.bufferHookEvent({ sessionId: 's1', type: 'PermissionResolved', payload: { _requestId: 'native-answered' }, timestamp: Date.now() });

    await replayAndWait(server, ws);

    expect(frames.some((m) => m.type === 'hook:event' && m.payload.type === 'PermissionResolved')).toBe(false);
  });
});

// Security regression: the transcript:read-meta WS handler validated the
// caller-supplied path with startsWith(claudeProjects) and NO trailing path
// separator, so a SIBLING directory like ~/.claude/projects-evil/x.jsonl
// passed the containment check and its contents leaked to remote clients.
// The model:read-last case a few lines below already used the correct
// `claudeProjects + path.sep` prefix — these tests pin transcript:read-meta
// to the same rule.
describe('RemoteServer transcript:read-meta path containment', () => {
  let mockSessionManager: any;
  let mockHookRelay: any;
  let mockConfig: any;
  let tmpHome: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockSessionManager = new EventEmitter();
    Object.assign(mockSessionManager, { listSessions: vi.fn(() => []) });
    mockHookRelay = new EventEmitter();
    mockConfig = { enabled: true, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-rs-transcript-'));
    // Point os.homedir() at the tmp dir so the handler's ~/.claude/projects
    // containment root lives inside the fixture, not the real home.
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  });

  /** Drive handleMessage directly with a fake authenticated client and collect
   *  everything the server writes back. */
  function sendAndCollect(server: any, msg: any) {
    const sent: any[] = [];
    const ws: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    return server.handleMessage({ ws }, JSON.stringify(msg)).then(() => sent);
  }

  it('rejects a transcript in a sibling dir like ~/.claude/projects-evil', async () => {
    const evilDir = path.join(tmpHome, '.claude', 'projects-evil');
    fs.mkdirSync(evilDir, { recursive: true });
    const evilFile = path.join(evilDir, 'x.jsonl');
    fs.writeFileSync(evilFile, JSON.stringify({ model: 'leaked-model' }) + '\n');

    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const sent = await sendAndCollect(server, { type: 'transcript:read-meta', id: 'req-evil', payload: { path: evilFile } });

    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toBeNull();
  });

  it('still reads a transcript inside ~/.claude/projects', async () => {
    const okDir = path.join(tmpHome, '.claude', 'projects', 'some-project');
    fs.mkdirSync(okDir, { recursive: true });
    const okFile = path.join(okDir, 'x.jsonl');
    fs.writeFileSync(okFile, JSON.stringify({ model: 'test-model' }) + '\n');

    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const sent = await sendAndCollect(server, { type: 'transcript:read-meta', id: 'req-ok', payload: { path: okFile } });

    expect(sent).toHaveLength(1);
    expect(sent[0].payload?.model).toBe('test-model');
  });
});

// Hardening regression (PR #294 adversarial review, nit A): transcript:read-meta
// computed path.resolve(payload.path || payload) OUTSIDE its try block with no
// type check, so a single malformed frame (non-string path) threw out of
// handleMessage as an unhandled rejection and the request never got a response.
// These tests pin the hardened shape: malformed payloads answer null, exactly
// like the neighboring model:read-last case. If the handler regresses, the
// sendAndCollect promise rejects and the await below fails the test.
describe('RemoteServer transcript:read-meta malformed payloads', () => {
  let mockSessionManager: any;
  let mockHookRelay: any;
  let mockConfig: any;

  beforeEach(() => {
    mockSessionManager = new EventEmitter();
    Object.assign(mockSessionManager, { listSessions: vi.fn(() => []) });
    mockHookRelay = new EventEmitter();
    mockConfig = { enabled: true, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
  });

  /** Drive handleMessage directly with a fake authenticated client and collect
   *  everything the server writes back. */
  function sendAndCollect(server: any, msg: any) {
    const sent: any[] = [];
    const ws: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    return server.handleMessage({ ws }, JSON.stringify(msg)).then(() => sent);
  }

  it('responds null to a non-string path instead of throwing', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const sent = await sendAndCollect(server, { type: 'transcript:read-meta', id: 'req-bad-path', payload: { path: { evil: 1 } } });

    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toBeNull();
  });

  it('responds null to a bare object payload with no path key', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const sent = await sendAndCollect(server, { type: 'transcript:read-meta', id: 'req-bare-obj', payload: {} });

    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toBeNull();
  });

  it('responds null to a null payload', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const sent = await sendAndCollect(server, { type: 'transcript:read-meta', id: 'req-null', payload: null });

    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toBeNull();
  });
});

// Hardening regression (PR #294 adversarial review, nit B): session:history
// probed ~/.claude/projects/<slug>/<id>.jsonl with fs.access using the
// client-supplied sessionId BEFORE any validation — loadHistory's SAFE_ID_RE
// guard only ran after the probe, so a traversal-shaped id ('../../x') turned
// the probe loop into a file-existence oracle for arbitrary *.jsonl paths.
// These tests pin that invalid ids are rejected with the same guard, and the
// same empty-array shape, loadHistory uses — without touching the filesystem.
describe('RemoteServer session:history id validation', () => {
  let mockSessionManager: any;
  let mockHookRelay: any;
  let mockConfig: any;
  let tmpHome: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;
  let accessSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockSessionManager = new EventEmitter();
    Object.assign(mockSessionManager, { listSessions: vi.fn(() => []) });
    mockHookRelay = new EventEmitter();
    mockConfig = { enabled: true, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-rs-history-'));
    // Point os.homedir() at the tmp dir so the handler's ~/.claude/projects
    // probe root lives inside the fixture, not the real home. A slug dir must
    // exist, otherwise the handler's readdir returns [] and the probe loop
    // never runs — which would make the invalid-id tests pass vacuously.
    fs.mkdirSync(path.join(tmpHome, '.claude', 'projects', 'my-project'), { recursive: true });
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    // Call-through spy: the valid-id test still needs real fs.access for the
    // slug probe; the invalid-id tests assert it was never reached.
    accessSpy = vi.spyOn(fs.promises, 'access');
    mockSessionBrowser.loadHistory.mockClear();
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    accessSpy.mockRestore();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  });

  /** Drive handleMessage directly with a fake authenticated client and collect
   *  everything the server writes back. */
  function sendAndCollect(server: any, msg: any) {
    const sent: any[] = [];
    const ws: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    return server.handleMessage({ ws }, JSON.stringify(msg)).then(() => sent);
  }

  it('rejects a traversal-shaped sessionId without probing the filesystem', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const sent = await sendAndCollect(server, { type: 'session:history', id: 'h1', payload: { sessionId: '../../../etc/passwd', count: 10 } });

    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toEqual([]);
    expect(accessSpy).not.toHaveBeenCalled();
    expect(mockSessionBrowser.loadHistory).not.toHaveBeenCalled();
  });

  it('rejects a slash-containing sessionId without probing the filesystem', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const sent = await sendAndCollect(server, { type: 'session:history', id: 'h2', payload: { sessionId: 'foo/bar', count: 10 } });

    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toEqual([]);
    expect(accessSpy).not.toHaveBeenCalled();
  });

  it('rejects a missing sessionId (SAFE_ID_RE alone would pass the string "undefined")', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const sent = await sendAndCollect(server, { type: 'session:history', id: 'h3', payload: { count: 10 } });

    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toEqual([]);
    expect(accessSpy).not.toHaveBeenCalled();
  });

  it('still loads history for a well-formed id', async () => {
    const slugDir = path.join(tmpHome, '.claude', 'projects', 'my-project');
    fs.writeFileSync(path.join(slugDir, 'abc-123.jsonl'), '');

    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const sent = await sendAndCollect(server, { type: 'session:history', id: 'h4', payload: { sessionId: 'abc-123', count: 5 } });

    expect(mockSessionBrowser.loadHistory).toHaveBeenCalledWith('abc-123', 'my-project', 5, undefined);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toEqual({ events: [] });
  });
});

// Perf regression (2026-09-01 investigation, "PTY replay buffer: a 4 MB string
// copy on every chunk, client or no client"). The rolling PTY buffer used to be
// ONE string per session: `buf += data` then `buf.slice(...)`, so once a busy
// session filled the 4 MB cap every further chunk re-allocated and copied ~4 MB —
// unconditionally, because the remote server is always on. It is now an array of
// chunks joined only at connect time. These tests pin the two things that must NOT
// change (the replayed tail, and the live broadcast) alongside the new bounds.
describe('RemoteServer replay buffers stay bounded and replay the same tail', () => {
  // Mirrors the module constants; they are not exported, and hard-coding them here
  // means a change to either one shows up as a failing test rather than silently
  // re-scaling the assertions.
  const PTY_CAP = 4 * 1024 * 1024;
  const HOOK_CAP = 10_000;

  let mockSessionManager: any;
  let mockHookRelay: any;
  let mockConfig: any;

  beforeEach(() => {
    mockSessionManager = Object.assign(new EventEmitter(), { listSessions: vi.fn(() => []) });
    mockHookRelay = new EventEmitter();
    mockConfig = { enabled: true, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
  });

  function fakeWs() {
    const frames: any[] = [];
    return { frames, ws: { readyState: 1, send: (raw: string) => frames.push(JSON.parse(raw)) } as any };
  }

  // Same restore the Task 9 suite above drives.
  async function replayAndWait(server: any, ws: any) {
    await restore(server, ws);
  }

  async function newServer() {
    const { RemoteServer } = await import('../src/main/remote-server');
    return new RemoteServer(mockSessionManager, mockHookRelay, mockConfig) as any;
  }

  it('never lets a session buffer exceed the 4 MB cap, however the output is chopped up', async () => {
    const server = await newServer();
    // 100 x 64 KiB = 6.25 MiB pushed through a 4 MiB cap.
    const chunk = 64 * 1024;
    for (let i = 0; i < 100; i++) {
      server.onPtyOutput('s1', String.fromCharCode(97 + (i % 26)).repeat(chunk));
    }
    const buf = server.ptyBuffers.get('s1');
    expect(buf.length).toBeLessThanOrEqual(PTY_CAP);
    // The running counter must agree with what is actually stored, or the trim
    // loop would drift and the cap would stop meaning anything.
    expect(buf.length).toBe(buf.chunks.join('').length);
  });

  it('replays the tail of the output, not the head', async () => {
    const server = await newServer();
    const chunk = 64 * 1024; // divides the cap exactly, so the tail is exact
    let full = '';
    for (let i = 0; i < 100; i++) {
      const data = String.fromCharCode(97 + (i % 26)).repeat(chunk);
      full += data;
      server.onPtyOutput('s1', data);
    }

    const { frames, ws } = fakeWs();
    await replayAndWait(server, ws);

    const pty = frames.filter((m) => m.type === 'pty:output' && m.payload.sessionId === 's1');
    expect(pty).toHaveLength(1);
    expect(pty[0].payload.data).toBe(full.slice(-PTY_CAP));
  });

  it('trims on a chunk boundary when the chunks do not divide the cap evenly', async () => {
    const server = await newServer();
    const chunk = 100_000; // does not divide 4 MiB
    let full = '';
    for (let i = 0; i < 60; i++) {
      const data = String.fromCharCode(97 + (i % 26)).repeat(chunk);
      full += data;
      server.onPtyOutput('s1', data);
    }

    const { frames, ws } = fakeWs();
    await replayAndWait(server, ws);
    const replayed = frames.find((m) => m.type === 'pty:output').payload.data;

    // Still a suffix of everything written, still under the cap — but because whole
    // chunks are dropped rather than cutting mid-chunk, it can be up to one chunk
    // shorter than the old string buffer would have been. That is expected.
    expect(full.endsWith(replayed)).toBe(true);
    expect(replayed.length).toBeLessThanOrEqual(PTY_CAP);
    expect(replayed.length).toBeGreaterThan(PTY_CAP - chunk);
  });

  it('caps a single chunk that is bigger than the whole buffer', async () => {
    const server = await newServer();
    const huge = 'z'.repeat(PTY_CAP + 5000);
    server.onPtyOutput('s1', huge);
    const buf = server.ptyBuffers.get('s1');
    expect(buf.length).toBe(PTY_CAP);
    expect(buf.chunks.join('')).toBe(huge.slice(-PTY_CAP));
  });

  it('does not accumulate array entries for empty output, or for one-character output', async () => {
    const server = await newServer();
    for (let i = 0; i < 100; i++) server.onPtyOutput('s1', '');
    expect(server.ptyBuffers.get('s1').chunks).toHaveLength(0);
    expect(server.ptyBuffers.get('s1').length).toBe(0);

    // 20,000 single keystrokes must not become 20,000 array entries — they are
    // coalesced into ~4 KB chunks (see PTY_CHUNK_COALESCE_BELOW).
    for (let i = 0; i < 20_000; i++) server.onPtyOutput('s1', 'x');
    const buf = server.ptyBuffers.get('s1');
    expect(buf.length).toBe(20_000);
    expect(buf.chunks.join('')).toBe('x'.repeat(20_000));
    expect(buf.chunks.length).toBeLessThan(20);
  });

  it('still broadcasts every PTY chunk live to a connected client', async () => {
    // Guards the pitfall this change sits next to: a broadcast nobody asked for is
    // still load-bearing. Skipping the send is only ever allowed at ZERO clients.
    const server = await newServer();
    const sent: any[] = [];
    server.clients.add({ id: 'c1', ws: { readyState: 1, send: (d: string) => sent.push(JSON.parse(d)) }, token: 't', ip: '1.2.3.4', connectedAt: 0 });

    server.onPtyOutput('s1', 'hello');
    server.onPtyOutput('s1', ''); // even an empty chunk is still forwarded, as before

    expect(sent).toHaveLength(2);
    // Batch 2: every live frame also carries the buffer epoch and the chunk's stream offset.
    expect(sent[0]).toMatchObject({ type: 'pty:output', payload: { sessionId: 's1', data: 'hello', offset: 0 } });
    expect(sent[1]).toMatchObject({ type: 'pty:output', payload: { sessionId: 's1', data: '', offset: 5 } });
  });

  it('broadcast() does no work at all when no client is connected', async () => {
    const server = await newServer();
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      server.broadcast({ type: 'pty:output', payload: { sessionId: 's1', data: 'x' } });
      // Not even the serialization: that was the per-chunk cost paid by every user
      // who never opens remote access.
      expect(stringify).not.toHaveBeenCalled();

      const sent: string[] = [];
      server.clients.add({ id: 'c1', ws: { readyState: 1, send: (d: string) => sent.push(d) }, token: 't', ip: '1.2.3.4', connectedAt: 0 });
      server.broadcast({ type: 'pty:output', payload: { sessionId: 's1', data: 'x' } });
      expect(stringify).toHaveBeenCalledTimes(1);
      expect(sent).toHaveLength(1);
    } finally {
      stringify.mockRestore();
    }
  });

  it('bounds the hook-event buffer at 10,000 events and keeps the newest ones', async () => {
    const server = await newServer();
    for (let i = 0; i < HOOK_CAP + 500; i++) {
      server.bufferHookEvent({ sessionId: 's1', type: 'Notification', payload: { n: i }, timestamp: 0 });
    }
    const buf = server.hookBuffers.get('s1');
    expect(buf).toHaveLength(HOOK_CAP);
    expect(buf[0].payload.n).toBe(500);              // oldest 500 dropped
    expect(buf[buf.length - 1].payload.n).toBe(HOOK_CAP + 499); // newest kept
  });
});
