// A page's LIVE connection to its home device (spec 2026-10-04, Part 1), main side.
//
// Two kinds of test, on purpose:
//   · a real `ws` server stands in for the device (greeting, redaction, deny
//     check, the login-refused answer), with real timers and no sleeps — each
//     test waits for the thing it is about;
//   · a scripted fake socket under FAKE timers for everything about time
//     (reconnect schedule, the 10-minute give-up, lease, flood window, races),
//     so no test waits in real time.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import net, { type AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { parseConnections } from '../src/main/pages/page-connections';
import { PageRateGate, REDACTED } from '../src/main/pages/page-fetch';
import type { DeviceSocketAccess } from '../src/main/pages/page-socket';
import { LIVE_LIMITS, PageLiveSockets, defaultConnect, type LiveWsLike, type PushResult, type SocketOwner } from '../src/main/pages/page-live-socket';
import type { PageConnection, PageSocketEvent } from '../src/shared/pages-types';

const KEY = 'ha-long-lived-token-value';
const HELLO = '{"type":"auth","access_token":"{{key}}"}';
const URL_HA = 'http://192.168.4.54:8123/api/websocket';

type Dev = Extract<PageConnection, { kind: 'device' }>;
function device(over: Record<string, unknown> = {}): Dev {
  const [c] = parseConnections([{
    id: 'ha', kind: 'device', service: 'Home Assistant', address: '192.168.4.54:8123', access: 'full',
    socketHello: HELLO, socketReady: 'auth_ok', socketAuthFailed: 'auth_invalid', socketDeny: ['config/core'], ...over,
  }]);
  return c as Dev;
}
const okAccess = (conn: Dev = device()): DeviceSocketAccess => ({
  ok: true, connection: conn, httpUrl: new URL(URL_HA),
  credential: { in: 'header', param: 'authorization', value: `Bearer ${KEY}`, secret: KEY },
  secrets: [`Bearer ${KEY}`, KEY], hello: conn.socketHello,
});
const refused = (reason: 'not-approved' | 'network', message = 'no'): DeviceSocketAccess => ({ ok: false, refusal: { ok: false, reason, message } });

/** A scripted socket: the test says what the device does. */
class FakeWs extends EventEmitter {
  sent: string[] = [];
  terminated = false;
  send(d: string) { this.sent.push(d); }
  terminate() { this.terminated = true; }
  /** The device accepts the upgrade. */
  accept() { this.emit('open'); }
  say(obj: unknown) { this.emit('message', Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)), false); }
  drop(code = 1006) { this.emit('close', code); }
}

interface Rig {
  sockets: PageLiveSockets;
  events: PageSocketEvent[];
  wss: FakeWs[];
  access: ReturnType<typeof vi.fn>;
  gate: { acquire: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  owner: (key?: string, result?: () => PushResult) => SocketOwner;
}
function rig(accessImpl?: () => Promise<DeviceSocketAccess>): Rig {
  const events: PageSocketEvent[] = [];
  const wss: FakeWs[] = [];
  const real = new PageRateGate();
  const gate = { acquire: vi.fn((p: string) => real.acquire(p)), release: vi.fn((p: string) => real.release(p)) };
  const access = vi.fn(accessImpl ?? (async () => okAccess()));
  const sockets = new PageLiveSockets({
    access, gate,
    connect: () => { const w = new FakeWs(); wss.push(w); return w as unknown as LiveWsLike; },
  });
  return {
    sockets, events, wss, access, gate,
    owner: (key = 'window:1', result = () => 'sent') => ({ key, push: (e) => { events.push(e); return result(); } }),
  };
}
const call = { page: 'personal:home', frame: 'frame-1' };
async function opened(r: Rig, owner = r.owner(), over: Partial<typeof call> = {}) {
  const res = await r.sockets.open(owner, { ...call, ...over, url: URL_HA });
  if (!res.ok) throw new Error(res.message);
  return res.socket;
}
const states = (r: Rig) => r.events.filter((e): e is Extract<PageSocketEvent, { kind: 'state' }> => e.kind === 'state');
const lastState = (r: Rig) => states(r).at(-1);
const texts = (r: Rig) => r.events.flatMap((e) => (e.kind === 'messages' ? e.texts : []));
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

describe('the live socket with a real device stand-in', () => {
  let server: WebSocketServer;
  let port = 0;
  let received: string[];
  let onConnection: (ws: WebSocket) => void;
  // Re-checks every `until` when the device receives something (not only when an event is pushed).
  const waiters: Array<() => void> = [];
  const wake = () => waiters.splice(0).forEach((w) => w());

  beforeEach(async () => {
    received = [];
    waiters.length = 0;
    onConnection = () => {};
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((r) => server.once('listening', () => r()));
    port = (server.address() as AddressInfo).port;
    server.on('connection', (ws) => {
      ws.on('message', (raw) => { received.push(raw.toString()); wake(); });
      onConnection(ws);
    });
  });
  afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); });

  /** A socket rig on the real wire, with events a test can await. */
  function wire(conn: Dev = device(), opts: { onAccess?: () => void } = {}) {
    const events: PageSocketEvent[] = [];
    const sockets = new PageLiveSockets({
      access: async () => { opts.onAccess?.(); return okAccess(conn); },
      gate: new PageRateGate(),
      connect: (url, headers) => new WebSocket(`ws://127.0.0.1:${port}${new URL(url).pathname}`, { headers, followRedirects: false, maxPayload: LIVE_LIMITS.inMessageBytes }),
    });
    const owner: SocketOwner = { key: 'window:1', push: (e) => { events.push(e); wake(); return 'sent'; } };
    const until = (pred: () => boolean) => new Promise<void>((resolve) => {
      const check = () => (pred() ? resolve() : void waiters.push(check));
      check();
    });
    const msgs = () => events.flatMap((e) => (e.kind === 'messages' ? e.texts : []));
    const state = () => events.filter((e) => e.kind === 'state').at(-1) as Extract<PageSocketEvent, { kind: 'state' }> | undefined;
    return { sockets, events, owner, until, msgs, state };
  }

  it('greets first with the key substituted, then reports open; the page never wrote the key', async () => {
    const w = wire();
    const res = await w.sockets.open(w.owner, { ...call, url: URL_HA });
    expect(res.ok).toBe(true);
    await w.until(() => w.state()?.state === 'open');
    await w.until(() => received.length === 1);
    expect(JSON.parse(received[0])).toEqual({ type: 'auth', access_token: KEY });
    w.sockets.closeAll();
  });

  it('refuses a denied message on send and sends an allowed one as JSON', async () => {
    const w = wire();
    const res = await w.sockets.open(w.owner, { ...call, url: URL_HA });
    if (!res.ok) throw new Error('open');
    await w.until(() => w.state()?.state === 'open');
    const denied = w.sockets.send('window:1', { ...call, socket: res.socket, text: '{"id":2,"type":"auth/long_lived_access_token"}' });
    expect(denied.ok).toBe(false);
    const extra = w.sockets.send('window:1', { ...call, socket: res.socket, text: '{"id":3,"type":"config/core/update"}' });
    expect(extra.ok).toBe(false);
    expect(w.sockets.send('window:1', { ...call, socket: res.socket, text: '{"id":4,"type":"ping"}' })).toEqual({ ok: true });
    await w.until(() => received.length === 2);
    expect(received.map((r) => JSON.parse(r).type)).toEqual(['auth', 'ping']);
    w.sockets.closeAll();
  });

  it('redacts the key from every message BEFORE it is batched', async () => {
    onConnection = (ws) => { ws.send(`you said ${KEY}`); ws.send(JSON.stringify({ type: 'result', echoed: `Bearer ${KEY}`, enc: encodeURIComponent(KEY) })); };
    const w = wire();
    await w.sockets.open(w.owner, { ...call, url: URL_HA });
    await w.until(() => w.msgs().length >= 2);
    const all = w.msgs().join('\n');
    expect(all).not.toContain(KEY);
    expect(all).toContain(REDACTED);
    w.sockets.closeAll();
  });

  it('ends for good when the device answers with the refused-key reply, with no second login', async () => {
    let connections = 0;
    onConnection = (ws) => { connections++; ws.send(JSON.stringify({ type: 'auth_invalid', message: `bad ${KEY}` })); };
    const w = wire();
    await w.sockets.open(w.owner, { ...call, url: URL_HA });
    await w.until(() => w.state()?.state === 'closed');
    expect(w.msgs().join('')).not.toContain(KEY);
    expect(w.state()?.why).toContain('refused the saved key');
    expect(connections).toBe(1);
    expect(w.sockets.count).toBe(0);
  });

  it('ends for good, without reconnecting, when the device sends a message over 1 MB (the way real ws reports it)', async () => {
    // ws closes with 1009 AND emits an 'error' first; reading only the close left the error to be treated as an ordinary drop.
    let connections = 0;
    onConnection = (ws) => { connections++; ws.send('x'.repeat(LIVE_LIMITS.inMessageBytes + 100_000)); };
    const w = wire();
    await w.sockets.open(w.owner, { ...call, url: URL_HA });
    await w.until(() => w.state()?.state === 'closed' || w.state()?.state === 'reconnecting');
    expect(w.state()).toMatchObject({ state: 'closed', why: expect.stringContaining('larger than the app will pass') });
    expect(connections).toBe(1);
    expect(w.sockets.count).toBe(0);
    expect(w.msgs()).toEqual([]); // the oversized message itself never reaches the page
  });

  it('closes a first attempt that is refused outright (nothing listening) with a plain reason, not a ten-minute retry loop', async () => {
    const dead = net.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', () => r()));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    const events: PageSocketEvent[] = [];
    const sockets = new PageLiveSockets({
      access: async () => okAccess(), gate: new PageRateGate(),
      connect: (url, headers) => defaultConnect(`ws://127.0.0.1:${deadPort}${new URL(url).pathname}`, headers),
    });
    const owner: SocketOwner = { key: 'window:1', push: (e) => { events.push(e); wake(); return 'sent'; } };
    const last = () => events.filter((e) => e.kind === 'state').at(-1) as Extract<PageSocketEvent, { kind: 'state' }> | undefined;
    await sockets.open(owner, { ...call, url: URL_HA });
    await new Promise<void>((resolve) => { const check = () => (last()?.state === 'closed' || last()?.state === 'reconnecting' ? resolve() : void waiters.push(check)); check(); });
    expect(last()?.state).toBe('closed');
    expect(sockets.count).toBe(0);
  });
});

describe('the real ws client against a device that never answers', () => {
  // WHY fake timers on the real client: ws's own handshake timer and the module's open timer are both
  // setTimeouts, so one fake clock decides which fires first without any real waiting.
  let silent: net.Server;
  const held: net.Socket[] = [];
  let silentPort = 0;
  beforeEach(async () => {
    silent = net.createServer((sock) => { held.push(sock); sock.on('error', () => {}); });
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
    silentPort = (silent.address() as AddressInfo).port;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(async () => {
    vi.useRealTimers();
    held.splice(0).forEach((s) => s.destroy());
    await new Promise<void>((r) => silent.close(() => r()));
  });

  it('closes a first attempt that never opens after our own 10 s, with the plain reason (not a reconnect)', async () => {
    const events: PageSocketEvent[] = [];
    const sockets = new PageLiveSockets({
      access: async () => okAccess(), gate: new PageRateGate(),
      connect: (url, headers) => defaultConnect(`ws://127.0.0.1:${silentPort}${new URL(url).pathname}`, headers),
    });
    await sockets.open({ key: 'window:1', push: (e) => { events.push(e); return 'sent'; } }, { ...call, url: URL_HA });
    await vi.advanceTimersByTimeAsync(LIVE_LIMITS.openWaitMs);
    const last = events.filter((e) => e.kind === 'state').at(-1);
    expect(last).toMatchObject({ state: 'closed', why: expect.stringContaining('did not answer within 10 seconds') });
    expect(sockets.count).toBe(0);
  });

  it('puts no handshake timeout of its own on the real client, so the 10 s rule has one owner', () => {
    // ws's own timer (also 10 s) fired first and turned "closed with a plain reason" into a reconnect loop.
    // It lives on the underlying request, which is where this reads it.
    const w = defaultConnect(`ws://127.0.0.1:${silentPort}/api/websocket`, {}) as unknown as { _req?: { timeout?: number }; terminate(): void; on(e: string, cb: () => void): void };
    w.on('error', () => {});
    try { expect(w._req).toBeDefined(); expect(w._req?.timeout).toBeUndefined(); } finally { w.terminate(); }
  });
});

describe('who may use a socket, and how many', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('allows 2 per page, 4 per window, 8 per app', async () => {
    const r = rig();
    const a = r.owner('window:1'); const b = r.owner('window:2'); const c = r.owner('window:3');
    await opened(r, a, { page: 'p1' }); await opened(r, a, { page: 'p1' });
    const third = await r.sockets.open(a, { page: 'p1', frame: 'f', url: URL_HA });
    expect(third).toMatchObject({ ok: false, message: expect.stringContaining('at most 2') });
    await opened(r, a, { page: 'p2' }); await opened(r, a, { page: 'p2' });
    // Window 1 now holds 4: a fifth, on a fresh page, is refused.
    expect(await r.sockets.open(a, { page: 'p3', frame: 'f', url: URL_HA })).toMatchObject({ ok: false, message: expect.stringContaining('at most 4') });
    await opened(r, b, { page: 'p3' }); await opened(r, b, { page: 'p3' });
    await opened(r, b, { page: 'p4' }); await opened(r, b, { page: 'p4' });
    expect(r.sockets.count).toBe(8);
    expect(await r.sockets.open(c, { page: 'p5', frame: 'f', url: URL_HA })).toMatchObject({ ok: false, message: expect.stringContaining('at most 8') });
    // Two quick opens cannot both pass a cap of one remaining place.
    r.sockets.closeFor('p4');
    const [x, y] = await Promise.all([r.sockets.open(c, { page: 'p5', frame: 'f', url: URL_HA }), r.sockets.open(c, { page: 'p6', frame: 'f', url: URL_HA })]);
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(2); // p4 freed two places
    r.sockets.closeAll();
  });

  it('refuses another window, another page or another frame, and never confirms an id', async () => {
    const r = rig();
    const id = await opened(r);
    r.wss[0].accept();
    const mine = { ...call, socket: id };
    expect(r.sockets.send('window:2', { ...mine, text: '{"type":"ping"}' }).ok).toBe(false);
    expect(r.sockets.send('window:1', { ...mine, page: 'other', text: '{"type":"ping"}' }).ok).toBe(false);
    expect(r.sockets.send('window:1', { ...mine, frame: 'frame-2', text: '{"type":"ping"}' }).ok).toBe(false);
    expect(r.sockets.close('window:2', mine).ok).toBe(false);
    expect(r.sockets.ping('window:2', mine).ok).toBe(false);
    expect(r.sockets.send('window:1', { ...mine, socket: 'ls_guess', text: '{"type":"ping"}' }).ok).toBe(false);
    // Still alive and still usable by its owner.
    expect(r.sockets.count).toBe(1);
    expect(r.sockets.send('window:1', { ...mine, text: '{"type":"ping"}' }).ok).toBe(true);
    // Another owner's own socket id is not guessable: ids are unique and unrelated.
    const id2 = await opened(r, r.owner('window:2'), { page: 'other' });
    expect(id2).not.toBe(id);
    expect(id).toMatch(/^ls_[0-9a-f]{32}$/);
  });

  it('takes a rate-gate slot for the open and for each reconnect', async () => {
    const r = rig();
    await opened(r);
    expect(r.gate.acquire).toHaveBeenCalledTimes(1);
    r.wss[0].accept(); r.wss[0].drop();
    await tick(1000);
    expect(r.gate.acquire).toHaveBeenCalledTimes(2);
    // Every slot taken is given back at once: a socket must not hold an in-flight slot.
    expect(r.gate.release).toHaveBeenCalledTimes(2);
  });

  it('a rate-limited reconnect backs off instead of giving up', async () => {
    const r = rig();
    await opened(r);
    r.wss[0].accept(); r.wss[0].drop();
    r.gate.acquire.mockResolvedValueOnce(false);
    await tick(1000);
    expect(lastState(r)?.state).toBe('reconnecting');
    await tick(2000);
    expect(r.wss).toHaveLength(2);
  });

  it('refuses an open outright when the page is not approved', async () => {
    const r = rig(async () => refused('not-approved', 'This page has not been allowed to reach 192.168.4.54 yet.'));
    const res = await r.sockets.open(r.owner(), { ...call, url: URL_HA });
    expect(res).toMatchObject({ ok: false, message: expect.stringContaining('not been allowed') });
    expect(r.sockets.count).toBe(0);
    expect(r.wss).toHaveLength(0);
  });
});

describe('what a page may send', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); });

  async function openSocket() {
    const r = rig();
    const id = await opened(r);
    r.wss[0].accept();
    return { r, id, send: (text: string) => r.sockets.send('window:1', { ...call, socket: id, text }) };
  }

  it('is refused unless the socket is open', async () => {
    const r = rig();
    const id = await opened(r);
    const send = () => r.sockets.send('window:1', { ...call, socket: id, text: '{"type":"ping"}' });
    expect(send().ok).toBe(false); // still connecting
    r.wss[0].accept();
    expect(send().ok).toBe(true);
    r.wss[0].drop();
    expect(send().ok).toBe(false); // reconnecting
    expect(r.wss[0].sent).toHaveLength(2); // the greeting and the one ping
  });

  it('is checked for its type, and the re-serialised text is what goes out', async () => {
    const { r, send } = await openSocket();
    expect(send('{"id":1,"type":"auth/long_lived_access_token"}').ok).toBe(false);
    expect(send('{"id":1,"type":"config/core/update"}').ok).toBe(false);
    expect(send('not json').ok).toBe(false);
    expect(send('{"type":"auth/x","type":"ping"}').ok).toBe(true);
    expect(r.wss[0].sent.at(-1)).toBe('{"type":"ping"}');
    // A nested "type" (a dashboard save) is ordinary.
    expect(send('{"type":"lovelace/config/save","config":{"views":[{"type":"entities"}]}}').ok).toBe(true);
  });

  it('is limited to 20 a second and 64 KB each', async () => {
    const { send } = await openSocket();
    for (let i = 0; i < LIVE_LIMITS.sendsPerSecond; i++) expect(send(`{"id":${i},"type":"ping"}`).ok).toBe(true);
    expect(send('{"id":99,"type":"ping"}')).toMatchObject({ ok: false, message: expect.stringContaining('faster') });
    await tick(1001);
    expect(send('{"id":100,"type":"ping"}').ok).toBe(true);
    await tick(1001);
    expect(send(JSON.stringify({ type: 'x', pad: 'a'.repeat(65_000) })).ok).toBe(false);
  });

  it('counts refused messages toward the 20 a second, so a page cannot spam bad ones for free', async () => {
    const { r, send } = await openSocket();
    for (let i = 0; i < LIVE_LIMITS.sendsPerSecond; i++) expect(send('not json').ok).toBe(false);
    expect(send('{"id":1,"type":"ping"}')).toMatchObject({ ok: false, message: expect.stringContaining('faster') });
    await tick(1001);
    expect(send('{"id":2,"type":"ping"}').ok).toBe(true);
    expect(r.wss[0].sent.at(-1)).toBe('{"id":2,"type":"ping"}');
  });
});

describe('what the device says', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('arrives in order, batched every 100 ms, with the key hidden', async () => {
    const r = rig();
    await opened(r);
    const ws = r.wss[0];
    ws.accept();
    ws.say({ type: 'auth_ok' });
    ws.say({ type: 'event', note: `token ${KEY}` });
    ws.say('plain text');
    // Nothing is pushed until the batch window ends.
    expect(texts(r)).toEqual([]);
    await tick(100);
    const pushes = r.events.filter((e) => e.kind === 'messages');
    expect(pushes).toHaveLength(1);
    expect(texts(r)).toHaveLength(3);
    expect(texts(r)[0]).toBe('{"type":"auth_ok"}');
    expect(texts(r).join('')).not.toContain(KEY);
  });

  it('splits a batch at 256 KB and lets one big message go alone', async () => {
    const r = rig();
    await opened(r);
    const ws = r.wss[0];
    ws.accept();
    const chunk = 'a'.repeat(100_000);
    for (let i = 0; i < 5; i++) ws.say(chunk); // 500 KB gathered
    await tick(100);
    const sizes = r.events.filter((e) => e.kind === 'messages').map((e) => (e.kind === 'messages' ? e.texts.length : 0));
    expect(sizes).toEqual([2, 2, 1]);
    r.events.length = 0;
    ws.say('b'.repeat(900_000)); // a whole house's first answer
    await tick(100);
    expect(r.events.filter((e) => e.kind === 'messages')).toHaveLength(1);
    expect(texts(r)[0]).toHaveLength(900_000);
  });

  it('closes the socket when more than 2 MB arrives within 10 s, but not when it is spread out', async () => {
    const r = rig();
    await opened(r);
    const ws = r.wss[0];
    ws.accept();
    for (let i = 0; i < 4; i++) { ws.say('c'.repeat(400_000)); await tick(3500); }
    // 1.6 MB within the window, then the early ones age out: still open.
    expect(r.sockets.count).toBe(1);
    ws.say('c'.repeat(700_000)); ws.say('c'.repeat(700_000));
    expect(r.sockets.count).toBe(0);
    expect(lastState(r)).toMatchObject({ state: 'closed', why: expect.stringContaining('more than the app will pass') });
    expect(ws.terminated).toBe(true);
  });

  it('closes after 20 binary frames and never passes one on', async () => {
    const r = rig();
    await opened(r);
    const ws = r.wss[0];
    ws.accept();
    for (let i = 0; i < 19; i++) ws.emit('message', Buffer.from(KEY), true);
    expect(r.sockets.count).toBe(1);
    ws.emit('message', Buffer.from(KEY), true);
    expect(r.sockets.count).toBe(0);
    expect(JSON.stringify(r.events)).not.toContain(KEY);
  });

  it('a message over the 1 MB limit (the wire reports an error, then closes with 1009) ends it for good', async () => {
    const r = rig();
    await opened(r);
    r.wss[0].accept();
    r.wss[0].emit('error', Object.assign(new RangeError('Max payload size exceeded'), { code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' }));
    r.wss[0].drop(1009);
    expect(lastState(r)).toMatchObject({ state: 'closed', why: expect.stringContaining('larger') });
    await tick(60_000);
    expect(r.wss).toHaveLength(1);
  });

  it('a remote client that is not keeping up loses the socket, nothing else', async () => {
    const r = rig();
    let backed = false;
    const owner = r.owner('client:abc', () => (backed ? 'backed-up' : 'sent'));
    await opened(r, owner);
    const ws = r.wss[0];
    ws.accept();
    backed = true;
    ws.say('hello');
    await tick(100);
    expect(r.sockets.count).toBe(0);
    expect(ws.terminated).toBe(true);
    // The page is told, or its handle would stay 'open' and send into nothing.
    expect(lastState(r)).toMatchObject({ state: 'closed', why: expect.stringContaining('not keeping up') });
  });

  it('reads a message for the login reply only until it has been seen, never for every later push', async () => {
    const r = rig();
    await opened(r);
    const ws = r.wss[0];
    ws.accept();
    const parse = vi.spyOn(JSON, 'parse');
    try {
      ws.say({ type: 'pong' });
      expect(parse).toHaveBeenCalledTimes(1); // still waiting for the login reply: looked at
      ws.say({ type: 'auth_ok' });
      parse.mockClear();
      for (let i = 0; i < 50; i++) ws.say({ type: 'event', n: i });
      expect(parse).not.toHaveBeenCalled(); // logged in: every later push is passed on unread
    } finally { parse.mockRestore(); }
    await tick(LIVE_LIMITS.batchMs);
    expect(texts(r)).toHaveLength(52);
  });

  it('forgets traffic older than the 10 s window, however many small messages it was made of', async () => {
    const r = rig();
    await opened(r);
    const ws = r.wss[0];
    ws.accept();
    const chunk = 'c'.repeat(1000);
    for (let i = 0; i < 1500; i++) ws.say(chunk); // 1.5 MB at once
    expect(r.sockets.count).toBe(1);
    await tick(LIVE_LIMITS.floodWindowMs + 1000);
    r.sockets.ping('window:1', { ...call, socket: (r.events[0] as { socket: string }).socket });
    for (let i = 0; i < 1500; i++) ws.say(chunk); // aged out: another 1.5 MB is fine
    expect(r.sockets.count).toBe(1);
    for (let i = 0; i < 600; i++) ws.say(chunk); // 2.1 MB inside the window: closed
    expect(r.sockets.count).toBe(0);
  });

  it('costs main the same per message however many came before (a flood of tiny messages)', async () => {
    const r = rig();
    await opened(r);
    const ws = r.wss[0];
    ws.accept();
    ws.say({ type: 'auth_ok' });
    const before = process.cpuUsage();
    for (let i = 0; i < 40_000; i++) ws.say('x');
    const cpuMs = (process.cpuUsage(before).user + process.cpuUsage(before).system) / 1000;
    expect(r.sockets.count).toBe(1);
    // Re-summing the whole window per message took several seconds of CPU here; a running total takes well under one.
    expect(cpuMs).toBeLessThan(2000);
  });

  it('does not leave a retry timer on a socket that ended while its last messages were being delivered', async () => {
    const r = rig();
    let gone = false;
    await opened(r, r.owner('window:1', () => (gone ? 'gone' : 'sent')));
    const ws = r.wss[0];
    ws.accept();
    ws.say('hello'); // waiting in the batch
    gone = true; // the window disappears before the batch is pushed
    ws.drop(); // the device drops: the push inside the drop ends the socket
    expect(r.sockets.count).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a window that is gone loses its sockets when an event cannot be delivered', async () => {
    const r = rig();
    await opened(r, r.owner('window:1', () => 'gone'));
    r.wss[0].accept();
    expect(r.sockets.count).toBe(0);
  });
});

describe('reconnecting', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('tries again after 1, 2, 4, 8, 16 then every 30 seconds', async () => {
    const r = rig();
    const id = await opened(r);
    // The page keeps pinging (the lease), so only the retry schedule is under test.
    const keepAlive = () => r.sockets.ping('window:1', { ...call, socket: id });
    r.wss[0].accept();
    r.wss[0].drop();
    for (const delay of [1, 2, 4, 8, 16, 30, 30]) {
      const before = r.wss.length;
      await tick(delay * 1000 - 1);
      keepAlive();
      expect(r.wss.length, `before ${delay}s`).toBe(before);
      await tick(1);
      expect(r.wss.length, `at ${delay}s`).toBe(before + 1);
      r.wss.at(-1)!.drop(); // refused at once: never opens
    }
  });

  it('a close right after opening keeps backing off', async () => {
    const r = rig();
    await opened(r);
    r.wss[0].accept(); r.wss[0].drop();
    await tick(1000);
    r.wss[1].accept(); r.wss[1].drop(); // opened, then closed at once
    await tick(1999);
    expect(r.wss).toHaveLength(2);
    await tick(1);
    expect(r.wss).toHaveLength(3);
  });

  it('starts over at one second only after a login that worked AND stayed up for 30 s', async () => {
    const r = rig();
    const id = await opened(r);
    r.wss[0].accept(); r.wss[0].drop();
    await tick(1000); r.wss[1].drop();
    await tick(2000); r.wss[2].accept();
    r.wss[2].say({ type: 'auth_ok' });
    await tick(LIVE_LIMITS.readyStableMs - 1);
    r.sockets.ping('window:1', { ...call, socket: id });
    await tick(1); // 30 s since the login reply
    r.wss[2].drop();
    await tick(999);
    expect(r.wss).toHaveLength(3);
    await tick(1);
    expect(r.wss).toHaveLength(4);
  });

  it('keeps backing off for a device that logs in and then drops straight away', async () => {
    const r = rig();
    await opened(r);
    r.wss[0].accept(); r.wss[0].drop();
    await tick(1000); r.wss[1].drop();
    await tick(2000); r.wss[2].accept();
    r.wss[2].say({ type: 'auth_ok' });
    r.wss[2].drop(); // logged in, then gone at once
    await tick(3999);
    expect(r.wss).toHaveLength(3); // the wait is 4 s, not 1 s
    await tick(1);
    expect(r.wss).toHaveLength(4);
  });

  it('counts a connection with no login reply as sound once it has stayed open 10 s', async () => {
    const r = rig(async () => okAccess(device({ socketReady: undefined })));
    await opened(r);
    r.wss[0].accept(); r.wss[0].drop();
    await tick(1000); r.wss[1].drop();
    await tick(2000); r.wss[2].accept();
    await tick(LIVE_LIMITS.stableMs);
    r.wss[2].drop();
    await tick(1000);
    expect(r.wss).toHaveLength(4);
  });

  it('gives up after ten minutes down, with a plain reason', async () => {
    const r = rig();
    const id = await opened(r);
    r.wss[0].accept();
    const startedAt = Date.now();
    r.wss[0].drop();
    while (r.sockets.count > 0 && Date.now() - startedAt < 20 * 60_000) {
      await tick(1000);
      r.sockets.ping('window:1', { ...call, socket: id }); // the page is still there; only the device is not
      const ws = r.wss.at(-1)!;
      if (!ws.terminated) ws.drop();
    }
    const waited = Date.now() - startedAt;
    expect(r.sockets.count).toBe(0);
    expect(waited).toBeGreaterThan(9 * 60_000);
    expect(waited).toBeLessThanOrEqual(10 * 60_000 + 1000);
    expect(lastState(r)).toMatchObject({ state: 'closed', why: expect.stringContaining('10 minutes') });
  });

  it('never tries again after the device says the key is wrong, and only an exact type counts', async () => {
    const r = rig();
    await opened(r);
    const ws = r.wss[0];
    ws.accept();
    ws.say({ type: 'auth_invalid_but_not_really' });
    ws.say({ type: 'result', message: 'auth_invalid' });
    ws.say('auth_invalid');
    expect(r.sockets.count).toBe(1);
    ws.say({ type: 'auth_invalid', message: `no ${KEY}` });
    expect(r.sockets.count).toBe(0);
    expect(lastState(r)).toMatchObject({ state: 'closed', why: expect.stringContaining('refused the saved key') });
    await tick(10 * 60_000);
    expect(r.wss).toHaveLength(1);
    // What the device said still reached the page first, redacted.
    expect(texts(r).at(-1)).not.toContain(KEY);
  });

  it('closes a first attempt that never opens after 10 s; a reconnect attempt that never opens keeps trying', async () => {
    const r = rig();
    await opened(r);
    await tick(LIVE_LIMITS.openWaitMs);
    expect(r.sockets.count).toBe(0);
    expect(lastState(r)).toMatchObject({ state: 'closed', why: expect.stringContaining('did not answer within 10 seconds') });
    expect(r.wss[0].terminated).toBe(true);

    const r2 = rig();
    await opened(r2);
    r2.wss[0].accept(); r2.wss[0].drop();
    await tick(1000); // second connection starts, never opens
    await tick(LIVE_LIMITS.openWaitMs);
    expect(r2.sockets.count).toBe(1);
    expect(lastState(r2)?.state).toBe('reconnecting');
    r2.sockets.closeAll();
  });

  it('closes a first attempt that fails before it opens (refused, unreachable) with a plain reason; a socket that has worked is retried', async () => {
    const r = rig();
    await opened(r);
    r.wss[0].emit('error', Object.assign(new Error('connect ECONNREFUSED 192.168.4.54:8123'), { code: 'ECONNREFUSED' }));
    expect(r.sockets.count).toBe(0);
    expect(lastState(r)).toMatchObject({ state: 'closed', why: expect.stringContaining('Lost the connection to 192.168.4.54') });

    const r2 = rig();
    await opened(r2);
    r2.wss[0].accept();
    r2.wss[0].emit('error', new Error('read ECONNRESET'));
    expect(r2.sockets.count).toBe(1);
    expect(lastState(r2)?.state).toBe('reconnecting');
    r2.sockets.closeAll();
  });

  it('asks the whole chain again on every reconnect and stops when the answer is no', async () => {
    let n = 0;
    const r = rig(async () => (++n === 1 ? okAccess() : refused('not-approved', 'This page has not been allowed to reach 192.168.4.54 yet.')));
    await opened(r);
    r.wss[0].accept(); r.wss[0].drop();
    await tick(1000);
    expect(r.access).toHaveBeenCalledTimes(2);
    expect(r.sockets.count).toBe(0);
    expect(lastState(r)).toMatchObject({ state: 'closed', why: expect.stringContaining('not been allowed') });
    await tick(60_000);
    expect(r.access).toHaveBeenCalledTimes(2);
  });

  it('retries when the home-address look-up itself failed for a moment', async () => {
    let n = 0;
    const r = rig(async () => (++n === 2 ? refused('network', 'lookup failed') : okAccess()));
    await opened(r);
    r.wss[0].accept(); r.wss[0].drop();
    await tick(1000); // second check fails: transient
    expect(r.sockets.count).toBe(1);
    expect(lastState(r)?.state).toBe('reconnecting');
    await tick(2000);
    expect(r.wss).toHaveLength(2);
  });
});

describe('races in the state machine', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('a close during the reconnect wait cancels the retry', async () => {
    const r = rig();
    const id = await opened(r);
    r.wss[0].accept(); r.wss[0].drop();
    expect(lastState(r)?.state).toBe('reconnecting');
    expect(r.sockets.close('window:1', { ...call, socket: id }).ok).toBe(true);
    await tick(60_000);
    expect(r.wss).toHaveLength(1);
    expect(r.sockets.count).toBe(0);
  });

  it('a close while the first connect is still being checked leaves nothing behind', async () => {
    let release!: (a: DeviceSocketAccess) => void;
    const r = rig(() => new Promise<DeviceSocketAccess>((res) => { release = res; }));
    const pending = r.sockets.open(r.owner(), { ...call, url: URL_HA });
    await tick(0);
    r.sockets.closeOwner('window:1'); // the window went away (a hide-then-close in the host)
    release(okAccess());
    expect(await pending).toMatchObject({ ok: false });
    expect(r.wss).toHaveLength(0);
    expect(r.sockets.count).toBe(0);
  });

  it('what a dropped connection says afterwards is thrown away', async () => {
    const r = rig();
    await opened(r);
    const old = r.wss[0];
    old.accept(); old.drop();
    await tick(1000);
    const fresh = r.wss[1];
    fresh.accept();
    old.say({ type: 'event', from: 'the old connection' });
    old.accept();
    old.drop();
    fresh.say({ type: 'event', from: 'the new one' });
    await tick(100);
    expect(texts(r).join('')).toContain('the new one');
    expect(texts(r).join('')).not.toContain('the old connection');
    // The late close of the old one did not take the new one down.
    expect(r.sockets.count).toBe(1);
    expect(lastState(r)?.state).toBe('open');
  });

  it('a late open from a connection that was replaced is closed, not used', async () => {
    const r = rig();
    await opened(r);
    const old = r.wss[0];
    old.drop(); // closed before it ever opened
    await tick(1000);
    old.accept();
    expect(old.terminated).toBe(true);
    expect(old.sent).toHaveLength(0); // no greeting went out on a dead connection
  });

  it('tells the page what had arrived before it tells it the socket closed', async () => {
    const r = rig();
    await opened(r);
    r.wss[0].accept();
    r.wss[0].say('last words');
    r.sockets.closeFor('personal:home');
    expect(r.events.map((e) => (e.kind === 'messages' ? 'messages' : e.kind === 'state' ? e.state : e.kind))).toEqual(['open', 'messages', 'closed']);
  });
});

describe('the lease', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('closes a socket nobody has pinged for 60 seconds', async () => {
    const r = rig();
    await opened(r);
    r.wss[0].accept();
    await tick(LIVE_LIMITS.leaseMs - 1);
    expect(r.sockets.count).toBe(1);
    await tick(1);
    expect(r.sockets.count).toBe(0);
    expect(r.wss[0].terminated).toBe(true);
    expect(lastState(r)).toMatchObject({ state: 'closed', why: expect.stringContaining('stopped checking in') });
  });

  it('is kept by a ping every 20 seconds, and does not tick when nothing is open', async () => {
    const r = rig();
    const id = await opened(r);
    r.wss[0].accept();
    for (let i = 0; i < 12; i++) {
      await tick(20_000);
      expect(r.sockets.ping('window:1', { ...call, socket: id }).ok).toBe(true);
    }
    expect(r.sockets.count).toBe(1);
    r.sockets.closeAll();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes a reconnecting socket whose page stopped pinging', async () => {
    const r = rig();
    await opened(r);
    r.wss[0].accept(); r.wss[0].drop();
    await tick(LIVE_LIMITS.leaseMs);
    expect(r.sockets.count).toBe(0);
  });
});

describe('closeFor and closeOwner', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('closeFor a page closes its sockets and no one else\'s; a connection id narrows it', async () => {
    const r = rig();
    await opened(r, r.owner(), { page: 'a' });
    await opened(r, r.owner(), { page: 'b' });
    r.wss.forEach((w) => w.accept());
    r.sockets.closeFor('a', 'some-other-connection');
    expect(r.sockets.count).toBe(2);
    r.sockets.closeFor('a', 'ha');
    expect(r.sockets.count).toBe(1);
    r.sockets.closeFor('b');
    expect(r.sockets.count).toBe(0);
    expect(r.wss.every((w) => w.terminated)).toBe(true);
  });

  it('closeOwner closes every socket of that window or client only', async () => {
    const r = rig();
    await opened(r, r.owner('window:1'), { page: 'a' });
    await opened(r, r.owner('client:x'), { page: 'b' });
    r.sockets.closeOwner('window:1');
    expect(r.sockets.count).toBe(1);
    expect(r.wss[0].terminated).toBe(true);
    expect(r.wss[1].terminated).toBe(false);
  });
});
