// State-machine tests for the platform-owned presence socket (Task 6).
// Uses the injectable WebSocketCtor + vitest fake timers — NO network, no real
// 'ws' sockets. The fake models exactly the event-emitter surface the manager
// consumes (on/send/close/readyState).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPresenceSocket, wakeEvidence, SUSPEND_GRACE_MS, HUMAN_INPUT_TYPES, type PresenceWebSocketLike } from '../src/main/presence-socket';

class FakeSocket implements PresenceWebSocketLike {
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

function makeSocket(getToken: () => string | null) {
  const events: Array<Record<string, unknown>> = [];
  const sock = createPresenceSocket({
    getToken,
    onEvent: (ev) => events.push(ev),
    WebSocketCtor: FakeSocket as any,
  });
  return { sock, events };
}

const types = (events: Array<Record<string, unknown>>) => events.map((e) => e.type);

describe('presence-socket state machine', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects, emits connected, starts the JSON ping loop, reports isConnected', () => {
    const { sock, events } = makeSocket(() => 'tok');
    sock.setDesired(true);
    expect(FakeSocket.instances).toHaveLength(1);
    const inst = FakeSocket.instances[0];
    expect(inst.opts.headers.Authorization).toBe('Bearer tok');
    expect(sock.isConnected()).toBe(false); // handshake not done yet

    inst.emit('open');
    expect(types(events)).toEqual(['connected']);
    expect(sock.isConnected()).toBe(true);

    // 30s liveness ping (app-level JSON ping the DO answers with pong)
    vi.advanceTimersByTime(30_000);
    expect(inst.sent).toEqual([JSON.stringify({ type: 'ping' })]);
    sock.destroy();
  });

  it('open-supersede: disconnect during handshake window emits no spurious connected and leaks no ping timer', () => {
    const { sock, events } = makeSocket(() => 'tok');
    sock.setDesired(true);
    const inst = FakeSocket.instances[0];

    // Disconnect BEFORE the handshake completes (Task 7 toggles on
    // signedIn/incognito/leader changes, so this window is reachable).
    sock.setDesired(false);
    expect(events).toEqual([{ type: 'disconnected', code: 1000, reason: 'local' }]);
    expect(inst.closeCalls).toHaveLength(1);

    // The in-flight open now fires on the superseded socket.
    inst.emit('open');
    expect(types(events)).toEqual(['disconnected']); // no spurious 'connected' AFTER disconnected
    expect(sock.isConnected()).toBe(false);

    // No leaked ping timer: nothing is sent on the dead socket ever again.
    vi.advanceTimersByTime(120_000);
    expect(inst.sent).toEqual([]);

    // Its close event is also inert (no retry, no double disconnected).
    inst.emit('close', 1000, 'server-ack');
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(types(events)).toEqual(['disconnected']);
    sock.destroy();
  });

  it('no-token bails quietly, then a later presence-connect picks up the token', () => {
    let token: string | null = null;
    const { sock, events } = makeSocket(() => token);

    sock.setDesired(true); // pre-sign-in: normal state, not an error
    expect(FakeSocket.instances).toHaveLength(0);
    expect(events).toEqual([]);

    token = 'tok'; // sign-in completed; renderer re-invokes presence-connect
    sock.setDesired(true); // desired already true but disconnected — must fall through to connect()
    expect(FakeSocket.instances).toHaveLength(1);
    sock.destroy();
  });

  it('retries on capped backoff and resets attempts on a successful open', () => {
    const { sock, events } = makeSocket(() => 'tok');
    sock.setDesired(true);
    FakeSocket.instances[0].emit('open');
    FakeSocket.instances[0].emit('close', 1006, 'blip');
    expect(types(events)).toEqual(['connected', 'disconnected']);

    // First retry after BACKOFF[0] = 1000ms — not a tick earlier.
    vi.advanceTimersByTime(999);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);

    // Second consecutive failure: BACKOFF[1] = 2000ms.
    FakeSocket.instances[1].emit('close', 1006, 'blip');
    vi.advanceTimersByTime(1_999);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);

    // Successful open resets attempts → next failure starts back at 1000ms.
    FakeSocket.instances[2].emit('open');
    FakeSocket.instances[2].emit('close', 1006, 'blip');
    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.instances).toHaveLength(4);
    sock.destroy();
  });

  it('setDesired(false) cancels a pending retry', () => {
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

  it('renderer-reload replay: setDesired(true) on an already-open socket re-emits connected + the cached presence frame', () => {
    const { sock, events } = makeSocket(() => 'tok');
    sock.setDesired(true);
    const inst = FakeSocket.instances[0];
    inst.emit('open');
    const presenceFrame = { type: 'presence', users: [{ id: 'github:2', display_name: 'Bob', handle: 'bob', status: 'idle' }] };
    inst.emit('message', JSON.stringify(presenceFrame));
    expect(types(events)).toEqual(['connected', 'presence']);

    // A reloaded renderer (dev HMR / Ctrl+R) re-invokes presence-connect while
    // main still holds the open socket — without the replay it would stick on
    // "Connecting…" forever because only 'connected' flips the reducer flag.
    sock.setDesired(true);
    expect(types(events)).toEqual(['connected', 'presence', 'connected', 'presence']);
    expect(events[3]).toEqual(presenceFrame); // the CACHED snapshot, replayed verbatim
    expect(FakeSocket.instances).toHaveLength(1); // no second socket was opened
    sock.destroy();
  });

  it('renderer-reload replay folds deltas into the cached snapshot — departed friends are not resurrected', () => {
    const { sock, events } = makeSocket(() => 'tok');
    sock.setDesired(true);
    const inst = FakeSocket.instances[0];
    inst.emit('open');
    const bob = { id: 'github:2', display_name: 'Bob', handle: 'bob', status: 'idle' };
    inst.emit('message', JSON.stringify({ type: 'presence', users: [bob] }));

    // Live deltas after the snapshot: Carol joins and goes in-game; Bob leaves.
    const carol = { id: 'github:3', display_name: 'Carol', handle: 'carol', status: 'idle' };
    inst.emit('message', JSON.stringify({ type: 'user-joined', user: carol }));
    inst.emit('message', JSON.stringify({ type: 'user-status', id: 'github:3', status: 'in-game' }));
    inst.emit('message', JSON.stringify({ type: 'user-left', id: 'github:2' }));

    // A renderer reload must see the CURRENT roster, not the connect-time one —
    // replaying stale users is the client-side twin of the server ghost bug
    // (a departed friend pinned "Online" until the next full snapshot).
    const before = events.length;
    sock.setDesired(true);
    const replayed = events.slice(before);
    expect(types(replayed)).toEqual(['connected', 'presence']);
    expect((replayed[1] as any).users).toEqual([{ ...carol, status: 'in-game' }]);
    sock.destroy();
  });

  it('renderer-reload replay does NOT fire while the handshake is still in flight', () => {
    const { sock, events } = makeSocket(() => 'tok');
    sock.setDesired(true); // socket exists, still CONNECTING
    sock.setDesired(true); // duplicate connect request during handshake
    expect(events).toEqual([]); // the REAL open event will emit connected
    FakeSocket.instances[0].emit('open');
    expect(types(events)).toEqual(['connected']);
    sock.destroy();
  });

  it('system suspend closes the socket cleanly and resume reconnects (renderer intent preserved)', () => {
    const { sock, events } = makeSocket(() => 'tok');
    sock.setDesired(true);
    const inst = FakeSocket.instances[0];
    inst.emit('open');
    expect(sock.isConnected()).toBe(true);

    // Lid close / OS sleep → powerMonitor 'suspend'. The close frame must go
    // out NOW (while the network is still up) so friends see "Last seen just
    // now" immediately instead of waiting out the server's staleness timeout.
    sock.setSuspended(true);
    expect(inst.closeCalls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'disconnected', reason: 'local' });
    expect(sock.isConnected()).toBe(false);

    // macOS dark wake: the process may briefly run while still "asleep" —
    // no reconnect and no pings may fire ('resume' never fired).
    vi.advanceTimersByTime(300_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(inst.sent).toEqual([]);

    // Real wake → powerMonitor 'resume': reconnect because the renderer still
    // wants presence on.
    sock.setSuspended(false);
    expect(FakeSocket.instances).toHaveLength(2);
    sock.destroy();
  });

  it('suspend respects renderer intent: off stays off across resume, and intent changes made while asleep win', () => {
    const { sock } = makeSocket(() => 'tok');
    // Renderer never asked for presence (signed out / incognito): suspend and
    // resume must not conjure a connection.
    sock.setSuspended(true);
    sock.setSuspended(false);
    expect(FakeSocket.instances).toHaveLength(0);

    // Renderer turns presence ON while suspended (e.g. sign-in completes just
    // as the lid closes): remembered, but no socket until resume.
    sock.setSuspended(true);
    sock.setDesired(true);
    expect(FakeSocket.instances).toHaveLength(0);
    sock.setSuspended(false);
    expect(FakeSocket.instances).toHaveLength(1);

    // Renderer turns presence OFF while suspended (incognito toggle mid-sleep):
    // resume must NOT reconnect.
    sock.setSuspended(true);
    sock.setDesired(false);
    sock.setSuspended(false);
    expect(FakeSocket.instances).toHaveLength(1); // no new socket
    sock.destroy();
  });

  it('user-idle gate: extended idleness closes the socket, activity reconnects, renderer intent preserved', () => {
    const { sock, events } = makeSocket(() => 'tok');
    sock.setDesired(true);
    const inst = FakeSocket.instances[0];
    inst.emit('open');

    // 10+ min with no input anywhere (system or remote): presence must drop so
    // "Online" means a HUMAN is around — an app left running on an awake
    // machine (e.g. remote-access keep-awake) must not read online forever.
    sock.setIdle(true);
    expect(inst.closeCalls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'disconnected', reason: 'local' });
    expect(sock.isConnected()).toBe(false);

    // Input returns → reconnect (renderer still wants presence on).
    sock.setIdle(false);
    expect(FakeSocket.instances).toHaveLength(2);

    // Idle while the renderer wants presence OFF: clearing idle must not
    // conjure a connection.
    sock.setDesired(false);
    sock.setIdle(true);
    sock.setIdle(false);
    expect(FakeSocket.instances).toHaveLength(2);
    sock.destroy();
  });

  it('idle and suspend gates are independent: both must clear before reconnecting', () => {
    const { sock } = makeSocket(() => 'tok');
    sock.setDesired(true);
    FakeSocket.instances[0].emit('open');

    // Machine goes idle, THEN sleeps (the normal order at a desk).
    sock.setIdle(true);
    sock.setSuspended(true);
    expect(FakeSocket.instances).toHaveLength(1);

    // Wake without input (dark wake / lid opened by a bump): still idle — the
    // resume alone must NOT reconnect and flash a false "Online" at friends.
    sock.setSuspended(false);
    expect(FakeSocket.instances).toHaveLength(1);

    // Real input arrives → both gates clear → reconnect.
    sock.setIdle(false);
    expect(FakeSocket.instances).toHaveLength(2);
    sock.destroy();
  });

  it('send is a silent no-op when disconnected; isConnected gates the honest handler receipt', () => {
    const { sock } = makeSocket(() => 'tok');
    // The manager itself no-ops; the HANDLER (social-handlers.ts) consults
    // isConnected() to return {ok:false, status:0, message:'not connected'}.
    expect(sock.isConnected()).toBe(false);
    sock.send({ type: 'status', status: 'idle' }); // must not throw

    sock.setDesired(true);
    const inst = FakeSocket.instances[0];
    inst.emit('open');
    expect(sock.isConnected()).toBe(true);
    sock.send({ type: 'status', status: 'idle' });
    expect(inst.sent).toEqual([JSON.stringify({ type: 'status', status: 'idle' })]);
    sock.destroy();
  });
});

// Roadmap (other-features, 2026-08-11): a friend read "Last seen 7/26/2026"
// while using the app; presence never came back short of a relaunch. The
// suspend latch had exactly one clearing edge (powerMonitor 'resume'), and the
// 'wait' no-token policy could wedge the engine with no retry scheduled.
// Spec: docs/active/specs/2026-08-11-presence-self-healing-design.md.
describe('presence self-healing', () => {
  beforeEach(() => { FakeSocket.instances = []; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  describe('wakeEvidence', () => {
    const t0 = 1_000_000_000;
    it('THE WEDGE: suspend, no resume ever, then a click in a YouCoded window → the latch clears', () => {
      expect(wakeEvidence({ now: t0 + 120_000, suspendedAt: t0, lastAppInputAt: t0 + 110_000 })).toBe('app-input');
    });
    // Review F1: macOS / Windows Modern Standby may pause or RESET the system
    // idle clock across sleep. A lid-shut maintenance wake then reports
    // idleSeconds 0 and a huge wall-clock gap — neither may release the latch.
    it('an idle clock that reset across sleep, plus a clock gap, does NOT clear it', () => {
      expect(wakeEvidence({
        now: t0 + 3_600_000, suspendedAt: t0, lastAppInputAt: null, idleSeconds: 0, sinceLastTickMs: 3_600_000,
      })).toBeNull();
      // App input from before the lid closed does not count either.
      expect(wakeEvidence({
        now: t0 + 3_600_000, suspendedAt: t0, lastAppInputAt: t0 - 5_000, idleSeconds: 0, sinceLastTickMs: 3_600_000,
      })).toBeNull();
    });
    it('input inside the grace window after suspend does not count (queued from before it)', () => {
      expect(wakeEvidence({ now: t0 + 120_000, suspendedAt: t0, lastAppInputAt: t0 + 10_000 })).toBeNull();
      expect(wakeEvidence({ now: t0 + 120_000, suspendedAt: t0, lastAppInputAt: t0 + SUSPEND_GRACE_MS })).toBe('app-input');
    });
    it('only deliberate input types count — a resting cursor re-entering the window does not', () => {
      expect(HUMAN_INPUT_TYPES.has('mouseDown')).toBe(true);
      expect(HUMAN_INPUT_TYPES.has('keyDown')).toBe(true);
      for (const t of ['mouseMove', 'mouseEnter', 'mouseLeave', 'pointerMove', 'pointerRawUpdate']) {
        expect(HUMAN_INPUT_TYPES.has(t)).toBe(false);
      }
    });
  });

  it('clearing suspended while still idle does not connect (a dark wake cannot flash Online)', () => {
    const { sock } = makeSocket(() => 'tok');
    sock.setDesired(true);
    FakeSocket.instances[0].emit('open');
    sock.setSuspended(true);
    sock.setIdle(true);
    sock.setSuspended(false); // e.g. an unlock while the idle gate still holds
    expect(FakeSocket.instances).toHaveLength(1);
    sock.setIdle(false);      // real input
    expect(FakeSocket.instances).toHaveLength(2);
    sock.destroy();
  });

  describe('repairIfStalled', () => {
    it('re-drives a wedged socket: wanted, no token at connect, token arrives later', () => {
      let token: string | null = null;
      const { sock } = makeSocket(() => token);
      sock.setDesired(true);              // 'wait' policy: no socket, no retry
      expect(FakeSocket.instances).toHaveLength(0);
      expect(sock.repairIfStalled()).toBe(false); // still no token → nothing sent
      token = 'tok';
      expect(sock.repairIfStalled()).toBe(true);
      expect(FakeSocket.instances).toHaveLength(1);
      sock.destroy();
    });
    it('never touches a healthy socket (no replay spam)', () => {
      const { sock, events } = makeSocket(() => 'tok');
      sock.setDesired(true);
      FakeSocket.instances[0].emit('open');
      const before = events.length;
      expect(sock.repairIfStalled()).toBe(false);
      expect(events.length).toBe(before);
      expect(FakeSocket.instances).toHaveLength(1);
      sock.destroy();
    });
    it('never cuts a backoff short', () => {
      const { sock } = makeSocket(() => 'tok');
      sock.setDesired(true);
      const first = FakeSocket.instances[0];
      first.emit('open');
      first.emit('close', 1006, 'drop');   // retry scheduled at 1 s
      expect(sock.repairIfStalled()).toBe(false);
      expect(FakeSocket.instances).toHaveLength(1);
      vi.advanceTimersByTime(1_000);
      expect(FakeSocket.instances).toHaveLength(2);
      sock.destroy();
    });
    it('does nothing when presence is intentionally off, asleep or idle', () => {
      const { sock } = makeSocket(() => 'tok');
      expect(sock.repairIfStalled()).toBe(false);
      sock.setDesired(true);
      sock.setSuspended(true);
      expect(sock.repairIfStalled()).toBe(false);
      sock.setSuspended(false);
      sock.setIdle(true);
      expect(sock.repairIfStalled()).toBe(false);
      sock.destroy();
    });
    it('a fired retry that found no token leaves the engine stalled (and repairable), not "retry pending"', () => {
      let token: string | null = 'tok';
      const { sock } = makeSocket(() => token);
      sock.setDesired(true);
      FakeSocket.instances[0].emit('open');
      token = null;
      FakeSocket.instances[0].emit('close', 1006, 'drop'); // retry at 1 s
      vi.advanceTimersByTime(1_000);                         // fires: no token → 'wait'
      expect(FakeSocket.instances).toHaveLength(1);
      token = 'tok2';
      expect(sock.repairIfStalled()).toBe(true);
      expect(FakeSocket.instances).toHaveLength(2);
      sock.destroy();
    });
  });
});
