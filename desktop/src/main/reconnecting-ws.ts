// Shared reconnecting-WebSocket engine for the two Electron-MAIN-held sockets:
// presence-socket.ts and sync-hub-socket.ts. Both need the identical mechanics —
// a node `ws` client with capped-backoff reconnect (a Worker deploy or network
// blip must never silently end the connection for the rest of the app session),
// a 30s liveness ping, and a "supersede guard" so a socket replaced mid-handshake
// never drives state. Before this module those mechanics were copy-pasted; a bug
// fixed in one had to be mirrored by hand into the other.
//
// The two callers DIVERGE only in the bits injected as hooks below: the URL, the
// per-frame message parsing, the no-token policy, whether errors surface as
// events, and the teardown extras (sync fails its in-flight lease requests;
// presence drops its cached snapshot). Everything else lives here, once.
import WebSocket from 'ws';

// Structural surface both call sites consume (on/send/close/readyState) — lets
// the state-machine tests inject a fake socket without touching the network.
export interface ReconnectingWebSocketLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
}
export type ReconnectingWebSocketCtor = new (
  url: string,
  opts: { headers: Record<string, string> },
) => ReconnectingWebSocketLike;

const PING_INTERVAL_MS = 30_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000]; // capped exponential

export interface ReconnectingWsHooks {
  Ctor?: ReconnectingWebSocketCtor; // defaults to the real node `ws`; tests inject a fake
  getUrl: () => string;
  getToken: () => string | null;
  // No-token policy. 'wait': stay quiet — a renderer re-invokes on sign-in
  // (presence). 'poll': there is no renderer to wait for, so re-check at the max
  // backoff so a mid-session sign-in connects on the next tick (sync).
  noToken: 'wait' | 'poll';
  // ws close-frame reason sent on an INTENTIONAL teardown (setDesired(false)).
  closeReason: string;
  onMessage: (data: unknown) => void;             // per-socket frame parsing
  onConnected: () => void;                         // handshake completed
  // A disconnect surfaced to the consumer. `intentional` marks a caller-driven
  // teardown (vs a dropped/failed socket); code/reason ride from the ws close.
  onDisconnected: (info: { code?: number; reason?: string; intentional?: boolean }) => void;
  onError?: (err: Error) => void;                  // presence surfaces; sync omits (engine still closes → retry)
  onReplay?: () => void;                           // setDesired(true) on an already-open socket (presence re-hydration)
  onTeardown?: () => void;                         // runs on every down/teardown/destroy (failAllPending / drop snapshot)
}

export interface ReconnectingWs {
  setDesired(want: boolean): void;
  send(data: string): boolean;   // true only when written on an OPEN socket
  isOpen(): boolean;             // socket exists AND finished its handshake
  /** Wanted on, no socket, and NO retry scheduled — a wedge, not a backoff.
   *  False while healthy, while backing off, and while intentionally off, so
   *  it is safe to poll (presence self-healing spec, Part 2). */
  isStalled(): boolean;
  destroy(): void;
}

export function createReconnectingWs(hooks: ReconnectingWsHooks): ReconnectingWs {
  const Ctor: ReconnectingWebSocketCtor = hooks.Ctor ?? (WebSocket as unknown as ReconnectingWebSocketCtor);
  let desired = false;
  let ws: ReconnectingWebSocketLike | null = null;
  let attempts = 0;
  let pingTimer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;

  function clearTimers() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  }

  // WHY a wrapper (2026-09-23): a fired timer's id used to stay in `retryTimer`,
  // so "is a retry scheduled?" could not be answered — and isStalled() needs
  // exactly that. Clearing it as the retry fires makes the variable honest.
  function fireRetry() {
    retryTimer = null;
    connect();
  }

  function connect() {
    if (!desired || ws) return;
    const token = hooks.getToken();
    if (!token) {
      // No token yet. 'wait' stays quiet (the renderer re-invokes on sign-in);
      // 'poll' re-checks at the max backoff so a mid-session sign-in connects on
      // the next tick without an app restart. Clear-then-reschedule (not a
      // `!retryTimer` guard): when THIS callback is itself the fired retry, the
      // timer variable still holds the elapsed id, so a guard would stop the poll
      // dead after one attempt. clearTimeout on an already-fired timer is a no-op.
      if (hooks.noToken === 'poll') {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(fireRetry, BACKOFF_MS[BACKOFF_MS.length - 1]);
      }
      return;
    }
    const sock = new Ctor(hooks.getUrl(), { headers: { Authorization: `Bearer ${token}` } });
    ws = sock;
    sock.on('open', () => {
      if (ws !== sock) return; // superseded before handshake completed — don't start a ping timer on a dead socket
      attempts = 0;
      hooks.onConnected();
      // Liveness ping — the DO answers pong; also keeps intermediaries from idling us out.
      pingTimer = setInterval(() => { try { sock.send(JSON.stringify({ type: 'ping' })); } catch { /* mid-close */ } }, PING_INTERVAL_MS);
    });
    sock.on('message', (data) => { hooks.onMessage(data); });
    sock.on('close', (code, reason) => {
      if (ws !== sock) return; // superseded socket — its lifecycle no longer drives state
      handleDown({ code, reason: reason === undefined ? undefined : String(reason) });
    });
    sock.on('error', (err: Error) => {
      hooks.onError?.(err);
      try { sock.close(); } catch { /* already closing */ } // 'close' fires next and schedules the retry
    });
  }

  function handleDown(info: { code?: number; reason?: string }) {
    clearTimers();
    hooks.onTeardown?.(); // socket died — resolve any in-flight work before the reconnect (sync); drop stale snapshot (presence)
    ws = null;
    hooks.onDisconnected(info);
    if (desired) {
      // Reconnect with capped backoff. A dead-token loop (persistent handshake
      // reject) is bounded upstream by the consumer dropping `desired` on
      // sign-out; revisit a close-code-based stop once the worker's close-code
      // contract is pinned.
      const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
      attempts += 1;
      retryTimer = setTimeout(fireRetry, delay);
    }
  }

  return {
    setDesired(want) {
      // Idempotent by intent. Short-circuit only when the request matches the
      // current state AND there's nothing to do: either we already want-off, or
      // we want-on WITH a live socket. The one case we must NOT short-circuit is
      // want===true while desired-but-disconnected (the token finally appeared
      // after sign-in, or a retry is pending) — that has to fall through to connect().
      if (want === desired && (!want || ws !== null)) {
        // Already want-on with a socket: give the consumer a chance to re-hydrate
        // a reloaded renderer (presence) — but only once the handshake is done;
        // while CONNECTING the real open event will fire onConnected anyway.
        if (want && ws !== null && ws.readyState === WebSocket.OPEN) hooks.onReplay?.();
        return;
      }
      desired = want;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (want) { connect(); return; }
      hooks.onTeardown?.(); // intentional teardown — clear in-flight work before closing
      const s = ws;
      ws = null;
      clearTimers();
      if (s) {
        try { s.close(1000, hooks.closeReason); } catch { /* already closed */ }
        // Emit synchronously; the socket's own async close event is ignored via
        // the supersede guard (ws was nulled above → `ws !== sock` in the close
        // handler) — that's what prevents a reconnect after an INTENTIONAL teardown.
        hooks.onDisconnected({ code: 1000, intentional: true });
      }
    },
    send(data) {
      if (ws === null || ws.readyState !== WebSocket.OPEN) return false;
      try { ws.send(data); return true; } catch { return false; }
    },
    isOpen() { return ws !== null && ws.readyState === WebSocket.OPEN; },
    isStalled() { return desired && ws === null && retryTimer === null; },
    destroy() {
      desired = false;
      clearTimers();
      hooks.onTeardown?.();
      try { ws?.close(); } catch { /* noop */ }
      ws = null;
    },
  };
}
