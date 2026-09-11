// Remote access batch 2, design §7 (T2): a reconnect is cheap, exact, and does
// not lie about consent — the host sends only the terminal units the phone has
// not drawn, resets when it cannot, replays only unresolved permission asks and
// says which ones are still open, and pauses rather than drowning a slow phone.
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
  closed: { code: number; reason: string } | null = null;
  send(raw: string) { this.frames.push(JSON.parse(raw)); }
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
    const hooks = ws.ofType('hook:event').map((f) => f.payload.type);
    // The queued request is flushed (a reconnect keeps every hook event) and so is its
    // resolution, in order — the phone's card appears and is cleared with the neutral note.
    expect(hooks).toEqual(['PermissionRequest', 'PermissionResolved']);
    expect(ws.ofType('hook:replay-complete')[0].payload.pendingRequestIds).toEqual([]);
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
