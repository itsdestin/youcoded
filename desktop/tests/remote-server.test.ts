import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPublish } from '../src/main/publish';
import { SessionRecords } from '../src/main/session-record';

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
 * Send a bare socket the host's hello (session list, topic names, last status), the way `client:ready` does.
 * (One-core R5-2: the restore sequence this used to drive is gone.)
 */
async function restore(server: any, ws: any) {
  server.sendHello({ id: 'test', ws, deviceId: 'd', ip: '', connectedAt: 0 });
}

// WHY (2026-09-29 one-core R1): RemoteServer no longer has a setNativeRuntime() setter; it reads the
// runtime through the `getNativeRuntime` accessor main.ts gives it. Tests hand it a (partial) fake
// by replacing that accessor on the instance — evaluated once, so a fake keeps its identity.
function giveRuntime(server: any, runtime: any): void { server.getNativeRuntime = () => runtime; }

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

  it('round-trips context defaults and refuses unsupported or failed saves', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const sent: any[] = [];
    const ws = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    const request = async (type: string, payload = {}) => {
      await server.handleMessage({ ws }, JSON.stringify({ type, id: 'context', payload }));
      return sent.pop()?.payload;
    };
    expect(await request('native:get-context-preferences')).toMatchObject({ ok: false });
    expect(await request('native:set-context-preferences', { patch: { chatgpt: 'long' } })).toMatchObject({ ok: false });
    const contextSettings = {
      read: vi.fn(() => ({ openrouter: 'long', chatgpt: 'standard' })),
      update: vi.fn(async () => ({ openrouter: 'long', chatgpt: 'long' })),
    };
    giveRuntime(server, { contextSettings });
    expect(await request('native:get-context-preferences')).toEqual({ openrouter: 'long', chatgpt: 'standard' });
    expect(await request('native:set-context-preferences', { patch: { chatgpt: 'long' } })).toEqual({ openrouter: 'long', chatgpt: 'long' });
    expect(contextSettings.update).toHaveBeenCalledWith({ chatgpt: 'long' });
    contextSettings.update.mockRejectedValueOnce(new Error('lock held'));
    // WHY toMatchObject (2026-09-30 one-core R3-5): a throw now answers through the table, whose failure
    // answer also carries the flag the phone's page turns back into a rejection.
    expect(await request('native:set-context-preferences', { patch: { chatgpt: 'standard' } })).toMatchObject({ ok: false, error: 'lock held' });
    vi.stubEnv('YOUCODED_NATIVE', '0');
    try {
      expect(await request('native:get-context-preferences')).toMatchObject({ ok: false });
      expect(await request('native:set-context-preferences', { patch: {} })).toMatchObject({ ok: false });
      expect(contextSettings.update).toHaveBeenCalledTimes(2);
    } finally { vi.unstubAllEnvs(); }
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
    // One-core R5-2: Claude Code's hook events are published from main.ts (publish.ts), so this server no longer listens to the relay.
    expect(mockHookRelay.listenerCount('permission-expired')).toBe(0);
    expect(mockSessionManager.listenerCount('pty-output')).toBe(1);
    server.stop();
    expect(mockSessionManager.listenerCount('pty-output')).toBe(0);
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

  it('routes remote handoff by socket identity and cancels only that socket on drop', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(shellSessionManager, shellHookRelay, shellConfig);
    const route: any = vi.fn(async () => ({ id: 'attempt', status: 'waiting' }));
    route.cancelOwner = vi.fn();
    server.setHandoffRoute(route);
    // WHY (2026-09-30 one-core R3-5): the handoff:* table entries reach the attempt controller through the
    // route the computer's setup binds; the server keeps its own copy only to cancel a dropped phone's attempts.
    const { bindHandoffRoute } = await import('../src/main/ipc/handoff');
    bindHandoffRoute(route);
    const frames: any[] = [];
    const client = { id: 'connection-a', ws: { readyState: 1, send: (raw: string) => frames.push(JSON.parse(raw)) } };
    const other: any = { id: 'connection-b' };
    server.clients.add(client);
    server.clients.add(other);
    await server.handleMessage(client, JSON.stringify({ type: 'handoff:begin', id: 'request', payload: {
      owner: 'remote:connection-b', conversationId: 'abc', provider: 'native',
    } }));
    expect(route).toHaveBeenCalledWith('remote:connection-a', 'begin', expect.objectContaining({ owner: 'remote:connection-b' }));
    expect(frames[0].payload).toEqual({ id: 'attempt', status: 'waiting' });
    await server.handleMessage(client, JSON.stringify({ type: 'handoff:force', id: 'force-request', payload: {
      owner: 'remote:connection-b', id: 'attempt', consent: true, expectedHolderId: 'original',
    } }));
    expect(route).toHaveBeenCalledWith('remote:connection-a', 'force', expect.objectContaining({ expectedHolderId: 'original' }));
    server.removeClient(client);
    expect(route.cancelOwner).toHaveBeenCalledWith('remote:connection-a');
    expect(server.clients.has(other)).toBe(true);
    other.ws = { close: vi.fn() };
    server.stop();
    expect(route.cancelOwner).toHaveBeenCalledWith('remote:connection-b');
    expect(shellSessionManager.createSession).not.toHaveBeenCalled();
    bindHandoffRoute(undefined);
  });

  // WHY (2026-09-30 one-core R3-4): session:create is a channel-table entry, so these tests give the table
  // its create operation (what registerIpcHandlers hands over) and drive the phone through the real server.
  const withCreate = async (createSession: any) => {
    const { bindSessionOps } = await import('../src/main/ipc/session');
    bindSessionOps({ createSession } as any);
  };
  afterEach(async () => { (await import('../src/main/ipc/session')).bindSessionOps(null); });

  it('uses the shared admitted creation for a remote resume, including a denial', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(shellSessionManager, shellHookRelay, shellConfig);
    const create = vi.fn(async () => ({ status: 'lease-denied', device: 'Other computer' }));
    await withCreate(create);
    const payload = { provider: 'native', resumeSessionId: 'c1', cwd: '/tmp' };
    const sent = await drive(server, { type: 'session:create', id: 'c1', payload });
    expect(create).toHaveBeenCalledWith(null, payload); // no window behind a phone's create
    expect(shellSessionManager.createSession).not.toHaveBeenCalled();
    expect(sent[0].payload).toEqual({ status: 'lease-denied', device: 'Other computer' });
  });

  it('answers creation failures instead of abandoning the remote request', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(shellSessionManager, shellHookRelay, shellConfig);
    await withCreate(vi.fn().mockRejectedValue(new Error('Saved data could not be read.')));
    const sent = await drive(server, { type: 'session:create', id: 'failure', payload: { resumeSessionId: 'c1' } });
    expect(sent).toContainEqual({ type: 'session:create:response', id: 'failure', payload: { ok: false, error: 'Saved data could not be read.' } });
  });

  it('cannot bypass admission before the shared creation operation is wired', async () => {
    // WHY (2026-09-30 one-core R3-5, review F4): a phone's create that arrives before the computer has wired
    // the shared creation operation WAITS for it (it used to be answered "not ready" at once); it still never
    // reaches the server's own createSession, and if the wiring never comes it ends in the same plain answer.
    vi.useFakeTimers();
    try {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(shellSessionManager, shellHookRelay, shellConfig);
      const create = vi.fn(async () => ({ id: 'late' }));
      const pending = drive(server, { type: 'session:create', id: 'early', payload: { resumeSessionId: 'c1' } });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(create).not.toHaveBeenCalled();
      expect(shellSessionManager.createSession).not.toHaveBeenCalled();
      await withCreate(create); // the computer finishes starting: the waiting create now runs through it
      const sent = await pending;
      expect(create).toHaveBeenCalledWith(null, { resumeSessionId: 'c1' });
      expect(sent[0].payload).toEqual({ id: 'late' });
      expect(shellSessionManager.createSession).not.toHaveBeenCalled();
      // And with no wiring ever, the wait ends in the plain answer instead of hanging.
      (await import('../src/main/ipc/session')).bindSessionOps(null);
      const never = drive(server, { type: 'session:create', id: 'never', payload: { resumeSessionId: 'c1' } });
      await vi.advanceTimersByTimeAsync(15_000);
      expect((await never)[0].payload).toEqual({ ok: false, error: 'Sessions are not ready yet. Try again.' });
    } finally { vi.useRealTimers(); }
  });

  it('refuses session:create for a shell, which would be a bare shell on the host', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(shellSessionManager, shellHookRelay, shellConfig);
    const create = vi.fn();
    await withCreate(create);
    const sent = await drive(server, {
      type: 'session:create', id: 'c1',
      payload: { name: 'x', cwd: '/', skipPermissions: false, provider: 'shell' },
    });
    expect(shellSessionManager.createSession).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(sent[0].payload).toEqual({ ok: false, error: 'A terminal session can only be opened from the app itself.' });
  });

  it('still creates an ordinary session', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(shellSessionManager, shellHookRelay, shellConfig);
    await withCreate(async (_sender: any, opts: any) => shellSessionManager.createSession(opts));
    await drive(server, { type: 'session:create', id: 'c2', payload: { name: 'x', cwd: '/tmp', skipPermissions: false } });
    expect(shellSessionManager.createSession).toHaveBeenCalledTimes(1);
  });

  // A phone reopening a conversation already open on the desktop is pinned
  // end to end (real RemoteServer -> shared create -> already-open check) in
  // ipc-handlers.test.ts, 'a phone reopening a conversation already open...'.
  // The "No folder" rewrite a phone's create needs is pinned there too: the shared create applies it.

  // A phone's YouCoded-runtime session used to be minted by the session manager
  // alone — nothing started its runtime, so every message failed as not-live.
  it('starts the new session the same way the desktop does, before answering the phone', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(shellSessionManager, shellHookRelay, shellConfig);
    const order: string[] = [];
    await withCreate(async (_sender: any, opts: any) => {
      order.push(`create+start:${opts.provider}`);
      return { id: 'n1', provider: opts.provider };
    });
    const sent = await drive(server, { type: 'session:create', id: 'c4', payload: { name: 'x', cwd: '/tmp', skipPermissions: false, provider: 'native' } });
    order.push('answered');
    expect(order).toEqual(['create+start:native', 'answered']);
    expect(sent[0].payload).toMatchObject({ id: 'n1' });
    expect(shellSessionManager.createSession).not.toHaveBeenCalled();   // the shared path creates it
  });

  it('answers the phone with the real reason when creating the session throws', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(shellSessionManager, shellHookRelay, shellConfig);
    await withCreate(async () => { throw new Error('engine gone'); });
    const sent = await drive(server, { type: 'session:create', id: 'c5', payload: { name: 'x', cwd: '/tmp', skipPermissions: false, provider: 'native' } });
    expect(sent[0].payload).toEqual({ ok: false, error: 'engine gone' });
  });

  // Files attached to a phone's message in a YouCoded-runtime session were dropped:
  // only the text reached the host.
  it('passes a phone message’s attached files to the YouCoded runtime', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(shellSessionManager, shellHookRelay, shellConfig);
    const send = vi.fn(() => ({ status: 'sent' }));
    giveRuntime(server, { nativeHost: { send } });
    await drive(server, { type: 'native:send', id: 'n1', payload: { sessionId: 's1', text: 'look /up/a.png', attachments: ['/up/a.png', 42] } });
    expect(send).toHaveBeenCalledWith('s1', 'look /up/a.png', ['/up/a.png']);
    await drive(server, { type: 'native:send', id: 'n2', payload: { sessionId: 's1', text: 'no files' } });
    expect(send).toHaveBeenLastCalledWith('s1', 'no files', []);
  });

  // A phone's settings read and write the same files the same way as the desktop's —
  // the hand-copied remote versions had drifted (no override defaults, a replaced
  // override block, and a saved permission the app did not enforce until a re-read).
  it('reads and saves session defaults exactly as the desktop does, and the app enforces the save', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-defaults-'));
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      fs.mkdirSync(path.join(home, '.claude'));
      fs.writeFileSync(path.join(home, '.claude', 'youcoded-defaults.json'), JSON.stringify({ permissionOverrides: { approveAll: true } }));
      const { RemoteServer } = await import('../src/main/remote-server');
      const { setPermissionOverridesSink } = await import('../src/main/prefs-service');
      const enforced = vi.fn();
      setPermissionOverridesSink(enforced);
      const server: any = new RemoteServer(shellSessionManager, shellHookRelay, shellConfig);
      const [got] = await drive(server, { type: 'defaults:get', id: 'd1' });
      expect(got.payload.permissionOverrides).toMatchObject({ approveAll: true, protectedDirectories: false });
      const [saved] = await drive(server, { type: 'defaults:set', id: 'd2', payload: { permissionOverrides: { protectedDirectories: true } } });
      expect(saved.payload.permissionOverrides).toMatchObject({ approveAll: true, protectedDirectories: true });
      expect(enforced).toHaveBeenLastCalledWith(expect.objectContaining({ approveAll: true, protectedDirectories: true }));
      const [favs] = await drive(server, { type: 'favorites:get', id: 'd3' });
      expect(favs.payload).toEqual([]);                  // a list, as on the desktop
      setPermissionOverridesSink(() => {});
    } finally {
      homedir.mockRestore();
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    }
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
    // WHY (2026-09-30 one-core R3-6): engine:run-in-terminal is a table entry; it opens its shell through the
    // session manager bound with the rest of the session operations, for a phone as for a window.
    (await import('../src/main/ipc/session')).bindSessionOps({ sessionManager: shellSessionManager } as any);
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
    giveRuntime(server, fakeRuntime({ setModelSettings }));

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
    giveRuntime(server, fakeRuntime({ modelSettings }));

    const sent = await drive(server, { type: 'models:settings', id: 's2', payload: { modelId: 'alpha' } });

    expect(modelSettings).toHaveBeenCalledWith('alpha');
    // The two fields T23's dialog draws must survive the remote hop too.
    expect(sent[0].payload).toMatchObject({ pendingApply: true, lastLoadError: 'out of device memory' });
  });

  it('answers a REFUSED save as a failure, which the shim re-throws', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(sm, hr, cfg);
    giveRuntime(server, fakeRuntime({
      setModelSettings: vi.fn(async () => { throw new Error('Context length must be at least 1024 tokens.'); }),
    }));

    const sent = await drive(server, {
      type: 'models:set-settings', id: 's3', payload: { modelId: 'alpha', patch: { contextLength: 512 } },
    });

    // The table's failure marker rides along so the phone's page rejects it for any channel.
    expect(sent[0].payload).toEqual({ ok: false, error: 'Context length must be at least 1024 tokens.', tableHandlerFailed: true });
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

  // Regression: useAttentionClassifier polls an unbridged channel (it was
  // `terminal:get-screen-text`, now a table entry the table refuses) once a second, so an unconditional warn logged a
  // line per second for the life of the connection. That drowned the log and,
  // because a write to a closed stdout throws EPIPE, helped crash the main
  // process outright on 2026-07-20.
  it('warns once per unhandled channel, not once per request', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      for (let i = 0; i < 5; i++) {
        await sendAndCollect(server, { type: 'unbridged:poll', id: `poll-${i}`, payload: {} });
      }
      expect(warn).toHaveBeenCalledTimes(1);

      // A DIFFERENT channel still warns — dedup must not silence new gaps.
      await sendAndCollect(server, { type: 'unbridged:other', id: 'other', payload: {} });
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
        const sent = await sendAndCollect(server, { type: 'unbridged:poll', id: `poll-${i}`, payload: {} });
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
// WHY (2026-09-30 one-core R3-4): session:get-meta / set-tag / set-note / browse are channel-table entries
// (main/ipc/session.ts) that a phone and the computer's windows share. These tests drive the phone through the
// real server and give the table what registerIpcHandlers hands it (the id map, the phantom-record gate, the
// native host), with the conversation store and the past-session scan mocked at the top of this file.
describe('RemoteServer session meta + browse', () => {
  let mockSessionManager: any;
  let mockHookRelay: any;
  let mockConfig: any;
  let sendForSession: any;
  let remoteBroadcast: any;

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
    sendForSession = vi.fn();
    remoteBroadcast = vi.fn();
  });
  afterEach(async () => { (await import('../src/main/ipc/session')).bindSessionOps(null); });

  /** Give the table the state registerIpcHandlers would: the id map (desktop id -> conversation id), which
   *  desktop sessions are live, the phantom-record gate, and a native host that recognizes `native` ids. */
  async function bindOps(opts: { map?: Record<string, string>; live?: string[]; native?: string[]; nativeEntries?: any[]; canWrite?: boolean } = {}) {
    const { bindSessionOps } = await import('../src/main/ipc/session');
    const nativeIds = new Set(opts.native ?? []);
    const live = new Set(opts.live ?? Object.keys(opts.map ?? {}));
    bindSessionOps({
      sessionManager: { listSessions: () => [...live].map((id) => ({ id })), getSession: (id: string) => (live.has(id) ? { id } : undefined), sendInput: vi.fn(), resizeSession: vi.fn() },
      sessionIdMap: new Map(Object.entries(opts.map ?? {})),
      nativeHost: {
        isNativeSessionId: (id: string) => nativeIds.has(id),
        // The browse handler reads through the async form since 2026-09-16 (C6).
        listAsync: async () => opts.nativeEntries ?? [],
      },
      canWriteStoreRecord: () => opts.canWrite ?? true,
      // WHY a real publish over the two spies (one-core R5-1): the assertions below still read what the windows and
      // the phones were told, so they pin the delivery, not the call shape.
      publish: createPublish({
        records: new SessionRecords(),
        toWindows: (sessionId, channel, args) => sendForSession(sessionId, channel, ...args),
        toSockets: (message) => remoteBroadcast(message),
      }),
    } as any);
  }

  async function phoneServer() {
    const { RemoteServer } = await import('../src/main/remote-server');
    return new RemoteServer(mockSessionManager, mockHookRelay, mockConfig) as any;
  }

  function sendAndCollect(server: any, msg: any) {
    const sent: any[] = [];
    const ws: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    return server.handleMessage({ ws }, JSON.stringify(msg)).then(() => sent);
  }

  describe('session:get-meta', () => {
    it('resolves a native id through the id map and reads the store with provider "native"', async () => {
      const server = await phoneServer();
      await bindOps({ map: { 'desktop-1': 'native-1' }, native: ['native-1'] });
      const storeGet = vi.fn(async (_provider: string, _id: string) => ({
        flags: { 'tag:tag_a': { value: true, updatedAt: 'x' } },
        note: 'hi',
      }));
      mockConversationsService.getConversationStore.mockReturnValue({ get: storeGet });

      const sent = await sendAndCollect(server, {
        type: 'session:get-meta', id: 'r1', payload: { sessionId: 'desktop-1' },
      });

      // The map's output — not the raw payload id — is what must reach the store, on the 'native'
      // bucket derived from isNativeSessionId. A phone now also gets the reserved flags (none here).
      expect(storeGet).toHaveBeenCalledWith('native', 'native-1');
      expect(sent[0].payload).toEqual({ tags: ['tag_a'], note: 'hi', supported: true, flags: {} });
    });

    it('resolves a non-native id and reads the store with provider "claude"', async () => {
      const server = await phoneServer();
      await bindOps({}); // nothing is native
      const storeGet = vi.fn(async () => null);
      mockConversationsService.getConversationStore.mockReturnValue({ get: storeGet });

      await sendAndCollect(server, {
        type: 'session:get-meta', id: 'r2', payload: { sessionId: 'cc-session-abc' },
      });

      expect(storeGet).toHaveBeenCalledWith('claude', 'cc-session-abc');
    });

    // C1: a store-only native id — NOT live/on-disk (isNativeSessionId false), but a native record exists in
    // the store (synced from a peer, transcript not materialized here). The provider lookup must probe the
    // native bucket and resolve 'native' rather than defaulting to 'claude' (which would read — and, on the
    // write path, seed — the wrong bucket).
    it('resolves a store-only native id (not live/on-disk) to the "native" bucket by probing the store', async () => {
      const server = await phoneServer();
      await bindOps({});
      const storeGet = vi.fn(async (provider: string) =>
        provider === 'native'
          ? { flags: { 'tag:tag_n': { value: true, updatedAt: 'x' } }, note: 'from peer' }
          : null,
      );
      mockConversationsService.getConversationStore.mockReturnValue({ get: storeGet });

      const sent = await sendAndCollect(server, {
        type: 'session:get-meta', id: 'r-native', payload: { sessionId: 'store-only-native' },
      });

      expect(storeGet).toHaveBeenCalledWith('native', 'store-only-native');
      expect(storeGet).not.toHaveBeenCalledWith('claude', 'store-only-native');
      expect(sent[0].payload).toEqual({ tags: ['tag_n'], note: 'from peer', supported: true, flags: {} });
    });

    it('reports the tags and note as unreadable when no Conversation Store is up', async () => {
      const server = await phoneServer();
      await bindOps({});
      mockConversationsService.getConversationStore.mockReturnValue(null);

      const sent = await sendAndCollect(server, {
        type: 'session:get-meta', id: 'r3', payload: { sessionId: 'x' },
      });

      // Was `{ tags: [], note: '', supported: true }` — identical to a conversation with no note, which the
      // close prompt showed as "No note" and then overwrote (error inventory 2026-09-10, false message 12).
      expect(sent[0].payload).toEqual({ tags: [], note: '', supported: true, unreadable: expect.any(String) });
    });

    it('gives a phone the reserved flags too (Priority etc.), as the computer always got them', async () => {
      const server = await phoneServer();
      await bindOps({});
      mockConversationsService.getConversationStore.mockReturnValue({
        get: async () => ({ flags: { priority: { value: true, updatedAt: 'x' }, 'internal-thing': { value: true, updatedAt: 'x' } }, note: '' }),
      });
      const sent = await sendAndCollect(server, { type: 'session:get-meta', id: 'r4', payload: { sessionId: 'c' } });
      expect(sent[0].payload).toEqual({ tags: [], note: '', supported: true, flags: { priority: true } });
    });
  });

  describe('session:set-tag', () => {
    const msg = (overrides: any = {}) => ({
      type: 'session:set-tag', id: 'st', payload: { sessionId: 'desktop-1', tagId: 'tag_abc', value: true, ...overrides },
    });

    it('rejects a malformed tag id without ever calling the store write', async () => {
      const server = await phoneServer();
      await bindOps({});

      const sent = await sendAndCollect(server, msg({ tagId: 'not-a-tag' }));

      expect(sent[0].payload).toEqual({ ok: false, error: 'invalid tag id: not-a-tag' });
      expect(mockConversationsService.noteFlagChanged).not.toHaveBeenCalled();
    });

    // The phantom-record gate (ipc-handlers.ts canWriteStoreRecord): a refusal means "don't seed a
    // mis-provider'd record for a live session whose id mapping hasn't landed yet" — the write is skipped,
    // NOT an error; the flag simply re-applies once the mapping lands.
    it('skips the write but still answers ok:true when the phantom-record gate refuses', async () => {
      const server = await phoneServer();
      await bindOps({ canWrite: false });

      const sent = await sendAndCollect(server, msg());

      expect(mockConversationsService.noteFlagChanged).not.toHaveBeenCalled();
      expect(sent[0].payload).toEqual({ ok: true });
    });

    it('answers ok:true once the service write resolves ok', async () => {
      const server = await phoneServer();
      await bindOps({});

      const sent = await sendAndCollect(server, msg());

      expect(mockConversationsService.noteFlagChanged).toHaveBeenCalledTimes(1);
      expect(sent[0].payload).toEqual({ ok: true });
    });

    // A tag applied from a phone must reach the chatsearch index, not wait for an unrelated refresh.
    it('signals chatsearch that a tag changed once the write succeeds', async () => {
      const server = await phoneServer();
      await bindOps({});

      await sendAndCollect(server, msg());

      expect(mockConversationsService.emitConversationMetaChanged).toHaveBeenCalledTimes(1);
    });

    // The emit must never fire on a failed write.
    it('does not signal chatsearch when the write fails', async () => {
      const server = await phoneServer();
      await bindOps({});
      mockConversationsService.noteFlagChanged.mockResolvedValue({ ok: false });

      await sendAndCollect(server, msg());

      expect(mockConversationsService.emitConversationMetaChanged).not.toHaveBeenCalled();
    });

    // Honesty invariant (Item 6): a write that actually reports failure must not be smoothed over into ok:true.
    it('honesty invariant: a service write resolving ok:false produces an ok:false response', async () => {
      const server = await phoneServer();
      await bindOps({});
      mockConversationsService.noteFlagChanged.mockResolvedValue({ ok: false });

      const sent = await sendAndCollect(server, msg());

      expect(sent[0].payload.ok).toBe(false);
    });

    // C1: the write passes the SYNCHRONOUS isNativeSessionId(resolved) result (a boolean) — not a provider
    // string — to noteFlagChanged, which defers the store's native-bucket probe to flush time.
    it('derives the write provider via nativeHost.isNativeSessionId on the RESOLVED id', async () => {
      const server = await phoneServer();
      await bindOps({ map: { 'desktop-1': 'native-1' }, native: ['native-1'] });

      await sendAndCollect(server, msg({ sessionId: 'desktop-1' }));

      expect(mockConversationsService.noteFlagChanged).toHaveBeenCalledWith('native-1', 'tag:tag_abc', true, true);
    });

    // A store write that throws (the real service resolves {ok:false} instead, so this cannot happen through
    // its contract) is answered to the phone like the computer answers it, not left hanging.
    it('answers a rejected write with the reason instead of leaving the request unanswered', async () => {
      const server = await phoneServer();
      await bindOps({});
      mockConversationsService.noteFlagChanged.mockRejectedValue(new Error('store exploded'));

      const sent = await sendAndCollect(server, msg());

      expect(sent[0].payload).toEqual({ ok: false, error: 'store exploded' });
    });

    it('tells the phones and the owning window session:meta-changed after a successful write', async () => {
      const server = await phoneServer();
      await bindOps({});

      await sendAndCollect(server, msg());

      // Same frame shape both doors send: a second remote client viewing this session must refetch its meta.
      const payload = { sessionId: 'desktop-1', flag: 'tag:tag_abc', value: true };
      expect(remoteBroadcast).toHaveBeenCalledWith({ type: 'session:meta-changed', payload });
      expect(sendForSession).toHaveBeenCalledWith('desktop-1', 'session:meta-changed', 'desktop-1', { flag: 'tag:tag_abc', value: true });
    });
  });

  describe('session:set-note', () => {
    const msg = (overrides: any = {}) => ({
      type: 'session:set-note', id: 'sn', payload: { sessionId: 'desktop-1', note: 'hello', ...overrides },
    });

    it('rejects a note over 8000 characters without ever calling the store write', async () => {
      const server = await phoneServer();
      await bindOps({});

      const sent = await sendAndCollect(server, msg({ note: 'x'.repeat(8001) }));

      expect(sent[0].payload).toEqual({ ok: false, error: 'note exceeds 8000 characters' });
      expect(mockConversationsService.noteSessionNote).not.toHaveBeenCalled();
    });

    it('skips the write but still answers ok:true when the phantom-record gate refuses', async () => {
      const server = await phoneServer();
      await bindOps({ canWrite: false });

      const sent = await sendAndCollect(server, msg());

      expect(mockConversationsService.noteSessionNote).not.toHaveBeenCalled();
      expect(sent[0].payload).toEqual({ ok: true });
    });

    it('answers ok:true once the service write resolves ok', async () => {
      const server = await phoneServer();
      await bindOps({});

      const sent = await sendAndCollect(server, msg());

      expect(mockConversationsService.noteSessionNote).toHaveBeenCalledTimes(1);
      expect(sent[0].payload).toEqual({ ok: true });
    });

    // A note written from a phone must reach the chatsearch index, not wait for an unrelated refresh.
    it('signals chatsearch that a note changed once the write succeeds', async () => {
      const server = await phoneServer();
      await bindOps({});

      await sendAndCollect(server, msg());

      expect(mockConversationsService.emitConversationMetaChanged).toHaveBeenCalledTimes(1);
    });

    it('honesty invariant: a service write resolving ok:false produces an ok:false response', async () => {
      const server = await phoneServer();
      await bindOps({});
      mockConversationsService.noteSessionNote.mockResolvedValue({ ok: false });

      const sent = await sendAndCollect(server, msg());

      expect(sent[0].payload.ok).toBe(false);
    });

    // The emit must never fire on a failed write.
    it('does not signal chatsearch when the note write fails', async () => {
      const server = await phoneServer();
      await bindOps({});
      mockConversationsService.noteSessionNote.mockResolvedValue({ ok: false });

      await sendAndCollect(server, msg());

      expect(mockConversationsService.emitConversationMetaChanged).not.toHaveBeenCalled();
    });

    it('derives the write provider via nativeHost.isNativeSessionId on the RESOLVED id', async () => {
      const server = await phoneServer();
      await bindOps({ map: { 'desktop-1': 'native-1' }, native: ['native-1'] });

      await sendAndCollect(server, msg({ sessionId: 'desktop-1', note: 'note text' }));

      // C1: passes the boolean isNativeSessionId result, not a provider string.
      expect(mockConversationsService.noteSessionNote).toHaveBeenCalledWith('native-1', 'note text', true);
    });

    it('tells the phones and the owning window session:meta-changed after a successful write', async () => {
      const server = await phoneServer();
      await bindOps({});

      await sendAndCollect(server, msg());

      expect(remoteBroadcast).toHaveBeenCalledWith({ type: 'session:meta-changed', payload: { sessionId: 'desktop-1', note: 'hello' } });
      expect(sendForSession).toHaveBeenCalledWith('desktop-1', 'session:meta-changed', 'desktop-1', { note: 'hello' });
    });
  });

  describe('session:browse', () => {
    it('passes nativeHost entries into listPastSessions alongside the live conversation ids', async () => {
      const server = await phoneServer();
      const nativeEntries = [{ id: 'native-9', provider: 'native' as const, slug: 'foo' }];
      await bindOps({ map: { 'live-1': 'live-1' }, nativeEntries });
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

    // Audit B1, fixed by construction: the exclusion set holds CLAUDE transcript ids, which is what
    // listPastSessions compares against — the desktop id a live session is known by is a different UUID.
    // A phone and the computer's windows now read the ONE id map through the same entry, so a session open on
    // the computer can never be offered on the phone's Resume list (the phone used to have its own lookup).
    it('hides a session open on the computer through the one id map, not through its desktop id', async () => {
      const server = await phoneServer();
      await bindOps({ map: { 'desktop-1': 'claude-1' } });

      await sendAndCollect(server, { type: 'session:browse', id: 'b3', payload: {} });

      const [activeIdsArg] = mockSessionBrowser.listPastSessions.mock.calls[0];
      expect(activeIdsArg.has('claude-1')).toBe(true); // the mapped id is what hides the open session
      expect(activeIdsArg.has('desktop-1')).toBe(false); // the raw desktop id matches no transcript
    });

    // WHY (2026-09-30 one-core R3-5, review F2): a NATIVE session's desktop id is its conversation id, but it
    // enters the id map only after its native start finishes; browsing in that window offered the brand-new
    // conversation as resumable. A live native id is excluded even though it is not mapped yet.
    it('also hides a brand-new native session that is open but not in the id map yet', async () => {
      const server = await phoneServer();
      await bindOps({ map: {}, live: ['native-new', 'claude-open'], native: ['native-new'] });

      await sendAndCollect(server, { type: 'session:browse', id: 'b4', payload: {} });

      const [activeIdsArg] = mockSessionBrowser.listPastSessions.mock.calls[0];
      expect([...activeIdsArg]).toEqual(['native-new']); // a Claude desktop id still matches no transcript and stays out
    });

    // Bug 1 (2026-07-13 dogfood): a stale map entry for a CLOSED session must not hide it from the list.
    it('a stale map entry for a session that is no longer open does not hide its conversation', async () => {
      const server = await phoneServer();
      await bindOps({ map: { 'closed-1': 'claude-closed', 'open-1': 'claude-open' }, live: ['open-1'] });

      await sendAndCollect(server, { type: 'session:browse', id: 'b2', payload: {} });

      const [activeIdsArg] = mockSessionBrowser.listPastSessions.mock.calls[0];
      expect([...activeIdsArg]).toEqual(['claude-open']);
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

  // WHY (2026-09-30 one-core R3-2): signed-in / user are served from the channel table now
  // (main/ipc/account.ts), not a RemoteServer case; the account objects arrive through
  // bindAccountDeps. The unbound case runs FIRST because the binding lasts for the file.
  // Must not hang or throw when the marketplace handlers have not registered yet.
  it('reports signed-out when the account is not bound yet', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const sent = await sendAndCollect(server, { type: 'account:signed-in', id: 'a3', payload: {} });
    expect(sent[0].payload).toBe(false);
    const user = await sendAndCollect(server, { type: 'account:user', id: 'a4', payload: {} });
    expect(user[0].payload).toBeNull();
  });

  it('reports the host signed-in state and the cached profile', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const { bindAccountDeps } = await import('../src/main/ipc/account');
    bindAccountDeps({ store: { getToken: () => 'tok', getUser: () => ({ login: 'destin' }) } as any, client: {} as any, installedSkillSource: null });
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    expect((await sendAndCollect(server, { type: 'account:signed-in', id: 'a1', payload: {} }))[0].payload).toBe(true);
    expect((await sendAndCollect(server, { type: 'account:user', id: 'a2', payload: {} }))[0].payload.login).toBe('destin');
  });

  it('a phone is still refused the account actions that change who this computer is', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    for (const type of ['account:start', 'account:poll', 'account:refresh', 'account:sign-out', 'account:update-profile', 'account:set-handle', 'account:delete', 'account:export']) {
      const sent = await sendAndCollect(server, { type, id: `r-${type}`, payload: {} });
      expect(sent[0].payload, type).toMatchObject({ ok: false, unsupported: true });
    }
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
describe('RemoteServer specialist run + native hook replay', () => {
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



  it('G-1: native:kill-shell over WS answers with the host result, and not-live without a runtime', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const { frames, ws } = fakeWs();
    await server.handleMessage({ ws, authenticated: true }, JSON.stringify({ type: 'native:kill-shell', id: 'r1', payload: { sessionId: 's1', shellId: 'sh-1' } }));
    expect(frames.find((m) => m.id === 'r1')?.payload).toEqual({ ok: false, reason: 'not-live' });
    giveRuntime(server, { nativeHost: { killShell: vi.fn(async () => ({ ok: true })) } });
    await server.handleMessage({ ws, authenticated: true }, JSON.stringify({ type: 'native:kill-shell', id: 'r2', payload: { sessionId: 's1', shellId: 'sh-1' } }));
    expect(frames.find((m) => m.id === 'r2')?.payload).toEqual({ ok: true });
  });

  it('forwards focused native compaction over WS and reports not-live without a runtime', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const { frames, ws } = fakeWs();
    const send = async (id: string, focus?: string) => {
      await server.handleMessage({ ws, authenticated: true }, JSON.stringify({
        type: 'native:compact', id, payload: { sessionId: 's1', focus },
      }));
      return frames.find(m => m.id === id)?.payload;
    };
    expect(await send('no-runtime', 'keep corrections')).toEqual({ ok: false, reason: 'not-live' });
    const compact = vi.fn(async () => ({ ok: true }));
    giveRuntime(server, { nativeHost: { compact } });
    expect(await send('focused', 'keep corrections')).toEqual({ ok: true });
    expect(compact).toHaveBeenCalledWith('s1', 'keep corrections');
    expect(await send('plain')).toEqual({ ok: true });
    expect(compact).toHaveBeenLastCalledWith('s1', undefined);
  });


  // Fix pass (2026-08-16 review finding, "the catch-up replays asks that were
  // already answered"): PermissionBroker now emits PermissionResolved from
  // its one removal chokepoint (permission-broker.ts) whenever an entry
  // leaves `pending` — respond() or a cancel.
  // bufferHookEvent() must treat that as a purge signal instead of just
  // another event to append, or a reconnecting phone still gets replayed a
  // dead question with live-looking Yes/No buttons.



  // admin-password design §2.5: a PasswordRequest must never be buffered at
  // all, not even transiently — the broker's own re-announce heartbeat and
  // the live broadcast are what cover a reconnect within a few seconds.


  // admin-password design §2.5/R6/R13: a paired phone or browser may answer
  // the password card, and `password` must never reach a log line anywhere
  // in this path.
  describe('native:submit-admin-password over WS', () => {
    const SENTINEL = 'sentinel-password-should-never-be-logged-xyz';

    it('routes to nativeHost.submitAdminPassword and answers with its result; not-live answers false', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      const { frames, ws } = fakeWs();

      await server.handleMessage({ ws, authenticated: true }, JSON.stringify({
        type: 'native:submit-admin-password', id: 'r1', payload: { requestId: 'req-1', password: SENTINEL },
      }));
      expect(frames.find((m: any) => m.id === 'r1')?.payload).toBe(false);

      const submitAdminPassword = vi.fn(() => true);
      giveRuntime(server, { nativeHost: { submitAdminPassword } });
      await server.handleMessage({ ws, authenticated: true }, JSON.stringify({
        type: 'native:submit-admin-password', id: 'r2', payload: { requestId: 'req-1', password: SENTINEL },
      }));
      expect(frames.find((m: any) => m.id === 'r2')?.payload).toBe(true);
      expect(submitAdminPassword).toHaveBeenCalledWith('req-1', SENTINEL);
    });

    it('never logs the password — the sentinel appears only in the one call into submitAdminPassword', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      const { ws } = fakeWs();
      const submitAdminPassword = vi.fn(() => true);
      giveRuntime(server, { nativeHost: { submitAdminPassword } });

      const spies = [
        vi.spyOn(console, 'log').mockImplementation(() => {}),
        vi.spyOn(console, 'warn').mockImplementation(() => {}),
        vi.spyOn(console, 'error').mockImplementation(() => {}),
      ];
      try {
        await server.handleMessage({ ws, authenticated: true }, JSON.stringify({
          type: 'native:submit-admin-password', id: 'r1', payload: { requestId: 'req-1', password: SENTINEL },
        }));
        for (const spy of spies) {
          for (const call of spy.mock.calls) {
            expect(JSON.stringify(call)).not.toContain(SENTINEL);
          }
        }
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      // The ONE place the sentinel is allowed to appear: the call this case makes.
      expect(submitAdminPassword).toHaveBeenCalledWith('req-1', SENTINEL);
    });

    // T4-2 (review): a non-string `password` used to reach
    // `Buffer.from(password, 'utf8')` three calls deep (submit()'s default
    // toBuffer), throwing synchronously — on this WS hop specifically that
    // throw is inside a promise nothing awaits, surfacing only via the
    // process-wide unhandledRejection log. Answered `false` here instead,
    // never even calling submitAdminPassword.
    it('answers false for a non-string or empty password, without calling submitAdminPassword or throwing', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      const { frames, ws } = fakeWs();
      const submitAdminPassword = vi.fn(() => true);
      giveRuntime(server, { nativeHost: { submitAdminPassword } });

      for (const [id, password] of [['r1', 12345], ['r2', null], ['r3', undefined], ['r4', {}], ['r5', '']] as const) {
        // No matcher needed to prove "does not throw" — an unhandled throw
        // inside handleMessage would fail this `await` itself.
        await server.handleMessage({ ws, authenticated: true }, JSON.stringify({
          type: 'native:submit-admin-password', id, payload: { requestId: 'req-1', password },
        }));
        expect(frames.find((m: any) => m.id === id)?.payload).toBe(false);
      }
      expect(submitAdminPassword).not.toHaveBeenCalled();
    });
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

  // WHY (2026-09-30 one-core R3-5, review F3): both doors used to list ~/.claude/projects on EVERY call even
  // when the caller's project folder was right (the usual case); the hint is now probed first.
  it('probes the caller\'s project folder first and lists the projects directory only when that misses', async () => {
    const slugDir = path.join(tmpHome, '.claude', 'projects', 'my-project');
    fs.writeFileSync(path.join(slugDir, 'abc-123.jsonl'), '');
    const readdirSpy = vi.spyOn(fs.promises, 'readdir');
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);

    await sendAndCollect(server, { type: 'session:history', id: 'h5', payload: { sessionId: 'abc-123', projectSlug: 'my-project', count: 5 } });
    expect(mockSessionBrowser.loadHistory).toHaveBeenLastCalledWith('abc-123', 'my-project', 5, undefined);
    expect(readdirSpy).not.toHaveBeenCalled();

    // A stale hint (the project folder changed) still finds the transcript, by scanning.
    await sendAndCollect(server, { type: 'session:history', id: 'h6', payload: { sessionId: 'abc-123', projectSlug: 'old-folder', count: 5 } });
    expect(readdirSpy).toHaveBeenCalledTimes(1);
    expect(mockSessionBrowser.loadHistory).toHaveBeenLastCalledWith('abc-123', 'my-project', 5, undefined);
    readdirSpy.mockRestore();
  });
});

// Perf regression (2026-09-01 investigation, "PTY replay buffer: a 4 MB string
// copy on every chunk, client or no client"). The rolling PTY buffer used to be
// ONE string per session: `buf += data` then `buf.slice(...)`, so once a busy
// session filled the 4 MB cap every further chunk re-allocated and copied ~4 MB —
// unconditionally, because the remote server is always on. It is now an array of
// chunks joined only at connect time. These tests pin the two things that must NOT
// change (the replayed tail, and the live broadcast) alongside the new bounds.
describe('RemoteServer terminal relay (the stream itself lives in the session record: tests/session-record-fill.test.ts)', () => {
  let mockSessionManager: any;
  let mockHookRelay: any;
  let mockConfig: any;

  beforeEach(() => {
    mockSessionManager = Object.assign(new EventEmitter(), { listSessions: vi.fn(() => []) });
    mockHookRelay = new EventEmitter();
    mockConfig = { enabled: true, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
  });

  async function newServer() {
    const { RemoteServer } = await import('../src/main/remote-server');
    const { SessionRecords } = await import('../src/main/session-record');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig) as any;
    // WHY a real record (one-core R5-2): the terminal's bytes, epoch and offsets are the record's now; the server appends and relays.
    giveRuntime(server, { records: new SessionRecords() });
    return server;
  }

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

});

// The gear badge used to poll remote:get-client-count every 10 s per window
// (simplification audit W18). The count now rides the status push, so the
// server must announce every arrival and departure through onStatusChange.
describe('RemoteServer status carries the connected-client count', () => {
  let mockSessionManager: any;
  let mockHookRelay: any;
  let mockConfig: any;

  beforeEach(() => {
    mockSessionManager = Object.assign(new EventEmitter(), { listSessions: vi.fn(() => []) });
    mockHookRelay = new EventEmitter();
    mockConfig = { enabled: true, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
  });

  function fakeSocket() {
    return Object.assign(new EventEmitter(), {
      readyState: 1, send: vi.fn(), ping: vi.fn(), close: vi.fn(), terminate: vi.fn(),
    });
  }

  it('emits the status with clientCount on every connect and disconnect', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig) as any;
    const seen: number[] = [];
    server.onStatusChange((st: any) => seen.push(st.clientCount));
    expect(server.getStatus().clientCount).toBe(0);

    const a = fakeSocket();
    const b = fakeSocket();
    server.addClient(a, 'dev-a', '100.64.0.2', { sendsReady: true });
    server.addClient(b, 'dev-b', '100.64.0.3', { sendsReady: true });
    expect(seen).toEqual([1, 2]);
    expect(server.getStatus().clientCount).toBe(2);

    a.emit('close', 1000, Buffer.alloc(0));
    expect(seen).toEqual([1, 2, 1]);
    b.emit('close', 1000, Buffer.alloc(0));
    expect(seen).toEqual([1, 2, 1, 0]);
    expect(server.getStatus().clientCount).toBe(0);
    // A second close for the same socket is not a departure — nothing new is announced.
    b.emit('close', 1000, Buffer.alloc(0));
    expect(seen).toEqual([1, 2, 1, 0]);
  });

  it('the remote:status answer over the socket carries clientCount as a number', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig) as any;
    const sent: any[] = [];
    const ws = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    await server.handleMessage({ ws }, JSON.stringify({ type: 'remote:status', id: 's', payload: {} }));
    expect(sent.pop()?.payload).toMatchObject({ state: expect.any(String), port: expect.any(Number), clientCount: 0 });
  });
});
