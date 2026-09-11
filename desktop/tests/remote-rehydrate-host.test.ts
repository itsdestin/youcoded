// Remote access batch 2, design §6 (T4): Refresh is a restore — the host moves
// that client back to restoring, takes the snapshot, sends chat:hydrate {seq},
// flushes with the same cut line and returns it to live, without the terminal
// and permission replays.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

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
});
