import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

// IPC channel names inlined here because Electron's sandboxed preload
// cannot resolve relative imports to other modules
const IPC = {
  SESSION_CREATE: 'session:create',
  SESSION_DESTROY: 'session:destroy',
  SESSION_INPUT: 'session:input',
  SESSION_RESIZE: 'session:resize',
  SESSION_LIST: 'session:list',
  SESSION_CREATED: 'session:created',
  SESSION_DESTROYED: 'session:destroyed',
  PTY_OUTPUT: 'pty:output',
  HOOK_EVENT: 'hook:event',
  SESSION_RENAMED: 'session:renamed',
  DIALOG_OPEN_FILE: 'dialog:open-file',
  DIALOG_OPEN_FOLDER: 'dialog:open-folder',
  DIALOG_OPEN_SOUND: 'dialog:open-sound',
  CLIPBOARD_SAVE_IMAGE: 'clipboard:save-image',
  STATUS_DATA: 'status:data',
  READ_TRANSCRIPT_META: 'transcript:read-meta',
  SKILLS_LIST: 'skills:list',
  SKILLS_LIST_MARKETPLACE: 'skills:list-marketplace',
  SKILLS_GET_DETAIL: 'skills:get-detail',
  SKILLS_SEARCH: 'skills:search',
  SKILLS_INSTALL: 'skills:install',
  SKILLS_UNINSTALL: 'skills:uninstall',
  SKILLS_GET_FAVORITES: 'skills:get-favorites',
  SKILLS_SET_FAVORITE: 'skills:set-favorite',
  SKILLS_GET_CHIPS: 'skills:get-chips',
  SKILLS_SET_CHIPS: 'skills:set-chips',
  SKILLS_GET_OVERRIDE: 'skills:get-override',
  SKILLS_SET_OVERRIDE: 'skills:set-override',
  SKILLS_CREATE_PROMPT: 'skills:create-prompt',
  SKILLS_DELETE_PROMPT: 'skills:delete-prompt',
  SKILLS_PUBLISH: 'skills:publish',
  SKILLS_GET_SHARE_LINK: 'skills:get-share-link',
  SKILLS_IMPORT_FROM_LINK: 'skills:import-from-link',
  SKILLS_GET_CURATED_DEFAULTS: 'skills:get-curated-defaults',
  OPEN_CHANGELOG: 'shell:open-changelog',
  OPEN_EXTERNAL: 'shell:open-external',
  TERMINAL_READY: 'session:terminal-ready',
  PERMISSION_RESPOND: 'permission:respond',
  REMOTE_GET_CONFIG: 'remote:get-config',
  REMOTE_SET_PASSWORD: 'remote:set-password',
  REMOTE_SET_CONFIG: 'remote:set-config',
  REMOTE_DETECT_TAILSCALE: 'remote:detect-tailscale',
  REMOTE_GET_CLIENT_COUNT: 'remote:get-client-count',
  REMOTE_GET_CLIENT_LIST: 'remote:get-client-list',
  REMOTE_DISCONNECT_CLIENT: 'remote:disconnect-client',
  REMOTE_INSTALL_TAILSCALE: 'remote:install-tailscale',
  REMOTE_AUTH_TAILSCALE: 'remote:auth-tailscale',
  UI_ACTION_BROADCAST: 'ui:action:broadcast',
  UI_ACTION_RECEIVED: 'ui:action:received',
  TRANSCRIPT_EVENT: 'transcript:event',
  // Fired when the JSONL file shrinks (/.clear truncation or /compact rewrite).
  // App.tsx listens to finalize compaction state machines.
  TRANSCRIPT_SHRINK: 'transcript:shrink',
  SESSION_BROWSE: 'session:browse',
  SESSION_HISTORY: 'session:history',
  // Folder switcher
  FOLDERS_LIST: 'folders:list',
  FOLDERS_ADD: 'folders:add',
  FOLDERS_REMOVE: 'folders:remove',
  FOLDERS_RENAME: 'folders:rename',
  // Theme system
  THEME_RELOAD: 'theme:reload',   // Main -> Renderer: a theme file changed
  THEME_LIST: 'theme:list',       // Renderer -> Main: get list of user theme slugs
  THEME_READ_FILE: 'theme:read-file', // Renderer -> Main: read a user theme JSON by slug
  THEME_WRITE_FILE: 'theme:write-file',
  THEME_READ_ASSET: 'theme:read-asset',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  ZOOM_IN: 'zoom:in',
  ZOOM_OUT: 'zoom:out',
  ZOOM_RESET: 'zoom:reset',
  ZOOM_GET: 'zoom:get',
  // Theme marketplace
  THEME_MARKETPLACE_LIST: 'theme-marketplace:list',
  THEME_MARKETPLACE_DETAIL: 'theme-marketplace:detail',
  THEME_MARKETPLACE_INSTALL: 'theme-marketplace:install',
  THEME_MARKETPLACE_UNINSTALL: 'theme-marketplace:uninstall',
  THEME_MARKETPLACE_UPDATE: 'theme-marketplace:update',
  THEME_MARKETPLACE_PUBLISH: 'theme-marketplace:publish',
  THEME_MARKETPLACE_GENERATE_PREVIEW: 'theme-marketplace:generate-preview',
  // Unified marketplace (Phase 3)
  MARKETPLACE_GET_PACKAGES: 'marketplace:get-packages',
  SKILLS_UPDATE: 'skills:update',
  MARKETPLACE_GET_CONFIG: 'marketplace:get-config',
  MARKETPLACE_SET_CONFIG: 'marketplace:set-config',
  FIRST_RUN_STATE: 'first-run:state',
  FIRST_RUN_RETRY: 'first-run:retry',
  FIRST_RUN_START_AUTH: 'first-run:start-auth',
  FIRST_RUN_SUBMIT_API_KEY: 'first-run:submit-api-key',
  FIRST_RUN_DEV_MODE_DONE: 'first-run:dev-mode-done',
  FIRST_RUN_SKIP: 'first-run:skip',
  MODEL_GET_PREFERENCE: 'model:get-preference',
  MODEL_SET_PREFERENCE: 'model:set-preference',
  APPEARANCE_GET: 'appearance:get',
  APPEARANCE_SET: 'appearance:set',
  MODEL_READ_LAST: 'model:read-last',
  DEFAULTS_GET: 'defaults:get',
  DEFAULTS_SET: 'defaults:set',
  // Claude Code settings.json bridge — used by Preferences panel (/config intercept)
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  // Fast mode + effort level — DestinCode-local state (Claude Code doesn't transcribe these)
  MODES_GET: 'modes:get',
  MODES_SET: 'modes:set',
  SESSION_SWITCH: 'session:switch',
  // Sync management
  SYNC_GET_STATUS: 'sync:get-status',
  SYNC_GET_CONFIG: 'sync:get-config',
  SYNC_SET_CONFIG: 'sync:set-config',
  SYNC_FORCE: 'sync:force',
  SYNC_GET_LOG: 'sync:get-log',
  SYNC_DISMISS_WARNING: 'sync:dismiss-warning',
} as const;

contextBridge.exposeInMainWorld('claude', {
  session: {
    create: (opts: { name: string; cwd: string; skipPermissions: boolean; cols?: number; rows?: number; resumeSessionId?: string; provider?: 'claude' | 'gemini' }) =>
      ipcRenderer.invoke(IPC.SESSION_CREATE, opts),
    destroy: (sessionId: string) =>
      ipcRenderer.invoke(IPC.SESSION_DESTROY, sessionId),
    list: () => ipcRenderer.invoke(IPC.SESSION_LIST),
    sendInput: (sessionId: string, text: string) =>
      ipcRenderer.send(IPC.SESSION_INPUT, sessionId, text),
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.send(IPC.SESSION_RESIZE, sessionId, cols, rows),
    signalReady: (sessionId: string) =>
      ipcRenderer.send(IPC.TERMINAL_READY, sessionId),
    respondToPermission: (requestId: string, decision: object) =>
      ipcRenderer.invoke(IPC.PERMISSION_RESPOND, requestId, decision),
    browse: (): Promise<any[]> =>
      ipcRenderer.invoke(IPC.SESSION_BROWSE),
    loadHistory: (sessionId: string, projectSlug: string, count?: number, all?: boolean): Promise<any[]> =>
      ipcRenderer.invoke(IPC.SESSION_HISTORY, sessionId, projectSlug, count || 10, all || false),
    switch: (sessionId: string) =>
      ipcRenderer.invoke(IPC.SESSION_SWITCH, sessionId),
  },
  on: {
    sessionCreated: (cb: (info: any) => void) => {
      const handler = (_e: IpcRendererEvent, info: any) => cb(info);
      ipcRenderer.on(IPC.SESSION_CREATED, handler);
      return handler;
    },
    sessionDestroyed: (cb: (id: string) => void) => {
      const handler = (_e: IpcRendererEvent, id: string) => cb(id);
      ipcRenderer.on(IPC.SESSION_DESTROYED, handler);
      return handler;
    },
    ptyOutput: (cb: (sessionId: string, data: string) => void) => {
      const handler = (_e: IpcRendererEvent, sid: string, data: string) => cb(sid, data);
      ipcRenderer.on(IPC.PTY_OUTPUT, handler);
      return handler;
    },
    ptyOutputForSession: (sessionId: string, cb: (data: string) => void) => {
      const channel = `pty:output:${sessionId}`;
      const handler = (_event: IpcRendererEvent, data: string) => cb(data);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    hookEvent: (cb: (event: any) => void) => {
      const handler = (_e: IpcRendererEvent, event: any) => cb(event);
      ipcRenderer.on(IPC.HOOK_EVENT, handler);
      return handler;
    },
    statusData: (cb: (data: any) => void) => {
      const handler = (_e: IpcRendererEvent, data: any) => cb(data);
      ipcRenderer.on(IPC.STATUS_DATA, handler);
      return handler;
    },
    sessionRenamed: (cb: (sessionId: string, name: string) => void) => {
      const handler = (_e: IpcRendererEvent, sid: string, name: string) => cb(sid, name);
      ipcRenderer.on(IPC.SESSION_RENAMED, handler);
      return handler;
    },
    // Shape parity with remote-shim — desktop never fires this push event
    // (mode detection runs in App.tsx via pty:output text matching), so this
    // is a no-op subscriber that just keeps `window.claude.on` symmetric.
    sessionPermissionMode: (_cb: (sessionId: string, mode: string) => void) => {
      return () => {};
    },
    uiAction: (cb: (action: any) => void) => {
      const handler = (_e: IpcRendererEvent, action: any) => cb(action);
      ipcRenderer.on(IPC.UI_ACTION_RECEIVED, handler);
      return handler;
    },
    transcriptEvent: (cb: (event: any) => void) => {
      const handler = (_e: IpcRendererEvent, event: any) => cb(event);
      ipcRenderer.on(IPC.TRANSCRIPT_EVENT, handler);
      return handler;
    },
    // Fired on JSONL truncation — used to detect /compact completion and
    // (defensively) catch /clear even if the dispatcher intercept was bypassed.
    transcriptShrink: (cb: (payload: { sessionId: string; oldSize: number; newSize: number }) => void) => {
      const handler = (_e: IpcRendererEvent, payload: any) => cb(payload);
      ipcRenderer.on(IPC.TRANSCRIPT_SHRINK, handler);
      return handler;
    },
  },
  skills: {
    list: (): Promise<any[]> => ipcRenderer.invoke(IPC.SKILLS_LIST),
    listMarketplace: (filters?: any): Promise<any[]> => ipcRenderer.invoke(IPC.SKILLS_LIST_MARKETPLACE, filters),
    getDetail: (id: string): Promise<any> => ipcRenderer.invoke(IPC.SKILLS_GET_DETAIL, id),
    search: (query: string): Promise<any[]> => ipcRenderer.invoke(IPC.SKILLS_SEARCH, query),
    install: (id: string): Promise<void> => ipcRenderer.invoke(IPC.SKILLS_INSTALL, id),
    uninstall: (id: string): Promise<void> => ipcRenderer.invoke(IPC.SKILLS_UNINSTALL, id),
    getFavorites: (): Promise<string[]> => ipcRenderer.invoke(IPC.SKILLS_GET_FAVORITES),
    setFavorite: (id: string, favorited: boolean): Promise<void> => ipcRenderer.invoke(IPC.SKILLS_SET_FAVORITE, id, favorited),
    getChips: (): Promise<any[]> => ipcRenderer.invoke(IPC.SKILLS_GET_CHIPS),
    setChips: (chips: any[]): Promise<void> => ipcRenderer.invoke(IPC.SKILLS_SET_CHIPS, chips),
    getOverride: (id: string): Promise<any> => ipcRenderer.invoke(IPC.SKILLS_GET_OVERRIDE, id),
    setOverride: (id: string, override: any): Promise<void> => ipcRenderer.invoke(IPC.SKILLS_SET_OVERRIDE, id, override),
    createPrompt: (skill: any): Promise<any> => ipcRenderer.invoke(IPC.SKILLS_CREATE_PROMPT, skill),
    deletePrompt: (id: string): Promise<void> => ipcRenderer.invoke(IPC.SKILLS_DELETE_PROMPT, id),
    publish: (id: string): Promise<any> => ipcRenderer.invoke(IPC.SKILLS_PUBLISH, id),
    getShareLink: (id: string): Promise<string> => ipcRenderer.invoke(IPC.SKILLS_GET_SHARE_LINK, id),
    importFromLink: (encoded: string): Promise<any> => ipcRenderer.invoke(IPC.SKILLS_IMPORT_FROM_LINK, encoded),
    getCuratedDefaults: (): Promise<string[]> => ipcRenderer.invoke(IPC.SKILLS_GET_CURATED_DEFAULTS),
    // Phase 3b: update an already-installed plugin
    update: (id: string): Promise<any> => ipcRenderer.invoke(IPC.SKILLS_UPDATE, id),
  },
  // Phase 3: unified marketplace APIs (packages map, per-entry config)
  marketplace: {
    getPackages: (): Promise<Record<string, any>> => ipcRenderer.invoke(IPC.MARKETPLACE_GET_PACKAGES),
    getConfig: (id: string): Promise<Record<string, any>> => ipcRenderer.invoke(IPC.MARKETPLACE_GET_CONFIG, id),
    setConfig: (id: string, values: Record<string, any>): Promise<void> =>
      ipcRenderer.invoke(IPC.MARKETPLACE_SET_CONFIG, id, values),
  },
  dialog: {
    openFile: (): Promise<string[]> =>
      ipcRenderer.invoke(IPC.DIALOG_OPEN_FILE),
    openFolder: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC.DIALOG_OPEN_FOLDER),
    openSound: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC.DIALOG_OPEN_SOUND),
    readTranscriptMeta: (transcriptPath: string): Promise<{ model: string; contextPercent: number } | null> =>
      ipcRenderer.invoke(IPC.READ_TRANSCRIPT_META, transcriptPath),
    saveClipboardImage: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC.CLIPBOARD_SAVE_IMAGE),
  },
  shell: {
    openChangelog: (): Promise<void> =>
      ipcRenderer.invoke(IPC.OPEN_CHANGELOG),
    openExternal: (url: string): Promise<void> =>
      ipcRenderer.invoke(IPC.OPEN_EXTERNAL, url),
  },
  remote: {
    getConfig: () => ipcRenderer.invoke(IPC.REMOTE_GET_CONFIG),
    setPassword: (password: string) => ipcRenderer.invoke(IPC.REMOTE_SET_PASSWORD, password),
    setConfig: (updates: { enabled?: boolean; trustTailscale?: boolean }) =>
      ipcRenderer.invoke(IPC.REMOTE_SET_CONFIG, updates),
    detectTailscale: () => ipcRenderer.invoke(IPC.REMOTE_DETECT_TAILSCALE),
    getClientCount: () => ipcRenderer.invoke(IPC.REMOTE_GET_CLIENT_COUNT),
    getClientList: () => ipcRenderer.invoke(IPC.REMOTE_GET_CLIENT_LIST),
    disconnectClient: (clientId: string) => ipcRenderer.invoke(IPC.REMOTE_DISCONNECT_CLIENT, clientId),
    installTailscale: () => ipcRenderer.invoke(IPC.REMOTE_INSTALL_TAILSCALE),
    authTailscale: () => ipcRenderer.invoke(IPC.REMOTE_AUTH_TAILSCALE),
    broadcastAction: (action: any) => ipcRenderer.send(IPC.UI_ACTION_BROADCAST, action),
  },
  model: {
    getPreference: (): Promise<string> => ipcRenderer.invoke(IPC.MODEL_GET_PREFERENCE),
    setPreference: (model: string): Promise<boolean> => ipcRenderer.invoke(IPC.MODEL_SET_PREFERENCE, model),
    readLastModel: (transcriptPath: string): Promise<string | null> => ipcRenderer.invoke(IPC.MODEL_READ_LAST, transcriptPath),
  },
  appearance: {
    get: (): Promise<{ theme?: string; themeCycle?: string[]; reducedEffects?: boolean; showTimestamps?: boolean; glassOverrides?: Record<string, Record<string, number>> } | null> =>
      ipcRenderer.invoke(IPC.APPEARANCE_GET),
    // Accepts arbitrary appearance prefs — glassOverrides stores per-theme
    // glass slider overrides for community/builtin themes
    set: (prefs: { theme?: string; themeCycle?: string[]; reducedEffects?: boolean; showTimestamps?: boolean; glassOverrides?: Record<string, Record<string, number>> }): Promise<boolean> =>
      ipcRenderer.invoke(IPC.APPEARANCE_SET, prefs),
  },
  defaults: {
    get: (): Promise<{ skipPermissions: boolean; model: string; projectFolder: string }> =>
      ipcRenderer.invoke(IPC.DEFAULTS_GET),
    set: (updates: Partial<{ skipPermissions: boolean; model: string; projectFolder: string }>): Promise<any> =>
      ipcRenderer.invoke(IPC.DEFAULTS_SET, updates),
  },
  // Claude Code settings.json — used by Preferences panel (/config intercept).
  // Field names follow Claude Code's schema; dot-paths supported (e.g. 'permissions.defaultMode').
  settings: {
    get: (field: string): Promise<unknown> => ipcRenderer.invoke(IPC.SETTINGS_GET, field),
    set: (field: string, value: unknown): Promise<boolean> => ipcRenderer.invoke(IPC.SETTINGS_SET, field, value),
  },
  // Fast mode + effort level — local-only state for /fast and /effort UI.
  modes: {
    get: (): Promise<{ fast: boolean; effort: string }> => ipcRenderer.invoke(IPC.MODES_GET),
    set: (modes: { fast?: boolean; effort?: string }): Promise<any> => ipcRenderer.invoke(IPC.MODES_SET, modes),
  },
  folders: {
    list: (): Promise<any[]> => ipcRenderer.invoke(IPC.FOLDERS_LIST),
    add: (folderPath: string, nickname?: string): Promise<any> => ipcRenderer.invoke(IPC.FOLDERS_ADD, folderPath, nickname),
    remove: (folderPath: string): Promise<boolean> => ipcRenderer.invoke(IPC.FOLDERS_REMOVE, folderPath),
    rename: (folderPath: string, nickname: string): Promise<boolean> => ipcRenderer.invoke(IPC.FOLDERS_RENAME, folderPath, nickname),
  },
  off: (channel: string, handler: (...args: any[]) => void) =>
    ipcRenderer.removeListener(channel, handler),
  removeAllListeners: (channel: string) =>
    ipcRenderer.removeAllListeners(channel),
  sync: {
    getStatus: () => ipcRenderer.invoke(IPC.SYNC_GET_STATUS),
    getConfig: () => ipcRenderer.invoke(IPC.SYNC_GET_CONFIG),
    setConfig: (updates: any) => ipcRenderer.invoke(IPC.SYNC_SET_CONFIG, updates),
    force: () => ipcRenderer.invoke(IPC.SYNC_FORCE),
    getLog: (lines?: number) => ipcRenderer.invoke(IPC.SYNC_GET_LOG, lines),
    dismissWarning: (warning: string) => ipcRenderer.invoke(IPC.SYNC_DISMISS_WARNING, warning),
    // V2: Per-instance backend management
    addBackend: (instance: any) => ipcRenderer.invoke('sync:add-backend', instance),
    removeBackend: (id: string) => ipcRenderer.invoke('sync:remove-backend', id),
    updateBackend: (id: string, updates: any) => ipcRenderer.invoke('sync:update-backend', id, updates),
    pushBackend: (id: string) => ipcRenderer.invoke('sync:push-backend', id),
    pullBackend: (id: string) => ipcRenderer.invoke('sync:pull-backend', id),
    openFolder: (id: string) => ipcRenderer.invoke('sync:open-folder', id),
    // Guided setup wizard
    setup: {
      checkPrereqs: (backend: string) => ipcRenderer.invoke('sync:setup:check-prereqs', backend),
      installRclone: () => ipcRenderer.invoke('sync:setup:install-rclone'),
      checkGdrive: () => ipcRenderer.invoke('sync:setup:check-gdrive'),
      authGdrive: () => ipcRenderer.invoke('sync:setup:auth-gdrive'),
      authGithub: () => ipcRenderer.invoke('sync:setup:auth-github'),
      createRepo: (repoName: string) => ipcRenderer.invoke('sync:setup:create-repo', repoName),
    },
  },
  getFavorites: () => ipcRenderer.invoke('favorites:get'),
  setFavorites: (favorites: string[]) => ipcRenderer.invoke('favorites:set', favorites),
  getIncognito: () => ipcRenderer.invoke('game:getIncognito'),
  setIncognito: (incognito: boolean) => ipcRenderer.invoke('game:setIncognito', incognito),
  getGitHubAuth: () => ipcRenderer.invoke('github:auth'),
  // Async IPC — renderer must await this (was sendSync before v2.2.0)
  getHomePath: (): Promise<string> => ipcRenderer.invoke('get-home-path'),
  window: {
    minimize: () => ipcRenderer.invoke(IPC.WINDOW_MINIMIZE),
    maximize: () => ipcRenderer.invoke(IPC.WINDOW_MAXIMIZE),
    close: () => ipcRenderer.invoke(IPC.WINDOW_CLOSE),
    // Fullscreen state relay — used by renderer to adjust macOS traffic light padding
    onFullscreenChanged: (handler: (isFullscreen: boolean) => void) => {
      const wrapped = (_event: IpcRendererEvent, isFullscreen: boolean) => handler(isFullscreen);
      ipcRenderer.on('window:fullscreen-changed', wrapped);
      return () => ipcRenderer.removeListener('window:fullscreen-changed', wrapped);
    },
  },
  theme: {
    list: () => ipcRenderer.invoke(IPC.THEME_LIST),
    readFile: (slug: string) => ipcRenderer.invoke(IPC.THEME_READ_FILE, slug),
    writeFile: (slug: string, content: string) => ipcRenderer.invoke(IPC.THEME_WRITE_FILE, slug, content),
    onReload: (handler: (slug: string) => void) => {
      const wrapped = (_event: IpcRendererEvent, slug: string) => handler(slug);
      ipcRenderer.on(IPC.THEME_RELOAD, wrapped);
      return () => ipcRenderer.removeListener(IPC.THEME_RELOAD, wrapped);
    },
    marketplace: {
      list: (filters?: any): Promise<any[]> => ipcRenderer.invoke(IPC.THEME_MARKETPLACE_LIST, filters),
      detail: (slug: string): Promise<any> => ipcRenderer.invoke(IPC.THEME_MARKETPLACE_DETAIL, slug),
      install: (slug: string): Promise<any> => ipcRenderer.invoke(IPC.THEME_MARKETPLACE_INSTALL, slug),
      uninstall: (slug: string): Promise<any> => ipcRenderer.invoke(IPC.THEME_MARKETPLACE_UNINSTALL, slug),
      // Phase 3b: re-install a theme at the same slug, overwriting files
      update: (slug: string): Promise<any> => ipcRenderer.invoke(IPC.THEME_MARKETPLACE_UPDATE, slug),
      publish: (slug: string): Promise<any> => ipcRenderer.invoke(IPC.THEME_MARKETPLACE_PUBLISH, slug),
      generatePreview: (slug: string): Promise<string | null> => ipcRenderer.invoke(IPC.THEME_MARKETPLACE_GENERATE_PREVIEW, slug),
    },
  },
  firstRun: {
    getState: (): Promise<any> => ipcRenderer.invoke(IPC.FIRST_RUN_STATE),
    retry: (): Promise<void> => ipcRenderer.invoke(IPC.FIRST_RUN_RETRY),
    startAuth: (mode: 'oauth' | 'apikey'): Promise<void> =>
      ipcRenderer.invoke(IPC.FIRST_RUN_START_AUTH, mode),
    submitApiKey: (key: string): Promise<void> =>
      ipcRenderer.invoke(IPC.FIRST_RUN_SUBMIT_API_KEY, key),
    devModeDone: (): Promise<void> => ipcRenderer.invoke(IPC.FIRST_RUN_DEV_MODE_DONE),
    skip: (): Promise<void> => ipcRenderer.invoke(IPC.FIRST_RUN_SKIP),
    onStateChanged: (cb: (state: any) => void) => {
      const handler = (_e: IpcRendererEvent, state: any) => cb(state);
      ipcRenderer.on(IPC.FIRST_RUN_STATE, handler);
      return handler;
    },
  },
  zoom: {
    zoomIn: (): Promise<number> => ipcRenderer.invoke(IPC.ZOOM_IN),
    zoomOut: (): Promise<number> => ipcRenderer.invoke(IPC.ZOOM_OUT),
    reset: (): Promise<number> => ipcRenderer.invoke(IPC.ZOOM_RESET),
    get: (): Promise<number> => ipcRenderer.invoke(IPC.ZOOM_GET),
  },
});
