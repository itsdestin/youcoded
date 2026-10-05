// social-handlers.ts
// IPC handler registration for the accounts Phase 2 social graph (friends,
// requests, blocks). Structurally a sibling of marketplace-api-handlers.ts:
// every call needs the bearer token, so all logic lives in the main process —
// the token never crosses the contextBridge into the renderer bundle.

import { app, webContents, powerMonitor, type WebContents } from "electron";
import type { MarketplaceAuthStore } from "./marketplace-auth-store";
import { createMarketplaceApiClient, MARKETPLACE_API_HOST } from "../renderer/state/marketplace-api-client";
import type {
  ApiResult,
} from "./marketplace-api-handlers";
import type {
  SocialUserCard, FriendRow, RequestsPayload, BlockRow,
} from "../renderer/state/marketplace-api-client";
// wrap + the 401-clear closure are shared with marketplace-api-handlers.ts via
// handler-utils.ts so the renderer sees ONE consistent ApiResult error contract
// across account:* and social:* — .status must survive the contextBridge.
import { wrap, makeClearSessionOn401 } from "./handler-utils";
// Platform-owned presence socket (Task 6). The account session token and the
// WebSocket live in the main process; the renderer only ever sees relayed
// social:presence-event pushes and expresses desired connection state.
import { createPresenceSocket, wakeEvidence, HUMAN_INPUT_TYPES, type PresenceSocket } from "./presence-socket";
import { log } from "./logger";
import type { WindowRegistry } from "./window-registry";
import type { RemoteServer } from "./remote-server";

// Module-scope handle so the account sign-out / delete handlers (in
// marketplace-api-handlers.ts) can drop the socket via notifySignedOut(), and
// app-quit teardown can destroy it — without threading the instance through the
// account module. Only the most recent registration's socket is retained.
let presenceSocket: PresenceSocket | null = null;

// Named refs so hot-reload re-registration swaps the powerMonitor listeners
// instead of stacking a new pair per reload (a stale pair would setSuspended
// on a destroyed socket and could resurrect it via the engine).
let onSuspend: (() => void) | null = null;
let onResume: (() => void) | null = null;
// When the OS last reported suspend, cleared on any wake signal. Module scope
// so a hot-reload re-registration can't strand a stale value in a closure.
let suspendedAt: number | null = null;
// OS "a person is back" signals that also clear the suspend latch. Both need a
// human by definition: unlock-screen (darwin, win32 — an unlock) and
// user-did-become-active (darwin — a login session switched to).
const WAKE_EVENTS = ["unlock-screen", "user-did-become-active"] as const;
// Last deliberate input to any YouCoded window — see wakeEvidence(). Module
// scope + a WeakSet so hot-reload re-registration never stacks listeners.
let lastAppInputAt: number | null = null;
const inputWatched = new WeakSet<WebContents>();
let watchingNewWebContents = false;
function watchAppInput(wc: WebContents): void {
  if (inputWatched.has(wc)) return;
  inputWatched.add(wc);
  wc.on("input-event", (_e, input) => {
    if (HUMAN_INPUT_TYPES.has(input.type)) lastAppInputAt = Date.now();
  });
}
let idlePoller: NodeJS.Timeout | null = null;

// Presence idle threshold: no system input AND no remote-client activity for
// this long → presence drops ("Last seen …"), because Online must mean a HUMAN
// is around, not that the process exists. Discovered via tjmorin's Mac
// (2026-07-23): the remote-access keep-awake powerSaveBlocker keeps machines
// permanently awake, so an idle app pings forever and reads Online for days.
// 10 min matches the server's staleness threshold by design.
const IDLE_DISCONNECT_MS = 10 * 60 * 1000;
// 15s poll: cheap native sync call; bounds the reconnect delay after the user
// returns (friends see them come back online within ~15s of first input).
const IDLE_POLL_MS = 15_000;

// WHY (2026-09-29 one-core R2): every request from a window is now ONE object ({ sessionId, text }, not (sessionId, text)) — the same object the phone sends, so one handler can serve both doors and two same-typed arguments can no longer be swapped unnoticed. tests/wire-shape-parity.test.ts checks these keys against preload's.
export function startSocial(
  store: MarketplaceAuthStore,
  // Optional broadcast targets. windowRegistry mirrors ipc-handlers.ts's global
  // send() (every renderer window); remoteServer forwards the push to connected
  // remote browsers (main-originated pushes do NOT ride to remotes automatically
  // — each one calls remoteServer.broadcast explicitly). Both are optional so
  // tests / minimal boots can register handlers without a full app graph.
  windowRegistry?: WindowRegistry,
  remoteServer?: RemoteServer,
): void {
  // Relay one presence event to every renderer window AND every remote browser.
  // The event objects are opaque here (server protocol frames + synthetic
  // connection-state events) — the renderer (Task 7) interprets them.
  const broadcastPresenceEvent = (ev: Record<string, unknown>) => {
    // Replicated from ipc-handlers.ts's local send() closure (not exported).
    if (windowRegistry) {
      for (const wid of windowRegistry.getWindowIds()) {
        const wc = webContents.fromId(wid);
        if (wc && !wc.isDestroyed()) wc.send("social:presence-event", ev);
      }
    } else {
      // No registry (minimal boot): fall back to every live webContents.
      for (const wc of webContents.getAllWebContents()) {
        if (!wc.isDestroyed()) wc.send("social:presence-event", ev);
      }
    }
    // Remote browsers share the desktop's single account/presence connection.
    remoteServer?.broadcast({ type: "social:presence-event", payload: ev });
  };

  // One desired-state connection manager. getToken() is read lazily at connect
  // time so a token that appears after sign-in is picked up on the next attempt.
  presenceSocket?.destroy(); // hot-reload: tear down the prior socket first
  const presence = createPresenceSocket({
    getToken: () => store.getToken(),
    onEvent: broadcastPresenceEvent,
  });
  presenceSocket = presence;

  // Sleep gate (see presence-socket.ts): close the presence socket the moment
  // the OS suspends — the close frame gets out while the network is still up,
  // so friends see "Last seen just now" instead of a ghost riding the server's
  // staleness timeout — and reconnect on real wake. macOS dark wakes don't fire
  // 'resume', so a lid-closed MacBook can't blip back online from maintenance
  // wakes. Renderer intent (sign-in/incognito/leader) is preserved across the
  // sleep cycle by the setDesired/setSuspended split.
  if (onSuspend) powerMonitor.removeListener("suspend", onSuspend);
  if (onResume) {
    powerMonitor.removeListener("resume", onResume);
    for (const ev of WAKE_EVENTS) powerMonitor.removeListener(ev as any, onResume);
  }
  suspendedAt = null;
  onSuspend = () => {
    suspendedAt = Date.now();
    log("INFO", "Presence", "gate: suspend");
    presence.setSuspended(true);
  };
  // WHY the extra wake events (2026-09-23, presence self-healing spec Part 1):
  // 'resume' used to be the ONLY thing that could clear the suspend latch, and
  // one missed delivery kept presence off until a relaunch. unlock-screen and
  // user-did-become-active are the OS's own "the user is back" notices; the
  // idle poller below adds evidence-based clearing that needs no OS event.
  onResume = () => {
    if (suspendedAt !== null) log("INFO", "Presence", "gate: resume");
    suspendedAt = null;
    presence.setSuspended(false);
  };
  powerMonitor.on("suspend", onSuspend);
  powerMonitor.on("resume", onResume);
  for (const ev of WAKE_EVENTS) powerMonitor.on(ev as any, onResume);

  // Idle gate poller (see IDLE_DISCONNECT_MS). Two activity sources, either
  // keeps presence alive: local keyboard/mouse (getSystemIdleTime — returns
  // seconds; on platforms where the desktop offers no idle API it reports 0,
  // which fails SAFE to "active", i.e. current behavior), and remote-access
  // clients (their input never touches local idle time — without this, a user
  // driving the app from their phone would wrongly read as away).
  //
  // WHY it runs only while the renderer WANTS presence (simplification audit
  // W13): it used to tick every 15 s from boot, signed in or not, and signed
  // out setIdle is a no-op. It is keyed to the renderer's presence-connect /
  // presence-disconnect intent (plus sign-out and teardown) — the same
  // desired-state axis the suspend/resume listeners feed — and deliberately
  // NOT to the socket's own connected/disconnected events: the poller is what
  // takes the socket DOWN when the user goes idle, so "stop on disconnect"
  // would have stopped the only thing able to notice them coming back.
  stopIdlePoller(); // hot-reload: never stack a second poller
  for (const wc of webContents.getAllWebContents()) watchAppInput(wc);
  if (!watchingNewWebContents) {
    watchingNewWebContents = true;
    app.on("web-contents-created", (_e, wc) => watchAppInput(wc));
  }
  const pollIdle = () => {
    const now = Date.now();
    const localIdleMs = powerMonitor.getSystemIdleTime() * 1000;
    // Evidence-based escape from the suspend latch — ONLY deliberate input to
    // our own windows counts; see wakeEvidence() for why the idle clock and
    // wall-clock gaps are not trusted.
    if (suspendedAt !== null) {
      const why = wakeEvidence({ now, suspendedAt, lastAppInputAt });
      if (why) {
        log("INFO", "Presence", "gate: wake-evidence", { why });
        suspendedAt = null;
        presence.setSuspended(false);
      }
    }
    const lastRemote = remoteServer?.getLastClientActivityMs() ?? 0;
    const remoteIdleMs = lastRemote === 0 ? Number.POSITIVE_INFINITY : now - lastRemote;
    presence.setIdle(localIdleMs >= IDLE_DISCONNECT_MS && remoteIdleMs >= IDLE_DISCONNECT_MS);
    // Part 2: a socket that is wanted, gone, and has no retry scheduled is
    // wedged (e.g. the 'wait' no-token policy). Healthy or backing-off
    // sockets are never touched, so this cannot defeat backoff.
    if (presence.repairIfStalled()) log("INFO", "Presence", "gate: stall-repair");
  };
  const startIdlePoller = () => {
    stopIdlePoller();
    // WHY one synchronous poll first: the socket keeps `idle` as state that ONLY
    // this poller clears. After idle → intent off → intent on, setDesired(true)
    // would otherwise stay masked by `!idle` until the first 15 s tick, and the
    // user would sit on "Connecting…" for up to 15 s after asking for presence.
    pollIdle();
    idlePoller = setInterval(pollIdle, IDLE_POLL_MS);
  };

  // One client instance shared across all handlers. getToken() is read lazily
  // per-request so sign-out takes effect immediately.
  const client = createMarketplaceApiClient({
    host: MARKETPLACE_API_HOST,
    getToken: () => store.getToken(),
  });

  // Shared 401-reaction (see handler-utils.ts for the full WHY): a dead session
  // server-side clears the local token so the UI flips to signed-out.
  const clearSessionOn401 = makeClearSessionOn401(store, "social");

  // All handlers return ApiResult<T> so the renderer preserves HTTP status across
  // the contextBridge (structuredClone drops MarketplaceApiError.status). The
  // friends UI needs .status to distinguish 404 (unknown/blocked handle),
  // 429 (caps), and 400 (self-request). Args are POSITIONAL here to match
  // preload.ts (which passes them positionally); remote-shim.ts object-wraps them
  // for the Android SessionService, which reads them via optString.

  // WHY (2026-10-01 one-core R3-8): the fourteen social:* channels are table entries (main/ipc/social.ts); they reach these
  // operations through getSocialOps(). Nothing is registered with Electron here any more, so a dev hot reload simply
  // replaces the operations (no removeHandler dance). All return ApiResult<T> so the renderer preserves HTTP status across the
  // contextBridge (structuredClone drops MarketplaceApiError.status): the friends UI needs .status to tell 404 (unknown or
  // blocked handle), 429 (caps) and 400 (self-request) apart.
  socialOps = {
    lookupHandle: (handle) => wrap(() => client.lookupHandle(handle)).then(clearSessionOn401),
    sendRequest: (handle) => wrap(() => client.sendRequest(handle)).then(clearSessionOn401),
    listRequests: () => wrap(() => client.listRequests()).then(clearSessionOn401),
    acceptRequest: (id) => wrap(() => client.acceptRequest(id)).then(clearSessionOn401),
    declineRequest: (id) => wrap(() => client.declineRequest(id)).then(clearSessionOn401),
    cancelRequest: (id) => wrap(() => client.cancelRequest(id)).then(clearSessionOn401),
    listFriends: () => wrap(() => client.listFriends()).then(clearSessionOn401),
    unfriend: (userId) => wrap(() => client.unfriend(userId)).then(clearSessionOn401),
    block: (userId) => wrap(() => client.block(userId)).then(clearSessionOn401),
    unblock: (userId) => wrap(() => client.unblock(userId)).then(clearSessionOn401),
    listBlocks: () => wrap(() => client.listBlocks()).then(clearSessionOn401),

    // ── Presence socket (Task 6) ──
    // These express desired state / send one message; they never return data — the socket relays everything back
    // asynchronously via social:presence-event.
    presenceConnect: () => {
      presence.setDesired(true);
      startIdlePoller(); // see the poller's WHY: it lives with the renderer's intent
      return { ok: true };
    },
    presenceDisconnect: () => {
      presence.setDesired(false);
      stopIdlePoller();
      return { ok: true };
    },
    // Honest receipt: sending with no OPEN socket would silently drop the frame, so report a failure (ApiResult-style error
    // shape, status:0 = local/non-API) instead of returning a success the renderer would trust.
    presenceSend: (message) => {
      if (!presence.isConnected()) return { ok: false, status: 0, message: "not connected" };
      presence.send(message);
      return { ok: true };
    },
  };
}

/** The social operations, for the social:* table entries (main/ipc/social.ts); null before main registers them (a minimal boot). */
export interface SocialOps {
  lookupHandle(handle: string): Promise<ApiResult<SocialUserCard>>;
  sendRequest(handle: string): Promise<ApiResult<{ status: "pending" | "friends" }>>;
  listRequests(): Promise<ApiResult<RequestsPayload>>;
  acceptRequest(id: string): Promise<ApiResult<void>>;
  declineRequest(id: string): Promise<ApiResult<void>>;
  cancelRequest(id: string): Promise<ApiResult<void>>;
  listFriends(): Promise<ApiResult<FriendRow[]>>;
  unfriend(userId: string): Promise<ApiResult<void>>;
  block(userId: string): Promise<ApiResult<void>>;
  unblock(userId: string): Promise<ApiResult<void>>;
  listBlocks(): Promise<ApiResult<BlockRow[]>>;
  presenceConnect(): { ok: true };
  presenceDisconnect(): { ok: true };
  presenceSend(message: Record<string, unknown>): { ok: true } | { ok: false; status: number; message: string };
}
let socialOps: SocialOps | null = null;
export function getSocialOps(): SocialOps | null { return socialOps; }

// Called by the account sign-out + delete handlers (marketplace-api-handlers.ts)
// so signing out drops presence immediately. Without this the socket would
// linger connected after the local token is cleared until its next server
// interaction. No-op when presence was never registered.
export function notifySignedOut(): void {
  presenceSocket?.setDesired(false);
  stopIdlePoller();
}

// App-quit teardown hook. Electron process death kills the socket anyway, but
// this makes the intent explicit and cleans timers if called during teardown.
export function destroySocialHandlers(): void {
  presenceSocket?.destroy();
  presenceSocket = null;
  stopIdlePoller();
}

// Module-level so sign-out and teardown (above) can stop it without a handle
// to the registration closure that started it.
function stopIdlePoller(): void {
  if (idlePoller) clearInterval(idlePoller);
  idlePoller = null;
}
