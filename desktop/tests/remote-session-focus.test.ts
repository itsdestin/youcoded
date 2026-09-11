// Remote access batch 2, design §2/§3 (T3): when a session goes away, the
// phone is told what the desktop is showing, so it can open that instead of
// guessing; and a remote client cannot write the desktop's selection cache.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('ws', async () => {
  const { EventEmitter: EE } = await import('events');
  class MockWebSocketServer extends EE { clients = new Set(); close = vi.fn((cb?: () => void) => cb?.()); constructor(_o?: unknown) { super(); } }
  const MockWebSocket: { (): void; OPEN: number } = Object.assign(vi.fn(), { OPEN: 1 });
  return { WebSocketServer: MockWebSocketServer, WebSocket: MockWebSocket };
});

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
  it('session:selected from the socket is ignored — no reply, no cache write', async () => {
    const { server, frames, client, getFocusSessionId } = await makeServer('s2');
    await server.handleMessage(client, JSON.stringify({ type: 'session:selected', id: 'x1', payload: { sessionId: 'evil' } }));
    expect(frames).toEqual([]);
    expect(getFocusSessionId).not.toHaveBeenCalled();
  });
});
