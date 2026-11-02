import http from 'http';
// A phone's project watcher is dropped when its socket closes (the file channels themselves are table entries).
import { dropSubscriber } from './artifacts/project-watcher';
import { RemoteDownloads } from './remote-download';
// Games arcade scores — remote browsers share the desktop's operations and
// its stale-board cache (main/arcade-handlers.ts).
import { dropDocCommentsSubscriber } from './doc-comments/doc-comments-watcher';
import { staticAssetPolicy } from './remote-static-policy';
import { CompressedAssets } from './remote-asset-compression';
import fs from 'fs';
import path from 'path';
import { sweepOldUploads } from './upload-store';
import { randomUUID } from 'crypto';
import { proxyHttpToVite, proxyUpgradesToVite } from './remote-dev-proxy';
import { describePhoneTimings, describeAnswer } from './remote-timings';
import { localTokenMatches, ownerDesktopServices, type LocalModeOptions } from './remote-local';
import { WebSocketServer, WebSocket } from 'ws';
import { isAllowedWsOrigin } from './remote-origin';
import { readFirstFrames, TOOK_FRAMES_PROTOCOL } from '../shared/first-frames';
import type { SessionManager } from './session-manager';
import type { createHandoffTransport } from './conversations/handoff-transport';
import type { HookRelay } from './hook-relay';
import type { RemoteConfig } from './remote-config';
import { RemoteConfig as RemoteConfigStatics } from './remote-config';
import { RemoteDeviceStore, type RemoteDeviceView } from './remote-devices';
import type { LocalSkillProvider } from './skill-provider';
import { VITE_DEV_PORT } from '../shared/ports';
import { ANDROID_LOCAL_CAPABILITIES, PROTOCOL_VERSION, REMOTE_SCREEN_CAPABILITIES } from '../shared/capabilities';
import { isOldFillClient, CLOSE_OLD_CLIENT, OLD_APP_REASON, REFRESH_NOTICE } from '../shared/fill-protocol';
import { createSessionChatState, serializeChatState } from '../renderer/state/chat-types';
import type { NativeSendResult } from '../shared/types';
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
import { getPagesService } from './pages/pages-service';
import { clientOwnerKey, sendToClient } from './pages/page-owner';
import { sendToAllWindows } from './window-broadcast';
import { toListResult } from './harness/specialists/catalog';
import { BrowserWindow, app } from 'electron';
import { NativeHome } from './native-home';
import { UpdateSettings } from './update-settings';
import { resolveStaticFile } from './remote-static-path';
import { log } from './logger';
import { CLOSE_REPLACED, CLOSE_DEVICE_EXPIRED, DEVICE_EXPIRY_DAYS } from '../shared/remote-close-codes';
import { AuthThrottle, VerificationQueue } from './remote-auth-throttle';

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
// Backpressure (remote access batch 2, design §7): ws.send never blocks, so a stalled phone grew the host's socket buffer
// until the liveness ping closed it. A LIVE client holding more than this is closed with a code the strip renders as
// reconnecting. (The pause-and-poll gate the restore sequence used is gone with the restore: nothing sends in bulk now.)
const BACKPRESSURE_CLOSE_BYTES = 32 * 1024 * 1024;
const CLOSE_TOO_SLOW = 4009;
// WHY (2026-10-22 phone reliability, cause 5): a phone counts only a COMPLETE frame as a sign of life, so one multi-MB answer (a
// conversation load: history, recent tail and terminal) over a slow relay looked like a dead computer for as long as it took to
// arrive — the phone gave up after ~20 s, reconnected and asked for the same load again, forever. Sent as pieces of this size,
// every piece is a sign of life. 256K characters is ~60–90 KB on the wire after compression: well under a second on any link
// that can carry a conversation at all, while a load stays a handful of frames.
const PIECE_CHARS = 256 * 1024;
/** How often to look for Tailscale again while it is installed but not connected. One `tailscale status`, off the main thread. */
const TAILSCALE_RETRY_MS = 20_000;

interface AuthenticatedClient {
  id: string;
  /** The device's own app, signed in with the local token: this backend's owner (remote-local.ts). */
  owner?: boolean;
  ws: WebSocket;
  deviceId: string;
  ip: string;
  connectedAt: number;
  /** Checks sent since the client last said anything. Reset by any frame, pong or message. */
  missedPings?: number;
  /** When the client last said anything — reported on the drop, so a silent death is visible. */
  lastHeardAt?: number;
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
  /** This phone's id in the window registry (one-core R5-1): negative, from the same counter as the two
   *  watch ids above so no two audience members share one. Set when the client joins, never reassigned. */
  audienceId?: number;
  /** The hello (session list, topics, status) has been sent on this connection. */
  helloSent?: boolean;
  /** The page refills one conversation on a `session:refill` push, so an expired fill hold need not hang up on it. */
  refillPush?: boolean;
  /** The page puts a large answer back together from `remote:piece` frames (sendAnswer). */
  pieces?: boolean;
}

/** The slice of WindowRegistry a phone connection needs: join on connect, leave on drop. */
export interface SocketAudience {
  registerSocket(id: number): void;
  unregisterSocket(id: number): void;
  /** Phones watching a session (per-session delivery, one-core R5-3). Optional so a test double need not model it: absent = every phone. */
  getSocketWatchers?(sessionId: string): number[];
  /** Phones to send terminal frames to: watchers plus terminal-only subscribers (sync-fix2). */
  getPtyWatchers?(sessionId: string): number[];
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

/** The handshake a signed-in screen receives. WHY (one-core R4-1, S7): `protocolVersion` and `capabilities` tell the screen what it
 *  may do (shared/capabilities.ts); `sessionNaming` is the older single capability the UI reads before first paint. */
export function authOkMessage(who: { deviceId: string; secret?: string }, focusSessionId: string | null = null, local = false) {
  return {
    type: 'auth:ok' as const,
    deviceId: who.deviceId,
    ...(who.secret !== undefined ? { secret: who.secret } : {}),
    platform: 'desktop' as const,
    sessionNaming: true,
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      ...(local ? ANDROID_LOCAL_CAPABILITIES : REMOTE_SCREEN_CAPABILITIES),
      sessionRecord: true,
      nativeSessions: process.env.YOUCODED_NATIVE !== '0',
      // WHY: account visibility belongs to the host, not the transport. The local
      // Android owner can sign in; a visiting client still sees status and guidance.
      chatgptAccount: process.env.YOUCODED_CHATGPT !== '0',
    },
    // The session the computer is showing, so a phone with no place of its own opens it (batch 2 §3). It used to ride the snapshot.
    focus: { sessionId: focusSessionId },
    // Requests sent right behind the sign-in are held and answered after it (handleConnection), so a page may stop waiting a round trip.
    pipelined: true,
  };
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
  private lastUsedRefreshAt = Date.now();
  // Sockets that have connected but not yet authenticated. Bounded by
  // MAX_UNAUTH_SOCKETS so a flood of half-open pre-auth sockets can't exhaust
  // memory (2026-09-10 security review, #5).
  private unauthSockets = 0;
  private lastClientActivityMs = 0; // see getLastClientActivityMs()
  private devices: RemoteDeviceStore;
  /** The page's files, compressed once each (remote-asset-compression.ts). */
  private assets = new CompressedAssets();
  /** Messages a socket's opening request carried (handleProtocols), handed to its sign-in once the connection exists. */
  private firstFrames = new WeakMap<http.IncomingMessage, string[]>();
  // Channels already warned about, so an unbridged channel that a client polls
  // logs once instead of every second. See the `default:` case in handleMessage.
  private warnedChannels = new Set<string>();
  // statusInterval removed — status data now fed by ipc-handlers.ts via broadcastStatusData()
  // Host-wide failure count, for the slowdown. Per-socket attempts live on the socket.
  private hostFailures = { count: 0, resetAt: 0 };
  // WHY (security audit RA-1): lockouts per source address and host-wide, plus one-at-a-time password
  // checks. See remote-auth-throttle.ts. Paired devices' saved keys are checked before any of this.
  private authThrottle = new AuthThrottle();
  private verifyQueue = new VerificationQueue();
  private statusListeners = new Set<(status: RemoteStatus) => void>();
  /**
   * Ids of requests this host finished, per device, so a client that lost the reply can ask
   * whether its action ran. Bounded and in memory only: after a restart the honest answer
   * is "unknown", and the milestone names host restart as a case the UI must handle.
   */
  private completedRequests = new Map<string, { id: string; at: number }[]>();
  /** The OS reason the last start() failed, so the panel can say it rather than guess. */
  private lastStartError: string | null = null;
  /** The next look for Tailscale while it is installed but not yet connected (waitForTailscale). */
  private tailscaleWait: ReturnType<typeof setTimeout> | null = null;
  /** The tailnet address to bind to. Null means Tailscale is not up, and start() refuses
   *  rather than falling back to every interface — that fallback IS the open listener. */
  private bindAddress: string | null = null;
  // Last-known topic names, fed by ipc-handlers.ts via setLastTopic()
  private lastTopics = new Map<string, string>();
  // Last-known FULL status payload, fed by ipc-handlers.ts via broadcastStatusData(),
  // sent to each new client in sendHello(). Was previously `contextMap` — only
  // the context-% slice was stored, and nothing ever read it, so a remote client that
  // connected between polls showed a blank status bar for up to 10s (the ipc-handlers
  // status interval). Storing the whole payload fixes that for every status field
  // (usage, gitBranch, sessionStats, attention, sync) instead of just context %.
  private lastStatusData: Record<string, any> | null = null;
  // WHY (2026-09-29 one-core R1): the SAME runtime the desktop door uses, from createRuntime() in
  // main.ts (was pushed in by ipc-handlers via a setter). Read-only accessor because this server
  // is built at module load and started BEFORE createWindow builds the runtime; no message can
  // arrive in between (no await). Null answers the native:*/provider:* cases' no-runtime fallbacks.
  // permissionStore is for permissions:list only; revokes go through nativeHost.
  private getNativeRuntime: () => RemoteNativeRuntime | null = () => null;
  private get nativeRuntime(): RemoteNativeRuntime | null { return this.getNativeRuntime(); }
  constructor(
    private sessionManager: SessionManager,
    // WHY unused now (one-core R5-2): this class listened to the hook relay to buffer and broadcast Claude Code's hook events. They
    // are published from main.ts (publish.ts) so the record sees them whether or not remote access is on. Kept so every caller's
    // argument order holds.
    _hookRelay: HookRelay,
    private config: RemoteConfig,
    // WHY unused now (2026-10-01 one-core R3-8): the favourite-themes read was this class's last use of the skill provider; it is a
    // table entry (main/ipc/appearance.ts) that reaches the config store through a bind. Kept so every caller's argument order holds.
    _skillProvider?: LocalSkillProvider,
    opts?: {
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
      /** WHY (2026-10-01 one-core R5-1, seam S6): phones are members of the same registry as windows, so
       *  "who wants this session" is one list. Absent in tests that do not model one. */
      audience?: SocketAudience;
      /** Local mode, for the Android app's own backend: see remote-local.ts. */
      local?: LocalModeOptions;
    },
  ) {
    this.local = opts?.local ?? null;
    this.audience = opts?.audience ?? null;
    this.devices = new RemoteDeviceStore();
    this.devices.expireStale(); // 90 days unused = signed out; checked here at startup and again on every connect
    this.getFocusSessionId = opts?.getFocusSessionId ?? (() => null);
    this.serveBuiltPage = opts?.serveBuiltPage ?? true;
    if (opts?.getNativeRuntime) this.getNativeRuntime = opts.getNativeRuntime;
    this.broadcastToWindows = opts?.broadcastToWindows ?? sendToAllWindows;
  }
  private broadcastToWindows: (channel: string, payload: unknown) => void;
  private local: LocalModeOptions | null = null;
  private audience: SocketAudience | null;
  private serveBuiltPage: boolean;
  private handoffRoute?: ReturnType<typeof createHandoffTransport>;
  /** WHY: remote requests share the exact Electron backend; no connection may supply another owner's identity. */
  setHandoffRoute(route: ReturnType<typeof createHandoffTransport>): void { this.handoffRoute = route; }

  /** One line per connection event in the host's log. WHY (2026-09-11 phone pass): an empty
   *  project list and a flashing password screen could not be traced, because the host recorded
   *  no connects, drops or catch-ups. A short device id only: never a secret, address or name. */
  private logDevice(client: { deviceId: string; owner?: boolean }, event: string): void {
    // WHY the time (2026-09-11): the log recorded seven drops in ten minutes with no way to
    // tell which were the phone being locked or refreshed and which happened on their own.
    console.log(`[remote-server] ${new Date().toISOString()} device ${client.deviceId.slice(0, 8)}: ${event}`);
    // WHY also desktop.log (2026-10-22 phone reliability): console.log never reaches a built app's
    // log file, so a packaged laptop recorded nothing about the phone's drops and none could be counted.
    log('INFO', 'Remote', event, { device: client.deviceId.slice(0, 8), ...(client.owner ? { local: true } : {}) });
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

  /** A start in progress: every other caller joins it (start). */
  private starting: Promise<void> | null = null;

  /** WHY one start at a time (branch review F2): `running` turns true only once the port is bound, after the Tailscale check, and
   *  the 20 s Tailscale retry, the wake handler and the settings switch can all call this. Two overlapping starts bound twice: the
   *  loser's rollback tore down the winner's server, or both subscribed and a phone got every terminal chunk twice. */
  start(): Promise<void> {
    this.starting ??= this.startOnce().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async startOnce(): Promise<void> {
    if (this.local) {
      if (this.running) return;
      this.bindAddress = '127.0.0.1'; this.serveBuiltPage = true; // loopback; a phone has no dev server
      return this.listen(this.local.port, undefined); // the app's page connects with no path
    }
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
      // WHY (2026-10-22 phone reliability): the app often opens at login before Tailscale has
      // connected, and this ran once — so remote access stayed off all day while the switch read
      // on. Installed-but-not-connected fixes itself, so look again until it does. Not installed
      // does not, and the setup flow starts the server itself once it is.
      if (ts.installed) this.waitForTailscale();
      throw new Error(this.lastStartError);
    }
    this.clearTailscaleWait();
    this.bindAddress = ts.ip;
    return this.listen(this.config.port, '/ws');
  }

  private listen(port: number, wsPath: string | undefined): Promise<void> {
    // Subscribe to the events this server relays itself (terminal bytes, session create/exit). Session-scoped pushes reach a phone
    // through publish (publish.ts).
    this.sessionManager.on('pty-output', this.onPtyOutput);
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
        proxyHttpToVite(req, res, viteDevUrl);
      }
    });

    // Security: limit message size to 50MB to prevent memory exhaustion attacks.
    // verifyClient (2026-09-10 security review, #5): reject a cross-origin upgrade
    // before the socket opens, so a web page the user has open elsewhere cannot
    // hijack this WebSocket (CSWSH). See remote-origin.ts for the rule.
    this.wss = new WebSocketServer({
      server: this.httpServer,
      path: wsPath,
      maxPayload: 52428800,
      // WHY (2026-10-22 phone reliability): a phone's conversation load is plain JSON — up to ~2 MB of history plus the terminal —
      // over a Tailscale relay measured at 75–100 ms. On Destin's own transcripts level 1 shrank text 3–4.5× for ~6–10 ms per 2 MB,
      // run on zlib's thread pool, not the main thread (pictures do not shrink, and cost little). Small frames are left alone. No
      // context kept between messages: a few hundred KB less per phone for a slightly lower ratio. Not on the Android app's own
      // loopback backend, where nothing crosses a network and the phone's CPU would pay for nothing.
      perMessageDeflate: this.local ? false : {
        zlibDeflateOptions: { level: 1 },
        threshold: 1024,
        serverNoContextTakeover: true,
        clientNoContextTakeover: true,
      },
      // A phone's sign-in and first requests can ride in the opening request (shared/first-frames.ts): taken here, answered with
      // the "connected". Anything else offered is answered as ws would by default (the first name), so an old page is unaffected.
      handleProtocols: (offered, req) => this.pickProtocol(offered, req),
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

    // Dev mode: proxy WebSocket upgrades (non-/ws) to Vite for HMR. Never in local mode, where every path is ours.
    if (!hasStaticBuild && !this.local) proxyUpgradesToVite(this.httpServer, viteDevUrl);

    // Status data is now fed by ipc-handlers.ts via broadcastStatusData() —
    // no independent polling needed. This eliminates duplicate file reads.

    // Cleanup uploaded files older than 1 hour.
    // WHY (2026-10-01 one-core R3-SEC): the sweep is upload-store.ts's, and it also runs once now: the hourly timer
    // alone never fired in an app that is restarted more than hourly, so uploads piled up in the temp folder.
    void sweepOldUploads();
    this.uploadCleanupTimer = setInterval(() => { void sweepOldUploads(); }, 3600_000);

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
      server.listen(port, this.bindAddress ?? undefined, () => {
        if (settled) return;
        settled = true;
        server.removeListener('error', onError);
        this.running = true;
        this.lastStartError = null;
        // The liveness ping is armed by addClient (first client) and disarmed on
        // the last drop — see startLiveness (simplification audit W14).
        console.log(`[RemoteServer] Listening on ${this.bindAddress ?? '*'}:${port}`);
        // The page's own files get their tight compressed copies in the background, after the app has finished starting.
        if (hasStaticBuild && !this.local) setTimeout(() => { void this.assets.warm(staticDir); }, 30_000).unref?.();
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

  /** Try start() again in a while, once: each failed attempt schedules the next. */
  private waitForTailscale(): void {
    if (this.tailscaleWait) return;
    this.tailscaleWait = setTimeout(() => {
      this.tailscaleWait = null;
      if (this.config.enabled && !this.running) this.start().catch(() => { /* scheduled the next look itself */ });
    }, TAILSCALE_RETRY_MS);
    this.tailscaleWait.unref?.();
  }

  private clearTailscaleWait(): void {
    if (this.tailscaleWait) { clearTimeout(this.tailscaleWait); this.tailscaleWait = null; }
  }

  /** The computer woke: if remote access is on but not listening, look for Tailscale now rather than at the next tick. */
  startAfterWake(): void {
    if (this.local || !this.config.enabled || this.running) return;
    this.clearTailscaleWait();
    this.start().catch(() => { /* start() reported it and scheduled the next look */ });
  }

  /** @param forRollback internal use: unwinding a start that failed, where the caller sets
   *  the real reason on the next line. Every other caller is a user switching it off. */
  stop(forRollback = false): void {
    this.clearTailscaleWait();
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
    this.sessionManager.off('session-exit', this.onSessionExit);
    this.sessionManager.off('session-created', this.onSessionCreated);

    // WHY: shutdown skips removeClient, so a phone connected all along was never marked used and a restart could expire it.
    this.devices.touchAll(Array.from(this.clients, (c) => c.deviceId));
    for (const client of this.clients) {
      // WHY: stop clears clients before close events run; invalidate pending starts now.
      this.handoffRoute?.cancelOwner(`remote:${client.id}`);
      getPagesService()?.closeOwner(clientOwnerKey(client.id)); // shutdown clears `clients` without removeClient
      client.ws.close(1001, 'Server shutting down');
      this.leaveAudience(client);
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
    this.devices.expireStale(Date.now(), online); // a stale device never shows in Settings; a connected one is never stale
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
    this.devices.touch(client.deviceId); // time spent connected counts as use for the 90-day sign-out
    this.leaveAudience(client);
    // WHY: close/error/liveness drops must invalidate in-flight starts for this connection only.
    this.handoffRoute?.cancelOwner(`remote:${client.id}`);
    getPagesService()?.closeOwner(clientOwnerKey(client.id)); // WHY here: every real drop (close, error, ping timeout, unpair) ends here; without it a phone's live sockets lived on for the 60 s lease and counted against its reconnect
    if (this.clients.size === 0 && this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.emitStatus(); // clientCount changed — see RemoteStatus.clientCount
  }

  // --- Event handlers ---

  private onPtyOutput = (sessionId: string, data: string, noted?: { epoch: string; offset: number } | null) => {
    // WHY the record (one-core R5-2): the terminal's bytes, with their own epoch and offset, live in the session's record beside its
    // events, so a phone's `session:open` resumes the terminal and the chat from ONE place. R5-4b: the core notes every chunk itself (whether or not
    // this server runs) and passes where it sat; this only relays. A chunk that arrives without a position (a caller with no core) is noted here.
    const at = noted ?? this.getNativeRuntime()?.records.notePty(sessionId, data);
    // A session the record has already closed (a late chunk) is not relayed: it has no stream to be a position in.
    if (!at) return;
    // The live relay: unchanged from what a client has always seen, now with the stream's epoch and the chunk's offset.
    // WHY only the phones watching it (one-core R5-3): terminal output is the heaviest stream there is, and a phone used to be sent
    // every session's bytes only to have its page throw away the ones it had not opened. Now it is sent the sessions it watches.
    this.broadcast({ type: 'pty:output', payload: { sessionId, data, epoch: at.epoch, offset: at.offset } }, (this.audience?.getPtyWatchers ?? this.audience?.getSocketWatchers)?.call(this.audience, sessionId));
  };

  private onSessionCreated = (info: any) => {
    this.broadcast({ type: 'session:created', payload: info });
  };

  private onSessionExit = (sessionId: string, exitCode: number = 0) => {
    // The session's record (and its terminal stream) is dropped by its owner in ipc-handlers on the same event.
    this.lastTopics.delete(sessionId);
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

    const body = this.assets.get(urlPath, policy.encoding, data);
    headers['Content-Encoding'] = policy.encoding;
    res.writeHead(200, headers);
    res.end(body);
  }

  // --- WebSocket connection handling ---

  /** The subprotocol answered to an opening request; takes the messages it carries (shared/first-frames.ts). */
  private pickProtocol(offered: Set<string>, req: http.IncomingMessage): string | false {
    const frames = this.local ? null : readFirstFrames(offered);
    if (frames) { this.firstFrames.set(req, frames); return TOOK_FRAMES_PROTOCOL; }
    return offered.values().next().value ?? false;
  }

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
    // WHY also per source (audit RA-1): one address must not be able to hold the whole shared pool and
    // starve the owner's phone. The loopback app page (local mode) is exempt; it is the app itself.
    if (!this.local && !this.authThrottle.acquireUnauth(ip)) {
      ws.close(4009, 'Too many pending connections');
      return;
    }
    this.unauthSockets++;
    let releasedUnauth = false;
    const releaseUnauth = () => { if (!releasedUnauth) { releasedUnauth = true; this.unauthSockets--; if (!this.local) this.authThrottle.releaseUnauth(ip); } };
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
      // WHY detached and holding BEFORE the slowdown wait: a request sent behind the sign-in that arrived during the wait reached
      // this handler as a second sign-in, and was refused as "expected auth" with the socket closed.
      ws.off('message', authHandler);
      // WHY held (2026-10-22 phone speed): a page that has signed in here before sends its first requests (the session list, its
      // conversation) right behind the sign-in instead of a round trip later (`pipelined` in authOkMessage). They wait here and are
      // handled once it is signed in; a failed sign-in closes the socket and they are dropped. Bounded like the sign-in itself.
      const early: Array<Buffer | string> = [];
      let earlyBytes = 0;
      const holdEarly = (r: Buffer | string) => {
        earlyBytes += r.length;
        if (early.length >= 16 || earlyBytes > PRE_AUTH_MAX_BYTES) { ws.close(4009, 'Too much before sign-in'); return; }
        early.push(r);
      };
      ws.on('message', holdEarly);
      const replayEarly = () => { ws.off('message', holdEarly); for (const r of early) ws.emit('message', r); };
      if (slowStart) await new Promise(r => setTimeout(r, slowStart));

      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== 'auth') {
          ws.send(JSON.stringify({ type: 'auth:failed', reason: 'expected-auth' }));
          ws.close(4000, 'Expected auth');
          return;
        }

        // Local mode: the app's own page, and nothing else, signs in — with this run's token (remote-local.ts).
        if (this.local) {
          if (!localTokenMatches(msg.token, this.local.token)) { ws.send(JSON.stringify({ type: 'auth:failed', reason: 'invalid-credentials' })); ws.close(4001, 'Auth failed'); return; }
          releaseUnauth();
          this.addClient(ws, 'local', ip, { sendsReady: msg.readyHandshake === true, owner: true, refillPush: msg.refillPush === true, pieces: msg.pieces === true });
          ws.send(JSON.stringify(authOkMessage({ deviceId: 'local' }, this.getFocusSessionId(), true))); replayEarly(); return; // the phone's own abilities
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
            this.addClient(ws, result.device.id, ip, { sendsReady: msg.readyHandshake === true, refillPush: msg.refillPush === true, pieces: msg.pieces === true });
            // WHY one builder (R4-1): the two sign-in paths used to spell the handshake by hand and had to be kept
            // in step; a returning device paints the same UI as a newly paired one.
            ws.send(JSON.stringify(authOkMessage({ deviceId: result.device.id }, this.getFocusSessionId())));
            replayEarly();
            // The restore waits for client:ready (addClient armed the old-client fallback).
            return;
          }
          if (result.reason !== 'bad-secret') {
            // Not a failed guess, so it does not count toward the lockout: on upgrade day
            // every retired credential arrives at once and must not lock the household out.
            ws.send(JSON.stringify({ type: 'auth:failed', reason: result.reason }));
            ws.close(result.reason === 'revoked' ? 4003 : result.reason === 'expired' ? CLOSE_DEVICE_EXPIRED : 4004,
              result.reason === 'revoked' ? 'Device unpaired' : result.reason === 'expired' ? `Signed out after ${DEVICE_EXPIRY_DAYS} days unused` : 'Credential retired');
            return;
          }
        }

        // WHY here, after the saved-key check above (audit RA-1): a locked-out source can still use a
        // device key it already holds; only password guessing is stopped.
        const waitMs = this.authThrottle.retryAfterMs(ip);
        if (msg.password && waitMs > 0) {
          ws.send(JSON.stringify({ type: 'auth:failed', reason: 'too-many-attempts', retryAfterMs: waitMs }));
          ws.close(4001, 'Too many attempts');
          return;
        }
        const verdict = msg.password && typeof msg.password === 'string'
          ? await this.verifyQueue.run(() => this.config.verifyPassword(msg.password))
          : false;
        if (verdict === 'busy') {
          ws.send(JSON.stringify({ type: 'auth:failed', reason: 'too-many-attempts', retryAfterMs: 30_000 }));
          ws.close(4001, 'Busy');
          return;
        }
        if (verdict) {
          this.authThrottle.recordSuccess(ip);
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
          this.addClient(ws, paired.deviceId, ip, { sendsReady: msg.readyHandshake === true, refillPush: msg.refillPush === true, pieces: msg.pieces === true });
          ws.send(JSON.stringify(authOkMessage({ deviceId: paired.deviceId, secret: paired.secret }, this.getFocusSessionId())));
          replayEarly();
          // The restore waits for client:ready (addClient armed the old-client fallback).
        } else {
          this.recordFailedAttempt();
          // Only real password guesses count; a stale saved key alone must not lock out password sign-in.
          if (msg.password) this.authThrottle.recordFailure(ip);
          ws.send(JSON.stringify({ type: 'auth:failed', reason: 'invalid-credentials' }));
          ws.close(4001, 'Auth failed');
        }
      } catch {
        ws.send(JSON.stringify({ type: 'auth:failed', reason: 'invalid-message' }));
        ws.close(4000, 'Invalid auth message');
      } finally {
        ws.off('message', holdEarly);   // signed in: already handed on (replayEarly); refused: dropped with the socket
      }
    };

    ws.on('message', authHandler);
    // The opening request's messages, in order: the sign-in reaches authHandler, the rest wait in its early hold like frames sent
    // right behind it. They count against the same limits.
    for (const frame of this.firstFrames.get(req) ?? []) ws.emit('message', Buffer.from(frame), false);
    this.firstFrames.delete(req);
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
      // WHY hourly: a phone connected for months only has its last-used date moved at disconnect; a crash must not leave an old one.
      if (Date.now() - this.lastUsedRefreshAt > 3_600_000) { this.lastUsedRefreshAt = Date.now(); this.devices.touchAll(Array.from(this.clients, (c) => c.deviceId)); }
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

  /** A phone's fill of a conversation never completed (its held pushes were dropped): have it fill that conversation again.
   *  WHY not always a hang-up (2026-10-22 phone reliability): one slow conversation used to close the whole connection, so
   *  every watched conversation refilled — a page that refills on `session:refill` refills just this one. Older pages,
   *  which ignore that push, are still hung up on, or they would silently keep a copy with a hole in it. */
  dropAudience(audienceId: number, sessionId?: string): void {
    for (const client of this.clients) {
      if (client.audienceId !== audienceId) continue;
      if (client.refillPush && sessionId) {
        this.logDevice(client, 'fill never completed; asked to fill that conversation again');
        try { client.ws.send(JSON.stringify({ type: 'session:refill', payload: { sessionId } })); } catch { /* closing anyway */ }
        continue;
      }
      this.logDevice(client, 'fill never completed; closing so it reconnects and fills again');
      client.ws.close(4010, 'Catch-up needed');
      this.removeClient(client);
    }
  }

  /** A phone left: take it out of the window registry (idempotent). */
  private leaveAudience(client: AuthenticatedClient): void {
    if (client.audienceId === undefined) return;
    this.audience?.unregisterSocket(client.audienceId);
    // A phone that dropped mid-fill is owed nothing (one-core R5-2): its held pushes die with it.
    this.getNativeRuntime()?.fills.forget(`s${client.audienceId}`);
  }

  private addClient(ws: WebSocket, deviceId: string, ip: string, opts: { sendsReady?: boolean; owner?: boolean; refillPush?: boolean; pieces?: boolean } = {}): void {
    // A device that signed in again replaces its older connection, which is usually a dead one the ping has not caught
    // yet (60–80 s). Never the phone's own app on its own runtime ('local'), and never across devices.
    if (!opts.owner) {
      for (const old of [...this.clients]) {
        if (old.owner || old.deviceId !== deviceId) continue;
        this.logDevice(old, 'replaced by a newer connection from the same device');
        try { old.ws.close(CLOSE_REPLACED, 'Replaced'); } catch { /* already gone */ }
        this.removeClient(old);
      }
    }
    // The per-connection id stays connection-scoped; the DEVICE id is the durable one the
    // panel lists. Two id spaces, deliberately not merged.
    const client: AuthenticatedClient = {
      id: randomUUID(), ws, deviceId, ip, connectedAt: Date.now(), lastHeardAt: Date.now(), owner: opts.owner === true, refillPush: opts.refillPush === true,
      pieces: opts.pieces === true && !this.local,
    };
    this.clients.add(client);
    // Join the window registry as a member with a negative id (one-core R5-1). A phone is sent a session's pushes once it has
    // opened that session (session:open, R5-2).
    if (this.audience) { client.audienceId = this.nextWatchId--; this.audience.registerSocket(client.audienceId); }
    this.startLiveness(); this.emitStatus(); // liveness is a no-op while already armed — see its WHY; the status carries the new clientCount
    this.logDevice(client, `connected (${opts.sendsReady ? 'page announces readiness' : 'older page'})`);
    // WHY no restore and no timer (one-core R5-2): the page says `client:ready` when it is listening and is then sent the global
    // state (sendHello); each session is filled by its own `session:open`. A page that never says so gets neither, which is
    // what an older page that expects a snapshot has no way to use.
    const drop = () => { this.removeClient(client); };
    ws.on('pong', () => { client.missedPings = 0; client.lastHeardAt = Date.now(); });
    ws.on('message', (raw) => { client.missedPings = 0; client.lastHeardAt = Date.now(); void this.handleMessage(client, raw as Buffer | string); });
    ws.on('close', (code: number, reason: Buffer) => {
      const why = reason && reason.length ? ` (${reason.toString()})` : '';
      // Silence before the drop separates "the phone went away" from "the phone was talking
      // and the connection broke" — the two need different fixes.
      const silent = Math.round((Date.now() - (client.lastHeardAt ?? client.connectedAt)) / 1000);
      this.logDevice(client, `disconnected: code ${code}${why} after ${Math.round((Date.now() - client.connectedAt) / 1000)} s, silent for ${silent} s`);
      drop();
    });
    ws.on('error', (err: Error) => {
      this.logDevice(client, `socket error: ${err?.message ?? err}`);
      drop();
    });
  }

  // --- Hello (the global state a screen needs once it is listening) ---

  /**
   * What every screen needs the moment its page is listening, whatever it shows: the session list, the topic names and the last
   * status payload. Sent when the page says `client:ready` (it has mounted its listeners; a push before that is dropped by the shim).
   *
   * WHY this is all that is left of the restore sequence (one-core R5-2): the snapshot of every session's chat state, the
   * per-window merge that built it, the cut line, the hold-queue, the terminal pass and the 10,000-event hook replay existed to catch
   * a phone up. A phone now fills each session through `session:open` (session-open.ts) and goes live at once; nothing is queued and
   * there is no cut line, because the fill is exact up to an event number and the live stream carries the rest.
   */
  private sendHello(client: AuthenticatedClient): void {
    const send = (msg: { type: string; payload: unknown }) => { if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(msg)); };
    for (const session of this.sessionManager.listSessions()) send({ type: 'session:created', payload: session });
    for (const [desktopId, name] of this.lastTopics) send({ type: 'session:renamed', payload: { sessionId: desktopId, name } });
    // So a client connecting between the 10 s polls renders a populated status bar at once. Same shape the poll broadcasts.
    if (this.lastStatusData) send({ type: 'status:data', payload: this.lastStatusData });
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
      // WHY afterReply (one-core R5-2): session:open lets a screen's held pushes through once its answer has been SENT, so they
      // arrive after it on this socket. Callbacks are collected here and run right after respond() below.
      const afterReply: Array<() => void> = [];
      const started = Date.now();
      const outcome = await serveRemoteChannel(tableDef, payload, {
        door: 'remote', runtime: this.nativeRuntime, deviceId: client.deviceId, clientId: client.id,
        audienceId: client.audienceId, afterReply: (fn) => { afterReply.push(fn); },
        isConnected: () => client.ws.readyState === WebSocket.OPEN,
        // WHY (2026-09-30 one-core R3-7): what only this phone's socket holds, for the file channels — which folders
        // a phone may see, its own watcher id (dropped when its socket closes), and its download links.
        remote: {
          sessionRoots: () => this.sessionRoots(), /* R6-1 sessionCwd: one open session's folder, for native:session-context-text's instruction-file read */ sessionCwd: (sessionId) => { const s = this.sessionManager.getSession(sessionId); return s && s.status !== 'destroyed' && typeof s.cwd === 'string' && s.cwd.length > 0 ? s.cwd : undefined; },
          watchSubscriberId: () => this.watchSubscriberId(client),
          currentWatchId: () => client.watchId,
          get watchedRoots() { return (client.watchedRoots ??= new Set<string>()); },
          mintDownload: (request) => this.downloads.mint(request as any, { deviceId: client.deviceId, socketId: client.id }),
          // WHY (2026-10-01 one-core R3-8): the document-comment watcher id (its own refcount map), the relay to the
          // other phones (a theme or screen change made on this phone), and a push to this computer's windows.
          docCommentsSubscriberId: () => this.docCommentsSubscriberId(client),
          currentDocCommentsId: () => client.docCommentsWatchId,
          relayToOthers: (message) => {
            const data = JSON.stringify(message);
            for (const c of this.clients) {
              if (c === client) continue;
              if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
            }
          },
          sendToWindows: (channel, payload) => this.broadcastToWindows(channel, payload),
          pageSocketPush: (event) => sendToClient(client, event),
          host: { config: this.config, getClientCount: () => this.getClientCount(), getClientList: () => this.getClientList(), getStatus: () => this.getStatus(), getDeviceList: () => this.getDeviceList() },
        },
        // Every screen: all phones (the sender included), then this computer's windows.
        broadcast: (channel, data) => {
          this.broadcast({ type: channel, payload: data });
          this.broadcastToWindows(channel, data);
        },
        desktop: client.owner ? ownerDesktopServices({ broadcast: (m) => this.broadcast(m), sessionRoots: () => this.sessionRoots(), sessionManager: this.sessionManager }) : undefined,
      }, { owner: client.owner === true });
      // Only an awaited request (it has an id) is answered.
      if (outcome.reply && id) {
        const chars = this.respond(client, type, id, outcome.payload);
        // How long a phone waited on what it needs to draw a conversation, and how much came back (remote-timings.ts).
        if (!client.owner && (type === 'session:open' || type === 'session:list')) this.logDevice(client, describeAnswer(type, payload, Date.now() - started, chars));
      }
      for (const fn of afterReply) { try { fn(); } catch (err) { console.warn('[remote-server] after-reply callback failed:', String(err)); } }
      return;
    }

    switch (type) {
      // --- Readiness ---
      case 'client:ready': {
        // Push, no reply: the page has mounted its listeners, so the global state it needs can be sent (sendHello). Once per connection.
        // A page from before the one fill path expects a chat snapshot that is gone; it would show empty conversations with no
        // explanation. Say so and let it go (its shipped code treats 4005 as final, so it does not retry in a loop).
        if (isOldFillClient(payload)) {
          this.logDevice(client, 'older page (expects a chat snapshot); told to refresh');
          if (typeof payload?.seq === 'number') {
            // A page loaded BEFORE this computer updated (a phone browser left open). Nothing in it reloads itself on a close code (its
            // 4005 handling forgets the key and shows the password box with no message), so instead of a refusal loop it is answered
            // the way it understands: the session list, then a degraded snapshot whose every conversation holds ONE plain notice. Its
            // own strip says the copy may be behind; reloading the tab fetches the new page (index.html is served no-cache).
            this.sendHello(client);
            const notice = { id: 'refresh-notice', timestamp: Date.now(), label: REFRESH_NOTICE, variant: 'info' as const };
            const sessions = new Map(this.sessionManager.listSessions().map((s: { id: string }) => [s.id, { ...createSessionChatState(), timeline: [{ kind: 'system-marker' as const, marker: notice }] }]));
            const snapshot = { ...serializeChatState(sessions), degraded: true, focus: { sessionId: this.getFocusSessionId() }, seq: payload.seq };
            if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify({ type: 'chat:hydrate', payload: snapshot }));
            break;
          }
          client.ws.close(CLOSE_OLD_CLIENT, OLD_APP_REASON);
          this.removeClient(client);
          break;
        }
        if (client.helloSent) break;
        client.helloSent = true;
        this.logDevice(client, 'page ready');
        this.sendHello(client);
        break;
      }
      case 'remote:timings': {
        // Push, no reply: how long this phone took to show its conversations (renderer/remote-timings.ts), for the log.
        const line = describePhoneTimings(payload);
        if (line) this.logDevice(client, line);
        break;
      }
      case 'remote:ping':
        // The phone's wake check (remote-shim checkConnectionAfterWake): any answer proves the
        // connection is alive. Answered at once and in every phase — a phone that is catching
        // up is exactly the one most likely to be asking.
        this.respond(client, type, id, { ok: true });
        break;
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
        this.respond(client, type, id, { outcomes });
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
          this.respond(client, type, id, {
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
  // WHY -1000 (R5-1 review): -1 is the `?? -1` stand-in ipc/buddy.ts uses for a missing sender; a phone must never own it.
  private nextWatchId = -1000;
  private nextPieceId = 1;

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

  /** Returns how many characters were sent (0 when the socket had closed). */
  private respond(client: AuthenticatedClient, type: string, id: string, payload: any): number {
    this.noteCompleted(id);
    if (client.ws.readyState !== WebSocket.OPEN) return 0;
    const data = JSON.stringify({ type: `${type}:response`, id, payload });
    this.sendAnswer(client, data);
    return data.length;
  }

  /** One answer, in `remote:piece` frames when it is large and the page can put them back together (PIECE_CHARS says why). The
   *  pieces go out back to back in one call, so nothing else lands between them; an older page gets the answer whole. */
  private sendAnswer(client: AuthenticatedClient, data: string): void {
    if (!client.pieces || data.length <= PIECE_CHARS) { client.ws.send(data); return; }
    const pieceId = this.nextPieceId++;
    const parts: string[] = [];
    // A cut may fall between an emoji's two halves: JSON.stringify writes a lone half as an escape, and the page's join restores it.
    for (let at = 0; at < data.length; at += PIECE_CHARS) parts.push(data.slice(at, at + PIECE_CHARS));
    parts.forEach((part, i) => client.ws.send(JSON.stringify({ type: 'remote:piece', payload: { id: pieceId, i, n: parts.length, data: part } })));
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

  /**
   * @param audienceIds the registry's answer to "which phones want this" (one-core R5-1/R5-2: the phones that opened the session).
   * Omitted means every phone (terminal bytes, session lifecycle). A phone that never joined the registry (no audienceId) is always
   * included, so a client record added straight to `clients` (tests) behaves as it always did.
   * @param hold lets a phone that is being filled with this session keep the message until its answer is sent (audience-fill.ts).
   */
  broadcast(msg: { type: string; payload: any; epoch?: string; seq?: number }, audienceIds?: readonly number[], hold?: (audienceId: number, deliver: () => void) => boolean): void {
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
    const only = audienceIds ? new Set(audienceIds) : null;
    for (const client of this.clients) {
      if (only && client.audienceId !== undefined && !only.has(client.audienceId)) continue;
      const deliver = () => {
        if (client.ws.readyState !== WebSocket.OPEN) return;
        // A live client that has stopped reading gets closed rather than buffered
        // without bound (§7); the shim reconnects and the strip says so.
        if (client.ws.bufferedAmount > BACKPRESSURE_CLOSE_BYTES) {
          this.logDevice(client, 'not reading fast enough; closing');
          client.ws.close(CLOSE_TOO_SLOW, 'Too slow');
          return;
        }
        data ??= JSON.stringify(msg);
        client.ws.send(data);
      };
      if (hold && client.audienceId !== undefined && hold(client.audienceId, deliver)) continue;
      deliver();
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

