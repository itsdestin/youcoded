// RemoteServer (src/main/remote-server.ts) — what a phone gets from the host, driven through a fake
// socket: the page it is served, pairing and auth limits, the catch-up when the phone says it is
// ready, reconnect replay, Refresh, the host log, and the messages it relays.
// WHY not in remote-server.test.ts: that file mocks remote-config, http, session-browser and the
// conversations service for the whole file; these cases use the real ones.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { choosePhonePageSource } from '../src/main/remote-server';

vi.mock('ws', async () => {
  const { EventEmitter: EE } = await import('events');
  class MockWebSocketServer extends EE { clients = new Set(); close = vi.fn((cb?: () => void) => cb?.()); constructor(_o?: unknown) { super(); } }
  const MockWebSocket: { (): void; OPEN: number } = Object.assign(vi.fn(), { OPEN: 1 });
  return { WebSocketServer: MockWebSocketServer, WebSocket: MockWebSocket };
});

// Destin, 2026-09-11: "still flashes the password screen at me on refresh/reconnect and takes a while
// to load back in". The dev window served the phone a copy of the app built the night before
// (dist/renderer, left by an Android test build): the remote server serves a built copy whenever one
// exists, so none of the day's phone-side fixes reached the phone. In development the phone now gets
// live code unless a fresh copy was asked for (run-dev.sh --phone-build), and the log says which.
describe('RemoteServer — the page a phone is served', () => {
  describe('which copy of the app a phone is served', () => {
    it('the installed app serves its built copy', () => {
      expect(choosePhonePageSource({ serveBuiltPage: true, hasBuild: true })).toBe('built');
    });

    it('a dev window serves live code even when an old built copy is on disk', () => {
      expect(choosePhonePageSource({ serveBuiltPage: false, hasBuild: true })).toBe('dev-server');
    });

    it('asked for a built copy that does not exist, it serves live code rather than nothing', () => {
      expect(choosePhonePageSource({ serveBuiltPage: true, hasBuild: false })).toBe('dev-server');
    });
  });
});

describe('RemoteServer — pairing', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'remote-auth-'));
    // The store's path is injectable precisely so this test cannot write the running app's
    // paired devices — the file it replaces had no such seam.
    vi.doMock('../src/main/remote-paths', async () => {
      const actual = await vi.importActual<typeof import('../src/main/remote-paths')>('../src/main/remote-paths');
      return { ...actual, remoteDeviceStorePath: () => join(dir, '.remote-devices.json') };
    });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); vi.resetModules(); vi.doUnmock('../src/main/remote-paths'); });

  /** A socket that records what the server sent and how it closed. */
  class FakeSocket extends EventEmitter {
    sent: Record<string, unknown>[] = [];
    closed: { code: number; reason: string } | null = null;
    readyState = 1;
    send(raw: string) { this.sent.push(JSON.parse(raw)); }
    close(code: number, reason: string) { this.closed = { code, reason }; }
    off(ev: string, fn: (...a: unknown[]) => void) { this.removeListener(ev, fn); return this; }
    last() { return this.sent[this.sent.length - 1]; }
  }

  async function makeServer() {
    const { RemoteServer } = await import('../src/main/remote-server');
    const config = {
      enabled: true, port: 9900, passwordHash: '$2b$10$hash', keepAwakeHours: 0,
      verifyPassword: vi.fn(async (p: string) => p === 'correct-horse'),
      markPaired: vi.fn(), toSafeObject: () => ({}),
    };
    const sessions = Object.assign(new EventEmitter(), { getAllSessions: () => [] });
    const server = new RemoteServer(sessions as never, new EventEmitter() as never, config as never);
    return { server, config };
  }

  /** Drive one connection through the auth handshake. */
  async function connect(server: unknown, auth: Record<string, unknown>) {
    const ws = new FakeSocket();
    (server as { handleConnection(w: unknown, r: unknown): void })
      ['handleConnection'](ws, { socket: { remoteAddress: '127.0.0.1' } });
    ws.emit('message', JSON.stringify({ type: 'auth', ...auth }));
    await new Promise(r => setImmediate(r));
    return ws;
  }

  describe('pairing over the wire', () => {
    it('hands back a credential once, and accepts it next time without the password', async () => {
      const { server } = await makeServer();
      const first = await connect(server, { password: 'correct-horse', deviceName: 'My phone' });
      expect(first.last()!.type).toBe('auth:ok');
      const deviceId = first.last()!.deviceId as string;
      const secret = first.last()!.secret as string;
      expect(secret).toBeTruthy();

      const second = await connect(server, { deviceId, secret });
      expect(second.last()!.type).toBe('auth:ok');
      // The secret is issued at pairing and never again.
      expect(second.last()!.secret).toBeUndefined();
    });

    it('the same browser signing in with the password again keeps its one row', async () => {
      // Destin, 2026-09-11: "each sign in seems to create a new device entry … even though all the
      // same device". The browser names its own row; the host still never matches devices by name.
      const { server } = await makeServer();
      const first = await connect(server, { password: 'correct-horse', deviceName: 'Chrome on Android' });
      const deviceId = first.last()!.deviceId as string;
      const again = await connect(server, { password: 'correct-horse', deviceName: 'Chrome on Android', previousDeviceId: deviceId });
      expect(again.last()).toMatchObject({ type: 'auth:ok', deviceId });
      expect(again.last()!.secret).toBeTruthy();
      expect((server as unknown as { devices: { list(): unknown[] } }).devices.list()).toHaveLength(1);
    });

    it('a device that was unpaired gets a new row when it pairs again', async () => {
      const { server } = await makeServer();
      const first = await connect(server, { password: 'correct-horse', deviceName: 'My phone' });
      const deviceId = first.last()!.deviceId as string;
      (server as unknown as { devices: { revoke(id: string): boolean } }).devices.revoke(deviceId);
      const again = await connect(server, { password: 'correct-horse', deviceName: 'My phone', previousDeviceId: deviceId });
      expect(again.last()!.type).toBe('auth:ok');
      expect(again.last()!.deviceId).not.toBe(deviceId);
    });

    it('refuses the wrong password and does not create a device', async () => {
      const { server } = await makeServer();
      const ws = await connect(server, { password: 'wrong' });
      expect(ws.last()).toEqual({ type: 'auth:failed', reason: 'invalid-credentials' });
      expect(ws.closed?.code).toBe(4001);
    });

    it('an unpaired device is told so, with a terminal close code', async () => {
      // Contract R7. The old server closed the socket and left the credential valid, so the
      // device reconnected immediately. A generic failure would also leave the client retrying.
      const { server } = await makeServer();
      const paired = await connect(server, { password: 'correct-horse', deviceName: 'My phone' });
      const deviceId = paired.last()!.deviceId as string;
      const secret = paired.last()!.secret as string;

      (server as unknown as { devices: { revoke(id: string): boolean } }).devices.revoke(deviceId);

      const back = await connect(server, { deviceId, secret });
      expect(back.last()).toEqual({ type: 'auth:failed', reason: 'revoked' });
      expect(back.closed).toEqual({ code: 4003, reason: 'Device unpaired' });
    });

    it('a credential from the retired token file is told it is retired, not that it guessed wrong', async () => {
      // Upgrade day: every old opaque token arrives at once. Answering "invalid credentials"
      // would count them all as failed guesses and lock the household out of its own host.
      const { server, config } = await makeServer();
      const ws = await connect(server, { deviceId: 'a-legacy-opaque-token' });
      expect(ws.last()).toEqual({ type: 'auth:failed', reason: 'unknown' });
      expect(ws.closed).toEqual({ code: 4004, reason: 'Credential retired' });
      expect(config.verifyPassword).not.toHaveBeenCalled();
    });
  });
});

describe('RemoteServer — auth rate limit', () => {
  // WHY no source reads here any more (Plan B, 2026-09-16): that no failure budget is keyed by
  // network address or shared between connections, and that a burst SLOWS new connections rather
  // than refusing them, are the ast-grep rules no-ip-keyed-failure-bucket and
  // remote-burst-slows-not-refuses. The cases below drive a socket.

  describe('a single connection cannot be used as an unlimited guessing channel', () => {
    it('gives a socket ONE auth attempt and then closes it', async () => {
      // Behaviour, not a grep — and writing it is what found the gap. The source-scan
      // version asserted that `attemptsOnThisSocket` and `AUTH_ATTEMPTS_PER_SOCKET`
      // appeared in the file; they did, and the five-attempt budget they named was
      // unreachable, because the handler detaches itself on the first message and never
      // re-attaches. One attempt per connection is STRICTER than the five the code claimed,
      // so the code was corrected to say one rather than the behaviour loosened to five.
      const { EventEmitter } = await import('node:events');
      const { RemoteServer } = await import('../src/main/remote-server');
      const sessionManager: any = new EventEmitter();
      Object.assign(sessionManager, { listSessions: () => [] });
      const closes: number[] = [];
      const socket: any = new EventEmitter();
      Object.assign(socket, {
        readyState: 1,
        send: () => {},
        close: (code: number) => closes.push(code),
        off: EventEmitter.prototype.off.bind(socket),
      });

      const server: any = new RemoteServer(sessionManager, new EventEmitter() as any, {
        enabled: true, port: 9900, passwordHash: null, toSafeObject: () => ({}),
      } as any);
      server.handleConnection(socket, { socket: { remoteAddress: '100.64.0.9' } });

      for (let i = 0; i < 6; i++) socket.emit('message', JSON.stringify({ type: 'auth', password: 'guess' }));
      await new Promise(r => setImmediate(r));

      // Closed once, on the first attempt, and deaf to the five that followed.
      expect(closes).toHaveLength(1);
      expect(socket.listenerCount('message')).toBe(0);
    });

    it('refuses new sockets once too many sit unauthenticated', async () => {
      const { EventEmitter } = await import('node:events');
      const { RemoteServer } = await import('../src/main/remote-server');
      const sessionManager: any = new EventEmitter();
      Object.assign(sessionManager, { listSessions: () => [] });
      const server: any = new RemoteServer(sessionManager, new EventEmitter() as any, {
        enabled: true, port: 9900, passwordHash: 'x', toSafeObject: () => ({}),
      } as any);

      const makeSocket = () => {
        const s: any = new EventEmitter();
        Object.assign(s, {
          readyState: 1, send: () => {}, closes: [] as number[],
          close: (code: number) => s.closes.push(code),
          off: EventEmitter.prototype.off.bind(s),
        });
        return s;
      };

      // Open 64 sockets that never authenticate — each holds a pre-auth slot.
      const held = [];
      for (let i = 0; i < 64; i++) {
        const s = makeSocket();
        server.handleConnection(s, { socket: { remoteAddress: '127.0.0.1' } });
        held.push(s);
      }
      expect(held.every((s) => s.closes.length === 0)).toBe(true);

      // The 65th is refused immediately with 4009, without consuming a slot.
      const overflow = makeSocket();
      server.handleConnection(overflow, { socket: { remoteAddress: '127.0.0.1' } });
      expect(overflow.closes).toEqual([4009]);

      // When one held socket closes, a slot frees and a new socket is accepted again.
      held[0].emit('close');
      const afterFree = makeSocket();
      server.handleConnection(afterFree, { socket: { remoteAddress: '127.0.0.1' } });
      expect(afterFree.closes).toHaveLength(0);
    });
  });
});

// Remote access batch 2, design §1 A/B and §6 seq (T1): the phone tells the
// host when it is ready, and the host queues every broadcast for it until the
// restore is done — so the chat fills in when the phone is ready, not after a
// timer (contract R6), and nothing is shown twice (R5).
describe('RemoteServer — readiness', () => {
  /** A socket that records every frame the host sent it, in order. */
  class FakeSocket extends EventEmitter {
    frames: any[] = [];
    readyState = 1;
    bufferedAmount = 0;
    send(raw: string) { this.frames.push(JSON.parse(raw)); }
    close() { this.readyState = 3; this.emit('close'); }
    ping() {}
    types() { return this.frames.map((f) => f.type); }
    ofType(type: string) { return this.frames.filter((f) => f.type === type); }
  }

  type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
  function deferred<T>(): Deferred<T> {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }

  const session = (id: string) => ({ id, name: id, cwd: '/tmp', status: 'active' });
  const snapshotOf = (ids: string[]) => ({ sessions: ids.map((id) => [id, { timeline: [], toolCalls: [], toolGroups: [], assistantTurns: [] }]) });

  async function makeServer(opts: { sessions?: string[]; snapshot?: () => Promise<any> } = {}) {
    const { RemoteServer } = await import('../src/main/remote-server');
    const sessions = (opts.sessions ?? ['s1']).map(session);
    const sm = Object.assign(new EventEmitter(), { listSessions: vi.fn(() => sessions) });
    const config = { enabled: true, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
    const requestSnapshot = vi.fn(opts.snapshot ?? (() => Promise.resolve(snapshotOf(opts.sessions ?? ['s1']))));
    const server: any = new RemoteServer(sm as never, new EventEmitter() as never, config as never, undefined, { requestSnapshot });
    return { server, requestSnapshot };
  }

  /** A client past auth: what addClient produces for a socket that just got auth:ok. */
  function connect(server: any) {
    const ws = new FakeSocket();
    server.addClient(ws, 'dev-1', '100.64.0.2');
    const client = [...server.clients].find((c: any) => c.ws === ws);
    return { ws, client };
  }

  const ready = (seq: number, reconnect = false) => JSON.stringify({ type: 'client:ready', payload: { seq, reconnect, ptyOffsets: {} } });
  const tick = () => new Promise((r) => setImmediate(r));

  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); vi.resetModules(); });

  describe('the phone says when it is ready', () => {
    it('a client whose listener registers 300 ms after auth:ok gets the hydrate then, not after the 5 s fallback', async () => {
      const { server } = await makeServer();
      const { ws, client } = connect(server);
      server.onPtyOutput('s1', 'terminal text');
      expect(ws.frames).toEqual([]);                          // nothing before the phone is ready

      vi.advanceTimersByTime(300);
      await server.handleMessage(client, ready(1));

      expect(ws.types()).toEqual(['session:created', 'chat:hydrate', 'pty:output', 'hook:replay-complete']);
      expect(ws.ofType('chat:hydrate')[0].payload.seq).toBe(1);
      expect(ws.ofType('chat:hydrate')[0].payload.sessions.map(([id]: [string]) => id)).toEqual(['s1']);

      vi.advanceTimersByTime(6000);                           // the fallback must not run a second sequence
      await tick();
      expect(ws.ofType('chat:hydrate')).toHaveLength(1);
      expect(ws.ofType('pty:output')).toHaveLength(1);
    });

    it('a client that never sends client:ready receives nothing until the fallback, then the whole sequence', async () => {
      const { server } = await makeServer();
      const { ws } = connect(server);
      server.onPtyOutput('s1', 'terminal text');
      server.bufferHookEvent({ type: 'PermissionRequest', sessionId: 's1', payload: { _requestId: 'r1', tool_name: 'Bash' }, timestamp: 1 });
      server.broadcast({ type: 'transcript:event', payload: { sessionId: 's1', type: 'assistant-text', uuid: 'u1' } });

      vi.advanceTimersByTime(4999);
      await tick();
      expect(ws.frames).toEqual([]);

      vi.advanceTimersByTime(1);
      await tick(); await tick();
      expect(ws.types()).toEqual(['session:created', 'chat:hydrate', 'pty:output', 'hook:event', 'hook:replay-complete']);
      expect(ws.ofType('chat:hydrate')[0].payload.seq).toBeUndefined();   // an old client has no seq to echo
      expect(ws.types()).not.toContain('session:list:response');           // the `_replay` message nothing read
    });

    it('client:ready at 4.9 s yields exactly one hydrate and one replay', async () => {
      const { server } = await makeServer();
      const { ws, client } = connect(server);
      server.onPtyOutput('s1', 'x');
      vi.advanceTimersByTime(4900);
      await server.handleMessage(client, ready(1));
      vi.advanceTimersByTime(2000);
      await tick();
      expect(ws.ofType('chat:hydrate')).toHaveLength(1);
      expect(ws.ofType('pty:output')).toHaveLength(1);
    });

    it('client:ready at 6 s, after the fallback ran, is ignored', async () => {
      const { server } = await makeServer();
      const { ws, client } = connect(server);
      server.onPtyOutput('s1', 'x');
      vi.advanceTimersByTime(5000);
      await tick(); await tick();
      expect(ws.ofType('chat:hydrate')).toHaveLength(1);
      const before = ws.frames.length;

      vi.advanceTimersByTime(1000);
      await server.handleMessage(client, ready(1));
      expect(ws.frames.length).toBe(before);
    });

    it('two client:ready within 100 ms yield one hydrate and one replay', async () => {
      const { server } = await makeServer();
      const { ws, client } = connect(server);
      server.onPtyOutput('s1', 'x');
      const first = server.handleMessage(client, ready(1));
      vi.advanceTimersByTime(50);
      const second = server.handleMessage(client, ready(2));
      await Promise.all([first, second]);
      expect(ws.ofType('chat:hydrate')).toHaveLength(1);
      expect(ws.ofType('pty:output')).toHaveLength(1);
    });

    it('a session:created broadcast between client:ready and the hydrate reaches the client after it', async () => {
      const snap = deferred<any>();
      const { server } = await makeServer({ snapshot: () => snap.promise });
      const { ws, client } = connect(server);
      const restoring = server.handleMessage(client, ready(1));
      await tick();
      server.broadcast({ type: 'session:created', payload: session('s9') });
      expect(ws.types()).not.toContain('chat:hydrate');
      snap.resolve(snapshotOf(['s1']));
      await restoring;
      const types = ws.types();
      expect(types.indexOf('chat:hydrate')).toBeGreaterThan(-1);
      expect(types.lastIndexOf('session:created')).toBeGreaterThan(types.indexOf('chat:hydrate'));
      expect(ws.ofType('session:created').map((f) => f.payload.id)).toEqual(['s1', 's9']);
    });
  });

  describe('the cut line', () => {
    const delta = (sessionId: string, uuid: string) => ({ type: 'transcript:event', payload: { sessionId, type: 'assistant-text', uuid, data: { text: 'x', partId: 'p1' } } });

    it('a per-delta event broadcast before the snapshot request is not re-sent; one broadcast after it is sent once; an omitted session gets both', async () => {
      const snap = deferred<any>();
      const { server } = await makeServer({ sessions: ['s1', 's2'], snapshot: () => snap.promise });
      const { ws, client } = connect(server);

      server.broadcast(delta('s1', 'before-1'));
      server.broadcast(delta('s2', 'before-2'));
      const restoring = server.handleMessage(client, ready(1));
      await tick();
      server.broadcast(delta('s1', 'after-1'));
      server.broadcast(delta('s2', 'after-2'));
      snap.resolve({ ...snapshotOf(['s1']), degraded: true });   // window owning s2 did not answer
      await restoring;

      const uuids = ws.ofType('transcript:event').map((f) => f.payload.uuid);
      expect(uuids).toEqual(['before-2', 'after-1', 'after-2']);
      const hydrateIdx = ws.types().indexOf('chat:hydrate');
      expect(ws.frames.findIndex((f) => f.payload?.uuid === 'after-1')).toBeGreaterThan(hydrateIdx);
    });

    it('lifecycle broadcasts below the cut line are still flushed', async () => {
      const snap = deferred<any>();
      const { server } = await makeServer({ snapshot: () => snap.promise });
      const { ws, client } = connect(server);
      server.broadcast({ type: 'status:data', payload: { contextMap: {} } });
      server.broadcast({ type: 'session:renamed', payload: { sessionId: 's1', name: 'Renamed' } });
      server.broadcast({ type: 'specialists:event', payload: { sessionId: 's1', kind: 'run' } });
      const restoring = server.handleMessage(client, ready(1));
      snap.resolve(snapshotOf(['s1']));
      await restoring;
      const after = ws.types().slice(ws.types().indexOf('chat:hydrate'));
      expect(after).toContain('status:data');
      expect(after).toContain('session:renamed');
      expect(after).toContain('specialists:event');
    });

    it('the queue is bounded at 2,000; overflow drops the oldest and marks the hydrate degraded', async () => {
      const snap = deferred<any>();
      const { server } = await makeServer({ snapshot: () => snap.promise });
      const { ws, client } = connect(server);
      const restoring = server.handleMessage(client, ready(1));
      await tick();
      for (let i = 0; i < 2100; i++) server.broadcast({ type: 'tags:changed', payload: { i } });
      snap.resolve(snapshotOf(['s1']));
      await restoring;
      const flushed = ws.ofType('tags:changed');
      expect(flushed).toHaveLength(2000);
      expect(flushed[0].payload.i).toBe(100);
      expect(ws.ofType('chat:hydrate')[0].payload.degraded).toBe(true);
    });

    it('native per-delta events below the cut line are skipped; native:shell-event and transcript:shrink follow the rule too', async () => {
      const snap = deferred<any>();
      const { server } = await makeServer({ snapshot: () => snap.promise });
      const { ws, client } = connect(server);
      server.broadcast({ type: 'native:session-context', payload: { sessionId: 's1', context: {} } });
      server.broadcast({ type: 'native:model-state', payload: { sessionId: 's1', state: 'x' } });
      server.broadcast({ type: 'transcript:shrink', payload: { sessionId: 's1', keep: 3 } });
      server.broadcast({ type: 'native:shell-event', payload: { sessionId: 's1', run: { shellId: 'sh1' } } });
      // The chip's mode is not chat state — the snapshot never holds it — so it
      // must survive the cut line or a reconnecting phone shows a stale mode.
      server.broadcast({ type: 'native:permission-mode', payload: { sessionId: 's1', mode: 'auto-edit' } });
      const restoring = server.handleMessage(client, ready(1));
      await tick();
      server.broadcast({ type: 'native:model-state', payload: { sessionId: 's1', state: 'y' } });
      snap.resolve(snapshotOf(['s1']));
      await restoring;
      expect(ws.types()).not.toContain('native:session-context');
      expect(ws.types()).not.toContain('transcript:shrink');
      expect(ws.ofType('native:model-state').map((f) => f.payload.state)).toEqual(['y']);
      expect(ws.ofType('native:shell-event')).toHaveLength(1);
      expect(ws.ofType('native:permission-mode').map((f) => f.payload.mode)).toEqual(['auto-edit']);
    });

    it('the cut line survives an overflow that shifts the queue', async () => {
      const snap = deferred<any>();
      const { server } = await makeServer({ snapshot: () => snap.promise });
      const { ws, client } = connect(server);
      for (let i = 0; i < 5; i++) server.broadcast(delta('s1', `below-${i}`));   // cut line will be 5
      const restoring = server.handleMessage(client, ready(1));
      await tick();
      server.broadcast(delta('s1', 'above'));                                   // index 5, above the line
      for (let i = 0; i < 1995; i++) server.broadcast({ type: 'tags:changed', payload: { i } });   // 2001 → one shift
      snap.resolve(snapshotOf(['s1']));
      await restoring;
      // Without moving the cut line with the shift, 'above' would sit at index 4 < 5 and be lost.
      expect(ws.ofType('transcript:event').map((f) => f.payload.uuid)).toEqual(['above']);
    });

    it('a hook event arriving on a FIRST connect before the hook pass is not replayed on top of the pass', async () => {
      const snap = deferred<any>();
      const { server } = await makeServer({ snapshot: () => snap.promise });
      const { ws, client } = connect(server);
      const ask = { type: 'PermissionRequest', sessionId: 's1', payload: { _requestId: 'r1', tool_name: 'Bash' }, timestamp: 1 };
      server.bufferHookEvent(ask);
      server.broadcast({ type: 'hook:event', payload: ask });      // the live copy, before any pass
      const restoring = server.handleMessage(client, ready(1, false));
      snap.resolve(snapshotOf(['s1']));
      await restoring;
      expect(ws.ofType('hook:event')).toHaveLength(1);            // the buffer pass, once
    });

    it('a hook event arriving on a RECONNECT during the restore is queued and flushed', async () => {
      const snap = deferred<any>();
      const { server } = await makeServer({ snapshot: () => snap.promise });
      const { ws, client } = connect(server);
      const resolved = { type: 'PermissionResolved', sessionId: 's1', payload: { _requestId: 'r1' }, timestamp: 2 };
      const restoring = server.handleMessage(client, ready(1, true));
      await tick();
      server.broadcast({ type: 'hook:event', payload: resolved });
      snap.resolve(snapshotOf(['s1']));
      await restoring;
      expect(ws.ofType('hook:event').map((f) => f.payload.type)).toEqual(['PermissionResolved']);
    });
  });
});

// Remote access batch 2, design §7 (T2): a reconnect is cheap, exact, and does
// not lie about consent — the host sends only the terminal units the phone has
// not drawn, resets when it cannot, replays only unresolved permission asks and
// says which ones are still open, and pauses rather than drowning a slow phone.
describe('RemoteServer — reconnect replay', () => {
  class FakeSocket extends EventEmitter {
    frames: any[] = [];
    readyState = 1;
    bufferedAmount = 0;
    closed: { code: number; reason: string } | null = null;
    /** Runs after each frame is recorded — lets a test act at an exact point in the restore. */
    onSend: ((msg: any) => void) | null = null;
    send(raw: string) { const msg = JSON.parse(raw); this.frames.push(msg); this.onSend?.(msg); }
    close(code = 1000, reason = '') { this.readyState = 3; this.closed = { code, reason }; this.emit('close'); }
    ping() {}
    types() { return this.frames.map((f) => f.type); }
    ofType(type: string) { return this.frames.filter((f) => f.type === type); }
    /** Everything the terminal for `sid` was told to draw, in order, resets marked. */
    terminal(sid: string) {
      return this.frames
        .filter((f) => (f.type === 'pty:output' || f.type === 'pty:reset') && f.payload.sessionId === sid)
        .map((f) => (f.type === 'pty:reset' ? '<RESET>' : f.payload.data)).join('');
    }
  }

  const session = (id: string) => ({ id, name: id, cwd: '/tmp', status: 'active' });
  const snapshotOf = (ids: string[]) => ({ sessions: ids.map((id) => [id, { timeline: [], toolCalls: [], toolGroups: [], assistantTurns: [] }]) });

  async function makeServer(opts: { sessions?: string[]; snapshot?: () => Promise<any> } = {}) {
    const { RemoteServer } = await import('../src/main/remote-server');
    const ids = opts.sessions ?? ['s1'];
    const sm = Object.assign(new EventEmitter(), { listSessions: vi.fn(() => ids.map(session)) });
    const hookRelay = Object.assign(new EventEmitter(), { respond: vi.fn(() => true) });
    const config = { enabled: true, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
    const requestSnapshot = vi.fn(opts.snapshot ?? (() => Promise.resolve(snapshotOf(ids))));
    const server: any = new RemoteServer(sm as never, hookRelay as never, config as never, undefined, { requestSnapshot });
    return { server, hookRelay };
  }

  function connect(server: any) {
    const ws = new FakeSocket();
    server.addClient(ws, 'dev-1', '100.64.0.2');
    const client = [...server.clients].find((c: any) => c.ws === ws);
    return { ws, client };
  }

  const ready = (seq: number, reconnect: boolean, ptyOffsets: Record<string, { epoch: string; units: number }> = {}) =>
    JSON.stringify({ type: 'client:ready', payload: { seq, reconnect, ptyOffsets } });

  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); vi.resetModules(); });

  describe('the terminal replay is exact', () => {
    it('every live pty:output carries the buffer epoch and the chunk offset', async () => {
      const { server } = await makeServer();
      const { ws, client } = connect(server);
      await server.handleMessage(client, ready(1, false));
      server.onPtyOutput('s1', 'abc');
      server.onPtyOutput('s1', 'defg');
      const out = ws.ofType('pty:output');
      expect(out.map((f) => f.payload.offset)).toEqual([0, 3]);
      expect(typeof out[0].payload.epoch).toBe('string');
      expect(out[1].payload.epoch).toBe(out[0].payload.epoch);
    });

    it('a phone offset mid-chunk receives exactly the units past it, no reset', async () => {
      const { server } = await makeServer();
      server.onPtyOutput('s1', 'hello ');
      server.onPtyOutput('s1', 'world');
      const epoch = server.ptyBuffers.get('s1').epoch;
      const { ws, client } = connect(server);
      await server.handleMessage(client, ready(2, true, { s1: { epoch, units: 3 } }));
      expect(ws.types()).not.toContain('pty:reset');
      const out = ws.ofType('pty:output');
      expect(out).toHaveLength(1);
      expect(out[0].payload).toMatchObject({ sessionId: 's1', data: 'lo world', offset: 3, epoch });
    });

    it('a phone that is fully up to date receives nothing for the terminal', async () => {
      const { server } = await makeServer();
      server.onPtyOutput('s1', 'hello');
      const epoch = server.ptyBuffers.get('s1').epoch;
      const { ws, client } = connect(server);
      await server.handleMessage(client, ready(2, true, { s1: { epoch, units: 5 } }));
      expect(ws.ofType('pty:output')).toHaveLength(0);
      expect(ws.ofType('pty:reset')).toHaveLength(0);
    });

    it('an epoch mismatch resets, then sends the whole buffer', async () => {
      const { server } = await makeServer();
      server.onPtyOutput('s1', 'after restart');
      const { ws, client } = connect(server);
      await server.handleMessage(client, ready(2, true, { s1: { epoch: 'from-before', units: 4 } }));
      expect(ws.terminal('s1')).toBe('<RESET>after restart');
      const reset = ws.ofType('pty:reset')[0];
      expect(reset.payload).toEqual({ sessionId: 's1', epoch: server.ptyBuffers.get('s1').epoch });
      expect(ws.types().indexOf('pty:reset')).toBeLessThan(ws.types().indexOf('pty:output'));
    });

    it('an offset beyond what the host holds resets', async () => {
      const { server } = await makeServer();
      server.onPtyOutput('s1', 'short');
      const epoch = server.ptyBuffers.get('s1').epoch;
      const { ws, client } = connect(server);
      await server.handleMessage(client, ready(2, true, { s1: { epoch, units: 99 } }));
      expect(ws.terminal('s1')).toBe('<RESET>short');
    });

    it('an offset below a trimmed head resets — base advances on every head trim, the single-chunk slice included', async () => {
      const { server, } = await makeServer();
      const CAP = 4 * 1024 * 1024;
      // Whole-chunk trims: 5 × 1 MiB through a 4 MiB cap drops the first chunk.
      for (let i = 0; i < 5; i++) server.onPtyOutput('s1', String.fromCharCode(97 + i).repeat(1024 * 1024));
      let buf = server.ptyBuffers.get('s1');
      expect(buf.base).toBe(1024 * 1024);
      expect(buf.base + buf.length).toBe(5 * 1024 * 1024);   // the stream position never goes backwards
      const epoch = buf.epoch;
      const { ws, client } = connect(server);
      await server.handleMessage(client, ready(2, true, { s1: { epoch, units: 100 } }));  // below the head
      expect(ws.ofType('pty:reset')).toHaveLength(1);
      expect(ws.ofType('pty:output')[0].payload.offset).toBe(1024 * 1024);

      // The single-chunk slice: one read larger than the cap.
      server.onPtyOutput('s2', 'z'.repeat(CAP + 5000));
      buf = server.ptyBuffers.get('s2');
      expect(buf.base).toBe(5000);
      expect(buf.length).toBe(CAP);
    });

    it('sends only the units past the cursor on a second pass, so output during a paused send is not lost or doubled', async () => {
      let snap: (v: any) => void = () => {};
      const { server } = await makeServer({ snapshot: () => new Promise((r) => { snap = r; }) });
      server.onPtyOutput('s1', 'before ');
      const { ws, client } = connect(server);
      const restoring = server.handleMessage(client, ready(1, false));
      await Promise.resolve();
      server.onPtyOutput('s1', 'during ');          // arrives while the snapshot is in flight — not queued, not lost
      snap(snapshotOf(['s1']));
      await restoring;
      server.onPtyOutput('s1', 'after');
      expect(ws.terminal('s1')).toBe('before during after');
    });
  });

  describe('consent does not lie', () => {
    const ask = (requestId: string, sessionId = 's1') =>
      ({ type: 'PermissionRequest', sessionId, payload: { _requestId: requestId, tool_name: 'Bash' }, timestamp: 1 });

    it('replays only unresolved permission requests and ends every session with hook:replay-complete', async () => {
      const { server } = await makeServer({ sessions: ['s1', 's2'] });
      server.bufferHookEvent(ask('answered'));
      server.bufferHookEvent(ask('open'));
      server.bufferHookEvent({ type: 'PermissionResolved', sessionId: 's1', payload: { _requestId: 'answered' }, timestamp: 2 });
      const { ws, client } = connect(server);
      await server.handleMessage(client, ready(2, true));
      expect(ws.ofType('hook:event').map((f) => f.payload.payload._requestId)).toEqual(['open']);
      const done = ws.ofType('hook:replay-complete').map((f) => f.payload);
      expect(done).toEqual([
        { sessionId: 's1', pendingRequestIds: ['open'] },
        { sessionId: 's2', pendingRequestIds: [] },          // a session with no hook history still gets one
      ]);
      // The completion comes after the last replayed ask, never before it.
      expect(ws.types().lastIndexOf('hook:event')).toBeLessThan(ws.types().indexOf('hook:replay-complete'));
    });

    it('answering a Claude Code ask on the computer emits PermissionResolved, so the host buffer forgets it', async () => {
      const { HookRelay } = await import('../src/main/hook-relay');
      const relay: any = new HookRelay();
      const socket = { write: vi.fn(), end: vi.fn(), destroyed: false };
      relay.pendingSockets.set('cc-1', { socket, sessionId: 's1' });
      const events: any[] = [];
      relay.on('hook-event', (e: any) => events.push(e));
      expect(relay.respond('cc-1', { decision: { behavior: 'allow' } })).toBe(true);
      expect(socket.write).toHaveBeenCalled();
      await Promise.resolve();                     // announced after the current emit (see respond)
      expect(events).toEqual([expect.objectContaining({ type: 'PermissionResolved', sessionId: 's1', payload: { _requestId: 'cc-1' } })]);

      const { server } = await makeServer();
      server.bufferHookEvent(ask('cc-1'));
      server.onHookEvent(events[0]);
      expect(server.hookBuffers.get('s1')).toEqual([]);
    });

    it('a request that arrives and is answered during the snapshot wait shows no card after the flush', async () => {
      let snap: (v: any) => void = () => {};
      const { server } = await makeServer({ snapshot: () => new Promise((r) => { snap = r; }) });
      const { ws, client } = connect(server);
      const restoring = server.handleMessage(client, ready(2, true));
      await Promise.resolve();
      const request = ask('quick');
      server.onHookEvent(request);                                                     // buffered + broadcast (queued)
      server.onHookEvent({ type: 'PermissionResolved', sessionId: 's1', payload: { _requestId: 'quick' }, timestamp: 2 });
      snap(snapshotOf(['s1']));
      await restoring;
      // Design test 7: "shows no card after the flush". The request and its resolution were
      // both queued in this restore and the snapshot never held the card, so the request is
      // not flushed at all; the resolution still is (a card the snapshot DID hold needs it).
      expect(ws.ofType('hook:event').map((f) => f.payload.type)).toEqual(['PermissionResolved']);
      expect(ws.ofType('hook:replay-complete')[0].payload.pendingRequestIds).toEqual([]);
      // Run what the phone received through its own dispatcher and reducer: no card.
      const { hookEventToAction } = await import('../src/renderer/state/hook-dispatcher');
      const { chatReducer } = await import('../src/renderer/state/chat-reducer');
      let phone: any = chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: 's1' });
      for (const f of ws.frames) {
        if (f.type !== 'hook:event') continue;
        const action = hookEventToAction(f.payload);
        if (action) phone = chatReducer(phone, action);
      }
      expect([...phone.get('s1').toolCalls.values()]).toEqual([]);
    });
  });

  describe('backpressure', () => {
    it('pauses the replay above 8 MB buffered, resumes as it drains, and loses nothing arriving meanwhile', async () => {
      const { server } = await makeServer();
      server.onPtyOutput('s1', 'first ');
      const { ws, client } = connect(server);
      ws.bufferedAmount = 9 * 1024 * 1024;
      const restoring = server.handleMessage(client, ready(2, true));
      await Promise.resolve(); await Promise.resolve();
      // Paused before the first frame; the host is waiting for the socket to drain.
      expect(ws.frames).toEqual([]);
      server.onPtyOutput('s1', 'second');
      server.onHookEvent({ type: 'PermissionRequest', sessionId: 's1', payload: { _requestId: 'r1', tool_name: 'Bash' }, timestamp: 1 });
      vi.advanceTimersByTime(200);
      await Promise.resolve();
      expect(ws.frames).toEqual([]);                                   // still paused — still above the mark
      ws.bufferedAmount = 0;
      vi.advanceTimersByTime(200);
      await restoring;
      expect(ws.terminal('s1')).toBe('first second');                // the output during the pause, exactly once
      expect(ws.ofType('hook:event').map((f) => f.payload.payload._requestId)).toEqual(['r1']);   // exactly once
      expect(client.phase).toBe('live');
    });

    it('closes a client above 32 MB with the reconnect code', async () => {
      const { server } = await makeServer();
      server.onPtyOutput('s1', 'x');
      const { ws, client } = connect(server);
      ws.bufferedAmount = 33 * 1024 * 1024;
      await server.handleMessage(client, ready(2, true));
      expect(ws.closed?.code).toBe(4009);
    });
  });


  // Review of T2 (2026-09-10) and the cursor bug found fixing it.
  describe('the replay under a paused send', () => {
    const MB = 1024 * 1024;
    async function drain(ws: FakeSocket, restoring: Promise<unknown>) {
      ws.bufferedAmount = 0;
      await vi.advanceTimersByTimeAsync(200);
      await restoring;
    }

    it('output that arrives while a terminal send is paused is sent next pass — not skipped, not doubled', async () => {
      const { server } = await makeServer();
      server.onPtyOutput('s1', 'first ');
      const { ws, client } = connect(server);
      ws.onSend = (msg) => {
        if (msg.type === 'hook:replay-complete') {          // the first pass is done; pause the next send
          ws.onSend = null;
          server.onPtyOutput('s1', 'second ');
          ws.bufferedAmount = 9 * MB;
        }
      };
      const restoring = server.handleMessage(client, ready(2, true));
      await vi.advanceTimersByTimeAsync(100);
      server.onPtyOutput('s1', 'third');                     // lands DURING the paused send of 'second '
      await drain(ws, restoring);
      expect(ws.terminal('s1')).toBe('first second third');
    });

    it('a message broadcast during the final terminal pass is still delivered', async () => {
      const { server } = await makeServer();
      const { ws, client } = connect(server);
      ws.onSend = (msg) => {
        if (msg.type === 'hook:replay-complete') {
          ws.onSend = null;
          server.onPtyOutput('s1', 'late output');
          ws.bufferedAmount = 9 * MB;
        }
      };
      const restoring = server.handleMessage(client, ready(2, true));
      await vi.advanceTimersByTimeAsync(100);
      server.onHookEvent({ type: 'PermissionRequest', sessionId: 's1', payload: { _requestId: 'during', tool_name: 'Bash' }, timestamp: 1 });
      await drain(ws, restoring);
      expect(ws.ofType('hook:event').map((f) => f.payload.payload._requestId)).toEqual(['during']);
      expect(client.phase).toBe('live');
    });

    it('when the head trim overtakes the cursor during a pause, the terminal is reset, never silently skipped', async () => {
      const { server } = await makeServer();
      server.onPtyOutput('s1', 'x'.repeat(1000));
      const { ws, client } = connect(server);
      ws.onSend = (msg) => {
        if (msg.type === 'hook:replay-complete') {
          ws.onSend = null;
          server.onPtyOutput('s1', 'y');
          ws.bufferedAmount = 9 * MB;
        }
      };
      const restoring = server.handleMessage(client, ready(2, true));
      await vi.advanceTimersByTimeAsync(100);
      for (let i = 0; i < 5; i++) server.onPtyOutput('s1', String.fromCharCode(97 + i).repeat(MB));   // 5M > 4M window
      await drain(ws, restoring);
      const buf = server.ptyBuffers.get('s1');
      const resets = ws.frames.filter((f) => f.type === 'pty:reset');
      expect(resets).toHaveLength(1);
      const afterReset = ws.frames.slice(ws.frames.indexOf(resets[0]) + 1).filter((f) => f.type === 'pty:output');
      expect(afterReset[0].payload.offset).toBe(buf.base);
      expect(afterReset.map((f) => f.payload.data).join('')).toBe(buf.chunks.join(''));
    });

    it('hook events added while the hook pass is paused are sent once', async () => {
      const { server } = await makeServer();
      server.bufferHookEvent({ type: 'Notification', sessionId: 's1', payload: { n: 1 }, timestamp: 1 });
      server.bufferHookEvent({ type: 'Notification', sessionId: 's1', payload: { n: 2 }, timestamp: 1 });
      const { ws, client } = connect(server);
      ws.onSend = (msg) => {
        if (msg.type === 'hook:event' && msg.payload.payload.n === 1) { ws.onSend = null; ws.bufferedAmount = 9 * MB; }
      };
      const restoring = server.handleMessage(client, ready(1, false));
      await vi.advanceTimersByTimeAsync(100);
      server.onHookEvent({ type: 'Notification', sessionId: 's1', payload: { n: 3 }, timestamp: 1 });
      await drain(ws, restoring);
      expect(ws.ofType('hook:event').map((f) => f.payload.payload.n)).toEqual([1, 2, 3]);
    });

    it('a live client that stops reading is closed above 32 MB instead of buffered without bound', async () => {
      const { server } = await makeServer();
      const { ws, client } = connect(server);
      await server.handleMessage(client, ready(1, false));
      ws.bufferedAmount = 33 * MB;
      server.onPtyOutput('s1', 'more');
      expect(ws.closed?.code).toBe(4009);
    });
  });

  describe('exact slicing at the edges', () => {
    it('an offset exactly at a trimmed window\'s start gets the whole window with no reset', async () => {
      const { server } = await makeServer();
      for (let i = 0; i < 5; i++) server.onPtyOutput('s1', String.fromCharCode(97 + i).repeat(1024 * 1024));
      const buf = server.ptyBuffers.get('s1');
      const { ws, client } = connect(server);
      await server.handleMessage(client, ready(2, true, { s1: { epoch: buf.epoch, units: buf.base } }));
      expect(ws.ofType('pty:reset')).toHaveLength(0);
      expect(ws.terminal('s1')).toBe(buf.chunks.join(''));
    });

    it('an offset inside the second of several chunks slices across the chunk boundary', async () => {
      const { server } = await makeServer();
      server.onPtyOutput('s1', 'a'.repeat(5000));
      server.onPtyOutput('s1', 'b'.repeat(5000));
      server.onPtyOutput('s1', 'c'.repeat(5000));
      const buf = server.ptyBuffers.get('s1');
      expect(buf.chunks.length).toBe(3);
      const { ws, client } = connect(server);
      await server.handleMessage(client, ready(2, true, { s1: { epoch: buf.epoch, units: 7000 } }));
      expect(ws.terminal('s1')).toBe('b'.repeat(3000) + 'c'.repeat(5000));
    });
  });

  describe('which asks are still open', () => {
    it('an ask the snapshot shows awaiting is listed pending even when the host buffer never saw it', async () => {
      // Remote access switched on after the ask was raised, or the buffer trimmed it: the
      // desktop's own copy is the truth for a session the snapshot holds (T2 review, 6).
      const snap = { sessions: [['s1', { timeline: [], toolCalls: [['t1', { toolUseId: 't1', toolName: 'Bash', input: {}, status: 'awaiting-approval', requestId: 'pre-remote' }]], toolGroups: [], assistantTurns: [] }]] };
      const { server } = await makeServer({ snapshot: () => Promise.resolve(snap) });
      const { ws, client } = connect(server);
      await server.handleMessage(client, ready(2, true));
      expect(ws.ofType('hook:replay-complete')[0].payload).toEqual({ sessionId: 's1', pendingRequestIds: ['pre-remote'] });
    });

    it('a Claude Code ask whose socket closed is purged, the phone is told it expired, and a phone that was away is replayed that', async () => {
      const { server } = await makeServer();
      const { ws, client } = connect(server);
      await server.handleMessage(client, ready(1, false));
      server.bufferHookEvent({ type: 'PermissionRequest', sessionId: 's1', payload: { _requestId: 'cc-dead', tool_name: 'Bash' }, timestamp: 1 });
      server.onPermissionExpired('s1', 'cc-dead');
      expect(server.hookBuffers.get('s1').map((e: any) => e.type)).toEqual(['PermissionExpired']);
      expect(ws.ofType('hook:event').map((f) => [f.payload.type, f.payload.payload._requestId])).toEqual([['PermissionExpired', 'cc-dead']]);

      // A phone that was away reconnects: it hears "expired", not a replay-complete that
      // would clear its card as "Answered on the computer" (T2 re-review, 7).
      const away = connect(server);
      await server.handleMessage(away.client, ready(2, true));
      const types = away.ws.types();
      expect(away.ws.ofType('hook:event').map((f) => f.payload.type)).toEqual(['PermissionExpired']);
      expect(types.indexOf('hook:event')).toBeLessThan(types.indexOf('hook:replay-complete'));
      expect(away.ws.ofType('hook:replay-complete')[0].payload.pendingRequestIds).toEqual([]);
    });

    it('first connect: an ask the snapshot shows awaiting but answered during the snapshot wait is not listed open, and its resolution still reaches the phone', async () => {
      // The snapshot is exported while r1 is open; r1 is answered before the hook pass.
      // Listing it pending from the snapshot while skipping its queued resolution left live
      // buttons for a dead question (T2 re-review, 1).
      let resolveSnap: (v: any) => void = () => {};
      const { server } = await makeServer({ snapshot: () => new Promise((r) => { resolveSnap = r; }) });
      server.onHookEvent({ type: 'PermissionRequest', sessionId: 's1', payload: { _requestId: 'r1', tool_name: 'Bash' }, timestamp: 1 });
      const { ws, client } = connect(server);
      const restoring = server.handleMessage(client, ready(1, false));
      await Promise.resolve();
      server.onHookEvent({ type: 'PermissionResolved', sessionId: 's1', payload: { _requestId: 'r1' }, timestamp: 2 });
      resolveSnap({ sessions: [['s1', { timeline: [], toolGroups: [], assistantTurns: [], toolCalls: [['t1', { toolUseId: 't1', toolName: 'Bash', input: {}, status: 'awaiting-approval', requestId: 'r1' }]] }]] });
      await restoring;
      expect(ws.ofType('hook:replay-complete')[0].payload.pendingRequestIds).toEqual([]);
      expect(ws.ofType('hook:event').map((f) => f.payload.type)).toContain('PermissionResolved');
    });

    it('the relay announces a resolution only after every listener has seen the request', async () => {
      // Remote access switched on after boot registers RemoteServer's listener AFTER main's
      // auto-approve listener; a synchronous Resolved purged nothing and the Request stayed
      // buffered as open forever (T2 review, 7).
      const { HookRelay } = await import('../src/main/hook-relay');
      const relay: any = new HookRelay();
      const socket = { write: vi.fn(), end: vi.fn(), destroyed: false };
      relay.pendingSockets.set('auto', { socket, sessionId: 's1' });
      const request = { type: 'PermissionRequest', sessionId: 's1', payload: { _requestId: 'auto' }, timestamp: 1 };
      relay.on('hook-event', (e: any) => { if (e.type === 'PermissionRequest') relay.respond('auto', { decision: { behavior: 'allow' } }); });
      const { server } = await makeServer();
      relay.on('hook-event', server.onHookEvent);
      relay.emit('hook-event', request);
      await Promise.resolve();
      expect(server.hookBuffers.get('s1')).toEqual([]);
    });
  });
});

// Remote access batch 2, design §6 (T4): Refresh is a restore — the host moves
// that client back to restoring, takes the snapshot, sends chat:hydrate {seq},
// flushes with the same cut line and returns it to live, without the terminal
// and permission replays.
describe('RemoteServer — refresh', () => {
  class FakeSocket extends EventEmitter {
    frames: any[] = [];
    readyState = 1;
    bufferedAmount = 0;
    send(raw: string) { this.frames.push(JSON.parse(raw)); }
    close() { this.readyState = 3; this.emit('close'); }
    ping() {}
    types() { return this.frames.map((f) => f.type); }
    ofType(type: string) { return this.frames.filter((f) => f.type === type); }
  }

  const session = (id: string) => ({ id, name: id, cwd: '/tmp', status: 'active' });
  const snapshotOf = (ids: string[]) => ({ sessions: ids.map((id) => [id, { timeline: [], toolCalls: [], toolGroups: [], assistantTurns: [] }]) });

  async function makeServer(snapshot: () => Promise<any> = () => Promise.resolve(snapshotOf(['s1']))) {
    const { RemoteServer } = await import('../src/main/remote-server');
    const sm = Object.assign(new EventEmitter(), { listSessions: vi.fn(() => [session('s1')]) });
    const config = { enabled: true, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
    const server: any = new RemoteServer(sm as never, new EventEmitter() as never, config as never, undefined, { requestSnapshot: vi.fn(snapshot) });
    return server;
  }

  async function liveClient(server: any) {
    const ws = new FakeSocket();
    server.addClient(ws, 'dev-1', '100.64.0.2');
    const client = [...server.clients].find((c: any) => c.ws === ws);
    await server.handleMessage(client, JSON.stringify({ type: 'client:ready', payload: { seq: 1, reconnect: false, ptyOffsets: {} } }));
    ws.frames = [];
    return { ws, client };
  }

  const rehydrate = (seq: number, id = `r${seq}`) => JSON.stringify({ type: 'remote:rehydrate', id, payload: { seq } });
  const tick = () => new Promise((r) => setImmediate(r));

  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); vi.resetModules(); });

  describe('remote:rehydrate on the host', () => {
    it('answers ok, sends chat:hydrate with the client\'s seq, replays no terminal or permissions, and goes live', async () => {
      const server = await makeServer();
      const { ws, client } = await liveClient(server);
      server.onPtyOutput('s1', 'already drawn');
      ws.frames = [];

      await server.handleMessage(client, rehydrate(5));
      await tick();
      expect(ws.ofType('remote:rehydrate:response')[0].payload).toEqual({ ok: true });
      expect(ws.ofType('chat:hydrate').map((f) => f.payload.seq)).toEqual([5]);
      expect(ws.types()).not.toContain('pty:output');
      expect(ws.types()).not.toContain('pty:reset');
      expect(ws.types()).not.toContain('hook:replay-complete');
      expect(client.phase).toBe('live');
    });

    it('a transcript event broadcast during the refresh reaches the phone once, after the hydrate', async () => {
      let resolveSnap: (v: any) => void = () => {};
      let calls = 0;
      const server = await makeServer(() => {
        calls++;
        return calls === 1 ? Promise.resolve(snapshotOf(['s1'])) : new Promise((r) => { resolveSnap = r; });
      });
      const { ws, client } = await liveClient(server);

      const refreshing = server.handleMessage(client, rehydrate(2));
      await tick();
      expect(client.phase).not.toBe('live');
      server.broadcast({ type: 'transcript:event', payload: { sessionId: 's1', type: 'assistant-text', uuid: 'during' } });
      resolveSnap(snapshotOf(['s1']));
      await refreshing;
      await tick();
      const types = ws.types();
      expect(ws.ofType('transcript:event').map((f) => f.payload.uuid)).toEqual(['during']);
      expect(types.indexOf('transcript:event')).toBeGreaterThan(types.indexOf('chat:hydrate'));
      expect(client.phase).toBe('live');
    });

    it('a refresh asked for while a restore is still running runs after it, with its own seq', async () => {
      let resolveFirst: (v: any) => void = () => {};
      let calls = 0;
      const server = await makeServer(() => {
        calls++;
        return calls === 1 ? new Promise((r) => { resolveFirst = r; }) : Promise.resolve(snapshotOf(['s1']));
      });
      const ws = new FakeSocket();
      server.addClient(ws, 'dev-1', '100.64.0.2');
      const client = [...server.clients].find((c: any) => c.ws === ws);
      const restoring = server.handleMessage(client, JSON.stringify({ type: 'client:ready', payload: { seq: 1, reconnect: false, ptyOffsets: {} } }));
      await tick();
      await server.handleMessage(client, rehydrate(2));
      resolveFirst(snapshotOf(['s1']));
      await restoring;
      // The follow-up restore runs on its own; wait for it to finish (a bounded number of turns).
      for (let i = 0; i < 20 && (ws.ofType('chat:hydrate').length < 2 || client.phase !== 'live'); i++) await tick();
      expect(ws.ofType('chat:hydrate').map((f) => f.payload.seq)).toEqual([1, 2]);
      expect(client.phase).toBe('live');
    });

    // Review of T4 (2026-09-10): a Refresh skips the full terminal replay, but output that
    // arrives WHILE it runs is not broadcast to a restoring client — it must still arrive.
    it('terminal output produced during a Refresh reaches the phone once, with no reset', async () => {
      let resolveSnap: (v: any) => void = () => {};
      let calls = 0;
      const server = await makeServer(() => {
        calls++;
        return calls === 1 ? Promise.resolve(snapshotOf(['s1'])) : new Promise((r) => { resolveSnap = r; });
      });
      const { ws, client } = await liveClient(server);
      server.onPtyOutput('s1', 'before ');                   // live, straight through
      const refreshing = server.handleMessage(client, rehydrate(2));
      await tick();
      server.onPtyOutput('s1', 'during');
      resolveSnap(snapshotOf(['s1']));
      await refreshing;
      for (let i = 0; i < 20 && client.phase !== 'live'; i++) await tick();
      const drawn = ws.frames.filter((f) => f.type === 'pty:output').map((f) => f.payload.data).join('');
      expect(drawn).toBe('before during');
      expect(ws.types()).not.toContain('pty:reset');
    });

    it('a restore that throws still delivers what was queued and goes live', async () => {
      const server = await makeServer();
      const { ws, client } = await liveClient(server);
      server.sessionManager.listSessions = () => { throw new Error('boom'); };
      const refreshing = server.handleMessage(client, rehydrate(3));
      server.broadcast({ type: 'tags:changed', payload: { queued: true } });
      await refreshing;
      for (let i = 0; i < 20 && client.phase !== 'live'; i++) await tick();
      expect(client.phase).toBe('live');
      expect(ws.ofType('tags:changed')).toHaveLength(1);
    });
  });
});

// Remote access, 2026-09-11 phone pass — the host half of the reliability fixes
// (docs/active/reviews/2026-09-11-remote-batch-2-3-phone-pass.md, investigation items 5–7):
//  - the dev log said `client:ready ignored in phase live`: a phone's page took more than 5 s to
//    start listening, the host's 5 s fallback ran the catch-up into a page that could not hear
//    it, and the phone showed "may be out of date";
//  - reads a phone's screens load at start were "unhandled channel", so those screens were empty;
//  - the host logged no connects, drops or catch-ups, so none of this could be traced.
describe('RemoteServer — reliability', () => {
  class FakeSocket extends EventEmitter {
    frames: any[] = [];
    readyState = 1;
    bufferedAmount = 0;
    send(raw: string) { this.frames.push(JSON.parse(raw)); }
    close(code = 1000, reason = '') { this.readyState = 3; this.emit('close', code, Buffer.from(reason)); }
    ping() {}
    ofType(type: string) { return this.frames.filter((f) => f.type === type); }
  }

  let dir: string;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    dir = mkdtempSync(join(tmpdir(), 'remote-host-rel-'));
    vi.doMock('../src/main/remote-paths', async () => {
      const actual = await vi.importActual<typeof import('../src/main/remote-paths')>('../src/main/remote-paths');
      return { ...actual, remoteDeviceStorePath: () => join(dir, '.remote-devices.json') };
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    vi.resetModules();
    vi.doUnmock('../src/main/remote-paths');
    vi.restoreAllMocks();
  });

  const tick = () => new Promise((r) => setImmediate(r));

  async function makeServer(opts: Record<string, unknown> = {}, skillProvider?: unknown) {
    const { RemoteServer } = await import('../src/main/remote-server');
    const config = {
      enabled: true, port: 9900, passwordHash: '$2b$10$hash', keepAwakeHours: 0,
      verifyPassword: vi.fn(async (p: string) => p === 'correct-horse'),
      markPaired: vi.fn(), toSafeObject: () => ({}),
    };
    const sessions = Object.assign(new EventEmitter(), { listSessions: () => [], getAllSessions: () => [] });
    return new RemoteServer(sessions as never, new EventEmitter() as never, config as never, skillProvider as never, opts as never) as any;
  }

  async function signIn(server: any, auth: Record<string, unknown>) {
    const ws = new FakeSocket();
    server.handleConnection(ws, { socket: { remoteAddress: '127.0.0.1' } });
    ws.emit('message', JSON.stringify({ type: 'auth', password: 'correct-horse', deviceName: 'Phone', ...auth }));
    await tick(); await tick();
    expect(ws.ofType('auth:ok')).toHaveLength(1);
    return ws;
  }

  const send = async (ws: FakeSocket, msg: unknown) => { ws.emit('message', JSON.stringify(msg)); await tick(); await tick(); };

  describe('the catch-up waits for a page that says it will announce readiness', () => {
    it('is not sent into the page at 5 s, and goes out when the page says ready', async () => {
      const server = await makeServer();
      const ws = await signIn(server, { readyHandshake: true });
      await vi.advanceTimersByTimeAsync(10_000);
      await tick();
      expect(ws.ofType('chat:hydrate')).toHaveLength(0);
      await send(ws, { type: 'client:ready', payload: { seq: 1, reconnect: false, ptyOffsets: {} } });
      expect(ws.ofType('chat:hydrate').map((f) => f.payload.seq)).toEqual([1]);
    });

    it('a page that announced it but never says ready still gets the catch-up, later', async () => {
      const server = await makeServer();
      const ws = await signIn(server, { readyHandshake: true });
      await vi.advanceTimersByTimeAsync(30_000);
      await tick(); await tick();
      expect(ws.ofType('chat:hydrate')).toHaveLength(1);
    });

    it('an older page that announces nothing keeps the 5 s fallback', async () => {
      const server = await makeServer();
      const ws = await signIn(server, {});
      await vi.advanceTimersByTimeAsync(5_000);
      await tick(); await tick();
      expect(ws.ofType('chat:hydrate')).toHaveLength(1);
    });
  });

  describe('what a phone asks on waking and at start is answered', () => {
    it('remote:ping is answered at once, even while the phone is still catching up', async () => {
      const server = await makeServer();
      const ws = await signIn(server, { readyHandshake: true });
      await send(ws, { type: 'remote:ping', id: 'p1' });
      expect(ws.ofType('remote:ping:response')[0].payload).toEqual({ ok: true });
    });

    it('theme list, commands, favourite themes and the platform come from the same code as the desktop', async () => {
      const skillProvider = { configStore: { getThemeFavorites: () => ['meadow-mist'] } };
      const server = await makeServer({ listThemes: () => ['meadow-mist', 'golden-sunbreak'], listCommands: async () => [{ name: '/compact' }] }, skillProvider);
      const ws = await signIn(server, {});
      await send(ws, { type: 'theme:list', id: 't1' });
      await send(ws, { type: 'commands:list', id: 'c1' });
      await send(ws, { type: 'appearance:get-favorite-themes', id: 'f1' });
      await send(ws, { type: 'platform:get', id: 'g1' });
      expect(ws.ofType('theme:list:response')[0].payload).toEqual(['meadow-mist', 'golden-sunbreak']);
      expect(ws.ofType('commands:list:response')[0].payload).toEqual([{ name: '/compact' }]);
      expect(ws.ofType('appearance:get-favorite-themes:response')[0].payload).toEqual(['meadow-mist']);
      expect(ws.ofType('platform:get:response')[0].payload).toBe(process.platform);
    });

    it('a list that fails is answered as a failure, never as an empty list', async () => {
      const server = await makeServer({ listThemes: () => { throw new Error('EACCES: themes folder'); }, listCommands: async () => { throw new Error('boom'); } });
      const ws = await signIn(server, {});
      await send(ws, { type: 'theme:list', id: 't1' });
      await send(ws, { type: 'commands:list', id: 'c1' });
      expect(ws.ofType('theme:list:response')[0].payload).toMatchObject({ ok: false, error: expect.stringContaining('EACCES') });
      expect(ws.ofType('commands:list:response')[0].payload).toMatchObject({ ok: false });
    });
  });

  describe('the host log says what happened to each phone connection', () => {
    it('logs the connect, the catch-up and the drop, with a short device id and no secrets', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const server = await makeServer();
      const ws = await signIn(server, { readyHandshake: true });
      await send(ws, { type: 'client:ready', payload: { seq: 1, reconnect: false, ptyOffsets: {} } });
      ws.close(1006);
      const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[remote-server] ') && l.includes(' device '));
      expect(lines.some((l) => /connected/.test(l))).toBe(true);
      // Every line is stamped, and the drop says how long the phone had been silent: without both,
      // seven drops in ten minutes (2026-09-11) could not be told apart from seven screen locks.
      expect(lines.every((l) => /^\[remote-server\] \d{4}-\d{2}-\d{2}T[\d:.]+Z device /.test(l))).toBe(true);
      expect(lines.some((l) => /silent for \d+ s/.test(l))).toBe(true);
      expect(lines.some((l) => /catch-up started \(page ready\)/.test(l))).toBe(true);
      expect(lines.some((l) => /caught up in \d+ ms/.test(l))).toBe(true);
      expect(lines.some((l) => /disconnected: code 1006/.test(l))).toBe(true);
      const secret = ws.ofType('auth:ok')[0].secret as string;
      expect(lines.join('\n')).not.toContain(secret);
      expect(lines.join('\n')).not.toContain('127.0.0.1');
    });
  });
});

// Remote access batch 2, design §2/§3 (T3): when a session goes away, the
// phone is told what the desktop is showing, so it can open that instead of
// guessing; and a remote client cannot write the desktop's selection cache.
describe('RemoteServer — session focus', () => {
  afterEach(() => { vi.resetModules(); });

  async function makeServer(focus: string | null) {
    const { RemoteServer } = await import('../src/main/remote-server');
    const sm = Object.assign(new EventEmitter(), { listSessions: vi.fn(() => []), destroySession: vi.fn(() => true) });
    const config = { enabled: true, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
    const getFocusSessionId = vi.fn(() => focus);
    const server: any = new RemoteServer(sm as never, new EventEmitter() as never, config as never, undefined, { getFocusSessionId });
    const frames: any[] = [];
    const client = { id: 'c', ws: { readyState: 1, bufferedAmount: 0, send: (d: string) => frames.push(JSON.parse(d)) }, deviceId: 'd', ip: '', connectedAt: 0 };
    server.clients.add(client);
    return { server, frames, client, getFocusSessionId };
  }

  describe('session:destroyed carries the desktop\'s focus', () => {
    it('reports the cache as it is, even when it still names the session going away — the phone falls back', async () => {
      // session-exit fires before any window changes its selection, so focus usually names
      // the destroyed session itself. Design §3 puts the fallback on the phone (T4).
      const { server, frames } = await makeServer('s1');
      server.onSessionExit('s1', 0);
      expect(frames[0].payload.focus).toEqual({ sessionId: 's1' });
    });

    it('when the process exits', async () => {
      const { server, frames } = await makeServer('s2');
      server.onSessionExit('s1', 0);
      expect(frames).toEqual([{ type: 'session:destroyed', payload: { sessionId: 's1', exitCode: 0, focus: { sessionId: 's2' } } }]);
    });

    it('when a remote client destroys it', async () => {
      const { server, frames, client } = await makeServer(null);
      await server.handleMessage(client, JSON.stringify({ type: 'session:destroy', id: 'd1', payload: { sessionId: 's1' } }));
      expect(frames.find((f) => f.type === 'session:destroyed')?.payload).toEqual({ sessionId: 's1', focus: { sessionId: null } });
    });
  });

  describe('a remote client never reports a selection', () => {
    it('session:selected from the socket is ignored — no reply', async () => {
      // RemoteServer holds no handle that could write main's selection cache; the guard here
      // is that the case exists at all (without it the default answers "unsupported").
      const { server, frames, client } = await makeServer('s2');
      await server.handleMessage(client, JSON.stringify({ type: 'session:selected', id: 'x1', payload: { sessionId: 'evil' } }));
      expect(frames).toEqual([]);
    });
  });
});

// The host half of the appearance-sync section of tests/remote-shim.test.ts (Destin, 2026-09-11: the phone kept
// an old theme until reloaded). A theme change made on one phone must reach the computer's
// windows and every OTHER phone; a change made on the computer must reach every phone.
describe('RemoteServer — appearance relay', () => {
  class FakeSocket extends EventEmitter {
    frames: any[] = [];
    readyState = 1;
    bufferedAmount = 0;
    send(raw: string) { this.frames.push(JSON.parse(raw)); }
    close() { this.readyState = 3; this.emit('close'); }
    ping() {}
    ofType(type: string) { return this.frames.filter((f) => f.type === type); }
  }

  async function makeServer() {
    const { RemoteServer } = await import('../src/main/remote-server');
    const sm = Object.assign(new EventEmitter(), { listSessions: vi.fn(() => []) });
    const config = { enabled: true, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
    const onAppearanceBroadcast = vi.fn();
    const server: any = new RemoteServer(sm as never, new EventEmitter() as never, config as never, undefined, {
      requestSnapshot: () => Promise.resolve({ sessions: [] }),
      onAppearanceBroadcast,
    });
    return { server, onAppearanceBroadcast };
  }

  function liveClient(server: any, deviceId: string) {
    const ws = new FakeSocket();
    server.addClient(ws, deviceId, '100.64.0.2');
    const client = [...server.clients].find((c: any) => c.ws === ws);
    client.phase = 'live';
    return { ws, client };
  }

  afterEach(() => { vi.resetModules(); });

  describe('remote-server: appearance:broadcast from a phone', () => {
    it('reaches the computer\'s windows and every other phone, not the phone that sent it', async () => {
      const { server, onAppearanceBroadcast } = await makeServer();
      const a = liveClient(server, 'phone-a');
      const b = liveClient(server, 'phone-b');
      await server.handleMessage(a.client, JSON.stringify({ type: 'appearance:broadcast', payload: { theme: 'meadow-mist' } }));

      expect(onAppearanceBroadcast).toHaveBeenCalledWith({ theme: 'meadow-mist' });
      expect(b.ws.ofType('appearance:sync').map((f) => f.payload)).toEqual([{ theme: 'meadow-mist' }]);
      expect(a.ws.ofType('appearance:sync')).toEqual([]);
    });

    it('ignores a payload that is not an object', async () => {
      const { server, onAppearanceBroadcast } = await makeServer();
      const a = liveClient(server, 'phone-a');
      const b = liveClient(server, 'phone-b');
      await server.handleMessage(a.client, JSON.stringify({ type: 'appearance:broadcast', payload: 'midnight' }));
      expect(onAppearanceBroadcast).not.toHaveBeenCalled();
      expect(b.ws.ofType('appearance:sync')).toEqual([]);
    });
  });

  // WHY no main.ts cases here any more: the computer-side wiring (the window relay also
  // broadcasting appearance:sync to phones, and RemoteServer getting onAppearanceBroadcast)
  // is the ast-grep rule appearance-broadcast-relays-to-remote in youcoded-dev
  // scripts/ast-grep/ (Plan B, 2026-09-16), which reads the code rather than its text.
});
