import { app, IpcMain, BrowserWindow, dialog, clipboard, nativeImage, shell, powerSaveBlocker, webContents } from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import { execFile } from 'child_process';
import { SessionManager } from './session-manager';
import { HookRelay } from './hook-relay';
import { IPC, PERMISSION_OVERRIDES_DEFAULT, SESSION_FLAG_NAMES, type SessionFlagName } from '../shared/types';
import { setPermissionOverrides } from './main';
import { LocalSkillProvider } from './skill-provider';
import { IntegrationInstaller, listWithState } from './integration-installer';
import { RemoteConfig } from './remote-config';
import { RemoteServer } from './remote-server';
import { TranscriptWatcher } from './transcript-watcher';
import { listPastSessions, loadHistory } from './session-browser';
import { readTranscriptMeta } from './transcript-utils';
import { startThemeWatcher, listUserThemes, userThemeDir, userThemeManifest, THEMES_DIR } from './theme-watcher';
import { ThemeMarketplaceProvider } from './theme-marketplace-provider';
import { generateThemePreview } from './theme-preview-generator';
import { getSyncStatus, getSyncConfig, setSyncConfig, forceSync, getSyncLog, dismissWarning, addBackend, removeBackend, updateBackend, pushBackend, pullBackend, getSyncService } from './sync-state';
import { getConfig as getMarketplaceConfig, setConfig as setMarketplaceConfig } from './marketplace-config-store';
import { checkSyncPrereqs, installRclone, checkGdriveRemote, authGdrive, authGithub, createGithubRepo } from './sync-setup-handlers';
import { log } from './logger';

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
  // Multi-window ownership: when a session is created via IPC, assign it to
  // the calling renderer's window so subsequent per-session events route there.
  windowRegistry?: import('./window-registry').WindowRegistry,
) {
  // Broadcast a non-session-scoped event to every renderer. Status data, UI
  // actions, and similar globals must reach every window — not just window 1.
  // Session-scoped events should use sendForSession instead.
  const send = (channel: string, ...args: any[]) => {
    if (windowRegistry) {
      for (const wid of windowRegistry.getWindowIds()) {
        const wc = webContents.fromId(wid);
        if (wc && !wc.isDestroyed()) wc.send(channel, ...args);
      }
      return;
    }
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, ...args);
    }
  };

  // Route a session-scoped emit to the window that owns the session. Falls
  // back to the primary `mainWindow` if ownership is unknown (remote-created
  // sessions during Phase 1; remote clients still get their copy via the
  // parallel remoteServer.broadcast() calls). This is the single seam that
  // makes per-session IPC multi-window-aware — adding a new session-scoped
  // event type should use sendForSession, not send.
  const sendForSession = (sessionId: string, channel: string, ...args: any[]) => {
    const wid = windowRegistry?.getOwner(sessionId);
    if (wid != null) {
      // wid is a webContents.id, NOT a BrowserWindow.id — use webContents.fromId
      // (different ID space; BrowserWindow.fromId silently returns null and we
      // fall through to mainWindow, which made every peer-window event land in
      // window 1).
      const wc = webContents.fromId(wid);
      if (wc && !wc.isDestroyed()) {
        wc.send(channel, ...args);
        return;
      }
    }
    // Fallback: no known owner (e.g., remote-created session pre-assignment).
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
  };

  // --- Theme file watcher ---
  const stopThemeWatcher = startThemeWatcher(mainWindow);

  ipcMain.handle(IPC.THEME_LIST, async () => {
    return listUserThemes();
  });

  // Security: strict slug format to prevent path traversal before path.resolve.
  // Allow leading underscore for reserved internal slugs (e.g. _preview used by theme-builder).
  const SAFE_SLUG_RE = /^[a-z0-9_]+(?:-[a-z0-9_]+)*$/;

  ipcMain.handle(IPC.THEME_READ_FILE, async (_event, slug: string) => {
    if (!SAFE_SLUG_RE.test(slug)) throw new Error('Invalid theme slug');
    const manifestPath = path.resolve(userThemeManifest(slug));
    if (!manifestPath.startsWith(THEMES_DIR + path.sep)) throw new Error('Invalid theme slug');
    return fs.promises.readFile(manifestPath, 'utf-8');
  });

  ipcMain.handle(IPC.THEME_WRITE_FILE, async (_event, slug: string, content: string) => {
    if (!SAFE_SLUG_RE.test(slug)) throw new Error('Invalid theme slug');
    const themeDir = path.resolve(userThemeDir(slug));
    if (!themeDir.startsWith(THEMES_DIR + path.sep)) throw new Error('Invalid theme slug');
    await fs.promises.mkdir(path.join(themeDir, 'assets'), { recursive: true });
    await fs.promises.writeFile(path.join(themeDir, 'manifest.json'), content, 'utf-8');
  });

  // Window controls — used by custom caption buttons on Windows/Linux.
  // Operate on the SENDING window (BrowserWindow.fromWebContents), not the
  // primary mainWindow — otherwise window 2's caption buttons all act on
  // window 1.
  ipcMain.handle(IPC.WINDOW_MINIMIZE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.minimize();
  });
  ipcMain.handle(IPC.WINDOW_MAXIMIZE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.isMaximized() ? win.unmaximize() : win.maximize();
    }
  });
  ipcMain.handle(IPC.WINDOW_CLOSE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
  });
  // macOS traffic-light repositioning. Non-Mac platforms don't have native
  // traffic lights, so this is a no-op there. Called from theme-engine when
  // chrome-style changes — floating chrome's rounded header would otherwise
  // leave the OS-default (8,12) lights stranded over empty space.
  ipcMain.handle(IPC.WINDOW_SET_TRAFFIC_LIGHT_POS, (event, pos: { x: number; y: number } | null) => {
    if (process.platform !== 'darwin') return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    // Electron 28+: setWindowButtonPosition(null) resets to the platform default.
    // Older fallback: passing undefined also resets. We type-narrow before calling.
    const anyWin = win as unknown as { setWindowButtonPosition: (p: Electron.Point | null) => void };
    anyWin.setWindowButtonPosition(pos ?? null);
  });

  // Theme-driven window + dock icon hot-swap. Called from theme-context whenever
  // the active theme changes. Two URL forms are accepted:
  //   1. theme-asset://<slug>/<relative-path>  — a file in a community/user theme's
  //      asset dir (server resolves the path and confines reads to that dir, so
  //      renderer cannot read arbitrary files).
  //   2. data:image/png;base64,<...>            — an in-memory PNG synthesized by
  //      the renderer (theme-default-icon.ts), used for every theme that doesn't
  //      declare its own appIcon. Capped at MAX_DATA_ICON_BYTES to prevent a
  //      compromised renderer from flooding main with huge buffers.
  // Anything else (or null, or failure) resets to the bundled default icon.
  const DEFAULT_ICON_PATH = path.join(__dirname, '../../assets/icon.png');
  const THEMES_DIR_FOR_ICON = path.join(os.homedir(), '.claude', 'destinclaude-themes');
  const MAX_DATA_ICON_BYTES = 1024 * 1024; // 1 MB — a 256px PNG is typically <100KB
  ipcMain.handle(IPC.WINDOW_SET_ICON, (_e, url: string | null) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    let iconImg = nativeImage.createFromPath(DEFAULT_ICON_PATH);
    if (url && typeof url === 'string') {
      try {
        if (url.startsWith('theme-asset://')) {
          const parsed = new URL(url);
          const slug = parsed.hostname;
          if (SAFE_SLUG_RE.test(slug)) {
            const rel = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
            const themeDir = path.join(THEMES_DIR_FOR_ICON, slug);
            const resolved = path.resolve(themeDir, rel);
            if (resolved.startsWith(themeDir + path.sep)) {
              const img = nativeImage.createFromPath(resolved);
              if (!img.isEmpty()) iconImg = img;
            }
          }
        } else if (url.startsWith('data:image/png;base64,') && url.length <= MAX_DATA_ICON_BYTES) {
          const img = nativeImage.createFromDataURL(url);
          if (!img.isEmpty()) iconImg = img;
        }
      } catch { /* fall through to default */ }
    }
    mainWindow.setIcon(iconImg);
    if (process.platform === 'darwin' && app.dock) app.dock.setIcon(iconImg);
  });

  // Zoom controls — each returns the new zoom percentage for the overlay UI
  const ZOOM_STEP = 0.5; // ~12% per step (Electron uses logarithmic scale)
  const ZOOM_MIN = -3;   // ~50%
  const ZOOM_MAX = 5;    // ~300%

  function zoomLevelToPercent(level: number): number {
    return Math.round(Math.pow(1.2, level) * 100);
  }

  ipcMain.handle(IPC.ZOOM_IN, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return 100;
    const current = mainWindow.webContents.getZoomLevel();
    const next = Math.min(current + ZOOM_STEP, ZOOM_MAX);
    mainWindow.webContents.setZoomLevel(next);
    return zoomLevelToPercent(next);
  });

  ipcMain.handle(IPC.ZOOM_OUT, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return 100;
    const current = mainWindow.webContents.getZoomLevel();
    const next = Math.max(current - ZOOM_STEP, ZOOM_MIN);
    mainWindow.webContents.setZoomLevel(next);
    return zoomLevelToPercent(next);
  });

  ipcMain.handle(IPC.ZOOM_RESET, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return 100;
    mainWindow.webContents.setZoomLevel(0);
    return 100;
  });

  ipcMain.handle(IPC.ZOOM_GET, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return 100;
    return zoomLevelToPercent(mainWindow.webContents.getZoomLevel());
  });

  // --- Theme marketplace ---
  // Phase 3a: pass the shared config store so theme installs also record into
  // the unified destincode-skills.json packages map used for update tracking.
  const themeMarketplace = new ThemeMarketplaceProvider(skillProvider.configStore);
  // Phase 3 scaffold — kept inline (not a constructor arg) so this file is
  // the only thing that changes when the installer grows real OAuth wiring.
  const integrationInstaller = new IntegrationInstaller();

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

  // Publish-lifecycle: resolve button state (draft / in-review / published-current /
  // published-drift / unknown) for a user-authored theme on each detail open.
  ipcMain.handle(IPC.THEME_MARKETPLACE_RESOLVE_PUBLISH_STATE, async (_event, slug: string) => {
    return themeMarketplace.resolvePublishStateForSlug(slug);
  });

  // Manual refresh: drop in-memory registry cache + return a fresh listing in one round-trip.
  ipcMain.handle(IPC.THEME_MARKETPLACE_REFRESH_REGISTRY, async () => {
    themeMarketplace.invalidateRegistryCache();
    return themeMarketplace.listThemes();
  });

  ipcMain.handle(IPC.THEME_MARKETPLACE_GENERATE_PREVIEW, async (_event, slug: string) => {
    try {
      const manifestPath = path.resolve(userThemeManifest(slug));
      if (!manifestPath.startsWith(THEMES_DIR + path.sep)) throw new Error('Invalid theme slug');
      const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));
      const previewPath = await generateThemePreview(userThemeDir(slug), manifest);
      // Verify the file really landed on disk — if the generator returned a
      // path but writeFile silently failed, the share sheet would render a
      // broken-image icon. Better to return null and fall back to the swatch.
      const stat = await fs.promises.stat(previewPath).catch(() => null);
      if (!stat || stat.size < 150) {
        console.warn(`[IPC] Preview file missing/tiny after generation: slug=${slug} path=${previewPath} size=${stat?.size ?? 'missing'}`);
        return null;
      }
      return previewPath;
    } catch (err: any) {
      console.warn(`[IPC] Failed to generate theme preview: slug=${slug} err=${err?.message ?? err}`);
      return null;
    }
  });

  // Forward session-created to the owning window. Deferred via nextTick so
  // the SESSION_CREATE IPC handler can run assignSession first — otherwise
  // sendForSession fires before ownership is set and falls back to mainWindow,
  // making a session created in window 2 appear in window 1. Remote-created
  // sessions still fall back to mainWindow since no renderer owns them yet.
  sessionManager.on('session-created', (info) => {
    process.nextTick(() => sendForSession(info.id, IPC.SESSION_CREATED, info));
  });

  // Session CRUD
  ipcMain.handle(IPC.SESSION_CREATE, async (event, opts) => {
    const info = sessionManager.createSession(opts);
    // Assign the new session to the calling window so per-session events (transcript,
    // pty output, permission prompts) route here once Task 1.4 migrates the emits.
    if (windowRegistry) {
      try { windowRegistry.assignSession(info.id, event.sender.id); }
      catch (e) { log('WARN', 'IPC', 'assignSession failed', { error: String(e) }); }
    }
    return info;
  });

  // Pull-style directory snapshot — renderers call this on mount to avoid
  // racing the WINDOW_DIRECTORY_UPDATED push that fires before React subscribes.
  if (windowRegistry) {
    ipcMain.handle(IPC.WINDOW_GET_DIRECTORY, async () => {
      return windowRegistry.getDirectory((id) => sessionManager.getSession(id));
    });
  }

  ipcMain.handle(IPC.SESSION_DESTROY, async (_event, sessionId: string) => {
    const result = sessionManager.destroySession(sessionId);
    if (result) {
      // Explicit user-initiated destroy → treat as clean exit (0). The
      // reducer no-ops clean exits unless a turn was in flight.
      sendForSession(sessionId, IPC.SESSION_DESTROYED, sessionId, 0);
      windowRegistry?.releaseSession(sessionId);
    }
    return result;
  });

  // Multi-window aware: when a windowRegistry is wired up, scope the list to
  // sessions owned by the calling renderer's window — otherwise a freshly-
  // spawned peer window picks up every session on mount and its ownership-
  // acquired dedup leaves strangers stuck in the local list. Sessions with no
  // owner yet (e.g., remote-created) fall back to the primary window's list
  // so remote clients still see everything. RemoteServer uses its own path
  // and doesn't go through this handler.
  ipcMain.handle(IPC.SESSION_LIST, async (event) => {
    const all = sessionManager.listSessions();
    if (!windowRegistry) return all;
    const callerId = event.sender.id;
    const primaryId = windowRegistry.getLeaderId();
    return all.filter((s) => {
      const owner = windowRegistry.getOwner(s.id);
      if (owner == null) return callerId === primaryId; // unowned → primary only
      return owner === callerId;
    });
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

  // Sound file picker dialog — for custom notification sounds
  ipcMain.handle(IPC.DIALOG_OPEN_SOUND, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'Audio Files', extensions: ['mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac', 'webm'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
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

  // --- Model modes (fast + effort) persistence ---
  // ~/.claude/destincode-model-modes.json holds `{ fast, effort }`. These aren't
  // verified from transcripts (Claude Code doesn't include them there) — we
  // trust our local state and rely on the user's ModelPickerPopup as the source of truth.
  const modelModesPath = path.join(os.homedir(), '.claude', 'destincode-model-modes.json');

  ipcMain.handle('modes:get', async () => {
    try {
      return JSON.parse(fs.readFileSync(modelModesPath, 'utf-8'));
    } catch {
      return { fast: false, effort: 'auto' };
    }
  });

  ipcMain.handle('modes:set', async (_event, modes: { fast?: boolean; effort?: string }) => {
    try {
      let current = { fast: false, effort: 'auto' };
      try { current = { ...current, ...JSON.parse(fs.readFileSync(modelModesPath, 'utf-8')) }; } catch {}
      const merged = { ...current, ...modes };
      fs.mkdirSync(path.dirname(modelModesPath), { recursive: true });
      fs.writeFileSync(modelModesPath, JSON.stringify(merged));
      return merged;
    } catch {
      return null;
    }
  });

  // --- Claude Code settings.json bridge (for Preferences panel) ---
  // Generic get/set keyed by field name so we don't need a handler per setting.
  // Reads/writes ~/.claude/settings.json which Claude Code itself also reads.
  // Field names follow Claude Code's own schema (e.g., 'editorMode', 'defaultMode').
  const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');

  ipcMain.handle('settings:get', async (_event, field: string) => {
    try {
      const raw = fs.readFileSync(claudeSettingsPath, 'utf-8');
      const parsed = JSON.parse(raw);
      // Dot-path support for nested fields like 'permissions.defaultMode'
      return field.split('.').reduce((obj: any, k) => (obj == null ? undefined : obj[k]), parsed);
    } catch {
      return undefined;
    }
  });

  ipcMain.handle('settings:set', async (_event, field: string, value: unknown) => {
    try {
      let existing: Record<string, any> = {};
      try {
        existing = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8'));
      } catch {}
      // Dot-path support — write nested fields without clobbering siblings
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
      fs.mkdirSync(path.dirname(claudeSettingsPath), { recursive: true });
      fs.writeFileSync(claudeSettingsPath, JSON.stringify(existing, null, 2));
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
      // Security: validate path stays within Claude projects directory (prevents arbitrary file read)
      const claudeProjects = path.join(os.homedir(), '.claude', 'projects');
      const resolved = path.resolve(transcriptPath);
      if (!resolved.startsWith(claudeProjects + path.sep)) return null;

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
  const DEFAULTS_INITIAL = {
    skipPermissions: false,
    model: 'sonnet',
    projectFolder: '',
    geminiEnabled: false, // Opt-in: show Gemini CLI option in new session form
    permissionOverrides: { ...PERMISSION_OVERRIDES_DEFAULT },
  };

  // Load permission overrides into main.ts cache on startup
  function syncPermissionOverrides(defaults: Record<string, any>) {
    const overrides = defaults.permissionOverrides;
    if (overrides && typeof overrides === 'object') {
      setPermissionOverrides(overrides);
    }
  }

  ipcMain.handle('defaults:get', async () => {
    try {
      const raw = fs.readFileSync(defaultsPrefPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const result = { ...DEFAULTS_INITIAL, ...parsed,
        permissionOverrides: { ...PERMISSION_OVERRIDES_DEFAULT, ...parsed.permissionOverrides },
      };
      syncPermissionOverrides(result);
      return result;
    } catch {
      return { ...DEFAULTS_INITIAL };
    }
  });

  ipcMain.handle('defaults:set', async (_event, updates: Record<string, any>) => {
    try {
      let current: Record<string, any> = { ...DEFAULTS_INITIAL };
      try {
        const parsed = JSON.parse(fs.readFileSync(defaultsPrefPath, 'utf-8'));
        current = { ...current, ...parsed,
          permissionOverrides: { ...PERMISSION_OVERRIDES_DEFAULT, ...parsed.permissionOverrides },
        };
      } catch {}
      // Deep-merge permissionOverrides instead of replacing
      const merged = { ...current, ...updates };
      if (updates.permissionOverrides) {
        merged.permissionOverrides = { ...current.permissionOverrides, ...updates.permissionOverrides };
      }
      fs.mkdirSync(path.dirname(defaultsPrefPath), { recursive: true });
      fs.writeFileSync(defaultsPrefPath, JSON.stringify(merged, null, 2));
      // Update in-memory cache so hook handler picks up changes immediately
      syncPermissionOverrides(merged);
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
    const result = await skillProvider.install(id);
    // Reload plugins so Claude Code discovers the new plugin. Uses a
    // short delay because firing immediately races the prompt-ready state
    // (the reload gets queued but silently no-ops). Matches Android
    // behavior (SessionService.kt:458).
    if (result.status === 'installed' && result.type === 'plugin') {
      sessionManager.broadcastReloadPlugins();
    }
    return result;
  });

  ipcMain.handle(IPC.SKILLS_UNINSTALL, async (_event, id: string) => {
    const result = await skillProvider.uninstall(id);
    // Reload plugins so Claude Code drops the uninstalled plugin — matches
    // Android behavior (SessionService.kt:490)
    if (result.type === 'plugin') {
      sessionManager.broadcastReloadPlugins();
    }
    return result;
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

  ipcMain.handle(IPC.SKILLS_GET_FEATURED, async () => {
    return skillProvider.getFeatured();
  });

  // Marketplace redesign Phase 3 — integrations IPC. list/status are real;
  // install/uninstall/configure are scaffolded (manifest-only; the actual
  // OAuth + script runner lands with the Google Workspace slice).
  ipcMain.handle(IPC.INTEGRATIONS_LIST, async () => {
    return listWithState(integrationInstaller);
  });
  ipcMain.handle(IPC.INTEGRATIONS_STATUS, async (_e, slug: string) => {
    return integrationInstaller.status(slug);
  });
  ipcMain.handle(IPC.INTEGRATIONS_INSTALL, async (_e, slug: string) => {
    return integrationInstaller.install(slug);
  });
  ipcMain.handle(IPC.INTEGRATIONS_UNINSTALL, async (_e, slug: string) => {
    return integrationInstaller.uninstall(slug);
  });
  ipcMain.handle(IPC.INTEGRATIONS_CONFIGURE, async (_e, slug: string, settings: Record<string, unknown>) => {
    return integrationInstaller.configure(slug, settings);
  });

  // Phase 4 — user-initiated cache bust. Next fetchIndex/getFeatured refetches.
  ipcMain.handle(IPC.MARKETPLACE_INVALIDATE_CACHE, async () => {
    await skillProvider.invalidateCache();
  });

  // Decomposition v3 §9.9: surface integration info for the detail view badges
  ipcMain.handle(IPC.SKILLS_GET_INTEGRATION_INFO, async (_event, id: string) => {
    return skillProvider.getIntegrationInfo(id);
  });

  // Decomposition v3 §9.10: onboarding bulk-install curated packages
  ipcMain.handle(IPC.SKILLS_INSTALL_MANY, async (_event, ids: string[]) => {
    return skillProvider.installMany(ids);
  });

  // Decomposition v3 §9.10: onboarding picks an output style
  ipcMain.handle(IPC.SKILLS_APPLY_OUTPUT_STYLE, async (_event, styleId: string) => {
    skillProvider.applyOutputStyle(styleId);
    return { ok: true };
  });

  // Phase 3a: unified marketplace packages map — lets the renderer know which
  // versions are currently installed (for update detection) and the on-disk
  // component paths (for uninstall cascade).
  ipcMain.handle(IPC.MARKETPLACE_GET_PACKAGES, async () => {
    return skillProvider.configStore.getPackages();
  });

  // Phase 3b: update an installed plugin/prompt to the latest marketplace
  // version. Re-downloads files, overwrites at the same path, and bumps the
  // version in destincode-skills.json. Config is NOT touched.
  ipcMain.handle(IPC.SKILLS_UPDATE, async (_event, id: string) => {
    const result = await skillProvider.update(id);
    // Reload plugins in active sessions so Claude Code picks up updated code
    if (result.ok) {
      sessionManager.broadcastReloadPlugins();
    }
    return result;
  });

  // Phase 3b: update an installed theme to the latest registry version.
  // Re-downloads theme files at the same slug path and bumps the version.
  ipcMain.handle(IPC.THEME_MARKETPLACE_UPDATE, async (_event, slug: string) => {
    return themeMarketplace.updateTheme(slug);
  });

  // Phase 3c: per-entry config — reads/writes ~/.claude/destincode-config/<id>.json.
  // Only entries that declare configSchema in their marketplace JSON use this.
  ipcMain.handle(IPC.MARKETPLACE_GET_CONFIG, async (_event, id: string) => {
    return getMarketplaceConfig(id);
  });

  ipcMain.handle(IPC.MARKETPLACE_SET_CONFIG, async (_event, id: string, values: Record<string, unknown>) => {
    setMarketplaceConfig(id, values);
    return { ok: true };
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
      sendForSession(sessionId, `pty:output:${sessionId}`, data);  // per-session (TerminalView)
      sendForSession(sessionId, IPC.PTY_OUTPUT, sessionId, data);  // global (App.tsx mode detection)
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
        sendForSession(sessionId, `pty:output:${sessionId}`, data);  // per-session (TerminalView)
        sendForSession(sessionId, IPC.PTY_OUTPUT, sessionId, data);  // global (App.tsx mode detection)
      }
      pendingOutput.delete(sessionId);
    }
  });

  // Forward session exit events — exitCode is piped through to the renderer
  // so the reducer can distinguish clean shutdowns from 'session-died' cases.
  sessionManager.on('session-exit', (sessionId: string, exitCode: number) => {
    sendForSession(sessionId, IPC.SESSION_DESTROYED, sessionId, exitCode);
    pendingOutput.delete(sessionId);
    readySessions.delete(sessionId);
    windowRegistry?.releaseSession(sessionId);
  });

  // --- Prune stale context files on startup ---
  // Context files are written per-session by statusline.sh and cleaned up on
  // session exit, but a crash can leave orphans. Delete any .context-* files
  // that aren't associated with a running session.
  try {
    const claudeDir = path.join(os.homedir(), '.claude');
    const entries = fs.readdirSync(claudeDir);
    for (const entry of entries) {
      // Prune orphaned context + session-stats files from crashed sessions
      if (entry.startsWith('.context-') || entry.startsWith('.session-stats-')) {
        fs.unlink(path.join(claudeDir, entry), () => {});
      }
    }
  } catch { /* directory doesn't exist or unreadable — fine */ }

  // --- Status data poller ---
  // Reads DestinClaude cache files and pushes status updates to the renderer
  const usageCachePath = path.join(os.homedir(), '.claude', '.usage-cache.json');
  const announcementCachePath = path.join(os.homedir(), '.claude', '.announcement-cache.json');

  // --- DestinCode app update checker via GitHub Releases API ---
  // Caches the latest release info and refreshes every 30 minutes.
  let cachedUpdateStatus: { current: string; latest: string; update_available: boolean; download_url: string | null } | null = null;
  let lastReleaseCheck = 0;
  const RELEASE_CHECK_INTERVAL = 30 * 60 * 1000; // 30 minutes

  function fetchLatestRelease(): Promise<void> {
    return new Promise((resolve) => {
      const req = https.get('https://api.github.com/repos/itsdestin/destincode/releases/latest', {
        headers: { 'User-Agent': 'DestinCode', 'Accept': 'application/vnd.github.v3+json' },
        timeout: 10000,
      }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          // Follow redirect (GitHub sometimes redirects)
          https.get(res.headers.location!, { headers: { 'User-Agent': 'DestinCode', 'Accept': 'application/vnd.github.v3+json' }, timeout: 10000 }, (rRes) => {
            let body = '';
            rRes.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            rRes.on('end', () => { parseReleaseResponse(body); resolve(); });
          }).on('error', () => { resolve(); });
          return;
        }
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => { parseReleaseResponse(body); resolve(); });
      });
      req.on('error', () => { resolve(); });
      req.on('timeout', () => { req.destroy(); resolve(); });
    });
  }

  function parseReleaseResponse(body: string) {
    try {
      const release = JSON.parse(body);
      const tagName: string = release.tag_name || '';
      const latestVersion = tagName.replace(/^v/, '');
      const currentVersion = app.getVersion();
      const isNewer = compareVersions(latestVersion, currentVersion) > 0;

      // Find the right installer asset for the current platform
      const assets: Array<{ name: string; browser_download_url: string }> = release.assets || [];
      let downloadUrl: string | null = null;
      const platform = process.platform;
      if (platform === 'win32') {
        // Prefer .exe installer
        const exe = assets.find(a => a.name.endsWith('.exe'));
        downloadUrl = exe?.browser_download_url || null;
      } else if (platform === 'darwin') {
        // Prefer .dmg
        const dmg = assets.find(a => a.name.endsWith('.dmg'));
        downloadUrl = dmg?.browser_download_url || null;
      } else {
        // Linux — prefer .AppImage, fallback to .deb
        const appImage = assets.find(a => a.name.endsWith('.AppImage'));
        const deb = assets.find(a => a.name.endsWith('.deb'));
        downloadUrl = appImage?.browser_download_url || deb?.browser_download_url || null;
      }
      // Fallback to release page if no matching asset found
      if (!downloadUrl) downloadUrl = release.html_url || null;

      cachedUpdateStatus = { current: currentVersion, latest: latestVersion, update_available: isNewer, download_url: downloadUrl };
      lastReleaseCheck = Date.now();
    } catch {
      // Parse failed — keep previous cache or set current version only
      if (!cachedUpdateStatus) {
        cachedUpdateStatus = { current: app.getVersion(), latest: app.getVersion(), update_available: false, download_url: null };
      }
    }
  }

  /** Simple semver compare: returns >0 if a > b, <0 if a < b, 0 if equal */
  function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = pa[i] || 0;
      const nb = pb[i] || 0;
      if (na !== nb) return na - nb;
    }
    return 0;
  }

  function getUpdateStatus() {
    // Return cached value, kick off background refresh if stale
    if (Date.now() - lastReleaseCheck > RELEASE_CHECK_INTERVAL) {
      fetchLatestRelease().catch(() => {});
    }
    return cachedUpdateStatus || { current: app.getVersion(), latest: app.getVersion(), update_available: false, download_url: null };
  }

  // Initial fetch on startup
  fetchLatestRelease().catch(() => {});
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
    const updateStatus = getUpdateStatus();
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

    // Read per-session git branch (written by statusline.sh, same pattern as context %)
    const gitBranchMap: Record<string, string> = {};
    for (const [desktopId, claudeId] of sessionIdMap) {
      const raw = readTextFile(path.join(os.homedir(), '.claude', `.gitbranch-${claudeId}`));
      if (raw) gitBranchMap[desktopId] = raw;
    }

    // Read per-session stats (cost, tokens, code changes — written by statusline.sh)
    const sessionStatsMap: Record<string, any> = {};
    for (const [desktopId, claudeId] of sessionIdMap) {
      const stats = readJsonFile(path.join(os.homedir(), '.claude', `.session-stats-${claudeId}.json`));
      if (stats) sessionStatsMap[desktopId] = stats;
    }

    return { usage, announcement, updateStatus, syncStatus, syncWarnings, lastSyncEpoch, syncInProgress, backupMeta, contextMap, gitBranchMap, sessionStatsMap };
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
    sendForSession(event.sessionId, IPC.TRANSCRIPT_EVENT, event);
    if (remoteServer) {
      remoteServer.bufferTranscriptEvent(event);
      remoteServer.broadcast({ type: 'transcript:event', payload: event });
    }
  });

  // Transcript replay: a window that just acquired a session asks for every
  // historical event so its reducer can hydrate. Events stream back on the
  // normal TRANSCRIPT_EVENT channel (uuid dedup handles overlap with live).
  // We send directly to the requesting window — NOT via sendForSession —
  // because ownership has already transferred to them by the time this fires.
  ipcMain.on(IPC.TRANSCRIPT_REPLAY, (evt, { sessionId }: { sessionId: string }) => {
    const events = transcriptWatcher.getHistory(sessionId);
    for (const ev of events) {
      evt.sender.send(IPC.TRANSCRIPT_EVENT, ev);
    }
  });
  // /clear and /compact both truncate or rewrite the JSONL. App.tsx listens
  // to detect compaction completion (pending → COMPACTION_COMPLETE).
  transcriptWatcher.on('transcript-shrink', (payload: any) => {
    sendForSession(payload.sessionId, IPC.TRANSCRIPT_SHRINK, payload);
    if (remoteServer) {
      remoteServer.broadcast({ type: 'transcript:shrink', payload });
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
      sendForSession(desktopId, IPC.SESSION_RENAMED, desktopId, initial);
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
          sendForSession(desktopId, IPC.SESSION_RENAMED, desktopId, topic);
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
        sendForSession(desktopId, IPC.SESSION_RENAMED, desktopId, topic);
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
    // Clean up context + session stats cache files
    const claudeId = sessionIdMap.get(sessionId);
    if (claudeId) {
      fs.unlink(path.join(os.homedir(), '.claude', `.context-${claudeId}`), () => {});
      fs.unlink(path.join(os.homedir(), '.claude', `.session-stats-${claudeId}.json`), () => {});
    }
    sessionIdMap.delete(sessionId);
  });

  // Set a named flag on a session (complete, priority, helpful). Persists in
  // conversation-index.json via SyncService (so it rides the existing
  // backup/downsync pipeline) and broadcasts SESSION_META_CHANGED so any open
  // resume browser refreshes. Accepts either a Claude session ID (as stored in
  // the index) or a desktop session ID — the desktop ID is resolved via
  // sessionIdMap. Unknown flag names are rejected server-side so a typo
  // surfaces as an error rather than silently writing dead data.
  ipcMain.handle(IPC.SESSION_SET_FLAG, async (_event, sessionId: string, flag: string, value: boolean) => {
    const svc = getSyncService();
    if (!svc) return { ok: false, error: 'sync service unavailable' };
    if (!SESSION_FLAG_NAMES.includes(flag as SessionFlagName)) {
      return { ok: false, error: `unknown flag: ${flag}` };
    }
    const resolved = sessionIdMap.get(sessionId) || sessionId;
    try {
      svc.setSessionFlag(resolved, flag, !!value);
      const payload = { flag, value: !!value };
      sendForSession(resolved, IPC.SESSION_META_CHANGED, resolved, payload);
      remoteServer?.broadcast({
        type: IPC.SESSION_META_CHANGED,
        payload: { sessionId: resolved, ...payload },
      });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
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

  // V2: Per-instance backend management (storage backends + multi-instance support)
  ipcMain.handle('sync:add-backend', (_e, instance) => addBackend(instance));
  ipcMain.handle('sync:remove-backend', (_e, id) => removeBackend(id));
  ipcMain.handle('sync:update-backend', (_e, id, updates) => updateBackend(id, updates));
  ipcMain.handle('sync:push-backend', (_e, id) => pushBackend(id));
  ipcMain.handle('sync:pull-backend', (_e, id) => pullBackend(id));

  // Open a backend's remote location in the default browser/file explorer
  ipcMain.handle('sync:open-folder', async (_e, id: string) => {
    const { shell } = require('electron');
    const config = await getSyncConfig();
    const backend = config.backends.find((b: any) => b.id === id);
    if (!backend) return;

    switch (backend.type) {
      case 'drive': {
        // Deep-link to the actual sync folder on Google Drive by resolving its
        // file ID via rclone, then opening https://drive.google.com/drive/folders/<id>.
        // Falls back to the generic Drive homepage if rclone or the folder lookup fails.
        const rcloneRemote = backend.config?.rcloneRemote || 'gdrive';
        const driveRoot = backend.config?.DRIVE_ROOT || 'Claude';
        const parentPath = `${rcloneRemote}:${driveRoot}/Backup`;
        const targetName = 'personal';
        const fallbackUrl = 'https://drive.google.com';
        try {
          const stdout: string = await new Promise((resolve, reject) => {
            execFile(
              'rclone',
              ['lsjson', parentPath, '--dirs-only'],
              { timeout: 15000 },
              (err, out) => (err ? reject(err) : resolve(String(out || ''))),
            );
          });
          const entries = JSON.parse(stdout) as Array<{ Name: string; ID?: string }>;
          const match = entries.find((e) => e.Name === targetName && e.ID);
          if (match?.ID) {
            shell.openExternal(`https://drive.google.com/drive/folders/${match.ID}`);
          } else {
            shell.openExternal(fallbackUrl);
          }
        } catch {
          shell.openExternal(fallbackUrl);
        }
        break;
      }
      case 'github': {
        const repoUrl = backend.config?.PERSONAL_SYNC_REPO || '';
        if (repoUrl) shell.openExternal(repoUrl);
        break;
      }
      case 'icloud': {
        const icloudPath = backend.config?.ICLOUD_PATH || '';
        if (icloudPath) shell.openPath(icloudPath);
        break;
      }
    }
  });

  // Guided setup wizard: prerequisite detection, tool installation, OAuth, repo creation.
  // Each handler runs one specific command — no generic shell exec.
  ipcMain.handle('sync:setup:check-prereqs', (_e, backend) => checkSyncPrereqs(backend));
  ipcMain.handle('sync:setup:install-rclone', () => installRclone());
  ipcMain.handle('sync:setup:check-gdrive', () => checkGdriveRemote());
  ipcMain.handle('sync:setup:auth-gdrive', () => authGdrive());
  ipcMain.handle('sync:setup:auth-github', () => authGithub());
  ipcMain.handle('sync:setup:create-repo', (_e, repoName) => createGithubRepo(repoName));

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
