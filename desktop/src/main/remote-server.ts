import http from 'http';
import zlib from 'zlib';
import { listProjectsIndex } from './artifacts/projects-index';
import { readFileHead } from './fs-read-head';
// Games arcade scores — remote browsers share the desktop's operations and
// its stale-board cache (main/arcade-handlers.ts).
import { getArcadeOps } from './arcade-handlers';
// Shared cap so a local folder's description (set via a remote browser client)
// can't drift from the synced registry's limit — same constant project-registry.ts
// and ipc-handlers.ts use.
import { PROJECT_DESCRIPTION_MAX } from '../shared/artifacts/types';
import { staticAssetPolicy } from './remote-static-policy';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { SessionManager } from './session-manager';
// Value import (not type-only): the "Run in terminal" case below runs the SAME
// validation the desktop handler runs — a remote client's payload is the least
// trusted input either of them sees.
import { prepareRunInTerminal, shellDisplayName } from './session-manager';
import type { HookRelay } from './hook-relay';
import type { RemoteConfig } from './remote-config';
import type { LocalSkillProvider } from './skill-provider';
import type { SerializedChatState } from '../renderer/state/chat-types';
import { VITE_DEV_PORT } from '../shared/ports';
import type { NativeSessionHost } from './harness/native-session-host';
import type { NativeSendResult, SessionProvider, HookEvent, SpecialistsEvent, ShellEvent } from '../shared/types';
import type { ProviderRegistry } from './providers/provider-registry';
import type { ModelCatalog } from './providers/model-catalog';
import type { SearchKeyStore } from './harness/search/search-key-store';
import type { SearchService } from './harness/search/search-service';
import type { EngineManager } from './engine/engine-manager';
import { enginePrereqs } from './engine/rocm-prereqs';
import type { ModelManager } from './models/model-manager';
import type { PermissionStore } from './harness/permission-store';
import type { StepGuardSettings } from './harness/step-guard-settings';
import type { PermissionRule } from '../shared/permission-types';
import type { SpecialistCatalog } from './harness/specialists/catalog';
import type { ChatGptAuth } from './providers/chatgpt-auth';
import { toListResult } from './harness/specialists/catalog';
import { detectEndpoints } from './models/endpoint-detectors';
import { BrowserWindow } from 'electron';
import { readTranscriptMeta } from './transcript-utils';
import { listPastSessions, loadHistory, SAFE_ID_RE } from './session-browser';
import { readTranscriptPage } from './transcript-page';
import { getSyncStatus, getSyncConfig, setSyncConfig, forceSync, getSyncLog, dismissWarning, addBackend, removeBackend, updateBackend, pushBackend } from './sync-state';
// Cross-device sync spaces (spec 2026-07-03) — same service functions the
// Electron IPC handlers call, so remote browsers get identical behavior.
import { syncSpacesStatus, syncSpacesEnable, syncSpacesSyncNow, syncSpacesCreateProject, syncSpacesImportProject, syncSpacesRenameProject, syncSpacesStopProject, syncSpacesSetProjectDescription, getManagedRoots } from './sync-spaces/service';
import { readDevices, renameDevice, removeDevice } from './sync-spaces/device-registry';
import { checkSyncPrereqs, installRclone, checkGdriveRemote, authGdrive, authGithub, createGithubRepo } from './sync-setup-handlers';
// Connect-GitHub modal (device-flow auth). status/install are stateless direct
// calls; connect start/cancel drive the shared orchestrator singleton created in
// ipc-handlers (its emitDone broadcasts github:connect-done to remote clients).
import { installGh } from './github-auth';
import { combinedGithubStatus } from './github-client';
import { getGithubConnect, disconnectGithub } from './github-connect';
import { resolveConversations, readConversation } from './chatsearch-index/refs-service';

const PTY_BUFFER_SIZE = 4 * 1024 * 1024; // 4MB per session — enough for full conversation replay
// Perf (2026-09-03): the rolling PTY replay buffer is a LIST OF OUTPUT CHUNKS,
// not one big string, so appending costs O(chunk) instead of O(whole buffer).
// `length` is the running total of `chunks` measured in JavaScript string length
// (UTF-16 code units) — deliberately the SAME unit the old
// `buf.length > PTY_BUFFER_SIZE` cap counted, so the effective cap size does not
// silently change. (It is a character count, not a byte count: a non-ASCII char
// can cost 2 units and a UTF-8 byte count would differ — exactly as before.)
interface PtyBuffer { chunks: string[]; length: number; }
// Perf: a PTY can emit a single keystroke at a time, and 4 MB of 1-char chunks
// would be millions of array entries (each JS string carries tens of bytes of
// overhead). So while the newest chunk is still small, append INTO it rather than
// pushing a new entry — copying under 4 KB is free, and it caps the array at
// roughly a thousand entries no matter how the output is chopped up.
const PTY_CHUNK_COALESCE_BELOW = 4096;
const HOOK_BUFFER_SIZE = 10_000; // ~10MB max, covers full conversations without excessive memory
const AUTH_TIMEOUT_MS = 5000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_FAILURES = 5;

interface AuthenticatedClient {
  id: string;
  ws: WebSocket;
  token: string;
  ip: string;
  connectedAt: number;
}

export interface ClientInfo {
  id: string;
  ip: string;
  connectedAt: number;
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
  private clients = new Set<AuthenticatedClient>();
  private lastClientActivityMs = 0; // see getLastClientActivityMs()
  private tokens = new Map<string, boolean>(); // token → valid
  private tokensPath: string;
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
  private failedAttempts = new Map<string, { count: number; resetAt: number }>();
  // Last-known topic names, fed by ipc-handlers.ts via setLastTopic()
  private lastTopics = new Map<string, string>();
  // Last-known FULL status payload, fed by ipc-handlers.ts via broadcastStatusData(),
  // replayed to each new client in replayBuffers(). Was previously `contextMap` — only
  // the context-% slice was stored, and nothing ever read it, so a remote client that
  // connected between polls showed a blank status bar for up to 10s (the ipc-handlers
  // status interval). Storing the whole payload fixes that for every status field
  // (usage, gitBranch, sessionStats, attention, sync) instead of just context %.
  private lastStatusData: Record<string, any> | null = null;
  // Provider injected at construction — called when new clients connect to get the full chat state.
  // Task 6 wires this into replayBuffers(); declared here so the field exists before that step.
  private requestSnapshot: () => Promise<SerializedChatState>;
  // Native runtime stack — injected by ipc-handlers via setNativeRuntime() AFTER
  // it constructs the instances (they can't be built at RemoteServer construction
  // time because they live in the ipc-handlers scope). Null until wired; the
  // native:* / provider:* WS cases no-op until then.
  // Merge note: nativeRuntime carries modelManager (Plan C) AND the leaseWiring
  // field (Plan 2b) — both were added independently on master and this branch.
  // permissionStore (M5 2a) is carried for the READ side only — permissions:list.
  // The two revokes go through nativeHost, which also clears live in-memory state.
  private nativeRuntime: { nativeHost: NativeSessionHost; providerRegistry: ProviderRegistry; modelCatalog: ModelCatalog; engineManager: EngineManager; modelManager: ModelManager; searchKeyStore: SearchKeyStore; searchService: SearchService; permissionStore: PermissionStore; stepGuardSettings: StepGuardSettings; specialistCatalog: SpecialistCatalog; chatgptAuth: ChatGptAuth | null } | null = null;
  // Plan 2b Task 11: conversation-lease + device wiring, injected by ipc-handlers
  // via setLeaseWiring() AFTER main.ts builds the lease client/requester (they
  // live in the whenReady scope, not reachable at RemoteServer construction).
  // Null until wired; the syncspaces:lease-*/device WS cases degrade the same
  // way the desktop handlers do (free/error) so a remote resume never hard-blocks.
  private leaseWiring: {
    client: import('./conversations/lease-client').LeaseClient;
    requester: import('./conversations/takeover').RequesterTakeoverType;
    deviceId: string;  // per-INSTALL — leases only
    machineId: string; // per-MACHINE — device-registry self-marking only
  } | null = null;

  constructor(
    private sessionManager: SessionManager,
    private hookRelay: HookRelay,
    private config: RemoteConfig,
    private skillProvider?: LocalSkillProvider,
    opts?: { requestSnapshot?: () => Promise<SerializedChatState> },
  ) {
    this.tokensPath = path.join(os.homedir(), '.claude', '.remote-tokens.json');
    this.loadTokens();
    // Default is a no-op that returns an empty snapshot — allows the server to
    // be constructed before the main window exists (e.g. during first-run setup).
    this.requestSnapshot = opts?.requestSnapshot ?? (() => Promise.resolve({ sessions: [] }));
  }

  /** Injected by main.ts. Read-only access to the marketplace auth session so
   *  remote clients can see whether the host is signed in — the game lobby
   *  renders its sign-in screen off account:signed-in, so without this a remote
   *  browser showed "signed out" while the host app was signed in. */
  setAccountStore(store: { getToken(): string | null; getUser(): any }): void {
    this.accountStore = store;
  }
  private accountStore?: { getToken(): string | null; getUser(): any };

  /** Injected by ipc-handlers after it constructs the native stack, so remote
   *  WS clients reach the SAME nativeHost / providerRegistry / modelCatalog the
   *  Electron IPC handlers use (mirrors setLastTopic / broadcastStatusData). */
  setNativeRuntime(rt: { nativeHost: NativeSessionHost; providerRegistry: ProviderRegistry; modelCatalog: ModelCatalog; engineManager: EngineManager; modelManager: ModelManager; searchKeyStore: SearchKeyStore; searchService: SearchService; permissionStore: PermissionStore; stepGuardSettings: StepGuardSettings; specialistCatalog: SpecialistCatalog; chatgptAuth: ChatGptAuth | null }): void {
    this.nativeRuntime = rt;
  }

  /** Task 5: which Conversation Store bucket a session's meta reads/writes
   *  belong to. 'native' when NativeSessionHost recognizes the id (live now,
   *  or a persisted ~/.youcoded/sessions file); 'claude' otherwise, including
   *  when the native runtime isn't wired yet (nothing to recognize as native).
   *  Remote clients pass raw session ids — no sessionIdMap resolution is
   *  needed because native ids are mapped to themselves (ipc-handlers sets
   *  sessionIdMap identity for native). Mirrors ipc-handlers' sessionProviderFor
   *  so a session's meta lands in — and reads back from — the same bucket
   *  regardless of which surface (Electron IPC or remote WS) touched it. */
  private isNativeId(sessionId: unknown): boolean {
    const rt = this.nativeRuntime;
    return rt ? rt.nativeHost.isNativeSessionId(String(sessionId ?? '')) : false;
  }

  // Provider bucket to READ a session's meta from — mirrors ipc-handlers'
  // sessionProviderFor exactly (design §12 survivor 1: any gate covers BOTH
  // surfaces). 'native' when the runtime recognizes the id (live/on-disk);
  // otherwise probe the store's native bucket so a store-only native browse row
  // (record synced, transcript not local; Task 5) reads back from native
  // instead of seeding a claude phantom (C1). Null store → 'claude', as before.
  // WRITES pass isNativeId() straight to noteFlagChanged/noteSessionNote, which
  // defer the probe to flush time (boot-window correctness) — same as ipcMain.
  private async sessionProviderFor(sessionId: unknown): Promise<SessionProvider> {
    if (this.isNativeId(sessionId)) return 'native';
    const { getConversationStore } = await import('./conversations/service');
    const store = getConversationStore();
    if (!store) return 'claude';
    try { return (await store.get('native', String(sessionId ?? ''))) ? 'native' : 'claude'; }
    catch { return 'claude'; }
  }

  /** Injected by ipc-handlers after main.ts builds the lease client/requester,
   *  so remote WS clients reach the SAME lease state the Electron IPC handlers
   *  use (mirrors setNativeRuntime). machineId marks self in list-devices —
   *  deviceId is the per-INSTALL lease id and must NOT be used for that. */
  setLeaseWiring(w: {
    client: import('./conversations/lease-client').LeaseClient;
    requester: import('./conversations/takeover').RequesterTakeoverType;
    deviceId: string;
    machineId: string;
  }): void {
    this.leaseWiring = w;
  }

  /** Injected by ipc-handlers right after it builds sessionIdMap + the
   *  phantom-record gate (canWriteStoreRecord), so remote WS clients
   *  (session:set-tag / session:set-note) get the IDENTICAL desktop→claude id
   *  resolution and writability gate the ipcMain handlers use. Before this,
   *  the remote path had neither — the exact "gate covers one surface but not
   *  the other" shape the 2026-07-19 native-refusal incident was about, just
   *  for a different gate. Undefined until wired (or in tests that never call
   *  registerIpcHandlers's full setup): falls back to no resolution / no gate,
   *  i.e. the pre-parity behavior. */
  setSessionMetaWiring(w: {
    resolve: (sessionId: string) => string;
    canWrite: (sessionId: string, resolved: string) => boolean;
  }): void {
    this.sessionMetaWiring = w;
  }
  private sessionMetaWiring?: {
    resolve: (sessionId: string) => string;
    canWrite: (sessionId: string, resolved: string) => boolean;
  };

  private loadTokens(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.tokensPath, 'utf8'));
      if (Array.isArray(data)) {
        for (const t of data) this.tokens.set(t, true);
      }
    } catch { /* no persisted tokens yet */ }
  }

  private saveTokens(): void {
    try {
      fs.mkdirSync(path.dirname(this.tokensPath), { recursive: true });
      // Security: restrict file permissions to owner-only (prevents other users reading tokens)
      fs.writeFileSync(this.tokensPath, JSON.stringify(Array.from(this.tokens.keys())), { mode: 0o600 });
    } catch { /* best effort */ }
  }

  /** True once start() has bound the port; false after stop() or a failed start. */
  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      console.log('[RemoteServer] Disabled in config, not starting');
      return;
    }
    if (this.running) return;

    // Re-read persisted tokens: stop() clears the in-memory map, and loadTokens()
    // only ran in the constructor. Without this, toggling remote access off and
    // back on forced every already-paired device to re-enter the password.
    this.loadTokens();

    // Subscribe to events for buffering and broadcasting
    this.sessionManager.on('pty-output', this.onPtyOutput);
    this.hookRelay.on('hook-event', this.onHookEvent);
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
    // In dev mode, dist/renderer/index.html doesn't exist — proxy to Vite
    const hasStaticBuild = fs.existsSync(path.join(staticDir, 'index.html'));

    this.httpServer = http.createServer((req, res) => {
      if (hasStaticBuild) {
        this.handleHttpRequest(req, res, staticDir);
      } else {
        this.proxyToVite(req, res, viteDevUrl);
      }
    });

    // Security: limit message size to 50MB to prevent memory exhaustion attacks
    this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws', maxPayload: 52428800 });
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
        // so a retry starts clean instead of double-subscribing.
        this.stop();
        reject(err);
      };
      server.once('error', onError);
      server.listen(this.config.port, () => {
        if (settled) return;
        settled = true;
        server.removeListener('error', onError);
        this.running = true;
        console.log(`[RemoteServer] Listening on port ${this.config.port}`);
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

  stop(): void {
    this.running = false;
    if (this.uploadCleanupTimer) {
      clearInterval(this.uploadCleanupTimer);
      this.uploadCleanupTimer = null;
    }
    this.lastTopics.clear();
    this.lastStatusData = null;
    this.sessionManager.off('pty-output', this.onPtyOutput);
    this.hookRelay.off('hook-event', this.onHookEvent);
    this.sessionManager.off('session-exit', this.onSessionExit);
    this.sessionManager.off('session-created', this.onSessionCreated);

    for (const client of this.clients) {
      client.ws.close(1001, 'Server shutting down');
    }
    this.clients.clear();
    this.tokens.clear();

    if (this.wss) { this.wss.close(); this.wss = null; }
    if (this.httpServer) { this.httpServer.close(); this.httpServer = null; }
  }

  /** Invalidate all session tokens (e.g., after password change). */
  invalidateTokens(): void {
    this.tokens.clear();
    this.saveTokens();
    for (const client of this.clients) {
      client.ws.close(4001, 'Password changed');
    }
    this.clients.clear();
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

  /** Disconnect a specific client by ID. */
  disconnectClient(clientId: string): boolean {
    for (const client of this.clients) {
      if (client.id === clientId) {
        client.ws.close(4002, 'Disconnected by admin');
        this.clients.delete(client);
        return true;
      }
    }
    return false;
  }

  // --- Event handlers for buffering ---

  private onPtyOutput = (sessionId: string, data: string) => {
    // Append to the rolling replay buffer. Perf: push the chunk instead of
    // rebuilding the whole string — see PtyBuffer for the 4 MB-per-chunk copy
    // this replaces.
    let buf = this.ptyBuffers.get(sessionId);
    if (!buf) { buf = { chunks: [], length: 0 }; this.ptyBuffers.set(sessionId, buf); }
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
      // Behaviour note: the old code cut mid-chunk at exactly PTY_BUFFER_SIZE, so
      // the replay could begin part-way through a terminal escape sequence; the cut
      // now lands on a chunk boundary, which means the buffer can hold slightly
      // LESS than the cap. That is the intended trade — the replayed tail is
      // otherwise identical, and it is strictly less likely to start mid-escape.
      while (buf.length > PTY_BUFFER_SIZE && buf.chunks.length > 1) {
        buf.length -= buf.chunks.shift()!.length;
      }
      // A single chunk larger than the entire cap cannot be dropped without losing
      // everything, so trim its tail instead — the one copy left in this path, and
      // it only happens when one read delivers more than 4 MB at once.
      if (buf.length > PTY_BUFFER_SIZE) {
        const only = buf.chunks[0];
        buf.chunks[0] = only.slice(only.length - PTY_BUFFER_SIZE);
        buf.length = buf.chunks[0].length;
      }
    }

    // Broadcast live
    this.broadcast({ type: 'pty:output', payload: { sessionId, data } });
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
   *  it, a phone reconnecting while a native permission ask was HELD got
   *  nothing, because PermissionHeld is one-shot and the reannounce heartbeat
   *  stops once an ask is held). Reusing hookBuffers — rather than a parallel
   *  native-only map — means the existing replay loop in replayBuffers()
   *  picks these up for free, in the same push order (request, then held). */
  bufferHookEvent(event: HookEvent): void {
    const sessionId = event.sessionId || '';
    // Fix pass (2026-08-16 review finding, "the catch-up replays asks that
    // were already answered"): PermissionBroker's one removal chokepoint
    // (permission-broker.ts's removeEntry) now emits this the moment an ask
    // stops being open — respond() in time, respond() late, or a cancel.
    // Before this, a PermissionRequest sat in the buffer FOREVER once
    // answered (nothing ever removed it, and the buffer holds 10,000
    // events), so a reconnecting phone was replayed a dead question with
    // live-looking Yes/No buttons; tapping either returned false and the
    // card showed a "socket closed" error that was simply untrue — no
    // socket had closed. This is a purge signal, not a replayable card: it
    // drops the matching PermissionRequest/PermissionHeld pair (same
    // _requestId) instead of being appended itself. hook-dispatcher.ts's
    // switch defaults to null on this unknown type, so even if a live client
    // saw it broadcast, it is a harmless no-op — nothing here required a
    // renderer change.
    if (event.type === 'PermissionResolved') {
      const requestId = (event.payload as Record<string, unknown> | undefined)?._requestId;
      const buf = this.hookBuffers.get(sessionId);
      if (buf && typeof requestId === 'string') {
        const filtered = buf.filter((e) => (e.payload as Record<string, unknown> | undefined)?._requestId !== requestId);
        if (filtered.length !== buf.length) this.hookBuffers.set(sessionId, filtered);
      }
      return;
    }
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
    let byChild = this.specialistRunBuffers.get(event.sessionId);
    if (!byChild) {
      byChild = new Map();
      this.specialistRunBuffers.set(event.sessionId, byChild);
    }
    byChild.set(event.run.childId, event);
  }

  /** G-1: connect-time catch-up for a background command's card — latest per
   *  shell id, never an append-only log (same reasoning as bufferSpecialistRun). */
  bufferShellRun(event: ShellEvent): void {
    let byShell = this.shellRunBuffers.get(event.sessionId);
    if (!byShell) { byShell = new Map(); this.shellRunBuffers.set(event.sessionId, byShell); }
    byShell.set(event.run.shellId, event);
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
    this.broadcast({ type: 'session:destroyed', payload: { sessionId, exitCode } });
  };

  // --- HTTP static file serving ---

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse, staticDir: string): void {
    const url = req.url || '/';
    let filePath: string;

    if (url === '/' || url === '/index.html') {
      filePath = path.join(staticDir, 'index.html');
    } else {
      // Prevent directory traversal — decode percent-encoding first
      const decoded = decodeURIComponent(url);
      const safePath = path.normalize(decoded).replace(/^(\.\.[\/\\])+/, '');
      filePath = path.join(staticDir, safePath);
    }

    // Verify the resolved path is within staticDir
    if (!filePath.startsWith(staticDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
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

    // Check rate limiting
    if (this.isRateLimited(ip)) {
      ws.close(4029, 'Too many failed attempts');
      return;
    }

    // Auto-accept Tailscale-trusted connections
    if (this.config.trustTailscale && this.config.isTailscaleIp(ip)) {
      const token = randomUUID();
      this.tokens.set(token, true);
      this.saveTokens();
      this.config.markPaired();
      this.addClient(ws, token, ip);
      ws.send(JSON.stringify({ type: 'auth:ok', token, platform: 'desktop' }));
      this.replayBuffers(ws).catch((err) => {
        console.error('[remote-server] replayBuffers failed:', err);
      });
      return;
    }

    // Auth timeout
    const timeout = setTimeout(() => {
      ws.close(4000, 'Auth timeout');
    }, AUTH_TIMEOUT_MS);

    // Wait for auth message
    const authHandler = async (raw: Buffer | string) => {
      clearTimeout(timeout);
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

        let authenticated = false;

        if (msg.token && this.tokens.has(msg.token)) {
          authenticated = true;
        } else if (msg.password) {
          authenticated = await this.config.verifyPassword(msg.password);
        }

        if (authenticated) {
          this.clearFailedAttempts(ip);
          const token = msg.token && this.tokens.has(msg.token) ? msg.token : randomUUID();
          this.tokens.set(token, true);
          this.saveTokens();
          this.config.markPaired();
          this.addClient(ws, token, ip);
          ws.send(JSON.stringify({ type: 'auth:ok', token, platform: 'desktop' }));
          this.replayBuffers(ws).catch((err) => {
            console.error('[remote-server] replayBuffers failed:', err);
          });
        } else {
          this.recordFailedAttempt(ip);
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

  private addClient(ws: WebSocket, token: string, ip: string): void {
    const client: AuthenticatedClient = { id: randomUUID(), ws, token, ip, connectedAt: Date.now() };
    this.clients.add(client);

    ws.on('message', (raw) => this.handleMessage(client, raw as Buffer | string));
    ws.on('close', () => this.clients.delete(client));
    ws.on('error', () => this.clients.delete(client));
  }

  // --- Replay buffers on new connection ---

  private async replayBuffers(ws: WebSocket): Promise<void> {
    // Session list — sent immediately so client can initialize chat state
    const sessions = this.sessionManager.listSessions();
    ws.send(JSON.stringify({
      type: 'session:list:response',
      id: '_replay',
      payload: sessions,
    }));

    for (const session of sessions) {
      ws.send(JSON.stringify({ type: 'session:created', payload: session }));
    }

    // Send current topic names for all mapped sessions
    for (const [desktopId, name] of this.lastTopics) {
      ws.send(JSON.stringify({ type: 'session:renamed', payload: { sessionId: desktopId, name } }));
    }

    // Replay the last status payload so a client connecting between the 10s polls
    // renders a populated status bar immediately instead of waiting for the next tick.
    // Same shape the poll broadcasts, so the renderer's existing status:data handler
    // merges it with no special-casing.
    if (this.lastStatusData) {
      ws.send(JSON.stringify({ type: 'status:data', payload: this.lastStatusData }));
    }

    // NEW: request a snapshot of the desktop's chat reducer state and push it
    // to the connecting client so they see the full chat history immediately.
    // Must happen before PTY/hook replay so the reducer has state to merge
    // subsequent transcript events into.
    try {
      const snapshot = await this.requestSnapshot();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'chat:hydrate', payload: snapshot }));
      }
    } catch (err) {
      console.error('[remote-server] chat:hydrate failed:', err);
    }

    // Delay PTY + hook replay to give the client time to process SESSION_INIT.
    // Without this delay, hook events arrive before the chat reducer has
    // initialized the session state, and all events are silently dropped.
    // Note: the preceding `requestSnapshot()` await can take up to 2000ms
    // (its internal timeout), so the worst-case total delay before PTY/hook
    // replay starts is ~2500ms for a connect when the renderer is unresponsive.
    setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) return;

      // PTY buffers. Perf: join the chunks only HERE, at connect time — the buffer
      // is stored chopped up precisely so that arriving output never re-copies the
      // whole 4 MB (see PtyBuffer). The joined text is what the old single-string
      // buffer held, apart from the head trim now landing on a chunk boundary.
      for (const [sessionId, buf] of this.ptyBuffers) {
        if (buf.length > 0) {
          ws.send(JSON.stringify({ type: 'pty:output', payload: { sessionId, data: buf.chunks.join('') } }));
        }
      }

      // Hook event buffers (also carries buffered NATIVE hook events now —
      // see bufferHookEvent's own comment for why those need to ride this
      // same map instead of a parallel one).
      for (const [_sessionId, events] of this.hookBuffers) {
        for (const event of events) {
          ws.send(JSON.stringify({ type: 'hook:event', payload: event }));
        }
      }

      // Task 9 (plan 1c): latest specialist run per helper, so a reconnecting
      // client's card comes back with a status instead of blank. Same
      // ordering position as the hook buffers just above — catch-up replay,
      // then live events resume.
      for (const [_sessionId, byChild] of this.specialistRunBuffers) {
        for (const event of byChild.values()) {
          ws.send(JSON.stringify({ type: 'specialists:event', payload: event }));
        }
      }
      // G-1: latest shell run per command, same position as the specialist replay.
      for (const [_sessionId, byShell] of this.shellRunBuffers) {
        for (const event of byShell.values()) {
          ws.send(JSON.stringify({ type: 'native:shell-event', payload: event }));
        }
      }

    }, 500); // 500ms gives React time to render App and register SESSION_INIT
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

    switch (type) {
      // --- Request/response ---
      case 'session:create': {
        // This payload is passed to createSession unfiltered, so without this
        // guard a remote browser could ask for `{provider:'shell', cwd:'/'}`.
        //
        // BE PRECISE ABOUT WHAT THIS BUYS. It does NOT stop an authenticated
        // remote client from reaching a shell: engine:run-in-terminal below is
        // open to remote clients too, and session:input is unconditional. What
        // it removes is the two things that payload alone would carry — an
        // attacker-chosen cwd, and an initialCommand nothing validated. It is
        // not a privilege boundary: an authenticated remote client already had
        // equivalent reach before the shell provider existed, through this same
        // unfiltered path into Claude Code, and a remote client is a human
        // pressing keys. The property that matters — the APP never runs a
        // command for anyone — is enforced by prepareRunInTerminal, not here.
        if (payload?.provider === 'shell') {
          this.respond(client.ws, type, id, { ok: false, error: 'A terminal session can only be opened from the app itself.' });
          break;
        }
        const info = this.sessionManager.createSession(payload);
        this.respond(client.ws, type, id, info);
        // session:created broadcast is handled by the onSessionCreated event listener
        break;
      }
      case 'session:destroy': {
        // Tear down the native HarnessSession too (mirrors Electron
        // SESSION_DESTROY) so a native session isn't leaked when destroyed via
        // remote. No-op for non-native ids; guarded until the stack is wired.
        await this.nativeRuntime?.nativeHost.destroy(payload.sessionId || payload);
        const result = this.sessionManager.destroySession(payload.sessionId || payload);
        this.respond(client.ws, type, id, result);
        if (result) {
          this.broadcast({ type: 'session:destroyed', payload: { sessionId: payload.sessionId || payload } });
        }
        break;
      }
      case 'session:list': {
        const sessions = this.sessionManager.listSessions();
        this.respond(client.ws, type, id, sessions);
        break;
      }
      case 'session:switch': {
        // Session switching is client-side state — acknowledge so the request doesn't time out
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'session:browse': {
        const activeIds = new Set(this.sessionManager.listSessions().map(s => s.id));
        // Task 5: remote browse gains native rows for the first time, through
        // the SAME enrichment pass the Electron IPC path uses (see
        // ipc-handlers' SESSION_BROWSE) — previously this surface only ever
        // returned CC rows, so a remote web client's Resume Browser silently
        // never showed native sessions at all.
        const sessions = await listPastSessions(activeIds, this.nativeRuntime?.nativeHost.list());
        this.respond(client.ws, type, id, sessions);
        break;
      }
      // --- Native runtime (Phase 1 Plan A) — same instances as Electron IPC ---
      case 'native:set-binding': {
        const ok = this.nativeRuntime ? await this.nativeRuntime.nativeHost.setBinding(payload.sessionId, payload.binding) : false;
        this.respond(client.ws, type, id, ok);
        break;
      }
      case 'native:set-permission-mode': {
        // setPermissionMode THROWS on an unknown mode string — respond an error
        // object (same convention as the provider CRUD handlers below) so the
        // remote client's request id resolves instead of hanging to timeout.
        try {
          const mode = this.nativeRuntime ? this.nativeRuntime.nativeHost.setPermissionMode(payload.sessionId, payload.mode) : null;
          this.respond(client.ws, type, id, mode);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'native:get-permission-mode': {
        // Read-only — never throws. Falls back to 'ask' when no native runtime
        // (mirrors NativeSessionHost.getPermissionMode's default).
        const mode = this.nativeRuntime ? this.nativeRuntime.nativeHost.getPermissionMode(payload.sessionId) : 'ask';
        this.respond(client.ws, type, id, mode);
        break;
      }
      case 'native:get-step-guard': {
        try {
          const value = this.nativeRuntime ? this.nativeRuntime.stepGuardSettings.read() : null;
          this.respond(client.ws, type, id, value);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'native:set-step-guard': {
        try {
          const value = this.nativeRuntime ? await this.nativeRuntime.stepGuardSettings.update(payload.value) : null;
          this.respond(client.ws, type, id, value);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'native:send': {
        // M1: mirrors the desktop invoke — never throw (transport-parity rule).
        const notLive = { status: 'failed', reason: 'not-live' } satisfies NativeSendResult;
        const result = this.nativeRuntime ? this.nativeRuntime.nativeHost.send(payload.sessionId, payload.text) : notLive;
        this.respond(client.ws, type, id, result);
        break;
      }
      // Task 11: removeQueued is sync + never throws — mirrors the desktop invoke.
      case 'native:queue-remove': {
        const removed = this.nativeRuntime ? this.nativeRuntime.nativeHost.removeQueued(payload.sessionId, payload.queueId) : false;
        this.respond(client.ws, type, id, removed);
        break;
      }
      case 'native:sessions-list': {
        this.respond(client.ws, type, id, this.nativeRuntime ? this.nativeRuntime.nativeHost.list() : []);
        break;
      }
      case 'native:kill-shell': {
        // G-1: the phone's Stop button. Mirrors the desktop invoke's result
        // shape exactly, so the card's refusal handling is identical on both.
        const result = this.nativeRuntime
          ? await this.nativeRuntime.nativeHost.killShell(payload.sessionId, payload.shellId)
          : { ok: false, reason: 'not-live' };
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'provider:list': {
        this.respond(client.ws, type, id, this.nativeRuntime ? await this.nativeRuntime.providerRegistry.list() : []);
        break;
      }
      // The provider CRUD/key/catalog handlers can THROW (bad input, built-in
      // removal, keychain failure). Each responds an error object on throw so
      // the remote client's request id resolves instead of hanging to timeout.
      case 'provider:upsert': {
        try {
          const res = this.nativeRuntime ? await this.nativeRuntime.providerRegistry.upsert(payload) : null;
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'provider:remove': {
        try {
          if (this.nativeRuntime) await this.nativeRuntime.providerRegistry.remove(payload.id ?? payload);
          this.respond(client.ws, type, id, true);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'provider:test': {
        try {
          const res = this.nativeRuntime
            ? await this.nativeRuntime.providerRegistry.testConnection(payload.id ?? payload)
            : { ok: false, message: 'Native runtime not available.' };
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, message: err?.message ?? String(err) });
        }
        break;
      }
      case 'provider:set-key': {
        try {
          if (this.nativeRuntime) await this.nativeRuntime.providerRegistry.setKey(payload.id, payload.key);
          this.respond(client.ws, type, id, true);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'provider:catalog': {
        try {
          const res = this.nativeRuntime
            ? await this.nativeRuntime.modelCatalog.get(await this.nativeRuntime.providerRegistry.list())
            : [];
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      // Sign in with ChatGPT (backend design 2026-09-05 §5) — the four cases exist
      // for the five-surface parity test and answer honestly. Remote clients never
      // see the card (the whole Model Providers section is gated on native.supported,
      // false on remote — review R1-7); the only remote-visible ChatGPT surface is
      // status:data.chatgptUsage, which broadcastStatusData already carries.
      // status / cancel / sign-out are real against the SAME account object the
      // desktop handlers use (kill-switched to null by ipc-handlers → signed-out /
      // false). sign-in answers false: the browser and the 127.0.0.1:1455 listener
      // live on the desktop, so a phone cannot complete the round-trip. Each case
      // try/catches → { ok: false, error } like the provider cases above, so a
      // thrown sentence resolves the request id instead of hanging it to timeout.
      case 'chatgpt:status': {
        try {
          const auth = this.nativeRuntime?.chatgptAuth ?? null;
          this.respond(client.ws, type, id, auth ? auth.status() : { state: 'signed-out' });
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'chatgpt:sign-in': {
        this.respond(client.ws, type, id, false);
        break;
      }
      case 'chatgpt:cancel-sign-in': {
        try {
          const auth = this.nativeRuntime?.chatgptAuth ?? null;
          this.respond(client.ws, type, id, auth ? await auth.cancelSignIn() : false);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'chatgpt:sign-out': {
        try {
          const auth = this.nativeRuntime?.chatgptAuth ?? null;
          this.respond(client.ws, type, id, auth ? await auth.signOut() : false);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      // WebSearch providers (Phase 2 Plan B) — mirror the desktop IPC handlers so
      // remote WS clients reach the SAME searchKeyStore/searchService instances.
      // set/remove-key can throw (empty key, keychain failure); each responds an
      // error object so the client's request id resolves instead of timing out.
      // search:test is never-throws — { ok, message } is the result.
      case 'search:list': {
        this.respond(client.ws, type, id, this.nativeRuntime ? await this.nativeRuntime.searchKeyStore.list() : []);
        break;
      }
      case 'search:set-key': {
        try {
          if (this.nativeRuntime) await this.nativeRuntime.searchKeyStore.setKey(payload.backend, payload.key);
          this.respond(client.ws, type, id, true);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'search:remove-key': {
        try {
          if (this.nativeRuntime) await this.nativeRuntime.searchKeyStore.removeKey(payload.backend);
          this.respond(client.ws, type, id, true);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'search:test': {
        const res = this.nativeRuntime
          ? await this.nativeRuntime.searchService.testBackend(payload.backend, payload.key)
          : { ok: false, message: 'Native runtime not available.' };
        this.respond(client.ws, type, id, res);
        break;
      }
      // Remembered "Always allow" rules (M5 2a) — mirror the desktop IPC handlers
      // so a remote client (a phone, typically) reaches the SAME permissionStore /
      // nativeHost instances. There is no generic passthrough here: a channel with
      // no explicit case gets no reply at all, which hangs the request instead of
      // failing it. Payloads arrive object-wrapped from remote-shim (payload.slug /
      // payload.rule), matching the search:* cases above.
      case 'fs:read-head': {
        // Same function as the ipcMain handler (main/fs-read-head.ts): a
        // remote browser gets the same cap and the same sensitive-path
        // refusal, never a wider read.
        this.respond(client.ws, type, id, await readFileHead(payload?.filePath, payload?.maxBytes));
        break;
      }
      case 'permissions:list': {
        // Read-only: the store is the disk authority. No native runtime → no
        // grants to show, same shape the renderer already handles for an empty list.
        this.respond(client.ws, type, id, this.nativeRuntime ? await this.nativeRuntime.permissionStore.list() : []);
        break;
      }
      case 'permissions:remove': {
        // nativeHost.revokeRule, NEVER permissionStore.remove — the host also
        // clears the live in-memory rule so an already-running session stops
        // granting what was just revoked. false = nothing matched (stale list),
        // which is also the honest answer when the runtime isn't wired.
        const removed = this.nativeRuntime
          ? await this.nativeRuntime.nativeHost.revokeRule(payload.slug, payload.rule as PermissionRule)
          : false;
        this.respond(client.ws, type, id, removed);
        break;
      }
      case 'permissions:remove-project': {
        // Same disk-plus-live-memory contract as permissions:remove above.
        const removed = this.nativeRuntime
          ? await this.nativeRuntime.nativeHost.revokeProject(payload.slug)
          : false;
        this.respond(client.ws, type, id, removed);
        break;
      }
      // Specialists 1c (Task 8) — mirrors the desktop IPC handlers so a
      // remote client (a phone, typically) reaches the SAME specialistCatalog
      // / nativeHost instances. NOT gated on native.supported — a phone must
      // still be able to see the roster and answer a hire's ask. A
      // disconnected runtime answers the general-non-committal message
      // (error-message-standards.md) rather than hanging or guessing why.
      case 'specialists:list': {
        if (!this.nativeRuntime) {
          this.respond(client.ws, type, id, { definitions: [], skipped: [], folders: { personal: '', claudeUser: '' } });
          break;
        }
        const { specialistCatalog } = this.nativeRuntime;
        if (payload?.ensurePersonalFolder) await specialistCatalog.ensurePersonalFolder();
        await specialistCatalog.reload(payload?.cwd);
        this.respond(client.ws, type, id, toListResult(specialistCatalog.snapshot(payload?.cwd)));
        break;
      }
      case 'specialists:delegated-get': {
        const result = this.nativeRuntime
          ? await this.nativeRuntime.nativeHost.getDelegatedModels()
          : { budget: null, frontier: null };
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'specialists:delegated-set': {
        const result = this.nativeRuntime
          ? await this.nativeRuntime.nativeHost.setDelegatedModel(payload.tier, payload.binding)
          : { ok: false, error: 'The assistant runtime isn’t connected.' };
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'specialists:steer': {
        const result = this.nativeRuntime
          ? this.nativeRuntime.nativeHost.steerFromUser(payload.sessionId, payload.childId, payload.text)
          : { ok: false, error: 'The assistant runtime isn’t connected.' };
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'specialists:interrupt': {
        const result = this.nativeRuntime
          ? this.nativeRuntime.nativeHost.interruptFromUser(payload.sessionId, payload.childId)
          : { ok: false, error: 'The assistant runtime isn’t connected.' };
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'tags:list': {
        const { getTagRegistry } = await import('./conversations/tag-registry-service');
        const reg = getTagRegistry();
        const list = reg ? await reg.list().catch(() => []) : [];
        this.respond(client.ws, type, id, list);
        break;
      }
      case 'tags:create': {
        const { getTagRegistry } = await import('./conversations/tag-registry-service');
        const reg = getTagRegistry();
        if (!reg) { this.respond(client.ws, type, id, { ok: false, error: 'tag registry unavailable' }); break; }
        try {
          const tag = await reg.create(String(payload?.label ?? ''), payload?.color);
          this.broadcast({ type: 'tags:changed', payload: {} });
          this.respond(client.ws, type, id, { ok: true, tag });
        } catch (e: any) { this.respond(client.ws, type, id, { ok: false, error: e?.message || String(e) }); }
        break;
      }
      case 'tags:update': {
        const { getTagRegistry } = await import('./conversations/tag-registry-service');
        const reg = getTagRegistry();
        if (!reg) { this.respond(client.ws, type, id, { ok: false, error: 'tag registry unavailable' }); break; }
        try {
          const tag = await reg.update(String(payload?.id), payload?.patch ?? {});
          this.broadcast({ type: 'tags:changed', payload: {} });
          this.respond(client.ws, type, id, { ok: true, tag });
        } catch (e: any) { this.respond(client.ws, type, id, { ok: false, error: e?.message || String(e) }); }
        break;
      }
      case 'tags:delete': {
        const { getTagRegistry } = await import('./conversations/tag-registry-service');
        const reg = getTagRegistry();
        if (!reg) { this.respond(client.ws, type, id, { ok: false, error: 'tag registry unavailable' }); break; }
        try {
          await reg.delete(String(payload?.id));
          this.broadcast({ type: 'tags:changed', payload: {} });
          this.respond(client.ws, type, id, { ok: true });
        } catch (e: any) { this.respond(client.ws, type, id, { ok: false, error: e?.message || String(e) }); }
        break;
      }
      case 'session:set-tag': {
        const { noteFlagChanged, emitConversationMetaChanged } = await import('./conversations/service');
        const { tagFlagKey } = await import('../shared/tags');
        const tagId = String(payload?.tagId ?? '');
        if (!tagId.startsWith('tag_')) { this.respond(client.ws, type, id, { ok: false, error: 'invalid tag id' }); break; }
        // Parity with the ipcMain path: resolve the raw (possibly desktop) id
        // through the SAME map before checking nativeness/writability — see
        // setSessionMetaWiring. Falls back to identity/unconditional-write when
        // unwired (pre-parity behavior), so this never regresses if the setter
        // hasn't been called yet.
        const rawId = String(payload?.sessionId ?? '');
        const resolved = this.sessionMetaWiring?.resolve(rawId) ?? rawId;
        if (!this.sessionMetaWiring || this.sessionMetaWiring.canWrite(rawId, resolved)) {
          // Item 6: await the real result and answer honestly instead of the old
          // fire-and-forget that always said ok:true even when the write
          // silently evaporated (store not up yet / never came up / rejected).
          // Task 5: provider is derived, not hardcoded — writes land in the
          // SAME bucket session:get-meta / session:browse will read back.
          const res = await noteFlagChanged(resolved, tagFlagKey(tagId), !!payload?.value, this.isNativeId(resolved));
          if (!res.ok) {
            this.respond(client.ws, type, id, { ok: false, error: 'Could not save — conversation storage is not available on this device.' });
            break;
          }
        }
        // Task 5 gap (final review): this remote mirror of session:set-tag
        // never told chatsearch a tag changed, so a tag applied from a phone/
        // browser stayed invisible to the CLI until an unrelated refresh.
        emitConversationMetaChanged();
        // ROADMAP 2026-07-23: the ipcMain twin broadcasts session:meta-changed
        // after a successful persist; without this a SECOND remote client (or
        // the same session on another device) stayed stale until a full
        // refresh. Same frame shape as ipc-handlers SESSION_SET_TAG. The echo
        // to the originating client is a harmless refetch (consumers ignore
        // the payload and refetch meta).
        this.broadcast({ type: 'session:meta-changed', payload: { sessionId: resolved, flag: tagFlagKey(tagId), value: !!payload?.value } });
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'session:set-note': {
        const { noteSessionNote, emitConversationMetaChanged } = await import('./conversations/service');
        const text = String(payload?.note ?? '');
        if (text.length > 8000) { this.respond(client.ws, type, id, { ok: false, error: 'note too long' }); break; }
        const rawId = String(payload?.sessionId ?? '');
        const resolved = this.sessionMetaWiring?.resolve(rawId) ?? rawId;
        if (!this.sessionMetaWiring || this.sessionMetaWiring.canWrite(rawId, resolved)) {
          // Task 5: provider is derived, not hardcoded — see session:set-tag.
          const res = await noteSessionNote(resolved, text, this.isNativeId(resolved));
          if (!res.ok) {
            this.respond(client.ws, type, id, { ok: false, error: 'Could not save — conversation storage is not available on this device.' });
            break;
          }
        }
        // Same gap as session:set-tag above — the remote mirror of
        // session:set-note must also tell chatsearch a note changed.
        emitConversationMetaChanged();
        // Same parity gap as session:set-tag above — see that comment.
        this.broadcast({ type: 'session:meta-changed', payload: { sessionId: resolved, note: text } });
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'session:get-meta': {
        const { getConversationStore } = await import('./conversations/service');
        const store = getConversationStore();
        let out = { tags: [] as string[], note: '', supported: true };
        // Task 5: resolve through the same map set-tag/set-note use (a latent
        // gap here previously — this handler read the raw id straight through,
        // which only worked by accident for ids that never needed resolving)
        // and read from whichever provider bucket this session actually writes
        // to. No more up-front native refusal — native records are real.
        const rawId = String(payload?.sessionId ?? '');
        const resolved = this.sessionMetaWiring?.resolve(rawId) ?? rawId;
        if (store) {
          try {
            const rec = await store.get(await this.sessionProviderFor(resolved), resolved);
            if (rec) {
              const tags: string[] = [];
              for (const [k, v] of Object.entries(rec.flags)) {
                if ((v as any).value && k.startsWith('tag:')) tags.push(k.slice(4));
              }
              out = { tags, note: rec.note || '', supported: true };
            }
          } catch { /* fall through to empty */ }
        }
        this.respond(client.ws, type, id, out);
        break;
      }
      // Local engine (Plan B). status is sync; install/restart resolve to a
      // fresh status() so the remote client mirrors the desktop IPC contract.
      case 'engine:status': {
        this.respond(client.ws, type, id, this.nativeRuntime ? this.nativeRuntime.engineManager.status() : null);
        break;
      }
      case 'engine:install': {
        try {
          if (this.nativeRuntime) await this.nativeRuntime.engineManager.install();
          this.respond(client.ws, type, id, this.nativeRuntime?.engineManager.status() ?? null);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'engine:restart': {
        try {
          if (this.nativeRuntime) await this.nativeRuntime.engineManager.restart();
          this.respond(client.ws, type, id, this.nativeRuntime?.engineManager.status() ?? null);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      // Model manager (Plan C). Every handler can throw (network, HF API, disk
      // guard, bad input) so each responds an error object on throw — the remote
      // client's request id resolves instead of hanging to timeout. Payloads are
      // objects matching remote-shim's invoke() calls (payload.query / .repo /
      // .quant / .downloadId / .id / .backend). download-progress is broadcast
      // from ipc-handlers' emitter; no per-case push needed here.
      case 'engine:set-backend': {
        try {
          if (this.nativeRuntime) await this.nativeRuntime.engineManager.setBackend((payload.backend ?? payload) as any);
          this.respond(client.ws, type, id, this.nativeRuntime?.engineManager.status() ?? null);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'engine:set-context': {
        try {
          if (this.nativeRuntime) await this.nativeRuntime.engineManager.setContext((payload.contextSize ?? payload) as number);
          this.respond(client.ws, type, id, this.nativeRuntime?.engineManager.status() ?? null);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      // Every engine-wide setting in one write (2026-09-05 §B). The whole
      // payload IS the patch here — unlike the single-value cases above there is
      // no bare-value form to unwrap, because a patch is always an object.
      case 'engine:set-config': {
        try {
          if (this.nativeRuntime) await this.nativeRuntime.engineManager.setConfig(payload ?? {});
          this.respond(client.ws, type, id, this.nativeRuntime?.engineManager.status() ?? null);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      // "Run in terminal" over the remote link. The shell runs on the HOST — a
      // remote client is a browser and has no terminal of its own — so this is
      // the same plain-shell session the desktop button makes, and the client
      // sees it appear through the session:created broadcast.
      case 'engine:run-in-terminal': {
        try {
          // This payload arrives over the network. A `\r` anywhere inside the
          // string would make the host RUN the command with nobody at the
          // keyboard, so the same validator the desktop handler uses runs here
          // — see prepareRunInTerminal in session-manager.ts.
          const checked = prepareRunInTerminal(payload?.command ?? payload);
          // The host's newest live session names the folder the user is working
          // in; with none, createSession falls back to the home folder.
          let cwd = '';
          for (const s of this.sessionManager.listSessions()) {
            if (s.status !== 'destroyed') cwd = s.cwd;
          }
          const info = this.sessionManager.createSession({
            name: shellDisplayName(checked.shell),
            cwd,
            skipPermissions: false,
            provider: 'shell',
            initialCommand: checked.command,
            shellToken: checked.shellToken,
          });
          this.respond(client.ws, type, id, { sessionId: info.id });
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      // What a faster engine build needs installed (2026-09-05 §A5). Reads THIS
      // machine — the one running the server — which is the right answer: the
      // remote browser is only a window onto it, and the engine that would be
      // switched runs here.
      case 'engine:prereqs': {
        try {
          this.respond(client.ws, type, id, enginePrereqs((payload.backend ?? payload) as string, { refresh: true }));
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'models:curated': {
        try {
          const res = this.nativeRuntime ? await this.nativeRuntime.modelManager.curatedList() : [];
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'models:search': {
        try {
          const res = this.nativeRuntime ? await this.nativeRuntime.modelManager.search(payload.query ?? payload) : [];
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'models:quants': {
        try {
          const res = this.nativeRuntime ? await this.nativeRuntime.modelManager.quants(payload.repo ?? payload) : [];
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'models:download': {
        try {
          const res = this.nativeRuntime ? await this.nativeRuntime.modelManager.download(payload.repo, payload.quant) : null;
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'models:download-cancel': {
        try {
          this.nativeRuntime?.modelManager.cancel(payload.downloadId ?? payload);
          this.respond(client.ws, type, id, true);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'models:delete': {
        try {
          if (this.nativeRuntime) await this.nativeRuntime.engineManager.deleteModel(payload.id ?? payload);
          this.respond(client.ws, type, id, true);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'models:installed': {
        try {
          const res = this.nativeRuntime ? await this.nativeRuntime.engineManager.installedModels() : [];
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      // Resume an interrupted download (2026-08-26) — mirrors the Electron IPC
      // handler. Replaces the orphaned-.partial scan, whose listing folded into
      // models:installed.
      case 'models:resume': {
        try {
          const res = this.nativeRuntime
            ? await this.nativeRuntime.modelManager.resume(payload.modelId ?? payload)
            : { downloadId: '' };
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      // Per-model settings + vision (2026-09-05 local-engine upgrades §C/§E4).
      // All three act on the HOST's engine, which is the only engine there is —
      // the remote client is a browser. The shim rejects an { ok:false } answer
      // for these three, so a refused save reaches the dialog's error line
      // instead of looking like a save that worked.
      case 'models:settings': {
        try {
          const res = this.nativeRuntime
            ? this.nativeRuntime.engineManager.modelSettings(payload.modelId ?? payload)
            : null;
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'models:set-settings': {
        try {
          const res = this.nativeRuntime
            ? await this.nativeRuntime.engineManager.setModelSettings(payload.modelId, payload.patch ?? {})
            : null;
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'models:add-vision': {
        try {
          // `null`, not `{ downloadId: '' }`, when there is no engine to talk
          // to — matching its two siblings above. An empty download id is a FAKE
          // SUCCESS: the row would start showing a download that never begins
          // and never ends.
          const res = this.nativeRuntime
            ? await this.nativeRuntime.modelManager.addVision(payload.modelId ?? payload)
            : null;
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'engine:models': {
        try {
          const res = this.nativeRuntime ? await this.nativeRuntime.engineManager.liveModels() : [];
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'models:memory-check': {
        try {
          const res = this.nativeRuntime
            ? await this.nativeRuntime.modelManager.memoryCheck(payload.modelId ?? payload)
            : { verdict: 'ok', headline: '', detail: '' };
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'models:load': {
        try {
          if (this.nativeRuntime) await this.nativeRuntime.engineManager.loadModel(payload.modelId ?? payload);
          this.respond(client.ws, type, id, true);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'endpoints:detect': {
        try {
          const res = this.nativeRuntime
            ? await detectEndpoints(fetch, await this.nativeRuntime.providerRegistry.list())
            : [];
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'session:history': {
        const { sessionId: histSessionId, projectSlug: histSlug, count, all } = payload;
        // Fix: validate the client-supplied id BEFORE the fs.access probe loop
        // below — loadHistory's SAFE_ID_RE guard only runs after the probe, so
        // a traversal-shaped id ('../../x') made the loop a file-existence
        // oracle for arbitrary *.jsonl paths. The typeof check matters too:
        // SAFE_ID_RE.test(undefined) coerces to the string "undefined", which
        // the regex would accept. Invalid ids get the same [] loadHistory returns.
        if (typeof histSessionId !== 'string' || !SAFE_ID_RE.test(histSessionId)) {
          this.respond(client.ws, type, id, []);
          break;
        }
        // Find the JSONL file across all project slugs. The shim sends the
        // caller's projectSlug (argument-order fix, same day as the SAFE_ID_RE
        // hardening above) — probe it FIRST, parity with Android's handler,
        // so the common case skips the O(projects) directory scan. A stale or
        // invalid slug just falls through to the scan; SAFE_ID_RE gates it
        // before it can shape a path.
        const projectsDir = path.join(os.homedir(), '.claude', 'projects');
        const slugs = await fs.promises.readdir(projectsDir).catch(() => [] as string[]);
        const candidates = (typeof histSlug === 'string' && SAFE_ID_RE.test(histSlug))
          ? [histSlug, ...slugs.filter((s) => s !== histSlug)]
          : slugs;
        let foundSlug = '';
        for (const slug of candidates) {
          const candidate = path.join(projectsDir, slug, histSessionId + '.jsonl');
          try {
            await fs.promises.access(candidate);
            foundSlug = slug;
            break;
          } catch {}
        }
        if (!foundSlug) {
          this.respond(client.ws, type, id, []);
          break;
        }
        const history = await loadHistory(histSessionId, foundSlug, count, all);
        this.respond(client.ws, type, id, history);
        break;
      }
      // Perf cycle 2: paged history over the bridge. The phone hydrates via
      // chat:hydrate on connect; scrolling up asks for older pages here.
      // Resolves the JSONL the same way session:history does (validate the id
      // FIRST, then probe the caller's slug before scanning) — a traversal-
      // shaped id must never shape a path.
      case 'transcript:page': {
        const { sessionId: pageSessionId, beforeCursor } = payload;
        const emptyPage = { events: [], cursor: null, hasMore: false };
        if (typeof pageSessionId !== 'string' || !SAFE_ID_RE.test(pageSessionId)) {
          this.respond(client.ws, type, id, emptyPage);
          break;
        }
        const beforeOffset = (beforeCursor && typeof beforeCursor.offset === 'number') ? beforeCursor.offset : null;

        // Native sessions page over the merged event array; null means "not a
        // native id", so CC's transcript file is the source.
        const nativePage = this.nativeRuntime?.nativeHost.getHistoryPage(pageSessionId, beforeOffset) ?? null;
        if (nativePage) {
          this.respond(client.ws, type, id, {
            events: nativePage.events,
            cursor: nativePage.hasMore ? { path: `native:${pageSessionId}`, offset: nativePage.nextIndex, sizeAtRead: 0 } : null,
            hasMore: nativePage.hasMore,
          });
          break;
        }

        const pageProjectsDir = path.join(os.homedir(), '.claude', 'projects');
        const pageSlugs = await fs.promises.readdir(pageProjectsDir).catch(() => [] as string[]);
        const pageSlugHint = payload.projectSlug;
        const pageCandidates = (typeof pageSlugHint === 'string' && SAFE_ID_RE.test(pageSlugHint))
          ? [pageSlugHint, ...pageSlugs.filter((sl) => sl !== pageSlugHint)]
          : pageSlugs;
        let pagePath = '';
        for (const slug of pageCandidates) {
          const candidate = path.join(pageProjectsDir, slug, pageSessionId + '.jsonl');
          try { await fs.promises.access(candidate); pagePath = candidate; break; } catch { /* try the next slug */ }
        }
        if (!pagePath) {
          // Same distinction the desktop handler makes (shared/types.ts,
          // TranscriptPageResult.unresolved): "I could not find the transcript"
          // must not read as "you have reached the beginning of the
          // conversation", which the renderer records by dropping the cursor
          // and the scroll-up sentinel for good. The renderer is the SAME React
          // code over this bridge, so the phone needs the same answer.
          this.respond(client.ws, type, id, { ...emptyPage, unresolved: true });
          break;
        }
        const page = await readTranscriptPage({
          jsonlPath: pagePath,
          sessionId: pageSessionId,
          endOffset: beforeOffset,
          subagentsDir: path.join(path.dirname(pagePath), pageSessionId, 'subagents'),
        });
        this.respond(client.ws, type, id, page);
        break;
      }
      case 'permission:respond': {
        const { requestId, decision } = payload;
        // Native asks share the channel; 'native-'-prefixed ids route to the
        // broker first, then fall through to hookRelay (mirrors ipc-handlers).
        const result = this.nativeRuntime?.nativeHost.respondPermission(requestId, decision)
          ? true
          : this.hookRelay.respond(requestId, decision);
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:list': {
        const skills = this.skillProvider ? await this.skillProvider.getInstalled() : [];
        this.respond(client.ws, type, id, skills);
        break;
      }
      case 'skills:list-marketplace': {
        const result = this.skillProvider ? await this.skillProvider.listMarketplace(payload) : [];
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:get-detail': {
        const result = this.skillProvider ? await this.skillProvider.getSkillDetail(payload.id) : null;
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:search': {
        const result = this.skillProvider ? await this.skillProvider.search(payload.query) : [];
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:install': {
        const installResult = this.skillProvider
          ? await this.skillProvider.install(payload.id)
          : { status: 'failed' as const, error: 'Skill provider not initialized' };
        // Reload plugins so Claude Code discovers the new plugin. Delayed
        // via broadcastReloadPlugins() to avoid racing the prompt-ready state.
        if (installResult.status === 'installed' && 'type' in installResult && installResult.type === 'plugin') {
          this.sessionManager.broadcastReloadPlugins();
        }
        this.respond(client.ws, type, id, installResult);
        break;
      }
      case 'skills:uninstall': {
        const uninstallResult = this.skillProvider
          ? await this.skillProvider.uninstall(payload.id)
          : { type: 'prompt' as const };
        // Reload plugins so Claude Code drops the uninstalled plugin — matches
        // Android behavior (SessionService.kt:490)
        if (uninstallResult.type === 'plugin') {
          this.sessionManager.broadcastReloadPlugins();
        }
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'skills:get-favorites': {
        const result = this.skillProvider ? await this.skillProvider.getFavorites() : [];
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:set-favorite': {
        if (this.skillProvider) await this.skillProvider.setFavorite(payload.id, payload.favorited);
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'skills:get-chips': {
        const result = this.skillProvider ? await this.skillProvider.getChips() : [];
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:set-chips': {
        if (this.skillProvider) await this.skillProvider.setChips(payload.chips);
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'skills:get-override': {
        const overrides = this.skillProvider ? await this.skillProvider.getOverrides() : {};
        this.respond(client.ws, type, id, overrides[payload.id] || null);
        break;
      }
      case 'skills:set-override': {
        if (this.skillProvider) await this.skillProvider.setOverride(payload.id, payload.override);
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'skills:create-prompt': {
        const result = this.skillProvider ? await this.skillProvider.createPromptSkill(payload) : null;
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:delete-prompt': {
        if (this.skillProvider) await this.skillProvider.deletePromptSkill(payload.id);
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'skills:publish': {
        const result = this.skillProvider ? await this.skillProvider.publish(payload.id) : null;
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:get-share-link': {
        const result = this.skillProvider ? await this.skillProvider.generateShareLink(payload.id) : '';
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:import-from-link': {
        const result = this.skillProvider ? await this.skillProvider.importFromLink(payload.encoded) : null;
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:get-curated-defaults': {
        const result = this.skillProvider ? await this.skillProvider.getCuratedDefaults() : [];
        this.respond(client.ws, type, id, result);
        break;
      }
      // Decomposition v3 §9.9: integration badges via remote/Android session
      case 'skills:get-integration-info': {
        const result = this.skillProvider
          ? await this.skillProvider.getIntegrationInfo(payload.id as string)
          : { provides: [], optionalIntegrations: [] };
        this.respond(client.ws, type, id, result);
        break;
      }
      // Decomposition v3 §9.10: onboarding helpers via remote/Android
      case 'skills:install-many': {
        const result = this.skillProvider
          ? await this.skillProvider.installMany((payload.ids as string[]) || [])
          : [];
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:apply-output-style': {
        if (this.skillProvider) this.skillProvider.applyOutputStyle(payload.styleId as string);
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'file:upload': {
        const uploadDir = path.join(os.tmpdir(), 'claude-desktop-uploads');
        try {
          await fs.promises.mkdir(uploadDir, { recursive: true });
          // Sanitize filename — strip path separators and limit length
          const rawName = String(payload.name || 'upload').replace(/[/\\:*?"<>|]/g, '_').slice(0, 200);
          const filePath = path.join(uploadDir, `${Date.now()}-${rawName}`);
          const buffer = Buffer.from(payload.data, 'base64');
          await fs.promises.writeFile(filePath, buffer);
          this.respond(client.ws, type, id, { path: filePath });
        } catch (err) {
          this.respond(client.ws, type, id, { error: 'Upload failed' });
        }
        break;
      }
      case 'model:get-preference': {
        const modelPrefPath = path.join(os.homedir(), '.claude', 'youcoded-model.json');
        try {
          const raw = await fs.promises.readFile(modelPrefPath, 'utf8');
          const parsed = JSON.parse(raw);
          this.respond(client.ws, type, id, parsed.model || 'sonnet');
        } catch {
          this.respond(client.ws, type, id, 'sonnet');
        }
        break;
      }
      case 'model:set-preference': {
        const modelPrefPath = path.join(os.homedir(), '.claude', 'youcoded-model.json');
        const model = payload.model || payload;
        try {
          await fs.promises.mkdir(path.dirname(modelPrefPath), { recursive: true });
          await fs.promises.writeFile(modelPrefPath, JSON.stringify({ model }));
          this.respond(client.ws, type, id, true);
        } catch {
          this.respond(client.ws, type, id, false);
        }
        break;
      }
      case 'appearance:get': {
        const appearancePath = path.join(os.homedir(), '.claude', 'youcoded-appearance.json');
        try {
          const raw = await fs.promises.readFile(appearancePath, 'utf8');
          this.respond(client.ws, type, id, JSON.parse(raw));
        } catch {
          this.respond(client.ws, type, id, null);
        }
        break;
      }
      case 'appearance:set': {
        const appearancePath = path.join(os.homedir(), '.claude', 'youcoded-appearance.json');
        try {
          let existing: Record<string, any> = {};
          try {
            existing = JSON.parse(await fs.promises.readFile(appearancePath, 'utf8'));
          } catch {}
          const merged = { ...existing, ...payload };
          await fs.promises.mkdir(path.dirname(appearancePath), { recursive: true });
          await fs.promises.writeFile(appearancePath, JSON.stringify(merged));
          this.respond(client.ws, type, id, true);
        } catch {
          this.respond(client.ws, type, id, false);
        }
        break;
      }
      case 'defaults:get': {
        const defaultsPrefPath = path.join(os.homedir(), '.claude', 'youcoded-defaults.json');
        const DEFAULTS_INITIAL = { skipPermissions: false, model: 'sonnet', projectFolder: '' };
        try {
          const raw = await fs.promises.readFile(defaultsPrefPath, 'utf8');
          this.respond(client.ws, type, id, { ...DEFAULTS_INITIAL, ...JSON.parse(raw) });
        } catch {
          this.respond(client.ws, type, id, { ...DEFAULTS_INITIAL });
        }
        break;
      }
      case 'defaults:set': {
        const defaultsPrefPath = path.join(os.homedir(), '.claude', 'youcoded-defaults.json');
        const DEFAULTS_INITIAL = { skipPermissions: false, model: 'sonnet', projectFolder: '' };
        try {
          let current = { ...DEFAULTS_INITIAL };
          try { current = { ...current, ...JSON.parse(await fs.promises.readFile(defaultsPrefPath, 'utf8')) }; } catch {}
          const merged = { ...current, ...payload };
          await fs.promises.writeFile(defaultsPrefPath, JSON.stringify(merged, null, 2));
          this.respond(client.ws, type, id, merged);
        } catch {
          this.respond(client.ws, type, id, null);
        }
        break;
      }
      case 'get-home-path': {
        this.respond(client.ws, type, id, os.homedir());
        break;
      }
      // Claude Code settings.json bridge — mirrors ipc-handlers.ts 'settings:get'/'settings:set'.
      // Dot-path keys supported (e.g. 'permissions.defaultMode').
      case 'settings:get': {
        const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        try {
          const raw = await fs.promises.readFile(claudeSettingsPath, 'utf-8');
          const parsed = JSON.parse(raw);
          const field: string = (payload as any)?.field ?? '';
          const value = field.split('.').reduce((obj: any, k) => (obj == null ? undefined : obj[k]), parsed);
          this.respond(client.ws, type, id, value);
        } catch {
          this.respond(client.ws, type, id, undefined);
        }
        break;
      }
      // Fast + effort mode persistence — mirrors ipc-handlers.ts 'modes:get'/'modes:set'.
      case 'modes:get': {
        const modelModesPath = path.join(os.homedir(), '.claude', 'youcoded-model-modes.json');
        try {
          const raw = await fs.promises.readFile(modelModesPath, 'utf-8');
          this.respond(client.ws, type, id, JSON.parse(raw));
        } catch {
          this.respond(client.ws, type, id, { fast: false, effort: 'auto' });
        }
        break;
      }
      case 'modes:set': {
        const modelModesPath = path.join(os.homedir(), '.claude', 'youcoded-model-modes.json');
        try {
          let current = { fast: false, effort: 'auto' } as Record<string, any>;
          try { current = { ...current, ...JSON.parse(await fs.promises.readFile(modelModesPath, 'utf-8')) }; } catch {}
          const merged = { ...current, ...(payload as Record<string, any>) };
          await fs.promises.mkdir(path.dirname(modelModesPath), { recursive: true });
          await fs.promises.writeFile(modelModesPath, JSON.stringify(merged));
          this.respond(client.ws, type, id, merged);
        } catch {
          this.respond(client.ws, type, id, null);
        }
        break;
      }
      case 'settings:set': {
        const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        try {
          let existing: Record<string, any> = {};
          try { existing = JSON.parse(await fs.promises.readFile(claudeSettingsPath, 'utf-8')); } catch {}
          const field: string = (payload as any)?.field ?? '';
          const value = (payload as any)?.value;
          const keys = field.split('.');
          let cursor = existing;
          for (let i = 0; i < keys.length - 1; i++) {
            const k = keys[i];
            if (cursor[k] == null || typeof cursor[k] !== 'object') cursor[k] = {};
            cursor = cursor[k];
          }
          if (value === null || value === undefined) {
            delete cursor[keys[keys.length - 1]];
          } else {
            cursor[keys[keys.length - 1]] = value;
          }
          await fs.promises.mkdir(path.dirname(claudeSettingsPath), { recursive: true });
          await fs.promises.writeFile(claudeSettingsPath, JSON.stringify(existing, null, 2));
          this.respond(client.ws, type, id, true);
        } catch {
          this.respond(client.ws, type, id, false);
        }
        break;
      }
      case 'folders:list': {
        const foldersPrefPath = path.join(os.homedir(), '.claude', 'youcoded-folders.json');
        try {
          const raw = await fs.promises.readFile(foldersPrefPath, 'utf8');
          let folders = JSON.parse(raw);
          if (!Array.isArray(folders)) folders = [];
          if (folders.length === 0) {
            const home = os.homedir();
            folders = [{ path: home, nickname: 'Home', addedAt: Date.now() }];
            await fs.promises.writeFile(foldersPrefPath, JSON.stringify(folders, null, 2));
          }
          const annotated = folders.map((f: any) => ({ ...f, exists: fs.existsSync(f.path) }));
          this.respond(client.ws, type, id, annotated);
        } catch {
          const home = os.homedir();
          const folders = [{ path: home, nickname: 'Home', addedAt: Date.now(), exists: true }];
          this.respond(client.ws, type, id, folders);
        }
        break;
      }
      case 'folders:add': {
        const foldersPrefPath = path.join(os.homedir(), '.claude', 'youcoded-folders.json');
        try {
          let folders: any[] = [];
          try { folders = JSON.parse(await fs.promises.readFile(foldersPrefPath, 'utf8')); } catch {}
          if (!Array.isArray(folders)) folders = [];
          const normalized = path.resolve(payload.folderPath);
          if (folders.some((f: any) => path.resolve(f.path) === normalized)) {
            this.respond(client.ws, type, id, folders.find((f: any) => path.resolve(f.path) === normalized));
            break;
          }
          const entry = { path: normalized, nickname: payload.nickname || path.basename(normalized), addedAt: Date.now() };
          folders.unshift(entry);
          await fs.promises.mkdir(path.dirname(foldersPrefPath), { recursive: true });
          await fs.promises.writeFile(foldersPrefPath, JSON.stringify(folders, null, 2));
          this.respond(client.ws, type, id, entry);
        } catch {
          this.respond(client.ws, type, id, null);
        }
        break;
      }
      case 'folders:remove': {
        const foldersPrefPath = path.join(os.homedir(), '.claude', 'youcoded-folders.json');
        try {
          let folders: any[] = [];
          try { folders = JSON.parse(await fs.promises.readFile(foldersPrefPath, 'utf8')); } catch {}
          if (!Array.isArray(folders)) folders = [];
          const normalized = path.resolve(payload.folderPath);
          const filtered = folders.filter((f: any) => path.resolve(f.path) !== normalized);
          if (filtered.length === folders.length) { this.respond(client.ws, type, id, false); break; }
          await fs.promises.writeFile(foldersPrefPath, JSON.stringify(filtered, null, 2));
          this.respond(client.ws, type, id, true);
        } catch {
          this.respond(client.ws, type, id, false);
        }
        break;
      }
      case 'folders:rename': {
        const foldersPrefPath = path.join(os.homedir(), '.claude', 'youcoded-folders.json');
        try {
          let folders: any[] = [];
          try { folders = JSON.parse(await fs.promises.readFile(foldersPrefPath, 'utf8')); } catch {}
          if (!Array.isArray(folders)) folders = [];
          const normalized = path.resolve(payload.folderPath);
          const entry = folders.find((f: any) => path.resolve(f.path) === normalized);
          if (!entry) { this.respond(client.ws, type, id, false); break; }
          entry.nickname = payload.nickname;
          await fs.promises.writeFile(foldersPrefPath, JSON.stringify(folders, null, 2));
          this.respond(client.ws, type, id, true);
        } catch {
          this.respond(client.ws, type, id, false);
        }
        break;
      }
      // Sibling of folders:rename above. DELIBERATELY duplicates that case's
      // inline read/find/write instead of importing saved-folders.ts — this
      // file already re-implements the folders store rather than sharing it,
      // and unifying that is out of scope for a description-only change to a
      // shipped, uncovered code path. Only the length cap is shared (imported
      // above), so it can't drift from the other setters.
      case 'folders:set-description': {
        const foldersPrefPath = path.join(os.homedir(), '.claude', 'youcoded-folders.json');
        try {
          let folders: any[] = [];
          try { folders = JSON.parse(await fs.promises.readFile(foldersPrefPath, 'utf8')); } catch {}
          if (!Array.isArray(folders)) folders = [];
          const normalized = path.resolve(payload.folderPath);
          const entry = folders.find((f: any) => path.resolve(f.path) === normalized);
          if (!entry) { this.respond(client.ws, type, id, false); break; }
          entry.description = String(payload.description ?? '').trim().slice(0, PROJECT_DESCRIPTION_MAX) || null;
          await fs.promises.writeFile(foldersPrefPath, JSON.stringify(folders, null, 2));
          this.respond(client.ws, type, id, true);
        } catch {
          this.respond(client.ws, type, id, false);
        }
        break;
      }
      case 'favorites:get': {
        const favPath = path.join(os.homedir(), '.claude', 'youcoded-favorites.json');
        try {
          const data = await fs.promises.readFile(favPath, 'utf8');
          this.respond(client.ws, type, id, JSON.parse(data));
        } catch {
          this.respond(client.ws, type, id, { favorites: [] });
        }
        break;
      }
      case 'favorites:set': {
        const favPath = path.join(os.homedir(), '.claude', 'youcoded-favorites.json');
        let existing: Record<string, any> = {};
        try { existing = JSON.parse(await fs.promises.readFile(favPath, 'utf8')); } catch {}
        existing.favorites = payload.favorites ?? payload;
        await fs.promises.writeFile(favPath, JSON.stringify(existing, null, 2));
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'game:getIncognito': {
        const gPath = path.join(os.homedir(), '.claude', 'youcoded-favorites.json');
        try {
          const data = JSON.parse(await fs.promises.readFile(gPath, 'utf8'));
          this.respond(client.ws, type, id, data.incognito ?? false);
        } catch {
          this.respond(client.ws, type, id, false);
        }
        break;
      }
      case 'game:setIncognito': {
        const gPath = path.join(os.homedir(), '.claude', 'youcoded-favorites.json');
        let existing: Record<string, any> = {};
        try { existing = JSON.parse(await fs.promises.readFile(gPath, 'utf8')); } catch {}
        existing.incognito = payload;
        await fs.promises.writeFile(gPath, JSON.stringify(existing, null, 2));
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'transcript:read-meta': {
        // Fix: mirror model:read-last below — accept { path } or a raw string,
        // and reject non-string values BEFORE touching path.resolve. The old
        // `payload.path || payload` + resolve-outside-the-try shape meant one
        // malformed frame ({ path: {...} }, a bare object, or a null payload)
        // threw out of handleMessage as an unhandled rejection instead of
        // answering null.
        const transcriptPath = (payload && typeof payload === 'object' && 'path' in payload)
          ? payload.path
          : payload;
        if (typeof transcriptPath !== 'string') {
          this.respond(client.ws, type, id, null);
          break;
        }
        try {
          const claudeProjects = path.join(os.homedir(), '.claude', 'projects');
          const resolvedPath = path.resolve(transcriptPath);
          // Fix: + path.sep so a sibling dir like ~/.claude/projects-evil can't pass the prefix check
          if (!resolvedPath.startsWith(claudeProjects + path.sep)) {
            this.respond(client.ws, type, id, null);
            break;
          }
          const meta = await readTranscriptMeta(transcriptPath);
          this.respond(client.ws, type, id, meta);
        } catch {
          this.respond(client.ws, type, id, null);
        }
        break;
      }
      case 'model:read-last': {
        // Mirror of ipc-handlers.ts model:read-last — reads the last assistant
        // message's model field from a JSONL transcript. Accepts either a raw
        // string or { transcriptPath } so the same shim wrapping works on
        // Android (wraps in object) and remote browsers (passes string).
        const transcriptPath = (payload && typeof payload === 'object' && 'transcriptPath' in payload)
          ? payload.transcriptPath
          : payload;
        if (typeof transcriptPath !== 'string') {
          this.respond(client.ws, type, id, null);
          break;
        }
        try {
          const claudeProjects = path.join(os.homedir(), '.claude', 'projects');
          const resolved = path.resolve(transcriptPath);
          if (!resolved.startsWith(claudeProjects + path.sep)) {
            this.respond(client.ws, type, id, null);
            break;
          }
          const content = await fs.promises.readFile(transcriptPath, 'utf-8');
          const lines = content.trim().split('\n');
          let model: string | null = null;
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const entry = JSON.parse(lines[i]);
              if (entry.type === 'assistant' && entry.message?.model) {
                model = entry.message.model;
                break;
              }
            } catch { /* skip malformed line */ }
          }
          this.respond(client.ws, type, id, model);
        } catch {
          this.respond(client.ws, type, id, null);
        }
        break;
      }
      case 'remote:get-config': {
        const config = {
          ...this.config.toSafeObject(),
          clientCount: this.getClientCount(),
        };
        this.respond(client.ws, type, id, config);
        break;
      }
      case 'remote:set-password': {
        // Security: only allow password changes from local connections (not remote clients)
        const isLocal = client.ip === '127.0.0.1' || client.ip === '::1' || client.ip === '::ffff:127.0.0.1';
        if (!isLocal) {
          this.respond(client.ws, type, id, { error: 'Password change only allowed from local connection' });
          break;
        }
        await this.config.setPassword(payload);
        this.invalidateTokens();
        this.respond(client.ws, type, id, true);
        break;
      }
      case 'remote:set-config': {
        if (typeof payload.enabled === 'boolean') this.config.enabled = payload.enabled;
        if (typeof payload.trustTailscale === 'boolean') this.config.trustTailscale = payload.trustTailscale;
        if (typeof payload.keepAwakeHours === 'number') this.config.keepAwakeHours = payload.keepAwakeHours;
        this.config.save();
        this.respond(client.ws, type, id, this.config.toSafeObject());
        break;
      }
      case 'remote:detect-tailscale': {
        const { RemoteConfig } = require('./remote-config');
        const result = await RemoteConfig.detectTailscale(this.config.port);
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'remote:get-client-count': {
        this.respond(client.ws, type, id, this.getClientCount());
        break;
      }
      case 'remote:get-client-list': {
        this.respond(client.ws, type, id, this.getClientList());
        break;
      }
      case 'remote:disconnect-client': {
        const result = this.disconnectClient(payload.clientId || payload);
        this.respond(client.ws, type, id, result);
        break;
      }

      // --- Sync management ---
      case 'sync:get-status': {
        const syncStatus = await getSyncStatus();
        this.respond(client.ws, type, id, syncStatus);
        break;
      }
      case 'sync:get-config': {
        const syncConfig = await getSyncConfig();
        this.respond(client.ws, type, id, syncConfig);
        break;
      }
      case 'sync:set-config': {
        const updatedConfig = await setSyncConfig(payload.updates || payload);
        this.respond(client.ws, type, id, updatedConfig);
        break;
      }
      case 'sync:force': {
        const syncResult = await forceSync();
        this.respond(client.ws, type, id, syncResult);
        break;
      }
      case 'sync:get-log': {
        const logLines = await getSyncLog(payload?.lines);
        this.respond(client.ws, type, id, logLines);
        break;
      }
      case 'sync:dismiss-warning': {
        // The remote-shim always sends { warning }, so payload.warning is
        // the authoritative path. Guard against missing payload rather than
        // falling back to the whole object (which would be a silent no-op).
        await dismissWarning(payload?.warning ?? '');
        this.respond(client.ws, type, id, { ok: true });
        break;
      }

      // Cross-device sync spaces (spec 2026-07-03). Remote-shim sends payloads
      // wrapped as { enabled } / { name }; unwrap the same way the sync:* cases
      // above do. The syncspaces:event push reaches remote clients via the
      // broadcast in service.ts (see broadcastToRenderers wiring below).
      case 'syncspaces:status': {
        this.respond(client.ws, type, id, await syncSpacesStatus());
        break;
      }
      case 'syncspaces:enable': {
        this.respond(client.ws, type, id, await syncSpacesEnable(!!payload?.enabled));
        break;
      }
      case 'syncspaces:sync-now': {
        // Optional spaceId narrows to one space (Project View "Sync now"); omit for all.
        this.respond(client.ws, type, id, await syncSpacesSyncNow(
          payload?.spaceId ? String(payload.spaceId) : undefined));
        break;
      }
      case 'syncspaces:create-project': {
        this.respond(client.ws, type, id, await syncSpacesCreateProject(String(payload?.name ?? '')));
        break;
      }
      case 'syncspaces:import-project': {
        this.respond(client.ws, type, id, await syncSpacesImportProject(
          String(payload?.sourcePath ?? ''), String(payload?.name ?? ''),
          this.sessionManager.listSessions().filter(s => s.status !== 'destroyed').map(s => s.cwd)));
        break;
      }
      // Cross-device rename (display-name only) + stop-syncing (2026-07-12).
      case 'syncspaces:rename-project': {
        this.respond(client.ws, type, id, await syncSpacesRenameProject(
          String(payload?.name ?? ''), String(payload?.displayName ?? '')));
        break;
      }
      case 'syncspaces:stop-project': {
        this.respond(client.ws, type, id, await syncSpacesStopProject(String(payload?.name ?? '')));
        break;
      }
      // Synced project description (Task 3) — payload-object shape, matching rename-project.
      case 'syncspaces:set-project-description': {
        this.respond(client.ws, type, id, await syncSpacesSetProjectDescription(
          String(payload?.name ?? ''), String(payload?.description ?? '')));
        break;
      }
      // Conversation-lease takeover (Plan 2b Task 9/11). Thin passthroughs to the
      // lease client (query) and requester flow (takeover/force), matching the
      // desktop ipc handlers. When wiring is absent (sync disabled) they degrade
      // to a free/error answer so the remote resume gate proceeds (spec §3 never-block).
      // Session references (spec 2026-08-10). Both go through refs-service, the
      // same functions ipc-handlers calls, so a phone and the desktop cannot
      // disagree about which folders may be read.
      case 'chatsearch:resolve': {
        this.respond(client.ws, type, id, resolveConversations(payload?.shortIds));
        break;
      }
      case 'chatsearch:read': {
        // async — await before respond (unlike ipcMain.handle, respond does not
        // unwrap promises).
        this.respond(client.ws, type, id, await readConversation(payload as never));
        break;
      }
      case 'syncspaces:lease-query': {
        // query() is async — await before respond (unlike ipcMain.handle, respond
        // doesn't unwrap promises).
        this.respond(client.ws, type, id,
          (await this.leaseWiring?.client.query(String(payload?.claudeSessionId ?? ''))) ?? { held: false, source: 'none' });
        break;
      }
      case 'syncspaces:lease-takeover': {
        this.respond(client.ws, type, id,
          (await this.leaseWiring?.requester.takeover(String(payload?.claudeSessionId ?? ''))) ?? { outcome: 'error' });
        break;
      }
      case 'syncspaces:lease-force': {
        this.respond(client.ws, type, id,
          (await this.leaseWiring?.requester.force(String(payload?.claudeSessionId ?? ''))) ?? { ok: false });
        break;
      }
      // Device registry (Plan 2b spec §10a). readDevices/renameDevice are direct
      // service-level calls (like the syncspaces:* rows above); self:true marks
      // the current machine via the injected machineId.
      case 'syncspaces:list-devices': {
        const pr = getManagedRoots()?.personalRoot;
        // machineId — must match the Electron handler exactly (ipc-channels.test.ts
        // pins the channel pair; this is the semantic half it can't see).
        const selfId = this.leaseWiring?.machineId ?? '';
        this.respond(client.ws, type, id,
          pr ? readDevices(pr).map((d) => ({ ...d, self: !!selfId && d.id === selfId })) : []);
        break;
      }
      case 'syncspaces:rename-device': {
        const pr = getManagedRoots()?.personalRoot;
        if (!pr) { this.respond(client.ws, type, id, { ok: false }); break; }
        try { await renameDevice(pr, String(payload?.id ?? ''), String(payload?.name ?? '')); this.respond(client.ws, type, id, { ok: true }); }
        catch { this.respond(client.ws, type, id, { ok: false }); }
        break;
      }
      case 'syncspaces:remove-device': {
        const pr = getManagedRoots()?.personalRoot;
        if (!pr) { this.respond(client.ws, type, id, { ok: false }); break; }
        const target = String(payload?.id ?? '');
        if (!target) { this.respond(client.ws, type, id, { ok: false }); break; }
        // Same self-guard as the Electron handler — a remote client must not be
        // able to remove the host machine's own row (it re-registers anyway).
        if (target === (this.leaseWiring?.machineId ?? '')) {
          this.respond(client.ws, type, id, { ok: false, error: 'cannot remove this device' });
          break;
        }
        try { await removeDevice(pr, target); this.respond(client.ws, type, id, { ok: true }); }
        catch { this.respond(client.ws, type, id, { ok: false }); }
        break;
      }

      // Connect-GitHub modal (device-flow auth) — remote browser parity. The flow
      // is all main-process; the browser just renders the code/URL and waits for
      // the github:connect-done broadcast. The access token never crosses the WS.
      case 'github:status': {
        // Combined status (Phase 2) — same payload as the desktop handler:
        // authed = stored app token OR gh login (legacy shape + additive fields).
        this.respond(client.ws, type, id, await combinedGithubStatus());
        break;
      }
      case 'github:connect-start': {
        // Drives the shared orchestrator singleton; completion arrives as the
        // github:connect-done broadcast (fanned out to every client).
        const gc = getGithubConnect();
        this.respond(client.ws, type, id, gc ? await gc.start() : { error: 'unavailable' });
        break;
      }
      case 'github:connect-cancel': {
        getGithubConnect()?.cancel();
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'github:install-gh': {
        this.respond(client.ws, type, id, await installGh());
        break;
      }
      case 'github:disconnect': {
        this.respond(client.ws, type, id, await disconnectGithub());
        break;
      }

      // V2: Per-instance backend management (remote browser parity)
      case 'sync:add-backend': {
        const added = await addBackend(payload);
        this.respond(client.ws, type, id, added);
        break;
      }
      case 'sync:remove-backend': {
        await removeBackend(payload.id || payload);
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'sync:update-backend': {
        const updated = await updateBackend(payload.id, payload.updates);
        this.respond(client.ws, type, id, updated);
        break;
      }
      case 'sync:push-backend': {
        const pushResult = await pushBackend(payload.id || payload);
        this.respond(client.ws, type, id, pushResult);
        break;
      }
      // sync:pull-backend ("Download now") removed in sync-legacy-demolition.
      case 'sync:open-folder': {
        // Remote clients can't open local folders — return the URL for them to open manually.
        // For Drive, resolve the actual sync folder ID via rclone so the client deep-links
        // to the synced folder, not just drive.google.com's homepage.
        const cfg = await getSyncConfig();
        const backend = cfg.backends.find((b: any) => b.id === (payload.id || payload));
        let url = '';
        if (backend?.type === 'drive') {
          const rcloneRemote = backend.config?.rcloneRemote || 'gdrive';
          const driveRoot = backend.config?.DRIVE_ROOT || 'Claude';
          try {
            const { execFile } = require('child_process');
            const stdout: string = await new Promise((resolve, reject) => {
              execFile(
                'rclone',
                ['lsjson', `${rcloneRemote}:${driveRoot}/Backup`, '--dirs-only'],
                { timeout: 15000 },
                (err: any, out: string) => (err ? reject(err) : resolve(String(out || ''))),
              );
            });
            const entries = JSON.parse(stdout) as Array<{ Name: string; ID?: string }>;
            const match = entries.find((e) => e.Name === 'personal' && e.ID);
            url = match?.ID
              ? `https://drive.google.com/drive/folders/${match.ID}`
              : 'https://drive.google.com';
          } catch {
            url = 'https://drive.google.com';
          }
        } else if (backend?.type === 'github') {
          url = backend.config?.PERSONAL_SYNC_REPO || '';
        }
        this.respond(client.ws, type, id, { url });
        break;
      }

      // Guided setup wizard (prerequisite detection, install, OAuth, repo creation)
      case 'sync:setup:check-prereqs': {
        const prereqs = await checkSyncPrereqs(payload.backend || payload);
        this.respond(client.ws, type, id, prereqs);
        break;
      }
      case 'sync:setup:install-rclone': {
        const installResult = await installRclone();
        this.respond(client.ws, type, id, installResult);
        break;
      }
      case 'sync:setup:check-gdrive': {
        const gdriveCheck = await checkGdriveRemote();
        this.respond(client.ws, type, id, gdriveCheck);
        break;
      }
      case 'sync:setup:auth-gdrive': {
        const gdriveAuth = await authGdrive();
        this.respond(client.ws, type, id, gdriveAuth);
        break;
      }
      case 'sync:setup:auth-github': {
        const ghAuth = await authGithub();
        this.respond(client.ws, type, id, ghAuth);
        break;
      }
      case 'sync:setup:create-repo': {
        const repoResult = await createGithubRepo(payload.repoName || payload);
        this.respond(client.ws, type, id, repoResult);
        break;
      }

      // --- UI state sync: broadcast actions to all OTHER clients ---
      case 'ui:action': {
        const data = JSON.stringify({ type: 'ui:action', payload });
        for (const c of this.clients) {
          if (c !== client && c.ws.readyState === WebSocket.OPEN) {
            c.ws.send(data);
          }
        }
        // Also forward to Electron window via IPC if this came from a remote client
        this.sessionManager.emit('ui-action', payload);
        break;
      }

      // --- Zoom controls (applies to the desktop Electron window) ---
      case 'zoom:in':
      case 'zoom:out':
      case 'zoom:reset':
      case 'zoom:get': {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win || win.isDestroyed()) {
          this.respond(client.ws, type, id, 100);
          break;
        }
        const ZOOM_STEP = 0.5;
        const ZOOM_MIN = -3;
        const ZOOM_MAX = 5;
        const toPercent = (l: number) => Math.round(Math.pow(1.2, l) * 100);
        const wc = win.webContents;
        if (type === 'zoom:in') {
          wc.setZoomLevel(Math.min(wc.getZoomLevel() + ZOOM_STEP, ZOOM_MAX));
        } else if (type === 'zoom:out') {
          wc.setZoomLevel(Math.max(wc.getZoomLevel() - ZOOM_STEP, ZOOM_MIN));
        } else if (type === 'zoom:reset') {
          wc.setZoomLevel(0);
        }
        this.respond(client.ws, type, id, toPercent(wc.getZoomLevel()));
        break;
      }

      // --- Fire-and-forget ---
      case 'session:input': {
        this.sessionManager.sendInput(payload.sessionId, payload.text);
        break;
      }
      // Native runtime interrupt — fire-and-forget (no response). The host no-ops unknown ids.
      case 'native:interrupt': {
        this.nativeRuntime?.nativeHost.interrupt(payload.sessionId);
        break;
      }
      // Stalled-turn Retry — fire-and-forget, same shape as interrupt above.
      // The host no-ops when nothing is parked (stream already resumed).
      case 'native:retry': {
        this.nativeRuntime?.nativeHost.retryStalledStep(payload.sessionId);
        break;
      }
      case 'session:resize': {
        this.sessionManager.resizeSession(payload.sessionId, payload.cols, payload.rows);
        break;
      }
      case 'session:terminal-ready': {
        // Remote clients don't need the buffering gate that ipc-handlers uses,
        // because we replay the PTY buffer on connect instead.
        break;
      }

      // --- Project View ---
      case 'artifacts:list-projects-index': {
        // Shared with the Electron IPC handler (artifacts/projects-index.ts) so
        // both transports return the same thing. Without this case the request
        // fell through to nothing and remote Project View was permanently empty.
        try {
          this.respond(client.ws, type, id, await listProjectsIndex(payload));
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: String(err?.message ?? err) });
        }
        break;
      }

      // --- Games arcade scores (spec §6.1) ---
      // The SAME operations the Electron IPC path runs, including the shared
      // stale-board cache — a remote browser must never see a different
      // leaderboard from the desktop window sitting beside it.
      case 'arcade:status':
      case 'arcade:leaderboard':
      case 'arcade:submit-score':
      case 'arcade:records': {
        const ops = getArcadeOps();
        if (!ops) {
          // Registration never ran (minimal boot). General but non-committal —
          // we do not guess a cause we have not verified.
          this.respond(client.ws, type, id, { ok: false, status: 0, message: 'Game scores are unavailable on this host.' });
          break;
        }
        this.respond(client.ws, type, id,
          type === 'arcade:status' ? await ops.status()
          : type === 'arcade:leaderboard' ? await ops.leaderboard(payload?.game)
          // An absent payload.game means EVERY game — passing undefined through
          // is the whole filter, so don't coerce it to '' (that would ask the
          // Worker for the game literally named "", i.e. always nothing).
          : type === 'arcade:records' ? await ops.records(payload?.game ?? undefined)
          : await ops.submitScore(payload?.game, payload?.score));
        break;
      }

      // --- Account (drives the game lobby's signed-in state) ---
      case 'account:signed-in': {
        // No store injected → report signed-out rather than hanging. Mirrors
        // marketplace-api-handlers' `!!store.getToken()`.
        this.respond(client.ws, type, id, !!this.accountStore?.getToken());
        break;
      }
      case 'account:user': {
        // Cached profile only. The Electron handler additionally heals an empty
        // cache by calling /auth/me; that path needs the API client, which lives
        // in marketplace-api-handlers. Returning the cache (or null) keeps this
        // read-only and is enough for the lobby to see a signed-in user.
        this.respond(client.ws, type, id, this.accountStore?.getUser() ?? null);
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

  // --- Helpers ---

  private respond(ws: WebSocket, type: string, id: string, payload: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: `${type}:response`, id, payload }));
    }
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
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  // --- Rate limiting ---

  private isRateLimited(ip: string): boolean {
    const entry = this.failedAttempts.get(ip);
    if (!entry) return false;
    if (Date.now() > entry.resetAt) {
      this.failedAttempts.delete(ip);
      return false;
    }
    return entry.count >= RATE_LIMIT_MAX_FAILURES;
  }

  private recordFailedAttempt(ip: string): void {
    const entry = this.failedAttempts.get(ip);
    if (entry && Date.now() < entry.resetAt) {
      entry.count++;
    } else {
      this.failedAttempts.set(ip, { count: 1, resetAt: Date.now() + RATE_LIMIT_WINDOW_MS });
    }
  }

  private clearFailedAttempts(ip: string): void {
    this.failedAttempts.delete(ip);
  }
}

