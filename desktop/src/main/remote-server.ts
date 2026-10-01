import http from 'http';
import zlib from 'zlib';
// A phone's project watcher is dropped when its socket closes (the file channels themselves are table entries).
import { dropSubscriber } from './artifacts/project-watcher';
import { RemoteDownloads } from './remote-download';
// Games arcade scores — remote browsers share the desktop's operations and
// its stale-board cache (main/arcade-handlers.ts).
import { dropDocCommentsSubscriber } from './doc-comments/doc-comments-watcher';
import { staticAssetPolicy } from './remote-static-policy';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { isAllowedWsOrigin } from './remote-origin';
import type { SessionManager } from './session-manager';
import type { createHandoffTransport } from './conversations/handoff-transport';
import type { HookRelay } from './hook-relay';
import type { RemoteConfig } from './remote-config';
import { RemoteConfig as RemoteConfigStatics } from './remote-config';
import { RemoteDeviceStore, type RemoteDeviceView } from './remote-devices';
import type { LocalSkillProvider } from './skill-provider';
import type { SerializedChatState } from '../renderer/state/chat-types';
import { VITE_DEV_PORT } from '../shared/ports';
import type { NativeSendResult, HookEvent, SpecialistsEvent, ShellEvent } from '../shared/types';
import type { ProviderRegistry } from './providers/provider-registry';
import type { ModelCatalog } from './providers/model-catalog';
import type { SearchKeyStore } from './harness/search/search-key-store';
import type { SearchService } from './harness/search/search-service';
import type { EngineManager } from './engine/engine-manager';
import type { ModelManager } from './models/model-manager';
import type { PermissionStore } from './harness/permission-store';
import type { StepGuardSettings } from './harness/step-guard-settings';
import type { ContextSettingsStore } from './harness/context-settings-store';
import type { PermissionRule } from '../shared/permission-types';
import type { SpecialistCatalog } from './harness/specialists/catalog';
import type { ChatGptAuth } from './providers/chatgpt-auth';
import type { OpenRouterSignIn } from './providers/openrouter-oauth';
import type { RemoteNativeRuntime } from './create-runtime';
import { findChannel, serveRemoteChannel } from './ipc/channel-table';
import { sendToAllWindows } from './window-broadcast';
import { toListResult } from './harness/specialists/catalog';
import { BrowserWindow, app } from 'electron';
import { NativeHome } from './native-home';
import { UpdateSettings } from './update-settings';
import { resolveStaticFile } from './remote-static-path';

// 4M UTF-16 units per session — enough for full conversation replay. Named for what it
// counts (batch 2): JavaScript string length, not bytes.
const PTY_BUFFER_UNITS = 4 * 1024 * 1024;
// Perf (2026-09-03): the rolling PTY replay buffer is a LIST OF OUTPUT CHUNKS,
// not one big string, so appending costs O(chunk) instead of O(whole buffer).
// `length` is the running total of `chunks` measured in JavaScript string length
// (UTF-16 code units) — deliberately the SAME unit the old
// 4 MB cap counted (`buf.length > cap`), so the effective cap size does not
// silently change. (It is a character count, not a byte count: a non-ASCII char
// can cost 2 units and a UTF-8 byte count would differ — exactly as before.)
//
// Remote access batch 2 (design §7): the buffer is a window onto a monotonic STREAM.
// `epoch` names the stream (random per buffer, so a host restart or a destroyed-and-
// recreated session gets a new one); `base` is how many units have been trimmed off
// the head, so a chunk's stream position is `base + length` at the moment it is
// appended and the window covers `[base, base + length)`. A phone reports the stream
// position it has drawn up to; a matching epoch and a position inside the window get
// exactly the units past it, anything else gets a reset and the whole window.
interface PtyBuffer { chunks: string[]; length: number; epoch: string; base: number; }
// Perf: a PTY can emit a single keystroke at a time, and 4 MB of 1-char chunks
// would be millions of array entries (each JS string carries tens of bytes of
// overhead). So while the newest chunk is still small, append INTO it rather than
// pushing a new entry — copying under 4 KB is free, and it caps the array at
// roughly a thousand entries no matter how the output is chopped up.
const PTY_CHUNK_COALESCE_BELOW = 4096;
const HOOK_BUFFER_SIZE = 10_000; // ~10MB max, covers full conversations without excessive memory
const AUTH_TIMEOUT_MS = 5000;
// The most an unauthenticated socket may buffer before it signs in. The auth
// handshake is a single sub-KB JSON message; queued app traffic only follows
// auth:ok. 16 KB covers the handshake with room to spare (2026-09-10).
const PRE_AUTH_MAX_BYTES = 16 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
// A failed authentication closes the socket, so a connection gets ONE real attempt; this
// only bounds a client that pipelines several auth messages before the close lands.
// The point of moving off a per-ADDRESS bucket: behind the loopback bind every device is
// 127.0.0.1, so one bucket is the whole household — five bad guesses from anyone would lock
// everyone out, and on upgrade day every retired credential fails at once.
// A guesser can still open a new socket per five tries, so the host counts failures across
// all sockets too. Above this it SLOWS new connections rather than refusing them: a
// refusal here is indistinguishable from the feature being broken, and the person locked
// out is the owner far more often than the attacker.
const HOST_FAILURES_BEFORE_SLOWDOWN = 25;
const HOST_SLOWDOWN_MS = 2_000;
// The most sockets that may sit unauthenticated at once (2026-09-10 security
// review, #5). An auth handshake resolves in milliseconds and the socket then
// leaves this count, so a legitimate household never approaches it; the cap only
// bounds a flood of half-open pre-auth sockets held open to exhaust memory.
// A TOTAL cap, not per-IP: behind the loopback proxy every device shares
// 127.0.0.1, so a per-IP cap would be one bucket for the whole household.
const MAX_UNAUTH_SOCKETS = 64;
// Enough to cover a reconnect, not a session. Older than this answers "unknown".
const COMPLETED_RING_PER_DEVICE = 200;
const COMPLETED_RING_MS = 10 * 60_000;
// A half-open socket is invisible without this: the host keeps buffering for a client that
// is gone, and the client waits the full request timeout to learn anything is wrong.
const PING_INTERVAL_MS = 20_000;
// How many of those checks may go unanswered before the host gives up on a client.
// WHY more than one (Destin, 2026-09-11: "still flashes the password screen at me on
// refresh/reconnect and takes a while to load back in/sync up"; the dev log showed his phone
// dropping every 55-90 s): one missed check closed the connection after as little as 20 s of
// silence, and a phone that locks for half a minute — or whose radio pauses mid-tap — is not a
// phone that has gone away. Each reconnect then cost a full catch-up. Three gives roughly a
// minute of grace, still far inside the 30 s a request waits.
const MAX_MISSED_PINGS = 3;
// Remote access batch 2 (design §1): a client that never says `client:ready` — an older
// build of the phone page — gets the restore sequence after this long instead of never.
const OLD_CLIENT_FALLBACK_MS = 5000;
// The same fallback for a page that said at sign-in that it sends `client:ready`. WHY longer
// (2026-09-11 phone pass, dev log "client:ready ignored in phase live"): a phone's page can take
// more than 5 s from sign-in to listening, and the 5 s timer then ran the catch-up into a page
// that could not hear it, so the phone said "may be out of date". A page that will announce
// readiness is waited on; this timer only covers one that breaks before it can.
const READY_CLIENT_FALLBACK_MS = 30_000;

/** Latest-wins buffer: `buffers` is sessionId → key → the newest event for
 *  that key. One helper for both the specialist-run and shell-run catch-up
 *  buffers (simplification audit M8) — a card shows one current status, not
 *  a history, so the previous entry for the same key is overwritten. */
function bufferLatest<E>(buffers: Map<string, Map<string, E>>, sessionId: string, key: string, event: E): void {
  let byKey = buffers.get(sessionId);
  if (!byKey) {
    byKey = new Map();
    buffers.set(sessionId, byKey);
  }
  byKey.set(key, event);
}
// Broadcasts queued for a client that is still restoring. Overflow drops the oldest and
// marks that client's hydrate `degraded`, so the phone knows to offer Refresh.
const RESTORE_QUEUE_MAX = 2000;
// Backpressure (design §7): ws.send never blocks, so a stalled phone grew the host's
// socket buffer until the liveness ping closed it. While the socket holds more than
// this, the restore's sends pause and poll; above the close mark the client is closed
// with a code the strip renders as reconnecting.
const BACKPRESSURE_PAUSE_BYTES = 8 * 1024 * 1024;
const BACKPRESSURE_CLOSE_BYTES = 32 * 1024 * 1024;
const BACKPRESSURE_POLL_MS = 50;
const CLOSE_TOO_SLOW = 4009;

/** Where a remote client stands between auth and the live stream (design §1 B).
 *  `restoring`: queue every broadcast until the phone says it is ready.
 *  `readying`: the restore sequence is running (the snapshot may be in flight).
 *  `live`: broadcasts go straight to the socket. */
type ClientPhase = 'restoring' | 'readying' | 'live';

interface AuthenticatedClient {
  id: string;
  ws: WebSocket;
  deviceId: string;
  ip: string;
  connectedAt: number;
  /** Checks sent since the client last said anything. Reset by any frame, pong or message. */
  missedPings?: number;
  /** When the client last said anything — reported on the drop, so a silent death is visible. */
  lastHeardAt?: number;
  // Optional because tests (and any record added straight to `clients`) predate the
  // phases: a record with no phase is treated as live, which is what it always was.
  phase?: ClientPhase;
  /** Broadcasts held back while the client is not live, in arrival order. */
  queue?: { type: string; payload: any }[];
  /** True once the queue overflowed — the hydrate is then marked degraded. */
  queueDegraded?: boolean;
  /** Queue length at the moment the snapshot was requested: the cut line. */
  snapshotIndex?: number;
  /** Queue length when the hook buffer pass began (first connect only). */
  hookPassIndex?: number;
  /** Runs the restore for a client that never sends client:ready. */
  fallbackTimer?: ReturnType<typeof setTimeout> | null;
  /** A Refresh asked for while a restore was already running; it runs right after. */
  pendingRehydrate?: { seq?: number };
  /** What the phone said it had drawn per session, from client:ready (§7). */
  ptyOffsets?: Record<string, { epoch: string; units: number }>;
  /** Stream position sent so far per session during THIS restore — the replay cursor.
   *  Keyed with the buffer's epoch, so a buffer recreated mid-restore is not read at the
   *  old buffer's position (T2 review, 12). */
  ptyCursor?: Map<string, { epoch: string; pos: number }>;
  // The project watcher's subscriber id for this socket (batch 3, §8). Assigned
  // on the first watch-project and dropped on close; negative so it can never
  // collide with a webContents id, which is what the desktop subscribes with.
  watchId?: number;
  // Distinct roots this socket watches — capped (MAX_WATCHED_ROOTS_PER_SOCKET in ipc/artifacts.ts).
  watchedRoots?: Set<string>;
  // Document comments (T3): a SEPARATE subscriber-id space from watchId above
  // — a different module (doc-comments-watcher.ts) with its own refcounts —
  // so this client's docComments:watch/:unwatch calls don't share (or
  // collide with) its artifacts:watch-project subscription.
  docCommentsWatchId?: number;
}

export interface ClientInfo {
  id: string;
  ip: string;
  connectedAt: number;
}

// WHY (2026-10-01 one-core R3-8): HOST_ADMIN_REFUSAL moved with the admin channels to main/ipc/remote-admin.ts.

export interface RemoteStatus {
  state: 'listening' | 'stopped' | 'failed';
  reason?: string;
  port: number;
  clientCount: number; // phones connected now — WHY here (audit W18): the gear badge polled it every 10 s per window; emitStatus() fires on every connect/disconnect instead
}

/**
 * Which copy of the app a phone's browser is served.
 *
 * WHY (Destin, 2026-09-11: "still flashes the password screen at me on refresh/reconnect"): the
 * server served a built copy whenever one existed on disk, and a dev window found one left by an
 * Android test build the night before, so a whole day of phone-side fixes never reached the phone.
 * The installed app serves its built copy; a dev window serves live code unless a fresh copy was
 * built for the phone (run-dev.sh --phone-build). Pinned by tests/remote-server-connections.test.ts.
 */
export function choosePhonePageSource(opts: { serveBuiltPage: boolean; hasBuild: boolean }): 'built' | 'dev-server' {
  return opts.serveBuiltPage && opts.hasBuild ? 'built' : 'dev-server';
}

export class RemoteServer {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  // Tracks whether start() has completed. start() used to be called exactly
  // once at app boot, so re-entrancy never came up; it is now also called from
  // the Settings toggle (IPC.REMOTE_SET_CONFIG), and a second start() would
  // double-subscribe the SessionManager/HookRelay listeners and listen() twice.
  private running = false;
  // Held so stop() can clear it. Previously this interval was created by start()
  // and never cancelled, so it survived stop() and a restart stacked another.
  private uploadCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private clients = new Set<AuthenticatedClient>();
  // Sockets that have connected but not yet authenticated. Bounded by
  // MAX_UNAUTH_SOCKETS so a flood of half-open pre-auth sockets can't exhaust
  // memory (2026-09-10 security review, #5).
  private unauthSockets = 0;
  private lastClientActivityMs = 0; // see getLastClientActivityMs()
  private devices: RemoteDeviceStore;
  // `${encoding}:${urlPath}` → compressed bytes. Safe to hold indefinitely
  // because Vite content-hashes the URLs it serves; see compressStatic().
  private compressedAssets = new Map<string, Buffer>();
  // Channels already warned about, so an unbridged channel that a client polls
  // logs once instead of every second. See the `default:` case in handleMessage.
  private warnedChannels = new Set<string>();
  // sessionId → rolling PTY output. Perf: was `Map<string, string>`, where
  // onPtyOutput did `buf += data` then `buf.slice(...)`; once a busy session filled
  // the 4 MB cap, EVERY subsequent chunk re-allocated and copied ~4 MB — and it ran
  // whether or not anyone was connected, because the remote server is always on.
  // Chunks are joined into a string only at connect/replay time.
  private ptyBuffers = new Map<string, PtyBuffer>();
  private hookBuffers = new Map<string, any[]>(); // sessionId → rolling hook events
  // Task 9 (plan 1c) — mirrors hookBuffers, but keyed sessionId → childId,
  // holding only the LATEST specialists:event per helper (never an
  // append-only log — a card shows one current status, not a history of
  // every intermediate one). Filled by bufferSpecialistRun(), called from
  // the same ipc-handlers.ts listener that broadcasts 'specialists-event'.
  private specialistRunBuffers = new Map<string, Map<string, SpecialistsEvent>>();
  // G-1: sessionId -> shellId -> latest run view, same latest-per-key shape.
  private shellRunBuffers = new Map<string, Map<string, ShellEvent>>();
  // statusInterval removed — status data now fed by ipc-handlers.ts via broadcastStatusData()
  // Host-wide failure count, for the slowdown. Per-socket attempts live on the socket.
  private hostFailures = { count: 0, resetAt: 0 };
  private statusListeners = new Set<(status: RemoteStatus) => void>();
  /**
   * Ids of requests this host finished, per device, so a client that lost the reply can ask
   * whether its action ran. Bounded and in memory only: after a restart the honest answer
   * is "unknown", and the milestone names host restart as a case the UI must handle.
   */
  private completedRequests = new Map<string, { id: string; at: number }[]>();
  /** The OS reason the last start() failed, so the panel can say it rather than guess. */
  private lastStartError: string | null = null;
  /** The tailnet address to bind to. Null means Tailscale is not up, and start() refuses
   *  rather than falling back to every interface — that fallback IS the open listener. */
  private bindAddress: string | null = null;
  // Last-known topic names, fed by ipc-handlers.ts via setLastTopic()
  private lastTopics = new Map<string, string>();
  // Last-known FULL status payload, fed by ipc-handlers.ts via broadcastStatusData(),
  // replayed to each new client in restoreClient(). Was previously `contextMap` — only
  // the context-% slice was stored, and nothing ever read it, so a remote client that
  // connected between polls showed a blank status bar for up to 10s (the ipc-handlers
  // status interval). Storing the whole payload fixes that for every status field
  // (usage, gitBranch, sessionStats, attention, sync) instead of just context %.
  private lastStatusData: Record<string, any> | null = null;
  // Provider injected at construction — called when new clients connect to get the full chat state.
  // restoreClient() calls it once per restore; declared here so the field exists before that step.
  private requestSnapshot: () => Promise<SerializedChatState>;
  // WHY (2026-09-29 one-core R1): the SAME runtime the desktop door uses, from createRuntime() in
  // main.ts (was pushed in by ipc-handlers via a setter). Read-only accessor because this server
  // is built at module load and started BEFORE createWindow builds the runtime; no message can
  // arrive in between (no await). Null answers the native:*/provider:* cases' no-runtime fallbacks.
  // permissionStore is for permissions:list only; revokes go through nativeHost.
  private getNativeRuntime: () => RemoteNativeRuntime | null = () => null;
  private get nativeRuntime(): RemoteNativeRuntime | null { return this.getNativeRuntime(); }
  constructor(
    private sessionManager: SessionManager,
    private hookRelay: HookRelay,
    private config: RemoteConfig,
    // WHY unused now (2026-10-01 one-core R3-8): the favourite-themes read was this class's last use of the skill provider; it is a
    // table entry (main/ipc/appearance.ts) that reaches the config store through a bind. Kept so every caller's argument order holds.
    _skillProvider?: LocalSkillProvider,
    opts?: {
      requestSnapshot?: () => Promise<SerializedChatState>;
      getFocusSessionId?: () => string | null;
      /** Serve the built copy of the app when one exists (see choosePhonePageSource). main.ts
       *  passes app.isPackaged or run-dev.sh --phone-build; the default keeps the old behaviour. */
      serveBuiltPage?: boolean;
      /** The native runtime, read on every request (see the `nativeRuntime` field for why it is
       *  an accessor). main.ts returns the runtime createWindow built; tests return a partial fake. */
      getNativeRuntime?: () => RemoteNativeRuntime | null;
      /** WHY (2026-09-30 one-core R3-1): a change a phone makes through the channel table (a tag
       *  edited on a phone) must reach this computer's own windows too, not only the phones.
       *  Defaults to every window of the app (window-broadcast.ts); a test passes its own. */
      broadcastToWindows?: (channel: string, payload: unknown) => void;
    },
  ) {
    this.devices = new RemoteDeviceStore();
    // Default is a no-op that returns an empty snapshot — allows the server to
    // be constructed before the main window exists (e.g. during first-run setup).
    this.requestSnapshot = opts?.requestSnapshot ?? (() => Promise.resolve({ sessions: [] }));
    this.getFocusSessionId = opts?.getFocusSessionId ?? (() => null);
    this.serveBuiltPage = opts?.serveBuiltPage ?? true;
    if (opts?.getNativeRuntime) this.getNativeRuntime = opts.getNativeRuntime;
    this.broadcastToWindows = opts?.broadcastToWindows ?? sendToAllWindows;
  }
  private broadcastToWindows: (channel: string, payload: unknown) => void;
  private serveBuiltPage: boolean;
  private handoffRoute?: ReturnType<typeof createHandoffTransport>;
  /** WHY: remote requests share the exact Electron backend; no connection may supply another owner's identity. */
  setHandoffRoute(route: ReturnType<typeof createHandoffTransport>): void { this.handoffRoute = route; }

  /** One line per connection event in the host's log. WHY (2026-09-11 phone pass): an empty
   *  project list and a flashing password screen could not be traced, because the host recorded
   *  no connects, drops or catch-ups. A short device id only: never a secret, address or name. */
  private logDevice(client: { deviceId: string }, event: string): void {
    // WHY the time (2026-09-11): the log recorded seven drops in ten minutes with no way to
    // tell which were the phone being locked or refreshed and which happened on their own.
    console.log(`[remote-server] ${new Date().toISOString()} device ${client.deviceId.slice(0, 8)}: ${event}`);
  }
  // Batch 2 (§3): the session the desktop is showing, from main's per-window cache.
  // Rides session:destroyed so a phone whose conversation went away opens that one.
  // It can name the destroyed session itself — session-exit fires before any window
  // changes its selection — and the design puts that fallback on the phone (first
  // remaining session), so the host reports the cache as it is.
  private getFocusSessionId: () => string | null;
  /** Hands a phone's appearance change to the computer's windows (main owns BrowserWindow). */

  // loadTokens/saveTokens are deliberately NOT carried across this merge. They read the flat
  // `.remote-tokens.json` file of opaque strings that this batch replaced with per-device
  // records (RemoteDeviceStore): no identity, no dates, and revocation that dropped every
  // device at once. Restoring them would not compile — the fields are gone — and would undo
  // contract row R7.

  /** True once start() has bound the port; false after stop() or a failed start. */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * What the listener is actually doing. WHY this exists: the panel's indicator was derived
   * from saved settings plus Tailscale's state, so it said "connected" whenever the switch
   * was on — including when the port never bound. isRunning() was here all along with no
   * caller outside tests.
   */
  getStatus(): RemoteStatus {
    if (this.running) return { state: 'listening', port: this.config.port, clientCount: this.clients.size };
    if (this.lastStartError) return { state: 'failed', reason: this.lastStartError, port: this.config.port, clientCount: this.clients.size };
    return { state: 'stopped', port: this.config.port, clientCount: this.clients.size };
  }

  onStatusChange(listener: (status: RemoteStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  private emitStatus(): void {
    const status = this.getStatus();
    for (const l of this.statusListeners) l(status);
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      console.log('[RemoteServer] Disabled in config, not starting');
      return;
    }
    if (this.running) return;

    // WHY this refuses instead of falling back: binding every interface is exactly the
    // open, unencrypted listener this batch exists to remove. No Tailscale, no remote
    // access — and the panel says so rather than reporting a server that is not private.
    const ts = await RemoteConfigStatics.detectTailscale(this.config.port);
    if (!ts.connected || !ts.ip) {
      this.bindAddress = null;
      this.lastStartError = ts.installed
        ? 'Tailscale is installed but not connected, so there is no private address to listen on.'
        : 'Tailscale is not installed, so there is no private address to listen on.';
      this.emitStatus();
      throw new Error(this.lastStartError);
    }
    this.bindAddress = ts.ip;

    // Subscribe to events for buffering and broadcasting
    this.sessionManager.on('pty-output', this.onPtyOutput);
    this.hookRelay.on('hook-event', this.onHookEvent);
    this.hookRelay.on('permission-expired', this.onPermissionExpired);
    this.sessionManager.on('session-exit', this.onSessionExit);
    this.sessionManager.on('session-created', this.onSessionCreated);

    // Determine static file directory (production) or Vite dev server URL (development)
    const staticDir = path.join(__dirname, '..', 'renderer');
    // Fix: this fallback hardcoded port 5173 and ignored YOUCODED_PORT_OFFSET,
    // so a dev instance (Vite on 5223) proxied to a port with nothing on it and
    // every remote request returned a bare HTTP 502. main.ts:188 already derived
    // its dev URL from VITE_DEV_PORT; remote-server was the one place that
    // didn't. Never reintroduce a literal port here — import it from ports.ts.
    const viteDevUrl = process.env.VITE_DEV_SERVER_URL || `http://127.0.0.1:${VITE_DEV_PORT}`;
    const builtIndex = path.join(staticDir, 'index.html');
    const hasStaticBuild = choosePhonePageSource({ serveBuiltPage: this.serveBuiltPage, hasBuild: fs.existsSync(builtIndex) }) === 'built';
    // Say which, and how old a built copy is, so a stale copy shows in the log instead of hiding.
    if (hasStaticBuild) {
      console.log(`[RemoteServer] phone page: built copy from ${fs.statSync(builtIndex).mtime.toISOString()} (${staticDir})`);
    } else {
      console.log(`[RemoteServer] phone page: live code from the dev server (${viteDevUrl})`);
    }

    this.httpServer = http.createServer((req, res) => {
      // WHY this endpoint exists: without it the sign-in screen has no way to know the host
      // has no password set, so it shows a password box, waits for you to type something,
      // and only then says "Remote access is not configured". It asked for a secret that
      // could not have existed. Now the screen knows before it draws.
      //
      // It discloses nothing new: anyone who can open this port learns the same thing by
      // connecting, because the refusal names its own reason. It is deliberately the ONLY
      // thing served without authentication, and it says nothing about devices or sessions.
      if ((req.url || '').split('?')[0] === '/remote-state') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ needsSetup: !this.config.passwordHash }));
        return;
      }
      // Download links (batch 3, §10) — matched before the static handler AND
      // the Vite proxy: the SPA fallback would answer an expired link with
      // index.html and a 200, and in dev the proxy would hand it to Vite. The
      // 256-bit token in the path is the authorization; see remote-download.ts.
      if (this.downloads.handleHttpRequest(req, res)) return;
      if (hasStaticBuild) {
        this.handleHttpRequest(req, res, staticDir);
      } else {
        this.proxyToVite(req, res, viteDevUrl);
      }
    });

    // Security: limit message size to 50MB to prevent memory exhaustion attacks.
    // verifyClient (2026-09-10 security review, #5): reject a cross-origin upgrade
    // before the socket opens, so a web page the user has open elsewhere cannot
    // hijack this WebSocket (CSWSH). See remote-origin.ts for the rule.
    this.wss = new WebSocketServer({
      server: this.httpServer,
      path: '/ws',
      maxPayload: 52428800,
      verifyClient: (info, cb) => {
        if (isAllowedWsOrigin(info.origin, info.req.headers.host)) {
          cb(true);
          return;
        }
        // Log so a legitimate refusal (e.g. a nickname we didn't anticipate) is
        // visible rather than a silent "it just won't connect".
        console.warn('[remote-server] refused WS upgrade: origin', JSON.stringify(info.origin || null),
          'host', JSON.stringify(info.req.headers.host || null));
        cb(false, 403, 'Forbidden origin');
      },
    });
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));

    // Dev mode: proxy WebSocket upgrades (non-/ws) to Vite for HMR
    if (!hasStaticBuild) {
      this.httpServer.on('upgrade', (req, socket, _head) => {
        if (req.url === '/ws') return; // handled by our WebSocketServer
        // Use http:// URL — WebSocket upgrade is an HTTP request with Upgrade header
        const proxyUrl = new URL(req.url || '/', viteDevUrl);
        const proxyReq = http.request(proxyUrl, {
          method: 'GET',
          headers: req.headers,
        });
        proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\n` +
            Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
            '\r\n\r\n'
          );
          if (proxyHead.length) socket.write(proxyHead);
          proxySocket.pipe(socket);
          socket.pipe(proxySocket);
        });
        proxyReq.on('error', () => socket.destroy());
        proxyReq.end();
      });
    }

    // Status data is now fed by ipc-handlers.ts via broadcastStatusData() —
    // no independent polling needed. This eliminates duplicate file reads.

    // Cleanup uploaded files older than 1 hour
    const uploadDir = path.join(os.tmpdir(), 'claude-desktop-uploads');
    this.uploadCleanupTimer = setInterval(async () => {
      try {
        const files = await fs.promises.readdir(uploadDir);
        const now = Date.now();
        for (const file of files) {
          try {
            const stat = await fs.promises.stat(path.join(uploadDir, file));
            if (now - stat.mtimeMs > 3600_000) {
              await fs.promises.unlink(path.join(uploadDir, file));
            }
          } catch {}
        }
      } catch {}
    }, 3600_000);

    // Topic names are tracked by ipc-handlers.ts and forwarded via setLastTopic() + broadcast()

    // listen() errors (EADDRINUSE, EACCES) used to have no handler at all: the
    // promise simply never settled and the 'error' event went unhandled. That
    // was survivable when start() ran once during boot inside a try/catch that
    // only logged, but the Settings toggle now awaits this — an unsettled
    // promise would hang the toggle forever with no feedback. Reject with the
    // real OS error so the caller can surface it verbatim rather than guess.
    return new Promise<void>((resolve, reject) => {
      const server = this.httpServer!;
      let settled = false;
      const onError = (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        // Roll back the half-built state (event subscriptions, timer, sockets)
        // so a retry starts clean instead of double-subscribing. Rollback, not a user
        // stop: the reason is set on the next line, and announcing 'stopped' first would
        // flash the panel through a state the server was never in.
        this.stop(true);
        // Keep the reason: a bind failure was only logged, so the panel had nothing to show
        // and fell back to reporting the saved setting as though it had worked.
        this.lastStartError = err.message;
        this.emitStatus();
        reject(err);
      };
      server.once('error', onError);
      // Bind to the Tailscale address ONLY. Verified 2026-09-09: a server bound this way
      // answers on the tailnet name and REFUSES the machine's home-wifi address, which is
      // contract row R10 — and it needs neither Tailscale Serve nor an administrator
      // password, because nothing about Tailscale's own configuration changes.
      server.listen(this.config.port, this.bindAddress ?? undefined, () => {
        if (settled) return;
        settled = true;
        server.removeListener('error', onError);
        this.running = true;
        this.lastStartError = null;
        // The liveness ping is armed by addClient (first client) and disarmed on
        // the last drop — see startLiveness (simplification audit W14).
        console.log(`[RemoteServer] Listening on port ${this.config.port}`);
        this.emitStatus();
        resolve();
      });
    });
  }

  /** Store a topic name for replay on new connections. Called by ipc-handlers.ts. */
  setLastTopic(desktopId: string, name: string): void {
    this.lastTopics.set(desktopId, name);
  }

  /** Broadcast status data to all connected remote clients. Called by ipc-handlers.ts
   *  so that both the local renderer and remote clients share the same polling cycle. */
  broadcastStatusData(data: Record<string, any>): void {
    this.lastStatusData = data;
    this.broadcast({ type: 'status:data', payload: data });
  }

  /** @param forRollback internal use: unwinding a start that failed, where the caller sets
   *  the real reason on the next line. Every other caller is a user switching it off. */
  stop(forRollback = false): void {
    this.running = false;
    if (this.uploadCleanupTimer) {
      clearInterval(this.uploadCleanupTimer);
      this.uploadCleanupTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.lastTopics.clear();
    this.lastStatusData = null;
    this.sessionManager.off('pty-output', this.onPtyOutput);
    this.hookRelay.off('hook-event', this.onHookEvent);
    this.hookRelay.off('permission-expired', this.onPermissionExpired);
    this.sessionManager.off('session-exit', this.onSessionExit);
    this.sessionManager.off('session-created', this.onSessionCreated);

    for (const client of this.clients) {
      // WHY: stop clears clients before close events run; invalidate pending starts now.
      this.handoffRoute?.cancelOwner(`remote:${client.id}`);
      client.ws.close(1001, 'Server shutting down');
    }
    this.clients.clear();
    // Nothing to clear for devices: the store is file-backed, so toggling remote access off
    // and on no longer forces every paired device to re-enter the password.

    if (this.wss) { this.wss.close(); this.wss = null; }
    if (this.httpServer) { this.httpServer.close(); this.httpServer = null; }
    if (forRollback) return;
    // A stop the USER asked for clears the last failure. It used to be cleared only by a
    // successful listen, and this method skipped its own emit whenever the field was set —
    // so after one failed start the panel read "Not running: <that reason>" for the rest of
    // the process, including after remote access had been switched off entirely.
    this.lastStartError = null;
    this.emitStatus();
  }

  /** Every device loses access — what a password change means. */
  invalidateTokens(): void {
    this.devices.revokeAll();
    this.downloads.revokeAll();
    for (const client of [...this.clients]) {
      client.ws.close(4001, 'Password changed');
      this.removeClient(client); // also disarms the liveness ping on the last one
    }
  }

  /** Number of currently connected remote clients. */
  getClientCount(): number {
    return this.clients.size;
  }

  /** Epoch ms of the last authenticated remote-client message (0 = never).
   *  Read by the presence idle poller (social-handlers.ts): someone driving
   *  the app through remote access produces no LOCAL keyboard/mouse input, so
   *  system idle time alone would wrongly mark them away. */
  getLastClientActivityMs(): number {
    return this.lastClientActivityMs;
  }

  /** List all connected remote clients. */
  getClientList(): ClientInfo[] {
    return Array.from(this.clients).map(c => ({
      id: c.id,
      ip: c.ip,
      connectedAt: c.connectedAt,
    }));
  }

  /** Contract R11: every device that has paired, until it is unpaired. */
  getDeviceList(): RemoteDeviceView[] {
    const online = new Set<string>();
    for (const c of this.clients) online.add(c.deviceId);
    return this.devices.list(online);
  }

  renameDevice(deviceId: string, name: string): boolean {
    return this.devices.rename(deviceId, name);
  }

  /**
   * Contract R7/R8. Unpair, then hang up: the record is what keeps the device out, so a
   * device whose socket is already gone is still unpaired — which is the whole point of a
   * list that keeps offline devices.
   */
  unpairDevice(deviceId: string): boolean {
    const revoked = this.devices.revoke(deviceId);
    if (!revoked) return false;
    // Contract R10 (batch 3): removing a device also ends its right to download.
    this.downloads.revokeDevice(deviceId);
    for (const client of this.clients) {
      if (client.deviceId === deviceId) {
        client.ws.close(4003, 'Device unpaired');
        this.removeClient(client);
      }
    }
    return true;
  }

  /** Every path that forgets a client goes through here so the liveness ping
   *  can stand down when the last one leaves (simplification audit W14). */
  private removeClient(client: AuthenticatedClient): void {
    if (!this.clients.delete(client)) return;
    // WHY: close/error/liveness drops must invalidate in-flight starts for this connection only.
    this.handoffRoute?.cancelOwner(`remote:${client.id}`);
    if (this.clients.size === 0 && this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.emitStatus(); // clientCount changed — see RemoteStatus.clientCount
  }

  // --- Event handlers for buffering ---

  private onPtyOutput = (sessionId: string, data: string) => {
    // Append to the rolling replay buffer. Perf: push the chunk instead of
    // rebuilding the whole string — see PtyBuffer for the 4 MB-per-chunk copy
    // this replaces.
    let buf = this.ptyBuffers.get(sessionId);
    if (!buf) { buf = { chunks: [], length: 0, epoch: randomUUID().slice(0, 8), base: 0 }; this.ptyBuffers.set(sessionId, buf); }
    // The chunk's stream position, read BEFORE the append (see PtyBuffer).
    const offset = buf.base + buf.length;
    // An empty chunk adds nothing to the replayed text but WOULD add an array
    // entry, so skip it here. The live broadcast below is deliberately untouched —
    // a client that is listening still sees exactly the frames it saw before.
    if (data.length > 0) {
      const last = buf.chunks.length - 1;
      if (last >= 0 && buf.chunks[last].length < PTY_CHUNK_COALESCE_BELOW) {
        buf.chunks[last] += data; // merge into the small tail chunk (see PTY_CHUNK_COALESCE_BELOW)
      } else {
        buf.chunks.push(data);
      }
      buf.length += data.length;

      // Trim WHOLE chunks off the head until we are back under the cap.
      // Behaviour note: the old code cut mid-chunk at exactly the cap, so
      // the replay could begin part-way through a terminal escape sequence; the cut
      // now lands on a chunk boundary, which means the buffer can hold slightly
      // LESS than the cap. That is the intended trade — the replayed tail is
      // otherwise identical, and it is strictly less likely to start mid-escape.
      while (buf.length > PTY_BUFFER_UNITS && buf.chunks.length > 1) {
        const dropped = buf.chunks.shift()!.length;
        buf.length -= dropped;
        buf.base += dropped;             // every head trim advances the window's start
      }
      // A single chunk larger than the entire cap cannot be dropped without losing
      // everything, so trim its tail instead — the one copy left in this path, and
      // it only happens when one read delivers more than 4 MB at once.
      if (buf.length > PTY_BUFFER_UNITS) {
        const only = buf.chunks[0];
        buf.base += only.length - PTY_BUFFER_UNITS;   // this slice is a head trim too
        buf.chunks[0] = only.slice(only.length - PTY_BUFFER_UNITS);
        buf.length = buf.chunks[0].length;
      }
    }

    // Broadcast live. A client that is not live yet does not get this (see
    // enqueueForRestoring): the cursor replay covers it up to the moment it goes live.
    this.broadcast({ type: 'pty:output', payload: { sessionId, data, epoch: buf.epoch, offset } });
  };

  /** The window's text from stream position `from` (>= base) to its end, without
   *  joining chunks the caller already has. */
  private static sliceFrom(buf: PtyBuffer, from: number): string {
    let skip = from - buf.base;
    const parts: string[] = [];
    for (const chunk of buf.chunks) {
      if (skip >= chunk.length) { skip -= chunk.length; continue; }
      parts.push(skip > 0 ? chunk.slice(skip) : chunk);
      skip = 0;
    }
    return parts.join('');
  }

  /**
   * One replay pass for a client (design §7): for every session buffer, send what lies
   * past the client's cursor. The first pass seeds the cursor from what the phone said
   * it had drawn — an exact continuation when the epoch matches and the position is
   * inside the window, otherwise a reset and the whole window. Returns true when
   * anything was sent, so the caller can pass again until nothing is new: output that
   * arrives while a send is paused is picked up by the next pass, never lost, and the
   * live broadcast takes over with no gap and no overlap.
   */
  private async ptyPass(client: AuthenticatedClient): Promise<boolean> {
    const cursor = (client.ptyCursor ??= new Map());
    let sent = false;
    for (const [sessionId, buf] of this.ptyBuffers) {
      const prior = cursor.get(sessionId);
      let from: number;
      let reset = false;
      if (prior && prior.epoch === buf.epoch) {
        from = prior.pos;
        // More output arrived while a send was paused than the window holds, so the head
        // trim passed the cursor: what lies between is gone. Start the terminal over
        // rather than skip it silently (T2 review, 4).
        if (from < buf.base) { reset = true; from = buf.base; }
      } else if (prior) {
        // This session's buffer was destroyed and recreated during the restore.
        reset = true;
        from = buf.base;
      } else {
        const reported = client.ptyOffsets?.[sessionId];
        const total = buf.base + buf.length;
        if (reported && reported.epoch === buf.epoch && reported.units >= buf.base && reported.units <= total) {
          from = reported.units;
        } else {
          from = buf.base;
          // The phone drew a terminal this window cannot continue: start it over.
          reset = !!reported;
        }
      }
      if (reset) {
        if (!(await this.sendGated(client, { type: 'pty:reset', payload: { sessionId, epoch: buf.epoch } }))) return sent;
        sent = true;
        from = Math.max(from, buf.base);          // the window may have moved during the send
      }
      if (from < buf.base + buf.length) {
        // Sliced HERE, synchronously; the cursor advances by exactly what was sliced. It
        // used to jump to the buffer's end after the send, which skipped any output that
        // arrived while that send was paused.
        const data = RemoteServer.sliceFrom(buf, from);
        if (!(await this.sendGated(client, { type: 'pty:output', payload: { sessionId, data, epoch: buf.epoch, offset: from } }))) return sent;
        sent = true;
        from += data.length;
      }
      cursor.set(sessionId, { epoch: buf.epoch, pos: from });
    }
    return sent;
  }

  /** Permission asks the snapshot shows awaiting in one session, top-level and nested.
   *  For a session the snapshot holds, the desktop's own copy is the truth about which
   *  asks are open — the host buffer misses asks raised before remote access started. */
  private static awaitingInSnapshot(snapshot: SerializedChatState, sessionId: string): string[] {
    const held = snapshot.sessions.find(([id]) => id === sessionId)?.[1];
    const out: string[] = [];
    for (const [, tool] of held?.toolCalls ?? []) {
      if (tool.status === 'awaiting-approval' && tool.requestId) out.push(tool.requestId);
      for (const seg of tool.subagentSegments ?? []) {
        if (seg.type === 'tool' && seg.status === 'awaiting-approval' && seg.requestId) out.push(seg.requestId);
      }
    }
    return out;
  }

  /**
   * Send with the backpressure gate (design §7). Returns false when the client is gone
   * or was closed for being too slow, so a caller can stop its pass.
   */
  private async sendGated(client: AuthenticatedClient, msg: { type: string; payload: any }): Promise<boolean> {
    const ws = client.ws;
    while (ws.readyState === WebSocket.OPEN && ws.bufferedAmount > BACKPRESSURE_PAUSE_BYTES) {
      if (ws.bufferedAmount > BACKPRESSURE_CLOSE_BYTES) {
        ws.close(CLOSE_TOO_SLOW, 'Too slow');
        return false;
      }
      // `ws` exposes no drain event on bufferedAmount; a short poll is the signal.
      await new Promise((r) => setTimeout(r, BACKPRESSURE_POLL_MS));
    }
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  /** A Claude Code ask whose hook socket closed before anyone answered (T2 review, 7).
   *  main.ts tells the desktop windows; nothing told the host's replay buffer or a phone,
   *  so a reconnecting phone was replayed the dead ask as open. Purge it from the buffer
   *  (the same purge a resolution does) and tell connected clients it expired — for the
   *  relay, "socket closed before a response was sent" is literally what happened. */
  private onPermissionExpired = (sessionId: string, requestId: string, reason?: string) => {
    this.bufferHookEvent({ type: 'PermissionResolved', sessionId, payload: { _requestId: requestId }, timestamp: Date.now() } as HookEvent);
    // _reason travels to phones too, so a 'hook-closed' ask stays answerable
    // there exactly as it does on the computer (hook-relay.ts).
    const expired = { type: 'PermissionExpired', sessionId, payload: { _requestId: requestId, _reason: reason }, timestamp: Date.now() } as HookEvent;
    // Buffered too, so a phone that was away hears "expired" on reconnect instead of a
    // replay-complete that would clear the card as answered (T2 re-review, 7).
    this.bufferHookEvent(expired);
    this.broadcast({ type: 'hook:event', payload: expired });
  };

  private onHookEvent = (event: any) => {
    this.bufferHookEvent(event);
    // Broadcast live
    this.broadcast({ type: 'hook:event', payload: event });
  };

  /** Push one hook event onto the rolling per-session replay buffer, WITHOUT
   *  broadcasting it — split out of onHookEvent (which still does both, for
   *  the legacy hookRelay path) so ipc-handlers.ts can feed this SAME buffer
   *  for NATIVE hook events, which reach remote clients through a direct
   *  broadcast() call in ipc-handlers.ts, never through this class's own
   *  onHookEvent (that listener is wired only to hookRelay.on('hook-event',
   *  ...) — see the call site's own comment for the gap this closes: without
   *  it, a phone reconnecting while a native permission ask was open saw no
   *  card until the next heartbeat). Reusing hookBuffers — rather than a
   *  parallel native-only map — means the existing replay loop in
   *  restoreClient() picks these up for free, in push order. */
  bufferHookEvent(event: HookEvent): void {
    const sessionId = event.sessionId || '';
    // Fix pass (2026-08-16 review finding, "the catch-up replays asks that
    // were already answered"): PermissionBroker's one removal chokepoint
    // (permission-broker.ts's removeEntry) now emits this the moment an ask
    // stops being open — respond() or a cancel.
    // Before this, a PermissionRequest sat in the buffer FOREVER once
    // answered (nothing ever removed it, and the buffer holds 10,000
    // events), so a reconnecting phone was replayed a dead question with
    // live-looking Yes/No buttons; tapping either returned false and the
    // card showed a "socket closed" error that was simply untrue — no
    // socket had closed. This is a purge signal, not a replayable card: it
    // drops every matching PermissionRequest (same _requestId) instead of being appended itself. hook-dispatcher.ts's
    // switch defaults to null on this unknown type, so even if a live client
    // saw it broadcast, it is a harmless no-op — nothing here required a
    // renderer change.
    if (event.type === 'PermissionResolved' || event.type === 'PasswordResolved') {
      const requestId = (event.payload as Record<string, unknown> | undefined)?._requestId;
      const buf = this.hookBuffers.get(sessionId);
      if (buf && typeof requestId === 'string') {
        const filtered = buf.filter((e) => (e.payload as Record<string, unknown> | undefined)?._requestId !== requestId);
        if (filtered.length !== buf.length) this.hookBuffers.set(sessionId, filtered);
      }
      return;
    }
    // admin-password design §2.5: a PasswordRequest is never buffered at all
    // — not even transiently. Unlike a PermissionRequest (which the buffer
    // exists to replay to a reconnecting phone), a password ask's own
    // re-announce heartbeat (permission-broker.ts, every 3s) plus this same
    // live broadcast already cover a reconnect within a few seconds, and this
    // rolling log must not hold a password ask's command line/tries any
    // longer than the ask is actually live.
    if (event.type === 'PasswordRequest') return;
    const buf = this.hookBuffers.get(sessionId) || [];
    buf.push(event);
    // Perf: drop the overflow IN PLACE. This was `buf = buf.slice(...)`, which
    // allocated a fresh 10,000-entry array on every single event once the cap was
    // reached. splice keeps exactly the same surviving events in the same order.
    if (buf.length > HOOK_BUFFER_SIZE) {
      buf.splice(0, buf.length - HOOK_BUFFER_SIZE);
    }
    this.hookBuffers.set(sessionId, buf);
  }

  /** Task 9 (plan 1c) — the remote-client counterpart to
   *  NativeSessionHost.specialistRunsFor: a reconnecting phone hydrates over
   *  this WebSocket, never through TRANSCRIPT_REPLAY, so it needs its own
   *  connect-time catch-up for a helper's run status. Called from the SAME
   *  ipc-handlers.ts listener that broadcasts 'specialists-event' live.
   *  Latest-per-child, not append-only — see specialistRunBuffers' own
   *  comment for why overwriting the previous entry is correct here. */
  bufferSpecialistRun(event: SpecialistsEvent): void {
    bufferLatest(this.specialistRunBuffers, event.sessionId, event.run.childId, event);
  }

  /** G-1: connect-time catch-up for a background command's card — latest per
   *  shell id, never an append-only log (same reasoning as bufferSpecialistRun). */
  bufferShellRun(event: ShellEvent): void {
    bufferLatest(this.shellRunBuffers, event.sessionId, event.run.shellId, event);
  }

  private onSessionCreated = (info: any) => {
    this.broadcast({ type: 'session:created', payload: info });
  };

  private onSessionExit = (sessionId: string, exitCode: number = 0) => {
    this.ptyBuffers.delete(sessionId);
    this.hookBuffers.delete(sessionId);
    this.lastTopics.delete(sessionId);
    // Task 9: a destroyed parent's helpers are gone with it — nothing will
    // ever reconnect asking for this session's run status again, so clear it
    // the same way the buffers above already do.
    this.specialistRunBuffers.delete(sessionId);
    this.shellRunBuffers.delete(sessionId);   // G-1
    // Forward exitCode so the remote shim can surface 'session-died' banners
    // when Claude's process dies mid-turn on the host machine.
    this.broadcast({ type: 'session:destroyed', payload: { sessionId, exitCode, focus: { sessionId: this.getFocusSessionId() } } });
  };

  // --- HTTP static file serving ---

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse, staticDir: string): void {
    const url = req.url || '/';
    let filePath: string;

    if (url === '/' || url === '/index.html') {
      filePath = path.join(staticDir, 'index.html');
    } else {
      // resolveStaticFile decodes safely (a malformed % no longer throws into the
      // main process) and confines the result to staticDir by path segments.
      const resolved = resolveStaticFile(url, staticDir);
      if (resolved === null) {
        res.writeHead(400);
        res.end('Bad Request');
        return;
      }
      filePath = resolved;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        // SPA fallback — serve index.html for non-file routes
        fs.readFile(path.join(staticDir, 'index.html'), (err2, html) => {
          if (err2) {
            res.writeHead(404);
            res.end('Not found');
          } else {
            this.sendStatic(req, res, '/index.html', '.html', html);
          }
        });
        return;
      }

      this.sendStatic(req, res, url, path.extname(filePath).toLowerCase(), data);
    });
  }

  /**
   * Writes a static asset with negotiated compression and cache headers.
   *
   * Before this, remote clients re-downloaded the ~2.14 MB uncompressed critical
   * path (2,016 kB entry chunk + 128 kB CSS) on every page load, with no caching
   * headers at all — the dominant cost of a first connect over a phone link.
   */
  private sendStatic(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    urlPath: string,
    ext: string,
    data: Buffer,
  ): void {
    const policy = staticAssetPolicy(urlPath, ext, req.headers['accept-encoding'] as string, data.length);

    const headers: Record<string, string> = {
      'Content-Type': policy.contentType,
      'Cache-Control': policy.cacheControl,
      // Caches key on the encoding we picked, or a gzip response can be replayed
      // to a client that never asked for one.
      Vary: 'Accept-Encoding',
    };

    if (!policy.encoding) {
      res.writeHead(200, headers);
      res.end(data);
      return;
    }

    const body = this.compressStatic(urlPath, policy.encoding, data);
    headers['Content-Encoding'] = policy.encoding;
    res.writeHead(200, headers);
    res.end(body);
  }

  /**
   * Compresses once per (asset, encoding) and reuses the result.
   *
   * Assets under assets/ are content-hashed, so a given URL's bytes never
   * change and the cached output can never go stale. This is what makes brotli
   * affordable — compressing a 2 MB chunk per request would cost far more than
   * the transfer it saves.
   */
  private compressStatic(urlPath: string, encoding: 'br' | 'gzip', data: Buffer): Buffer {
    const key = `${encoding}:${urlPath}`;
    const cached = this.compressedAssets.get(key);
    if (cached) return cached;

    const compressed = encoding === 'br'
      // Quality 5 rather than the default 11: near-gzip CPU cost for
      // meaningfully better ratios. At 11 the first request for the entry chunk
      // would stall for seconds.
      // Measured on the real 1,969 kB entry chunk (2026-07-20): q5 = 38 ms,
      // q11 = 4,719 ms. Do NOT raise this — the default (11) would stall the
      // first request by ~5 s, costing more than the transfer it saves.
      ? zlib.brotliCompressSync(data, {
          params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
        })
      : zlib.gzipSync(data);

    // Bound the cache. A production build emits a handful of assets, but this
    // is fed by request URLs, so it must not be allowed to grow without limit.
    if (this.compressedAssets.size >= 64) this.compressedAssets.clear();
    this.compressedAssets.set(key, compressed);
    return compressed;
  }

  // --- Dev mode: proxy HTTP requests to Vite dev server ---

  private proxyToVite(req: http.IncomingMessage, res: http.ServerResponse, viteUrl: string): void {
    const url = new URL(req.url || '/', viteUrl);
    const proxyReq = http.request(url, {
      method: req.method,
      headers: req.headers,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => {
      res.writeHead(502);
      res.end('Vite dev server not available');
    });
    req.pipe(proxyReq);
  }

  // --- WebSocket connection handling ---

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const ip = req.socket.remoteAddress || '';

    // Bound the number of sockets held open without authenticating (2026-09-10
    // security review, #5). releaseUnauth() runs exactly once — on auth success
    // below, or on close for every failure/timeout path — so an authenticated
    // long-lived socket does not keep occupying a pre-auth slot.
    if (this.unauthSockets >= MAX_UNAUTH_SOCKETS) {
      ws.close(4009, 'Too many pending connections');
      return;
    }
    this.unauthSockets++;
    let releasedUnauth = false;
    const releaseUnauth = () => { if (!releasedUnauth) { releasedUnauth = true; this.unauthSockets--; } };
    ws.once('close', releaseUnauth);
    // ONE auth attempt per connection. The handler below detaches itself on the first
    // message and every failure path closes the socket, so a guesser pays a full
    // reconnect per try and cannot spend anyone else's budget.
    //
    // This used to carry a five-attempt counter. The counter was unreachable — the
    // detach happens before a second message could ever be counted — so the code
    // claimed five and delivered one. One is the stronger of the two, so it is what
    // the code now says. Found by writing the behaviour test in remote-server-connections.test.ts;
    // the source-scan version passed happily, because the words were all present.
    const slowStart = this.shouldSlowConnection() ? HOST_SLOWDOWN_MS : 0;

    // Contract R9: a device needs the password even on a private network. The block that
    // stood here auto-paired any peer inside 100.64.0.0/10 with no password exchanged — a
    // carrier-grade NAT range, not one Tailscale owns. Nothing is trusted for its address.
    // The per-IP rate limiter that stood beside it is gone for the reason in §0: behind a
    // loopback proxy every device shares one bucket, so five failures locked the household
    // out. Limits are per socket and per host now.

    // Pre-auth byte budget (2026-09-10 security review). The socket accepts up to
    // maxPayload (50 MB) so an authenticated device can upload a file, but the
    // first message — an auth handshake — is well under 1 KB. Cap what an
    // unauthenticated peer may buffer at PRE_AUTH_MAX_BYTES so it cannot make the
    // host hold megabytes per idle connection. Removed the moment auth resolves.
    // The `?.` on .on/.off is a RUNTIME guard, not a type one: a real net.Socket
    // always has them, but the WS-level test harness passes a bare `{ remoteAddress }`
    // stub, where the byte budget is moot.
    let preAuthBytes = 0;
    const budgetGuard = (chunk: Buffer) => {
      preAuthBytes += chunk.length;
      if (preAuthBytes > PRE_AUTH_MAX_BYTES) {
        clearTimeout(timeout);
        detachBudget();
        ws.close(4009, 'Pre-auth payload too large');
      }
    };
    const detachBudget = () => { req.socket.off?.('data', budgetGuard); };

    // Auth timeout
    const timeout = setTimeout(() => {
      detachBudget();
      ws.close(4000, 'Auth timeout');
    }, AUTH_TIMEOUT_MS);
    req.socket.on?.('data', budgetGuard);

    // Wait for auth message
    const authHandler = async (raw: Buffer | string) => {
      clearTimeout(timeout);
      detachBudget();
      if (slowStart) await new Promise(r => setTimeout(r, slowStart));
      ws.off('message', authHandler);

      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== 'auth') {
          ws.send(JSON.stringify({ type: 'auth:failed', reason: 'expected-auth' }));
          ws.close(4000, 'Expected auth');
          return;
        }

        // No password configured
        if (!this.config.passwordHash) {
          ws.send(JSON.stringify({ type: 'auth:failed', reason: 'no-password-configured' }));
          ws.close(4000, 'No password configured');
          return;
        }

        // A credential first, then the password. WHY the credential answers with a REASON:
        // "unpaired" and "credential retired" are terminal — the client must stop retrying
        // rather than hammer the host into its own lockout — while a bad secret is not.
        if (msg.deviceId) {
          const result = this.devices.authenticate(msg.deviceId, msg.secret);
          if (result.ok) {
            this.clearFailedAttempts();
            releaseUnauth(); // authenticated — free the pre-auth slot
            this.config.markPaired();
            this.addClient(ws, result.device.id, ip, { sendsReady: msg.readyHandshake === true });
            // Same capability flag as the pairing path below — master's own note says the
            // two sites must stay in step, and a returning device paints the same UI.
            ws.send(JSON.stringify({ type: 'auth:ok', deviceId: result.device.id, platform: 'desktop', sessionNaming: true }));
            // The restore waits for client:ready (addClient armed the old-client fallback).
            return;
          }
          if (result.reason !== 'bad-secret') {
            // Not a failed guess, so it does not count toward the lockout: on upgrade day
            // every retired credential arrives at once and must not lock the household out.
            ws.send(JSON.stringify({ type: 'auth:failed', reason: result.reason }));
            ws.close(result.reason === 'revoked' ? 4003 : 4004,
              result.reason === 'revoked' ? 'Device unpaired' : 'Credential retired');
            return;
          }
        }

        if (msg.password && await this.config.verifyPassword(msg.password)) {
          this.clearFailedAttempts();
          // The secret is returned once per pairing. A device that still HOLDS its credential
          // re-authenticates with it above. Arriving here with only the password means that
          // credential is gone. The host still never GUESSES which row this is — matching on a
          // name would merge two people with the same phone. The browser names its own row,
          // remembered apart from its key, and the password proves it may have that row back
          // with a new key (Destin, 2026-09-11: "each sign in seems to create a new device
          // entry … even though all the same device"). An unpaired or unknown row is a new
          // pairing, so an unpaired device never comes back by naming itself.
          const paired = this.devices.pairAgain(msg.previousDeviceId) ?? this.devices.pair(msg.deviceName);
          releaseUnauth(); // authenticated — free the pre-auth slot
          this.config.markPaired();
          this.addClient(ws, paired.deviceId, ip, { sendsReady: msg.readyHandshake === true });
          // `sessionNaming` is a CAPABILITY the remote UI reads before first paint, added on
          // master while this branch was open. It rides on every auth:ok this host sends.
          ws.send(JSON.stringify({ type: 'auth:ok', deviceId: paired.deviceId, secret: paired.secret, platform: 'desktop', sessionNaming: true }));
          // The restore waits for client:ready (addClient armed the old-client fallback).
        } else {
          this.recordFailedAttempt();
          ws.send(JSON.stringify({ type: 'auth:failed', reason: 'invalid-credentials' }));
          ws.close(4001, 'Auth failed');
        }
      } catch {
        ws.send(JSON.stringify({ type: 'auth:failed', reason: 'invalid-message' }));
        ws.close(4000, 'Invalid auth message');
      }
    };

    ws.on('message', authHandler);
  }

  /** Close sockets that stopped answering. Without this a half-open connection is invisible
   *  and the client waits the full 30s request timeout to learn anything is wrong.
   *  WHY armed per client (simplification audit W14): this used to start with the
   *  server and tick every 20 s with zero clients — 4,320 empty wakes a day on an
   *  idle app. addClient arms it, removeClient disarms it on the last drop, the
   *  same "nobody is listening" short-circuit broadcast() already has. */
  private startLiveness(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      for (const client of this.clients) {
        const missed = (client.missedPings ?? 0) + 1;
        if (missed > MAX_MISSED_PINGS) {
          this.logDevice(client, `no answer to ${MAX_MISSED_PINGS} checks; closing`);
          // terminate(), not close(): a phone whose network vanished never completes a closing
          // handshake, so close() waited out ws's own 30 s timer — the drop was logged, and the
          // socket freed, half a minute after it actually happened. Test doubles without
          // terminate() keep the old path.
          const socket = client.ws as WebSocket & { terminate?: () => void };
          if (typeof socket.terminate === 'function') socket.terminate();
          else socket.close(4008, 'No response');
          this.removeClient(client);
          continue;
        }
        client.missedPings = missed;
        try { client.ws.ping(); } catch { /* closing anyway */ }
      }
    }, PING_INTERVAL_MS);
  }

  private addClient(ws: WebSocket, deviceId: string, ip: string, opts: { sendsReady?: boolean } = {}): void {
    // The per-connection id stays connection-scoped; the DEVICE id is the durable one the
    // panel lists. Two id spaces, deliberately not merged.
    const client: AuthenticatedClient = {
      id: randomUUID(), ws, deviceId, ip, connectedAt: Date.now(), lastHeardAt: Date.now(),
      phase: 'restoring', queue: [], queueDegraded: false, fallbackTimer: null,
    };
    this.clients.add(client);
    this.startLiveness(); this.emitStatus(); // liveness is a no-op while already armed — see its WHY; the status carries the new clientCount
    this.logDevice(client, `connected (${opts.sendsReady ? 'page announces readiness' : 'older page'})`);
    // WHY a fallback and not an immediate replay (design §1): the restore used to start
    // the moment auth succeeded, before the page had mounted App, and guessed with a
    // 500 ms timer how long React would take. Now the client says when it is ready
    // (client:ready) and the queue holds everything until then. A client that never says
    // so — an older page — still gets the whole sequence, after this timer.
    client.fallbackTimer = setTimeout(() => {
      client.fallbackTimer = null;
      if (client.phase !== 'restoring') return;
      this.logDevice(client, 'catch-up started by the fallback timer (no client:ready)');
      void this.restoreClient(client, { reconnect: false, replayBuffers: true }).catch((err) => {
        console.error('[remote-server] restore (fallback) failed:', err);
      });
    }, opts.sendsReady ? READY_CLIENT_FALLBACK_MS : OLD_CLIENT_FALLBACK_MS);

    const drop = () => {
      if (client.fallbackTimer) { clearTimeout(client.fallbackTimer); client.fallbackTimer = null; }
      this.removeClient(client);
    };
    ws.on('pong', () => { client.missedPings = 0; client.lastHeardAt = Date.now(); });
    ws.on('message', (raw) => { client.missedPings = 0; client.lastHeardAt = Date.now(); void this.handleMessage(client, raw as Buffer | string); });
    ws.on('close', (code: number, reason: Buffer) => {
      const why = reason && reason.length ? ` (${reason.toString()})` : '';
      // Silence before the drop separates "the phone went away" from "the phone was talking
      // and the connection broke" — the two need different fixes.
      const silent = Math.round((Date.now() - (client.lastHeardAt ?? client.connectedAt)) / 1000);
      this.logDevice(client, `disconnected: code ${code}${why} after ${Math.round((Date.now() - client.connectedAt) / 1000)} s, phase ${client.phase}, silent for ${silent} s`);
      drop();
    });
    ws.on('error', (err: Error) => {
      this.logDevice(client, `socket error: ${err?.message ?? err}`);
      drop();
    });
  }

  // --- The restore sequence (design §1 B, §6) ---

  /**
   * Run the restore for one client: the session list, the snapshot, the buffer replays,
   * then everything that was broadcast meanwhile — and only then go live.
   *
   * Called from `client:ready` (the phone said it has its listeners), from the old-client
   * fallback timer, and (batch 2 §6) from `remote:rehydrate`, which skips the buffer
   * replay because the phone's terminal and cards are already in step.
   */
  private async restoreClient(
    client: AuthenticatedClient,
    opts: { seq?: number; reconnect: boolean; replayBuffers: boolean; ptyPasses?: boolean },
  ): Promise<void> {
    const ws = client.ws;
    const startedAt = Date.now();
    client.phase = 'readying';
    if (client.fallbackTimer) { clearTimeout(client.fallbackTimer); client.fallbackTimer = null; }
    client.queue ??= [];
    try {
      await this.runRestore(client, opts);
    } catch (err) {
      // Whatever failed, the client must not stay `readying` with a queue that fills
      // forever (review of T1, finding 4): flush what was held and go live; the phone's
      // strip reports an incomplete restore and offers Refresh.
      console.error('[remote-server] restore failed:', err);
      await this.flushRestoreQueue(client, { sessions: [] }, [], true).catch(() => { /* the socket is gone */ });
    } finally {
      client.phase = 'live';
      this.logDevice(client, `caught up in ${Date.now() - startedAt} ms`);
      // A Refresh that arrived while this restore ran: its seq is the one the phone is
      // waiting for, so it runs now instead of being dropped (§6).
      const next = client.pendingRehydrate;
      if (next && client.ws.readyState === WebSocket.OPEN) {
        client.pendingRehydrate = undefined;
        void this.rehydrateClient(client, next.seq).catch((err) => console.error('[remote-server] rehydrate failed:', err));
      }
    }
  }

  /** Refresh (design §6): back to restoring with a fresh queue and cut line, the
   *  snapshot, chat:hydrate { seq }, the flush — §1's sequence minus the terminal and
   *  permission replays, which a connected phone already has in step. */
  private async rehydrateClient(client: AuthenticatedClient, seq: number | undefined): Promise<void> {
    this.logDevice(client, 'catch-up started (Refresh)');
    client.phase = 'restoring';
    client.queue = [];
    client.queueDegraded = false;
    client.snapshotIndex = undefined;
    client.hookPassIndex = undefined;
    // The phone has every terminal unit up to now (it was live), so the cursor starts at the
    // buffers' current ends — but output produced DURING the Refresh is not broadcast to a
    // restoring client, so the terminal passes must still run to send it (T4 review, 2).
    client.ptyCursor = new Map([...this.ptyBuffers].map(([sid, buf]) => [sid, { epoch: buf.epoch, pos: buf.base + buf.length }]));
    await this.restoreClient(client, { seq, reconnect: true, replayBuffers: false, ptyPasses: true });
  }

  private async runRestore(
    client: AuthenticatedClient,
    opts: { seq?: number; reconnect: boolean; replayBuffers: boolean; ptyPasses?: boolean },
  ): Promise<void> {
    const ws = client.ws;
    const queue = (client.queue ??= []);
    const send = (msg: { type: string; payload: any }) => this.sendGated(client, msg);

    // Session list — sent so the client can initialize chat state. (The old
    // `session:list:response` with id `_replay` is gone; nothing ever read it.)
    const sessions = this.sessionManager.listSessions();
    for (const session of sessions) if (!(await send({ type: 'session:created', payload: session }))) return;

    // Current topic names for all mapped sessions.
    for (const [desktopId, name] of this.lastTopics) {
      if (!(await send({ type: 'session:renamed', payload: { sessionId: desktopId, name } }))) return;
    }

    // The last status payload, so a client connecting between the 10s polls renders a
    // populated status bar immediately. Same shape the poll broadcasts.
    if (this.lastStatusData && !(await send({ type: 'status:data', payload: this.lastStatusData }))) return;

    // THE CUT LINE. Everything queued before this index reaches the desktop window
    // before the export request does (same ordered IPC channel), and the exporter
    // flushes its transcript batch before serializing (RemoteSnapshotExporter.tsx) —
    // so every transcript-shaped entry below the index IS in the snapshot, and nothing
    // above it is. flushRestoreQueue skips exactly those.
    client.snapshotIndex = queue.length;
    let snapshot: SerializedChatState;
    try {
      snapshot = await this.requestSnapshot();
    } catch (err) {
      console.error('[remote-server] snapshot request failed:', err);
      snapshot = { sessions: [], degraded: true };
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    // A queue that overflowed lost events the snapshot may not hold either — the phone
    // must be told its copy may be behind (the strip offers Refresh).
    if (client.queueDegraded) snapshot = { ...snapshot, degraded: true };
    // `seq` echoes the client's request so the shim applies only the hydrate it last
    // asked for; the old-client fallback has none to echo.
    if (!(await send({ type: 'chat:hydrate', payload: opts.seq === undefined ? snapshot : { ...snapshot, seq: opts.seq } }))) return;

    // Permission asks this restore replayed, so the queue flush does not send the same
    // ask a second time when its live broadcast was also queued.
    const replayedAsks = new Set<string>();
    if (opts.replayBuffers) {
      // The terminal, from where the phone left off (§7). The final passes below, after
      // the queue, are what let the client go live with no gap.
      if (!(await this.ptyPass(client)) && ws.readyState !== WebSocket.OPEN) return;

      // Hook event buffers (also carries buffered NATIVE hook events — see
      // bufferHookEvent's own comment). Only unresolved asks are here: the broker and
      // the relay both emit PermissionResolved when an ask closes, and bufferHookEvent
      // purges on it. On a first connect, a live hook event that arrived before this
      // pass is already reflected here, so the flush skips those (hookPassIndex); from
      // this point on they are queued and flushed.
      client.hookPassIndex = queue.length;
      // A copy taken at the same instant as hookPassIndex: an event added while this
      // pass is paused is in the queue (flushed later), and must not ALSO be picked up
      // by the pass walking the live array — it went out twice (T2 review, 9).
      const hookPass = [...this.hookBuffers].map(([sid, events]) => [sid, events.slice()] as const);
      for (const [_sessionId, events] of hookPass) {
        for (const event of events) {
          const requestId = (event.payload as Record<string, unknown> | undefined)?._requestId;
          if (event.type === 'PermissionRequest' && typeof requestId === 'string') replayedAsks.add(requestId);
          if (!(await send({ type: 'hook:event', payload: event }))) return;
        }
      }
      // Consent does not lie (§7): for EVERY session, which asks are still open. The
      // phone clears any awaiting card not named — it was answered while it was away —
      // with a neutral note, never a failure.
      for (const session of sessions) {
        const fromBuffer = (this.hookBuffers.get(session.id) ?? [])
          .filter((e) => e.type === 'PermissionRequest')
          .map((e) => (e.payload as Record<string, unknown> | undefined)?._requestId)
          .filter((id): id is string => typeof id === 'string');
        // Plus what the snapshot shows awaiting (T2 review, 6): an ask raised before
        // remote access was switched on, or trimmed from the buffer, is open on the
        // desktop and must not be cleared on the phone.
        // Minus any ask whose resolution or expiry is already waiting in the queue: the
        // snapshot was taken before it closed (T2 re-review, 1).
        const closedInQueue = new Set(queue
          .filter((m) => m.type === 'hook:event' && (m.payload?.type === 'PermissionResolved' || m.payload?.type === 'PermissionExpired'))
          .map((m) => m.payload?.payload?._requestId));
        const pendingRequestIds = [...new Set([...fromBuffer, ...RemoteServer.awaitingInSnapshot(snapshot, session.id)])]
          .filter((rid) => !closedInQueue.has(rid));
        if (!(await send({ type: 'hook:replay-complete', payload: { sessionId: session.id, pendingRequestIds } }))) return;
      }

      // Task 9 (plan 1c): latest specialist run per helper, so a reconnecting client's
      // card comes back with a status instead of blank.
      for (const [_sessionId, byChild] of this.specialistRunBuffers) {
        for (const event of byChild.values()) if (!(await send({ type: 'specialists:event', payload: event }))) return;
      }
      // G-1: latest shell run per command, same position as the specialist replay.
      for (const [_sessionId, byShell] of this.shellRunBuffers) {
        for (const event of byShell.values()) if (!(await send({ type: 'native:shell-event', payload: event }))) return;
      }
    }

    // The queue, then whatever was queued while the flush itself was paused, until
    // nothing is left; only the first round has entries below the cut line.
    //
    // Queue and terminal passes ALTERNATE until a round finds neither (T2 review, 3): a
    // terminal pass can pause on backpressure, and anything broadcast meanwhile lands in
    // the queue — flushing the queue only once, before the passes, lost it when the
    // client went live. Live only after a round that found nothing new (§7). A pass or
    // flush that sends nothing awaits nothing, so no broadcast can land between the last
    // check and the phase change (broadcasts arrive on the event loop, never as a
    // microtask).
    let firstRound = true;
    for (;;) {
      while (queue.length > 0) {
        if (!(await this.flushRestoreQueue(client, snapshot, sessions.map((s) => s.id), opts.reconnect, replayedAsks, firstRound))) return;
        firstRound = false;
      }
      // Entries queued from here on are all above the cut line.
      firstRound = false;
      if (!opts.replayBuffers && !opts.ptyPasses) break;
      const sent = await this.ptyPass(client);
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!sent && queue.length === 0) break;
    }
  }

  /** Transcript-shaped broadcasts: in the snapshot when queued below the cut line. The
   *  uuid dedup in the reducer does not cover the native harness's per-delta text, so
   *  these must not be replayed on top of a snapshot that already holds them. */
  private static isTranscriptShaped(type: string): boolean {
    // native:permission-mode is excluded because the chip's mode is App state,
    // not chat state — the snapshot never holds it, so skipping it here would
    // leave a reconnecting phone's chip on a stale mode.
    return type === 'transcript:event' || type === 'transcript:shrink'
      || (type.startsWith('native:') && type !== 'native:shell-event' && type !== 'native:permission-mode');
  }

  /**
   * Send what was broadcast while the client was restoring, in arrival order, minus what
   * the snapshot already holds. Lifecycle entries (session:*, status:data, hook:event,
   * specialists:event, native:shell-event) are flushed from the whole window. For a
   * session the snapshot OMITTED (a window that did not answer, §2) nothing is skipped:
   * the client's copy is its own, and lacks them.
   */
  private async flushRestoreQueue(
    client: AuthenticatedClient,
    snapshot: SerializedChatState,
    knownSessionIds: string[],
    reconnect: boolean,
    replayedAsks: ReadonlySet<string> = new Set(),
    firstRound = true,
  ): Promise<boolean> {
    // Take the round's entries out; anything broadcast while a send below is paused
    // lands in the fresh array the caller loops back for.
    const queue = (client.queue ?? []).splice(0);
    const cutLine = firstRound ? (client.snapshotIndex ?? 0) : 0;
    const hookPass = firstRound ? client.hookPassIndex : undefined;
    const held = new Set(snapshot.sessions.map(([id]) => id));
    void knownSessionIds; // a session the list has and the snapshot lacks is simply not in `held`
    // Design test 7, "shows no card after the flush": an ask whose resolution is LATER in
    // this same round was raised and answered while the client was restoring. Flushing
    // the request would draw a card only to clear it. The resolution is still flushed —
    // a card the snapshot did hold needs it, and it is a no-op otherwise.
    const resolvedAt = new Map<string, number>();
    queue.forEach((m, idx) => {
      const rid = m.payload?.payload?._requestId;
      if (m.type === 'hook:event' && m.payload?.type === 'PermissionResolved' && typeof rid === 'string') resolvedAt.set(rid, idx);
    });
    for (let i = 0; i < queue.length; i++) {
      const msg = queue[i];
      if (i < cutLine && RemoteServer.isTranscriptShaped(msg.type)) {
        const sid = msg.payload?.sessionId;
        if (typeof sid === 'string' && held.has(sid)) continue;
      }
      if (msg.type === 'hook:event') {
        // First connect only: a hook event that arrived before the hook buffer pass is
        // already reflected by the pass (a resolved ask is purged from the buffer; an
        // open one is in it). A reconnecting phone keeps its cards, so it needs every
        // one — except an ask this restore's pass already replayed.
        // Never a resolution or an expiry (T2 re-review, 1): the snapshot can still show an
        // ask that closed while it was being taken, and dropping the closure left live
        // buttons for a dead question. Both are idempotent on a card that is not awaiting.
        const closes = msg.payload?.type === 'PermissionResolved' || msg.payload?.type === 'PermissionExpired';
        if (!reconnect && hookPass !== undefined && i < hookPass && !closes) continue;
        const requestId = msg.payload?.payload?._requestId;
        if (msg.payload?.type === 'PermissionRequest' && typeof requestId === 'string' && replayedAsks.has(requestId)) continue;
        const asks = msg.payload?.type === 'PermissionRequest';
        if (asks && typeof requestId === 'string' && (resolvedAt.get(requestId) ?? -1) > i) continue;
      }
      if (!(await this.sendGated(client, msg))) return false;
    }
    return true;
  }

  // --- Message routing ---

  private async handleMessage(client: AuthenticatedClient, raw: Buffer | string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Presence-activity stamp (see getLastClientActivityMs). Any parsed frame
    // counts: a remote user's typing arrives as pty:input / chat sends, and
    // even passive viewing produces periodic client messages.
    this.lastClientActivityMs = Date.now();

    const { type, id, payload } = msg;

    // WHY (2026-09-29 one-core R2, filled by R3): the channel table is consulted BEFORE the switch, so
    // a moved family's entry (and its policy: desktop-only, refused, soft failure answer) applies to
    // the phone from one place. A `case` left behind for a table name would be dead code.
    const tableDef = findChannel(type);
    if (tableDef) {
      const outcome = await serveRemoteChannel(tableDef, payload, {
        door: 'remote', runtime: this.nativeRuntime, deviceId: client.deviceId, clientId: client.id,
        isConnected: () => client.ws.readyState === WebSocket.OPEN,
        // WHY (2026-09-30 one-core R3-7): what only this phone's socket holds, for the file channels — which folders
        // a phone may see, its own watcher id (dropped when its socket closes), and its download links.
        remote: {
          sessionRoots: () => this.sessionRoots(),
          watchSubscriberId: () => this.watchSubscriberId(client),
          currentWatchId: () => client.watchId,
          get watchedRoots() { return (client.watchedRoots ??= new Set<string>()); },
          mintDownload: (request) => this.downloads.mint(request as any, { deviceId: client.deviceId, socketId: client.id }),
          // WHY (2026-10-01 one-core R3-8): the document-comment watcher id (its own refcount map), the relay to the
          // other phones (a theme or screen change made on this phone), and a push to this computer's windows.
          docCommentsSubscriberId: () => this.docCommentsSubscriberId(client),
          currentDocCommentsId: () => client.docCommentsWatchId,
          relayToOthers: (message, opts) => {
            const data = JSON.stringify(message);
            for (const c of this.clients) {
              if (c === client) continue;
              if (opts?.queueWhileRestoring && c.phase && c.phase !== 'live') { this.enqueueForRestoring(c, message); continue; }
              if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
            }
          },
          sendToWindows: (channel, payload) => this.broadcastToWindows(channel, payload),
          host: { config: this.config, getClientCount: () => this.getClientCount(), getClientList: () => this.getClientList(), getStatus: () => this.getStatus(), getDeviceList: () => this.getDeviceList() },
        },
        // Every screen: all phones (the sender included), then this computer's windows.
        broadcast: (channel, data) => {
          this.broadcast({ type: channel, payload: data });
          this.broadcastToWindows(channel, data);
        },
      });
      // Only an awaited request (it has an id) is answered.
      if (outcome.reply && id) this.respond(client.ws, type, id, outcome.payload);
      return;
    }

    switch (type) {
      // --- Readiness (design §1 A) ---
      case 'client:ready': {
        // Push, no reply. Only a restoring client can start the sequence: a second
        // client:ready (an effect re-run on the phone) while readying is ignored, and so is
        // one after the old-client fallback already ran or the client went live (R2-7,
        // R3-4). Awaited so a test can observe the whole sequence; messages are handled
        // concurrently anyway (`void this.handleMessage` per frame).
        if (client.phase !== 'restoring') {
          console.log('[remote-server] client:ready ignored in phase', client.phase);
          break;
        }
        const seq = typeof payload?.seq === 'number' ? payload.seq : undefined;
        this.logDevice(client, 'catch-up started (page ready)');
        client.ptyOffsets = payload?.ptyOffsets && typeof payload.ptyOffsets === 'object' ? payload.ptyOffsets : {};
        client.ptyCursor = new Map();
        await this.restoreClient(client, { seq, reconnect: payload?.reconnect === true, replayBuffers: true });
        break;
      }
      case 'remote:ping':
        // The phone's wake check (remote-shim checkConnectionAfterWake): any answer proves the
        // connection is alive. Answered at once and in every phase — a phone that is catching
        // up is exactly the one most likely to be asking.
        this.respond(client.ws, type, id, { ok: true });
        break;
      case 'remote:rehydrate': {
        // Answered at once — the phone follows the result through chat:hydrate and its
        // strip, not through this reply. Mid-restore, the Refresh runs right after.
        const seq = typeof payload?.seq === 'number' ? payload.seq : undefined;
        this.respond(client.ws, type, id, { ok: true });
        if (client.phase && client.phase !== 'live') {
          client.pendingRehydrate = { seq };
          break;
        }
        await this.rehydrateClient(client, seq);
        break;
      }
      // --- Request/response ---
      // WHY (2026-09-30 one-core R3-6): handoff:*, native:*, permission(s):*, specialists:*, model:*, provider:*,
      // chatgpt:*, openrouter:*, claude-code:*, search:*, engine:*, models:* and endpoints:detect are table entries
      // (the files in main/ipc); the table answers before this switch, so none of them has a case here.
      // WHY (2026-09-30 one-core R3-7): the pages:* channels are table entries (main/ipc/pages.ts); the table answers
      // before this switch, so none has a case here. pages:approve's "no keys from a phone" rule is the entry's
      // `ctx.door === 'remote'`.
      // WHY (2026-10-01 one-core R3-8): the docComments:* channels are table entries (main/ipc/doc-comments.ts); the table
      // answers before this switch, so none has a case here. Their `projectRoot` gate (the F1 fix) is the same
      // shared check on both doors, fed this class's sessionRoots() through ctx.remote.
      // WHY (2026-09-30 one-core R3-7): fs:read-head, file:upload and get-home-path are table entries (main/ipc/files.ts).
      // Read-only lists a phone's screens load at start. Each was "unhandled channel" in the
      // 2026-09-11 phone pass log and its screen fell back to empty. The same functions the
      // desktop handlers call, so the two cannot drift; a failure is answered as a failure
      // (REJECT_ON_NOT_OK in the shim), never as an empty list.
      // WHY (2026-10-01 one-core R3-8): theme:*, appearance:*, favorites:*, game:*, arcade:*, commands:list, platform:get, ui:action,
      // zoom:* and the remote:* administration channels are table entries (main/ipc/appearance.ts, game.ts, ui.ts, window.ts,
      // remote-admin.ts); the table answers before this switch, so none has a case here. The refusals a phone gets for
      // set-password, set-config, devices:rename and devices:unpair are declared on those entries (HOST_ADMIN_REFUSAL), and
      // remote:disconnect-client still has no entry or case on purpose, so it falls to `default:` below.
      case 'remote:request-outcome': {
        const ids: string[] = Array.isArray(payload?.ids) ? payload.ids : [];
        const outcomes: Record<string, 'completed' | 'unknown'> = {};
        for (const requestId of ids.slice(0, 200)) {
          // WHY the caller's own device id is checked: a request id carries the device
          // that made it, and without this any paired device could ask about any other
          // device's requests. Nothing secret comes back, but "did that phone's action
          // run?" is not this phone's business, and the id was already there to check.
          outcomes[requestId] = requestId.split(':')[0] === client.deviceId
            ? this.outcomeOf(requestId)
            : 'unknown';
        }
        this.respond(client.ws, type, id, { outcomes });
        break;
      }
      default: {
        // WHY this exists: the switch had no default, so any channel the remote
        // server doesn't implement was silently dropped. The shim registers a
        // pending promise with a 30s timer (remote-shim.ts invoke()), so an
        // unimplemented channel presented as a 30-SECOND HANG followed by a
        // rejection with no indication of which side failed — which is how
        // Project View and the game lobby looked merely "broken" rather than
        // unimplemented. Respond immediately and name the channel instead.
        //
        // Fire-and-forget message types legitimately have no id; only answer
        // when the client is actually awaiting something.
        if (id) {
          // Warn ONCE per channel. useAttentionClassifier polls the unbridged
          // `terminal:get-screen-text` every second, so an unconditional warn
          // wrote a line per second for the life of the connection — drowning
          // the log and, because stdout writes can throw, multiplying the odds
          // of hitting the EPIPE crash guarded in main.ts.
          //
          // Deduped by channel (not by client) deliberately: the point is to
          // tell a developer which channels are missing, and that set does not
          // change when another phone connects. Mirrors the shim's
          // feature-level dedup in remote-unsupported.ts.
          if (!this.warnedChannels.has(type)) {
            this.warnedChannels.add(type);
            console.warn(`[RemoteServer] unhandled channel: ${type}`);
          }
          this.respond(client.ws, type, id, {
            ok: false,
            error: `This feature isn't available over remote access yet (${type}).`,
            unsupported: true,
          });
        }
        break;
      }
    }
  }

  // --- Files over remote (batch 3) ---

  /** The working folders of every open session. WHY it stays here (2026-09-30 one-core R3-7): the file
   *  channels' folder gates (main/ipc/file-gates.ts) reach it through the phone's ctx.remote, and the
   *  document-comment cases below still use it directly. */
  private sessionRoots(): string[] {
    return this.sessionManager.listSessions().map((s: any) => s?.cwd).filter((c: unknown): c is string => typeof c === 'string' && c.length > 0);
  }

  // Negative and descending: never a webContents id (those are positive).
  private nextWatchId = -1;

  // Download links (§10). The revocation check reads the device store lazily,
  // at each GET, so a device unpaired while its link was alive is refused.
  readonly downloads = new RemoteDownloads({
    isDeviceRevoked: (deviceId) => this.devices.isRevoked(deviceId),
  });

  /** This socket's project-watcher subscriber id, allocated on first use and released on close. */
  private watchSubscriberId(client: AuthenticatedClient): number {
    if (client.watchId === undefined) {
      const watchId = this.nextWatchId--;
      client.watchId = watchId;
      // A phone that vanishes never sends unwatch — same as a crashed renderer,
      // which the desktop handles with webContents 'destroyed'. Guarded because
      // tests drive handleMessage with a bare `{ ws }`.
      if (typeof (client.ws as any).once === 'function') {
        client.ws.once('close', () => dropSubscriber(watchId));
      }
    }
    return client.watchId;
  }

  /** Same shape as watchSubscriberId above, for doc-comments-watcher.ts's
   *  OWN, separate refcount map (T3) — arms its own 'close' cleanup rather
   *  than reusing watchSubscriberId's, since that one only wires
   *  project-watcher's dropSubscriber and a docComments-only client (no
   *  artifacts:watch-project call) would otherwise leak its watcher forever. */
  private docCommentsSubscriberId(client: AuthenticatedClient): number {
    if (client.docCommentsWatchId === undefined) {
      const watchId = this.nextWatchId--;
      client.docCommentsWatchId = watchId;
      if (typeof (client.ws as any).once === 'function') {
        client.ws.once('close', () => dropDocCommentsSubscriber(watchId));
      }
    }
    return client.docCommentsWatchId;
  }

  // --- Helpers ---

  private respond(ws: WebSocket, type: string, id: string, payload: any): void {
    this.noteCompleted(id);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: `${type}:response`, id, payload }));
    }
  }

  /** Request ids are `<deviceId>:<generation>:<n>`, so the device is the ring's key. */
  private noteCompleted(id: string): void {
    const deviceId = id.split(':')[0];
    if (!deviceId) return;
    const now = Date.now();
    const ring = this.completedRequests.get(deviceId) ?? [];
    ring.push({ id, at: now });
    const cutoff = now - COMPLETED_RING_MS;
    let trimmed = ring.filter(e => e.at >= cutoff);
    if (trimmed.length > COMPLETED_RING_PER_DEVICE) trimmed = trimmed.slice(-COMPLETED_RING_PER_DEVICE);
    this.completedRequests.set(deviceId, trimmed);
  }

  /** 'completed' only when we can still see it. Anything else is 'unknown', deliberately. */
  private outcomeOf(id: string): 'completed' | 'unknown' {
    const deviceId = id.split(':')[0];
    const ring = this.completedRequests.get(deviceId);
    if (!ring) return 'unknown';
    const cutoff = Date.now() - COMPLETED_RING_MS;
    return ring.some(e => e.id === id && e.at >= cutoff) ? 'completed' : 'unknown';
  }

  broadcast(msg: { type: string; payload: any }): void {
    // Perf: with nobody connected there is no one to send to, so skip the
    // JSON.stringify as well. This matters because broadcast() runs on EVERY PTY
    // chunk and the remote server is always on — a user who never opens remote
    // access was still paying to serialize every byte their terminal printed.
    // Safe to short-circuit: the loop below is the only thing this method does, and
    // its sole effect is writing to connected client sockets — nothing in the app
    // observes broadcast() as a side effect (`this.clients` is the same set
    // getClientCount() reports, and it is empty here).
    if (this.clients.size === 0) return;
    let data: string | null = null;
    for (const client of this.clients) {
      // A client that is not live yet gets this after its restore (design §1 B) — except
      // pty:output, which the PTY buffer replay covers up to the moment it goes live.
      if (client.phase && client.phase !== 'live') {
        this.enqueueForRestoring(client, msg);
        continue;
      }
      if (client.ws.readyState === WebSocket.OPEN) {
        // A live client that has stopped reading gets closed rather than buffered
        // without bound (§7); the shim reconnects and the strip says so.
        if (client.ws.bufferedAmount > BACKPRESSURE_CLOSE_BYTES) {
          this.logDevice(client, 'not reading fast enough; closing');
          client.ws.close(CLOSE_TOO_SLOW, 'Too slow');
          continue;
        }
        data ??= JSON.stringify(msg);
        client.ws.send(data);
      }
    }
  }

  private enqueueForRestoring(client: AuthenticatedClient, msg: { type: string; payload: any }): void {
    if (msg.type === 'pty:output') return;
    const queue = (client.queue ??= []);
    queue.push(msg);
    if (queue.length > RESTORE_QUEUE_MAX) {
      queue.shift();
      client.queueDegraded = true;
      // The cut line and the hook-pass mark index into this queue; both move with it.
      if (client.snapshotIndex !== undefined && client.snapshotIndex > 0) client.snapshotIndex--;
      if (client.hookPassIndex !== undefined && client.hookPassIndex > 0) client.hookPassIndex--;
    }
  }

  // --- Rate limiting ---

  /** Whether a new connection should be answered slowly, because the host is seeing a
   *  burst of failed attempts. Slowing beats refusing: the owner is locked out far more
   *  often than the attacker is stopped. (This returned a boolean while being named and
   *  documented as milliseconds; the caller applied the delay. Renamed to what it is.) */
  private shouldSlowConnection(): boolean {
    if (Date.now() > this.hostFailures.resetAt) {
      this.hostFailures = { count: 0, resetAt: 0 };
      return false;
    }
    return this.hostFailures.count >= HOST_FAILURES_BEFORE_SLOWDOWN;
  }

  private recordFailedAttempt(): void {
    if (Date.now() > this.hostFailures.resetAt) {
      this.hostFailures = { count: 1, resetAt: Date.now() + RATE_LIMIT_WINDOW_MS };
    } else {
      this.hostFailures.count++;
    }
  }

  private clearFailedAttempts(): void {
    this.hostFailures = { count: 0, resetAt: 0 };
  }
}

