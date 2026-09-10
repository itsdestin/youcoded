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
