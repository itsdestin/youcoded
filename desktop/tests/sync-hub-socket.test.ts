// State-machine tests for the main-process SyncHub socket (Plan 1b, Task 4).
// Uses the injectable WebSocketCtor + vitest fake timers — NO network, no real
// 'ws' sockets. The FakeSocket models exactly the event-emitter surface the
// client consumes (on/send/close/readyState). Cloned from
// tests/presence-socket.test.ts's harness; assertions adapted to the nine
// SyncHub behaviors in the plan.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSyncHubSocket, type SyncHubWebSocketLike } from '../src/main/sync-hub-socket';

class FakeSocket implements SyncHubWebSocketLike {
  static instances: FakeSocket[] = [];
  listeners = new Map<string, Array<(...args: any[]) => void>>();
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  readyState = 0; // CONNECTING — flips to OPEN(1) on emit('open'), CLOSED(3) on emit('close')
  constructor(public url: string, public opts: { headers: Record<string, string> }) {
    FakeSocket.instances.push(this);
  }
  on(event: string, listener: (...args: any[]) => void) {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
    return this;
  }
  send(data: string) { this.sent.push(data); }
  close(code?: number, reason?: string) { this.closeCalls.push({ code, reason }); }
  emit(event: string, ...args: any[]) {
    if (event === 'open') this.readyState = 1;
    if (event === 'close') this.readyState = 3;
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
}

function makeSocket(getToken: () => string | null, deviceName = 'my-laptop') {
  const events: Array<Record<string, unknown>> = [];
  const sock = createSyncHubSocket({
    getToken,
    deviceName,
    onEvent: (ev) => events.push(ev),
    WebSocketCtor: FakeSocket as any,
  });
  return { sock, events };
}

const types = (events: Array<Record<string, unknown>>) => events.map((e) => e.type);

describe('sync-hub-socket state machine', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Behavior 1: setDesired(true) with a token constructs a socket whose url
  // targets /sync/hub?device= and whose headers carry Bearer <token>.
  it('constructs a socket to /sync/hub?device= with the Bearer token header', () => {
    const { sock } = makeSocket(() => 'tok', 'my-laptop');
    sock.setDesired(true);
    expect(FakeSocket.instances).toHaveLength(1);
    const inst = FakeSocket.instances[0];
    expect(inst.url).toContain('/sync/hub?device=');
    expect(inst.url).toContain('device=my-laptop');
    expect(inst.opts.headers.Authorization).toBe('Bearer tok');
    sock.destroy();
  });

  it('sends expected holder only on conditional force and refuses malformed force rather than sending legacy force', async () => {
    const { sock } = makeSocket(() => 'tok');
    sock.setDesired(true); const ws = FakeSocket.instances[0]; ws.emit('open');
    expect(await sock.request('force-acquire-if-holder', 'session', 'requester')).toBeNull();
    expect(await sock.request('force-acquire-if-holder', 'session', 'requester', undefined, '../bad')).toBeNull();
    expect(ws.sent).toHaveLength(0);
    const result = sock.request('force-acquire-if-holder', 'session', 'requester', undefined, 'original');
    const sent = JSON.parse(ws.sent[0]);
    expect(sent).toMatchObject({ type: 'lease', op: 'force-acquire-if-holder', sessionId: 'session',
      deviceId: 'requester', expectedHolderId: 'original' });
    expect(sent).not.toHaveProperty('transferNonce');
    ws.emit('message', JSON.stringify({ type: 'lease-result', reqId: sent.reqId,
      op: 'force-acquire-if-holder', sessionId: 'session', ok: true, holder: { deviceId: 'requester' } }));
    expect(await result).toMatchObject({ ok: true, op: 'force-acquire-if-holder', holder: { deviceId: 'requester' } });
    sock.destroy();
  });

  // Behavior 2: No token → no socket construction; a retry is scheduled at the
  // max backoff. Once a token appears, advancing the timer constructs a socket.
  it('bails without a token but retries on a timer; connects once a token appears', () => {
    let token: string | null = null;
    const { sock, events } = makeSocket(() => token);

    sock.setDesired(true); // pre-sign-in — normal state, not an error
    expect(FakeSocket.instances).toHaveLength(0);
    expect(events).toEqual([]);

    // No token yet: the retry hasn't fired, so still nothing (and still no error).
    vi.advanceTimersByTime(29_999);
    expect(FakeSocket.instances).toHaveLength(0);

    // The no-token retry must keep POLLING, not stop after one attempt — the
    // service has no renderer to re-invoke it, so a still-tokenless retry has to
    // reschedule itself.
    vi.advanceTimersByTime(30_000); // second retry fires, still no token
    expect(FakeSocket.instances).toHaveLength(0);
    vi.advanceTimersByTime(30_000); // third retry fires, still no token
    expect(FakeSocket.instances).toHaveLength(0);

    // Sign-in completes mid-wait; the next 30s retry fires and now finds a token.
    token = 'tok';
    vi.advanceTimersByTime(30_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0].opts.headers.Authorization).toBe('Bearer tok');
    sock.destroy();
  });

  // Behavior 3: On open → onEvent({type:'connected'}).
  it('emits connected on open and reports isConnected', () => {
    const { sock, events } = makeSocket(() => 'tok');
    sock.setDesired(true);
    expect(sock.isConnected()).toBe(false); // handshake not done yet
    FakeSocket.instances[0].emit('open');
    expect(types(events)).toEqual(['connected']);
    expect(sock.isConnected()).toBe(true);
    sock.destroy();
  });

  // Behavior 4: Incoming signal frame → onEvent signal. Task 2 recency: `at`
  // (server timestamp) is now FORWARDED; the legacy `device` hostname label is
  // still ignored (the consumer joins on the durable `deviceId`, not hostname).
  it('flattens an incoming live signal frame to a signal event, forwarding at but ignoring the legacy device label', () => {
    const { sock, events } = makeSocket(() => 'tok');
    sock.setDesired(true);
    const inst = FakeSocket.instances[0];
    inst.emit('open');
    inst.emit('message', JSON.stringify({
      type: 'signal', kind: 'space-updated', spaceKey: 'k', device: 'other', at: 123,
    }));
    expect(events[1]).toEqual({ type: 'signal', kind: 'space-updated', spaceKey: 'k', at: 123 });
    sock.destroy();
  });

  // Behavior 5: hello.replay entries are flattened into one signal event each —
  // replay and live signals are identical to the consumer.
  it('flattens hello.replay into one signal event per entry', () => {
    const { sock, events } = makeSocket(() => 'tok');
    sock.setDesired(true);
    const inst = FakeSocket.instances[0];
    inst.emit('open');
    inst.emit('message', JSON.stringify({
      type: 'hello',
      replay: [
        { kind: 'space-updated', spaceKey: 'a', device: 'd1', at: 1 },
        { kind: 'space-updated', spaceKey: 'b', device: 'd2', at: 2 },
      ],
    }));
    expect(types(events)).toEqual(['connected', 'signal', 'signal']);
    // Task 2 recency: `at` is forwarded on replay entries too (device label ignored).
    expect(events[1]).toEqual({ type: 'signal', kind: 'space-updated', spaceKey: 'a', at: 1 });
    expect(events[2]).toEqual({ type: 'signal', kind: 'space-updated', spaceKey: 'b', at: 2 });
    sock.destroy();
  });

  // Hardening (review): one malformed replay entry must not throw out of the
  // flatten loop and strand the rest of the batch, nor emit undefined fields.
  it('skips malformed replay entries without dropping the valid ones around them', () => {
    const { sock, events } = makeSocket(() => 'tok');
    sock.setDesired(true);
    const inst = FakeSocket.instances[0];
    inst.emit('open');
    inst.emit('message', JSON.stringify({
      type: 'hello',
      replay: [
        { kind: 'space-updated', spaceKey: 'a', device: 'd1', at: 1 },
        null, // malformed: would TypeError on entry.kind without the guard
        { kind: 'space-updated' }, // malformed: missing spaceKey
        { kind: 'space-updated', spaceKey: 'b', device: 'd2', at: 2 },
      ],
    }));
    expect(types(events)).toEqual(['connected', 'signal', 'signal']);
    expect(events[1]).toEqual({ type: 'signal', kind: 'space-updated', spaceKey: 'a', at: 1 });
    expect(events[2]).toEqual({ type: 'signal', kind: 'space-updated', spaceKey: 'b', at: 2 });

    // Live signal frames get the same guard — missing fields emit nothing.
    inst.emit('message', JSON.stringify({ type: 'signal', kind: 'space-updated' }));
    expect(types(events)).toEqual(['connected', 'signal', 'signal']);
    sock.destroy();
  });

  // ---- Task 2: per-device recency (deviceId on connect, at+deviceId on
  // signals, lastSyncByDevice hello map). Additive + backward-compatible. ----

  it('appends &deviceId to the connect url when the deviceId opt is set, omits it when absent or empty', () => {
    const mk = (deviceId?: string) => {
      FakeSocket.instances = [];
      const sock = createSyncHubSocket({
        getToken: () => 'tok', deviceName: 'my-laptop', deviceId,
        onEvent: () => {}, WebSocketCtor: FakeSocket as any,
      });
      sock.setDesired(true);
      const url = FakeSocket.instances[0].url;
      sock.destroy();
      return url;
    };
    // Set → appended (and URL-encoded).
    expect(mk('machine-123')).toContain('&deviceId=machine-123');
    expect(mk('a b/c')).toContain(`&deviceId=${encodeURIComponent('a b/c')}`);
    // Absent → omitted entirely (old app / no built-app machineId).
    expect(mk(undefined)).not.toContain('deviceId=');
    // Empty string → omitted (never send a blank id).
    expect(mk('')).not.toContain('deviceId=');
  });

  it('forwards at + deviceId on a live signal frame', () => {
    const { sock, events } = makeSocket(() => 'tok');
    sock.setDesired(true);
    const inst = FakeSocket.instances[0];
    inst.emit('open');
    inst.emit('message', JSON.stringify({
      type: 'signal', kind: 'space-updated', spaceKey: 'k', deviceId: 'machine-9', at: 1_720_000_000_000,
    }));
    expect(events[1]).toEqual({ type: 'signal', kind: 'space-updated', spaceKey: 'k', deviceId: 'machine-9', at: 1_720_000_000_000 });
    sock.destroy();
  });

  it('emits a sync-map event from a hello frame carrying lastSyncByDevice (seed), alongside replay signals', () => {
    const { sock, events } = makeSocket(() => 'tok');
    sock.setDesired(true);
    const inst = FakeSocket.instances[0];
    inst.emit('open');
    const map = { 'machine-1': 111, 'machine-2': 222 };
    inst.emit('message', JSON.stringify({
      type: 'hello',
      replay: [{ kind: 'space-updated', spaceKey: 'a', at: 5 }],
      lastSyncByDevice: map,
    }));
    // Both the seed map AND the replay signal come through.
    expect(events).toContainEqual({ type: 'sync-map', map });
    expect(events).toContainEqual({ type: 'signal', kind: 'space-updated', spaceKey: 'a', at: 5 });
    sock.destroy();
  });

  it('emits no sync-map when hello omits lastSyncByDevice (old worker, backward compat)', () => {
    const { sock, events } = makeSocket(() => 'tok');
    sock.setDesired(true);
    const inst = FakeSocket.instances[0];
    inst.emit('open');
    inst.emit('message', JSON.stringify({ type: 'hello', replay: [] }));
    expect(types(events)).toEqual(['connected']); // connected only — no sync-map, no signal
    sock.destroy();
  });

  it('still emits {kind,spaceKey} for a signal frame with no at/deviceId (old worker, backward compat)', () => {
    const { sock, events } = makeSocket(() => 'tok');
    sock.setDesired(true);
    const inst = FakeSocket.instances[0];
    inst.emit('open');
    inst.emit('message', JSON.stringify({ type: 'signal', kind: 'space-updated', spaceKey: 'k' }));
    // Undefined at/deviceId are omitted — the sync-trigger consumer at
    // service.ts is undisturbed (it reads only kind/spaceKey).
    expect(events[1]).toEqual({ type: 'signal', kind: 'space-updated', spaceKey: 'k' });
    sock.destroy();
  });

  // Behavior 6: sendSignal on an OPEN socket sends the JSON frame and returns
  // true; on a closed socket it's a silent no-op returning false.
  it('sendSignal sends the frame + returns true when open, no-ops + returns false when closed', () => {
    const { sock } = makeSocket(() => 'tok');
    // Closed: silent no-op.
    expect(sock.sendSignal('space-updated', 'k')).toBe(false);

    sock.setDesired(true);
    const inst = FakeSocket.instances[0];
    // Still CONNECTING (not OPEN): no-op.
    expect(sock.sendSignal('space-updated', 'k')).toBe(false);
    expect(inst.sent).toEqual([]);

    inst.emit('open');
    expect(sock.sendSignal('space-updated', 'k')).toBe(true);
    expect(inst.sent).toEqual([JSON.stringify({ type: 'signal', kind: 'space-updated', spaceKey: 'k' })]);
    sock.destroy();
  });

  // Behavior 7: Unexpected close → disconnected + reconnect with capped
  // exponential backoff (1s, 2s, 5s, 10s, 30s, 30s…).
  it('reconnects on unexpected close with capped exponential backoff', () => {
    const { sock, events } = makeSocket(() => 'tok');
    sock.setDesired(true);
    FakeSocket.instances[0].emit('open');
    FakeSocket.instances[0].emit('close', 1006, 'blip');
    expect(types(events)).toEqual(['connected', 'disconnected']);

    // Reconnect ladder: 1s, 2s, 5s, 10s, 30s, 30s (capped). No open() between
    // closes, so attempts climbs and the cap holds at 30s.
    const ladder = [1_000, 2_000, 5_000, 10_000, 30_000, 30_000];
    let expected = 1; // one socket exists so far
    for (const delay of ladder) {
      vi.advanceTimersByTime(delay - 1);
      expect(FakeSocket.instances).toHaveLength(expected); // not a tick early
      vi.advanceTimersByTime(1);
      expected += 1;
      expect(FakeSocket.instances).toHaveLength(expected);
      FakeSocket.instances[expected - 1].emit('close', 1006, 'blip');
    }
    sock.destroy();
  });

  it('resets the backoff attempts counter on a successful open', () => {
    const { sock } = makeSocket(() => 'tok');
    sock.setDesired(true);
    FakeSocket.instances[0].emit('open');
    FakeSocket.instances[0].emit('close', 1006, 'blip'); // schedules retry at 1000ms
    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.instances).toHaveLength(2);

    FakeSocket.instances[1].emit('close', 1006, 'blip'); // no open → next is 2000ms
    vi.advanceTimersByTime(2_000);
    expect(FakeSocket.instances).toHaveLength(3);

    // Successful open resets attempts → next failure starts back at 1000ms.
    FakeSocket.instances[2].emit('open');
    FakeSocket.instances[2].emit('close', 1006, 'blip');
    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.instances).toHaveLength(4);
    sock.destroy();
  });

  // Behavior 8: setDesired(false) closes with code 1000 and does NOT reconnect.
  it('setDesired(false) closes with code 1000 and never reconnects', () => {
    const { sock, events } = makeSocket(() => 'tok');
    sock.setDesired(true);
    const inst = FakeSocket.instances[0];
    inst.emit('open');

    sock.setDesired(false);
    expect(inst.closeCalls).toHaveLength(1);
    expect(inst.closeCalls[0].code).toBe(1000);
    expect(types(events)).toEqual(['connected', 'disconnected']);

    // The socket's own async close event is inert (superseded), and no reconnect
    // is ever scheduled.
    inst.emit('close', 1000, 'server-ack');
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(types(events)).toEqual(['connected', 'disconnected']);
    sock.destroy();
  });

  it('setDesired(false) cancels a pending reconnect retry', () => {
    const { sock, events } = makeSocket(() => 'tok');
    sock.setDesired(true);
    FakeSocket.instances[0].emit('open');
    FakeSocket.instances[0].emit('close', 1006, 'blip'); // schedules retry in 1000ms

    sock.setDesired(false); // ws already null → no extra local-disconnect event
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.instances).toHaveLength(1); // no reconnect ever happened
    expect(types(events)).toEqual(['connected', 'disconnected']);
    sock.destroy();
  });

  // Behavior 9: a JSON ping frame is sent every 30s while open.
  it('sends a JSON ping every 30s while open', () => {
    const { sock } = makeSocket(() => 'tok');
    sock.setDesired(true);
    const inst = FakeSocket.instances[0];
    inst.emit('open');

    vi.advanceTimersByTime(30_000);
    expect(inst.sent).toEqual([JSON.stringify({ type: 'ping' })]);
    vi.advanceTimersByTime(30_000);
    expect(inst.sent).toEqual([
      JSON.stringify({ type: 'ping' }),
      JSON.stringify({ type: 'ping' }),
    ]);
    sock.destroy();
  });

  it('open-supersede: a disconnect during the handshake window leaks no ping timer and emits no spurious connected', () => {
    const { sock, events } = makeSocket(() => 'tok');
    sock.setDesired(true);
    const inst = FakeSocket.instances[0];

    sock.setDesired(false); // tear down before the handshake completes
    expect(inst.closeCalls).toHaveLength(1);

    inst.emit('open'); // in-flight open fires on the superseded socket
    expect(types(events)).toEqual(['disconnected']); // no spurious 'connected'
    expect(sock.isConnected()).toBe(false);

    vi.advanceTimersByTime(120_000);
    expect(inst.sent).toEqual([]); // no leaked ping timer
    sock.destroy();
  });

  // ---- Task 5: lease request/response frames + request correlation ----

  // Helper: pull the reqId the client generated out of the frame it sent, so the
  // test can echo back a matching lease-result (the client owns the reqId).
  function sentReqId(inst: FakeSocket): string {
    const last = JSON.parse(inst.sent[inst.sent.length - 1]);
    return last.reqId;
  }

  // Lease 1: request() on an OPEN socket sends a {type:'lease',...} frame and
  // resolves the matching lease-result (by reqId) with the holder mapped.
  it('request sends a lease frame and resolves the matching lease-result by reqId', async () => {
    const { sock } = makeSocket(() => 'tok');
    sock.setDesired(true);
    const inst = FakeSocket.instances[0];
    inst.emit('open');

    const p = sock.request('acquire', 'sess-1', 'dev-1');
    const frame = JSON.parse(inst.sent[inst.sent.length - 1]);
    expect(frame).toMatchObject({ type: 'lease', op: 'acquire', sessionId: 'sess-1', deviceId: 'dev-1' });
    expect(typeof frame.reqId).toBe('string');

    const holder = { deviceId: 'dev-2', device: 'Other', expiresAt: 999 };
    inst.emit('message', JSON.stringify({
      type: 'lease-result', reqId: frame.reqId, op: 'acquire', sessionId: 'sess-1', ok: true, holder,
    }));
    await expect(p).resolves.toEqual({ ok: true, op: 'acquire', sessionId: 'sess-1', holder });
    sock.destroy();
  });

  // Lease 2: a lease-result whose reqId does NOT match must not resolve the
  // pending request. The correct reqId (or the 5s timeout) still resolves it.
  it('does not resolve a request on a mismatched reqId', async () => {
    const { sock } = makeSocket(() => 'tok');
    sock.setDesired(true);
    const inst = FakeSocket.instances[0];
    inst.emit('open');

    const p = sock.request('acquire', 'sess-1', 'dev-1');
    let settled: unknown = 'PENDING';
    void p.then((v) => { settled = v; });

    // Wrong reqId → ignored, promise still pending.
    inst.emit('message', JSON.stringify({ type: 'lease-result', reqId: 'r-nope', op: 'acquire', sessionId: 'sess-1', ok: true, holder: null }));
    await Promise.resolve();
    expect(settled).toBe('PENDING');

    // Correct reqId → resolves.
    const reqId = sentReqId(inst);
    inst.emit('message', JSON.stringify({ type: 'lease-result', reqId, op: 'acquire', sessionId: 'sess-1', ok: false, holder: null }));
    await Promise.resolve();
    expect(settled).toEqual({ ok: false, op: 'acquire', sessionId: 'sess-1', holder: null });
    sock.destroy();
  });

  // Lease 3: a request with no matching response times out to null after 5s.
  it('request times out to null after 5s', async () => {
    const { sock } = makeSocket(() => 'tok');
    sock.setDesired(true);
    const inst = FakeSocket.instances[0];
    inst.emit('open');

    const p = sock.request('acquire', 'sess-1', 'dev-1');
    vi.advanceTimersByTime(5_000);
    await expect(p).resolves.toBeNull();
    sock.destroy();
  });

  // Lease 4: request() resolves null immediately (never-block) when not connected.
  it('request resolves null immediately when not connected', async () => {
    const { sock } = makeSocket(() => 'tok');
    // No socket at all.
    await expect(sock.request('acquire', 'sess-1', 'dev-1')).resolves.toBeNull();

    // Connecting (not OPEN yet) → still null, no frame sent.
    sock.setDesired(true);
    const inst = FakeSocket.instances[0];
    await expect(sock.request('acquire', 'sess-1', 'dev-1')).resolves.toBeNull();
    expect(inst.sent).toEqual([]);
    sock.destroy();
  });

  // Lease 5a: a pending request is resolved to null when the socket goes down
  // (unexpected close → handleDown → failAllPending). A stranded request must
  // never hang across a reconnect.
  it('resolves a pending request to null when the socket goes down', async () => {
    const { sock } = makeSocket(() => 'tok');
    sock.setDesired(true);
    const inst = FakeSocket.instances[0];
    inst.emit('open');

    const p = sock.request('acquire', 'sess-1', 'dev-1');
    inst.emit('close', 1006, 'blip'); // drives handleDown → failAllPending
    await expect(p).resolves.toBeNull();
    sock.destroy();
  });

  // Lease 5b: intentional teardown (setDesired(false)) also fails pending requests.
  it('resolves a pending request to null on setDesired(false)', async () => {
    const { sock } = makeSocket(() => 'tok');
    sock.setDesired(true);
    const inst = FakeSocket.instances[0];
    inst.emit('open');

    const p = sock.request('acquire', 'sess-1', 'dev-1');
    sock.setDesired(false); // intentional teardown → failAllPending
    await expect(p).resolves.toBeNull();
    sock.destroy();
  });

  it('relays an optional takeover nonce and authoritative holder identity without confusing reqId', async () => {
    const { sock, events } = makeSocket(() => 'tok');
    sock.setDesired(true);
    const inst = FakeSocket.instances[0]; inst.emit('open');
    const nonce = '3db07e20-1244-4a1b-85bf-bde2db925e41';
    const pending = sock.request('takeover', 's', 'requester-1', nonce);
    const frame = JSON.parse(inst.sent.at(-1)!);
    expect(frame.transferNonce).toBe(nonce);
    expect(frame.reqId).not.toBe(nonce);
    inst.emit('message', JSON.stringify({ type: 'lease-result', reqId: frame.reqId, ok: true, op: 'takeover', sessionId: 's' }));
    await pending;
    inst.emit('message', JSON.stringify({ type: 'lease-event', kind: 'takeover-request', sessionId: 's',
      from: { deviceId: 'requester-1', device: 'Label' }, senderDeviceId: 'holder-1', transferNonce: nonce }));
    expect(events.at(-1)).toMatchObject({ transferNonce: nonce, senderDeviceId: 'holder-1' });
    const beforeInvalid = inst.sent.length;
    expect(await sock.request('takeover', 's', 'requester-1', 'not-a-uuid')).toBeNull();
    expect(inst.sent).toHaveLength(beforeInvalid);
    const legacy = sock.request('takeover', 's', 'requester-1');
    expect(JSON.parse(inst.sent.at(-1)!)).not.toHaveProperty('transferNonce');
    const oldFrame = JSON.parse(inst.sent.at(-1)!);
    inst.emit('message', JSON.stringify({ type: 'lease-result', reqId: oldFrame.reqId, ok: true, op: 'takeover', sessionId: 's' }));
    await legacy;
    sock.destroy();
  });

  // Lease 6: lease-event frames emit as SyncHubEvents (unsolicited server pushes,
  // not tied to a reqId).
  it('emits lease-event frames as onEvent lease-event', () => {
    const { sock, events } = makeSocket(() => 'tok');
    sock.setDesired(true);
    const inst = FakeSocket.instances[0];
    inst.emit('open');

    inst.emit('message', JSON.stringify({ type: 'lease-event', kind: 'released', sessionId: 's', device: 'D' }));
    expect(events[events.length - 1]).toEqual({ type: 'lease-event', kind: 'released', sessionId: 's', device: 'D' });

    inst.emit('message', JSON.stringify({
      type: 'lease-event', kind: 'takeover-request', sessionId: 's2', from: { deviceId: 'dev-2', device: 'Other' },
    }));
    expect(events[events.length - 1]).toEqual({
      type: 'lease-event', kind: 'takeover-request', sessionId: 's2', from: { deviceId: 'dev-2', device: 'Other' },
    });

    // Malformed lease-event (missing sessionId) emits nothing.
    const before = events.length;
    inst.emit('message', JSON.stringify({ type: 'lease-event', kind: 'released' }));
    expect(events.length).toBe(before);
    sock.destroy();
  });
});
