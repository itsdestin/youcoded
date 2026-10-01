// RemoteServer (src/main/remote-server.ts) — what a phone gets from the host, driven through a fake
// socket: the page it is served, pairing and auth limits, the catch-up when the phone says it is
// ready, reconnect replay, Refresh, the host log, and the messages it relays.
// WHY not in remote-server.test.ts: that file mocks remote-config, http, session-browser and the
// conversations service for the whole file; these cases use the real ones.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
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

    it('both sign-in paths tell the screen the protocol version and what it can do', async () => {
      const { server } = await makeServer();
      const first = await connect(server, { password: 'correct-horse', deviceName: 'My phone' });
      const second = await connect(server, { deviceId: first.last()!.deviceId as string, secret: first.last()!.secret as string });
      for (const ws of [first, second]) {
        expect(ws.last()).toMatchObject({ type: 'auth:ok', platform: 'desktop', sessionNaming: true, protocolVersion: 1 });
        // A screen watching a computer cannot open the computer's folders or tear a window out; it MAY drive the app's own engine, which runs on the computer.
        expect(ws.last()!.capabilities).toMatchObject({ nativeWindows: false, openInOs: false, nativeSessions: true, terminalTransport: 'text', terminalScreenRead: false });
      }
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

// Remote access batch 2, design §1 A (T1), trimmed by one-core R5-2: the phone tells the host when its page is listening, and the host
// then sends the global state a screen needs (the session list, topic names, the last status). There is no restore sequence, no queue and
// no cut line any more: a conversation's content comes from `session:open` (tests/session-open.test.ts, tests/session-fill-reconnect.test.ts).
describe('RemoteServer — readiness', () => {
  class FakeSocket extends EventEmitter {
    frames: any[] = [];
    readyState = 1;
    bufferedAmount = 0;
    send(raw: string) { this.frames.push(JSON.parse(raw)); }
    close() { this.readyState = 3; this.emit('close'); }
    ping() {}
    types() { return this.frames.map((f) => f.type); }
  }
  async function makeServer(topics: Array<[string, string]> = []) {
    const { RemoteServer } = await import('../src/main/remote-server');
    const sm = Object.assign(new EventEmitter(), { listSessions: vi.fn(() => [{ id: 's1', name: 's1', cwd: '/tmp', status: 'active' }]) });
    const config = { enabled: true, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
    const server: any = new RemoteServer(sm as never, new EventEmitter() as never, config as never);
    for (const [id, name] of topics) server.setLastTopic(id, name);
    return server;
  }
  function connect(server: any) {
    const ws = new FakeSocket();
    server.addClient(ws, 'dev-1', '100.64.0.2');
    return { ws, client: [...server.clients].find((c: any) => c.ws === ws) };
  }
  const ready = JSON.stringify({ type: 'client:ready', payload: { reconnect: false } });
  const tick = () => new Promise((r) => setImmediate(r));
  afterEach(() => { vi.resetModules(); });

  it('sends nothing at connect: a push before the page is listening would be dropped', async () => {
    const server = await makeServer();
    const { ws } = connect(server);
    await tick();
    expect(ws.frames).toEqual([]);
  });

  it('answers client:ready with the session list, topic names and last status, and goes live at once (no queue, no phase)', async () => {
    const server = await makeServer([['s1', 'Fixing the build']]);
    server.broadcastStatusData({ usage: { a: 1 } });
    const { ws, client } = connect(server);
    ws.emit('message', ready);
    await tick(); await tick();
    expect(ws.types()).toEqual(['session:created', 'session:renamed', 'status:data']);
    expect(client.phase).toBeUndefined();
    // a broadcast now reaches the phone immediately
    server.broadcast({ type: 'session:created', payload: { id: 's2' } });
    expect(ws.types().at(-1)).toBe('session:created');
    expect(ws.frames.length).toBe(4);
  });

  it('an older page (client:ready with a seq and no version, expecting a chat snapshot) is answered with a degraded snapshot of one refresh notice, not left blank and not looped (tests/old-phone-page.test.ts drives the real old page)', async () => {
    const server = await makeServer();
    const { ws } = connect(server);
    const close = vi.spyOn(ws, 'close');
    ws.emit('message', JSON.stringify({ type: 'client:ready', payload: { seq: 1, reconnect: false, ptyOffsets: {} } }));
    await tick(); await tick();
    expect(close).not.toHaveBeenCalled();
    const hydrate = ws.frames.find((f: any) => f.type === 'chat:hydrate');
    expect(hydrate.payload).toMatchObject({ degraded: true, seq: 1 });
  });

  it('a page that says its version is welcome; a page that says an old version is refused', async () => {
    const server = await makeServer();
    const a = connect(server);
    a.ws.emit('message', JSON.stringify({ type: 'client:ready', payload: { reconnect: false, protocolVersion: 2 } }));
    await tick(); await tick();
    expect(a.ws.types()).toContain('session:created');
    const b = connect(server);
    const close = vi.spyOn(b.ws, 'close');
    b.ws.emit('message', JSON.stringify({ type: 'client:ready', payload: { protocolVersion: 1 } }));
    await tick(); await tick();
    expect(close).toHaveBeenCalledWith(4005, expect.any(String));
  });

  it('a second client:ready on one connection is ignored', async () => {
    const server = await makeServer();
    const { ws } = connect(server);
    ws.emit('message', ready); await tick(); await tick();
    const n = ws.frames.length;
    ws.emit('message', ready); await tick(); await tick();
    expect(ws.frames.length).toBe(n);
  });

  it('never sends a chat snapshot (chat:hydrate is gone): a conversation arrives through session:open', async () => {
    const server = await makeServer();
    const { ws } = connect(server);
    ws.emit('message', ready); await tick(); await tick();
    expect(ws.types()).not.toContain('chat:hydrate');
    expect(ws.types()).not.toContain('hook:replay-complete');
  });

  it('a live client that stops reading is closed above 32 MB instead of buffered without bound', async () => {
    const server = await makeServer();
    const { ws } = connect(server);
    const close = vi.spyOn(ws, 'close');
    ws.bufferedAmount = 33 * 1024 * 1024;
    server.broadcast({ type: 'x', payload: {} });
    expect(close).toHaveBeenCalledWith(4009, 'Too slow');
  });

  it('a push for a session this phone is being filled with waits until its answer is out, then follows it in order', async () => {
    const { AudienceFills } = await import('../src/main/audience-fill');
    const server = await makeServer();
    const { ws, client } = connect(server);
    const fills = new AudienceFills();
    fills.begin(`s${client.audienceId ?? 1}`, 's1');
    client.audienceId = client.audienceId ?? 1;
    const hold = (id: number, deliver: () => void) => fills.hold(`s${id}`, 's1', deliver);
    server.broadcast({ type: 'transcript:event', payload: { n: 1 }, epoch: 'e', seq: 5 }, undefined, hold);
    server.broadcast({ type: 'transcript:event', payload: { n: 2 }, epoch: 'e', seq: 6 }, undefined, hold);
    expect(ws.frames).toEqual([]);
    ws.send(JSON.stringify({ type: 'session:open:response' }));   // the answer goes out first
    fills.release(`s${client.audienceId}`, 's1');
    expect(ws.frames.map((f) => f.seq ?? 'answer')).toEqual(['answer', 5, 6]);
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

  describe('what a phone asks on waking and at start is answered', () => {
    it('remote:ping is answered at once, even while the phone is still catching up', async () => {
      const server = await makeServer();
      const ws = await signIn(server, { readyHandshake: true });
      await send(ws, { type: 'remote:ping', id: 'p1' });
      expect(ws.ofType('remote:ping:response')[0].payload).toEqual({ ok: true });
    });

    it('theme list, commands, favourite themes and the platform come from the same code as the desktop', async () => {
      // WHY the table entries (2026-10-01 one-core R3-8): these four are channel-table entries both doors run; the theme list reads
      // the real themes folder (under the suite's sandbox HOME), the command list and the favourites reach it through the binds
      // ipc-handlers.ts makes at startup.
      const server = await makeServer();
      const { THEMES_DIR } = await import('../src/main/theme-watcher');
      const { bindUi } = await import('../src/main/ipc/ui');
      const { bindAppearance } = await import('../src/main/ipc/appearance');
      for (const slug of ['meadow-mist', 'golden-sunbreak']) {
        fs.mkdirSync(path.join(THEMES_DIR, slug), { recursive: true });
        fs.writeFileSync(path.join(THEMES_DIR, slug, 'manifest.json'), '{}');
      }
      try {
        bindUi({ getCommands: async () => [{ name: '/compact' }], emitUiAction: () => {} });
        bindAppearance({ getThemeFavorites: () => ['meadow-mist'], setThemeFavorite: () => {} });
        const ws = await signIn(server, {});
        await send(ws, { type: 'theme:list', id: 't1' });
        await send(ws, { type: 'commands:list', id: 'c1' });
        await send(ws, { type: 'appearance:get-favorite-themes', id: 'f1' });
        await send(ws, { type: 'platform:get', id: 'g1' });
        expect([...ws.ofType('theme:list:response')[0].payload].sort()).toEqual(expect.arrayContaining(['golden-sunbreak', 'meadow-mist']));
        expect(ws.ofType('commands:list:response')[0].payload).toEqual([{ name: '/compact' }]);
        expect(ws.ofType('appearance:get-favorite-themes:response')[0].payload).toEqual(['meadow-mist']);
        expect(ws.ofType('platform:get:response')[0].payload).toBe(process.platform);
      } finally {
        for (const slug of ['meadow-mist', 'golden-sunbreak']) fs.rmSync(path.join(THEMES_DIR, slug), { recursive: true, force: true });
      }
    });

    it('a list that fails is answered as a failure, never as an empty list', async () => {
      const server = await makeServer();
      const { bindUi } = await import('../src/main/ipc/ui');
      bindUi({ getCommands: async () => { throw new Error('boom'); }, emitUiAction: () => {} });
      const ws = await signIn(server, {});
      await send(ws, { type: 'commands:list', id: 'c1' });
      expect(ws.ofType('commands:list:response')[0].payload).toMatchObject({ ok: false, error: 'boom' });
    });
  });

  describe('the host log says what happened to each phone connection', () => {
    it('logs the connect, the page ready and the drop, with a short device id and no secrets', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const server = await makeServer();
      const ws = await signIn(server, { readyHandshake: true });
      await send(ws, { type: 'client:ready', payload: { reconnect: false, protocolVersion: 2 } });
      ws.close(1006);
      const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[remote-server] ') && l.includes(' device '));
      expect(lines.some((l) => /connected/.test(l))).toBe(true);
      // Every line is stamped, and the drop says how long the phone had been silent: without both,
      // seven drops in ten minutes (2026-09-11) could not be told apart from seven screen locks.
      expect(lines.every((l) => /^\[remote-server\] \d{4}-\d{2}-\d{2}T[\d:.]+Z device /.test(l))).toBe(true);
      expect(lines.some((l) => /silent for \d+ s/.test(l))).toBe(true);
      expect(lines.some((l) => /page ready/.test(l))).toBe(true);
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

    // The session manager emits session-exit for EVERY destroy (a phone's own X included), which is what
    // tells the phones — so a phone that closes a session hears it once, with the desktop's focus. (The old
    // phone-only teardown also sent a second, shorter notice; session:destroy is a table entry now and runs
    // the computer's teardown, which is tested in ipc-handlers.test.ts.)
    it('when a remote client destroys it, it hears the session end once, from the exit', async () => {
      const { server, frames, client } = await makeServer(null);
      const { bindSessionOps } = await import('../src/main/ipc/session');
      bindSessionOps({ destroySession: async (id: string) => { server.onSessionExit(id, 0); return true; } } as any);
      await server.handleMessage(client, JSON.stringify({ type: 'session:destroy', id: 'd1', payload: { sessionId: 's1' } }));
      expect(frames.filter((f) => f.type === 'session:destroyed')).toEqual([
        { type: 'session:destroyed', payload: { sessionId: 's1', exitCode: 0, focus: { sessionId: null } } },
      ]);
      expect(frames.find((f) => f.type === 'session:destroy:response')?.payload).toBe(true);
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
    // WHY (2026-10-01 one-core R3-8): the appearance:broadcast table entry reaches this computer's windows through the host's
    // broadcastToWindows (the same hook a tag change from a phone uses), so the test watches that.
    const onAppearanceBroadcast = vi.fn();
    const server: any = new RemoteServer(sm as never, new EventEmitter() as never, config as never, undefined, {
      broadcastToWindows: (channel, payload) => { if (channel === 'appearance:sync') onAppearanceBroadcast(payload); },
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
