import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type { AuthStartResponse, AuthPollResponse, PostRatingInput } from '../renderer/state/marketplace-api-client';
import type { MarketplaceUser } from './marketplace-auth-store';
import type { ApiResult } from './marketplace-api-handlers';

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
  SKILLS_GET_FEATURED: 'skills:get-featured',
  // Marketplace redesign Phase 3 — integrations namespace.
  INTEGRATIONS_LIST: 'integrations:list',
  INTEGRATIONS_INSTALL: 'integrations:install',
  INTEGRATIONS_UNINSTALL: 'integrations:uninstall',
  INTEGRATIONS_STATUS: 'integrations:status',
  INTEGRATIONS_CONFIGURE: 'integrations:configure',
  // Phase 4 — skip 24h cache after /feature curation.
  MARKETPLACE_INVALIDATE_CACHE: 'marketplace:invalidate-cache',
  SKILLS_GET_INTEGRATION_INFO: 'skills:get-integration-info',
  SKILLS_INSTALL_MANY: 'skills:install-many',
  SKILLS_APPLY_OUTPUT_STYLE: 'skills:apply-output-style',
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
  // Mark/unmark a session flag (complete, priority, helpful, …)
  SESSION_SET_FLAG: 'session:set-flag',
  // Pushed when session metadata (a flag value) changes so open browsers refresh
  SESSION_META_CHANGED: 'session:meta-changed',
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
  WINDOW_SET_ICON: 'window:set-icon',
  // Repositions macOS traffic lights — needed because the OS positions them at
  // fixed window coords, so the floating-chrome header (margin + radius) leaves
  // them stranded in empty space. Caller passes a {x,y} offset or null to reset.
  WINDOW_SET_TRAFFIC_LIGHT_POS: 'window:set-traffic-light-pos',
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
  THEME_MARKETPLACE_RESOLVE_PUBLISH_STATE: 'theme-marketplace:resolve-publish-state',
  THEME_MARKETPLACE_REFRESH_REGISTRY: 'theme-marketplace:refresh-registry',
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
  // Restore from backup (directional pull — see restore-service.ts)
  SYNC_RESTORE_LIST_VERSIONS: 'sync:restore:list-versions',
  SYNC_RESTORE_PREVIEW: 'sync:restore:preview',
  SYNC_RESTORE_EXECUTE: 'sync:restore:execute',
  SYNC_RESTORE_PROGRESS: 'sync:restore:progress',
  SYNC_RESTORE_LIST_SNAPSHOTS: 'sync:restore:list-snapshots',
  SYNC_RESTORE_UNDO: 'sync:restore:undo',
  SYNC_RESTORE_DELETE_SNAPSHOT: 'sync:restore:delete-snapshot',
  SYNC_RESTORE_PROBE: 'sync:restore:probe',
  SYNC_RESTORE_BROWSE_URL: 'sync:restore:browse-url',
  // Window detach / multi-window ownership (feature: drag session to new window)
  WINDOW_GET_ID: 'window:get-id',
  WINDOW_DIRECTORY_UPDATED: 'window:directory-updated',
  WINDOW_GET_DIRECTORY: 'window:get-directory',
  WINDOW_LEADER_CHANGED: 'window:leader-changed',
  WINDOW_OPEN_DETACHED: 'window:open-detached',
  WINDOW_FOCUS_AND_SWITCH: 'window:focus-and-switch',
  SESSION_OWNERSHIP_ACQUIRED: 'session:ownership-acquired',
  SESSION_OWNERSHIP_LOST: 'session:ownership-lost',
  SESSION_DETACH_START: 'session:detach-start',
  SESSION_DETACH_LIVE: 'session:detach-live',
  SESSION_DRAG_WINDOW_MOVE: 'session:drag-window-move',
  SESSION_DRAG_STARTED: 'session:drag-started',
  SESSION_DRAG_ENDED: 'session:drag-ended',
  SESSION_DRAG_DROPPED: 'session:drag-dropped',
  SESSION_DROP_RESOLVE: 'session:drop-resolve',
  CROSS_WINDOW_CURSOR: 'session:cross-window-cursor',
  TRANSCRIPT_REPLAY: 'transcript:replay-from-start',
  APPEARANCE_BROADCAST: 'appearance:broadcast',
  APPEARANCE_SYNC: 'appearance:sync',
  // Marketplace auth + write APIs (Task 4 — byte-identical to marketplace-api-handlers.ts CHANNELS)
  MARKETPLACE_AUTH_START: 'marketplace:auth:start',
  MARKETPLACE_AUTH_POLL: 'marketplace:auth:poll',
  MARKETPLACE_AUTH_SIGNED_IN: 'marketplace:auth:signed-in',
  MARKETPLACE_AUTH_USER: 'marketplace:auth:user',
  MARKETPLACE_AUTH_SIGN_OUT: 'marketplace:auth:sign-out',
  MARKETPLACE_INSTALL: 'marketplace:install',
  MARKETPLACE_RATE: 'marketplace:rate',
  MARKETPLACE_RATE_DELETE: 'marketplace:rate:delete',
  MARKETPLACE_THEME_LIKE: 'marketplace:theme:like',
  MARKETPLACE_REPORT: 'marketplace:report',
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
    // Mark/unmark a session flag (complete, priority, helpful, …).
    // Persists in conversation-index.json and rides the existing sync pipeline.
    setFlag: (sessionId: string, flag: string, value: boolean) =>
      ipcRenderer.invoke(IPC.SESSION_SET_FLAG, sessionId, flag, value),
  },
  on: {
    sessionCreated: (cb: (info: any) => void) => {
      const handler = (_e: IpcRendererEvent, info: any) => cb(info);
      ipcRenderer.on(IPC.SESSION_CREATED, handler);
      return handler;
    },
    sessionDestroyed: (cb: (id: string, exitCode: number) => void) => {
      // exitCode piped in so the chat reducer can classify this as a clean
      // exit vs. 'session-died'. Default to 0 when absent (older bridges).
      const handler = (_e: IpcRendererEvent, id: string, exitCode: number = 0) => cb(id, exitCode);
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
    // Pushed when a session's metadata changes (currently: complete flag)
    sessionMetaChanged: (cb: (sessionId: string, meta: { flag: string; value: boolean }) => void) => {
      const handler = (_e: IpcRendererEvent, sid: string, meta: any) => cb(sid, meta);
      ipcRenderer.on(IPC.SESSION_META_CHANGED, handler);
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
    getFeatured: (): Promise<any> => ipcRenderer.invoke(IPC.SKILLS_GET_FEATURED),
    // Decomposition v3 §9.9: integration badges for SkillDetail
    getIntegrationInfo: (id: string): Promise<any> => ipcRenderer.invoke(IPC.SKILLS_GET_INTEGRATION_INFO, id),
    // Decomposition v3 §9.10: onboarding helpers
    installMany: (ids: string[]): Promise<Array<{ id: string; status: string; error?: string }>> =>
      ipcRenderer.invoke(IPC.SKILLS_INSTALL_MANY, ids),
    applyOutputStyle: (styleId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.SKILLS_APPLY_OUTPUT_STYLE, styleId),
    // Phase 3b: update an already-installed plugin
    update: (id: string): Promise<any> => ipcRenderer.invoke(IPC.SKILLS_UPDATE, id),
  },
  // Phase 3: unified marketplace APIs (packages map, per-entry config)
  marketplace: {
    getPackages: (): Promise<Record<string, any>> => ipcRenderer.invoke(IPC.MARKETPLACE_GET_PACKAGES),
    getConfig: (id: string): Promise<Record<string, any>> => ipcRenderer.invoke(IPC.MARKETPLACE_GET_CONFIG, id),
    setConfig: (id: string, values: Record<string, any>): Promise<void> =>
      ipcRenderer.invoke(IPC.MARKETPLACE_SET_CONFIG, id, values),
    // Phase 4 — user-initiated cache bust.
    invalidateCache: (): Promise<void> => ipcRenderer.invoke(IPC.MARKETPLACE_INVALIDATE_CACHE),
  },
  // Marketplace redesign Phase 3 — integrations as a first-class content kind.
  // Scaffold only: list/status return real data from integrations.json, but
  // install/uninstall/configure are stubbed pending Google OAuth work.
  integrations: {
    list: (): Promise<any> => ipcRenderer.invoke(IPC.INTEGRATIONS_LIST),
    install: (slug: string): Promise<any> => ipcRenderer.invoke(IPC.INTEGRATIONS_INSTALL, slug),
    uninstall: (slug: string): Promise<any> => ipcRenderer.invoke(IPC.INTEGRATIONS_UNINSTALL, slug),
    status: (slug: string): Promise<any> => ipcRenderer.invoke(IPC.INTEGRATIONS_STATUS, slug),
    configure: (slug: string, settings: Record<string, any>): Promise<any> =>
      ipcRenderer.invoke(IPC.INTEGRATIONS_CONFIGURE, slug, settings),
  },
  // Marketplace sign-in (device-code OAuth flow) — token stays in main process.
  // start/poll wrap API calls and return ApiResult so the renderer can inspect
  // HTTP status codes across the contextBridge (structuredClone drops Error fields).
  // signedIn / user / signOut are pure local reads — no API call, no ApiResult wrapper.
  marketplaceAuth: {
    start: (): Promise<ApiResult<AuthStartResponse>> =>
      ipcRenderer.invoke(IPC.MARKETPLACE_AUTH_START),
    poll: (deviceCode: string): Promise<ApiResult<AuthPollResponse>> =>
      ipcRenderer.invoke(IPC.MARKETPLACE_AUTH_POLL, deviceCode),
    signedIn: (): Promise<boolean> =>
      ipcRenderer.invoke(IPC.MARKETPLACE_AUTH_SIGNED_IN),
    user: (): Promise<MarketplaceUser | null> =>
      ipcRenderer.invoke(IPC.MARKETPLACE_AUTH_USER),
    signOut: (): Promise<void> =>
      ipcRenderer.invoke(IPC.MARKETPLACE_AUTH_SIGN_OUT),
  },
  // Marketplace write endpoints — all return ApiResult so the renderer can
  // surface install-gate (403) vs. generic errors (Task 7+).
  marketplaceApi: {
    install: (pluginId: string): Promise<ApiResult<void>> =>
      ipcRenderer.invoke(IPC.MARKETPLACE_INSTALL, pluginId),
    rate: (input: PostRatingInput): Promise<ApiResult<{ hidden: boolean }>> =>
      ipcRenderer.invoke(IPC.MARKETPLACE_RATE, input),
    deleteRating: (pluginId: string): Promise<ApiResult<void>> =>
      ipcRenderer.invoke(IPC.MARKETPLACE_RATE_DELETE, pluginId),
    likeTheme: (themeId: string): Promise<ApiResult<{ liked: boolean }>> =>
      ipcRenderer.invoke(IPC.MARKETPLACE_THEME_LIKE, themeId),
    report: (input: { rating_user_id: string; rating_plugin_id: string; reason?: string }): Promise<ApiResult<void>> =>
      ipcRenderer.invoke(IPC.MARKETPLACE_REPORT, input),
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
    // Multi-window appearance sync: any window calling broadcast forwards its
    // change to every OTHER peer window so ThemeProvider can apply it without
    // reading from disk. onSync receives those forwards.
    broadcast: (prefs: Record<string, unknown>) => ipcRenderer.send(IPC.APPEARANCE_BROADCAST, prefs),
    onSync: (cb: (prefs: Record<string, unknown>) => void) => {
      const h = (_e: IpcRendererEvent, prefs: any) => cb(prefs);
      ipcRenderer.on(IPC.APPEARANCE_SYNC, h);
      return () => ipcRenderer.removeListener(IPC.APPEARANCE_SYNC, h);
    },
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
    // Restore from backup — directional, user-initiated pull
    restore: {
      listVersions: (backendId: string) =>
        ipcRenderer.invoke(IPC.SYNC_RESTORE_LIST_VERSIONS, backendId),
      preview: (opts: any) => ipcRenderer.invoke(IPC.SYNC_RESTORE_PREVIEW, opts),
      execute: (opts: any) => ipcRenderer.invoke(IPC.SYNC_RESTORE_EXECUTE, opts),
      listSnapshots: () => ipcRenderer.invoke(IPC.SYNC_RESTORE_LIST_SNAPSHOTS),
      undo: (snapshotId: string) => ipcRenderer.invoke(IPC.SYNC_RESTORE_UNDO, snapshotId),
      deleteSnapshot: (snapshotId: string) =>
        ipcRenderer.invoke(IPC.SYNC_RESTORE_DELETE_SNAPSHOT, snapshotId),
      probe: (backendId: string) => ipcRenderer.invoke(IPC.SYNC_RESTORE_PROBE, backendId),
      browseCategory: (backendId: string, category: string, versionRef: string) =>
        ipcRenderer.invoke(IPC.SYNC_RESTORE_BROWSE_URL, backendId, category, versionRef),
      // Subscribe to progress events for an in-flight restore. Returns an
      // unsubscribe function — callers MUST invoke it on unmount to avoid
      // leaking listeners across restore attempts.
      onProgress: (cb: (evt: any) => void) => {
        const handler = (_e: any, evt: any) => cb(evt);
        ipcRenderer.on(IPC.SYNC_RESTORE_PROGRESS, handler);
        return () => ipcRenderer.removeListener(IPC.SYNC_RESTORE_PROGRESS, handler);
      },
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
    // Hot-swaps the window + dock icon. Accepts a theme-asset:// URL or null
    // (null resets to the bundled default). Main validates the URL and silently
    // ignores anything outside the theme's own asset dir.
    setIcon: (url: string | null) => ipcRenderer.invoke(IPC.WINDOW_SET_ICON, url),
    // macOS-only: reposition the traffic lights so they sit inside the floating
    // header chrome. Pass null to restore the OS default. No-ops on Win/Linux.
    setTrafficLightPosition: (pos: { x: number; y: number } | null) =>
      ipcRenderer.invoke(IPC.WINDOW_SET_TRAFFIC_LIGHT_POS, pos),
    // Fullscreen state relay — used by renderer to adjust macOS traffic light padding
    onFullscreenChanged: (handler: (isFullscreen: boolean) => void) => {
      const wrapped = (_event: IpcRendererEvent, isFullscreen: boolean) => handler(isFullscreen);
      ipcRenderer.on('window:fullscreen-changed', wrapped);
      return () => ipcRenderer.removeListener('window:fullscreen-changed', wrapped);
    },
    // Returns this renderer's BrowserWindow webContents id — used by the detach
    // subsystem so a window can identify itself when resolving cross-window drops.
    getId: (): Promise<number> => ipcRenderer.invoke(IPC.WINDOW_GET_ID),
  },
  // Multi-window detach: drag a session pill to a new OS window, re-dock, etc.
  // Main owns a WindowRegistry (sessionId → windowId); per-session events route
  // only to the owning window. See docs/superpowers/specs/2026-04-12-drag-session-detach-window-design.md.
  detach: {
    // Subscriptions — main pushes these
    onDirectoryUpdated: (cb: (dir: any) => void) => {
      const h = (_e: IpcRendererEvent, dir: any) => cb(dir);
      ipcRenderer.on(IPC.WINDOW_DIRECTORY_UPDATED, h);
      return () => ipcRenderer.removeListener(IPC.WINDOW_DIRECTORY_UPDATED, h);
    },
    onLeaderChanged: (cb: (leaderId: number) => void) => {
      const h = (_e: IpcRendererEvent, id: number) => cb(id);
      ipcRenderer.on(IPC.WINDOW_LEADER_CHANGED, h);
      return () => ipcRenderer.removeListener(IPC.WINDOW_LEADER_CHANGED, h);
    },
    onOwnershipAcquired: (cb: (payload: any) => void) => {
      const h = (_e: IpcRendererEvent, p: any) => cb(p);
      ipcRenderer.on(IPC.SESSION_OWNERSHIP_ACQUIRED, h);
      return () => ipcRenderer.removeListener(IPC.SESSION_OWNERSHIP_ACQUIRED, h);
    },
    onOwnershipLost: (cb: (payload: any) => void) => {
      const h = (_e: IpcRendererEvent, p: any) => cb(p);
      ipcRenderer.on(IPC.SESSION_OWNERSHIP_LOST, h);
      return () => ipcRenderer.removeListener(IPC.SESSION_OWNERSHIP_LOST, h);
    },
    onCrossWindowCursor: (cb: (payload: { screenX: number; screenY: number }) => void) => {
      const h = (_e: IpcRendererEvent, p: any) => cb(p);
      ipcRenderer.on(IPC.CROSS_WINDOW_CURSOR, h);
      return () => ipcRenderer.removeListener(IPC.CROSS_WINDOW_CURSOR, h);
    },
    // Commands — renderer → main
    openDetached: (payload: { sessionId: string }) =>
      ipcRenderer.send(IPC.WINDOW_OPEN_DETACHED, payload),
    detachStart: (payload: { sessionId: string; screenX: number; screenY: number }) =>
      ipcRenderer.send(IPC.SESSION_DETACH_START, payload),
    // Chrome-style live tear-off. Spawns peer window mid-drag and returns its
    // webContents id so the caller can stream cursor positions to it.
    detachLive: (payload: { sessionId: string; screenX: number; screenY: number }): Promise<{ windowId: number }> =>
      ipcRenderer.invoke(IPC.SESSION_DETACH_LIVE, payload),
    dragWindowMove: (payload: { windowId: number; screenX: number; screenY: number }) =>
      ipcRenderer.send(IPC.SESSION_DRAG_WINDOW_MOVE, payload),
    dragStarted: (payload: { sessionId: string }) =>
      ipcRenderer.send(IPC.SESSION_DRAG_STARTED, payload),
    dragEnded: () => ipcRenderer.send(IPC.SESSION_DRAG_ENDED),
    dragDropped: (payload: { sessionId: string; targetWindowId: number; insertIndex: number }) =>
      ipcRenderer.send(IPC.SESSION_DRAG_DROPPED, payload),
    focusAndSwitch: (payload: { windowId: number; sessionId: string }) =>
      ipcRenderer.send(IPC.WINDOW_FOCUS_AND_SWITCH, payload),
    // Request/response — ask main which window's strip currently contains the cursor
    dropResolve: (): Promise<{ targetWindowId: number | null }> =>
      ipcRenderer.invoke(IPC.SESSION_DROP_RESOLVE),
    // Pull-style: new windows call this from their mount useEffect to avoid
    // racing the WINDOW_DIRECTORY_UPDATED push (which fires before React has
    // subscribed, so it's missed on first load).
    getDirectory: (): Promise<any> =>
      ipcRenderer.invoke(IPC.WINDOW_GET_DIRECTORY),
    // Fire-and-forget: main streams every historical TRANSCRIPT_EVENT for this
    // session back over the normal transcript:event channel. The reducer's
    // uuid-based dedup handles any overlap with live events.
    requestTranscriptReplay: (sessionId: string) =>
      ipcRenderer.send(IPC.TRANSCRIPT_REPLAY, { sessionId }),
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
      // Publish-lifecycle: derive button state from registry + gh PRs + local content hash
      resolvePublishState: (slug: string): Promise<any> =>
        ipcRenderer.invoke(IPC.THEME_MARKETPLACE_RESOLVE_PUBLISH_STATE, slug),
      // Manual "pull from GitHub now" — drops the 15-min cache and returns a fresh list
      refreshRegistry: (): Promise<any[]> =>
        ipcRenderer.invoke(IPC.THEME_MARKETPLACE_REFRESH_REGISTRY),
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
