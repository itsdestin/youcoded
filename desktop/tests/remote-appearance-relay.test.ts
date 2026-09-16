// The host half of tests/remote-appearance-sync.test.ts (Destin, 2026-09-11: the phone kept
// an old theme until reloaded). A theme change made on one phone must reach the computer's
// windows and every OTHER phone; a change made on the computer must reach every phone.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'node:fs';
import path from 'node:path';

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

describe('main: a theme change on the computer reaches phones', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.ts'), 'utf8');
  it('the window relay also broadcasts appearance:sync to remote clients', () => {
    const relay = mainSource.match(/ipcMain\.on\(IPC\.APPEARANCE_BROADCAST,[\s\S]*?\n  \}\);/)?.[0] ?? '';
    expect(relay).toMatch(/remoteServer\.broadcast\(\{\s*type:\s*IPC\.APPEARANCE_SYNC/);
  });
  it('the remote server is told how to reach the computer\'s windows', () => {
    expect(mainSource).toMatch(/onAppearanceBroadcast:/);
  });
});
