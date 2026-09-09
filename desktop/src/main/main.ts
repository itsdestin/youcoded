import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, safeStorage, screen, shell, webContents } from 'electron';
import path from 'path';
// A write to a closed stdout/stderr throws EPIPE, and with no listener that is
// an uncaught exception that kills the whole main process — the app dies with
// "A JavaScript error occurred in the main process" over a LOG LINE.
//
// This is not hypothetical: it crashed a dev instance on 2026-07-20 when the
// launching shell's pipe closed while RemoteServer was warning about unbridged
// remote channels. Any detached launch, piped log, or parent exiting first
// reproduces it in production.
//
// Registered at import time, before anything can log. Swallowing is correct
// here: if the pipe is gone there is nowhere to report, and the file logger in
// ./logger is the durable path anyway.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err?.code === 'EPIPE') return;
    // Anything else is unexpected — surface via the file log, never by
    // re-writing to the stream that just failed.
  });
}
import os from 'os';
import fs from 'fs';
import { SessionManager } from './session-manager';
import { HookRelay } from './hook-relay';
import { WindowRegistry } from './window-registry';
import { PendingAcquireQueue } from './pending-acquire';
import { registerIpcHandlers, buddyShowRefusal, cachedBuddyHelperStatus, refreshBuddyHelperStatus, setBuddyHelperLostHandler } from './ipc-handlers';
import { RemoteServer } from './remote-server';
import { RemoteConfig } from './remote-config';
import { LocalSkillProvider } from './skill-provider';
import { CommandProvider } from './command-provider';
import { IPC, PermissionOverrides, PERMISSION_OVERRIDES_DEFAULT, type AttentionState, type AttentionSummary, type AttentionReport, type SessionOwnershipAcquired } from '../shared/types';
import { VITE_DEV_PORT } from '../shared/ports';
import { MOUNT_PROBE_JS } from './dev-mount-probe';
import { log, rotateLog } from './logger';
import { registerThemeProtocol } from './theme-protocol';
import { FirstRunManager, markSetupCompleted, setupIsUsable } from './first-run';
import type { FirstRunState } from '../shared/first-run-types';
// Sign in with ChatGPT (backend design 2026-09-05 §1): the account object is
// built HERE, inside createWindow, and handed to the IPC layer and both
// first-run managers. It needs its own SecretsStore over the same encrypted
// file ipc-handlers' store uses (precedent: mcp-reconciler.ts) — one file, one
// lock, two readers.
import { ChatGptAuth } from './providers/chatgpt-auth';
import { SecretsStore } from './providers/secrets-store';
import { SyncService } from './sync-service';
import { setSyncService, getSyncConfig } from './sync-state';
// Cross-device sync spaces (spec 2026-07-03) — folder-based sync engine.
import { startSyncSpaces, stopSyncSpaces, setSyncSpacesRemoteBroadcaster, setSyncSpacesAuthStore, hubLeaseRequest, setSyncSpacesLeaseEventListener, getManagedRoots, syncSpacesSyncNowAwaited } from './sync-spaces/service';
import { createGithubClient, setGithubClient } from './github-client';
// Plan 2b Task 8: conversation-lease lifecycle. The lease client coordinates
// which device "holds" a conversation so two devices don't append to the same
// transcript. Constructed in the main process (needs userData-scoped device id).
import { getDeviceIdentity, getMachineIdentity } from './device-identity';
import { createLeaseClient, sweepExpiredLeases, sweepLegacyLeaseDir, type LeaseClient } from './conversations/lease-client';
// Plan 2b Task 9: the requester-side takeover flow (ask-hand-off, poll, pull,
// acquire). Built here where deviceId + hubLeaseRequest + materializeOne +
// syncSpacesSyncNow are all reachable, then passed to registerIpcHandlers.
import { createRequesterTakeover } from './conversations/takeover';
import { upsertSelf } from './sync-spaces/device-registry';
// Conversation Store (Phase 2a): records + transcript sync ride the personal
// space. Imported statically like the sync-spaces stop so the non-async quit
// handler can call stopConversationStore() directly.
import { startConversationStore, stopConversationStore, materializeOne, resumeSweeps, HANDOFF_SYNC_TIMEOUT_MS } from './conversations/service';
import { runSlugRepair } from './conversations/slug-repair';
import { startChatsearchIndex, stopChatsearchIndex } from './chatsearch-index/index-service';
import { startOutboxDrain, stopOutboxDrain } from './chatsearch-index/outbox-drain';
// One-time cleanup of the legacy sync-service's slug-symlink aggregation (Plan 2c).
import { sweepProjectSymlinks } from './conversations/symlink-sweep';
import { startTagRegistry } from './conversations/tag-registry-service';
import { createAuthStore } from './marketplace-auth-store';
import { registerMarketplaceApiHandlers } from './marketplace-api-handlers';
import { reconcileInstalls } from './install-reconcile';
import { registerSocialHandlers, destroySocialHandlers } from './social-handlers';
import { registerArcadeHandlers } from './arcade-handlers';
import { registerVoiceHandlers, shutdownVoiceHandlers } from './voice/voice-handlers';
import { requestChatSnapshot } from './chat-snapshot';
import { BuddyWindowManager } from './buddy-window-manager';
import { BuddyOverlayManager, OVERLAY_TITLE } from './buddy-overlay-manager';
import { chooseBuddyStrategy } from './buddy-manager';
import type { BuddyManager } from './buddy-manager';
import { applyKwinKeepAbove } from './kwin-keep-above';
import { BAR_SIZE, MASCOT_SIZE, CHAT_SIZE } from './buddy-bar-geometry';
// The KDE script that lets the buddy move itself on a Wayland desktop, and
// the lookup that asks KDE how much of the screen the taskbar has taken.
import { syncHelperOnLaunch } from './kwin-helper';
import { WorkAreaResolver } from './buddy-work-area';
import { excludeFromCapture, nativeCaptureExclusionAvailable } from './window-exclude-capture';
import { cleanupStaleDownloads } from './update-installer';
import { runAnalyticsOnLaunch } from './analytics-service';
import { loadConfigSync, setAppliedAtLaunch, setCachedGpu } from './performance-config';
import { perfMark } from './perf-marks';

// Perf lab instrumentation: perfMark() is a no-op unless YOUCODED_PERF_LOG is
// set, so these calls cost nothing in a normal launch. The names below are a
// wire contract with youcoded-dev/scripts/perf-lab, which parses them verbatim
// and derives each boot chore's duration from the gap between consecutive
// marks — so keep them in execution order and don't rename one in isolation.
//
// WHY "imports-done" and not "module-start": tsconfig sets "module": "commonjs",
// so TypeScript emits all 46 import declarations above as require() calls at the
// top of the file, in source order. Every transitive main-process dependency has
// therefore already been loaded and evaluated by the time this line runs — this
// mark is the END of the import phase, not the start of the module.
perfMark('main:imports-done');

// Last-resort safety net for async work nobody awaited. The main process runs
// a lot of fire-and-forget I/O (watchers, poll timers, disk caches, loadURL);
// under Node's default --unhandled-rejections=throw a single stray rejection
// takes the whole app down, losing every open session. Logging and continuing
// is strictly better: the app stays up and the real reason lands in the log
// instead of a silent exit. These are NOT a license to drop .catch() at call
// sites — a rejection reaching here is a bug worth fixing at its source.
// Registering this listener is also what DISABLES Node's default conversion of
// an unhandled rejection into a fatal uncaughtException — so this one handler
// is the whole fix. No uncaughtException handler is added on purpose: a genuine
// synchronous throw can leave state corrupt, and swallowing it is worse.
process.on('unhandledRejection', (reason) => {
  log('ERROR', 'main', 'unhandled promise rejection', {
    reason: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
  });
});

// macOS and Linux Electron apps may inherit a minimal PATH that's missing
// common tool locations (Homebrew, nvm, Volta, pipx, cargo). macOS Finder/Dock
// only provides /usr/bin:/bin:/usr/sbin:/sbin. Linux Snap/Flatpak/some DEs may
// also strip user paths. Prepend common locations on both platforms.
if (process.platform === 'win32') {
  // Windows IS affected too (the old comment here claimed otherwise). The Claude
  // Code native installer drops claude.exe in %USERPROFILE%\.local\bin and does
  // NOT always register that dir on the user PATH — verified 2026-05-30: a real
  // first-run install printed "Native installation exists but
  // C:\Users\...\.local\bin is not in your PATH". which.sync('claude') only
  // resolves what's on process.env.PATH, so without this, both prereq detection
  // AND session launch fail (pty-worker forks inherit this process's PATH).
  // Prepend the dir so YouCoded finds Claude with zero user PATH edits.
  const localBin = path.join(os.homedir(), '.local', 'bin');
  const parts = (process.env.PATH ?? '').split(path.delimiter);
  if (!parts.includes(localBin)) {
    process.env.PATH = `${localBin}${path.delimiter}${process.env.PATH ?? ''}`;
  }
} else if (process.platform === 'darwin' || process.platform === 'linux') {
  const home = os.homedir();
  const extraPaths = [
    `${home}/.local/bin`,         // pipx, cargo, etc.
    `${home}/.nvm/current/bin`,   // nvm
    `${home}/.volta/bin`,         // Volta
    `${home}/.npm-global/bin`,    // npm global installs
    '/usr/local/bin',             // system-wide installs / Homebrew (Intel)
  ];
  if (process.platform === 'darwin') {
    extraPaths.unshift('/opt/homebrew/bin');  // Homebrew (Apple Silicon)
    // User-local Node installed by first-run installer (tarball extract,
    // no sudo). Must be on PATH at startup so node/npm/claude resolve on
    // subsequent launches without re-running the installer.
    extraPaths.unshift(
      `${home}/Library/Application Support/YouCoded/node/bin`,
    );
  }
  process.env.PATH = `${extraPaths.join(path.delimiter)}${path.delimiter}${process.env.PATH}`;
}


let mainWindow: BrowserWindow | null = null;
// Module-level ref so createAppWindow's 'closed' handler can reach the buddy
// manager (defined later inside the ready-handler closure), whichever
// implementation is active — BuddyWindowManager (three windows) today,
// BuddyOverlayManager (one DOM overlay, Linux Wayland) from Task 3. Typed as
// the BuddyManager interface so this call site never depends on which one it
// is. Assigned once during setup; `createAppWindow` uses it to hide the
// buddy when the last main window closes (spec §7.6).
let buddyManagerRef: BuddyManager | null = null;
let cleanupIpcHandlers: (() => Promise<void>) | null = null;
// Sign in with ChatGPT: module scope only so runShutdown can dispose it (stops
// the usage poll, closes a lingering sign-in listener). Assigned in createWindow.
let chatgptAuth: ChatGptAuth | null = null;
// Plan 2b Task 8: the conversation-lease client + this install's device identity.
// Constructed inside createWindow (before registerIpcHandlers) but referenced
// again in the app-ready sync block, so they live at module scope. The holder
// takeover handler is routed through a mutable ref that ipc-handlers fills in
// (it needs sessionIdMap, which is local to registerIpcHandlers).
let leaseClient: LeaseClient | null = null;
let deviceIdentity: { id: string } | null = null;
// The per-MACHINE id backing the device registry — distinct from deviceIdentity
// (per-INSTALL, for leases). null = no durable machine identity: register nothing.
let machineIdentity: { id: string } | null = null;
const holderTakeoverRef: { fn: (sessionId: string, from?: { deviceId: string; device: string }) => void } = { fn: () => {} };
const sessionManager = new SessionManager();

// Multi-window ownership: maps sessionId -> windowId and tracks leader for
// singletons (PartyKit lobby). Populated when sessions are created and
// when windows spawn/close. See window-registry.ts.
const windowRegistry = new WindowRegistry();

// Ownership handoffs that arrived before their target window could listen.
// See pending-acquire.ts for the full WHY — short version: `webContents.send`
// into a not-yet-mounted renderer is dropped, never queued, so a tear-off's
// handoff has to be pulled by the renderer rather than pushed at it.
const pendingAcquire = new PendingAcquireQueue<SessionOwnershipAcquired>();

// IDs in the registry are webContents.id values, NOT BrowserWindow.id values.
// BrowserWindow.fromId(webContentsId) silently returns null, so previously
// every peer-window send fell through to the mainWindow fallback (window 1
// received events meant for window 2/3/etc). Always look up via webContents.
function windowFromWcId(wid: number): BrowserWindow | null {
  const wc = webContents.fromId(wid);
  return wc ? BrowserWindow.fromWebContents(wc) : null;
}

// Broadcast the current window directory to every renderer whenever windows
// or ownership change. The directory drives the "Sessions in other windows"
// group in the switcher.
let currentLeaderId = -1;
function broadcastWindowState() {
  const dir = windowRegistry.getDirectory((id) => sessionManager.getSession(id));
  const newLeader = windowRegistry.getLeaderId() ?? -1;
  for (const wid of windowRegistry.getWindowIds()) {
    const win = windowFromWcId(wid);
    if (!win || win.isDestroyed()) continue;
    win.webContents.send(IPC.WINDOW_DIRECTORY_UPDATED, dir);
    if (newLeader !== currentLeaderId) {
      win.webContents.send(IPC.WINDOW_LEADER_CHANGED, newLeader);
    }
  }
  currentLeaderId = newLeader;
}
windowRegistry.on('changed', broadcastWindowState);


// Unique pipe name per launch — avoids EADDRINUSE from stale Electron processes
const pipeName = process.platform === 'win32'
  ? `\\\\.\\pipe\\claude-desktop-hooks-${process.pid}`
  : path.join(os.tmpdir(), `claude-desktop-hooks-${process.pid}.sock`);
sessionManager.setPipeName(pipeName);
const hookRelay = new HookRelay(pipeName);
// Hold /reload-plugins broadcasts away from sessions whose TUI is showing a
// live permission/AskUserQuestion menu — typing into that menu presses Enter
// on the highlighted option and silently answers the prompt (stray-Enter fix).
sessionManager.setReloadPluginsGate((sessionId) => hookRelay.hasPendingPermission(sessionId));
const remoteConfig = new RemoteConfig();
const skillProvider = new LocalSkillProvider();
skillProvider.ensureMigrated();
// Fix (Track B minor hardening review): ensureBundledPluginsInstalled() and
// repairPackageVersions() both write ~/.claude/youcoded-skills.json's
// `packages` map. Firing them back to back with two bare `void` calls only
// stayed safe because reconcileBundledPlugins() (called by
// ensureBundledPluginsInstalled) suspends at its first `await this.fetchIndex()`
// before any recordPackageInstall/updatePackageVersion call, so repair's
// fully-synchronous body always ran to completion first by accident — add
// one `await` inside repairPackageVersions() later and the two would
// silently interleave writes to the same in-memory config object. Wrapping
// in an async IIFE makes the ordering explicit: repair (still synchronous
// today, so this costs nothing at boot) completes before reconcile is even
// started. See the WHY on repairPackageVersions() in skill-provider.ts for
// what breaks without the repair (permanently stale "Update available"
// state for every in-repo plugin other than the three bundled ids).
void (async () => {
  await skillProvider.repairPackageVersions();
  // Fire-and-forget: install bundled plugins if missing. Silent retry on
  // every launch. See docs/superpowers/specs/2026-04-20-bundled-default-plugins-design.md.
  void skillProvider.ensureBundledPluginsInstalled();
})();

// commandProvider is constructed after skillProvider so it can read skills
// for dedup. getProjectCwd returns the most recently active session's cwd,
// or null if no sessions exist yet.
const commandProvider = new CommandProvider(
  () => skillProvider.getInstalled(),
  () => {
    const sessions = sessionManager.listSessions();
    return sessions[0]?.cwd ?? null;
  },
);

// When skills change (plugin install/uninstall), invalidate the command
// cache so skill-name dedup re-evaluates.
skillProvider.setCacheInvalidationListener(() => commandProvider.invalidateCache());
// Pass a snapshot provider so RemoteServer can request the full chat state from
// the renderer when new remote clients connect. The closure captures mainWindow
// by reference — mainWindow is null here but will be set before any client
// can connect (the server only starts after the window is created).
const remoteServer = new RemoteServer(sessionManager, hookRelay, remoteConfig, skillProvider, {
  requestSnapshot: () => {
    if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve({ sessions: [] });
    return requestChatSnapshot(mainWindow.webContents);
  },
});

// Dev server URL — env override wins; otherwise compute from YOUCODED_PORT_OFFSET
// (via shared/ports.ts) so Vite and main stay in sync without a second env var.
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || `http://localhost:${VITE_DEV_PORT}`;

// Dev-profile isolation: any non-empty YOUCODED_PROFILE marks this as a dev
// instance. userData is named after the profile so concurrent dev instances
// (e.g. YOUCODED_PROFILE=dev2) don't share state with each other or with the
// built app. The install-hooks gate below uses the same "profile set" test —
// positive match instead of a strict string compare so typos or variants
// (dev2, feature-x, etc.) can't accidentally re-enable hook installation.
// Must be called before app.whenReady().
const DEV_PROFILE = process.env.YOUCODED_PROFILE;
// Captured BEFORE the override below, so this is the BUILT app's userData dir even
// in a dev instance — Electron derives it from the app name, so nothing here has to
// hardcode 'youcoded' (a productName added to package.json would change it).
// It holds the machine identity backing the device registry: a dev profile READS
// this dir rather than minting its own id. See device-identity.ts.
const BUILT_APP_USER_DATA = app.getPath('userData');
if (DEV_PROFILE) {
  app.setPath('userData', path.join(app.getPath('appData'), `youcoded-${DEV_PROFILE}`));
  app.setName(DEV_PROFILE === 'dev' ? 'YouCoded Dev' : `YouCoded Dev (${DEV_PROFILE})`);
}

// Dev-only window title suffix, so several concurrent dev instances are
// distinguishable in the OS taskbar / Alt-Tab / window switcher (the app's own
// titlebar is hidden, but the WM still uses this title). `YOUCODED_DEV_LABEL` is
// the human-readable descriptor run-dev.sh passes (e.g. "UI Consistency"); with
// no label we fall back to the profile so a dev window is never just "YouCoded".
// UNDEFINED in production (neither env var set) — the built app keeps the plain
// "YouCoded" title from index.html untouched.
const DEV_LABEL = process.env.YOUCODED_DEV_LABEL?.trim();
const DEV_WINDOW_TITLE =
  DEV_LABEL ? `YouCoded - ${DEV_LABEL}`
  : DEV_PROFILE && DEV_PROFILE !== 'dev' ? `YouCoded Dev (${DEV_PROFILE})`
  : DEV_PROFILE ? 'YouCoded Dev'
  : undefined;

// The name a buddy window carries when it is NOT being positioned by rename
// (i.e. everywhere except native-Wayland Linux with the helper running). It is
// exactly the title src/renderer/index.html supplies, so freezing the name here
// changes nothing anybody can see: buddy windows are frameless and kept out of
// the taskbar, and the only reason to freeze it at all is that the page's own
// title event would otherwise overwrite a rename mid-drag.
const BUDDY_WINDOW_TITLE = 'YouCoded';

// Windows AUMID alignment: electron-builder's NSIS installer stamps the Start
// Menu shortcut with an AppUserModelID derived from `appId`. If the runtime
// process's AUMID doesn't match, Windows resolves the taskbar button's icon
// via the shortcut's AUMID (i.e. the embedded exe .ico) and silently ignores
// BrowserWindow.setIcon() updates. That's why theme-driven icon hot-swap
// worked in dev (no installer shortcut, so setIcon wins) but not in packaged
// builds. Must be called before any BrowserWindow is created.
// See: electron-builder NSIS docs + electron/electron#28581.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.youcoded.desktop');
}

// Must be called before app.whenReady() — Electron requirement
protocol.registerSchemesAsPrivileged([
  { scheme: 'theme-asset', privileges: { bypassCSP: true, supportFetchAPI: true, stream: true } },
]);

// --- Permission override classification ---
// In bypass mode, Claude Code still fires PermissionRequest for protected paths,
// compound cd commands, and AskUserQuestion. These regexes classify each request
// so the user's per-category overrides can selectively auto-approve them.

const TITLE_HOOK_RE = /[>|].*[/\\]\.claude[/\\]topics[/\\]topic-/;
const CONFIG_FILE_RE = /\.(bashrc|bash_profile|zshrc|zprofile|profile|gitconfig|gitmodules|ripgreprc)\b|\.mcp\.json|\.claude\.json/;
const PROTECTED_DIR_RE = /[/\\]\.git[/\\]|[/\\]\.claude[/\\]/;
const CD_REDIRECT_RE = /\bcd\b.*[>]/;
const CD_GIT_RE = /\bcd\b.*\bgit\b/;

type PermissionCategory =
  | 'titleHook'
  | 'protectedConfigFiles'
  | 'protectedDirectories'
  | 'compoundCdRedirect'
  | 'compoundCdGit'
  | 'unknown';

function classifyPermission(toolName: string, toolInput?: Record<string, unknown>): PermissionCategory {
  const cmd = (toolInput?.command as string) || '';
  const filePath = (toolInput?.file_path as string) || '';
  const target = cmd || filePath;

  // Title hook — always auto-approved, checked first
  if (toolName === 'Bash' && TITLE_HOOK_RE.test(cmd)) return 'titleHook';

  // Compound cd patterns (Bash only) — check before path-based patterns
  // because a single command can match both (e.g., cd /tmp && echo > .git/config)
  if (toolName === 'Bash') {
    if (CD_GIT_RE.test(cmd)) return 'compoundCdGit';
    if (CD_REDIRECT_RE.test(cmd)) return 'compoundCdRedirect';
  }

  // Protected config files
  if (CONFIG_FILE_RE.test(target)) return 'protectedConfigFiles';

  // Protected directories (.git/, .claude/)
  if (PROTECTED_DIR_RE.test(target)) return 'protectedDirectories';

  return 'unknown';
}

// In-memory cache of user's permission overrides, loaded from defaults file
// and updated by ipc-handlers.ts whenever defaults:set is called.
let permissionOverrides: PermissionOverrides = { ...PERMISSION_OVERRIDES_DEFAULT };

/** Called by ipc-handlers.ts on startup and after each defaults:set. */
export function setPermissionOverrides(overrides: Partial<PermissionOverrides>) {
  permissionOverrides = { ...PERMISSION_OVERRIDES_DEFAULT, ...overrides };
}

function registerFirstRunIpc(
  mainWindow: BrowserWindow,
  firstRunManager: FirstRunManager,
  // Sign in with ChatGPT (backend design 2026-09-05 §5): the wizard's "Sign in
  // with ChatGPT" button routes through here to the SAME account object the
  // Settings card uses, so a sign-in finished in the wizard is signed in everywhere.
  chatgptAuth: ChatGptAuth,
) {
  // Push state updates to renderer
  firstRunManager.on('state-changed', (state) => {
    try {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.FIRST_RUN_STATE, state);
      }
    } catch {}
  });

  // launch-wizard just signals completion — the renderer transitions to normal
  // mode where the user clicks "New Session." No session auto-creation avoids
  // timing issues between the first-run UI transition and session event handling.
  firstRunManager.on('launch-wizard', () => {
    log('INFO', 'FirstRun', 'First-run complete, transitioning to normal app');
  });

  ipcMain.handle(IPC.FIRST_RUN_STATE, async () => {
    try { return firstRunManager.getState(); }
    catch { return { currentStep: 'COMPLETE' }; }
  });

  ipcMain.handle(IPC.FIRST_RUN_RETRY, async () => {
    try { await firstRunManager.retry(); }
    catch (e) { log('ERROR', 'FirstRun', 'Retry failed', { error: String(e) }); }
  });

  ipcMain.handle(IPC.FIRST_RUN_START_AUTH, async (_event, mode: FirstRunState['authMode']) => {
    try {
      if (mode === 'oauth') {
        // claude auth login opens the browser itself — don't double-open
        await firstRunManager.handleOAuthLogin();
      } else if (mode === 'chatgpt') {
        // Opens the browser through ChatGptAuth and waits for the callback.
        // handleChatGptLogin catches signIn()'s own throws (port 1455 held,
        // no keychain) into lastError itself — the catch below is only the
        // last resort, since a swallowed throw here would leave the wizard's
        // button silently doing nothing.
        await firstRunManager.handleChatGptLogin(chatgptAuth);
      } else if (mode === 'openrouter') {
        // The approved card has the button; the sign-in is not built yet, and
        // a button that does nothing was review R1-6.
        firstRunManager.handleOpenRouterNotBuilt();
      }
    } catch (e) { log('ERROR', 'FirstRun', 'Auth failed', { error: String(e) }); }
  });

  ipcMain.handle(IPC.FIRST_RUN_SUBMIT_API_KEY, async (_event, key: string) => {
    try { await firstRunManager.handleApiKeySubmit(key); }
    catch (e) { log('ERROR', 'FirstRun', 'API key submit failed', { error: String(e) }); }
  });

  ipcMain.handle(IPC.FIRST_RUN_DEV_MODE_DONE, async () => {
    try { await firstRunManager.handleDevModeDone(); }
    catch (e) { log('ERROR', 'FirstRun', 'Dev mode failed', { error: String(e) }); }
  });

  ipcMain.handle(IPC.FIRST_RUN_SKIP, async () => {
    // One writer for the setup-completed flag (first-run.ts). WHY: it is the
    // only place that knows WHERE the wizard's files live, so a dev instance
    // pointed at a scratch folder cannot write the installed app's config.
    markSetupCompleted();
    // Transition the state machine so the renderer's onStateChanged fires
    firstRunManager.skip();
  });

  // Start the first-run flow (async, doesn't block)
  firstRunManager.run().catch((e) => {
    log('ERROR', 'FirstRun', 'Run failed', { error: String(e) });
  });
}

// Module-scope attention aggregator. Declared here (not inside app.whenReady)
// so both createAppWindow's 'closed' handler and the ipcMain.on handler inside
// app.whenReady can close over the same references.
//
// Key: webContents.id of the reporting window.
// Value: Map from sessionId → { attentionState, awaitingApproval }.
//
// Each renderer pushes updates via attention:report whenever the chat reducer's
// ATTENTION_STATE_CHANGED fires. Main aggregates and broadcasts
// session:attention-summary to all windows so buddy mascot can react.
type PerSessionAttention = {
  attentionState: AttentionState;
  awaitingApproval: boolean;
  // Derived dot color computed by the reporting renderer's sessionStatuses
  // useMemo. We just forward it — the main window owns the derivation so
  // the buddy's dot matches the main switcher's dot exactly.
  status?: import('../shared/types').SessionStatusDotColor;
};
const attentionReports = new Map<number, Map<string, PerSessionAttention>>();

// WHY (2026-09-07): split out of recomputeAndBroadcastAttention so the same
// aggregate can also be PULLED. SESSION_ATTENTION_SUMMARY is push-on-change
// only, so a window that just opened hears nothing until some session's state
// next flips — leaving a peer session that is already mid-turn reading gray in
// its switcher. Renderers call attention.getSummary() once on mount for the
// current snapshot (same pull-vs-race reason as detach.getDirectory).
function buildAttentionSummary(): AttentionSummary {
  const perSession: Record<string, PerSessionAttention> = {};
  let anyNeedsAttention = false;
  for (const byWin of attentionReports.values()) {
    for (const [sid, state] of byWin) {
      perSession[sid] = state;
      // 'ok' and 'session-died' are passive states — only non-ok, non-died
      // states (stuck, awaiting-input, shell-idle, error) plus active
      // awaiting-approval tools count as needing attention.
      if (state.awaitingApproval || (state.attentionState !== 'ok' && state.attentionState !== 'session-died')) {
        anyNeedsAttention = true;
      }
    }
  }
  return { anyNeedsAttention, perSession };
}

function recomputeAndBroadcastAttention(): void {
  const summary = buildAttentionSummary();
  const anyNeedsAttention = summary.anyNeedsAttention;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.SESSION_ATTENTION_SUMMARY, summary);
  }
  // Dock/peek activity signal: attention pops a peeking buddy out (spec §6.2).
  buddyManagerRef?.setAttentionNeeded(anyNeedsAttention);
}

// 100ms debounce — coalesces bursts of classifier transitions so buddy
// doesn't get flooded when multiple sessions update in quick succession.
const debouncedBroadcastAttention = (() => {
  let t: NodeJS.Timeout | null = null;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(recomputeAndBroadcastAttention, 100);
  };
})();

// Shared BrowserWindow factory — used for the primary window AND for peer
// windows spawned by the detach subsystem. Keeps webPreferences, security
// hardening, and fullscreen relay consistent across every window so renderers
// don't have to guess which features are available.
/**
 * Dev-only self-healing for Vite-served windows (recurring first-launch
 * failure, diagnosed 2026-07-16): on a cold Vite dependency cache the first
 * window load fires a storm of unbundled module requests plus a mid-load
 * full-reload; Chromium's network service has crashed under it ("Network
 * service crashed or was terminated"), aborting every in-flight request and
 * leaving a permanently blank window — the only remedy was restarting dev.
 * Three recovery paths, because the failure shows up three ways:
 *  - did-fail-load: the main document itself failed to load (also covers
 *    "Electron reached the URL before Vite was actually serving");
 *  - render-process-gone: the renderer process died outright;
 *  - blank-mount watchdog: the document loaded but its module scripts were
 *    aborted mid-boot, so React never mounted and NO failure event fires —
 *    this is the network-service-crash signature. Also fires after a WiFi
 *    disconnect/reconnect (ERR_NETWORK_CHANGED aborts loopback fetches too),
 *    which can outlast any fixed retry budget — hence unbounded retries with
 *    capped backoff (see retry()'s WHY comment).
 * The watchdog is the ONLY path that covers the aborted-sub-resource case, and
 * it silently stopped covering it between 2026-07-20 and 2026-07-26: its probe
 * read `#root.childElementCount`, and index.html began painting the boot
 * skeleton inside `#root`, so every stranded window reported "mounted". The
 * probe now lives in ./dev-mount-probe.ts, pinned against the real index.html by
 * tests/dev-load-recovery.test.tsx — do not inline a new one here. Neither
 * sibling path can substitute: did-fail-load never fires (index.html itself
 * loads 200) and render-process-gone never fires (the renderer stays alive).
 * Prod loads local files and is deliberately untouched (callers gate on
 * !app.isPackaged).
 */
function wireDevLoadRecovery(win: BrowserWindow, devUrl: string): void {
  let attempts = 0;
  const retry = (why: string) => {
    if (win.isDestroyed()) return;
    attempts += 1;
    // WHY unbounded (2026-07-23 network-flap lesson): a WiFi
    // disconnect/reconnect makes Chromium abort EVERY in-flight request
    // (ERR_NETWORK_CHANGED) — loopback Vite fetches included. The old fixed
    // 5-attempt budget could be entirely spent while the network was still
    // flapping, and with the budget gone the window sat on the pre-React
    // spinner forever. Retrying forever is safe here: the blank-mount
    // watchdog fires at most once per ~(delay + 8s) cycle, the -3 guard
    // below already excludes the reload-storm case the cap was protecting
    // against, and this whole function is dev-only (prod loads local files).
    const delaySeconds = Math.min(attempts, 5);
    console.warn(`[dev-recovery] renderer load failed (${why}) — retry ${attempts} in ${delaySeconds}s`);
    setTimeout(() => {
      // .catch is not error handling here — `did-fail-load` below is what
      // actually drives recovery. This only stops a rejected load (ERR_ABORTED
      // on a racing reload) from surfacing as an unhandled rejection.
      if (!win.isDestroyed()) void win.loadURL(devUrl).catch(() => {});
    }, delaySeconds * 1000);
  };
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    // -3 = ERR_ABORTED: fired by Vite's own full-reloads and by a loadURL
    // superseding an in-flight load — retrying on it would loop forever.
    if (isMainFrame && errorCode !== -3) retry(`did-fail-load ${errorCode} ${errorDescription}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit') retry(`render-process-gone: ${details.reason}`);
  });
  win.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      if (win.isDestroyed()) return;
      win.webContents
        .executeJavaScript(MOUNT_PROBE_JS)
        .then((mounted) => {
          if (mounted) attempts = 0; // healthy — future incidents get a fresh retry budget
          else retry('blank renderer — React never mounted');
        })
        .catch(() => { /* window closed or JS context torn down — nothing to heal */ });
    }, 8000);
  });
}

function createAppWindow(opts?: { x?: number; y?: number; width?: number; height?: number; maximize?: boolean; inactive?: boolean; buddy?: 'mascot' | 'chat' | 'bar' | 'overlay'; buddyTitle?: string }): BrowserWindow {
  const iconPath = path.join(__dirname, '../../assets/icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  const isMac = process.platform === 'darwin';

  // Buddy windows use a pure-transparent Electron surface — the "glass"
  // effect is produced entirely in CSS (see buddy.css). We explored native
  // OS glass (Win 11 backgroundMaterial:'acrylic', macOS vibrancy) but
  // every path had deal-breakers:
  //   - Electron 41 frameless bug #38466/#39959: backgroundMaterial silently
  //     fails when applied at construction on frameless windows
  //   - OS-level fallback: Windows "Transparency effects" OFF or Energy
  //     Saver ON silently drops acrylic to a solid dark fallback, and we
  //     can't depend on user OS settings
  //   - Corner-sliver mismatch: OS ~8px radius vs CSS 18px radius leaves
  //     visible acrylic strips in the 4 corners
  // Instead, glass is faked in CSS via theme-driven panel tint + gradient
  // overlay + inner-edge highlight + drop shadow. Modern design systems
  // (Fluent, Material, Apple HIG) do this too — the "glass" readability
  // comes from surface tonality, not from crisp real-blur of content behind.
  // Tradeoff: the ~10% of the user's desktop visible through the bubble is
  // unblurred. Acceptable; nothing else is OS-independent.
  //
  // These flags together kill every OS paint source that could show as a
  // faint rectangle around transparent web content:
  //  - transparent:true + backgroundColor:'#00000000' = RGBA (0,0,0,0)
  //    native surface (Electron on some Win builds paints an opaque default
  //    behind web content without this)
  //  - thickFrame:false drops WS_THICKFRAME, which otherwise leaves a DWM
  //    shadow + window-animation chrome visible as a faint rectangle
  //  - roundedCorners:false: Windows 11 rounds frameless windows by default;
  //    on the 80×80 mascot that reads as a visible 8px radius border
  const buddyExtras: Electron.BrowserWindowConstructorOptions = opts?.buddy
    ? {
        transparent: true,
        frame: false,
        resizable: false,
        alwaysOnTop: true,
        hasShadow: false,
        skipTaskbar: true,
        backgroundColor: '#00000000',
        thickFrame: false,
        roundedCorners: false,
        autoHideMenuBar: true,
        // Exclude buddy windows from macOS Dock + Mission Control
        ...(isMac ? { type: 'panel' as const } : {}),
      }
    : {};

  // Buddy window dimensions. Every size comes from buddy-bar-geometry.ts so
  // the BrowserWindows and the positioning math can never drift apart — the
  // mascot and chat used to be hardcoded here and the comment had already gone
  // stale against the 112px bump.
  const buddyDimensions: { width?: number; height?: number } = opts?.buddy === 'mascot'
    ? { width: MASCOT_SIZE.width, height: MASCOT_SIZE.height }
    : opts?.buddy === 'chat'
    ? { width: CHAT_SIZE.width, height: CHAT_SIZE.height }
    : opts?.buddy === 'bar'
    ? { width: BAR_SIZE.width, height: BAR_SIZE.height }
    : {};

  const win = new BrowserWindow({
    width: buddyDimensions.width ?? opts?.width ?? 1200,
    height: buddyDimensions.height ?? opts?.height ?? 800,
    x: opts?.x,
    y: opts?.y,
    icon,
    // A buddy window's NAME IS HOW IT GETS POSITIONED on native-Wayland Linux
    // (see shared/buddy-caption.ts), and it has to be right in the constructor:
    // the KWin helper decides whether to watch a window the instant the window
    // appears, so a window born nameless is never watched and the buddy would
    // appear and then refuse to move. Everywhere else buddyTitle is absent and
    // the window simply keeps the plain "YouCoded" name it has today.
    // Non-buddy windows keep the dev-only distinguishing title (DEV_WINDOW_TITLE).
    title: opts?.buddy ? (opts.buddyTitle ?? BUDDY_WINDOW_TITLE) : DEV_WINDOW_TITLE,
    titleBarStyle: opts?.buddy ? undefined : (isMac ? 'hiddenInset' as const : 'hidden' as const),
    // Live tear-off spawns this window mid-drag and needs the source window to
    // keep keyboard/pointer focus. show: false + showInactive() below prevents
    // the OS from focusing the new window on creation.
    // Buddy windows start hidden — BuddyWindowManager will show them explicitly.
    show: !opts?.inactive && !opts?.buddy,
    ...buddyExtras,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Lift alwaysOnTop to 'screen-saver' level for buddy windows after construction.
  // 'screen-saver' is the highest reliable always-on-top level; floats over
  // minimized apps on Win/Mac/Linux. Applied after construction because
  // BrowserWindowConstructorOptions only supports boolean here.
  if (opts?.buddy) {
    win.setAlwaysOnTop(true, 'screen-saver');
    // Exclude buddy windows from OS-level screen capture. Lets the
    // capture-icon action screenshot the desktop underneath without a
    // hide-and-snap flicker, AND keeps the personal floater out of
    // screen shares / Zoom demos / OBS recordings. No-op on platforms
    // without native exclusion support (old Win10 builds, Linux) — the
    // capture handler falls back to opacity dimming in that case.
    excludeFromCapture(win);
  }

  // Keep the window's name stuck. index.html ships `<title>YouCoded</title>`,
  // which fires page-title-updated on load and would clobber the constructor
  // title; the renderer never sets document.title otherwise, so blocking that
  // one event is all it takes.
  //
  // WHY buddy windows are now included, where before they were explicitly
  // excluded: on native-Wayland Linux the buddy's name is the channel that
  // moves him, so the page load would overwrite his coordinates with the word
  // "YouCoded" a fraction of a second after he appeared — and he would sit
  // there, unmovable, for the rest of the session. On every other platform the
  // name it is pinned to is the very same "YouCoded" the page would have set,
  // so nothing observable changes.
  //
  // preventDefault BEFORE setTitle, always: register the block first and the
  // name we set can never be clobbered. Doing it the other way round is a real
  // bug this repo has already shipped once — buddy-overlay-manager.ts:203-209,
  // found live on 2026-07-23.
  if (opts?.buddy) {
    win.on('page-title-updated', (e) => e.preventDefault());
    win.setTitle(opts.buddyTitle ?? BUDDY_WINDOW_TITLE);
  } else if (DEV_WINDOW_TITLE) {
    win.on('page-title-updated', (e) => e.preventDefault());
    win.setTitle(DEV_WINDOW_TITLE);
  }

  if (opts?.inactive) {
    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) return;
      // Re-assert the position right before showing — with show:false, some
      // Electron versions on Windows lose the constructor x/y by the time
      // showInactive() fires, leaving the window at default placement.
      if (opts.x != null && opts.y != null) win.setPosition(opts.x, opts.y);
      win.showInactive();
    });
  }

  // Security: block navigation to external origins (prevents preload API exposure)
  win.webContents.on('will-navigate', (event, url) => {
    const isAppOrigin = url.startsWith('file://') || url.startsWith(DEV_SERVER_URL);
    if (!isAppOrigin) event.preventDefault();
  });
  // Security: deny window.open() but route safe http(s)/mailto to the OS browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Rejects when the OS has no handler for the scheme — nothing to recover,
    // but it must not escape as an unhandled rejection.
    if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url).catch(() => {});
    return { action: 'deny' as const };
  });
  // Disable Chromium's pinch-to-zoom so our IPC zoom handler is the sole zoom path
  void win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});

  if (opts?.maximize) win.maximize();

  // Append mode query param for buddy windows so React can branch on the mode
  const modeQuery = opts?.buddy ? `?mode=buddy-${opts.buddy}` : '';
  if (!app.isPackaged) {
    // YOUCODED_DEV_URL lets dev launchers in the youcoded-dev workspace boot
    // the MAIN window straight into a specific path like ?mode=workbench —
    // avoids the DevTools location.href dance. The env var itself stays; only
    // the example changed when the tool-sandbox route was retired.
    // Only applies to the main window: buddy windows keep their own
    // ?mode=buddy-* routing so the override can't hijack them. Prod (file://)
    // is untouched because this whole branch runs under `!app.isPackaged`.
    const devUrlOverride = !opts?.buddy ? process.env.YOUCODED_DEV_URL : undefined;
    const devUrl = devUrlOverride || `${DEV_SERVER_URL}${modeQuery}`;
    // Rejections are recovered by wireDevLoadRecovery's did-fail-load handler;
    // the .catch only keeps them off the unhandled-rejection path.
    void win.loadURL(devUrl).catch(() => {});
    wireDevLoadRecovery(win, devUrl);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), {
      // loadFile expects search string WITHOUT the leading '?'
      search: modeQuery ? modeQuery.slice(1) : undefined,
      // A failed prod load is surfaced by did-fail-load, not by this promise.
    }).catch(() => {});
  }

  // Auto-open DevTools in dev — the app's menu is nulled so F12/Ctrl+Shift+I
  // don't work by default. Opens detached so it doesn't steal window width.
  // Directory snapshot is pulled by the renderer via WINDOW_GET_DIRECTORY
  // once it mounts, so no push is needed here.
  if (!app.isPackaged) {
    win.webContents.on('did-finish-load', () => {
      if (!win.isDestroyed()) win.webContents.openDevTools({ mode: 'detach' });
    });
  }

  // Fullscreen state relay — per-window so macOS traffic-light padding is correct
  win.on('enter-full-screen', () => {
    if (!win.isDestroyed()) win.webContents.send('window:fullscreen-changed', true);
  });
  win.on('leave-full-screen', () => {
    if (!win.isDestroyed()) win.webContents.send('window:fullscreen-changed', false);
  });

  // Register with the ownership registry so per-session events can route here
  // and (main windows only) the switcher in other windows sees this window in
  // its directory. Buddy windows register as kind 'buddy' so they stay out of
  // the switcher's "Sessions in other windows" group — the floater is not
  // "another window" from the user's point of view — but subscriptions still
  // work (subscribe() rejects unknown ids).
  const wid = win.webContents.id;
  windowRegistry.registerWindow(wid, Date.now(), opts?.buddy ? 'buddy' : 'main');
  win.on('closed', () => {
    // Drop attention reports contributed by this window so stale session
    // states from a closed window don't persist in the aggregated summary.
    attentionReports.delete(wid);
    debouncedBroadcastAttention();
    pendingAcquire.forget(wid);
    windowRegistry.unregisterWindow(wid);
    // Spec §7.6: "Buddy closes with main." If this was the last main window
    // (i.e., all remaining open windows are buddy windows), tear down the
    // buddy so Electron's window-all-closed handler can fire and the app
    // can quit cleanly on Win/Linux. Without this, closing the main window
    // leaves a floating mascot orphaned with no settings UI to reach — the
    // user has to force-quit via Task Manager, which the user just hit.
    if (!opts?.buddy && buddyManagerRef) {
      const mgr = buddyManagerRef;
      const remainingMain = BrowserWindow.getAllWindows().some((w) => {
        if (w === win) return false; // the one closing right now
        if (w.isDestroyed()) return false;
        // Our buddy windows are the two BuddyWindowManager owns. Anything
        // else is a main/peer window.
        return !mgr.isBuddyWindow(w);
      });
      if (!remainingMain) {
        mgr.hide();
      }
    }
  });

  // Confirm-on-close if this window still owns active sessions. Without the
  // prompt, closing a window silently kills every session it owns — which is
  // easy to do by accident and impossible to undo. A guard flag prevents the
  // prompt from re-firing after the user confirms.
  let confirmedClose = false;
  win.on('close', async (ev) => {
    // Buddy windows never own sessions (they only subscribe). Skip the
    // close-confirmation entirely so a floating widget never gets blocked
    // by a "kill sessions?" dialog that wouldn't make sense in that UI.
    if (opts?.buddy) return;
    if (confirmedClose) return;
    const ownedSessions = windowRegistry.sessionsForWindow(wid);
    if (ownedSessions.length === 0) return; // no sessions — close freely
    ev.preventDefault();
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel', 'Close & Kill Sessions'],
      defaultId: 0,
      cancelId: 0,
      message: `This window has ${ownedSessions.length} active session${ownedSessions.length === 1 ? '' : 's'}.`,
      detail: 'Closing the window will terminate these sessions. To preserve a session, drag its pill to another window first.',
    });
    if (response === 1) {
      for (const sid of ownedSessions) {
        sessionManager.destroySession(sid);
        windowRegistry.releaseSession(sid);
      }
      confirmedClose = true;
      win.close();
    }
  });

  return win;
}

function createWindow(firstRunManager?: FirstRunManager) {
  mainWindow = createAppWindow({ maximize: true });
  // Perf lab: the renderer bundle has finished loading (not yet mounted).
  // Registered HERE, not in createAppWindow: createAppWindow also builds the
  // three detached/tear-off windows (and the buddy floaters), and the rig's log
  // parse is last-occurrence-wins — so a window detached hours later would
  // overwrite this mark and drag blankWindowMs with it. createWindow runs once, from
  // the app.whenReady() block. createAppWindow is synchronous and returns before
  // its loadURL/loadFile promise can settle, so this listener is still attached
  // in the same tick as the load call and cannot miss the event.
  mainWindow.webContents.once('did-finish-load', () => perfMark('main:main-window:did-finish-load'));

  // Plan 2b Task 8: construct the conversation-lease client. Lazy accessors —
  // the hub socket + managed roots don't exist yet at this point (they're wired
  // in the app-ready sync block below), so hubRequest/personalRoot read them
  // lazily. onTakeoverRequest routes through holderTakeoverRef, which
  // registerIpcHandlers fills in (it owns sessionIdMap).
  deviceIdentity = getDeviceIdentity(app.getPath('userData'));
  // Per-MACHINE id for the device registry, from the BUILT app's userData — so a
  // dev profile heartbeats the machine's real row instead of minting its own.
  // In the built app this resolves the id getDeviceIdentity just wrote; in a dev
  // profile it reads across to the built app's dir.
  machineIdentity = getMachineIdentity(BUILT_APP_USER_DATA);
  leaseClient = createLeaseClient({
    deviceId: deviceIdentity.id,
    deviceName: os.hostname(),
    // Lease files live in userData, NOT in the personal sync space. They are a
    // 30s-per-session heartbeat; while they lived in the space, every renew became
    // a git commit — 93% of all file-changes in the real Personal repo, 30k
    // commits / 673 MB, and the bloat pushed catch-up syncs past GIT_TIMEOUT so a
    // device that fell behind could never recover (2026-07-30).
    //
    // Resolved AFTER the DEV_PROFILE setPath above, so a dev instance gets its own
    // lease dir — deliberately matching deviceIdentity, which is also per-INSTALL
    // (dev + built app must stay distinguishable as lease holders).
    //
    // TRADE-OFF: the file is the fallback consulted when the HUB is down, and it
    // no longer reaches other devices. A peer's lease is now invisible in that
    // window, so query() reports free and the caller proceeds optimistically.
    // Accepted because the hub is the source of truth, the file was always
    // "best-effort", and a lease never BLOCKS anything (never-block rule) — it
    // only warns. Losing a warning in a narrow hub-down window is far cheaper
    // than an unusable backup repo.
    leaseDir: () => path.join(app.getPath('userData'), 'Leases'),
    hubRequest: hubLeaseRequest,
    onTakeoverRequest: (sid, from) => holderTakeoverRef.fn(sid, from),
  });
  // Nothing else ever deleted expired lease files — deleteLeaseFile only runs on a
  // clean release, so every crash/force-quit leaked one permanently (59 of 60 were
  // stale on the machine that surfaced this). Cheap, synchronous, dir-local.
  try { sweepExpiredLeases(path.join(app.getPath('userData'), 'Leases')); } catch { /* best-effort */ }

  // Plan 2b Task 9: build the requester-side takeover flow. It reuses the SAME
  // lease client (takeover/query/acquire), nudges a personal-space sync, pulls the
  // peer's final turn via materializeOne, and force-acquires through the hub
  // directly (the reviewed lease client has no force method). "Held by US" is now
  // decided inside query() via the per-install deviceId (self flag), so no
  // selfDevice label is threaded here — a hostname label would collide when two
  // installs share a hostname (the dev instance + built app dogfood gate).
  const requester = createRequesterTakeover({
    leaseClient,
    // AWAITABLE sync (not the fire-and-forget syncSpacesSyncNow): the requester
    // pulls the holder's final turn right after this, so the pull must not run
    // until the push it depends on has actually landed. Bounded so a slow network
    // can't wedge the resume.
    syncNow: () => syncSpacesSyncNowAwaited('personal', HANDOFF_SYNC_TIMEOUT_MS),
    materializeOne: (id) => materializeOne(id),
    forceAcquire: (id) => hubLeaseRequest('force-acquire', id, deviceIdentity!.id),
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
  });

  // Sign in with ChatGPT (backend design 2026-09-05 §1, §6). Built HERE, right
  // before registerIpcHandlers — i.e. AFTER the dev-profile userData override
  // near the top of this file — and never beside `remoteServer`, which is
  // The kill switch, read once: YOUCODED_CHATGPT=0 turns the whole feature off.
  const chatgptEnabled = process.env.YOUCODED_CHATGPT !== '0';
  // constructed before that override: an instance built there would read and
  // write the BUILT app's native-secrets.json and chatgpt-account.json from a
  // dev instance (the live-app rule broken through a file). Constructed even
  // under the kill switch (YOUCODED_CHATGPT=0): it is the file reader the
  // launch-time auth check below needs, so a ChatGPT-only install is not locked
  // out by the switch; ipc-handlers applies the switch to everything user-facing.
  chatgptAuth = new ChatGptAuth({
    userDataDir: app.getPath('userData'),
    secrets: new SecretsStore(app.getPath('userData')),
    appVersion: app.getVersion(),
    openExternal: (url) => shell.openExternal(url),
    // The object still exists under the kill switch (the launch check reads the
    // account file through it), but it must not talk to OpenAI: the poll
    // refreshes the token, and a rejected refresh deletes the saved sign-in.
    // Turning the feature off must never sign anyone out (review T4 F1).
    pollUsage: chatgptEnabled,
  });

  const ipcWiring = registerIpcHandlers(ipcMain, sessionManager, mainWindow, skillProvider, commandProvider, hookRelay, remoteConfig, remoteServer, windowRegistry,
    { client: leaseClient, setHolderTakeover: (fn) => { holderTakeoverRef.fn = fn; }, requester,
      deviceId: deviceIdentity.id, machineId: machineIdentity?.id ?? '' },
    chatgptAuth);
  cleanupIpcHandlers = ipcWiring.cleanup;
  const hasUsableProvider = ipcWiring.hasUsableProvider;

  if (firstRunManager) {
    registerFirstRunIpc(mainWindow, firstRunManager, chatgptAuth);
  } else {
    // Not a first-run — but verify Claude Code can actually run.
    // If auth is missing, re-trigger first-run at the auth step so the user
    // isn't dropped into an app that can't create sessions.
    // Lazy auth verification — on the first getState() call from the renderer,
    // check if Claude Code is actually authenticated. If not, spin up the
    // first-run flow at the auth step. This handles: user quit mid-auth,
    // user installed toolkit manually but never logged in, corrupted state, etc.
    let lateFirstRunManager: FirstRunManager | null = null;
    let lateAuthCheck: Promise<any> | null = null;
    ipcMain.handle(IPC.FIRST_RUN_STATE, () => {
      // If we already spun up a late first-run manager, delegate to it
      if (lateFirstRunManager) {
        try { return lateFirstRunManager.getState(); }
        catch { return { currentStep: 'COMPLETE' }; }
      }
      // One-time async auth check — share the promise so concurrent calls
      // (e.g., React StrictMode double-mount) don't register duplicate handlers
      if (!lateAuthCheck) {
        lateAuthCheck = (async () => {
          try {
            // Provider-aware since Sign in with ChatGPT (backend design
            // 2026-09-05 §5, review R3-2). This branch removed the wizard's
            // Skip link, so forcing AUTHENTICATE here is a lock-out, not a
            // nudge — and the old Claude-only check would have locked out a
            // ChatGPT-only install (every launch), an install running on an
            // OpenRouter key, and anyone whose `claude` CLI broke. Order is
            // load-bearing: the two LOCAL reads first, the `claude auth status`
            // spawn last, so a signed-in ChatGPT account never pays for it.
            // chatgptAuth is read directly (not via the registry row) so the
            // kill switch, which removes the row, cannot lock anyone out either.
            const { detectAuth } = require('./prerequisite-installer');
            const usable = await setupIsUsable({
              isSignedIn: () => chatgptAuth!.isSignedIn(),
              hasUsableProvider,
              detectAuth,
            });
            if (usable) return { currentStep: 'COMPLETE' };

            // Auth missing — spin up first-run at the auth step
            log('WARN', 'Main', 'Setup complete but auth missing — showing auth screen');
            // Record that setup itself is DONE before demoting the wizard's
            // saved step. WHY: forceStep() overwrites the saved step (COMPLETE)
            // with AUTHENTICATE and writes it to disk. If the user closes the
            // window without signing in, the next launch sees a state file that
            // no longer says COMPLETE and treats this months-old install as a
            // brand-new machine — re-running the Node/Git/Claude installers and,
            // with the Skip link gone, stranding them on a "Try Again" screen.
            // With the flag set, the next launch comes back through THIS check.
            markSetupCompleted();
            lateFirstRunManager = new FirstRunManager();
            lateFirstRunManager.forceStep('AUTHENTICATE');

            // Wire up events (but skip FIRST_RUN_STATE — we're already handling it)
            lateFirstRunManager.on('state-changed', (state) => {
              try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.FIRST_RUN_STATE, state); } catch {}
            });
            lateFirstRunManager.on('launch-wizard', () => {
              log('INFO', 'FirstRun', 'Late first-run complete, transitioning to normal app');
            });

            // Register the other handlers
            ipcMain.handle(IPC.FIRST_RUN_RETRY, async () => { try { await lateFirstRunManager!.retry(); } catch {} });
            // Same three arms as registerFirstRunIpc above (ChatGPT / OpenRouter
            // per backend design 2026-09-05 §5); swallowed throws are the last
            // resort only — handleChatGptLogin writes its own lastError.
            ipcMain.handle(IPC.FIRST_RUN_START_AUTH, async (_event, mode: FirstRunState['authMode']) => {
              try {
                if (mode === 'oauth') await lateFirstRunManager!.handleOAuthLogin();
                // Gated on the switch as well as on the renderer's hidden button:
                // an ungated arm would still open a browser tab and bind port
                // 1455 with the feature turned off (review T4 F3).
                else if (mode === 'chatgpt' && chatgptEnabled) await lateFirstRunManager!.handleChatGptLogin(chatgptAuth!);
                else if (mode === 'openrouter') lateFirstRunManager!.handleOpenRouterNotBuilt();
              } catch {} });
            ipcMain.handle(IPC.FIRST_RUN_SUBMIT_API_KEY, async (_event, key: string) => { try { await lateFirstRunManager!.handleApiKeySubmit(key); } catch {} });
            ipcMain.handle(IPC.FIRST_RUN_DEV_MODE_DONE, async () => { try { await lateFirstRunManager!.handleDevModeDone(); } catch {} });
            ipcMain.handle(IPC.FIRST_RUN_SKIP, async () => {
              markSetupCompleted(); // same one writer as above
              lateFirstRunManager?.skip();
            });

            return lateFirstRunManager.getState();
          } catch {
            return { currentStep: 'COMPLETE' }; // Can't check — don't block
          }
        })();
      }
      return lateAuthCheck;
    });
  }

  // Forward hook events to renderer
  hookRelay.on('hook-event', (event) => {
    // In bypass mode (--dangerously-skip-permissions), Claude Code handles most
    // permissions natively. But a few things still fire PermissionRequest:
    //   - Protected path writes (.git/, .bashrc, .claude/ except commands/agents/skills/worktrees)
    //   - Compound commands with cd + output redirection (path resolution bypass protection)
    //   - Compound commands with cd + git (bare repository attack protection)
    //   - AskUserQuestion (needs actual user input)
    //
    // Title hooks are always auto-approved. Other categories are auto-approved
    // only if the user has enabled the corresponding override in Advanced settings.
    // AskUserQuestion always goes to the chat UI (needs real user input).
    if (event.type === 'PermissionRequest') {
      const toolName = event.payload?.tool_name as string;
      const toolInput = event.payload?.tool_input as Record<string, unknown> | undefined;
      const requestId = event.payload?._requestId as string;

      // Never auto-approve AskUserQuestion — it needs actual user input
      if (requestId && toolName !== 'AskUserQuestion') {
        const category = classifyPermission(toolName, toolInput);

        // Title hooks are always auto-approved (fire every few minutes)
        if (category === 'titleHook') {
          hookRelay.respond(requestId, { decision: { behavior: 'allow' } });
          return;
        }

        // Blanket approve-all override (restores old behavior)
        if (permissionOverrides.approveAll) {
          hookRelay.respond(requestId, { decision: { behavior: 'allow' } });
          return;
        }

        // Per-category overrides — approve if the user enabled this category
        if (category !== 'unknown' && permissionOverrides[category]) {
          hookRelay.respond(requestId, { decision: { behavior: 'allow' } });
          return;
        }
      }
    }

    // Route to the window that owns this session; fall back to mainWindow if
    // ownership is unknown (e.g., session not yet created via IPC).
    const ownerId = windowRegistry.getOwner(event.sessionId);
    if (ownerId != null) {
      const win = windowFromWcId(ownerId);
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.HOOK_EVENT, event);
        return;
      }
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.HOOK_EVENT, event);
    }
  });

  // Notify renderer when a permission request socket closes (timeout/killed)
  hookRelay.on('permission-expired', (sessionId: string, requestId: string) => {
    const evt = {
      type: 'PermissionExpired',
      sessionId,
      payload: { _requestId: requestId },
      timestamp: Date.now(),
    };
    const ownerId = windowRegistry.getOwner(sessionId);
    if (ownerId != null) {
      const win = windowFromWcId(ownerId);
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.HOOK_EVENT, evt);
        return;
      }
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.HOOK_EVENT, evt);
    }
  });
}

// Detach subsystem: IPC handlers for drag-a-session-to-new-window feature.
// All session-scoped traffic is routed via windowRegistry.getOwner(). These
// handlers coordinate ownership transfers between windows and broadcast the
// cross-window cursor during an active drag so peer windows can highlight
// their strip as a drop target.
function registerDetachIpc() {
  // Renderer asks "which window am I?" — used by SessionStrip to avoid
  // treating its own directory entry as a remote session.
  ipcMain.handle(IPC.WINDOW_GET_ID, (evt) => evt.sender.id);

  // Renderer asks "did I inherit anything while I was still booting?"
  //
  // WHY (2026-09-03): a tear-off hands the session to a window created one
  // statement earlier, so `tgt.webContents.send(SESSION_OWNERSHIP_ACQUIRED)`
  // fired at a renderer whose React tree did not exist yet. Electron does NOT
  // queue for a late subscriber — measured on 41.10.7: a message sent right
  // after `new BrowserWindow()` never reaches a listener registered 1.5s later,
  // it is dropped outright. So the handoff, and everything it triggers (history
  // hydration, opening on the dragged session, re-sending open permission asks)
  // silently did nothing on EVERY tear-off into a fresh window.
  //
  // Fix shape follows the one already used for the buddy overlay's boot
  // geometry (see BUDDY_OVERLAY_READY): the renderer PULLS once mounted rather
  // than being pushed at before it can listen. `readyWindows` is what makes the
  // two paths exclusive — before a window has pulled, transfers queue; after,
  // they push as before — so a payload is delivered exactly once either way.
  ipcMain.handle(IPC.DETACH_CLAIM_PENDING, (evt) => pendingAcquire.claim(evt.sender.id));

  // Appearance sync across peer windows. When one window writes a theme /
  // font / reduced-effects change, it broadcasts and every OTHER window
  // receives the same prefs via appearance:sync. ThemeProvider applies
  // locally without re-broadcasting (guarded by a ref) so there's no loop.
  ipcMain.on(IPC.APPEARANCE_BROADCAST, (evt, prefs) => {
    // WHY BrowserWindow is the delivery authority here: Buddy floaters do not
    // own sessions, so filtering through session-peer registry entries can
    // leave their independent ThemeProvider permanently on its launch theme.
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.id === evt.sender.id) continue;
      win.webContents.send(IPC.APPEARANCE_SYNC, prefs);
    }
  });

  // Transfer a session from its current owner window to a target window.
  // Rejects if the source claim is stale (race protection). Emits ownership
  // events to both windows so renderers can update their reducers.
  function transferOwnership(sessionId: string, srcWindowId: number, targetWindowId: number, freshWindow: boolean) {
    const info = sessionManager.getSession(sessionId);
    if (!info) return;
    const currentOwner = windowRegistry.getOwner(sessionId);
    if (currentOwner !== srcWindowId) return; // stale — another event already moved it
    windowRegistry.assignSession(sessionId, targetWindowId);
    // The target has not been receiving this session's live transcript stream,
    // so its first page of history must read to EOF rather than stopping at the
    // watcher's startOffset. See WindowRegistry.markInheritedByTransfer.
    windowRegistry.markInheritedByTransfer(sessionId, targetWindowId);
    const src = windowFromWcId(srcWindowId);
    const tgt = windowFromWcId(targetWindowId);
    src?.webContents.send(IPC.SESSION_OWNERSHIP_LOST, { sessionId });
    const payload = { sessionId, sessionInfo: info, freshWindow };
    // A window that has not yet pulled (DETACH_CLAIM_PENDING) has no listener —
    // a send would be dropped on the floor. Queue for its pull instead.
    if (pendingAcquire.isReady(targetWindowId)) {
      tgt?.webContents.send(IPC.SESSION_OWNERSHIP_ACQUIRED, payload);
    } else {
      pendingAcquire.enqueue(targetWindowId, payload);
    }
  }

  // If a window was emptied by a detach/re-dock and another peer window
  // exists, close it automatically. The last surviving window may stay empty.
  function maybeAutoCloseEmpty(windowId: number) {
    if (windowRegistry.sessionsForWindow(windowId).length > 0) return;
    if (windowRegistry.getWindowIds().length <= 1) return;
    windowFromWcId(windowId)?.close();
  }

  // "Launch in new window" entry point and the direct-spawn fallback for drops
  // outside any window. Spawns a peer window at/near the cursor and hands it
  // ownership of the session.
  ipcMain.on(IPC.WINDOW_OPEN_DETACHED, (evt, { sessionId }: { sessionId: string }) => {
    const { x, y } = screen.getCursorScreenPoint();
    const newWin = createAppWindow({ x: x - 60, y: y - 40, width: 900, height: 700 });
    transferOwnership(sessionId, evt.sender.id, newWin.webContents.id, /*freshWindow*/ true);
    maybeAutoCloseEmpty(evt.sender.id);
  });

  // Cursor left the source window while dragging — spawn a peer at the cursor
  // and hand off the session.
  ipcMain.on(IPC.SESSION_DETACH_START, (evt, payload: { sessionId: string; screenX: number; screenY: number }) => {
    const newWin = createAppWindow({ x: payload.screenX - 60, y: payload.screenY - 40, width: 900, height: 700 });
    transferOwnership(payload.sessionId, evt.sender.id, newWin.webContents.id, /*freshWindow*/ true);
    maybeAutoCloseEmpty(evt.sender.id);
    stopCursorTicker();
  });

  // Chrome-style live tear-off. Spawns a peer window mid-drag (threshold hit in
  // SessionStrip) and returns its id so the source window can stream cursor
  // positions to it until pointerup. Ownership transfers immediately; the new
  // window is repositioned via SESSION_DRAG_WINDOW_MOVE as the user drags.
  // Approx. position of the FIRST pill inside a freshly-spawned window's
  // header, measured from the window's top-left in DIPs. Used to offset the
  // new window so the cursor ends up over the pill, not the window corner.
  // Tuned empirically on Windows (hidden titlebar, no REMOTE badge, chat/
  // terminal toggle on the left); bump if the left cluster grows or shrinks.
  const DETACHED_FIRST_PILL_X = 96;
  const DETACHED_FIRST_PILL_Y = 12;

  // Given cursor screen coords + where inside the pill the user grabbed,
  // compute where the new window's top-left should sit so the cursor hovers
  // over the same spot on that session's pill inside the new window.
  const computeDetachedWindowPos = (screenX: number, screenY: number, offsetX: number, offsetY: number) => ({
    x: Math.round(screenX - DETACHED_FIRST_PILL_X - offsetX),
    y: Math.round(screenY - DETACHED_FIRST_PILL_Y - offsetY),
  });

  // Tracks live tear-off state so we can defer source-window auto-close until
  // the user releases (closing mid-drag would kill the pointer-capture path
  // and leave the new window stuck in mouse-passthrough mode).
  let liveDragWindowId: number | null = null;
  let liveDragSourceId: number | null = null;
  let liveDragOffset: { x: number; y: number } = { x: 40, y: 12 };
  // Updated by the post-spawn measurement (see SESSION_DETACH_LIVE) so the
  // streaming setPosition uses the *real* first-pill position in the new
  // window, not the static DETACHED_FIRST_PILL_X/Y guess.
  let measuredFirstPillX: number = DETACHED_FIRST_PILL_X;
  let measuredFirstPillY: number = DETACHED_FIRST_PILL_Y;

  ipcMain.handle(IPC.SESSION_DETACH_LIVE, (evt, payload: { sessionId: string; offsetX?: number; offsetY?: number }) => {
    // Read cursor position from main (DIPs, DPI-correct) instead of trusting
    // renderer-reported screenX/screenY — those can be in physical pixels on
    // scaled Windows displays and put the new window at the wrong screen pos.
    const cursor = screen.getCursorScreenPoint();
    liveDragOffset = { x: payload.offsetX ?? 40, y: payload.offsetY ?? 12 };
    const pos = computeDetachedWindowPos(cursor.x, cursor.y, liveDragOffset.x, liveDragOffset.y);
    // inactive: show without stealing focus so the source window keeps
    // receiving pointer events (the drag isn't finished yet).
    const newWin = createAppWindow({ x: pos.x, y: pos.y, width: 900, height: 700, inactive: true });
    // Make the new window pass pointer events through to whatever sits under
    // the cursor. Combined with setPosition() following the cursor, the source
    // window keeps getting pointermove until the user releases — at which
    // point SESSION_DRAG_ENDED clears this and refocuses.
    try { newWin.setIgnoreMouseEvents(true, { forward: true }); } catch { /* older electron */ }
    liveDragWindowId = newWin.webContents.id;
    liveDragSourceId = evt.sender.id;
    transferOwnership(payload.sessionId, evt.sender.id, newWin.webContents.id, /*freshWindow*/ true);
    // Defer maybeAutoCloseEmpty(source) to SESSION_DRAG_ENDED — if we close
    // the source mid-drag, its renderer dies and never fires pointerup, so
    // dragEnded never reaches main and the new window stays click-through.

    // Once the new window has its React tree up, measure the actual first pill
    // position and re-anchor the window so the cursor sits exactly over the
    // grabbed spot on that pill. The DETACHED_FIRST_PILL_X/Y constants used at
    // initial spawn are only an approximation; this corrects any drift from
    // varying header layouts (REMOTE badge present/absent, mac vs win toggle).
    newWin.webContents.once('did-finish-load', () => {
      // Small delay so React mounts and the pill paints before we measure.
      setTimeout(async () => {
        if (newWin.isDestroyed() || liveDragWindowId !== newWin.webContents.id) return;
        try {
          const pillRect = await newWin.webContents.executeJavaScript(
            `(() => { const el = document.querySelector('[data-session-idx]'); if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`,
          );
          if (!pillRect) return;
          const cursor = screen.getCursorScreenPoint();
          const correctedX = Math.round(cursor.x - pillRect.left - liveDragOffset.x);
          const correctedY = Math.round(cursor.y - pillRect.top - liveDragOffset.y);
          // Update the constants too so the streaming setPosition during the
          // remaining drag uses the measured values, not the initial guess.
          measuredFirstPillX = pillRect.left;
          measuredFirstPillY = pillRect.top;
          newWin.setPosition(correctedX, correctedY);
        } catch { /* measurement is best-effort; constants fall back */ }
      }, 80);
    });

    return { windowId: newWin.webContents.id };
  });

  // Follow-the-cursor. Renderer just signals a frame happened; main reads the
  // authoritative cursor position from the OS and uses the *measured* first-
  // pill position (set after the new window mounts) so the cursor stays over
  // the pill the user grabbed, not over an estimated header offset.
  ipcMain.on(IPC.SESSION_DRAG_WINDOW_MOVE, () => {
    if (liveDragWindowId === null) return;
    const win = windowFromWcId(liveDragWindowId);
    if (!win || win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    win.setPosition(
      Math.round(cursor.x - measuredFirstPillX - liveDragOffset.x),
      Math.round(cursor.y - measuredFirstPillY - liveDragOffset.y),
    );
  });

  // Drop landed on another window's SessionStrip — move ownership there.
  ipcMain.on(IPC.SESSION_DRAG_DROPPED, (evt, payload: { sessionId: string; targetWindowId: number; insertIndex: number }) => {
    transferOwnership(payload.sessionId, evt.sender.id, payload.targetWindowId, /*freshWindow*/ false);
    maybeAutoCloseEmpty(evt.sender.id);
    stopCursorTicker();
  });

  // ── 'html-drag' tear-off (Linux/Wayland) ──────────────────────────────────
  //
  // Everything above this point resolves a cross-window drag from SCREEN
  // coordinates, and on Wayland every one of those is zero — the cursor's
  // position, each window's position, and setPosition, which is a no-op that
  // still reports success. So peer windows never highlighted, the torn-off
  // window never followed the cursor, and the drop always resolved to "you
  // dropped it on nothing". A pill in a torn-off window could never be dragged
  // back (Destin, 2026-09-03: "permanently stuck with two windows").
  //
  // There, the pill is a browser-native draggable and the compositor carries
  // the whole gesture; the window it lands on is TOLD, in its own window-local
  // coordinates, and claims the session with the message below. Main's only
  // job is ownership. (A previous attempt started the drag from here with
  // webContents.startDrag — abandoned because on Linux that API crops the
  // picture to ~138px and can carry nothing but a file: session-drag-model.ts.)
  //
  // The window that RECEIVED an 'html-drag' drop claims the session. Unlike
  // SESSION_DRAG_DROPPED (sent by the source), this arrives from the TARGET, so
  // the source is resolved from the registry and never taken from the payload —
  // a forged message can only move a session to the window that sent it, and
  // only if some window really owns it.
  ipcMain.on(IPC.SESSION_DRAG_ADOPT, (evt, payload: { sessionId: string }) => {
    const from = windowRegistry.getOwner(payload.sessionId);
    if (from == null || from === evt.sender.id) return;
    transferOwnership(payload.sessionId, from, evt.sender.id, /*freshWindow*/ false);
    maybeAutoCloseEmpty(from);
  });

  // Switcher selected a remote session — focus that window and tell it to
  // switch its active session.
  ipcMain.on(IPC.WINDOW_FOCUS_AND_SWITCH, (_evt, { windowId, sessionId }: { windowId: number; sessionId: string }) => {
    const info = sessionManager.getSession(sessionId);
    const win = windowFromWcId(windowId);
    if (!win || !info) return;
    win.focus();
    // refocusOnly tells the target its state already has this session — just switch active.
    win.webContents.send(IPC.SESSION_OWNERSHIP_ACQUIRED, { sessionId, sessionInfo: info, freshWindow: false, refocusOnly: true });
  });

  // Active-drag cursor broadcasting: while a source window is dragging a pill,
  // every other window needs to know where the cursor is (OS only delivers
  // pointer events to the active window). Ticker runs ~30Hz; stops on any
  // drop resolution.
  let cursorTicker: NodeJS.Timeout | null = null;
  function stopCursorTicker() {
    if (cursorTicker) { clearInterval(cursorTicker); cursorTicker = null; }
  }
  ipcMain.on(IPC.SESSION_DRAG_STARTED, () => {
    stopCursorTicker();
    cursorTicker = setInterval(() => {
      const { x, y } = screen.getCursorScreenPoint();
      for (const wid of windowRegistry.getWindowIds()) {
        windowFromWcId(wid)?.webContents.send(IPC.CROSS_WINDOW_CURSOR, { screenX: x, screenY: y });
      }
    }, 33);
  });
  ipcMain.on(IPC.SESSION_DRAG_ENDED, () => {
    stopCursorTicker();
    // Finalize any live-detached window: re-enable pointer events and focus
    // it so the user can interact with the session they just tore off.
    if (liveDragWindowId !== null) {
      const win = windowFromWcId(liveDragWindowId);
      if (win && !win.isDestroyed()) {
        try { win.setIgnoreMouseEvents(false); } catch { /* ignore */ }
        win.focus();
      }
      liveDragWindowId = null;
    }
    // Now safe to close the source window if it became empty during the drag.
    // Deferred from SESSION_DETACH_LIVE so the source's renderer survives long
    // enough to fire pointerup and reach this handler.
    if (liveDragSourceId !== null) {
      maybeAutoCloseEmpty(liveDragSourceId);
      liveDragSourceId = null;
    }
    measuredFirstPillX = DETACHED_FIRST_PILL_X;
    measuredFirstPillY = DETACHED_FIRST_PILL_Y;
  });

  // Resolve a drop: ask each window whether its SessionStrip bounding box
  // currently contains the cursor. The source window uses the answer on
  // pointerup to pick between re-dock (other window) vs detach (no hit).
  ipcMain.handle(IPC.SESSION_DROP_RESOLVE, async () => {
    const { x, y } = screen.getCursorScreenPoint();
    for (const wid of windowRegistry.getWindowIds()) {
      const win = windowFromWcId(wid);
      if (!win || win.isDestroyed()) continue;
      try {
        const hit = await win.webContents.executeJavaScript(
          `(() => {
            const el = document.querySelector('[data-session-strip]');
            if (!el) return false;
            const r = el.getBoundingClientRect();
            const lx = ${x} - window.screenX;
            const ly = ${y} - window.screenY;
            return (lx >= r.left && lx <= r.right && ly >= r.top && ly <= r.bottom);
          })()`,
        );
        if (hit) return { targetWindowId: wid };
      } catch { /* window not ready — skip */ }
    }
    return { targetWindowId: null };
  });
}

// Apply GPU preference. Reads ~/.claude/youcoded-performance.json synchronously.
// Default (file missing OR preferPowerSaving=false) → request the discrete GPU.
// preferPowerSaving=true → request the integrated GPU.
// These are hints to Chromium; the OS may still override (Windows Settings →
// Graphics, NVIDIA Control Panel). The "Restart to apply" notice in
// SettingsPanel uses appliedAtLaunch — set here — to know whether the running
// process matches the on-disk config.
{
  const perf = loadConfigSync();
  if (perf.preferPowerSaving) {
    app.commandLine.appendSwitch('force-low-power-gpu');
  } else {
    app.commandLine.appendSwitch('force-high-performance-gpu');
  }
  setAppliedAtLaunch(perf.preferPowerSaving);
}

// Dev-only debugging aid: YOUCODED_DEVTOOLS_PORT=9223 opens Chromium's
// remote-debugging port so scripts/cdp-eval.mjs can inspect live renderers
// (localhost-only; never enabled in packaged builds — the double gate below).
// Added 2026-07-23 while diagnosing the dead buddy overlay on Wayland.
if (!app.isPackaged && process.env.YOUCODED_DEVTOOLS_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.YOUCODED_DEVTOOLS_PORT);
}

// NOTE — do NOT add `--disable-features=EvictionThrottlesDraw` here for the
// buddy overlay (2026-07-23 lesson, full matrix in
// docs/active/investigations/2026-07-23-buddy-overlay-wayland-presentation.md):
// a delayed-content probe on the X11 backend froze without that switch and
// was "fixed" by it — but the probe was silently running XWayland, and on
// the app's REAL backend (native Wayland) the switch has the exact opposite
// effect: it FREEZES the transparent overlay's presentation on its first
// blank commit. Native Wayland needs no feature switch at all (verified on
// 41.10.3 and 43.2.0). Ground-truth the ozone backend before trusting any
// transparency probe on this machine.

// `void`, not a .catch(): a bootstrap failure has no meaningful local recovery,
// and the unhandledRejection listener registered at the top of this file logs
// it and keeps the app alive rather than exiting silently.
void app.whenReady().then(async () => {
  perfMark('main:when-ready');
  await rotateLog();
  perfMark('main:chore:rotate-log:done');

  // Fire-and-forget: never await. Respects the opt-out in About → Privacy
  // internally and fails silently on any network issue.
  void runAnalyticsOnLaunch();

  // Cache the GPU device list once. Used by the Performance section in
  // SettingsPanel to decide whether to render (hidden on single-GPU systems)
  // and to surface a "Detected GPUs: ..." line under the toggle. Async
  // because getGPUInfo can take 1-2s on first call; the IPC handler returns
  // multiGpuDetected:false until this resolves.
  app.getGPUInfo('complete').then((info: unknown) => {
    const list: string[] = [];
    // Electron's GPUInfo shape uses `gpuDevice` (singular array). Names live
    // in auxAttributes.glRenderer for the active device, but device-level
    // names are not always populated — fall back to a vendor/device-id hint.
    if (info && typeof info === 'object') {
      const gpuDevice = (info as { gpuDevice?: Array<Record<string, unknown>> }).gpuDevice;
      const aux = (info as { auxAttributes?: Record<string, unknown> }).auxAttributes;
      if (Array.isArray(gpuDevice)) {
        for (const d of gpuDevice) {
          const renderer = typeof aux?.glRenderer === 'string' && d.active === true
            ? (aux.glRenderer as string)
            : null;
          const fallback = `GPU vendor=${d.vendorId ?? '?'} device=${d.deviceId ?? '?'}`;
          list.push(renderer ?? fallback);
        }
      }
    }
    setCachedGpu(list);
  }).catch((err: unknown) => {
    log('WARN', 'Main', 'getGPUInfo failed — GPU list unavailable', { error: String(err) });
    setCachedGpu([]);
  });

  // --- First-run detection (wrapped in try/catch — never breaks the app) ---
  let firstRunManager: FirstRunManager | undefined;
  let isFirstRun = false;
  try {
    isFirstRun = FirstRunManager.isFirstRun();
    if (isFirstRun) firstRunManager = new FirstRunManager();
  } catch (e) {
    log('ERROR', 'Main', 'First-run detection failed, skipping', { error: String(e) });
    isFirstRun = false;
  }
  // Perf lab: everything between rotate-log and here — kicking off
  // runAnalyticsOnLaunch() (whose readState + deviceIdHash run synchronously on
  // this stack, before its first await), the app.getGPUInfo('complete') call, and
  // first-run detection's up-to-two readFileSync + JSON.parse — used to be billed
  // to the install-hooks chore, because the rig measures each chore as
  // mark[n] − mark[n−1]. This mark makes that prelude work show up as itself.
  perfMark('main:chore:prelude:done');

  // Install hook relay entries in Claude Code settings.
  //
  // Skipped in dev profile so that running `npm run dev` from a worktree
  // doesn't overwrite ~/.claude/settings.json with paths under that worktree
  // — those paths break the user's installed app the moment the worktree is
  // removed. Dev piggybacks on whatever hook paths the built app last wrote.
  //
  // install-hooks.js already does in-place replacement of existing entries,
  // so simply calling it repairs any stale paths. We scan first only to log a
  // visible warning when staleness is detected — useful for diagnosing the
  // "stuck on Initializing" symptom that follows a removed dev worktree.
  if (!process.env.YOUCODED_PROFILE) {
    try {
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        for (const event of Object.values(settings.hooks ?? {}) as any[]) {
          for (const matcher of event ?? []) {
            for (const h of matcher.hooks ?? []) {
              const cmd: string = h?.command ?? '';
              const m = cmd.match(/"([^"]+\.(?:js|sh))"/);
              if (m && (m[1].includes('.worktrees') || !fs.existsSync(m[1]))) {
                log('WARN', 'Main', 'Stale hook command detected — install-hooks will repair', { command: cmd });
              }
            }
          }
        }
      } catch { /* settings missing or unparseable — install-hooks will normalize */ }
      const installScript = path.join(__dirname, '../../scripts/install-hooks.js');
      require(installScript);
    } catch (e) {
      log('ERROR', 'Main', 'Failed to install hooks', { error: String(e) });
    }
  } else {
    log('INFO', 'Main', `Dev profile '${process.env.YOUCODED_PROFILE}' — skipping install-hooks (using built app paths)`);
  }
  perfMark('main:chore:install-hooks:done');

  try {
    await hookRelay.start();
  } catch (e) {
    log('ERROR', 'Main', 'Failed to start hook relay', { error: String(e) });
  }
  perfMark('main:chore:hook-relay:done');

  // Legacy cleanup: youcoded-core was deprecated 2026-04. Users who
  // upgraded from a prior version still have the legacy clone at
  // ~/.claude/plugins/youcoded-core/ with stale settings.json entries
  // pointing into it. Delete the directory; the reconcileHooks() call
  // below prunes the orphaned entries via pruneDeadPluginHooks().
  try {
    const { cleanupLegacyYoucodedCore } = require('./legacy-cleanup');
    const legacyResult = cleanupLegacyYoucodedCore();
    if (legacyResult.removed) {
      log('INFO', 'Main', 'Legacy youcoded-core clone removed', { path: legacyResult.path });
    } else if (legacyResult.error) {
      log('WARN', 'Main', 'Legacy youcoded-core cleanup failed', { path: legacyResult.path, error: legacyResult.error });
    }
  } catch (e) {
    log('ERROR', 'Main', 'Failed to run legacy cleanup', { error: String(e) });
  }
  perfMark('main:chore:legacy-cleanup:done');

  // Decomposition v3 §9.2: reconcile plugin hooks-manifest.json into
  // ~/.claude/settings.json. Adds missing required hooks, updates stale paths
  // (e.g., flattened core/hooks/ → hooks/), enforces MAX timeout, and prunes
  // plugin-owned entries whose script file is gone (hooks dropped from the
  // manifest in phase-3 flatten). Never removes user-added hooks. Runs after
  // install-hooks.js so the app's own relay entries win any ordering contention.
  try {
    const { reconcileHooks } = require('./hook-reconciler');
    const hookSummary = reconcileHooks();
    log('INFO', 'Main', 'Plugin hooks reconciled', hookSummary);
  } catch (e) {
    log('ERROR', 'Main', 'Failed to reconcile plugin hooks', { error: String(e) });
  }
  perfMark('main:chore:hook-reconcile:done');

  // Force CC's prompt-suggestion feature off in ~/.claude/settings.json on
  // every launch. CC pre-fills the input bar with a generated next-prompt
  // suggestion that interacts badly with our chat→PTY write path (the body
  // gets concatenated with the ghost text and submitted on the trailing CR).
  // See `docs/PITFALLS.md → PTY Writes` and `docs/cc-dependencies.md` →
  // "Prompt suggestion (force-disabled by app)".
  try {
    const { enforcePromptSuggestionDisabled } = require('./disable-prompt-suggestion');
    const r = enforcePromptSuggestionDisabled();
    if (r.changed) log('INFO', 'Main', 'Prompt suggestion force-disabled', { prior: r.prior });
  } catch (e) {
    log('ERROR', 'Main', 'Failed to force-disable prompt suggestion', { error: String(e) });
  }
  perfMark('main:chore:prompt-suggestion:done');

  // Seed a transcript-retention default so Claude Code's 30-day cleanup
  // doesn't silently delete Resume Browser history. Only writes when the
  // user hasn't set cleanupPeriodDays themselves. See retention-default.ts.
  try {
    const { seedCleanupPeriodDefault } = require('./retention-default');
    const r = seedCleanupPeriodDefault();
    if (r.changed) log('INFO', 'Main', 'Seeded cleanupPeriodDays default', { effective: r.effective });
  } catch (e) {
    log('ERROR', 'Main', 'Failed to seed cleanupPeriodDays', { error: String(e) });
  }
  perfMark('main:chore:retention-default:done');

  // Clean up orphan symlinks left by pre-decomposition post-update.sh —
  // entries under ~/.claude/{hooks,commands,skills}/ that point into now-deleted
  // core/life/productivity subtrees of the toolkit. No replacement mechanism
  // rebuilds them; Claude Code v2.1+ discovers plugin commands/skills via
  // plugin.json, so the symlinks are pure tombstones once the target is gone.
  try {
    const { cleanupOrphanSymlinks } = require('./symlink-cleanup');
    const cleanupSummary = cleanupOrphanSymlinks();
    if (cleanupSummary.removed > 0) {
      log('INFO', 'Main', 'Orphan symlinks cleaned up', cleanupSummary);
    }
  } catch (e) {
    log('ERROR', 'Main', 'Failed to clean up orphan symlinks', { error: String(e) });
  }
  perfMark('main:chore:symlink-cleanup:done');

  // Sweep abandoned .partial files and downloads older than 24h from the
  // in-app update cache. Runs at every startup so stale downloads (e.g. from
  // a cancelled update on a prior session) don't accumulate on disk.
  try {
    cleanupStaleDownloads(path.join(app.getPath('userData'), 'update-cache'));
  } catch (e) {
    log('ERROR', 'Main', 'Failed to clean up stale update downloads', { error: String(e) });
  }
  perfMark('main:chore:stale-downloads:done');

  // Decomposition v3 §9.3 + native MCP phase 1 Task 7: reconcile plugin
  // mcp-manifest.json AND the YouCoded MCP registry into ~/.claude.json
  // mcpServers. reconcileMcp() is now async (registry secrets decrypt via
  // Electron's safeStorage) — awaited so a rejection lands in this catch
  // instead of becoming an unhandled promise rejection.
  try {
    const { reconcileMcp } = require('./mcp-reconciler');
    const mcpSummary = await reconcileMcp();
    log('INFO', 'Main', 'MCP servers reconciled', mcpSummary);
  } catch (e) {
    log('ERROR', 'Main', 'Failed to reconcile MCP servers', { error: String(e) });
  }
  perfMark('main:chore:reconcile-mcp:done');

  try {
    const { startAnnouncementService } = require('./announcement-service');
    startAnnouncementService();
  } catch (e) {
    log('ERROR', 'Main', 'Failed to start announcement service', { error: String(e) });
  }
  perfMark('main:chore:announcements:done');

  // The withdrawn protection overrides switch themselves off, once (Assistant
  // settings, contract R17). Runs HERE — before the remote server and before the
  // IPC handlers register — so nothing can answer a defaults request, or push
  // those overrides into the live permission cache, until it has happened.
  //
  // WHY `app.isPackaged` (design review 1, R1-8): run-dev.sh isolates ports and
  // userData but NOT `~/.claude`, so an unguarded migration would perform this
  // real, one-way, marker-stamping rewrite of the developer's own live settings
  // the first time any dev build launched — and then never again on their real
  // install. Verified against a COPY of a defaults file instead; there is
  // deliberately no environment opt-in (design review 3, R3-1).
  if (app.isPackaged) {
    try {
      const { migratePermissionOverrides } = require('./migrate-permission-overrides');
      const result = migratePermissionOverrides(path.join(os.homedir(), '.claude', 'youcoded-defaults.json'));
      if (result === 'migrated') log('INFO', 'Main', 'Cleared withdrawn permission overrides');
    } catch (e) {
      log('ERROR', 'Main', 'Permission override migration failed', { error: String(e) });
    }
  }

  try {
    await remoteServer.start();
  } catch (e) {
    log('ERROR', 'Main', 'Failed to start remote server', { error: String(e) });
  }
  perfMark('main:chore:remote-server:done');

  const FAVORITES_PATH = path.join(os.homedir(), '.claude', 'youcoded-favorites.json');

  function readGamePrefs(): Record<string, any> {
    try { return JSON.parse(fs.readFileSync(FAVORITES_PATH, 'utf8')); }
    catch { return {}; }
  }
  function writeGamePrefs(data: Record<string, any>): boolean {
    try { fs.writeFileSync(FAVORITES_PATH, JSON.stringify(data, null, 2)); return true; }
    catch { return false; }
  }

  ipcMain.handle('favorites:get', async () => readGamePrefs().favorites ?? []);

  ipcMain.handle('favorites:set', async (_event, favorites: string[]) => {
    const data = readGamePrefs();
    data.favorites = favorites;
    return writeGamePrefs(data);
  });

  ipcMain.handle('game:getIncognito', async () => readGamePrefs().incognito ?? false);

  ipcMain.handle('game:setIncognito', async (_event, incognito: boolean) => {
    const data = readGamePrefs();
    data.incognito = incognito;
    return writeGamePrefs(data);
  });

  // Expose the system home directory to the renderer (async to avoid blocking)
  ipcMain.handle('get-home-path', () => os.homedir());

  // Remove the default menu bar (File, Edit, View, Window, Help)
  Menu.setApplicationMenu(null);

  // Perf lab: the FAVORITES_PATH setup, the five game/favorites/home-path
  // ipcMain.handle registrations above and Menu.setApplicationMenu(null) all sat
  // inside the theme-protocol chore's measured window (each chore is measured as
  // mark[n] − mark[n−1]). This mark separates them from registerThemeProtocol().
  perfMark('main:chore:ipc-prefs:done');

  registerThemeProtocol();
  perfMark('main:chore:theme-protocol:done');

  // Marketplace auth store — instantiated once at startup, passed to IPC handlers.
  // The auth store holds the bearer token in the main process only; the token
  // never crosses the contextBridge into the renderer.
  const marketplaceAuthStore = createAuthStore(app.getPath('userData'));
  registerMarketplaceApiHandlers(marketplaceAuthStore, skillProvider);
  // Catch-up for sessions that signed in before reconcile existed, and for
  // plugins installed on another device since last launch. No-ops when signed
  // out; never awaited (bookkeeping must not delay startup).
  void reconcileInstalls(marketplaceAuthStore, skillProvider);
  // Remote clients read the signed-in state through the WS server, which has no
  // ipcMain access — without this the game lobby showed "signed out" in a remote
  // browser while the host app was signed in.
  remoteServer.setAccountStore(marketplaceAuthStore);
  // Accounts Phase 2 — social graph (friends/requests/blocks) IPC. Shares the
  // same token-bound auth store; handlers live in a sibling module to keep the
  // account file focused on auth + marketplace writes. windowRegistry +
  // remoteServer let the presence relay (Task 6) reach every local window and
  // any connected remote browser.
  registerSocialHandlers(marketplaceAuthStore, windowRegistry, remoteServer);
  // Games arcade scores (spec §6.1). Same token-bound store; its own module for
  // the same reason social has one — the account file stays about auth.
  registerArcadeHandlers(marketplaceAuthStore);
  // Voice typing (design 2026-09-05). WITHOUT THIS LINE the six `voice:*`
  // channels exist in preload.ts and nothing answers them, so tapping the
  // microphone would hang forever — the feature would ship dead. It takes only
  // the userData path: everything else it needs (the downloaded speech engine,
  // the window that opened the mic) it resolves for itself.
  registerVoiceHandlers(app.getPath('userData'));
  // Named "accounts", not "auth-store": this window covers five registrations —
  // createAuthStore, registerMarketplaceApiHandlers, remoteServer.setAccountStore,
  // registerSocialHandlers and registerArcadeHandlers — not just the store.
  perfMark('main:chore:accounts:done');

  perfMark('main:create-window:start');
  createWindow(isFirstRun ? firstRunManager : undefined);
  perfMark('main:create-window:done');
  registerDetachIpc();

  // Buddy window position persistence — JSON file in userData so restarts
  // restore the mascot to where the user left it. Keyed by 'mascot' only:
  // the chat key was dropped (written but never read — chat is always
  // re-anchored to the mascot on show).
  const BUDDY_POS_FILE = path.join(app.getPath('userData'), 'buddy-positions.json');
  // `mascot` = last free position; `dock` = edge the buddy was docked to
  // (spec §6.1 — a docked buddy is still docked after a restart).
  interface BuddyPositionsFile {
    mascot?: { x: number; y: number };
    dock?: 'left' | 'right' | 'top' | 'bottom';
    // Linux Wayland overlay only (Task 3+): whether the overlay window
    // should stay above fullscreen apps via Task 8's KWin script. Absent
    // (undefined/falsy) is the correct default everywhere else — the
    // three-window model never reads this field.
    keepAbove?: boolean;
  }
  function loadBuddyPositions(): BuddyPositionsFile {
    try { return JSON.parse(fs.readFileSync(BUDDY_POS_FILE, 'utf8')); } catch { return {}; }
  }
  function saveBuddyPositions(obj: BuddyPositionsFile): void {
    try { fs.writeFileSync(BUDDY_POS_FILE, JSON.stringify(obj)); } catch {}
  }
  const buddyPositions = loadBuddyPositions();

  // ─── The Linux/KDE buddy helper: launch housekeeping, before any buddy ────
  //
  // On a native-Wayland desktop an app is not allowed to move its own windows,
  // so the buddy appears and then refuses to be dragged. A small script running
  // inside KDE's window manager can move it. This runs BEFORE the buddy exists,
  // and it is awaited rather than fired off, because everything below depends on
  // the answer.
  //
  // On Windows, macOS, Linux/X11 and a Wayland desktop running this app through
  // XWayland, both calls return immediately without touching anything, and
  // everything after this point behaves exactly as it did before.
  //
  // syncHelperOnLaunch does two chores: it removes helper scripts left behind by
  // profiles that no longer exist (each one keeps running inside the window
  // manager and fights over the buddy on every drag frame), and it quietly
  // replaces our own copy when the app has been updated.
  // Wrapped, and deliberately so: every buddy IPC handler below is registered
  // AFTER these two awaits, so a throw here would silently leave the buddy — and
  // the session-attention indicator — with no handlers at all, and the process
  // unhandledRejection listener would swallow it. The helper is optional; the
  // launch is not. (B4 review, F2.)
  await syncHelperOnLaunch().catch(() => { /* an un-swept orphan is inert; launch matters more */ });
  const helperAtLaunch = await refreshBuddyHelperStatus().catch(
    () => ({ needed: false, supported: false, installed: false }) as const,
  );

  // WHY this lookup exists and is built only where it is needed: on native
  // Wayland the desktop will not tell an app how much of the screen the taskbar
  // has reserved — Electron reports the WHOLE screen (measured: 1707x1067 while
  // KDE had reserved 52 px). Believing it puts the mascot 52 px too low, standing
  // on the clock and system tray, and nothing ever corrects it because the app is
  // never told where the compositor really put him. This asks KDE directly.
  // Everywhere else Electron's own answer is right and stays in use, untouched.
  const buddyWorkArea = helperAtLaunch.needed ? new WorkAreaResolver() : null;
  if (buddyWorkArea) {
    // Start the lookup now instead of at the first show(): the buddy's first
    // appearance waits for this answer either way (BuddyWindowManager.show
    // defers until it settles), and starting it here means the wait is normally
    // already over by the time the user switches him on.
    void buddyWorkArea.refresh();

    // Screens being plugged in, unplugged or rearranged all invalidate which
    // KDE screen each of Electron's displays is, so all three events re-ask.
    //
    // Debounced because KDE fires display-metrics-changed THREE TIMES within
    // 200 ms of a window appearing (measured — buddy-overlay-manager.ts:110),
    // so an undebounced handler would run the whole lookup three times over
    // every time the buddy is shown.
    //
    // Moving a taskbar, or setting it to auto-hide, fires NO event at all —
    // nothing in KDE publishes one (verified: its strut service has zero
    // signals) — so that case is caught when the buddy is shown and again at
    // the start of each drag, which BuddyWindowManager already does.
    const reresolveWorkArea = (() => {
      let t: NodeJS.Timeout | null = null;
      return () => {
        if (t) clearTimeout(t);
        t = setTimeout(() => { void buddyWorkArea.refresh(); }, 250);
      };
    })();
    screen.on('display-metrics-changed', reresolveWorkArea);
    screen.on('display-added', reresolveWorkArea);
    screen.on('display-removed', reresolveWorkArea);
  }

  // WHY branch here (not inside BuddyWindowManager/BuddyOverlayManager
  // themselves): main.ts is the only place that knows both which strategy
  // is active AND how to build a BrowserWindow (createAppWindow) — the two
  // managers stay ignorant of each other. Windows/macOS/Linux-X11 get the
  // EXACT SAME BuddyWindowManager construction as before this branch existed
  // (same deps object, unchanged) — only Linux Wayland (or an explicit
  // YOUCODED_BUDDY_STRATEGY override) takes the overlay path.
  const buddyStrategy = chooseBuddyStrategy(process.platform, process.env);
  const buddyManager: BuddyManager = buddyStrategy === 'overlay'
    ? new BuddyOverlayManager({
        createOverlayWindow: ({ width, height }) => createAppWindow({ width, height, buddy: 'overlay' }),
        getPersisted: () => ({
          mascot: buddyPositions.mascot ?? null,
          dock: buddyPositions.dock ?? null,
          keepAbove: !!buddyPositions.keepAbove,
        }),
        persist: (state) => {
          buddyPositions.mascot = state.mascot;
          if (state.dock) buddyPositions.dock = state.dock;
          else delete buddyPositions.dock;
          saveBuddyPositions(buddyPositions);
        },
        registry: windowRegistry,
        mainWindow: () => mainWindow,
        // Status pushes go to every window (main app Settings panels + buddy
        // surfaces) so the "Hidden until restart" row state renders live.
        onStatusChanged: (status) => {
          for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send(IPC.BUDDY_STATUS_CHANGED, status);
          }
        },
        // Task 8: real KWin "keep above" script runner. Fire-and-forget —
        // BuddyOverlayDeps.applyKeepAbove is `void`, and the overlay's own
        // construction/recreate path shouldn't block on a DBus round-trip;
        // a slow or failed call just means the window briefly isn't pinned,
        // not a functional break (applyKwinKeepAbove never throws).
        applyKeepAbove: (_win) => { void applyKwinKeepAbove(OVERLAY_TITLE, true); },
      })
    : new BuddyWindowManager({
        // `title` is the caption that positions the window on native-Wayland
        // Linux; it is undefined on every other platform (see buddy-caption.ts).
        createBuddyWindow: (variant, { x, y, title }) => createAppWindow({ x, y, buddy: variant, buddyTitle: title }),
        getPersistedPosition: (key) => buddyPositions[key] ?? null,
        setPersistedPosition: (key, pos) => {
          buddyPositions[key] = pos;
          saveBuddyPositions(buddyPositions);
        },
        getPersistedDock: () => buddyPositions.dock ?? null,
        setPersistedDock: (edge) => {
          if (edge) buddyPositions.dock = edge;
          else delete buddyPositions.dock;
          saveBuddyPositions(buddyPositions);
        },
        registry: windowRegistry,
        mainWindow: () => mainWindow,
        // Status pushes go to every window (main app Settings panels + buddy
        // surfaces) so the "Hidden until restart" row state renders live.
        onStatusChanged: (status) => {
          for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send(IPC.BUDDY_STATUS_CHANGED, status);
          }
        },
        // Where the buddy is allowed to sit on each screen. Supplied ONLY on
        // native-Wayland Linux; `undefined` everywhere else, which is what makes
        // every other platform keep Electron's own number, byte for byte.
        //
        // The RESOLVER is handed over, not a rectangle: the lookup is async and
        // show() places the mascot synchronously, so pre-resolving here would
        // still leave the first buddy of a session placed against a number that
        // had not arrived. The manager waits for it instead.
        workArea: buddyWorkArea ?? undefined,
        // "Does moving this window mean renaming it?" — asked on EVERY FRAME of
        // a drag, which is why it reads a value already in memory and never
        // makes a call. True only where the app cannot move its own windows AND
        // the KDE script that can is actually running; false on every other
        // platform, always, so every position is applied the ordinary way.
        captionChannelLive: () => {
          const s = cachedBuddyHelperStatus();
          return s?.needed === true && s.installed === true;
        },
      });
  // Publish to module scope so createAppWindow's 'closed' handler can see it.
  buddyManagerRef = buddyManager;

  // If the helper stops being live while the buddy is up — the user switches the
  // KWin script off in KDE's System Settings, or KWin is briefly unreachable —
  // put the buddy away rather than leaving one that cannot be dragged and whose
  // chat and bar open in the screen corner. Design §4 added the re-check to
  // NOTICE this; without a reaction, noticing changed nothing.
  setBuddyHelperLostHandler(() => buddyManager.hide());

  // ─── CONSENT IS ENFORCED HERE, not in the settings screen (design §5) ────
  //
  // The product promise is "decline the helper and you get no buddy at all",
  // and a check in the settings screen cannot keep it: the settings screen is
  // not the only thing that turns the buddy on — the app also brings him back
  // at launch from a saved preference, with no helper check anywhere on that
  // path. Without this line, a user who declined (or who never got asked,
  // because the status lookup failed) gets a buddy who appears and then refuses
  // to be dragged: the exact bug this feature exists to remove.
  //
  // It refuses on "a helper is needed here", NEVER on "this is Linux". A KDE
  // user on X11 — or on Wayland whose windows are actually X11-backed, which
  // looks identical from every environment variable — moves his own windows
  // perfectly well and must never lose a buddy that already works.
  //
  // The status is re-read on every show rather than trusted from launch,
  // because the user can switch the script off in KDE's own System Settings
  // while YouCoded is running (design §4).
  ipcMain.handle(IPC.BUDDY_SHOW, async () => {
    const refusal = buddyShowRefusal(await refreshBuddyHelperStatus());
    if (refusal) return { ok: false, reason: refusal };
    buddyManager.show();
    return { ok: true };
  });
  ipcMain.handle(IPC.BUDDY_HIDE, () => buddyManager.hide());
  ipcMain.handle(IPC.BUDDY_TOGGLE_CHAT, () => buddyManager.toggleChat());
  ipcMain.handle(IPC.BUDDY_SET_SESSION, (_evt, sessionId: string) => {
    buddyManager.setViewedSession(sessionId);
  });
  ipcMain.handle(IPC.BUDDY_SUBSCRIBE, (evt, sessionId: string) => {
    windowRegistry.subscribe(sessionId, evt.sender.id);
    // No replay kick is needed here — the renderer calls
    // window.claude.detach.requestTranscriptReplay(sessionId) right after
    // subscribe resolves, which sends IPC.TRANSCRIPT_REPLAY; history
    // streams back via the normal TRANSCRIPT_EVENT channel, which reaches
    // owner ∪ subscribers (including this new subscription) thanks to A2.
  });
  ipcMain.handle(IPC.BUDDY_UNSUBSCRIBE, (evt, sessionId: string) => {
    windowRegistry.unsubscribe(sessionId, evt.sender.id);
  });
  ipcMain.handle(IPC.BUDDY_GET_VIEWED_SESSION, () => buddyManager.getViewedSession());
  // Fire-and-forget drag handler. High-frequency (one event per pointermove);
  // using ipcMain.on rather than ipcMain.handle avoids the async round-trip.
  // CSS -webkit-app-region: drag was removed from BuddyMascot because on
  // Windows Electron implements it via WM_NCHITTEST → HTCAPTION, which makes
  // the OS consume all pointer events for window dragging — the renderer
  // never gets pointerup, so click-to-toggle-chat never fires.
  // The payload is WINDOW-LOCAL on purpose — how far the cursor has strayed
  // from the pixel it grabbed him by, inside the mascot's own window. A
  // renderer's screen coordinates are a lie on Wayland (probe Round 8:
  // window.screenX stayed 0 through three real moves), and feeding them back
  // made the buddy bounce between two points every frame. See
  // BuddyWindowManager.moveMascotFromPointer.
  ipcMain.on(IPC.BUDDY_MOVE_MASCOT, (_evt, target: { localDx: number; localDy: number }) => {
    buddyManager.moveMascotFromPointer(target.localDx, target.localDy);
  });
  // Drag release → edge-snap detection against the window's final bounds.
  ipcMain.on(IPC.BUDDY_DRAG_ENDED, () => buddyManager.dragEnded());
  // Linux Wayland overlay only (Task 4). Both handlers verify the sender is
  // the overlay's own webContents before acting — guarding on sender identity
  // keeps a compromised main window from puppeting the overlay's input mode
  // (set-interactive) or writing bogus positions (persist). No-op everywhere
  // else: buddyManager is a BuddyWindowManager on Windows/macOS/Linux-X11,
  // so the `instanceof` check alone already short-circuits these to nothing.
  ipcMain.on(IPC.BUDDY_OVERLAY_SET_INTERACTIVE, (evt, { interactive }: { interactive: boolean }) => {
    if (buddyManager instanceof BuddyOverlayManager && buddyManager.isBuddyWindow(BrowserWindow.fromWebContents(evt.sender)!)) {
      buddyManager.setInteractive(interactive);
    }
  });
  ipcMain.on(IPC.BUDDY_OVERLAY_PERSIST, (evt, state: { mascot: { x: number; y: number }; dock: 'left' | 'right' | 'top' | 'bottom' | null }) => {
    if (buddyManager instanceof BuddyOverlayManager && buddyManager.isBuddyWindow(BrowserWindow.fromWebContents(evt.sender)!)) {
      buddyManager.persistFromRenderer(state);
    }
  });
  // Overlay renderer pulls its boot geometry once mounted (replaces the old
  // did-finish-load push, which raced React's mount and got dropped — see
  // BuddyOverlayManager.initPayloadForSender / BuddyApi.overlayReady WHYs).
  // Sender guard lives inside initPayloadForSender; non-overlay senders and
  // three-window platforms get null.
  ipcMain.handle(IPC.BUDDY_OVERLAY_READY, (evt) =>
    buddyManager instanceof BuddyOverlayManager ? buddyManager.initPayloadForSender(evt.sender) : null
  );
  // Task 8: Settings' KDE keep-above toggle. Persists to BUDDY_POS_FILE (so
  // the next overlay show()/recreate reads it via getPersisted() and
  // reapplies — KWin state doesn't survive window recreation) AND applies
  // it live immediately against the overlay's current window, since a
  // toggle flip mid-session doesn't otherwise trigger a recreate. Not
  // gated on buddyManager's type: applyKwinKeepAbove filters by caption, and
  // only the overlay window is ever titled OVERLAY_TITLE (buddy-overlay-
  // manager.ts), so this is naturally a no-op on the three-window model.
  //
  // WHY persist the REQUEST, not the outcome: a failed apply here
  // (GNOME/wlroots, or KWin just not answering DBus yet at login) doesn't
  // mean the user's intent changed. Persisting `enabled && ok` instead
  // would silently downgrade a real "yes, pin me" request to off and stop
  // retrying on every future recreate — including a later session where
  // KWin has since become available. Controller ruling (2026-07-22): the
  // Settings toggle mirrors this exactly — it's a saved preference, not a
  // live-state indicator, and always displays/persists the request in both
  // directions (see SettingsPanel.tsx's toggleKeepAbove). The `ok` this
  // handler returns is used there only to drive a transient, honest inline
  // hint ("couldn't reach KWin right now") — never to flip the toggle
  // itself back.
  ipcMain.handle(IPC.BUDDY_OVERLAY_KEEP_ABOVE, async (_evt, enabled: boolean) => {
    buddyPositions.keepAbove = enabled;
    saveBuddyPositions(buddyPositions);
    return applyKwinKeepAbove(OVERLAY_TITLE, enabled);
  });
  ipcMain.handle(IPC.BUDDY_DISMISS, () => buddyManager.dismiss());
  // keepAbove rides along on getStatus() (see BuddyApi.getStatus WHY comment
  // in shared/types.ts) — merged in from the persisted positions file here
  // rather than through buddyManager.getStatus(), since keepAbove isn't part
  // of the BuddyManager interface (Windows/macOS/Linux-X11 never touch it).
  ipcMain.handle(IPC.BUDDY_GET_STATUS, () => ({
    ...buddyManager.getStatus(),
    keepAbove: !!buddyPositions.keepAbove,
  }));
  // Restore + focus the main window, then ask it to switch to the buddy's
  // viewed session so the user lands in the same conversation (spec §4.2).
  ipcMain.handle(IPC.BUDDY_OPEN_MAIN, () => {
    // Same source of truth the buddyManager deps use for mainWindow.
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    const sid = buddyManager.getViewedSession();
    if (sid) win.webContents.send(IPC.SESSION_FOCUS_REQUEST, sid);
  });

  // Desktop-capture action: screenshot the display the mascot sits on,
  // excluding the buddy windows themselves.
  //
  // Two exclusion strategies, picked at runtime:
  //
  // 1. NATIVE EXCLUSION (preferred). excludeFromCapture() applied to
  //    each buddy window at creation time (Windows 10 build 19041+ via
  //    WDA_EXCLUDEFROMCAPTURE; macOS via NSWindowSharingNone). Buddy
  //    stays fully visible to the user but invisible to every screen-
  //    capture API, including our own desktopCapturer. Zero flicker.
  //
  // 2. OPACITY-DIM FALLBACK. On older Win10, Linux, or if the koffi
  //    binding failed to load, we dip the buddy windows to opacity 0
  //    for ~60 ms, capture, and restore. One-frame flicker but still a
  //    clean desktop shot. We chose opacity over hide/show because on
  //    frameless+transparent+alwaysOnTop windows the hide path can
  //    strand them invisible until the app restarts.
  //
  // Why NOT setContentProtection(true) on Windows: it maps to
  // WDA_MONITOR which paints the window solid black during capture —
  // three black rectangles in the screenshot.
  ipcMain.handle(IPC.BUDDY_CAPTURE_DESKTOP, async (): Promise<string | null> => {
    const { desktopCapturer } = require('electron') as typeof import('electron');
    // WHY: go through the BuddyManager interface instead of the three-window
    // getters (getMascotWindow/getChatWindow/getBarWindow) so this handler
    // works unchanged whichever strategy is active (three windows or the
    // Linux Wayland overlay). captureWindows() already filters to alive,
    // non-destroyed windows, mascot first when present — same set and same
    // ordering the old three getters produced.
    const liveBuddyWindows = buddyManager.captureWindows();
    const mascotWin = liveBuddyWindows[0] ?? null;
    // Pick the display the mascot lives on — multi-monitor users expect
    // "screenshot my desktop" to mean the one their buddy is sitting on,
    // not every monitor merged into one long strip.
    // WHY (targetDisplay): picks mascot's display when present, or primary
    // display as fallback. Theoretical "mascot gone but chat/bar alive" state
    // would pick the surviving window's display instead — but hide() clears all
    // three windows together, so behavior is unchanged in practice.
    // WHY getBounds() here is safe even for the overlay (coordinator review
    // finding 4 — this branch otherwise never reads getBounds()/getPosition()
    // on the overlay window, since Wayland echoes stale/construction values
    // for it): the overlay is always constructed AT the primary display's
    // bounds and never moved (buddy-overlay-manager.ts's createWindow), so
    // the echoed construction bounds still resolve to the correct (primary)
    // display via getDisplayMatching — there's no live-position read being
    // relied on here, just a display lookup that happens to land right by
    // construction.
    const targetDisplay = mascotWin
      ? screen.getDisplayMatching(mascotWin.getBounds())
      : screen.getPrimaryDisplay();

    // If the platform supports native capture exclusion (set at window
    // creation in createAppWindow), the buddies are already invisible to
    // desktopCapturer and we skip the opacity dip entirely.
    const needsOpacityFallback = !nativeCaptureExclusionAvailable();
    const buddyWindows = needsOpacityFallback ? liveBuddyWindows : [];

    try {
      if (needsOpacityFallback) {
        // One compositor frame (~16 ms) suffices; 60 ms cushions slower
        // machines. The buddy is visually invisible during this window —
        // reads as a single-frame flicker, NOT a vanishing event.
        for (const w of buddyWindows) w.setOpacity(0);
        await new Promise<void>((r) => setTimeout(r, 60));
      }

      // Request thumbnails at physical pixel resolution so the saved
      // PNG is full-res, not a 150×150 thumbnail. display.size is in
      // DIPs — multiply by scaleFactor for HiDPI screens.
      const sf = targetDisplay.scaleFactor || 1;
      const thumbnailSize = {
        width: Math.round(targetDisplay.size.width * sf),
        height: Math.round(targetDisplay.size.height * sf),
      };
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
      // Match by display_id. On Electron, display_id is a stringified
      // number equal to Electron's display.id — but on some Linux setups
      // it comes back empty, so we fall back to the first screen source
      // if an exact match isn't found.
      const targetId = String(targetDisplay.id);
      const src = sources.find((s) => s.display_id === targetId) ?? sources[0];
      if (!src) return null;
      const pngBuffer = src.thumbnail.toPNG();

      // Write to a timestamped temp file. InputBar renders the preview
      // with <img src={`file://${path}`}> and sends the path as input to
      // the PTY, so a stable on-disk path is exactly what it wants.
      const tmpName = `youcoded-buddy-capture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
      const tmpPath = path.join(os.tmpdir(), tmpName);
      await fs.promises.writeFile(tmpPath, pngBuffer);

      // Push to the chat renderer specifically — it's the only window
      // whose InputBar should auto-attach this capture. We resolve via
      // buddyManager instead of broadcasting because other windows
      // (main, detached peers) shouldn't auto-attach a screenshot the
      // user took from the floater's capture button.
      buddyManager.chatWebContents()?.send(IPC.BUDDY_ATTACH_FILE, tmpPath);
      return tmpPath;
    } catch (err) {
      log('ERROR', 'Buddy', 'capture-desktop failed', { error: String(err) });
      return null;
    } finally {
      // Always restore opacity — even on error — so a failed capture
      // (e.g. macOS screen-recording permission denial) can't leave the
      // buddy invisible. No-op when we didn't dip in the first place.
      for (const w of buddyWindows) {
        if (!w.isDestroyed()) w.setOpacity(1);
      }
    }
  });

  // Wire the attention:report IPC channel. Renderers push per-session states
  // here; module-scope attentionReports + debouncedBroadcastAttention aggregate
  // and fan out the summary. The Map and debouncer are module-scope so the
  // 'closed' handler in createAppWindow can also clean up on window removal.
  ipcMain.on(IPC.ATTENTION_REPORT, (evt, payload: AttentionReport) => {
    let byWin = attentionReports.get(evt.sender.id);
    if (!byWin) { byWin = new Map(); attentionReports.set(evt.sender.id, byWin); }
    if ('clear' in payload) {
      byWin.delete(payload.sessionId);
    } else {
      byWin.set(payload.sessionId, {
        attentionState: payload.attentionState,
        awaitingApproval: payload.awaitingApproval,
        status: payload.status,
      });
    }
    debouncedBroadcastAttention();
  });

  // Pull-style companion to the SESSION_ATTENTION_SUMMARY push. A renderer
  // calls this from its mount effect so a window opened mid-turn draws the
  // right dot immediately instead of waiting for the next state flip.
  ipcMain.handle(IPC.ATTENTION_GET_SUMMARY, async () => buildAttentionSummary());

  // Start native sync service — owns push/pull lifecycle, background timer,
  // session-end sync. Replaces bash hook sync when app is running.
  const syncService = new SyncService();
  setSyncService(syncService);
  syncService.start().catch(e => log('ERROR', 'Main', 'SyncService start failed', { error: String(e) }));

  // Shared GitHub client (Phase 2, 2026-07-22 sync-setup overhaul): token
  // custody (safeStorage in the PER-INSTALL userData dir — never ~/.claude or
  // a synced space) + REST repo provisioning. MUST be registered before
  // startSyncSpaces: provisioning and the transport's credential provider
  // read it via getGithubClient().
  setGithubClient(createGithubClient({
    storageDir: app.getPath('userData'),
    safeStorage,
    log: (m) => log('INFO', 'GithubClient', m),
  }));

  // Cross-device sync spaces (spec 2026-07-03). Roots always ensured (the
  // session picker lists them); the engine runs only when the user enabled
  // sync. Wire the remote broadcaster first so engine events fired during the
  // initial reconcile still reach any already-connected remote clients.
  setSyncSpacesRemoteBroadcaster((e) => remoteServer.broadcast({ type: 'syncspaces:event', payload: e }));
  // SyncHub (Plan 1b) reads the marketplace token to auth its WebSocket. Reuse
  // the same auth store the social/marketplace handlers own; getToken() is read
  // lazily per-connect so sign-in/out mid-session is picked up without a restart.
  // Must be set before startSyncSpaces so a sync enabled at boot can connect.
  setSyncSpacesAuthStore(marketplaceAuthStore);
  // Plan 2b Task 8: route hub lease events to the lease client, which filters to
  // sessions THIS device actually holds before driving the handoff.
  //
  // BOTH 'takeover-request' AND 'taken' drive the holder teardown:
  //   - 'takeover-request': a peer asked politely — interrupt, flush, release so it
  //     can acquire. The requester is waiting on our release.
  //   - 'taken': a peer FORCE-acquired the lease (its user confirmed the steal after
  //     we didn't respond in time). The lease is already gone; if we don't interrupt
  //     + flush NOW, our in-flight turn never reaches the space and the requester
  //     resumes a stale copy (the 2026-07-18 lost-turns bug). handleTakeoverRequest's
  //     held.has() guard no-ops the ATTACKER (who doesn't hold the session) so only
  //     the VICTIM tears down — the 'taken' frame carries no deviceId to compare.
  //
  // KNOWN RESIDUAL WINDOW: on 'taken' the requester has already force-acquired and is
  // pulling immediately, so it may grab the pre-flush copy. The holder's awaited flush
  // (HANDOFF_SYNC_TIMEOUT_MS) shrinks this from "never flushes" to a ~1s race, but
  // fully closing it needs the requester to wait on a holder ack — the deferred
  // holder-ack protocol (investigation Fix 4). Do not assume 'taken' => turn saved.
  setSyncSpacesLeaseEventListener((ev) => {
    if (ev.kind === 'takeover-request' || ev.kind === 'taken') {
      leaseClient?.handleTakeoverRequest(ev.sessionId, ev.from);
    }
  });
  startSyncSpaces(
    async () => {
      // Daily dated backup targets come from the SAME backend config the legacy
      // system uses — drive + iCloud only (GitHub is sync, not backup; spec §11).
      // getSyncConfig is async and exposes the backends array as `.backends`
      // (each BackendInstance carries type-specific fields in `.config`).
      const cfg = await getSyncConfig();
      return (cfg?.backends ?? [])
        .filter((b) => b.type === 'drive' || b.type === 'icloud')
        .map((b) => b.type === 'drive'
          ? { type: 'drive' as const, base: `${b.config?.rcloneRemote ?? 'gdrive'}:${b.config?.DRIVE_ROOT ?? 'Claude'}` }
          // iCloud base is a local folder path — drop backends that never set one.
          : { type: 'icloud' as const, base: b.config?.ICLOUD_PATH ?? '' })
        .filter((t) => t.base.length > 0);
    },
    (m) => log('INFO', 'SyncSpaces', m),
    // Durable machineId → keys the hub's per-device sync-recency map (same id the
    // device registry rows use). Null on machines without a built-app identity.
    machineIdentity?.id ?? null,
  ).catch(e => log('ERROR', 'Main', 'SyncSpaces start failed', { error: String(e) }));

  // Device registry (spec §10a, Plan 2b): stamp this MACHINE's record (friendly
  // name + lastSeen) on launch so the "Your devices" list is never empty. No-op
  // when sync is off (no personal root yet).
  //
  // Keys on machineIdentity, NOT deviceIdentity: deviceIdentity is per-INSTALL, so
  // registering it gave every YOUCODED_PROFILE its own permanent "GalaxyBook" row.
  // A null machineIdentity means no durable id (no built app on this machine, or
  // the id write failed) — register NOTHING. Registering an ephemeral id would
  // leave a fresh orphan row on every launch, which is the same bug, worse.
  try {
    const pr = getManagedRoots()?.personalRoot;
    if (pr && machineIdentity) void upsertSelf(pr, { id: machineIdentity.id, platform: process.platform }).catch(() => { /* best-effort */ });
    else if (pr) log('INFO', 'Main', 'Device registry: no durable machine identity — skipping self-registration');
    // One-time migration off the LEGACY in-space lease dir. Those files are
    // TRACKED in the space's git repo, and `git add -A` re-stages tracked files
    // regardless of the ignore list — so adding 'Leases/' to DEFAULT_IGNORES
    // silences new installs but cannot stop an existing repo churning. Removing
    // them yields ONE final delete-commit, then permanent silence.
    if (pr) {
      const swept = sweepLegacyLeaseDir(pr);
      if (swept > 0) log('INFO', 'Main', `Removed ${swept} legacy in-space lease file(s) — leases now live in userData`);
    }
  } catch { /* sync not configured */ }

  // Conversation Store (Phase 2a): records + transcript sync ride the personal
  // space. Started after startSyncSpaces because getManagedRoots() must be
  // populated (its synchronous prologue creates the roots before its first
  // await, so the roots exist by the time this line runs). startConversationStore
  // resolves fast — the first-run reconcile inside is detached (may mirror GBs).
  // Fix: pauseSweeps quiesces the startup reconcile/materialize kicks (and any
  // trigger that fires while the repair runs) so the one-shot slug repair
  // below never races them — a race here re-quarantines and re-resurrects
  // records on every launch (found on the real-data run, see resumeSweeps'
  // caller-side note and pauseSweeps' WHY in conversations/service.ts).
  // .finally ALWAYS resumes, even if the repair throws, so a bad repair can't
  // leave sync mirroring silently disabled forever.
  startConversationStore({ pauseSweeps: true })
    .then(() => runSlugRepair())   // idempotent; runs with the sweeps quiesced (spec §6)
    .catch(e => log('ERROR', 'Main', 'ConversationStore start / slug repair failed', { error: String(e) }))
    .finally(() => resumeSweeps());

  // One-time symlink sweep (Plan 2c): the legacy SyncService.aggregateConversations()/
  // rewriteProjectSlugs() (deleted this release) left ~hundreds of symlinks/junctions
  // in ~/.claude/projects/. Deleting the creators does NOT remove links already on
  // disk — this sweep does. lstat-only, removes ONLY symlinks/junctions, never real
  // files. Idempotent (0 removals after the first run), so no once-marker is needed.
  // Detached so ~hundreds of lstats never block startup. The 2a reconciler's own
  // symlink-skip (conversations/reconciler.ts) stays as a harmless defense.
  setImmediate(() => {
    try {
      const { removed, failed } = sweepProjectSymlinks(path.join(os.homedir(), '.claude', 'projects'));
      log('INFO', 'Main', 'Legacy slug-symlink sweep complete', { removed, failed });
    } catch (e) {
      log('ERROR', 'Main', 'Legacy slug-symlink sweep failed', { error: String(e) });
    }
  });

  // Tag registry (design §"Storage & sync layout") — same Personal sync space,
  // resolved after managed roots exist (same ordering as startConversationStore).
  startTagRegistry();

  // After the store AND tag registry — the index denormalizes both.
  startChatsearchIndex();
  // WHY after the index: the drainer reads the same store root; requests it
  // applies trigger the index rebuild through emitConversationMetaChanged.
  startOutboxDrain();

  // The legacy session-end backup push (SyncService.pushSession) was removed in
  // sync-legacy-demolition. Conversations now travel via the sync-spaces
  // conversation store, so there is no session-exit backup hook here anymore.
  perfMark('main:post-window:done');
});

// Every teardown step the app owns, in one place, run at most once.
//
// WHY THIS EXISTS AS A FUNCTION (2026-08-05): this body used to live inline in
// the `window-all-closed` handler, which was the app's ONLY quit-related
// listener — verified by a repo-wide search for `app.on('before-quit'|
// 'will-quit'|'quit')` and `process.on('SIGTERM'|'SIGINT')`, which returned
// exactly one hit, this one. Every quit route that does NOT go through
// window-all-closed therefore ran none of it:
//   - macOS Cmd+Q and dock-quit call app.quit() directly, which fires
//     before-quit/will-quit/quit but NOT window-all-closed.
//   - An OS shutdown/logout SIGTERM bypasses Electron's quit events entirely,
//     on every platform.
// What leaked on those routes: llama-server (holding its fixed port for the
// next launch to wrongly adopt), the hook relay's named pipe, the sync-spaces
// watchers and timers, the presence WebSocket — and, since the native-MCP
// work, every stdio MCP server's spawned subprocess, which is the one a user
// would actually notice still running after quitting.
//
// The idempotence guard is not defensive coding: before-quit fires again on the
// second pass below, and window-all-closed can fire alongside it, so this WILL
// be called more than once on a normal quit.
let shuttingDown: Promise<void> | null = null;
function shutdownApp(): Promise<void> {
  if (shuttingDown) return shuttingDown;
  shuttingDown = runShutdown();
  return shuttingDown;
}

async function runShutdown(): Promise<void> {
  // Capture the engine-stop promise: cleanup() starts llama-server teardown and we
  // must let it finish before app.quit(), else the engine outlives the app and keeps
  // the fixed port bound for the next instance to wrongly adopt (2026-07-20 fix).
  const engineStopped = cleanupIpcHandlers ? cleanupIpcHandlers() : Promise.resolve();
  // Sign in with ChatGPT: stop the usage poll and close any lingering sign-in
  // listener on 1455. Best-effort like the other teardowns here.
  const chatgptDisposed = chatgptAuth?.dispose().catch(() => {}) ?? Promise.resolve();
  destroySocialHandlers(); // tear down the presence WebSocket + its timers
  // Kill the speech engine's own program. WHY IT IS HERE and not in its own
  // `app.on('before-quit')`: this function IS the before-quit path (see the
  // header above — the app deliberately has exactly one teardown route, so that
  // an OS shutdown or a Cmd+Q cleans up the same things a window close does).
  // A second before-quit listener would run on only two of the three routes and
  // leave a 1.14 GB speech process behind on the third.
  try { shutdownVoiceHandlers(); } catch {}
  sessionManager.destroyAll();
  hookRelay.stop();
  remoteServer.stop();
  // Stop the cross-device sync-spaces engine (clears its backup timer + watchers).
  // .catch, not try/catch: it's an async fn, so a failure arrives as a rejected
  // promise — the old `void` call left that rejection unhandled at quit.
  stopSyncSpaces().catch(() => {});
  // Stop the Conversation Store (Phase 2a) — unsubscribes the sync-spaces
  // listener, clears the periodic reconciler + pending debounce timers. Sync fn.
  try { stopConversationStore(); } catch {}
  try { stopChatsearchIndex(); } catch {}
  try { stopOutboxDrain(); } catch {}
  // Plan 2b Task 8: tear down the lease client so its per-session renew timers
  // don't linger past a hard quit (destroy clears all held timers). Sync fn.
  try { leaseClient?.destroy(); } catch {}
  // Stop sync service — clears timer, releases locks, removes .app-sync-active marker
  try { setSyncService(null); } catch {}
  // Wait for the engine to actually die, but never let a wedged teardown hang quit:
  // race the teardown against a 4s cap (supervisor's own SIGTERM→SIGKILL bound is ~3s).
  // Returned (not `void`-ed) so the callers below can sequence app.quit()/exit()
  // after it — this function no longer decides on its own when to quit.
  // chatgptDisposed joins the race: dispose() promises that every write in
  // flight lands, and a poll's read-modify-write cut off half-way is exactly the
  // torn account file the lock exists to prevent (review T4 F5). Same 4s cap.
  await Promise.race([
    Promise.all([engineStopped, chatgptDisposed]),
    new Promise<void>((r) => setTimeout(r, 4_000)),
  ]).catch(() => {});
}

// Route 1: last window closed. Delegate to app.quit() rather than tearing down
// here, so there is exactly ONE teardown path (before-quit, below) instead of
// two that can drift apart.
app.on('window-all-closed', () => {
  app.quit();
});

// Route 2: app.quit() from anywhere — macOS Cmd+Q, dock quit, the menu, or
// window-all-closed above. before-quit is cancellable, which is what lets an
// async teardown finish before the process goes away; `quit`/`will-quit` are
// not reliably awaitable.
app.on('before-quit', (e) => {
  // Second pass: shutdownApp() already ran (or is running) and re-issued the
  // quit below — let it proceed rather than cancelling forever.
  if (shuttingDown) return;
  e.preventDefault();
  void shutdownApp().finally(() => app.quit());
});

// Route 3: OS shutdown, logout, `kill`, or Ctrl+C in a dev terminal. These
// never reach Electron's quit events at all, so they need their own hook.
// app.exit() (not app.quit()) because teardown has already run by then and
// re-entering the quit sequence would only add another wait.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdownApp().finally(() => app.exit(0));
  });
}
