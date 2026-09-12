import http from 'http';
import zlib from 'zlib';
import { listProjectsIndex } from './artifacts/projects-index';
// Files over remote (batch 3): the same read bodies the Electron handlers
// call, plus the phone's smaller preview ceilings.
import {
  listSessionFiles, listProjectFiles, listAllFiles, readArtifactText, readArtifactBytes,
  searchArtifactContent, checkArtifactExistence, isKnownRoot, isKnownProjectRef,
  resolveArtifactPath,
} from './artifacts/read-service';
import { listConversations, repoInfo, listContextFiles, readContext } from './project-read-service';
import { watchProject, unwatchProject, dropSubscriber } from './artifacts/project-watcher';
import { REMOTE_TEXT_PREVIEW_MAX_BYTES, REMOTE_BINARY_PREVIEW_MAX_BYTES } from '../shared/remote-file-limits';
import { RemoteDownloads } from './remote-download';
import { readSidecarShared } from './artifacts/artifact-store';
import { readFileHead } from './fs-read-head';
// Games arcade scores — remote browsers share the desktop's operations and
// its stale-board cache (main/arcade-handlers.ts).
import { getArcadeOps } from './arcade-handlers';
// Shared cap so a local folder's description (set via a remote browser client)
// can't drift from the synced registry's limit — same constant project-registry.ts
// and ipc-handlers.ts use.
import { PROJECT_DESCRIPTION_MAX } from '../shared/artifacts/types';
import { listPickerFolders, addFolder, removeFolder, renameFolder, setFolderDescription } from './folders-service';
import { staticAssetPolicy } from './remote-static-policy';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { isAllowedWsOrigin } from './remote-origin';
import type { SessionManager } from './session-manager';
// Value import (not type-only): the "Run in terminal" case below runs the SAME
// validation the desktop handler runs — a remote client's payload is the least
// trusted input either of them sees.
import { prepareRunInTerminal, shellDisplayName } from './session-manager';
import type { HookRelay } from './hook-relay';
import type { RemoteConfig } from './remote-config';
import { RemoteConfig as RemoteConfigStatics } from './remote-config';
import { RemoteDeviceStore, type RemoteDeviceView } from './remote-devices';
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
import type { ClaudeAccount } from './providers/claude-account';
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
import { getJsonPath, setJsonPath } from './safe-json-path';
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
  // Distinct roots this socket watches — capped (MAX_WATCHED_ROOTS_PER_SOCKET).
  watchedRoots?: Set<string>;
}

// A phone shows one project's Files and one conversation's drawer at a time;
// four leaves room for a switch mid-grace without letting a socket pin a
// watcher per directory on the computer.
const MAX_WATCHED_ROOTS_PER_SOCKET = 4;

export interface ClientInfo {
  id: string;
  ip: string;
  connectedAt: number;
}

const HOST_ADMIN_REFUSAL = 'Change this on the computer itself.';

export interface RemoteStatus {
  state: 'listening' | 'stopped' | 'failed';
  reason?: string;
  port: number;
}

interface SessionNamingWiring {
  get: () => Promise<{ mode: string; model: unknown }>;
  set: (value: unknown) => Promise<{ ok: boolean; error?: string }>;
  title: (sessionId: string, fallback: string) => Promise<{ title: string; manual: boolean }>;
  rename: (sessionId: string, title: string) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Which copy of the app a phone's browser is served.
 *
 * WHY (Destin, 2026-09-11: "still flashes the password screen at me on refresh/reconnect"): the
 * server served a built copy whenever one existed on disk, and a dev window found one left by an
 * Android test build the night before, so a whole day of phone-side fixes never reached the phone.
 * The installed app serves its built copy; a dev window serves live code unless a fresh copy was
 * built for the phone (run-dev.sh --phone-build). Pinned by tests/remote-page-source.test.ts.
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
  // Native runtime stack — injected by ipc-handlers via setNativeRuntime() AFTER
  // it constructs the instances (they can't be built at RemoteServer construction
  // time because they live in the ipc-handlers scope). Null until wired; the
  // native:* / provider:* WS cases no-op until then.
  // Merge note: nativeRuntime carries modelManager (Plan C) AND the leaseWiring
  // field (Plan 2b) — both were added independently on master and this branch.
  // permissionStore (M5 2a) is carried for the READ side only — permissions:list.
  // The two revokes go through nativeHost, which also clears live in-memory state.
  private nativeRuntime: { nativeHost: NativeSessionHost; providerRegistry: ProviderRegistry; modelCatalog: ModelCatalog; engineManager: EngineManager; modelManager: ModelManager; searchKeyStore: SearchKeyStore; searchService: SearchService; permissionStore: PermissionStore; stepGuardSettings: StepGuardSettings; specialistCatalog: SpecialistCatalog; chatgptAuth: ChatGptAuth | null; claudeAccount: ClaudeAccount | null } | null = null;
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
    opts?: {
      requestSnapshot?: () => Promise<SerializedChatState>;
      getFocusSessionId?: () => string | null;
      onAppearanceBroadcast?: (prefs: Record<string, unknown>) => void;
      /** The desktop's commands:list (CommandProvider.getCommands), for the phone's / menu. */
      listCommands?: () => Promise<unknown[]>;
      /** The desktop's theme:list. Injectable for tests; defaults to the same function. */
      listThemes?: () => string[];
      /** Serve the built copy of the app when one exists (see choosePhonePageSource). main.ts
       *  passes app.isPackaged or run-dev.sh --phone-build; the default keeps the old behaviour. */
      serveBuiltPage?: boolean;
    },
  ) {
    this.devices = new RemoteDeviceStore();
    // Default is a no-op that returns an empty snapshot — allows the server to
    // be constructed before the main window exists (e.g. during first-run setup).
    this.requestSnapshot = opts?.requestSnapshot ?? (() => Promise.resolve({ sessions: [] }));
    this.getFocusSessionId = opts?.getFocusSessionId ?? (() => null);
    this.onAppearanceBroadcast = opts?.onAppearanceBroadcast ?? (() => {});
    this.listCommands = opts?.listCommands ?? null;
    this.listThemes = opts?.listThemes ?? (() => require('./theme-watcher').listUserThemes());
    this.serveBuiltPage = opts?.serveBuiltPage ?? true;
  }
  private serveBuiltPage: boolean;
  private listCommands: (() => Promise<unknown[]>) | null;
  private listThemes: () => string[];

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
  private onAppearanceBroadcast: (prefs: Record<string, unknown>) => void;

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
  setNativeRuntime(rt: { nativeHost: NativeSessionHost; providerRegistry: ProviderRegistry; modelCatalog: ModelCatalog; engineManager: EngineManager; modelManager: ModelManager; searchKeyStore: SearchKeyStore; searchService: SearchService; permissionStore: PermissionStore; stepGuardSettings: StepGuardSettings; specialistCatalog: SpecialistCatalog; chatgptAuth: ChatGptAuth | null; claudeAccount: ClaudeAccount | null }): void {
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

  /** Session naming, injected from ipc-handlers so a remote client runs the
   *  SAME implementation as the local one — ownership checks, model-catalog
   *  validation and the persist-then-broadcast order included. Absent until
   *  registerIpcHandlers runs; the dispatch below answers honestly meanwhile. */
  setSessionNamingWiring(w: SessionNamingWiring): void { this.sessionNamingWiring = w; }
  private sessionNamingWiring?: SessionNamingWiring;

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
    if (this.running) return { state: 'listening', port: this.config.port };
    if (this.lastStartError) return { state: 'failed', reason: this.lastStartError, port: this.config.port };
    return { state: 'stopped', port: this.config.port };
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
        this.startLiveness();
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
        this.clients.delete(client);
      }
    }
    return true;
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
  private onPermissionExpired = (sessionId: string, requestId: string) => {
    this.bufferHookEvent({ type: 'PermissionResolved', sessionId, payload: { _requestId: requestId }, timestamp: Date.now() } as HookEvent);
    const expired = { type: 'PermissionExpired', sessionId, payload: { _requestId: requestId }, timestamp: Date.now() } as HookEvent;
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
   *  it, a phone reconnecting while a native permission ask was HELD got
   *  nothing, because PermissionHeld is one-shot and the reannounce heartbeat
   *  stops once an ask is held). Reusing hookBuffers — rather than a parallel
   *  native-only map — means the existing replay loop in restoreClient()
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
    // the code now says. Found by writing the behaviour test in remote-rate-limit.test.ts;
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
   *  and the client waits the full 30s request timeout to learn anything is wrong. */
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
          this.clients.delete(client);
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
      this.clients.delete(client);
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
    return type === 'transcript:event' || type === 'transcript:shrink'
      || (type.startsWith('native:') && type !== 'native:shell-event');
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
        const asks = msg.payload?.type === 'PermissionRequest' || msg.payload?.type === 'PermissionHeld';
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
      case 'session:selected':
        // Batch 2 (§2): desktop windows report their selection to main over IPC. A
        // remote client has no desktop window, so it must never write that cache —
        // and gets no answer, as a push never does.
        break;
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
          this.broadcast({ type: 'session:destroyed', payload: { sessionId: payload.sessionId || payload, focus: { sessionId: this.getFocusSessionId() } } });
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
      case 'native:session-context-text': {
        // "What the assistant was given" — one file's text, read on the DESKTOP,
        // where the session and its files live. Without this case the panel opens
        // on a phone and every row reads "This file couldn't be read": the
        // default arm answers {unsupported:true}, which is not an answer.
        const result = this.nativeRuntime
          ? this.nativeRuntime.nativeHost.sessionContextText(payload.sessionId, payload.kind, payload.id)
          : { error: 'not-live' };
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
      // Claude Code's live sign-in (2026-09-09). The DESKTOP's answer, not the
      // browser's: the phone has no `claude` binary, and the session it is
      // driving runs here. `unknown` when the runtime is not wired yet, which
      // every reader treats as available — a remote client must never grey out
      // a model on the strength of a missing object.
      case 'claude-code:status': {
        try {
          const account = this.nativeRuntime?.claudeAccount ?? null;
          if (payload?.refresh) account?.invalidate();
          this.respond(client.ws, type, id, account ? await account.status() : { state: 'unknown' });
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
        // Same answer as main's handler: a failed read is { ok: false, error }, never [] —
        // see listTagsForHost for why.
        const { listTagsForHost } = await import('./conversations/tag-registry-service');
        this.respond(client.ws, type, id, await listTagsForHost());
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
      // Session naming. `unavailable` is answered as a refusal, not silence:
      // the shim's capability probe reads a well-formed preference as "this
      // host can name sessions", so a half-started host must not look ready.
      case 'session-naming:get': {
        const w = this.sessionNamingWiring;
        this.respond(client.ws, type, id, w
          ? await w.get()
          : { ok: false, error: 'The assistant isn’t ready yet.' });
        break;
      }
      case 'session-naming:set': {
        const w = this.sessionNamingWiring;
        this.respond(client.ws, type, id, w
          ? await w.set(payload?.value)
          : { ok: false, error: 'The assistant isn’t ready yet.' });
        break;
      }
      case 'session-naming:title': {
        const w = this.sessionNamingWiring;
        this.respond(client.ws, type, id, w
          ? await w.title(String(payload?.sessionId ?? ''), String(payload?.fallback ?? ''))
          : { title: String(payload?.fallback ?? ''), manual: false });
        break;
      }
      case 'session-naming:rename': {
        const w = this.sessionNamingWiring;
        this.respond(client.ws, type, id, w
          ? await w.rename(String(payload?.sessionId ?? ''), String(payload?.title ?? ''))
          : { ok: false, error: 'The assistant isn’t ready yet.' });
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
        // WHY `unreadable` (error inventory 2026-09-10, false message 12): a missing store
        // and a failed read used to answer blank tags and note, which the close prompt
        // showed as "No note" and then used as the baseline for a note write. Same answer
        // as main's session:get-meta; an absent record is still a real "none".
        let out: { tags: string[]; note: string; supported: boolean; unreadable?: string } = { tags: [], note: '', supported: true };
        // Task 5: resolve through the same map set-tag/set-note use (a latent
        // gap here previously — this handler read the raw id straight through,
        // which only worked by accident for ids that never needed resolving)
        // and read from whichever provider bucket this session actually writes
        // to. No more up-front native refusal — native records are real.
        const rawId = String(payload?.sessionId ?? '');
        const resolved = this.sessionMetaWiring?.resolve(rawId) ?? rawId;
        if (!store) {
          out = { tags: [], note: '', supported: true, unreadable: "conversation storage isn't available" };
        } else {
          try {
            const rec = await store.get(await this.sessionProviderFor(resolved), resolved);
            if (rec) {
              const tags: string[] = [];
              for (const [k, v] of Object.entries(rec.flags)) {
                if ((v as any).value && k.startsWith('tag:')) tags.push(k.slice(4));
              }
              out = { tags, note: rec.note || '', supported: true };
            }
          } catch (e) {
            out = { tags: [], note: '', supported: true, unreadable: e instanceof Error && e.message ? e.message : "the conversation's record could not be read" };
          }
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
      // Read-only lists a phone's screens load at start. Each was "unhandled channel" in the
      // 2026-09-11 phone pass log and its screen fell back to empty. The same functions the
      // desktop handlers call, so the two cannot drift; a failure is answered as a failure
      // (REJECT_ON_NOT_OK in the shim), never as an empty list.
      case 'theme:list': {
        try { this.respond(client.ws, type, id, this.listThemes()); }
        catch (err) { this.respond(client.ws, type, id, { ok: false, error: String((err as Error)?.message ?? err) }); }
        break;
      }
      case 'commands:list': {
        try { this.respond(client.ws, type, id, this.listCommands ? await this.listCommands() : []); }
        catch (err) { this.respond(client.ws, type, id, { ok: false, error: String((err as Error)?.message ?? err) }); }
        break;
      }
      case 'appearance:get-favorite-themes': {
        try { this.respond(client.ws, type, id, this.skillProvider ? this.skillProvider.configStore.getThemeFavorites() : []); }
        catch (err) { this.respond(client.ws, type, id, { ok: false, error: String((err as Error)?.message ?? err) }); }
        break;
      }
      case 'platform:get':
        // The COMPUTER's platform. The screens that ask are about what can be installed or run
        // there (Marketplace integrations; the Linux helper, which is also gated to a desktop).
        this.respond(client.ws, type, id, process.platform);
        break;
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
      // WHY reading a theme file is bridged and nothing else under `theme:` is: the phone
      // ALREADY learns which theme the host is on — `appearance:get` above hands it the
      // slug — and then could not find out what that slug means, because loading the
      // definition went unanswered. So a community theme fell back to a built-in and the
      // phone looked like a different app. Destin's own theme is one (2026-09-10).
      //
      // Read-only, and the same two guards the desktop handler uses: a slug that is not a
      // plain slug is refused, and the resolved path must still be inside the themes
      // directory, so `../` cannot walk out of it. Writing a theme stays desktop-only,
      // like every other change to the host.
      case 'theme:read-file': {
        const slug = String(payload?.slug ?? '');
        if (!/^[a-z0-9_]+(?:-[a-z0-9_]+)*$/.test(slug)) {
          this.respond(client.ws, type, id, { ok: false, error: 'Invalid theme slug' });
          break;
        }
        const { userThemeManifest, THEMES_DIR } = require('./theme-watcher');
        const manifestPath = path.resolve(userThemeManifest(slug));
        if (!manifestPath.startsWith(THEMES_DIR + path.sep)) {
          this.respond(client.ws, type, id, { ok: false, error: 'Invalid theme slug' });
          break;
        }
        try {
          this.respond(client.ws, type, id, await fs.promises.readFile(manifestPath, 'utf-8'));
        } catch {
          // Not installed on this computer. The client keeps the theme it has rather than
          // being handed a fallback it did not choose.
          this.respond(client.ws, type, id, { ok: false, error: 'Theme not found' });
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
      // A theme or display change made on a phone (remote-appearance-relay.test.ts). WHY: a
      // phone used to read the computer's theme once, at page load, and never hear a change
      // after that in either direction (Destin, 2026-09-11: "dev is on meadow mist and remote
      // chose golden daybreak"). The phone has already saved it with appearance:set; this
      // only tells everyone else, the way a desktop window tells its peer windows.
      case 'appearance:broadcast': {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) break;
        this.onAppearanceBroadcast(payload);
        const msg = { type: 'appearance:sync', payload };
        for (const c of this.clients) {
          if (c === client) continue;
          if (c.phase && c.phase !== 'live') { this.enqueueForRestoring(c, msg); continue; }
          if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
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
          const value = getJsonPath(parsed, field);
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
          // setJsonPath refuses __proto__/constructor/prototype segments — a paired
          // remote device reaches this handler (2026-09-10 security review).
          setJsonPath(existing, field, value);
          await fs.promises.mkdir(path.dirname(claudeSettingsPath), { recursive: true });
          await fs.promises.writeFile(claudeSettingsPath, JSON.stringify(existing, null, 2));
          this.respond(client.ws, type, id, true);
        } catch {
          this.respond(client.ws, type, id, false);
        }
        break;
      }
      // The folder picker's five operations: the SAME functions the Electron handlers call
      // (folders-service.ts). WHY: the hand-copied versions here had stopped listing synced
      // projects, so a phone's new-session picker showed only the saved-folders file (Destin,
      // 2026-09-11). The catch answers keep what a phone got before on a failed read or write.
      case 'folders:list': {
        try {
          this.respond(client.ws, type, id, listPickerFolders());
        } catch {
          this.respond(client.ws, type, id, [{ path: os.homedir(), nickname: 'Home', addedAt: Date.now(), exists: true }]);
        }
        break;
      }
      case 'folders:add': {
        try { this.respond(client.ws, type, id, addFolder(payload.folderPath, payload.nickname)); }
        catch { this.respond(client.ws, type, id, null); }
        break;
      }
      case 'folders:remove': {
        try { this.respond(client.ws, type, id, removeFolder(payload.folderPath)); }
        catch { this.respond(client.ws, type, id, false); }
        break;
      }
      case 'folders:rename': {
        try { this.respond(client.ws, type, id, renameFolder(payload.folderPath, payload.nickname)); }
        catch { this.respond(client.ws, type, id, false); }
        break;
      }
      case 'folders:set-description': {
        try { this.respond(client.ws, type, id, setFolderDescription(payload.folderPath, payload.description)); }
        catch { this.respond(client.ws, type, id, false); }
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
      // Host administration does not travel over this socket at all. It stays on desktop
      // IPC, which no remote client can reach.
      //
      // WHY not the old source-address check: it compared client.ip to 127.0.0.1. Behind a
      // loopback bind — which is where this is going — every remote device arrives as
      // 127.0.0.1, so that check would pass for all of them and any paired phone could
      // change the host password, which also throws every other device off. Refusing the
      // whole class is what makes the bind safe. set-config was never checked at all, so a
      // phone could switch remote access off on the computer.
      case 'remote:set-password': {
        this.respond(client.ws, type, id, { ok: false, error: HOST_ADMIN_REFUSAL });
        break;
      }
      case 'remote:set-config': {
        this.respond(client.ws, type, id, { ok: false, error: HOST_ADMIN_REFUSAL });
        break;
      }
      // remote:disconnect-client has NO case on purpose, and this comment is the guard's
      // explanation. It was kept as an explicit `{ok:false}` refusal so an un-upgraded
      // client would be told no rather than met with silence — but that reasoning was
      // backwards. A shim only turns `{ok:false}` into an error for channels in its own
      // REJECT_ON_NOT_OK, and no released version lists this one, so the refusal resolved
      // as an ordinary value: another false success. Falling through to `default:` answers
      // `{unsupported:true}`, which EVERY shim version rejects. Silence was never the
      // alternative; the honest "no" is the one the default already gives.
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
      // WHY this case exists at all: the channel was added to preload, the shim, the
      // desktop IPC handlers and Android — but not here, and this is the host a remote
      // BROWSER talks to. Without it the answer is `{unsupported:true}`, which the shim
      // rejects; the panel asks for it in the same Promise.all as the config, the
      // Tailscale info and the device list, so one missing case opened the whole Remote
      // Access screen blank on a phone. Reading status is not administration — it is the
      // same question the indicator already answers — so it is answered, not refused.
      case 'remote:status': {
        this.respond(client.ws, type, id, this.getStatus());
        break;
      }
      case 'remote:devices:list': {
        this.respond(client.ws, type, id, { devices: this.getDeviceList() });
        break;
      }
      // Renaming and unpairing are host administration: they decide who may reach this
      // computer, so they stay on desktop IPC like the password does. See HOST_ADMIN_REFUSAL.
      case 'remote:devices:rename': {
        this.respond(client.ws, type, id, { ok: false, error: HOST_ADMIN_REFUSAL });
        break;
      }
      case 'remote:devices:unpair': {
        this.respond(client.ws, type, id, { ok: false, error: HOST_ADMIN_REFUSAL });
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

      // --- Files over remote (batch 3, design 2026-09-10 §8, §9) ---
      // The SAME functions the Electron handlers call (artifacts/read-service.ts,
      // project-read-service.ts): same roots, same denylist, same shape, so the
      // phone's Files screens show what the desktop shows (contract R7, R16).
      // The reads carry the phone's preview ceiling; over it the answer is
      // `too-large` with the real size, decided from `stat` — never a prefix.
      // The write channels (save, append-version, import, rename…) are not
      // bridged: editing over remote is not in this batch.
      case 'artifacts:list-session':
      case 'artifacts:list-project':
      case 'artifacts:list-all-files':
      case 'artifacts:resolve-path':
      case 'artifacts:get':
      case 'artifacts:read-binary':
      case 'artifacts:search-content':
      case 'artifacts:check-existence':
      case 'project:list-context':
      case 'project:read-context-file':
      case 'project:list-conversations':
      case 'project:repo-info': {
        try {
          this.respond(client.ws, type, id, await this.readFileChannel(type, payload ?? {}));
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: String(err?.message ?? err) });
        }
        break;
      }
      case 'artifacts:watch-project': {
        // Live refresh (contract R12). The watcher refcounts subscribers by a
        // numeric id; a WS client gets its own — negative, so it can never
        // collide with a webContents id — and loses it when its socket closes,
        // the way a destroyed renderer loses its refs. A reconnect is a NEW
        // socket, so the phone re-subscribes (useProjectWatch).
        const projectRoot = payload?.projectRoot;
        // Same root gate as the reads: a watcher is a full tree walk on the
        // main thread (project-watcher.ts measures 310-372 ms on a large
        // folder) and holds OS watch handles, so a phone naming `/usr` or a
        // hundred different roots must be refused (T6 review, finding 3).
        const refused = await this.refuseUnknownRoot(projectRoot);
        if (refused) { this.respond(client.ws, type, id, { ok: false, error: refused.error }); break; }
        const watched = (client.watchedRoots ??= new Set<string>());
        if (!watched.has(projectRoot) && watched.size >= MAX_WATCHED_ROOTS_PER_SOCKET) {
          this.respond(client.ws, type, id, { ok: false, error: 'too-many' });
          break;
        }
        watched.add(projectRoot);
        this.respond(client.ws, type, id, await watchProject(projectRoot, this.watchSubscriberId(client)));
        break;
      }
      case 'artifacts:unwatch-project': {
        const projectRoot = payload?.projectRoot;
        if (typeof projectRoot === 'string' && projectRoot.length > 0 && client.watchId !== undefined) {
          unwatchProject(projectRoot, client.watchId);
          client.watchedRoots?.delete(projectRoot);
        }
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'artifacts:download': {
        // Mint a short-lived link bound to THIS device and THIS socket (§10);
        // the answer's `url` is host-relative and the shim makes it absolute.
        // Refusals (`sensitive`, `outside-roots`, `busy`…) are data the card
        // shows, so this channel must never join REJECT_ON_NOT_OK.
        try {
          // The record route (projectRoot + artifactId) is offered only for a
          // folder the computer shows or a live session runs in; for any other
          // folder the record is IGNORED and the path alone decides (T7 review,
          // finding 4; re-review, finding 6). A session-only folder therefore
          // reaches only files that session recorded (re-review, finding 1).
          const recordRoot = typeof payload?.projectRoot === 'string' && typeof payload?.artifactId === 'string'
            && await this.isKnownRootForRecords(payload.projectRoot);
          const request = recordRoot
            ? { absolutePath: payload.absolutePath, projectRoot: payload.projectRoot, artifactId: payload.artifactId }
            : { absolutePath: payload?.absolutePath };
          this.respond(client.ws, type, id,
            await this.downloads.mint(request, { deviceId: client.deviceId, socketId: client.id }));
        } catch (err: any) {
          // The phone gets an answer instead of a request that never returns.
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

  // --- Files over remote (batch 3) ---

  /**
   * Every root a phone names is checked against the roots the desktop itself
   * shows (saved folders, indexed projects) before any read (design §8 "same
   * roots"; 2026-09-10 review of T6, finding 2). The desktop's renderer only ever
   * asks about roots it was given; a phone's payload is the phone's, and without
   * this every read channel answered for any directory on the computer.
   * Remote-only by design: the desktop's own transport keeps its behaviour.
   *
   * A folder a live session runs in counts ONLY for that session's recorded
   * files (`records: true`): the drawer's list, the existence check, a record
   * read by its id, and Download's record route. WHY: a phone can start a
   * session in any folder — and "No folder" lands in the home folder — so a
   * session folder counting as a full root handed out every file in it by path
   * (T7 re-review, finding 1).
   */
  private sessionRoots(): string[] {
    return this.sessionManager.listSessions().map((s: any) => s?.cwd).filter((c: unknown): c is string => typeof c === 'string' && c.length > 0);
  }

  private isKnownRootForRecords(root: string): Promise<boolean> {
    return isKnownRoot(root, this.sessionRoots());
  }

  private async refuseUnknownRoot(root: unknown, opts: { records?: boolean } = {}): Promise<{ ok: false; error: string } | null> {
    if (typeof root !== 'string' || root.length === 0) return { ok: false, error: 'bad-request' };
    const known = opts.records ? await this.isKnownRootForRecords(root) : await isKnownRoot(root);
    return known ? null : { ok: false, error: 'not-allowed' };
  }

  private async refuseUnknownProject(projectId: unknown, opts: { records?: boolean } = {}): Promise<{ ok: false; error: string } | null> {
    if (typeof projectId !== 'string' || projectId.length === 0) return { ok: false, error: 'bad-request' };
    return (await isKnownProjectRef(projectId, opts.records ? this.sessionRoots() : [])) ? null : { ok: false, error: 'not-allowed' };
  }

  /** A record id the folder's sidecar actually holds. */
  private async refuseUnlessRecorded(root: string, artifactId: string): Promise<{ ok: false; error: string } | null> {
    const sidecar = await readSidecarShared(root).catch(() => null);
    const recorded = !!sidecar && !('corrupted' in sidecar) && sidecar.artifacts.some((a) => a.id === artifactId);
    return recorded ? null : { ok: false, error: 'not-allowed' };
  }

  /**
   * The read channels, answered from the shared services with the phone's
   * preview ceilings applied (design §9) after the root gate above. Payloads
   * are the shim's object form (`{ projectRoot, artifactId, full }`), never
   * positional arguments; a malformed one answers `bad-request`, never a Node
   * error's text.
   *
   * A lookup table, not a second `switch`: tests/remote-channel-parity.test.ts
   * reads `case '<channel>':` out of this file to prove the handleMessage
   * switch routes every read, and a `case` here would satisfy that guard for a
   * channel the outer switch had dropped.
   */
  private readonly fileReads: Record<string, (payload: any) => Promise<unknown>> = {
    'artifacts:list-session': async (p) => {
      if (typeof p.sessionId !== 'string') return { ok: false, error: 'bad-request' };
      return (await this.refuseUnknownRoot(p.projectRoot, { records: true })) ?? listSessionFiles(p.sessionId, p.projectRoot);
    },
    'artifacts:list-project': async (p) =>
      (await this.refuseUnknownProject(p.projectId, { records: true })) ?? listProjectFiles(p.projectId, p.opts),
    'artifacts:list-all-files': async (p) =>
      (await this.refuseUnknownProject(p.projectId)) ?? listAllFiles(p.projectId, p.opts),
    // One file path tapped in chat (2026-09-11). A phone can name ANY path
    // here, so: the root gate runs first and nothing is looked up for a folder
    // the computer never showed; and a folder known only because a chat runs
    // there (a phone can start one anywhere, "No folder" lands in home) answers
    // only files that chat recorded — the rule artifacts:get applies — with the
    // same not-tracked whether or not any other path exists (trackedOnly).
    // An unknown folder answers the gate's not-allowed: nothing in it is shared.
    'artifacts:resolve-path': async (p) => {
      if (typeof p.path !== 'string' || p.path.length === 0) return { ok: false, error: 'bad-request' };
      const refused = await this.refuseUnknownRoot(p.projectRoot, { records: true });
      if (refused) return refused;
      const shownByComputer = await isKnownRoot(p.projectRoot);
      return resolveArtifactPath(p.projectRoot, p.path, { trackedOnly: !shownByComputer });
    },
    'artifacts:get': async (p) => {
      if (typeof p.artifactId !== 'string') return { ok: false, error: 'bad-request' };
      // By path inside a folder the computer shows; inside a session-only folder,
      // only a file that session recorded, named by its record id.
      if (await this.refuseUnknownRoot(p.projectRoot)) {
        const refused = (await this.refuseUnknownRoot(p.projectRoot, { records: true }))
          ?? (await this.refuseUnlessRecorded(p.projectRoot, p.artifactId));
        if (refused) return refused;
      }
      return readArtifactText(p.projectRoot, p.artifactId, { full: p.full === true, maxBytes: REMOTE_TEXT_PREVIEW_MAX_BYTES });
    },
    // read-binary carries its own roots check (authorizeBytesRead), on the file itself.
    'artifacts:read-binary': (p) => readArtifactBytes(p.absolutePath, { maxBytes: REMOTE_BINARY_PREVIEW_MAX_BYTES }),
    'artifacts:search-content': async (p) =>
      (await this.refuseUnknownRoot(p.projectRoot)) ?? searchArtifactContent(p.projectRoot, p.query),
    'artifacts:check-existence': async (p) =>
      (await this.refuseUnknownRoot(p.projectRoot, { records: true })) ?? checkArtifactExistence(p.projectRoot, p.artifactIds),
    'project:list-context': async (p) =>
      (await this.refuseUnknownRoot(p.projectPath)) ?? listContextFiles(p.projectPath),
    'project:read-context-file': async (p) => {
      if (typeof p.absolutePath !== 'string') return { ok: false, error: 'bad-request' };
      return (await this.refuseUnknownRoot(p.projectPath)) ?? readContext(p.projectPath, p.absolutePath);
    },
    'project:list-conversations': async (p) =>
      (await this.refuseUnknownRoot(p.projectPath)) ?? listConversations(p.projectPath),
    'project:repo-info': async (p) =>
      (await this.refuseUnknownRoot(p.projectPath)) ?? repoInfo(p.projectPath),
  };

  private readFileChannel(type: string, payload: any): Promise<unknown> {
    const read = this.fileReads[type];
    return read ? read(payload) : Promise.resolve({ ok: false, error: `Not a file read channel (${type}).` });
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

