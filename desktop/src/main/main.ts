import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, screen, shell, webContents } from 'electron';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SessionManager } from './session-manager';
import { HookRelay } from './hook-relay';
import { WindowRegistry } from './window-registry';
import { registerIpcHandlers } from './ipc-handlers';
import { RemoteServer } from './remote-server';
import { RemoteConfig } from './remote-config';
import { LocalSkillProvider } from './skill-provider';
import { CommandProvider } from './command-provider';
import { IPC, PermissionOverrides, PERMISSION_OVERRIDES_DEFAULT, type AttentionState, type AttentionSummary, type AttentionReport } from '../shared/types';
import { VITE_DEV_PORT } from '../shared/ports';
import { log, rotateLog } from './logger';
import { registerThemeProtocol } from './theme-protocol';
import { FirstRunManager } from './first-run';
import { SyncService } from './sync-service';
import { setSyncService } from './sync-state';
import { initRestoreService } from './restore-service';
import { createAuthStore } from './marketplace-auth-store';
import { registerMarketplaceApiHandlers } from './marketplace-api-handlers';
import { requestChatSnapshot } from './chat-snapshot';
import { BuddyWindowManager } from './buddy-window-manager';
import { excludeFromCapture, nativeCaptureExclusionAvailable } from './window-exclude-capture';
import { cleanupStaleDownloads } from './update-installer';

// macOS and Linux Electron apps may inherit a minimal PATH that's missing
// common tool locations (Homebrew, nvm, Volta, pipx, cargo). macOS Finder/Dock
// only provides /usr/bin:/bin:/usr/sbin:/sbin. Linux Snap/Flatpak/some DEs may
// also strip user paths. Prepend common locations on both platforms.
// Windows is not affected — which.sync() resolves executables independently.
if (process.platform === 'darwin' || process.platform === 'linux') {
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

const execFileAsync = promisify(execFile);
// Resolve 'gh' path for Windows where Electron's PATH may not include it
let ghPath = 'gh';
try { const w = require('which'); ghPath = w.sync('gh'); } catch { /* use bare 'gh' */ }

let mainWindow: BrowserWindow | null = null;
// Module-level ref so createAppWindow's 'closed' handler can reach the
// BuddyWindowManager (defined later inside the ready-handler closure).
// Assigned once during setup; `createAppWindow` uses it to hide the buddy
// when the last main window closes (spec §7.6).
let buddyManagerRef: BuddyWindowManager | null = null;
let cleanupIpcHandlers: (() => void) | null = null;
const sessionManager = new SessionManager();

// Multi-window ownership: maps sessionId -> windowId and tracks leader for
// singletons (PartyKit lobby). Populated when sessions are created and
// when windows spawn/close. See window-registry.ts.
const windowRegistry = new WindowRegistry();
export function getWindowRegistry() { return windowRegistry; }

// IDs in the registry are webContents.id values, NOT BrowserWindow.id values.
// BrowserWindow.fromId(webContentsId) silently returns null, so previously
// every peer-window send fell through to the mainWindow fallback (window 1
// received events meant for window 2/3/etc). Always look up via webContents.
function windowFromWcId(wid: number): BrowserWindow | null {
  const wc = webContents.fromId(wid);
  return wc ? BrowserWindow.fromWebContents(wc) : null;
}

// Route a session-scoped IPC event to the window that currently owns the
// session. No-op if ownership is unknown (e.g., during teardown). Task 1.4
// will migrate ipc-handlers.ts emits to use this helper.
export function routeToOwner(sessionId: string, channel: string, ...args: unknown[]): void {
  const wid = windowRegistry.getOwner(sessionId);
  if (wid == null) return;
  const win = windowFromWcId(wid);
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
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
const remoteConfig = new RemoteConfig();
const skillProvider = new LocalSkillProvider();
skillProvider.ensureMigrated();
// Fire-and-forget: install bundled plugins if missing. Silent retry on
// every launch. See docs/superpowers/specs/2026-04-20-bundled-default-plugins-design.md.
void skillProvider.ensureBundledPluginsInstalled();

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
if (DEV_PROFILE) {
  app.setPath('userData', path.join(app.getPath('appData'), `youcoded-${DEV_PROFILE}`));
  app.setName(DEV_PROFILE === 'dev' ? 'YouCoded Dev' : `YouCoded Dev (${DEV_PROFILE})`);
}

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

/** Read current overrides (for ipc-handlers.ts startup load). */
export function getPermissionOverrides(): PermissionOverrides {
  return permissionOverrides;
}

function registerFirstRunIpc(
  mainWindow: BrowserWindow,
  firstRunManager: FirstRunManager,
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

  ipcMain.handle(IPC.FIRST_RUN_START_AUTH, async (_event, mode: 'oauth' | 'apikey') => {
    try {
      if (mode === 'oauth') {
        // claude auth login opens the browser itself — don't double-open
        await firstRunManager.handleOAuthLogin();
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
    try {
      const stateDir = path.join(os.homedir(), '.claude', 'toolkit-state');
      fs.mkdirSync(stateDir, { recursive: true });
      const configPath = path.join(stateDir, 'config.json');
      let config: any = {};
      try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
      config.setup_completed = true;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (e) { log('ERROR', 'FirstRun', 'Skip failed', { error: String(e) }); }
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

function recomputeAndBroadcastAttention(): void {
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
  const summary: AttentionSummary = { anyNeedsAttention, perSession };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.SESSION_ATTENTION_SUMMARY, summary);
  }
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
function createAppWindow(opts?: { x?: number; y?: number; width?: number; height?: number; maximize?: boolean; inactive?: boolean; buddy?: 'mascot' | 'chat' | 'capture' }): BrowserWindow {
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

  // Buddy window dimensions: mascot = 80×80; chat = 320×480; capture = 44×44
  // (Fluent-ish action-button size — big enough for a 20 px camera glyph
  // with a generous click target without dominating the mascot it sits
  // below.) Adjust both constants here AND the stack-offsets in
  // BuddyWindowManager.computeCapturePosition if you change them.
  const buddyDimensions: { width?: number; height?: number } = opts?.buddy === 'mascot'
    ? { width: 80, height: 80 }
    : opts?.buddy === 'chat'
    ? { width: 320, height: 480 }
    : opts?.buddy === 'capture'
    ? { width: 44, height: 44 }
    : {};

  const win = new BrowserWindow({
    width: buddyDimensions.width ?? opts?.width ?? 1200,
    height: buddyDimensions.height ?? opts?.height ?? 800,
    x: opts?.x,
    y: opts?.y,
    icon,
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
    if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
    return { action: 'deny' as const };
  });
  // Disable Chromium's pinch-to-zoom so our IPC zoom handler is the sole zoom path
  win.webContents.setVisualZoomLevelLimits(1, 1);

  if (opts?.maximize) win.maximize();

  // Append mode query param for buddy windows so React can branch on the mode
  const modeQuery = opts?.buddy ? `?mode=buddy-${opts.buddy}` : '';
  if (!app.isPackaged) {
    win.loadURL(`${DEV_SERVER_URL}${modeQuery}`);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'), {
      // loadFile expects search string WITHOUT the leading '?'
      search: modeQuery ? modeQuery.slice(1) : undefined,
    });
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

  cleanupIpcHandlers = registerIpcHandlers(ipcMain, sessionManager, mainWindow, skillProvider, commandProvider, hookRelay, remoteConfig, remoteServer, windowRegistry);

  if (firstRunManager) {
    registerFirstRunIpc(mainWindow, firstRunManager);
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
            const { detectAuth } = require('./prerequisite-installer');
            const result = await detectAuth();
            if (result.installed) return { currentStep: 'COMPLETE' };

            // Auth missing — spin up first-run at the auth step
            log('WARN', 'Main', 'Setup complete but auth missing — showing auth screen');
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
            ipcMain.handle(IPC.FIRST_RUN_START_AUTH, async (_event, mode: 'oauth' | 'apikey') => {
              try { if (mode === 'oauth') { await lateFirstRunManager!.handleOAuthLogin(); } } catch {} });
            ipcMain.handle(IPC.FIRST_RUN_SUBMIT_API_KEY, async (_event, key: string) => { try { await lateFirstRunManager!.handleApiKeySubmit(key); } catch {} });
            ipcMain.handle(IPC.FIRST_RUN_DEV_MODE_DONE, async () => { try { await lateFirstRunManager!.handleDevModeDone(); } catch {} });
            ipcMain.handle(IPC.FIRST_RUN_SKIP, async () => {
              try {
                const stateDir = path.join(os.homedir(), '.claude', 'toolkit-state');
                fs.mkdirSync(stateDir, { recursive: true });
                const cp = path.join(stateDir, 'config.json');
                let c: any = {}; try { c = JSON.parse(fs.readFileSync(cp, 'utf8')); } catch {}
                c.setup_completed = true; fs.writeFileSync(cp, JSON.stringify(c, null, 2));
              } catch {}
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

  // Appearance sync across peer windows. When one window writes a theme /
  // font / reduced-effects change, it broadcasts and every OTHER window
  // receives the same prefs via appearance:sync. ThemeProvider applies
  // locally without re-broadcasting (guarded by a ref) so there's no loop.
  ipcMain.on(IPC.APPEARANCE_BROADCAST, (evt, prefs) => {
    for (const wid of windowRegistry.getWindowIds()) {
      if (wid === evt.sender.id) continue;
      windowFromWcId(wid)?.webContents.send(IPC.APPEARANCE_SYNC, prefs);
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
    const src = windowFromWcId(srcWindowId);
    const tgt = windowFromWcId(targetWindowId);
    src?.webContents.send(IPC.SESSION_OWNERSHIP_LOST, { sessionId });
    tgt?.webContents.send(IPC.SESSION_OWNERSHIP_ACQUIRED, { sessionId, sessionInfo: info, freshWindow });
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

app.whenReady().then(async () => {
  await rotateLog();

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

  try {
    await hookRelay.start();
  } catch (e) {
    log('ERROR', 'Main', 'Failed to start hook relay', { error: String(e) });
  }

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

  // Sweep abandoned .partial files and downloads older than 24h from the
  // in-app update cache. Runs at every startup so stale downloads (e.g. from
  // a cancelled update on a prior session) don't accumulate on disk.
  try {
    cleanupStaleDownloads(path.join(app.getPath('userData'), 'update-cache'));
  } catch (e) {
    log('ERROR', 'Main', 'Failed to clean up stale update downloads', { error: String(e) });
  }

  // Decomposition v3 §9.3: reconcile plugin mcp-manifest.json into
  // ~/.claude.json mcpServers. Only auto:true entries, filtered by platform.
  // Never overwrites user-configured servers.
  try {
    const { reconcileMcp } = require('./mcp-reconciler');
    const mcpSummary = reconcileMcp();
    log('INFO', 'Main', 'MCP servers reconciled', mcpSummary);
  } catch (e) {
    log('ERROR', 'Main', 'Failed to reconcile MCP servers', { error: String(e) });
  }

  try {
    const { startAnnouncementService } = require('./announcement-service');
    startAnnouncementService();
  } catch (e) {
    log('ERROR', 'Main', 'Failed to start announcement service', { error: String(e) });
  }

  try {
    await remoteServer.start();
  } catch (e) {
    log('ERROR', 'Main', 'Failed to start remote server', { error: String(e) });
  }

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

  ipcMain.handle('github:auth', async () => {
    try {
      const { stdout: username } = await execFileAsync(ghPath, ['api', 'user', '--jq', '.login']);
      return { username: username.trim() };
    } catch (err: any) {
      // Log specific failure reason for debugging
      if (err.code === 'ENOENT') {
        log('WARN', 'GitHubAuth', 'gh CLI not found on PATH');
      } else if (err.stderr?.includes('not logged in')) {
        log('WARN', 'GitHubAuth', 'gh CLI not authenticated');
      } else {
        log('WARN', 'GitHubAuth', 'Failed', { error: String(err.message || err) });
      }
      return null;
    }
  });

  // Expose the system home directory to the renderer (async to avoid blocking)
  ipcMain.handle('get-home-path', () => os.homedir());

  // Remove the default menu bar (File, Edit, View, Window, Help)
  Menu.setApplicationMenu(null);

  registerThemeProtocol();

  // Marketplace auth store — instantiated once at startup, passed to IPC handlers.
  // The auth store holds the bearer token in the main process only; the token
  // never crosses the contextBridge into the renderer.
  const marketplaceAuthStore = createAuthStore(app.getPath('userData'));
  registerMarketplaceApiHandlers(marketplaceAuthStore);

  createWindow(isFirstRun ? firstRunManager : undefined);
  registerDetachIpc();

  // Buddy window position persistence — JSON file in userData so restarts
  // restore the mascot and chat to where the user left them. Keyed by
  // 'mascot' / 'chat'.
  const BUDDY_POS_FILE = path.join(app.getPath('userData'), 'buddy-positions.json');
  function loadBuddyPositions(): Record<string, { x: number; y: number } | undefined> {
    try { return JSON.parse(fs.readFileSync(BUDDY_POS_FILE, 'utf8')); } catch { return {}; }
  }
  function saveBuddyPositions(obj: Record<string, { x: number; y: number } | undefined>): void {
    try { fs.writeFileSync(BUDDY_POS_FILE, JSON.stringify(obj)); } catch {}
  }
  const buddyPositions = loadBuddyPositions();

  const buddyManager = new BuddyWindowManager({
    createBuddyWindow: (variant, { x, y }) => createAppWindow({ x, y, buddy: variant }),
    getPersistedPosition: (key) => buddyPositions[key] ?? null,
    setPersistedPosition: (key, pos) => {
      buddyPositions[key] = pos;
      saveBuddyPositions(buddyPositions);
    },
    registry: windowRegistry,
    mainWindow: () => mainWindow,
  });
  // Publish to module scope so createAppWindow's 'closed' handler can see it.
  buddyManagerRef = buddyManager;

  ipcMain.handle(IPC.BUDDY_SHOW, () => buddyManager.show());
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
  ipcMain.on(IPC.BUDDY_MOVE_MASCOT, (_evt, target: { targetX: number; targetY: number }) => {
    buddyManager.moveMascot(target.targetX, target.targetY);
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
    const mascotWin = buddyManager.getMascotWindow();
    const chatWin = buddyManager.getChatWindow();
    const captureWin = buddyManager.getCaptureWindow();
    // Pick the display the mascot lives on — multi-monitor users expect
    // "screenshot my desktop" to mean the one their buddy is sitting on,
    // not every monitor merged into one long strip.
    const targetDisplay = mascotWin && !mascotWin.isDestroyed()
      ? screen.getDisplayMatching(mascotWin.getBounds())
      : screen.getPrimaryDisplay();

    // If the platform supports native capture exclusion (set at window
    // creation in createAppWindow), the buddies are already invisible to
    // desktopCapturer and we skip the opacity dip entirely.
    const needsOpacityFallback = !nativeCaptureExclusionAvailable();
    const buddyWindows = needsOpacityFallback
      ? [mascotWin, chatWin, captureWin].filter((w): w is BrowserWindow => !!w && !w.isDestroyed())
      : [];

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
      const liveChat = buddyManager.getChatWindow();
      if (liveChat && !liveChat.isDestroyed()) {
        liveChat.webContents.send(IPC.BUDDY_ATTACH_FILE, tmpPath);
      }
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

  // Start native sync service — owns push/pull lifecycle, background timer,
  // session-end sync. Replaces bash hook sync when app is running.
  const syncService = new SyncService();
  setSyncService(syncService);
  syncService.start().catch(e => log('ERROR', 'Main', 'SyncService start failed', { error: String(e) }));
  // Initialize restore service after sync is live — it needs SyncService to
  // flip restoreInProgress, which pauses the push loop during restore/undo.
  initRestoreService(syncService, app.getPath('userData'));
  // Push session JSONL on session close (replaces session-end-sync.sh)
  sessionManager.on('session-exit', (sessionId: string) => {
    syncService.pushSession(sessionId).catch(e =>
      log('ERROR', 'Main', 'Session-end sync failed', { sessionId, error: String(e) })
    );
  });
});

app.on('window-all-closed', () => {
  if (cleanupIpcHandlers) cleanupIpcHandlers();
  sessionManager.destroyAll();
  hookRelay.stop();
  remoteServer.stop();
  // Stop sync service — clears timer, releases locks, removes .app-sync-active marker
  try { setSyncService(null); } catch {}
  app.quit();
});
