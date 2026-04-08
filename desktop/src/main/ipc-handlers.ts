import { IpcMain, BrowserWindow, dialog, clipboard, nativeImage, shell, powerSaveBlocker } from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { SessionManager } from './session-manager';
import { HookRelay } from './hook-relay';
import { IPC } from '../shared/types';
import { LocalSkillProvider } from './skill-provider';
import { RemoteConfig } from './remote-config';
import { RemoteServer } from './remote-server';
import { TranscriptWatcher } from './transcript-watcher';
import { listPastSessions, loadHistory } from './session-browser';
import { readTranscriptMeta } from './transcript-utils';
import { startThemeWatcher, listUserThemes, userThemeDir, userThemeManifest, THEMES_DIR } from './theme-watcher';
import { ThemeMarketplaceProvider } from './theme-marketplace-provider';
import { generateThemePreview } from './theme-preview-generator';
import { getSyncStatus, getSyncConfig, setSyncConfig, forceSync, getSyncLog, dismissWarning } from './sync-state';

// Max age for clipboard paste images (1 hour)
const CLIPBOARD_MAX_AGE_MS = 60 * 60 * 1000;

export function registerIpcHandlers(
  ipcMain: IpcMain,
  sessionManager: SessionManager,
  mainWindow: BrowserWindow,
  skillProvider: LocalSkillProvider,
  hookRelay?: HookRelay,
  remoteConfig?: RemoteConfig,
  remoteServer?: RemoteServer,
) {
  const send = (channel: string, ...args: any[]) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, ...args);
    }
  };

  // --- Theme file watcher ---
  const stopThemeWatcher = startThemeWatcher(mainWindow);

  ipcMain.handle(IPC.THEME_LIST, async () => {
    return listUserThemes();
  });

  ipcMain.handle(IPC.THEME_READ_FILE, async (_event, slug: string) => {
    const manifestPath = path.resolve(userThemeManifest(slug));
    if (!manifestPath.startsWith(THEMES_DIR + path.sep)) throw new Error('Invalid theme slug');
    return fs.promises.readFile(manifestPath, 'utf-8');
  });

  ipcMain.handle(IPC.THEME_WRITE_FILE, async (_event, slug: string, content: string) => {
    const themeDir = path.resolve(userThemeDir(slug));
    if (!themeDir.startsWith(THEMES_DIR + path.sep)) throw new Error('Invalid theme slug');
    await fs.promises.mkdir(path.join(themeDir, 'assets'), { recursive: true });
    await fs.promises.writeFile(path.join(themeDir, 'manifest.json'), content, 'utf-8');
  });

  // Window controls — used by custom caption buttons on Windows/Linux
  ipcMain.handle(IPC.WINDOW_MINIMIZE, () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });
  ipcMain.handle(IPC.WINDOW_MAXIMIZE, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    }
  });
  ipcMain.handle(IPC.WINDOW_CLOSE, () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });

  // --- Theme marketplace ---
  const themeMarketplace = new ThemeMarketplaceProvider();

  ipcMain.handle(IPC.THEME_MARKETPLACE_LIST, async (_event, filters) => {
    return themeMarketplace.listThemes(filters);
  });

  ipcMain.handle(IPC.THEME_MARKETPLACE_DETAIL, async (_event, slug: string) => {
    return themeMarketplace.getThemeDetail(slug);
  });

  ipcMain.handle(IPC.THEME_MARKETPLACE_INSTALL, async (_event, slug: string) => {
    return themeMarketplace.installTheme(slug);
  });

  ipcMain.handle(IPC.THEME_MARKETPLACE_UNINSTALL, async (_event, slug: string) => {
    return themeMarketplace.uninstallTheme(slug);
  });

  ipcMain.handle(IPC.THEME_MARKETPLACE_PUBLISH, async (_event, slug: string) => {
    return themeMarketplace.publishTheme(slug);
  });

  ipcMain.handle(IPC.THEME_MARKETPLACE_GENERATE_PREVIEW, async (_event, slug: string) => {
    try {
      const manifestPath = path.resolve(userThemeManifest(slug));
      if (!manifestPath.startsWith(THEMES_DIR + path.sep)) throw new Error('Invalid theme slug');
      const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));
      const previewPath = await generateThemePreview(userThemeDir(slug), manifest);
      return previewPath;
    } catch (err: any) {
      console.warn('[IPC] Failed to generate theme preview:', err.message);
      return null;
    }
  });

  // Broadcast session-created events from SessionManager (covers both IPC and remote-created sessions)
  sessionManager.on('session-created', (info) => {
    send(IPC.SESSION_CREATED, info);
  });

  // Session CRUD
  ipcMain.handle(IPC.SESSION_CREATE, async (_event, opts) => {
    const info = sessionManager.createSession(opts);
    return info;
  });

  ipcMain.handle(IPC.SESSION_DESTROY, async (_event, sessionId: string) => {
    const result = sessionManager.destroySession(sessionId);
    if (result) {
      send(IPC.SESSION_DESTROYED, sessionId);
    }
    return result;
  });

  ipcMain.handle(IPC.SESSION_LIST, async () => {
    return sessionManager.listSessions();
  });

  ipcMain.handle(IPC.SESSION_SWITCH, async (_event, sessionId: string) => {
    // Switch is a client-side concern on desktop — the renderer manages active session.
    // This handler exists for protocol parity with Android/remote.
    return { ok: true };
  });

  // File picker dialog
  ipcMain.handle(IPC.DIALOG_OPEN_FILE, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });

  // Folder picker dialog
  ipcMain.handle(IPC.DIALOG_OPEN_FOLDER, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // Save clipboard image to temp file (async I/O, cleanup on timer)
  const clipboardTmpDir = path.join(os.tmpdir(), 'claude-desktop-attachments');
  let clipboardCleanupScheduled = false;

  async function cleanupClipboardTemp(): Promise<void> {
    try {
      const files = await fs.promises.readdir(clipboardTmpDir);
      const now = Date.now();
      for (const file of files) {
        if (!file.startsWith('paste-')) continue;
        try {
          const stat = await fs.promises.stat(path.join(clipboardTmpDir, file));
          if (now - stat.mtimeMs > CLIPBOARD_MAX_AGE_MS) {
            await fs.promises.unlink(path.join(clipboardTmpDir, file));
          }
        } catch {}
      }
    } catch {}
  }

  ipcMain.handle(IPC.CLIPBOARD_SAVE_IMAGE, async () => {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    await fs.promises.mkdir(clipboardTmpDir, { recursive: true });

    if (!clipboardCleanupScheduled) {
      clipboardCleanupScheduled = true;
      setInterval(cleanupClipboardTemp, 3600_000);
    }

    const filePath = path.join(clipboardTmpDir, `paste-${Date.now()}.png`);
    await fs.promises.writeFile(filePath, img.toPNG());
    return filePath;
  });

  // Open the DestinClaude CHANGELOG on GitHub in the default browser
  ipcMain.handle(IPC.OPEN_CHANGELOG, async () => {
    await shell.openExternal('https://github.com/itsdestin/destincode/blob/master/CHANGELOG.md');
  });

  // Open any URL in the default browser (allowlisted to https only)
  ipcMain.handle(IPC.OPEN_EXTERNAL, async (_event, url: string) => {
    if (typeof url === 'string' && url.startsWith('https://')) {
      await shell.openExternal(url);
    }
  });

  // Read model + context from a transcript JSONL file (async, first/last byte-range reads)
  ipcMain.handle(IPC.READ_TRANSCRIPT_META, async (_event, transcriptPath: string) => {
    try {
      const claudeProjects = path.join(os.homedir(), '.claude', 'projects');
      const resolved = path.resolve(transcriptPath);
      if (!resolved.startsWith(claudeProjects)) return null;
      return await readTranscriptMeta(transcriptPath);
    } catch {
      return null;
    }
  });

  // --- Model preference persistence ---
  ipcMain.handle('model:get-preference', async () => {
    try {
      const raw = fs.readFileSync(modelPrefPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return parsed.model || 'sonnet';
    } catch {
      return 'sonnet';
    }
  });

  ipcMain.handle('model:set-preference', async (_event, model: string) => {
    try {
      fs.mkdirSync(path.dirname(modelPrefPath), { recursive: true });
      fs.writeFileSync(modelPrefPath, JSON.stringify({ model }));
      return true;
    } catch {
      return false;
    }
  });

  // --- Appearance preference persistence ---
  ipcMain.handle('appearance:get', async () => {
    try {
      const raw = fs.readFileSync(appearancePrefPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  });

  ipcMain.handle('appearance:set', async (_event, prefs: Record<string, any>) => {
    try {
      let existing: Record<string, any> = {};
      try {
        existing = JSON.parse(fs.readFileSync(appearancePrefPath, 'utf-8'));
      } catch {}
      const merged = { ...existing, ...prefs };
      fs.mkdirSync(path.dirname(appearancePrefPath), { recursive: true });
      fs.writeFileSync(appearancePrefPath, JSON.stringify(merged));
      return true;
    } catch {
      return false;
    }
  });

  // --- Transcript model verification ---
  ipcMain.handle('model:read-last', async (_event, transcriptPath: string) => {
    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const lines = content.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type === 'assistant' && entry.message?.model) {
            return entry.message.model;
          }
        } catch { continue; }
      }
      return null;
    } catch {
      return null;
    }
  });

  // --- Session defaults persistence ---
  const DEFAULTS_INITIAL = { skipPermissions: false, model: 'sonnet', projectFolder: '' };

  ipcMain.handle('defaults:get', async () => {
    try {
      const raw = fs.readFileSync(defaultsPrefPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return { ...DEFAULTS_INITIAL, ...parsed };
    } catch {
      return { ...DEFAULTS_INITIAL };
    }
  });

  ipcMain.handle('defaults:set', async (_event, updates: Record<string, any>) => {
    try {
      let current = { ...DEFAULTS_INITIAL };
      try {
        current = { ...current, ...JSON.parse(fs.readFileSync(defaultsPrefPath, 'utf-8')) };
      } catch {}
      const merged = { ...current, ...updates };
      fs.mkdirSync(path.dirname(defaultsPrefPath), { recursive: true });
      fs.writeFileSync(defaultsPrefPath, JSON.stringify(merged, null, 2));
      return merged;
    } catch {
      return null;
    }
  });

  // --- Folder switcher persistence ---
  const foldersPrefPath = path.join(os.homedir(), '.claude', 'destincode-folders.json');

  interface SavedFolder {
    path: string;
    nickname: string;
    addedAt: number;
  }

  function readFolders(): SavedFolder[] {
    try {
      const raw = fs.readFileSync(foldersPrefPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeFolders(folders: SavedFolder[]) {
    fs.mkdirSync(path.dirname(foldersPrefPath), { recursive: true });
    fs.writeFileSync(foldersPrefPath, JSON.stringify(folders, null, 2));
  }

  ipcMain.handle(IPC.FOLDERS_LIST, async () => {
    let folders = readFolders();
    // Seed with home directory on first use
    if (folders.length === 0) {
      const home = os.homedir();
      folders = [{ path: home, nickname: 'Home', addedAt: Date.now() }];
      writeFolders(folders);
    }
    // Annotate each folder with whether the path still exists on disk
    return folders.map(f => ({
      ...f,
      exists: fs.existsSync(f.path),
    }));
  });

  ipcMain.handle(IPC.FOLDERS_ADD, async (_event, folderPath: string, nickname?: string) => {
    const folders = readFolders();
    // Deduplicate by normalized path
    const normalized = path.resolve(folderPath);
    if (folders.some(f => path.resolve(f.path) === normalized)) {
      return folders.find(f => path.resolve(f.path) === normalized);
    }
    const entry: SavedFolder = {
      path: normalized,
      nickname: nickname || path.basename(normalized),
      addedAt: Date.now(),
    };
    folders.unshift(entry);
    writeFolders(folders);
    return entry;
  });

  ipcMain.handle(IPC.FOLDERS_REMOVE, async (_event, folderPath: string) => {
    const folders = readFolders();
    const normalized = path.resolve(folderPath);
    const filtered = folders.filter(f => path.resolve(f.path) !== normalized);
    if (filtered.length === folders.length) return false;
    writeFolders(filtered);
    return true;
  });

  ipcMain.handle(IPC.FOLDERS_RENAME, async (_event, folderPath: string, nickname: string) => {
    const folders = readFolders();
    const normalized = path.resolve(folderPath);
    const entry = folders.find(f => path.resolve(f.path) === normalized);
    if (!entry) return false;
    entry.nickname = nickname;
    writeFolders(folders);
    return true;
  });

  // --- Skills discovery & marketplace ---
  ipcMain.handle(IPC.SKILLS_LIST, async () => {
    return skillProvider.getInstalled();
  });

  ipcMain.handle(IPC.SKILLS_LIST_MARKETPLACE, async (_event, filters) => {
    return skillProvider.listMarketplace(filters);
  });

  ipcMain.handle(IPC.SKILLS_GET_DETAIL, async (_event, id: string) => {
    return skillProvider.getSkillDetail(id);
  });

  ipcMain.handle(IPC.SKILLS_SEARCH, async (_event, query: string) => {
    return skillProvider.search(query);
  });

  ipcMain.handle(IPC.SKILLS_INSTALL, async (_event, id: string) => {
    return skillProvider.install(id);
  });

  ipcMain.handle(IPC.SKILLS_UNINSTALL, async (_event, id: string) => {
    return skillProvider.uninstall(id);
  });

  ipcMain.handle(IPC.SKILLS_GET_FAVORITES, async () => {
    return skillProvider.getFavorites();
  });

  ipcMain.handle(IPC.SKILLS_SET_FAVORITE, async (_event, id: string, favorited: boolean) => {
    return skillProvider.setFavorite(id, favorited);
  });

  ipcMain.handle(IPC.SKILLS_GET_CHIPS, async () => {
    return skillProvider.getChips();
  });

  ipcMain.handle(IPC.SKILLS_SET_CHIPS, async (_event, chips) => {
    return skillProvider.setChips(chips);
  });

  ipcMain.handle(IPC.SKILLS_GET_OVERRIDE, async (_event, id: string) => {
    return skillProvider.getOverrides().then(o => o[id] || null);
  });

  ipcMain.handle(IPC.SKILLS_SET_OVERRIDE, async (_event, id: string, override) => {
    return skillProvider.setOverride(id, override);
  });

  ipcMain.handle(IPC.SKILLS_CREATE_PROMPT, async (_event, skill) => {
    return skillProvider.createPromptSkill(skill);
  });

  ipcMain.handle(IPC.SKILLS_DELETE_PROMPT, async (_event, id: string) => {
    return skillProvider.deletePromptSkill(id);
  });

  ipcMain.handle(IPC.SKILLS_PUBLISH, async (_event, id: string) => {
    return skillProvider.publish(id);
  });

  ipcMain.handle(IPC.SKILLS_GET_SHARE_LINK, async (_event, id: string) => {
    return skillProvider.generateShareLink(id);
  });

  ipcMain.handle(IPC.SKILLS_IMPORT_FROM_LINK, async (_event, encoded: string) => {
    return skillProvider.importFromLink(encoded);
  });

  ipcMain.handle(IPC.SKILLS_GET_CURATED_DEFAULTS, async () => {
    return skillProvider.getCuratedDefaults();
  });

  // --- Remote access settings ---
  let keepAwakeBlockerId: number | null = null;
  let keepAwakeTimeout: ReturnType<typeof setTimeout> | null = null;

  function applyKeepAwake(hours: number) {
    // Clear existing blocker
    if (keepAwakeBlockerId !== null) {
      powerSaveBlocker.stop(keepAwakeBlockerId);
      keepAwakeBlockerId = null;
    }
    if (keepAwakeTimeout) {
      clearTimeout(keepAwakeTimeout);
      keepAwakeTimeout = null;
    }
    // Start new blocker if hours > 0
    if (hours > 0) {
      keepAwakeBlockerId = powerSaveBlocker.start('prevent-app-suspension');
      keepAwakeTimeout = setTimeout(() => {
        if (keepAwakeBlockerId !== null) {
          powerSaveBlocker.stop(keepAwakeBlockerId);
          keepAwakeBlockerId = null;
        }
        if (remoteConfig) {
          remoteConfig.keepAwakeHours = 0;
          remoteConfig.save();
        }
      }, hours * 60 * 60 * 1000);
    }
  }

  if (remoteConfig) {
    // Apply saved keep-awake on startup
    if (remoteConfig.keepAwakeHours > 0) applyKeepAwake(remoteConfig.keepAwakeHours);
    ipcMain.handle(IPC.REMOTE_GET_CONFIG, async () => {
      return {
        ...remoteConfig.toSafeObject(),
        clientCount: remoteServer?.getClientCount() ?? 0,
      };
    });

    ipcMain.handle(IPC.REMOTE_SET_PASSWORD, async (_event, password: string) => {
      await remoteConfig.setPassword(password);
      remoteServer?.invalidateTokens();
      return true;
    });

    ipcMain.handle(IPC.REMOTE_SET_CONFIG, async (_event, updates: { enabled?: boolean; trustTailscale?: boolean; keepAwakeHours?: number }) => {
      if (typeof updates.enabled === 'boolean') remoteConfig.enabled = updates.enabled;
      if (typeof updates.trustTailscale === 'boolean') remoteConfig.trustTailscale = updates.trustTailscale;
      if (typeof updates.keepAwakeHours === 'number') {
        remoteConfig.keepAwakeHours = updates.keepAwakeHours;
        applyKeepAwake(updates.keepAwakeHours);
      }
      remoteConfig.save();
      return remoteConfig.toSafeObject();
    });

    ipcMain.handle(IPC.REMOTE_DETECT_TAILSCALE, async () => {
      return RemoteConfig.detectTailscale(remoteConfig.port);
    });

    ipcMain.handle(IPC.REMOTE_GET_CLIENT_COUNT, async () => {
      return remoteServer?.getClientCount() ?? 0;
    });

    ipcMain.handle(IPC.REMOTE_GET_CLIENT_LIST, async () => {
      return remoteServer?.getClientList() ?? [];
    });

    ipcMain.handle(IPC.REMOTE_DISCONNECT_CLIENT, async (_event, clientId: string) => {
      return remoteServer?.disconnectClient(clientId) ?? false;
    });

    ipcMain.handle(IPC.REMOTE_INSTALL_TAILSCALE, async () => {
      return RemoteConfig.installTailscale();
    });

    ipcMain.handle(IPC.REMOTE_AUTH_TAILSCALE, async () => {
      const result = await RemoteConfig.startTailscaleAuth();
      if (result.url) {
        shell.openExternal(result.url);
      }
      return result;
    });

    // UI action sync: Electron window broadcasts an action → forward to all remote clients
    ipcMain.on(IPC.UI_ACTION_BROADCAST, (_event, action: any) => {
      remoteServer?.broadcast({ type: 'ui:action', payload: action });
    });

    // UI action sync: Remote client broadcasts an action → forward to Electron window
    sessionManager.on('ui-action', (action: any) => {
      send(IPC.UI_ACTION_RECEIVED, action);
    });
  }

  // --- Session browser (resume) ---
  ipcMain.handle(IPC.SESSION_BROWSE, async () => {
    // Collect active Claude Code session IDs so we can exclude them
    const activeIds = new Set<string>();
    // sessionIdMap is already defined in this scope — maps desktop ID → Claude ID
    for (const claudeId of sessionIdMap.values()) {
      activeIds.add(claudeId);
    }
    return listPastSessions(activeIds);
  });

  ipcMain.handle(IPC.SESSION_HISTORY, async (
    _event,
    sessionId: string,
    projectSlug: string,
    count: number,
    all: boolean,
  ) => {
    return loadHistory(sessionId, projectSlug, count, all);
  });

  // PTY input (fire-and-forget, not request-response)
  ipcMain.on(IPC.SESSION_INPUT, (_event, sessionId: string, text: string) => {
    sessionManager.sendInput(sessionId, text);
  });

  // PTY resize (fire-and-forget)
  ipcMain.on(IPC.SESSION_RESIZE, (_event, sessionId: string, cols: number, rows: number) => {
    sessionManager.resizeSession(sessionId, cols, rows);
  });

  // --- PTY output buffering ---
  // Buffer output per-session until the renderer signals its terminal is mounted.
  // This prevents losing the initial trust prompt on slow systems where
  // PTY output arrives before TerminalView mounts and registers its listener.
  const pendingOutput = new Map<string, string[]>();
  const readySessions = new Set<string>();

  sessionManager.on('pty-output', (sessionId: string, data: string) => {
    if (readySessions.has(sessionId)) {
      send(`pty:output:${sessionId}`, data);          // per-session (TerminalView)
      send(IPC.PTY_OUTPUT, sessionId, data);           // global (App.tsx mode detection)
    } else {
      let buf = pendingOutput.get(sessionId);
      if (!buf) {
        buf = [];
        pendingOutput.set(sessionId, buf);
      }
      buf.push(data);
    }
  });

  // Renderer signals terminal is mounted and listening
  ipcMain.on(IPC.TERMINAL_READY, (_event, sessionId: string) => {
    readySessions.add(sessionId);
    const buffered = pendingOutput.get(sessionId);
    if (buffered) {
      for (const data of buffered) {
        send(`pty:output:${sessionId}`, data);         // per-session (TerminalView)
        send(IPC.PTY_OUTPUT, sessionId, data);          // global (App.tsx mode detection)
      }
      pendingOutput.delete(sessionId);
    }
  });

  // Forward session exit events
  sessionManager.on('session-exit', (sessionId: string) => {
    send(IPC.SESSION_DESTROYED, sessionId);
    pendingOutput.delete(sessionId);
    readySessions.delete(sessionId);
  });

  // --- Prune stale context files on startup ---
  // Context files are written per-session by statusline.sh and cleaned up on
  // session exit, but a crash can leave orphans. Delete any .context-* files
  // that aren't associated with a running session.
  try {
    const claudeDir = path.join(os.homedir(), '.claude');
    const entries = fs.readdirSync(claudeDir);
    for (const entry of entries) {
      if (entry.startsWith('.context-')) {
        fs.unlink(path.join(claudeDir, entry), () => {});
      }
    }
  } catch { /* directory doesn't exist or unreadable — fine */ }

  // --- Status data poller ---
  // Reads DestinClaude cache files and pushes status updates to the renderer
  const usageCachePath = path.join(os.homedir(), '.claude', '.usage-cache.json');
  const announcementCachePath = path.join(os.homedir(), '.claude', '.announcement-cache.json');
  const updateStatusPath = path.join(os.homedir(), '.claude', 'toolkit-state', 'update-status.json');
  const modelPrefPath = path.join(os.homedir(), '.claude', 'destincode-model.json');
  const appearancePrefPath = path.join(os.homedir(), '.claude', 'destincode-appearance.json');
  const defaultsPrefPath = path.join(os.homedir(), '.claude', 'destincode-defaults.json');

  function readJsonFile(filePath: string): any {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  const syncStatusPath = path.join(os.homedir(), '.claude', '.sync-status');
  const syncWarningsPath = path.join(os.homedir(), '.claude', '.sync-warnings');

  function readTextFile(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf8').trim() || null;
    } catch {
      return null;
    }
  }

  function buildStatusData() {
    const usage = readJsonFile(usageCachePath);
    const announcement = readJsonFile(announcementCachePath);
    const updateStatus = readJsonFile(updateStatusPath);
    const syncStatus = readTextFile(syncStatusPath);
    const syncWarnings = readTextFile(syncWarningsPath);

    // Sync state for live updates — SyncPanel also fetches via IPC,
    // but these fields let the compact section row update in real-time.
    const syncMarkerRaw = readTextFile(path.join(os.homedir(), '.claude', 'toolkit-state', '.sync-marker'));
    const lastSyncEpoch = syncMarkerRaw ? parseInt(syncMarkerRaw, 10) || null : null;
    let syncInProgress = false;
    try { syncInProgress = fs.statSync(path.join(os.homedir(), '.claude', 'toolkit-state', '.sync-lock')).isDirectory(); } catch {}
    const backupMeta = readJsonFile(path.join(os.homedir(), '.claude', 'backup-meta.json'));

    // Read per-session context remaining % (written by statusline.sh)
    const contextMap: Record<string, number> = {};
    for (const [desktopId, claudeId] of sessionIdMap) {
      const raw = readTextFile(path.join(os.homedir(), '.claude', `.context-${claudeId}`));
      if (raw != null) {
        const num = parseInt(raw, 10);
        if (!isNaN(num)) contextMap[desktopId] = num;
      }
    }

    return { usage, announcement, updateStatus, syncStatus, syncWarnings, lastSyncEpoch, syncInProgress, backupMeta, contextMap };
  }

  // Push status data every 10s — store handle so it can be cleared on shutdown
  const statusInterval = setInterval(() => {
    const data = buildStatusData();
    send(IPC.STATUS_DATA, data);
    // Feed full status data to remote server for browser clients (single polling source)
    if (remoteServer) remoteServer.broadcastStatusData(data);
  }, 10000);

  // Also push immediately on first hook event (session is active)
  let sentInitialStatus = false;
  if (hookRelay) {
    hookRelay.on('hook-event', () => {
      if (!sentInitialStatus) {
        sentInitialStatus = true;
        const data = buildStatusData();
        send(IPC.STATUS_DATA, data);
        if (remoteServer) remoteServer.broadcastStatusData(data);
      }
    });
  }

  // --- Usage cache refresher ---
  // Runs usage-fetch.js periodically to keep .usage-cache.json fresh
  // even when the DestinClaude toolkit's statusline isn't running.
  const rawUsageFetchPath = path.resolve(__dirname, '../../hook-scripts/usage-fetch.js');
  const unpackedUsageFetchPath = rawUsageFetchPath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  const usageFetchScript = fs.existsSync(unpackedUsageFetchPath) ? unpackedUsageFetchPath : rawUsageFetchPath;

  function refreshUsageCache() {
    try {
      execFile('node', [usageFetchScript], { timeout: 15000 }, () => {
        // Output written to .usage-cache.json; buildStatusData() reads it
      });
    } catch { /* node not found or script error — status bar just shows no data */ }
  }

  refreshUsageCache();
  const usageRefreshInterval = setInterval(refreshUsageCache, 5 * 60 * 1000);

  // --- Announcement cache refresher ---
  // Runs announcement-fetch.js on startup and every 6 hours to keep
  // .announcement-cache.json fresh without relying on the toolkit's session-start.sh.
  const rawAnnounceFetchPath = path.resolve(__dirname, '../../hook-scripts/announcement-fetch.js');
  const unpackedAnnounceFetchPath = rawAnnounceFetchPath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  const announceFetchScript = fs.existsSync(unpackedAnnounceFetchPath) ? unpackedAnnounceFetchPath : rawAnnounceFetchPath;

  function refreshAnnouncementCache() {
    try {
      execFile('node', [announceFetchScript], { timeout: 15000 }, () => {});
    } catch { /* node not found or script error — announcement just stays stale */ }
  }

  refreshAnnouncementCache();
  const announceRefreshInterval = setInterval(refreshAnnouncementCache, 6 * 60 * 60 * 1000);

  // --- Topic file watcher (auto-title) ---
  // The auto-title hook writes topics to ~/.claude/topics/topic-{CLAUDE_CODE_SESSION_ID}.
  // But our desktop session IDs differ from Claude Code's internal IDs.
  // We discover the mapping from hook events (which contain both IDs)
  // and watch the correct file.
  const topicDir = path.join(os.homedir(), '.claude', 'topics');
  // Maps desktop session ID → Claude Code session ID
  const sessionIdMap = new Map<string, string>();
  const transcriptWatcher = new TranscriptWatcher();

  transcriptWatcher.on('transcript-event', (event: any) => {
    send(IPC.TRANSCRIPT_EVENT, event);
    if (remoteServer) {
      remoteServer.bufferTranscriptEvent(event);
      remoteServer.broadcast({ type: 'transcript:event', payload: event });
    }
  });
  const topicWatchers = new Map<string, fs.FSWatcher | NodeJS.Timeout>();
  const lastTopics = new Map<string, string>();

  // Broadcast session rename to remote WebSocket clients + update SessionInfo
  function broadcastRename(desktopId: string, name: string) {
    const session = sessionManager.getSession(desktopId);
    if (session) session.name = name;
    remoteServer?.broadcast({ type: 'session:renamed', payload: { sessionId: desktopId, name } });
    remoteServer?.setLastTopic(desktopId, name);
  }

  function readTopicFile(claudeSessionId: string): string | null {
    try {
      const content = fs.readFileSync(path.join(topicDir, `topic-${claudeSessionId}`), 'utf8').trim();
      return content || null;
    } catch {
      return null;
    }
  }

  const pendingWatchers = new Set<string>();

  function startWatching(desktopId: string, claudeId: string) {
    if (topicWatchers.has(desktopId) || pendingWatchers.has(desktopId)) return;
    pendingWatchers.add(desktopId);

    // Read initial value
    const initial = readTopicFile(claudeId);
    if (initial && initial !== 'New Session') {
      lastTopics.set(desktopId, initial);
      send(IPC.SESSION_RENAMED, desktopId, initial);
      broadcastRename(desktopId, initial);
    }

    const topicFilePath = path.join(topicDir, `topic-${claudeId}`);

    // Prefer fs.watch for efficiency; fall back to polling if watch fails
    // (e.g., on network filesystems or platforms with limited inotify)
    try {
      const watcher = fs.watch(topicFilePath, { persistent: false }, () => {
        const topic = readTopicFile(claudeId);
        if (topic && topic !== 'New Session' && topic !== lastTopics.get(desktopId)) {
          lastTopics.set(desktopId, topic);
          send(IPC.SESSION_RENAMED, desktopId, topic);
          broadcastRename(desktopId, topic);
        }
      });
      watcher.on('error', () => {
        // File may not exist yet — fall back to polling
        watcher.close();
        startPolling(desktopId, claudeId);
      });
      topicWatchers.set(desktopId, watcher);
      pendingWatchers.delete(desktopId);
    } catch {
      // fs.watch not available or file doesn't exist yet — poll instead
      pendingWatchers.delete(desktopId);
      startPolling(desktopId, claudeId);
    }
  }

  function startPolling(desktopId: string, claudeId: string) {
    if (topicWatchers.has(desktopId)) return;
    const interval = setInterval(() => {
      const topic = readTopicFile(claudeId);
      if (topic && topic !== 'New Session' && topic !== lastTopics.get(desktopId)) {
        lastTopics.set(desktopId, topic);
        send(IPC.SESSION_RENAMED, desktopId, topic);
        broadcastRename(desktopId, topic);
      }
    }, 2000);
    topicWatchers.set(desktopId, interval);
  }

  // Listen for hook events to extract the desktop→claude session ID mapping
  if (hookRelay) {
    hookRelay.on('hook-event', (event: { sessionId: string; payload: Record<string, unknown> }) => {
      const desktopId = event.sessionId; // _desktop_session_id (set by parseHookPayload)
      const claudeId = event.payload?.session_id as string;
      if (!desktopId || !claudeId) return;
      if (sessionIdMap.has(desktopId)) return;
      sessionIdMap.set(desktopId, claudeId);
      startWatching(desktopId, claudeId);

      // Start watching the transcript file for this session
      const sessionInfo = sessionManager.getSession(desktopId);
      if (sessionInfo) {
        transcriptWatcher.startWatching(desktopId, claudeId, sessionInfo.cwd);
      }
    });
  }

  // Stop watching when a session is destroyed
  sessionManager.on('session-exit', (sessionId: string) => {
    transcriptWatcher.stopWatching(sessionId);
    const watcher = topicWatchers.get(sessionId);
    if (watcher) {
      if (typeof (watcher as fs.FSWatcher).close === 'function') {
        (watcher as fs.FSWatcher).close();
      } else {
        clearInterval(watcher as NodeJS.Timeout);
      }
      topicWatchers.delete(sessionId);
      lastTopics.delete(sessionId);
    }
    // Clean up context cache file
    const claudeId = sessionIdMap.get(sessionId);
    if (claudeId) {
      fs.unlink(path.join(os.homedir(), '.claude', `.context-${claudeId}`), () => {});
    }
    sessionIdMap.delete(sessionId);
  });

  // --- Sync management ---
  // Control plane for DestinClaude toolkit sync — reads state files written
  // by sync.sh / session-start.sh and triggers sync via the existing scripts.
  ipcMain.handle(IPC.SYNC_GET_STATUS, () => getSyncStatus());
  ipcMain.handle(IPC.SYNC_GET_CONFIG, () => getSyncConfig());
  ipcMain.handle(IPC.SYNC_SET_CONFIG, (_e, updates) => setSyncConfig(updates));
  ipcMain.handle(IPC.SYNC_FORCE, () => forceSync());
  ipcMain.handle(IPC.SYNC_GET_LOG, (_e, lines) => getSyncLog(lines));
  ipcMain.handle(IPC.SYNC_DISMISS_WARNING, (_e, warning) => dismissWarning(warning));

  // --- Permission response (blocking hooks) ---
  if (hookRelay) {
    ipcMain.handle(IPC.PERMISSION_RESPOND, async (_event, requestId: string, decision: object) => {
      return hookRelay.respond(requestId, decision);
    });
  }

  // Return cleanup function for use during app shutdown
  return function cleanup() {
    stopThemeWatcher();
    clearInterval(statusInterval);
    clearInterval(usageRefreshInterval);
    clearInterval(announceRefreshInterval);
    transcriptWatcher.stopAll();
    for (const [id, watcher] of topicWatchers) {
      if (typeof (watcher as fs.FSWatcher).close === 'function') {
        (watcher as fs.FSWatcher).close();
      } else {
        clearInterval(watcher as NodeJS.Timeout);
      }
    }
    topicWatchers.clear();
    lastTopics.clear();
    sessionIdMap.clear();
  };
}
