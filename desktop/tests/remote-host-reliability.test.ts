// Remote access, 2026-09-11 phone pass — the host half of the reliability fixes
// (docs/active/reviews/2026-09-11-remote-batch-2-3-phone-pass.md, investigation items 5–7):
//  - the dev log said `client:ready ignored in phase live`: a phone's page took more than 5 s to
//    start listening, the host's 5 s fallback ran the catch-up into a page that could not hear
//    it, and the phone showed "may be out of date";
//  - reads a phone's screens load at start were "unhandled channel", so those screens were empty;
//  - the host logged no connects, drops or catch-ups, so none of this could be traced.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('ws', async () => {
  const { EventEmitter: EE } = await import('events');
  class MockWebSocketServer extends EE { clients = new Set(); close = vi.fn((cb?: () => void) => cb?.()); constructor(_o?: unknown) { super(); } }
  const MockWebSocket: { (): void; OPEN: number } = Object.assign(vi.fn(), { OPEN: 1 });
  return { WebSocketServer: MockWebSocketServer, WebSocket: MockWebSocket };
});

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
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[remote-server] device'));
    expect(lines.some((l) => /connected/.test(l))).toBe(true);
    expect(lines.some((l) => /catch-up started \(page ready\)/.test(l))).toBe(true);
    expect(lines.some((l) => /caught up in \d+ ms/.test(l))).toBe(true);
    expect(lines.some((l) => /disconnected: code 1006/.test(l))).toBe(true);
    const secret = ws.ofType('auth:ok')[0].secret as string;
    expect(lines.join('\n')).not.toContain(secret);
    expect(lines.join('\n')).not.toContain('127.0.0.1');
  });
});
