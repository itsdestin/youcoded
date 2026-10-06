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

// HIDDEN MODE (incognito, per device — games-social round 5; Destin: "they shouldn't be able to see
// me in incognito, but i feel like i should still be able to see who else is online"). The server
// (wecoded-marketplace PresenceRoom) keeps a `?hidden=1` socket out of every friend's view while it
// still RECEIVES their presence. Privacy rests on two client-side guards, because an OLDER server
// ignores the flag and would announce the user online:
//  1. Before connecting hidden, social-handlers asks CAPABILITIES_URL; no `hidden: true`, no connect.
//  2. On the socket, the very first frame must be {type:'hello', hidden:true}; anything else means
//     the server did not honour it — disconnect at once and report 'hidden-unsupported'.
// And while hidden this side never sends a status change or a challenge (the server refuses them
// too). Desktop and Android (PresenceClient.kt) implement the same rules.
export const PRESENCE_CAPABILITIES_URL = 'https://api.youcoded.ai/social/presence/capabilities';
const HIDDEN_BLOCKED = new Set(['status', 'challenge', 'challenge-response']);

/** Does the presence server support hidden mode? Never throws; anything but an explicit
 *  `{hidden: true}` (an older server's 404, no network, a timeout) is a no. */
export async function probeHiddenPresence(fetchImpl: typeof fetch = fetch, timeoutMs = 5000): Promise<boolean> {
  try {
    const res = await fetchImpl(PRESENCE_CAPABILITIES_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = (await res.json()) as { hidden?: unknown };
    return body?.hidden === true;
  } catch {
    return false;
  }
}

// Structural socket surface + injectable constructor. Kept as named exports so
// the state-machine test (tests/presence-socket.test.ts) can substitute a fake
// socket. Both alias the shared engine's types (identical shape).
export type PresenceWebSocketLike = ReconnectingWebSocketLike;
export type WebSocketCtor = ReconnectingWebSocketCtor;

export interface PresenceSocket {
  setDesired(want: boolean): void;
  /** Hidden (incognito) mode for the NEXT connection; switching modes while connected reconnects. */
  setHidden(hidden: boolean): void;
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

/** Evidence that a machine marked asleep is in fact awake AND a human is at
 *  it (presence self-healing spec, Part 1, as tightened by review F1).
 *
 *  WHY (2026-09-23, roadmap other-features: "Last seen 7/26/2026" while the
 *  friend was using the app): `suspended` was cleared ONLY by powerMonitor
 *  'resume'. Miss that one OS event and presence stayed off until a relaunch.
 *
 *  WHY ONLY input to our OWN windows counts (review F1): the first version also
 *  trusted the system idle clock and a wall-clock gap. Neither is proven on
 *  every OS — macOS and Windows Modern Standby may pause or reset the idle
 *  clock across sleep, so a lid-shut maintenance wake would read as fresh
 *  input and show a closed laptop Online (the 2026-07-22 bug this latch
 *  exists to prevent). A key press, click, tap or scroll delivered to a
 *  YouCoded window (Electron's webContents 'input-event') needs an open,
 *  awake machine and a person, on every OS. Pointer moves/enter/leave are NOT
 *  counted: a window reappearing under a resting cursor can produce them.
 *  Keeping a stuck "Last seen" is the lesser failure, so every other signal is
 *  deliberately ignored here — `idleSeconds` and `sinceLastTickMs` are taken
 *  only so the test can prove they cannot release the latch.
 *  Input within the grace period after the suspend may be queued from before
 *  it and is not counted. */
export function wakeEvidence(input: {
  now: number;
  suspendedAt: number;
  /** When a deliberate input last reached one of our windows, or null. */
  lastAppInputAt: number | null;
  idleSeconds?: number;
  sinceLastTickMs?: number | null;
  graceMs?: number;
}): 'app-input' | null {
  const grace = input.graceMs ?? SUSPEND_GRACE_MS;
  if (input.lastAppInputAt === null) return null;
  return input.lastAppInputAt - input.suspendedAt >= grace ? 'app-input' : null;
}

/** Input types that need a person: presses, clicks, taps, wheels. */
export const HUMAN_INPUT_TYPES: ReadonlySet<string> = new Set([
  'mouseDown', 'mouseUp', 'mouseWheel', 'contextMenu', 'rawKeyDown', 'keyDown', 'keyUp', 'char',
  'touchStart', 'touchEnd', 'pointerDown', 'pointerUp', 'gestureTap', 'gestureTapDown', 'gestureScrollBegin',
]);

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
  // Hidden mode, and whether THIS connection's server has confirmed it (see HIDDEN MODE above).
  let hidden = false;
  let helloSeen = false;

  const engine = createReconnectingWs({
    Ctor: opts.WebSocketCtor,
    getUrl: () => (hidden ? `${PRESENCE_URL}?hidden=1` : PRESENCE_URL),
    getToken: opts.getToken,
    noToken: 'wait',
    closeReason: 'incognito or sign-out',
    onMessage: (data) => {
      try {
        const ev = JSON.parse(String(data));
        if (hidden && !helloSeen) {
          // Guard 2: the first frame decides. Confirmed → only now tell the renderer it is
          // connected. Anything else → this server counted us VISIBLE: leave at once, relay
          // nothing from it, and say why.
          if (ev && ev.type === 'hello' && ev.hidden === true) {
            helloSeen = true;
            opts.onEvent({ type: 'connected' });
          } else {
            rendererDesired = false;
            applyDesire();
            opts.onEvent({ type: 'hidden-unsupported' });
          }
          return;
        }
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
    // A hidden socket is not "connected" until the server confirms it (onMessage above).
    onConnected: () => { helloSeen = false; if (!hidden) opts.onEvent({ type: 'connected' }); },
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
      if (hidden && !helloSeen) return; // not confirmed yet — the hello will announce it
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
    setHidden(next) {
      if (hidden === next) return;
      // Switching modes needs a NEW connection (the mode is part of the URL): drop the current one
      // first, so a visible socket is closed — and announced as left — before a hidden one opens.
      engine.setDesired(false);
      hidden = next;
      helloSeen = false;
      applyDesire();
    },
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
    send(message) {
      // While hidden, nothing a friend could notice leaves this computer (the server refuses these
      // too — this is the second lock on the same door).
      if (hidden && HIDDEN_BLOCKED.has(String(message.type))) return;
      engine.send(JSON.stringify(message));
    },
    // True only when a socket exists AND finished its handshake — lets the
    // presence-send handler return an honest failure instead of silently
    // dropping a frame with a success receipt.
    isConnected() { return engine.isOpen() && (!hidden || helloSeen); },
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
