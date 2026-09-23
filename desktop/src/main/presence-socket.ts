// Platform-owned presence socket (spec §6): Electron main holds the account
// session token and the WebSocket; the renderer only ever sees relayed events.
// The reconnect/backoff/ping/supersede-guard mechanics live in the shared
// reconnecting-ws engine (mirrored with sync-hub-socket.ts); this module only
// supplies the presence-specific URL, message caching, and the renderer-reload
// re-hydration hook. No-token policy is 'wait' — the renderer (usePresence,
// Task 7) re-invokes presence-connect when sign-in completes.
import {
  createReconnectingWs,
  type ReconnectingWebSocketLike,
  type ReconnectingWebSocketCtor,
} from './reconnecting-ws';

// WHY: Moved to its own domain so Cloudflare's cache and rate limiter apply; the old workers.dev address still answers for older app versions.
const PRESENCE_URL = 'wss://api.youcoded.ai/social/presence';

// Structural socket surface + injectable constructor. Kept as named exports so
// the state-machine test (tests/presence-socket.test.ts) can substitute a fake
// socket. Both alias the shared engine's types (identical shape).
export type PresenceWebSocketLike = ReconnectingWebSocketLike;
export type WebSocketCtor = ReconnectingWebSocketCtor;

export interface PresenceSocket {
  setDesired(want: boolean): void;
  // System sleep gate (powerMonitor suspend/resume). Kept SEPARATE from
  // setDesired: desired is the RENDERER's intent (sign-in/incognito/leader)
  // and must survive a sleep/wake cycle unchanged.
  setSuspended(asleep: boolean): void;
  // User-idle gate (no system OR remote input for the idle threshold — see the
  // poller in social-handlers.ts). Same composition rule as setSuspended:
  // presence means a HUMAN is around, so an app left running 24/7 on an awake
  // machine (remote-access keep-awake) must not read "Online" forever.
  setIdle(idle: boolean): void;
  send(message: Record<string, unknown>): void;
  isConnected(): boolean;
  /** Re-drive the connection ONLY if the engine is wedged (wanted on, no
   *  socket, no retry scheduled) — e.g. the 'wait' no-token policy after the
   *  token appeared with nothing to re-invoke. Never touches a healthy or
   *  backing-off socket, so it cannot defeat backoff or spam replays. Returns
   *  true when it started a connection. (Presence self-healing spec, Part 2.) */
  repairIfStalled(): boolean;
  destroy(): void;
}

/** Evidence that a machine marked asleep is in fact awake (presence
 *  self-healing spec, Part 1).
 *
 *  WHY (2026-09-23, roadmap other-features: "Last seen 7/26/2026" while the
 *  friend was using the app): `suspended` was cleared ONLY by powerMonitor
 *  'resume'. Miss that one OS event — a MacBook runs weeks of lid-close cycles
 *  without a quit — and presence stayed off until a full quit-and-relaunch.
 *  No gate may be clearable only by an OS event, so either of these clears it:
 *   - input newer than the suspend (the system idle clock restarted after it);
 *   - a wall-clock gap far longer than the poll interval (the process was
 *     frozen, i.e. the machine slept and has woken).
 *  Both wait out a grace period after the suspend so a tick racing the OS
 *  freeze cannot reopen a socket that is about to go to sleep (a ghost).
 *  Over-clearing is safe: `idle` is the real "a human is here" gate and still
 *  has to pass before anything connects. */
export function wakeEvidence(input: {
  now: number;
  suspendedAt: number;
  idleSeconds: number;
  /** ms since the previous poll tick, or null on the first tick. */
  sinceLastTickMs: number | null;
  pollIntervalMs: number;
  graceMs?: number;
}): 'input' | 'clock-gap' | null {
  const grace = input.graceMs ?? SUSPEND_GRACE_MS;
  if (input.now - input.suspendedAt < grace) return null;
  const lastInputAt = input.now - input.idleSeconds * 1000;
  if (lastInputAt > input.suspendedAt) return 'input';
  if (input.sinceLastTickMs !== null && input.sinceLastTickMs > input.pollIntervalMs * 3) return 'clock-gap';
  return null;
}

/** Real machines freeze within a second or two of the suspend event; a minute
 *  is irrelevant on wake, where it has long expired. */
export const SUSPEND_GRACE_MS = 60_000;

export function createPresenceSocket(opts: {
  getToken: () => string | null;
  onEvent: (ev: Record<string, unknown>) => void; // relayed as social:presence-event
  WebSocketCtor?: WebSocketCtor;
}): PresenceSocket {
  // Last full presence snapshot seen on the live socket. Kept so a RELOADED
  // renderer (dev HMR / Ctrl+R resets the reducer while main keeps the socket)
  // can be re-hydrated: setDesired(true) on an already-open socket replays
  // {type:'connected'} + this frame instead of returning silently — without it
  // the fresh renderer never leaves "Connecting…".
  let lastPresence: Record<string, unknown> | null = null;

  const engine = createReconnectingWs({
    Ctor: opts.WebSocketCtor,
    getUrl: () => PRESENCE_URL,
    getToken: opts.getToken,
    noToken: 'wait',
    closeReason: 'incognito or sign-out',
    onMessage: (data) => {
      try {
        const ev = JSON.parse(String(data));
        // Cache the latest full presence snapshot for renderer-reload replay
        // (see lastPresence above).
        if (ev && ev.type === 'presence') {
          lastPresence = ev;
        } else if (lastPresence) {
          // Fold the roster deltas into the cached snapshot (same semantics as
          // the game-reducer's USER_JOINED/LEFT/STATUS). Without this, a
          // renderer reload replayed the CONNECT-TIME roster and resurrected
          // friends who had since left — the client-side twin of the server's
          // ghost-socket stuck-"Online" bug (2026-07-22 investigation).
          // A delta arriving before any snapshot is skipped: a roster can't be
          // synthesized from deltas, and the server always snapshots first.
          const users = Array.isArray(lastPresence.users) ? (lastPresence.users as Array<{ id: string }>) : [];
          if (ev?.type === 'user-joined' && ev.user) {
            lastPresence = { ...lastPresence, users: [...users.filter((u) => u.id !== ev.user.id), ev.user] };
          } else if (ev?.type === 'user-left') {
            lastPresence = { ...lastPresence, users: users.filter((u) => u.id !== ev.id) };
          } else if (ev?.type === 'user-status') {
            lastPresence = { ...lastPresence, users: users.map((u) => (u.id === ev.id ? { ...u, status: ev.status } : u)) };
          }
        }
        opts.onEvent(ev);
      } catch { /* non-JSON frame: ignore */ }
    },
    onConnected: () => opts.onEvent({ type: 'connected' }),
    onDisconnected: (info) => {
      // reason:'local' marks an INTENTIONAL disconnect — Task 7 uses it to
      // suppress "reconnecting" UI. A dropped/failed socket forwards the ws
      // close code/reason instead.
      if (info.intentional) opts.onEvent({ type: 'disconnected', code: 1000, reason: 'local' });
      else opts.onEvent({ type: 'disconnected', code: info.code, reason: info.reason });
    },
    // The 'error' handler surfaces an error event; the engine then closes the
    // socket so its 'close' schedules the retry.
    onError: (err) => opts.onEvent({ type: 'error', message: err.message }),
    onReplay: () => {
      opts.onEvent({ type: 'connected' });
      if (lastPresence) opts.onEvent(lastPresence);
    },
    // The cached snapshot belongs to the socket that just went down — never
    // replay it stale onto the next connection.
    onTeardown: () => { lastPresence = null; },
  });

  // Suspend gate (2026-07-22, "closed MacBook stays Online" follow-up to the
  // ghost-socket fix): the engine's effective desire is rendererDesired AND
  // awake. On OS suspend we close NOW, while the network is still up, so the
  // close frame reaches the server and friends see "Last seen just now"
  // immediately — instead of a silently-dead socket riding the server's
  // staleness timeout. macOS dark wakes never fire powerMonitor 'resume', so a
  // lid-closed laptop can't blip back online from a maintenance wake; a real
  // wake restores whatever the renderer wanted.
  let rendererDesired = false;
  let suspended = false;
  let idle = false;
  const applyDesire = () => engine.setDesired(rendererDesired && !suspended && !idle);

  return {
    setDesired(want) { rendererDesired = want; applyDesire(); },
    setSuspended(asleep) {
      if (suspended === asleep) return;
      suspended = asleep;
      applyDesire();
    },
    // Independent axis from suspend: a dark wake clears suspended but not
    // idle, so a lid bumped open cannot flash a false "Online" — only real
    // input (which clears idle via the poller) reconnects.
    setIdle(nowIdle) {
      if (idle === nowIdle) return;
      idle = nowIdle;
      applyDesire();
    },
    send(message) { engine.send(JSON.stringify(message)); },
    // True only when a socket exists AND finished its handshake — lets the
    // presence-send handler return an honest failure instead of silently
    // dropping a frame with a success receipt.
    isConnected() { return engine.isOpen(); },
    repairIfStalled() {
      if (!engine.isStalled()) return false;
      // desired is already true inside the engine; setDesired(true) on a
      // desired-but-socketless engine is exactly its connect path.
      engine.setDesired(true);
      // Still stalled means there is still no token — nothing was sent, so
      // report no action (keeps the caller's log to real reconnects).
      return !engine.isStalled();
    },
    destroy() { engine.destroy(); },
  };
}
