// Phones as members of the window registry (one-core R5-1, seam S6): negative ids, no filtering yet.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { WindowRegistry } from '../src/main/window-registry';
import { startSessionSummaryPush } from '../src/main/session-summary-push';
import { SessionRecords } from '../src/main/session-record';

describe('WindowRegistry — phones as audience members', () => {
  let reg: WindowRegistry;
  beforeEach(() => {
    reg = new WindowRegistry();
    reg.registerWindow(10, 1);
    reg.registerWindow(11, 2, 'buddy');
  });

  it('accepts only negative ids, so a phone can never collide with a window', () => {
    expect(() => reg.registerSocket(5)).toThrow(/negative/);
    expect(() => reg.registerSocket(0)).toThrow(/negative/);
    reg.registerSocket(-1);
    expect(reg.isSocket(-1)).toBe(true);
    expect(reg.isSocket(10)).toBe(false);
  });

  it('are not windows: the directory, the leader and the window list never see them, and joining announces nothing', () => {
    const changed = vi.fn();
    reg.on('changed', changed);
    reg.registerSocket(-1);
    reg.registerSocket(-2);
    expect(reg.getWindowIds()).toEqual([10, 11]);
    expect(reg.getMainWindowIds()).toEqual([10]);
    expect(reg.getLeaderId()).toBe(10);
    expect(changed).not.toHaveBeenCalled();
    reg.unregisterSocket(-2);
    expect(changed).not.toHaveBeenCalled();
    expect(reg.getSocketIds()).toEqual([-1]);
  });

  it('leaving takes its subscriptions with it', () => {
    reg.registerSocket(-1);
    reg.subscribe('s1', -1);
    expect(reg.getSocketWatchers('s1')).toEqual([-1]);
    reg.unregisterSocket(-1);
    expect(reg.getSocketWatchers('s1')).toEqual([]);
  });

  it('a socket\'s watch is not a window subscriber: callers that treat subscribers as webContents ids never see it', () => {
    reg.registerSocket(-1);
    reg.subscribe('s1', 11);
    reg.subscribe('s1', -1);
    expect(reg.getSubscribers('s1')).toEqual(new Set([11]));
  });

  it('an unregistered id still cannot subscribe', () => {
    expect(() => reg.subscribe('s1', 999)).toThrow(/unknown window/);
    expect(() => reg.subscribe('s1', -9)).toThrow(/unknown window/);
  });

  it('resolves a session\'s audience: owner plus subscribers, every phone, and the primary fallback only when no window is there', () => {
    reg.registerSocket(-1);
    reg.registerSocket(-2);
    expect(reg.resolveAudience('s1')).toEqual({ windowIds: [], socketIds: [-1, -2], fallbackToPrimary: true });
    reg.assignSession('s1', 10);
    reg.subscribe('s1', 11);
    expect(reg.resolveAudience('s1')).toEqual({ windowIds: [10, 11], socketIds: [-1, -2], fallbackToPrimary: false });
  });
});

describe('RemoteServer — a connected phone joins and leaves the registry', () => {
  async function makeServer(audience: WindowRegistry) {
    const { RemoteServer } = await import('../src/main/remote-server');
    return new RemoteServer(Object.assign(new EventEmitter(), { getAllSessions: () => [] }) as never, new EventEmitter() as never, { enabled: true, port: 9900, toSafeObject: () => ({}) } as never, undefined, { audience }) as any;
  }
  // addClient is what a signed-in socket goes through; the auth handshake itself is covered in remote-server-connections.test.ts.
  function connect(server: any, deviceId = 'device-1') {
    const ws: any = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, sent: [] as any[], send(raw: string) { this.sent.push(JSON.parse(raw)); }, close: vi.fn() });
    server.addClient(ws, deviceId, '127.0.0.1');
    const client = [...server.clients].find((c: any) => c.ws === ws);
    client.phase = 'live'; // past its restore: broadcasts go straight to the socket
    return { ws, client };
  }

  it('is registered with a negative id when it connects and removed when it drops', async () => {
    const reg = new WindowRegistry();
    const server = await makeServer(reg);
    const { ws } = connect(server);
    expect(reg.getSocketIds()).toHaveLength(1);
    expect(reg.getSocketIds()[0]).toBeLessThan(0);
    ws.emit('close', 1000, Buffer.from(''));
    expect(reg.getSocketIds()).toEqual([]);
    server.stop(true);
  });

  it('two phones never share an id, nor one with a watch id', async () => {
    const reg = new WindowRegistry();
    const server = await makeServer(reg);
    const a = connect(server, 'a');
    const b = connect(server, 'b');
    const watchId = server.watchSubscriberId(a.client);
    const ids = [...reg.getSocketIds(), watchId];
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id: number) => id < 0)).toBe(true);
    server.stop(true);
    expect(b.client.audienceId).toBeLessThan(0);
  });

  it('stopping the server removes every phone', async () => {
    const reg = new WindowRegistry();
    const server = await makeServer(reg);
    connect(server);
    server.stop(true);
    expect(reg.getSocketIds()).toEqual([]);
  });

  it('a broadcast with no audience list reaches every phone; with one, only the phones named; a phone outside the registry is always reached', async () => {
    const reg = new WindowRegistry();
    const server = await makeServer(reg);
    const p1 = connect(server, 'p1');
    const p2 = connect(server, 'p2');
    // A client record added straight to the set predates the registry (the shape older tests build): it has no audience id.
    const legacyWs: any = { readyState: 1, bufferedAmount: 0, sent: [] as string[], send(raw: string) { this.sent.push(raw); }, close: vi.fn() };
    server.clients.add({ id: 'x', ws: legacyWs, deviceId: 'd', ip: 'i', connectedAt: 0, phase: 'live' });
    server.broadcast({ type: 'x:y', payload: 1 });
    expect([p1.ws.sent.length, p2.ws.sent.length, legacyWs.sent.length]).toEqual([1, 1, 1]);
    server.broadcast({ type: 'x:y', payload: 2 }, [p1.client.audienceId]);
    expect([p1.ws.sent.length, p2.ws.sent.length, legacyWs.sent.length]).toEqual([2, 1, 2]);
    server.stop(true);
  });
});

describe('the per-session summary push', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('sends the facts once, again only when they change, and a phone that connects later gets the current ones', async () => {
    const records = new SessionRecords();
    records.begin('s1');
    const deliver = vi.fn();
    let phoneConnected: () => void = () => {};
    const push = startSessionSummaryPush({ records, deliver, hasAudience: () => true, onPhoneConnected: (l) => { phoneConnected = l; return () => {}; } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toEqual({ summaries: { s1: expect.objectContaining({ working: false, awaitingCount: 0, attention: 'ok' }) } });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(deliver).toHaveBeenCalledTimes(1); // nothing changed: nothing sent
    records.note('s1', 'transcript:event', { sessionId: 's1', type: 'user-message', uuid: 'u', timestamp: 1, data: { text: 'go' } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1][0].summaries.s1.working).toBe(true);
    phoneConnected();
    expect(deliver).toHaveBeenCalledTimes(3); // the same facts again, for the phone that just joined
    push.stop();
  });

  it('says nothing while no session exists, and nothing while nobody is looking', async () => {
    const records = new SessionRecords();
    const deliver = vi.fn();
    let looking = false;
    const push = startSessionSummaryPush({ records, deliver, hasAudience: () => looking });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deliver).not.toHaveBeenCalled();
    records.begin('s1');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deliver).not.toHaveBeenCalled(); // changed, but nobody is looking
    looking = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    push.stop();
  });

  it('does not carry the last-activity time (it would make every push differ)', async () => {
    const records = new SessionRecords();
    records.begin('s1');
    expect(JSON.stringify(records.summaries())).not.toMatch(/lastActivity/);
  });
});
