import { app, BrowserWindow, ipcMain, Menu, nativeImage, protocol, shell } from 'electron';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SessionManager } from './session-manager';
import { HookRelay } from './hook-relay';
import { registerIpcHandlers } from './ipc-handlers';
import { RemoteServer } from './remote-server';
import { RemoteConfig } from './remote-config';
import { LocalSkillProvider } from './skill-provider';
import { IPC, PermissionOverrides, PERMISSION_OVERRIDES_DEFAULT } from '../shared/types';
import { VITE_DEV_PORT } from '../shared/ports';
import { log, rotateLog } from './logger';
import { registerThemeProtocol } from './theme-protocol';
import { FirstRunManager } from './first-run';
import { SyncService } from './sync-service';
import { setSyncService } from './sync-state';

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
  }
  process.env.PATH = `${extraPaths.join(path.delimiter)}${path.delimiter}${process.env.PATH}`;
}

const execFileAsync = promisify(execFile);
// Resolve 'gh' path for Windows where Electron's PATH may not include it
let ghPath = 'gh';
try { const w = require('which'); ghPath = w.sync('gh'); } catch { /* use bare 'gh' */ }

let mainWindow: BrowserWindow | null = null;
let cleanupIpcHandlers: (() => void) | null = null;
const sessionManager = new SessionManager();
// Unique pipe name per launch — avoids EADDRINUSE from stale Electron processes
const pipeName = process.platform === 'win32'
  ? `\\\\.\\pipe\\claude-desktop-hooks-${process.pid}`
  : path.join(os.tmpdir(), `claude-desktop-hooks-${process.pid}.sock`);
sessionManager.setPipeName(pipeName);
const hookRelay = new HookRelay(pipeName);
const remoteConfig = new RemoteConfig();
const skillProvider = new LocalSkillProvider();
skillProvider.ensureMigrated();
const remoteServer = new RemoteServer(sessionManager, hookRelay, remoteConfig, skillProvider);

// Dev server URL — env override wins; otherwise compute from DESTINCODE_PORT_OFFSET
// (via shared/ports.ts) so Vite and main stay in sync without a second env var.
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || `http://localhost:${VITE_DEV_PORT}`;

// Dev-profile isolation: when DESTINCODE_PROFILE=dev, split Electron userData so
// a dev instance doesn't clobber the built app's localStorage, cookies, cache,
// or window state. Must be called before app.whenReady().
if (process.env.DESTINCODE_PROFILE === 'dev') {
  app.setPath('userData', path.join(app.getPath('appData'), 'destincode-dev'));
  app.setName('DestinCode Dev');
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

function createWindow(firstRunManager?: FirstRunManager) {
  const iconPath = path.join(__dirname, '../../assets/icon.png');
  const icon = nativeImage.createFromPath(iconPath);

  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon,
    // macOS: hide native title bar but keep traffic lights
    // Windows/Linux: hide native title bar entirely — custom caption buttons in HeaderBar
    titleBarStyle: isMac ? 'hiddenInset' as const : 'hidden' as const,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // Security: OS-level process isolation for renderer
    },
  });

  // Security: block navigation to external origins (prevents preload API exposure)
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isAppOrigin = url.startsWith('file://') || url.startsWith(DEV_SERVER_URL);
    if (!isAppOrigin) {
      event.preventDefault();
    }
  });
  // Security: deny window.open() from renderer, but route safe http(s)/mailto
  // links (e.g. target="_blank" anchors in chat markdown) to the OS browser so
  // they are actually clickable. Without this, chat view links silently do nothing.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' as const };
  });

  // Disable Chromium's built-in visual pinch-to-zoom so our custom zoom handler
  // (Ctrl+Wheel / trackpad pinch → IPC → setZoomLevel) is the sole zoom path.
  // setVisualZoomLevelLimits disables the viewport zoom; page zoom via setZoomLevel
  // still works. Without this, pinch gestures double-fire (compositor + our handler).
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1);

  // Always open maximized — width/height above are the restore-size fallback
  mainWindow.maximize();

  if (!app.isPackaged) {
    mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Relay fullscreen state to renderer so CSS can adjust (e.g., macOS traffic light padding)
  mainWindow.on('enter-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:fullscreen-changed', true);
    }
  });
  mainWindow.on('leave-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:fullscreen-changed', false);
    }
  });

  cleanupIpcHandlers = registerIpcHandlers(ipcMain, sessionManager, mainWindow, skillProvider, hookRelay, remoteConfig, remoteServer);

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

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.HOOK_EVENT, event);
    }
  });

  // Notify renderer when a permission request socket closes (timeout/killed)
  hookRelay.on('permission-expired', (sessionId: string, requestId: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.HOOK_EVENT, {
        type: 'PermissionExpired',
        sessionId,
        payload: { _requestId: requestId },
        timestamp: Date.now(),
      });
    }
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
  if (process.env.DESTINCODE_PROFILE !== 'dev') {
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
    log('INFO', 'Main', 'Dev profile — skipping install-hooks (using built app paths)');
  }

  try {
    await hookRelay.start();
  } catch (e) {
    log('ERROR', 'Main', 'Failed to start hook relay', { error: String(e) });
  }

  try {
    await remoteServer.start();
  } catch (e) {
    log('ERROR', 'Main', 'Failed to start remote server', { error: String(e) });
  }

  const FAVORITES_PATH = path.join(os.homedir(), '.claude', 'destinclaude-favorites.json');

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
  createWindow(isFirstRun ? firstRunManager : undefined);

  // Start native sync service — owns push/pull lifecycle, background timer,
  // session-end sync. Replaces bash hook sync when app is running.
  const syncService = new SyncService();
  setSyncService(syncService);
  syncService.start().catch(e => log('ERROR', 'Main', 'SyncService start failed', { error: String(e) }));
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
