// SyncHub client (spec §6, Plan 1b). Shares the reconnect/backoff/ping/supersede
// engine with presence-socket.ts (see reconnecting-ws.ts) — a node `ws` client
// held by the Electron MAIN process, so a Worker deploy or network blip never
// silently ends cross-device signalling for the rest of the app session.
//
// Differences from presence-socket.ts (all deliberate, expressed as engine hooks):
//   (1) Owned by the sync-spaces SERVICE, not renderer-driven — sync must work
//       with zero windows open, so no-token policy is 'poll' (presence 'wait'):
//       we re-check at the max backoff and connect the moment a token appears.
//   (2) In-flight lease requests are failed (resolved null) on every teardown so
//       a request never hangs across a reconnect — the onTeardown hook.
//   (3) hello.replay entries are flattened into ordinary signal events — the
//       engine's single-flight syncSpace makes duplicate signals free, so the
//       consumer never has to distinguish replay from live.
import {
  createReconnectingWs,
  type ReconnectingWebSocketLike,
  type ReconnectingWebSocketCtor,
} from './reconnecting-ws';

// WHY: Moved to its own domain so Cloudflare's cache and rate limiter apply; the old workers.dev address still answers for older app versions.
const SYNC_HUB_URL = 'wss://api.youcoded.ai/sync/hub';

// Structural socket surface + injectable constructor. Named exports so the
// state-machine test (tests/sync-hub-socket.test.ts) can substitute a fake
// socket. Both alias the shared engine's types (identical shape).
export type SyncHubWebSocketLike = ReconnectingWebSocketLike;
export type WebSocketCtor = ReconnectingWebSocketCtor;

// Who currently holds a session lease (returned on lease-result, and carried in
// takeover-request events as `from`). expiresAt is an epoch-ms deadline.
export interface LeaseHolder { deviceId: string; device: string; expiresAt: number }

// The reply to a request() call — mapped from a server `lease-result` frame.
// `holder` is the current lease owner (or null when the op cleared/failed).
export interface LeaseResult { ok: boolean; op: string; sessionId: string; holder: LeaseHolder | null }

// The single event shape the consumer (Task 5 service wiring) sees. Replay and
// live signals collapse to the same 'signal' event. The engine only needs "some
// space changed, go sync it" (kind/spaceKey); the OPTIONAL `at` (server
// timestamp) + `deviceId` (durable machineId) ride along so the service can also
// build a per-device recency map — they're additive and never disturb the
// sync-trigger consumer. `sync-map` is the durable recency seed shipped in the
// hello frame (older workers omit it — then no sync-map is emitted). `lease-event`
// carries UNSOLICITED server pushes (another device released/took a lease, or is
// asking us to hand one over) — these are not tied to a request() reqId.
export type SyncHubEvent =
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'signal'; kind: string; spaceKey: string; at?: number; deviceId?: string }
  | { type: 'sync-map'; map: Record<string, number> }
  | { type: 'lease-event'; kind: 'released' | 'taken' | 'takeover-request'; sessionId: string; device?: string; from?: { deviceId: string; device: string }; transferNonce?: string; senderDeviceId?: string | null };

export interface SyncHubSocketOpts {
  getToken: () => string | null;
  deviceName: string;
  // Durable per-MACHINE id (the registry's `<id>.json` key). Threaded so a
  // relayed signal maps to a "Your devices" row reliably. Optional: a dev-only /
  // no-built-app machine has no durable id — we then connect WITHOUT deviceId and
  // simply contribute no recency entry (graceful, same as having no registry row).
  deviceId?: string;
  onEvent: (e: SyncHubEvent) => void;
  WebSocketCtor?: WebSocketCtor; // injectable for tests
}

export interface SyncHubSocket {
  setDesired(want: boolean): void;
  sendSignal(kind: string, spaceKey: string): boolean;
  // Request/response lease op (acquire/release/takeover). Resolves the matching
  // server `lease-result` by reqId; resolves null on timeout, when not connected,
  // or when the socket goes down mid-flight — NEVER blocks the caller.
  request(op: string, sessionId: string, deviceId: string, transferNonce?: string, expectedHolderId?: string): Promise<LeaseResult | null>;
  isConnected(): boolean;
  destroy(): void;
}

export function createSyncHubSocket(opts: SyncHubSocketOpts): SyncHubSocket {
  // device= identifies this client to the room so the server can fan a signal
  // out to the account's OTHER devices (never echo it back to the sender).
  // deviceId= (when present) is the durable machineId the DO records into its
  // lastSyncByDevice map — omitted for machines without a durable id so the
  // server (and an old worker) sees exactly the pre-recency wire shape.
  const url = `${SYNC_HUB_URL}?device=${encodeURIComponent(opts.deviceName)}`
    + (opts.deviceId ? `&deviceId=${encodeURIComponent(opts.deviceId)}` : '');

  // In-flight lease requests, keyed by the client-generated reqId. A matching
  // server `lease-result` (or the 5s timeout) removes the entry and resolves it.
  let reqCounter = 0;
  const pending = new Map<string, { resolve: (r: LeaseResult | null) => void; timer: NodeJS.Timeout }>();

  // Resolve EVERY in-flight request to null and clear the map. Called from all
  // teardown paths (engine handleDown / setDesired(false) / destroy, via the
  // onTeardown hook) so a request that was awaiting a reply when the socket died
  // never hangs forever across a reconnect — the never-block guarantee. The
  // caller sees null (treat as "no answer"), same as a timeout.
  function failAllPending() {
    for (const [, p] of pending) { clearTimeout(p.timer); p.resolve(null); }
    pending.clear();
  }

  const engine = createReconnectingWs({
    Ctor: opts.WebSocketCtor,
    getUrl: () => url,
    getToken: opts.getToken,
    noToken: 'poll',
    closeReason: 'sync disabled or sign-out',
    onConnected: () => opts.onEvent({ type: 'connected' }),
    onDisconnected: () => opts.onEvent({ type: 'disconnected' }),
    onTeardown: failAllPending,
    onMessage: (data) => {
      try {
        const msg = JSON.parse(String(data));
        if (msg && msg.type === 'hello') {
          // Seed the per-device recency map FIRST (Task 2): the DO ships the
          // durable lastSyncByDevice snapshot in hello so a reconnecting device
          // starts with every peer's last-sync, not just what arrives live after.
          // Old workers omit it — then no sync-map is emitted (backward compat).
          if (msg.lastSyncByDevice && typeof msg.lastSyncByDevice === 'object') {
            opts.onEvent({ type: 'sync-map', map: msg.lastSyncByDevice as Record<string, number> });
          }
          // Flatten the replay ring into ordinary signal events — the consumer
          // treats replay and live signals identically (see header note 3).
          if (Array.isArray(msg.replay)) {
            for (const entry of msg.replay) {
              // Per-entry guard: a null/malformed entry must not throw out of the
              // loop into the outer catch and silently strand the REST of the
              // replay batch (same per-emit isolation principle as the transcript
              // watcher's readNewLines), nor emit {kind: undefined} downstream.
              // at/deviceId forwarded when present (undefined otherwise) for the
              // recency map — additive, never disturbs the sync-trigger consumer.
              if (entry && entry.kind && entry.spaceKey) {
                opts.onEvent({ type: 'signal', kind: entry.kind, spaceKey: entry.spaceKey, at: entry.at, deviceId: entry.deviceId });
              }
            }
          }
        } else if (msg && msg.type === 'signal' && msg.kind && msg.spaceKey) {
          // Same guard on live frames — never hand the consumer undefined kind/
          // spaceKey. at/deviceId ride along when present (the DO's recency wire).
          opts.onEvent({ type: 'signal', kind: msg.kind, spaceKey: msg.spaceKey, at: msg.at, deviceId: msg.deviceId });
        } else if (msg && msg.type === 'lease-result' && typeof msg.reqId === 'string' && pending.has(msg.reqId)) {
          // Correlate the reply to its request() promise by reqId. An unknown
          // reqId (stale/duplicate) matches nothing and is dropped harmlessly.
          const p = pending.get(msg.reqId)!; pending.delete(msg.reqId); clearTimeout(p.timer);
          p.resolve({ ok: !!msg.ok, op: msg.op, sessionId: msg.sessionId, holder: msg.holder ?? null });
        } else if (msg && msg.type === 'lease-event' && msg.kind && msg.sessionId) {
          // Unsolicited server push (not tied to a reqId) — forward to the
          // consumer. Per-field guard mirrors the signal branch: no kind/sessionId
          // means we never hand the consumer undefined fields.
          opts.onEvent({ type: 'lease-event', kind: msg.kind, sessionId: msg.sessionId, device: msg.device, from: msg.from,
            ...(typeof msg.transferNonce === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(msg.transferNonce) &&
              typeof msg.senderDeviceId === 'string' && msg.senderDeviceId.length <= 100
              ? { transferNonce: msg.transferNonce, senderDeviceId: msg.senderDeviceId } : {}),
          });
        }
        // pong (or any other frame): ignore — pings are fire-and-forget liveness.
      } catch { /* non-JSON frame: ignore */ }
    },
  });

  return {
    setDesired(want) { engine.setDesired(want); },
    // Send a change signal to the room. Returns true only when actually written
    // on an OPEN socket; a closed/connecting socket is a silent no-op (the 120s
    // poll fallback covers the miss — no queueing, YAGNI).
    sendSignal(kind, spaceKey) {
      return engine.send(JSON.stringify({ type: 'signal', kind, spaceKey }));
    },
    // Request/response lease op. Sends a {type:'lease', op, sessionId, deviceId,
    // reqId} frame and resolves the matching server `lease-result` by reqId.
    // NEVER blocks the caller: resolves null immediately when not connected, on a
    // 5s timeout, if the send throws, or if the socket goes down mid-flight
    // (failAllPending). The consumer treats null as "no answer / fall back".
    request(op, sessionId, deviceId, transferNonce, expectedHolderId) {
      // WHY: a malformed conditional force cannot fall back to legacy unguarded force.
      if (op === 'force-acquire-if-holder' && (transferNonce !== undefined ||
          typeof expectedHolderId !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(expectedHolderId) ||
          expectedHolderId === '.' || expectedHolderId === '..' || expectedHolderId === deviceId)) return Promise.resolve(null);
      if (expectedHolderId !== undefined && op !== 'force-acquire-if-holder') return Promise.resolve(null);
      // WHY: never silently degrade a malformed correlated transfer into a
      // legacy takeover; the caller must know that this request was not sent.
      if (transferNonce !== undefined && (op !== 'takeover' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(transferNonce))) return Promise.resolve(null);
      if (!engine.isOpen()) return Promise.resolve(null); // never-block
      const reqId = `r${++reqCounter}`;
      return new Promise<LeaseResult | null>((resolve) => {
        const timer = setTimeout(() => { pending.delete(reqId); resolve(null); }, 5_000);
        timer.unref?.(); // don't keep the Electron main process alive just for a lease timeout
        pending.set(reqId, { resolve, timer });
        if (!engine.send(JSON.stringify({ type: 'lease', op, sessionId, deviceId, reqId,
          ...(transferNonce === undefined ? {} : { transferNonce }),
          ...(expectedHolderId === undefined ? {} : { expectedHolderId }) }))) {
          pending.delete(reqId); clearTimeout(timer); resolve(null);
        }
      });
    },
    // True only when a socket exists AND finished its handshake.
    isConnected() { return engine.isOpen(); },
    destroy() { engine.destroy(); },
  };
}
