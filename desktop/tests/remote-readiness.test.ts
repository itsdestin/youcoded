// Remote access batch 2, design §1 A/B and §6 seq (T1): the phone tells the
// host when it is ready, and the host queues every broadcast for it until the
// restore is done — so the chat fills in when the phone is ready, not after a
// timer (contract R6), and nothing is shown twice (R5).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { join } from 'node:path';
import { readStripped, assertPatternMatches } from './helpers/guard-scope';

vi.mock('ws', async () => {
  const { EventEmitter: EE } = await import('events');
  class MockWebSocketServer extends EE { clients = new Set(); close = vi.fn((cb?: () => void) => cb?.()); constructor(_o?: unknown) { super(); } }
  const MockWebSocket: { (): void; OPEN: number } = Object.assign(vi.fn(), { OPEN: 1 });
  return { WebSocketServer: MockWebSocketServer, WebSocket: MockWebSocket };
});

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
    const restoring = server.handleMessage(client, ready(1));
    await tick();
    server.broadcast({ type: 'native:model-state', payload: { sessionId: 's1', state: 'y' } });
    snap.resolve(snapshotOf(['s1']));
    await restoring;
    expect(ws.types()).not.toContain('native:session-context');
    expect(ws.types()).not.toContain('transcript:shrink');
    expect(ws.ofType('native:model-state').map((f) => f.payload.state)).toEqual(['y']);
    expect(ws.ofType('native:shell-event')).toHaveLength(1);
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

describe('the host has no fixed wait', () => {
  it('replays with no 500 ms timer — the only timer on the restore path is the 5 s old-client fallback', () => {
    const src = readStripped(join(__dirname, '..', 'src', 'main', 'remote-server.ts'));
    const halfSecondTimer = /\},\s*500\s*\)/g;                      // a callback closed and timed at 500
    assertPatternMatches(halfSecondTimer, '}, 500);', 'a setTimeout callback ending in `}, 500)`');
    expect(src.match(halfSecondTimer)).toBeNull();
    expect(src).toMatch(/OLD_CLIENT_FALLBACK_MS\s*=\s*5000/);
    expect(src).toMatch(/setTimeout\([\s\S]*?\}, OLD_CLIENT_FALLBACK_MS\);/);
  });
});
