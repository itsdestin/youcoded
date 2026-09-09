import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type { AuthStartResponse, AuthPollResponse, PostRatingInput } from '../renderer/state/marketplace-api-client';
import type { MarketplaceUser } from './marketplace-auth-store';
import type { ApiResult } from './marketplace-api-handlers';
import type { AttentionSummary, AttentionReport, PerformanceConfigSnapshot, SessionMetaResult } from '../shared/types';
// Type-only (erased at build), so the sandboxed preload still resolves nothing at
// runtime — same footing as the '../shared/types' line above.
import type { FirstRunState } from '../shared/first-run-types';
import type { ChatGptAccountStatus } from '../shared/chatgpt-types';

// Mirrored type — must match ChangelogResult in src/main/changelog-service.ts.
interface ChangelogIpcResult {
  markdown: string | null;
  entries: Array<{ version: string; date?: string; body: string }>;
  fromCache: boolean;
  error?: boolean;
}

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
  PTY_RAW_BYTES: 'pty:raw-bytes',
  HOOK_EVENT: 'hook:event',
  SESSION_RENAMED: 'session:renamed',
  // Plan 2b Task 10 — pushed when another device takes over a session's lease.
  SESSION_MOVED: 'session:moved',
  DIALOG_OPEN_FILE: 'dialog:open-file',
  DIALOG_OPEN_FOLDER: 'dialog:open-folder',
  DIALOG_OPEN_SOUND: 'dialog:open-sound',
  CLIPBOARD_SAVE_IMAGE: 'clipboard:save-image',
  STATUS_DATA: 'status:data',
  READ_TRANSCRIPT_META: 'transcript:read-meta',
  SKILLS_LIST: 'skills:list',
  COMMANDS_LIST: 'commands:list',
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
  INTEGRATIONS_CONNECT: 'integrations:connect',
  PLATFORM_GET: 'platform:get',
  // Phase 4 — skip 24h cache after /feature curation.
  MARKETPLACE_INVALIDATE_CACHE: 'marketplace:invalidate-cache',
  SKILLS_GET_INTEGRATION_INFO: 'skills:get-integration-info',
  SKILLS_INSTALL_MANY: 'skills:install-many',
  SKILLS_APPLY_OUTPUT_STYLE: 'skills:apply-output-style',
  OPEN_CHANGELOG: 'shell:open-changelog',
  UPDATE_CHANGELOG: 'update:changelog',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_CANCEL: 'update:cancel',
  UPDATE_LAUNCH: 'update:launch',
  UPDATE_PROGRESS: 'update:progress',
  UPDATE_GET_CACHED_DOWNLOAD: 'update:get-cached-download',
  OPEN_EXTERNAL: 'shell:open-external',
  SHOW_ITEM_IN_FOLDER: 'shell:show-item-in-folder',
  OPEN_PATH: 'shell:open-path',
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
  // Session tags + note (custom user tags, freeform note)
  SESSION_SET_TAG: 'session:set-tag',
  SESSION_SET_NOTE: 'session:set-note',
  SESSION_GET_META: 'session:get-meta',
  // Tag registry CRUD + change push
  TAGS_LIST: 'tags:list',
  TAGS_CREATE: 'tags:create',
  TAGS_UPDATE: 'tags:update',
  TAGS_DELETE: 'tags:delete',
  TAGS_CHANGED: 'tags:changed',
  // Folder switcher
  FOLDERS_LIST: 'folders:list',
  FOLDERS_ADD: 'folders:add',
  FOLDERS_REMOVE: 'folders:remove',
  FOLDERS_RENAME: 'folders:rename',
  // Local-only description on a saved folder — sibling of FOLDERS_RENAME. Preload
  // can't import shared/types.ts (sandboxed, no relative imports), so this literal
  // must stay byte-identical to the one in shared/types.ts — the parity test only
  // checks the CONSTANT NAME against ipc-handlers, not this literal against the
  // shared one, so a typo here would pass tests silently.
  FOLDERS_SET_DESCRIPTION: 'folders:set-description',
  // Theme system
  THEME_RELOAD: 'theme:reload',   // Main -> Renderer: a theme file changed
  THEME_LIST: 'theme:list',       // Renderer -> Main: get list of user theme slugs
  THEME_READ_FILE: 'theme:read-file', // Renderer -> Main: read a user theme JSON by slug
  THEME_WRITE_FILE: 'theme:write-file',
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
  MARKETPLACE_READ_COMPONENT: 'marketplace:read-component',
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
  // Fast mode + effort level — YouCoded-local state (Claude Code doesn't transcribe these)
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
  // Cross-device sync spaces (spec 2026-07-03) — distinct from the legacy sync:* above
  SYNC_SPACES_STATUS: 'syncspaces:status',
  SYNC_SPACES_ENABLE: 'syncspaces:enable',
  SYNC_SPACES_SYNC_NOW: 'syncspaces:sync-now',
  SYNC_SPACES_CREATE_PROJECT: 'syncspaces:create-project',
  SYNC_SPACES_IMPORT_PROJECT: 'syncspaces:import-project',
  SYNC_SPACES_RENAME_PROJECT: 'syncspaces:rename-project',
  // Synced project description (Task 3) — preload inlines its own IPC constants
  // because the sandboxed preload can't resolve relative imports.
  SYNC_SPACES_SET_PROJECT_DESCRIPTION: 'syncspaces:set-project-description',
  SYNC_SPACES_STOP_PROJECT: 'syncspaces:stop-project',
  // Conversation-lease takeover (Plan 2b Task 9) — inlined literals (preload can't import).
  SYNC_SPACES_LEASE_QUERY: 'syncspaces:lease-query',
  SYNC_SPACES_LEASE_TAKEOVER: 'syncspaces:lease-takeover',
  SYNC_SPACES_LEASE_FORCE: 'syncspaces:lease-force',
  // Device registry (Plan 2b spec §10a) — inlined literals (preload can't import).
  SYNC_SPACES_LIST_DEVICES: 'syncspaces:list-devices',
  SYNC_SPACES_RENAME_DEVICE: 'syncspaces:rename-device',
  SYNC_SPACES_REMOVE_DEVICE: 'syncspaces:remove-device',
  SYNC_SPACES_EVENT: 'syncspaces:event',
  // Connect-GitHub modal (device-flow auth) — inlined literals (preload can't import).
  GITHUB_STATUS: 'github:status',
  GITHUB_CONNECT_START: 'github:connect-start',
  GITHUB_CONNECT_CANCEL: 'github:connect-cancel',
  GITHUB_INSTALL_GH: 'github:install-gh',
  GITHUB_DISCONNECT: 'github:disconnect',
  GITHUB_CONNECT_DONE: 'github:connect-done',
  // Window detach / multi-window ownership (feature: drag session to new window)
  WINDOW_GET_ID: 'window:get-id',
  WINDOW_DIRECTORY_UPDATED: 'window:directory-updated',
  WINDOW_GET_DIRECTORY: 'window:get-directory',
  WINDOW_LEADER_CHANGED: 'window:leader-changed',
  WINDOW_OPEN_DETACHED: 'window:open-detached',
  WINDOW_FOCUS_AND_SWITCH: 'window:focus-and-switch',
  SESSION_OWNERSHIP_ACQUIRED: 'session:ownership-acquired',
  SESSION_OWNERSHIP_LOST: 'session:ownership-lost',
  DETACH_CLAIM_PENDING: 'detach:claim-pending',
  SESSION_REPLAY_LIVE_STATE: 'session:replay-live-state',
  SESSION_DETACH_START: 'session:detach-start',
  SESSION_DETACH_LIVE: 'session:detach-live',
  SESSION_DRAG_WINDOW_MOVE: 'session:drag-window-move',
  SESSION_DRAG_STARTED: 'session:drag-started',
  SESSION_DRAG_ENDED: 'session:drag-ended',
  SESSION_DRAG_DROPPED: 'session:drag-dropped',
  SESSION_DRAG_ADOPT: 'session:drag-adopt',
  SESSION_DROP_RESOLVE: 'session:drop-resolve',
  CROSS_WINDOW_CURSOR: 'session:cross-window-cursor',
  TRANSCRIPT_REPLAY: 'transcript:replay-from-start',
  TRANSCRIPT_PAGE: 'transcript:page',
  APPEARANCE_BROADCAST: 'appearance:broadcast',
  APPEARANCE_SYNC: 'appearance:sync',
  APPEARANCE_GET_FAVORITE_THEMES: 'appearance:get-favorite-themes',
  APPEARANCE_FAVORITE_THEME: 'appearance:favorite-theme',
  // Account (formerly marketplace auth) — byte-identical to marketplace-api-handlers.ts CHANNELS
  ACCOUNT_START: 'account:start',
  ACCOUNT_POLL: 'account:poll',
  ACCOUNT_SIGNED_IN: 'account:signed-in',
  ACCOUNT_USER: 'account:user',
  ACCOUNT_REFRESH: 'account:refresh',
  ACCOUNT_SIGN_OUT: 'account:sign-out',
  ACCOUNT_UPDATE_PROFILE: 'account:update-profile',
  ACCOUNT_SET_HANDLE: 'account:set-handle',
  ACCOUNT_DELETE: 'account:delete',
  ACCOUNT_EXPORT: 'account:export',
  // Social graph (accounts Phase 2) — byte-identical to social-handlers.ts CHANNELS
  SOCIAL_LOOKUP_HANDLE: 'social:lookup-handle',
  SOCIAL_SEND_REQUEST: 'social:send-request',
  SOCIAL_LIST_REQUESTS: 'social:list-requests',
  SOCIAL_ACCEPT_REQUEST: 'social:accept-request',
  SOCIAL_DECLINE_REQUEST: 'social:decline-request',
  SOCIAL_CANCEL_REQUEST: 'social:cancel-request',
  SOCIAL_LIST_FRIENDS: 'social:list-friends',
  SOCIAL_UNFRIEND: 'social:unfriend',
  SOCIAL_BLOCK: 'social:block',
  SOCIAL_UNBLOCK: 'social:unblock',
  SOCIAL_LIST_BLOCKS: 'social:list-blocks',
  // Presence socket (Task 6) — connect/disconnect express desired state, send
  // pushes one protocol message, and the main process relays every event back
  // on SOCIAL_PRESENCE_EVENT (a push channel, not a request-response handler).
  SOCIAL_PRESENCE_CONNECT: 'social:presence-connect',
  SOCIAL_PRESENCE_DISCONNECT: 'social:presence-disconnect',
  SOCIAL_PRESENCE_SEND: 'social:presence-send',
  SOCIAL_PRESENCE_EVENT: 'social:presence-event',
  // Marketplace write APIs — byte-identical to marketplace-api-handlers.ts CHANNELS
  MARKETPLACE_INSTALL: 'marketplace:install',
  MARKETPLACE_RATE: 'marketplace:rate',
  MARKETPLACE_RATE_DELETE: 'marketplace:rate:delete',
  MARKETPLACE_THUMB: 'marketplace:thumb',
  MARKETPLACE_THUMB_GET: 'marketplace:thumb:get',
  MARKETPLACE_COMMENT: 'marketplace:comment',
  MARKETPLACE_THEME_LIKE: 'marketplace:theme:like',
  MARKETPLACE_REPORT: 'marketplace:report',
  // Remote-access state sync — chat snapshot export and attention state relay
  CHAT_EXPORT_SNAPSHOT: 'chat:export-snapshot',
  CHAT_SNAPSHOT_RESPONSE: 'chat:snapshot-response',
  REMOTE_ATTENTION_CHANGED: 'remote:attention-changed',
  // Buddy floater (desktop-only MVP)
  BUDDY_SHOW: 'buddy:show',
  BUDDY_HIDE: 'buddy:hide',
  BUDDY_TOGGLE_CHAT: 'buddy:toggle-chat',
  BUDDY_SET_SESSION: 'buddy:set-session',
  BUDDY_SUBSCRIBE: 'buddy:subscribe',
  BUDDY_UNSUBSCRIBE: 'buddy:unsubscribe',
  BUDDY_GET_VIEWED_SESSION: 'buddy:get-viewed-session',
  BUDDY_MOVE_MASCOT: 'buddy:move-mascot',
  BUDDY_CAPTURE_DESKTOP: 'buddy:capture-desktop',
  BUDDY_ATTACH_FILE: 'buddy:attach-file',
  // ── Buddy upgrades (action bar, dismiss, dock/peek) ──
  BUDDY_DRAG_ENDED: 'buddy:drag-ended',
  BUDDY_OPEN_MAIN: 'buddy:open-main',
  BUDDY_DISMISS: 'buddy:dismiss',
  BUDDY_GET_STATUS: 'buddy:get-status',
  BUDDY_STATUS_CHANGED: 'buddy:status-changed',
  BUDDY_BAR_STATE: 'buddy:bar-state',
  BUDDY_MASCOT_STATE: 'buddy:mascot-state',
  BUDDY_CHAT_STATE: 'buddy:chat-state',
  // Linux Wayland overlay (Task 3+4). Inlined here like every other buddy
  // channel above — preload cannot import shared/types.ts.
  BUDDY_OVERLAY_READY: 'buddy:overlay-ready',
  BUDDY_OVERLAY_TOGGLE_CHAT: 'buddy:overlay-toggle-chat',
  BUDDY_OVERLAY_SET_INTERACTIVE: 'buddy:overlay-set-interactive',
  BUDDY_OVERLAY_PERSIST: 'buddy:overlay-persist',
  // Task 8: Settings' KDE keep-above toggle — invoke/handle, not fire-and-
  // forget, since it returns whether the KWin script actually ran.
  BUDDY_OVERLAY_KEEP_ABOVE: 'buddy:overlay-keep-above',
  // The Linux/KDE buddy helper. Kept byte-identical to shared/types.ts's copy —
  // preload cannot import that file (Electron sandbox), so the two maps are
  // duplicated on purpose and ipc-channels.test.ts is what stops them drifting.
  BUDDY_HELPER_STATUS: 'buddy:helper-status',
  BUDDY_INSTALL_HELPER: 'buddy:install-helper',
  BUDDY_REMOVE_HELPER: 'buddy:remove-helper',
  SESSION_FOCUS_REQUEST: 'session:focus-request',
  SESSION_ATTENTION_SUMMARY: 'session:attention-summary',
  ATTENTION_REPORT: 'attention:report',
  ATTENTION_GET_SUMMARY: 'attention:get-summary',
  // Settings → Development feature (bug report, contribute, known issues)
  DEV_LOG_TAIL: 'dev:log-tail',
  DEV_DIAGNOSTICS: 'dev:diagnostics',
  DEV_SUMMARIZE_ISSUE: 'dev:summarize-issue',
  DEV_SUBMIT_ISSUE: 'dev:submit-issue',
  DEV_INSTALL_WORKSPACE: 'dev:install-workspace',
  DEV_INSTALL_PROGRESS: 'dev:install-progress',
  DEV_OPEN_SESSION_IN: 'dev:open-session-in',
  // Anonymous analytics opt-out — read/write the boolean gate that
  // analytics-service consults on launch (Phase 6).
  ANALYTICS_GET_OPT_IN: 'analytics:get-opt-in',
  ANALYTICS_SET_OPT_IN: 'analytics:set-opt-in',
  // Performance / GPU settings. APP_RESTART is intentionally generic — not
  // 'performance:restart' — so future restart-required settings can reuse it.
  PERFORMANCE_GET_CONFIG: 'performance:get-config',
  PERFORMANCE_SET_CONFIG: 'performance:set-config',
  SYSTEM_NOTIFY_STACK_STATE: 'system:notify-stack-state',
  SYSTEM_BACK: 'system:back',
  APP_RESTART: 'app:restart',
  // ---- Native runtime Plan A (Phase 1): session I/O + provider management ----
  // Mirrors src/shared/types.ts — the sandboxed preload can't import it.
  // tests/ipc-channels.test.ts extracts BOTH full IPC blocks (anchored to the
  // `} as const;` terminator) and asserts value equality for every key the two
  // blocks share, so drift on these constants fails the test.
  NATIVE_SEND: 'native:send',
  // Task 11: cancel/edit a queued-but-not-yet-sent message.
  NATIVE_QUEUE_REMOVE: 'native:queue-remove',
  NATIVE_INTERRUPT: 'native:interrupt',
  // Stalled-turn Retry — fire-and-forget, same shape as interrupt above.
  NATIVE_RETRY: 'native:retry',
  NATIVE_COMPACT: 'native:compact',
  NATIVE_CLEAR: 'native:clear',
  NATIVE_INVOKE_SKILL: 'native:invoke-skill',
  NATIVE_SET_BINDING: 'native:set-binding',
  NATIVE_SET_PERMISSION_MODE: 'native:set-permission-mode',
  NATIVE_GET_PERMISSION_MODE: 'native:get-permission-mode',
  NATIVE_GET_STEP_GUARD: 'native:get-step-guard',
  NATIVE_SET_STEP_GUARD: 'native:set-step-guard',
  NATIVE_SESSIONS_LIST: 'native:sessions-list',
  NATIVE_KILL_SHELL: 'native:kill-shell',
  PROVIDER_LIST: 'provider:list',
  PROVIDER_UPSERT: 'provider:upsert',
  PROVIDER_REMOVE: 'provider:remove',
  PROVIDER_TEST: 'provider:test',
  PROVIDER_SET_KEY: 'provider:set-key',
  PROVIDER_CATALOG: 'provider:catalog',
  // Sign in with ChatGPT (backend design 2026-09-05 §5) — mirrors shared/types.ts.
  CHATGPT_STATUS: 'chatgpt:status',
  CHATGPT_SIGN_IN: 'chatgpt:sign-in',
  CHATGPT_CANCEL_SIGN_IN: 'chatgpt:cancel-sign-in',
  CHATGPT_SIGN_OUT: 'chatgpt:sign-out',
  // ---- Native runtime Plan B (Phase 1): local llama.cpp engine ----
  ENGINE_STATUS: 'engine:status',
  ENGINE_INSTALL: 'engine:install',
  ENGINE_RESTART: 'engine:restart',
  // Push events (no id): install progress + run-state transitions.
  ENGINE_INSTALL_PROGRESS: 'engine:install-progress',
  ENGINE_STATUS_CHANGED: 'engine:status-changed',
  // ---- Native runtime Plan C (Phase 1): model manager ----
  ENGINE_SET_BACKEND: 'engine:set-backend',
  ENGINE_SET_CONTEXT: 'engine:set-context',   // context-length knob (Task 9)
  ENGINE_SET_CONFIG: 'engine:set-config',     // one write for every engine-wide setting (2026-09-05)
  ENGINE_RUN_IN_TERMINAL: 'engine:run-in-terminal',  // plain-shell session + typed command
  ENGINE_PREREQS: 'engine:prereqs',           // faster-engine prerequisites (2026-09-05)
  MODELS_CURATED: 'models:curated',
  MODELS_SEARCH: 'models:search',
  MODELS_QUANTS: 'models:quants',
  MODELS_DOWNLOAD: 'models:download',
  MODELS_DOWNLOAD_CANCEL: 'models:download-cancel',
  MODELS_DOWNLOAD_PROGRESS: 'models:download-progress',  // push
  MODELS_DELETE: 'models:delete',
  MODELS_INSTALLED: 'models:installed',
  MODELS_RESUME: 'models:resume',
  // Per-model settings + vision (2026-09-05) — keep in sync with shared/types.ts.
  MODELS_SETTINGS: 'models:settings',
  MODELS_SET_SETTINGS: 'models:set-settings',
  MODELS_ADD_VISION: 'models:add-vision',
  ENDPOINTS_DETECT: 'endpoints:detect',
  // Model memory lifecycle (2026-07-14) — keep in sync with shared/types.ts.
  ENGINE_MODELS: 'engine:models',
  ENGINE_MODELS_CHANGED: 'engine:models-changed',
  NATIVE_MODEL_STATE: 'native:model-state',
  NATIVE_SHELL_EVENT: 'native:shell-event',
  MODELS_MEMORY_CHECK: 'models:memory-check',
  MODELS_LOAD: 'models:load',
  // ---- Voice prompting (design 2026-09-05) ----
  // Six things the composer can ask, one fire-and-forget audio stream, and one
  // push. VOICE_AUDIO is `send`, not `invoke`: ten slices a second, and a reply
  // per slice would cost more than the audio does.
  VOICE_STATUS: 'voice:status',
  VOICE_DOWNLOAD: 'voice:download',
  VOICE_START: 'voice:start',
  VOICE_STOP: 'voice:stop',
  VOICE_CANCEL: 'voice:cancel',
  VOICE_MIC_ACCESS: 'voice:mic-access',
  VOICE_AUDIO: 'voice:audio',
  VOICE_EVENT: 'voice:event',   // push
} as const;

// Strip the transport prefix Electron puts on a rejected invoke (see the
// `chatgpt` namespace for why), keeping the handler's own sentence. Anything
// that is not that exact shape is rethrown untouched.
const INVOKE_ERROR_PREFIX = /^Error invoking remote method '[^']*': (?:Error: )?/;
function unwrapInvokeError<T>(p: Promise<T>): Promise<T> {
  return p.catch((e: unknown) => {
    if (e instanceof Error && INVOKE_ERROR_PREFIX.test(e.message)) {
      throw new Error(e.message.replace(INVOKE_ERROR_PREFIX, ''));
    }
    throw e;
  });
}

contextBridge.exposeInMainWorld('claude', {
  // Dev-instance descriptor from `run-dev.sh --label` (YOUCODED_DEV_LABEL). The
  // StatusBar version pill shows it so concurrent dev instances are tellable
  // apart FROM INSIDE the window: the OS window title is set too, but KDE/Wayland
  // taskbars group by app id and render the app name, not the per-window caption,
  // so the title alone isn't reliably visible. null in the built app (env unset).
  // Same sandboxed process.env read the `native.supported` kill switch uses.
  devLabel: process.env.YOUCODED_DEV_LABEL?.trim() || null,
  session: {
    create: (opts: { name: string; cwd: string; skipPermissions: boolean; cols?: number; rows?: number; resumeSessionId?: string; provider?: 'claude' | 'native'; model?: string }) =>
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
    // Toggle a custom user tag on a session (persists in conversation-index.json).
    setTag: (sessionId: string, tagId: string, value: boolean) =>
      ipcRenderer.invoke(IPC.SESSION_SET_TAG, sessionId, tagId, value),
    // Set the freeform note on a session.
    setNote: (sessionId: string, note: string) =>
      ipcRenderer.invoke(IPC.SESSION_SET_NOTE, sessionId, note),
    // Read a session's applied tag ids + note (used by the in-session Tag chip).
    getMeta: (sessionId: string): Promise<SessionMetaResult> =>
      ipcRenderer.invoke(IPC.SESSION_GET_META, sessionId),
  },
  // Tag registry CRUD (custom user-defined tags shared across sessions).
  tags: {
    list: () => ipcRenderer.invoke('tags:list'),
    create: (label: string, color: string) => ipcRenderer.invoke('tags:create', label, color),
    update: (id: string, patch: object) => ipcRenderer.invoke('tags:update', id, patch),
    delete: (id: string) => ipcRenderer.invoke('tags:delete', id),
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
    // Shape parity with remote-shim — desktop never fires this push event
    // (Electron PTY emits pty:output strings instead). The stub keeps the
    // window.claude.on shape symmetric so an optional-chained call from a
    // future hook returns a benign no-op unsubscriber rather than crashing.
    ptyRawBytesForSession: (_sessionId: string, _cb: (data: string) => void) => {
      return () => {};
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
    // Plan 2b — another device took over this session's lease. Payload carries
    // the desktop sessionId + the new holder's device label, PLUS the resume
    // params (claudeSessionId / projectSlug / projectPath) so App.tsx's MovedGate
    // can offer "Resume on this device" directly. Returns the raw handler so
    // callers unsubscribe via off('session:moved', handler) — mirrors
    // sessionRenamed and stays parity with remote-shim.
    sessionMoved: (cb: (payload: { sessionId: string; device?: string; claudeSessionId?: string; projectSlug?: string; projectPath?: string }) => void) => {
      const handler = (_e: IpcRendererEvent, payload: any) => cb(payload);
      ipcRenderer.on(IPC.SESSION_MOVED, handler);
      return handler;
    },
    // Pushed when a session's metadata changes (flags, applied tags, or note).
    // Returns an UNSUBSCRIBE fn (not the raw handler) so callers can clean up via
    // `off()` — matches tagsChanged below; the leak fix for the tags hooks depends
    // on this being consistent across preload + remote-shim.
    sessionMetaChanged: (cb: (sessionId: string, meta: { flag: string; value: boolean }) => void) => {
      const handler = (_e: IpcRendererEvent, sid: string, meta: any) => cb(sid, meta);
      ipcRenderer.on(IPC.SESSION_META_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC.SESSION_META_CHANGED, handler);
    },
    // Pushed when the tag registry changes (create/update/delete) so open UIs refresh.
    tagsChanged: (cb: (payload: any) => void) => {
      const handler = (_e: any, payload: any) => cb(payload);
      ipcRenderer.on('tags:changed', handler);
      return () => ipcRenderer.removeListener('tags:changed', handler);
    },
    // Specialists 1c (Task 8) — one hire's ledger record changed (status,
    // model, a new note). Fired by nativeHost's 'specialists-event' listener
    // in ipc-handlers.ts, itself fed by DelegationLedger's own mutate()
    // chokepoint — never a direct emit per host method. Unsubscribe fn, same
    // as sessionMetaChanged/tagsChanged above (not the raw handler).
    specialistEvent: (cb: (e: any) => void) => {
      const handler = (_e: IpcRendererEvent, event: any) => cb(event);
      ipcRenderer.on('specialists:event', handler);
      return () => ipcRenderer.removeListener('specialists:event', handler);
    },
    // G-1: one background command's run record changed (status, tail, exit).
    // Fired by nativeHost's 'shell-event' listener in ipc-handlers.ts. Returns
    // the unsubscribe fn, same as specialistEvent.
    shellEvent: (cb: (e: any) => void) => {
      const handler = (_e: IpcRendererEvent, event: any) => cb(event);
      ipcRenderer.on('native:shell-event', handler);
      return () => ipcRenderer.removeListener('native:shell-event', handler);
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
  // Remote-access state sync — Electron-only surfaces (not in remote-shim.ts).
  // The remote server handles chat:hydrate via WebSocket directly; remote
  // browsers receive attentionMap via status:data. These bindings are only
  // needed on the desktop side of the snapshot export / attention relay pipeline.
  //
  // onChatExportSnapshot: main pushes a requestId; renderer replies via sendChatSnapshotResponse.
  // sendChatSnapshotResponse: renderer→main reply carrying the serialized chat state.
  // fireRemoteAttentionChanged: renderer→main fire when attentionState diffs (Task 8).
  onChatExportSnapshot: (cb: (requestId: string) => void) => {
    const handler = (_e: IpcRendererEvent, requestId: string) => cb(requestId);
    ipcRenderer.on(IPC.CHAT_EXPORT_SNAPSHOT, handler);
    return () => ipcRenderer.off(IPC.CHAT_EXPORT_SNAPSHOT, handler);
  },
  sendChatSnapshotResponse: (payload: { requestId: string; snapshot: unknown }) =>
    ipcRenderer.send(IPC.CHAT_SNAPSHOT_RESPONSE, payload),
  fireRemoteAttentionChanged: (payload: { sessionId: string; state: string }) =>
    ipcRenderer.send(IPC.REMOTE_ATTENTION_CHANGED, payload),
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
  commands: {
    list: (): Promise<any[]> => ipcRenderer.invoke(IPC.COMMANDS_LIST),
  },
  // Phase 3: unified marketplace APIs (packages map, per-entry config)
  marketplace: {
    getPackages: (): Promise<Record<string, any>> => ipcRenderer.invoke(IPC.MARKETPLACE_GET_PACKAGES),
    getConfig: (id: string): Promise<Record<string, any>> => ipcRenderer.invoke(IPC.MARKETPLACE_GET_CONFIG, id),
    setConfig: (id: string, values: Record<string, any>): Promise<void> =>
      ipcRenderer.invoke(IPC.MARKETPLACE_SET_CONFIG, id, values),
    // Phase 4 — user-initiated cache bust.
    invalidateCache: (): Promise<void> => ipcRenderer.invoke(IPC.MARKETPLACE_INVALIDATE_CACHE),
    // In-app file viewer — returns { content, source, path } or { error }.
    readComponent: (args: { pluginId: string; kind: 'skill' | 'command' | 'agent'; name: string }): Promise<any> =>
      ipcRenderer.invoke(IPC.MARKETPLACE_READ_COMPONENT, args),
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
    connect: (slug: string): Promise<any> => ipcRenderer.invoke(IPC.INTEGRATIONS_CONNECT, slug),
  },
  // Returns the raw process.platform code so the renderer can gate UI (e.g.
  // hide Install buttons on macOS-only integrations when running on Windows).
  getPlatform: (): Promise<'darwin' | 'win32' | 'linux' | 'android'> =>
    ipcRenderer.invoke(IPC.PLATFORM_GET),
  // FACTS about the host windowing system, read once at preload time. Pure
  // data — the decision that consumes it lives in renderer/session-drag-model.ts,
  // so the rule ("which drag model") stays testable without a live Electron.
  //
  // Synchronous on purpose: the session strip has to choose a tear-off model in
  // the middle of a pointermove, where awaiting a round-trip would mean the
  // first drag after launch silently used the wrong one. Preload must not name
  // a model itself — session-drag-model.test.ts pins that.
  platformFacts: {
    platform: process.platform as string,
    // Wayland vs X11 decides whether window positions and the cursor's screen
    // position are readable at all — on Wayland every such API returns zero.
    wayland: !!process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland',
  },
  // YouCoded account (device-code OAuth) — token stays in main process.
  // start/poll/updateProfile/setHandle/deleteAccount wrap API calls and return
  // ApiResult so the renderer can inspect HTTP status codes across the contextBridge
  // (structuredClone drops Error fields). signedIn is a pure local read; user may
  // lazily heal via /auth/me; signOut best-effort revokes the session server-side
  // before the local clear. None of those three wrap in ApiResult.
  account: {
    start: (): Promise<ApiResult<AuthStartResponse>> =>
      ipcRenderer.invoke(IPC.ACCOUNT_START),
    poll: (deviceCode: string): Promise<ApiResult<AuthPollResponse>> =>
      ipcRenderer.invoke(IPC.ACCOUNT_POLL, deviceCode),
    signedIn: (): Promise<boolean> =>
      ipcRenderer.invoke(IPC.ACCOUNT_SIGNED_IN),
    user: (): Promise<MarketplaceUser | null> =>
      ipcRenderer.invoke(IPC.ACCOUNT_USER),
    // Force a /auth/me round-trip and return the fresh profile (null if signed
    // out or 401-cleared). No ApiResult wrapper — same raw shape as user().
    refresh: (): Promise<MarketplaceUser | null> =>
      ipcRenderer.invoke(IPC.ACCOUNT_REFRESH),
    signOut: (): Promise<void> =>
      ipcRenderer.invoke(IPC.ACCOUNT_SIGN_OUT),
    updateProfile: (displayName: string): Promise<ApiResult<{ display_name: string }>> =>
      ipcRenderer.invoke(IPC.ACCOUNT_UPDATE_PROFILE, displayName),
    setHandle: (handle: string): Promise<ApiResult<{ handle: string }>> =>
      ipcRenderer.invoke(IPC.ACCOUNT_SET_HANDLE, handle),
    deleteAccount: (): Promise<ApiResult<void>> =>
      ipcRenderer.invoke(IPC.ACCOUNT_DELETE),
    // Export all account data. Resolves to { path } on save, { canceled: true }
    // on cancel, or { ok:false, status, error } on fetch failure — NOT ApiResult.
    exportData: (): Promise<{ path: string } | { canceled: true } | { ok: false; status: number; error: string }> =>
      ipcRenderer.invoke(IPC.ACCOUNT_EXPORT),
  },
  // Social graph (accounts Phase 2) — friends / requests / blocks. Every method
  // returns ApiResult so the renderer can read .status (404 unknown/blocked
  // handle, 429 caps, 400 self-request). Args are positional to match the
  // ipcMain.handle signatures in social-handlers.ts.
  social: {
    lookupHandle: (handle: string): Promise<ApiResult<unknown>> =>
      ipcRenderer.invoke(IPC.SOCIAL_LOOKUP_HANDLE, handle),
    sendRequest: (handle: string): Promise<ApiResult<unknown>> =>
      ipcRenderer.invoke(IPC.SOCIAL_SEND_REQUEST, handle),
    listRequests: (): Promise<ApiResult<unknown>> =>
      ipcRenderer.invoke(IPC.SOCIAL_LIST_REQUESTS),
    acceptRequest: (id: string): Promise<ApiResult<unknown>> =>
      ipcRenderer.invoke(IPC.SOCIAL_ACCEPT_REQUEST, id),
    declineRequest: (id: string): Promise<ApiResult<unknown>> =>
      ipcRenderer.invoke(IPC.SOCIAL_DECLINE_REQUEST, id),
    cancelRequest: (id: string): Promise<ApiResult<unknown>> =>
      ipcRenderer.invoke(IPC.SOCIAL_CANCEL_REQUEST, id),
    listFriends: (): Promise<ApiResult<unknown>> =>
      ipcRenderer.invoke(IPC.SOCIAL_LIST_FRIENDS),
    unfriend: (userId: string): Promise<ApiResult<unknown>> =>
      ipcRenderer.invoke(IPC.SOCIAL_UNFRIEND, userId),
    block: (userId: string): Promise<ApiResult<unknown>> =>
      ipcRenderer.invoke(IPC.SOCIAL_BLOCK, userId),
    unblock: (userId: string): Promise<ApiResult<unknown>> =>
      ipcRenderer.invoke(IPC.SOCIAL_UNBLOCK, userId),
    listBlocks: (): Promise<ApiResult<unknown>> =>
      ipcRenderer.invoke(IPC.SOCIAL_LIST_BLOCKS),
    // Presence socket (Task 6). connect/disconnect/send return { ok: true };
    // all real data arrives asynchronously via onPresenceEvent. message is
    // passed positionally (matches the ipcMain.handle signature).
    presenceConnect: (): Promise<{ ok: true }> =>
      ipcRenderer.invoke(IPC.SOCIAL_PRESENCE_CONNECT),
    presenceDisconnect: (): Promise<{ ok: true }> =>
      ipcRenderer.invoke(IPC.SOCIAL_PRESENCE_DISCONNECT),
    // presenceSend returns an honest receipt: { ok:false, status:0, message }
    // when no socket is connected (the frame would otherwise silently drop).
    presenceSend: (message: Record<string, unknown>): Promise<{ ok: true } | { ok: false; status: number; message: string }> =>
      ipcRenderer.invoke(IPC.SOCIAL_PRESENCE_SEND, message),
    // Subscribe to relayed presence events (server frames + synthetic
    // connection-state events). Returns an unsubscribe that removes the listener
    // — same pattern as onChatExportSnapshot above.
    onPresenceEvent: (cb: (ev: Record<string, unknown>) => void) => {
      const handler = (_e: IpcRendererEvent, ev: Record<string, unknown>) => cb(ev);
      ipcRenderer.on(IPC.SOCIAL_PRESENCE_EVENT, handler);
      return () => ipcRenderer.off(IPC.SOCIAL_PRESENCE_EVENT, handler);
    },
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
    thumb: (input: { plugin_id: string; value: 'up' | 'down' | null }): Promise<ApiResult<{ vote: 'up' | 'down' | null; thumbs_up: number; thumbs_down: number }>> =>
      ipcRenderer.invoke(IPC.MARKETPLACE_THUMB, input),
    myThumb: (pluginId: string): Promise<ApiResult<{ vote: 'up' | 'down' | null; thumbs_up: number; thumbs_down: number }>> =>
      ipcRenderer.invoke(IPC.MARKETPLACE_THUMB_GET, pluginId),
    comment: (input: { plugin_id: string; text: string }): Promise<ApiResult<{ id: string; hidden: boolean }>> =>
      ipcRenderer.invoke(IPC.MARKETPLACE_COMMENT, input),
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
    // Reveal a file in the OS file manager (Finder / Explorer / Files).
    showItemInFolder: (filePath: string): Promise<void> =>
      ipcRenderer.invoke(IPC.SHOW_ITEM_IN_FOLDER, filePath),
    // Open a local file with the OS default app (HTML→browser, .docx→Word, …).
    // Returns the empty string on success, or an error message on failure.
    openPath: (filePath: string): Promise<string> =>
      ipcRenderer.invoke(IPC.OPEN_PATH, filePath),
  },
  update: {
    changelog: (opts: { forceRefresh: boolean }): Promise<ChangelogIpcResult> =>
      ipcRenderer.invoke(IPC.UPDATE_CHANGELOG, opts),
    download: () => ipcRenderer.invoke(IPC.UPDATE_DOWNLOAD),
    cancel: (jobId: string) => ipcRenderer.invoke(IPC.UPDATE_CANCEL, { jobId }),
    launch: (jobId: string, filePath: string) => ipcRenderer.invoke(IPC.UPDATE_LAUNCH, { jobId, filePath }),
    getCachedDownload: (version: string) => ipcRenderer.invoke(IPC.UPDATE_GET_CACHED_DOWNLOAD, { version }),
    onProgress: (handler: (ev: { jobId: string; bytesReceived: number; bytesTotal: number; percent: number }) => void) => {
      const wrap = (_event: unknown, ev: any) => handler(ev);
      ipcRenderer.on(IPC.UPDATE_PROGRESS, wrap);
      return () => ipcRenderer.removeListener(IPC.UPDATE_PROGRESS, wrap);
    },
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
    favoriteTheme: (slug: string, favorited: boolean): Promise<string[]> =>
      ipcRenderer.invoke(IPC.APPEARANCE_FAVORITE_THEME, slug, favorited),
    getFavoriteThemes: (): Promise<string[]> =>
      ipcRenderer.invoke(IPC.APPEARANCE_GET_FAVORITE_THEMES),
  },
  defaults: {
    get: (): Promise<{ skipPermissions: boolean; model: string; projectFolder: string }> =>
      ipcRenderer.invoke(IPC.DEFAULTS_GET),
    set: (updates: Partial<{ skipPermissions: boolean; model: string; projectFolder: string }>): Promise<any> =>
      ipcRenderer.invoke(IPC.DEFAULTS_SET, updates),
  },
  // Anonymous analytics opt-out — read/write the gate that analytics-service
  // checks on launch. Default state is ON; users flip from About → Privacy.
  analytics: {
    getOptIn: (): Promise<boolean> => ipcRenderer.invoke(IPC.ANALYTICS_GET_OPT_IN),
    setOptIn: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.ANALYTICS_SET_OPT_IN, enabled),
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
    setDescription: (folderPath: string, description: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.FOLDERS_SET_DESCRIPTION, folderPath, description),
  },
  // Settings → Development feature (bug report, contribute, known issues)
  dev: {
    logTail: (maxLines: number) =>
      ipcRenderer.invoke(IPC.DEV_LOG_TAIL, maxLines),
    diagnostics: (): Promise<string> =>
      ipcRenderer.invoke(IPC.DEV_DIAGNOSTICS),
    summarizeIssue: (args: { kind: 'bug' | 'feature'; description: string; log?: string }) =>
      ipcRenderer.invoke(IPC.DEV_SUMMARIZE_ISSUE, args),
    submitIssue: (args: { kind: 'bug' | 'feature'; title: string; summary: string; description: string; log?: string; label: 'bug' | 'enhancement' }) =>
      ipcRenderer.invoke(IPC.DEV_SUBMIT_ISSUE, args),
    installWorkspace: () =>
      ipcRenderer.invoke(IPC.DEV_INSTALL_WORKSPACE),
    onInstallProgress: (cb: (line: string) => void) => {
      const listener = (_e: unknown, line: string) => cb(line);
      ipcRenderer.on(IPC.DEV_INSTALL_PROGRESS, listener);
      return () => ipcRenderer.removeListener(IPC.DEV_INSTALL_PROGRESS, listener);
    },
    openSessionIn: (args: { cwd: string; initialInput?: string }) =>
      ipcRenderer.invoke(IPC.DEV_OPEN_SESSION_IN, args),
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
  // Cross-device sync spaces (spec 2026-07-03) — the new folder-based sync
  // engine. Kept as its own namespace so it never entangles with the legacy
  // sync.* backup API above.
  syncSpaces: {
    status: () => ipcRenderer.invoke(IPC.SYNC_SPACES_STATUS),
    enable: (enabled: boolean) => ipcRenderer.invoke(IPC.SYNC_SPACES_ENABLE, enabled),
    // Optional spaceId narrows to one space (Project View "Sync now"); omit for all.
    syncNow: (spaceId?: string) => ipcRenderer.invoke(IPC.SYNC_SPACES_SYNC_NOW, spaceId),
    createProject: (name: string) => ipcRenderer.invoke(IPC.SYNC_SPACES_CREATE_PROJECT, name),
    // Spec §3 import: move an existing folder into ~/YouCoded/Projects/<name>.
    importProject: (sourcePath: string, name: string) =>
      ipcRenderer.invoke(IPC.SYNC_SPACES_IMPORT_PROJECT, sourcePath, name),
    // Cross-device rename (display-name only) + stop-syncing (2026-07-12).
    renameProject: (name: string, displayName: string) =>
      ipcRenderer.invoke(IPC.SYNC_SPACES_RENAME_PROJECT, { name, displayName }),
    stopProject: (name: string) =>
      ipcRenderer.invoke(IPC.SYNC_SPACES_STOP_PROJECT, { name }),
    // Synced project description (Task 3) — payload-object shape, same convention
    // as renameProject above.
    setProjectDescription: (name: string, description: string) =>
      ipcRenderer.invoke(IPC.SYNC_SPACES_SET_PROJECT_DESCRIPTION, { name, description }),
    // Conversation-lease takeover (Plan 2b Task 9). The Resume Browser calls
    // leaseQuery before resuming a store-backed row; if held elsewhere it offers
    // leaseTakeover (ask-hand-off), falling back to leaseForce on timeout.
    leaseQuery: (claudeSessionId: string) =>
      ipcRenderer.invoke(IPC.SYNC_SPACES_LEASE_QUERY, { claudeSessionId }),
    leaseTakeover: (claudeSessionId: string) =>
      ipcRenderer.invoke(IPC.SYNC_SPACES_LEASE_TAKEOVER, { claudeSessionId }),
    leaseForce: (claudeSessionId: string) =>
      ipcRenderer.invoke(IPC.SYNC_SPACES_LEASE_FORCE, { claudeSessionId }),
    // Device registry (Plan 2b spec §10a): the "Your devices" list marks the
    // current machine with self:true; renameDevice sets a friendly label.
    listDevices: () => ipcRenderer.invoke(IPC.SYNC_SPACES_LIST_DEVICES),
    renameDevice: (id: string, name: string) =>
      ipcRenderer.invoke(IPC.SYNC_SPACES_RENAME_DEVICE, { id, name }),
    // removeDevice forgets a row whose device is gone. A LIVE device re-registers
    // itself on its next launch — that's intended, not a bug.
    removeDevice: (id: string) =>
      ipcRenderer.invoke(IPC.SYNC_SPACES_REMOVE_DEVICE, { id }),
    // Returns an unsubscribe function — callers MUST invoke it on unmount to
    // avoid leaking listeners across mounts.
    onEvent: (cb: (e: unknown) => void) => {
      const listener = (_: unknown, e: unknown) => cb(e);
      ipcRenderer.on(IPC.SYNC_SPACES_EVENT, listener);
      return () => ipcRenderer.removeListener(IPC.SYNC_SPACES_EVENT, listener);
    },
  },
  // Connect-GitHub modal (device-flow auth). All the real work happens in the
  // main process (github-auth.ts + github-connect.ts); this namespace just relays
  // requests and the connect-done push event. The access token NEVER crosses this
  // boundary — only the public status/login/error fields do.
  github: {
    status: () => ipcRenderer.invoke(IPC.GITHUB_STATUS),
    // Returns {userCode, verificationUri, expiresAt} AND begins main-side polling;
    // completion arrives via onConnectDone below.
    connectStart: () => ipcRenderer.invoke(IPC.GITHUB_CONNECT_START),
    connectCancel: () => ipcRenderer.invoke(IPC.GITHUB_CONNECT_CANCEL),
    installGh: () => ipcRenderer.invoke(IPC.GITHUB_INSTALL_GH),
    // Deletes the app's stored token (Settings → GitHub → Disconnect). Does NOT
    // touch a gh CLI login — the app doesn't own that credential.
    disconnect: () => ipcRenderer.invoke(IPC.GITHUB_DISCONNECT),
    // Push subscription — returns an unsubscribe function (callers MUST invoke it
    // on unmount to avoid leaking listeners across modal open/close cycles).
    onConnectDone: (cb: (payload: { ok: boolean; login?: string; error?: string }) => void) => {
      const handler = (_e: IpcRendererEvent, payload: any) => cb(payload);
      ipcRenderer.on(IPC.GITHUB_CONNECT_DONE, handler);
      return () => ipcRenderer.removeListener(IPC.GITHUB_CONNECT_DONE, handler);
    },
  },
  getFavorites: () => ipcRenderer.invoke('favorites:get'),
  setFavorites: (favorites: string[]) => ipcRenderer.invoke('favorites:set', favorites),
  getIncognito: () => ipcRenderer.invoke('game:getIncognito'),
  setIncognito: (incognito: boolean) => ipcRenderer.invoke('game:setIncognito', incognito),
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
    // Sent by the window that RECEIVED a browser-drag drop (Linux/Wayland —
    // session-drag-model.ts). It names only the session:
    // main resolves the source from the WindowRegistry, so a forged drop can
    // never move a session the sender was not entitled to move.
    dragAdopt: (payload: { sessionId: string }) =>
      ipcRenderer.send(IPC.SESSION_DRAG_ADOPT, payload),
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
    // Pull the ownership handoffs main queued while this window was booting.
    // Called once from App's mount effect, right after onOwnershipAcquired is
    // subscribed — a push that lands before that subscription is DROPPED by
    // Electron, not queued, which is why the pull exists.
    claimPending: (): Promise<any[]> =>
      ipcRenderer.invoke(IPC.DETACH_CLAIM_PENDING),
    // Re-send the session state that exists only in main's memory (open
    // permission asks, specialist + background-shell run records, and the
    // replay-complete marker). Awaited AFTER the history page lands, because
    // the marker reaps tool cards the page left 'running' and must not run
    // before those cards exist.
    replayLiveState: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.SESSION_REPLAY_LIVE_STATE, { sessionId }),
    // Perf cycle 2: request/response, unlike the fire-and-forget replay above.
    // Returns ONE page of history (newest when beforeCursor is null, else the
    // page immediately older than the cursor) so opening a huge conversation
    // renders ~30 turns instead of thousands.
    requestTranscriptPage: (req: { sessionId: string; beforeCursor: unknown; claudeSessionId?: string; projectSlug?: string }) =>
      ipcRenderer.invoke(IPC.TRANSCRIPT_PAGE, req),
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
    // Widened from 'oauth' | 'apikey' (backend design 2026-09-05 §5): the
    // approved first-run card has a "Sign in with ChatGPT" button and an
    // OpenRouter one, and main.ts's two FIRST_RUN_START_AUTH handlers branch on
    // the mode. 'none' is in the union only because it IS FirstRunState's; main
    // ignores it.
    startAuth: (mode: FirstRunState['authMode']): Promise<void> =>
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
  buddy: {
    show: () => ipcRenderer.invoke(IPC.BUDDY_SHOW),
    hide: () => ipcRenderer.invoke(IPC.BUDDY_HIDE),
    toggleChat: () => ipcRenderer.invoke(IPC.BUDDY_TOGGLE_CHAT),
    setSession: (sessionId: string) => ipcRenderer.invoke(IPC.BUDDY_SET_SESSION, sessionId),
    subscribe: (sessionId: string) => ipcRenderer.invoke(IPC.BUDDY_SUBSCRIBE, sessionId),
    unsubscribe: (sessionId: string) => ipcRenderer.invoke(IPC.BUDDY_UNSUBSCRIBE, sessionId),
    getViewedSession: () => ipcRenderer.invoke(IPC.BUDDY_GET_VIEWED_SESSION),
    // Fire-and-forget: pointer drag fires ~60 events/sec; invoke() round-trips
    // would starve the renderer. Main clamps target to visible workArea.
    moveMascot: (target: { localDx: number; localDy: number }) => ipcRenderer.send(IPC.BUDDY_MOVE_MASCOT, target),
    onAttentionSummary: (cb: (summary: AttentionSummary) => void) => {
      const listener = (_: unknown, summary: AttentionSummary) => cb(summary);
      ipcRenderer.on(IPC.SESSION_ATTENTION_SUMMARY, listener);
      return () => ipcRenderer.removeListener(IPC.SESSION_ATTENTION_SUMMARY, listener);
    },
    // Capture-icon renderer invokes this. Main hides the three buddy windows,
    // captures the screen the mascot sits on, saves the PNG to temp, then
    // pushes the path to the chat renderer on BUDDY_ATTACH_FILE. Returns
    // the path for renderers that want to await success, but the chat side
    // picks it up via the listener below — don't thread the path through
    // window-to-window IPC by hand.
    captureDesktop: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC.BUDDY_CAPTURE_DESKTOP),
    // Chat renderer subscribes to receive file paths that should be added
    // as attachments (e.g. desktop screenshots). InputBar listens on
    // window 'buddy:attach-file' CustomEvent so we re-emit from here.
    onAttachFile: (cb: (filePath: string) => void) => {
      const listener = (_: unknown, filePath: string) => cb(filePath);
      ipcRenderer.on(IPC.BUDDY_ATTACH_FILE, listener);
      return () => ipcRenderer.removeListener(IPC.BUDDY_ATTACH_FILE, listener);
    },
    // ── Buddy upgrades ──
    dragEnded: () => ipcRenderer.send(IPC.BUDDY_DRAG_ENDED),
    openMain: (): Promise<void> => ipcRenderer.invoke(IPC.BUDDY_OPEN_MAIN),
    dismiss: (): Promise<void> => ipcRenderer.invoke(IPC.BUDDY_DISMISS),
    // Fix: keepAbove rides along on getStatus() (Task 8) rather than a new
    // getter channel — main's BUDDY_GET_STATUS handler merges it in from
    // the persisted positions file, so this type just widens to match.
    getStatus: (): Promise<{ dismissed: boolean; visible: boolean; keepAbove?: boolean }> =>
      ipcRenderer.invoke(IPC.BUDDY_GET_STATUS),
    onStatusChanged: (cb: (s: { dismissed: boolean; visible: boolean }) => void) => {
      const listener = (_: unknown, s: { dismissed: boolean; visible: boolean }) => cb(s);
      ipcRenderer.on(IPC.BUDDY_STATUS_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC.BUDDY_STATUS_CHANGED, listener);
    },
    onBarState: (cb: (s: { visible: boolean }) => void) => {
      const listener = (_: unknown, s: { visible: boolean }) => cb(s);
      ipcRenderer.on(IPC.BUDDY_BAR_STATE, listener);
      return () => ipcRenderer.removeListener(IPC.BUDDY_BAR_STATE, listener);
    },
    onMascotState: (cb: (s: { mode: 'free' | 'docked' | 'peeking'; edge: string | null }) => void) => {
      const listener = (_: unknown, s: { mode: 'free' | 'docked' | 'peeking'; edge: string | null }) => cb(s);
      ipcRenderer.on(IPC.BUDDY_MASCOT_STATE, listener);
      return () => ipcRenderer.removeListener(IPC.BUDDY_MASCOT_STATE, listener);
    },
    onChatState: (cb: (s: { visible: boolean }) => void) => {
      const listener = (_: unknown, s: { visible: boolean }) => cb(s);
      ipcRenderer.on(IPC.BUDDY_CHAT_STATE, listener);
      return () => ipcRenderer.removeListener(IPC.BUDDY_CHAT_STATE, listener);
    },
    onFocusSession: (cb: (sessionId: string) => void) => {
      const listener = (_: unknown, sessionId: string) => cb(sessionId);
      ipcRenderer.on(IPC.SESSION_FOCUS_REQUEST, listener);
      return () => ipcRenderer.removeListener(IPC.SESSION_FOCUS_REQUEST, listener);
    },
    // ── Linux Wayland overlay (Task 3+4) ──
    // WHY invoke (pull), not an on() push: a did-finish-load push raced
    // React's mount and got dropped — see BuddyApi.overlayReady's WHY in
    // shared/types.ts. One-shot boot fetch, not a hot path.
    overlayReady: (): Promise<{
      workArea: { x: number; y: number; width: number; height: number };
      mascot: { x: number; y: number } | null;
      dock: string | null;
    } | null> => ipcRenderer.invoke(IPC.BUDDY_OVERLAY_READY),
    onOverlayToggleChat: (cb: () => void) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.BUDDY_OVERLAY_TOGGLE_CHAT, listener);
      return () => ipcRenderer.removeListener(IPC.BUDDY_OVERLAY_TOGGLE_CHAT, listener);
    },
    // Fire-and-forget, hover-hot path (mousemove-driven hit testing) — same
    // reasoning as moveMascot above: an invoke() round-trip would starve it.
    overlaySetInteractive: (interactive: boolean) =>
      ipcRenderer.send(IPC.BUDDY_OVERLAY_SET_INTERACTIVE, { interactive }),
    overlayPersist: (state: { mascot: { x: number; y: number }; dock: string | null }) =>
      ipcRenderer.send(IPC.BUDDY_OVERLAY_PERSIST, state),
    // Task 8: Settings' KDE keep-above toggle. invoke/handle (not send) —
    // this is a rare, user-driven click, not a hover-hot path. The toggle
    // itself is a saved preference (see BuddyApi.setKeepAbove's WHY comment
    // in shared/types.ts) — the resolved boolean here reports only whether
    // the KWin apply actually ran just now, used by Settings for an inline
    // "couldn't reach KWin" hint, not to render the toggle's own state.
    setKeepAbove: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke(IPC.BUDDY_OVERLAY_KEEP_ABOVE, enabled),
    // ── The Linux/KDE buddy helper (design §4) ──
    //
    // `needed` is the fact that decides whether ANY of this UI appears: it is
    // true only where the app genuinely cannot move its own windows. It is NOT
    // "is this Linux" — the same binary on the same KDE desktop reports
    // Wayland from every environment variable while its windows are actually
    // X11-backed and move perfectly well (probe Round 7), and a user in that
    // state must keep the buddy they already have.
    //
    // `installed` is asked freshly every time rather than cached in the
    // renderer: the user can switch the script off in KDE's own System
    // Settings mid-session, and a stale "installed" would leave the buddy
    // switched on and unable to move.
    helperStatus: (): Promise<{ needed: boolean; supported: boolean; installed: boolean; reason?: string }> =>
      ipcRenderer.invoke(IPC.BUDDY_HELPER_STATUS),
    installHelper: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.BUDDY_INSTALL_HELPER),
    // The undo half (decide-uninstall#D-1). The consent card can no longer
    // promise the helper leaves when YouCoded is uninstalled — the AppImage
    // build has no uninstall step — so removal is a control the user owns.
    removeHelper: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.BUDDY_REMOVE_HELPER),
  },
  // Renderer pushes per-session attention state to main whenever the chat
  // reducer's ATTENTION_STATE_CHANGED fires. Main aggregates across all windows
  // and broadcasts a global AttentionSummary to buddy subscribers.
  attention: {
    report: (payload: AttentionReport) => ipcRenderer.send(IPC.ATTENTION_REPORT, payload),
    // Pull-style snapshot of that same aggregate. The push channel
    // (buddy.onAttentionSummary, which every window may subscribe to) only
    // fires on change, so a window that opens while a peer session is already
    // mid-turn would otherwise show it gray until the turn ended. Called once
    // from the subscriber's mount effect. Lives under `attention` rather than
    // `buddy` because the main window's session switcher reads it too.
    getSummary: (): Promise<AttentionSummary> => ipcRenderer.invoke(IPC.ATTENTION_GET_SUMMARY),
  },
  // Exposes the live xterm buffer for a session. Used by useAttentionClassifier
  // (~1s cadence) so it can read terminal state on both Electron and Android
  // via the same window.claude.terminal.getScreenText API.
  // The call chain on desktop is intentionally circuitous:
  //   renderer → preload contextBridge → ipcMain.handle →
  //   event.sender.executeJavaScript → window.__terminalRegistry.getScreenText
  // This round-trip is necessary because contextBridge freezes the exposed
  // object, so the renderer cannot write back to it. The registry is wired
  // up in bootstrap/terminal-bridge.ts. Round-trip cost is not perf-sensitive
  // at ~1s cadence.
  terminal: {
    getScreenText: (sessionId: string): Promise<string> =>
      ipcRenderer.invoke('terminal:get-screen-text', sessionId),
  },
  // GPU / performance preference — read and write the preferPowerSaving flag.
  // multiGpuDetected: false in the response means the UI section stays hidden.
  performance: {
    get: (): Promise<PerformanceConfigSnapshot> =>
      ipcRenderer.invoke(IPC.PERFORMANCE_GET_CONFIG),
    set: (preferPowerSaving: boolean): Promise<{ ok: true }> =>
      ipcRenderer.invoke(IPC.PERFORMANCE_SET_CONFIG, { preferPowerSaving }),
  },
  // WHY: named 'app:restart' (not 'performance:restart') so any future
  // restart-required setting can reuse this single generic channel.
  app: {
    restart: (): Promise<void> => ipcRenderer.invoke(IPC.APP_RESTART),
  },
  // Native runtime — YouCoded's first-party harness (platform roadmap Phase 0-2).
  // Enabled by default as of 2026-07-16. Kill switch: YOUCODED_NATIVE=0 disables it
  // (e.g. YOUCODED_NATIVE=0 bash scripts/run-dev.sh) if a regression needs a fast revert.
  native: {
    supported: process.env.YOUCODED_NATIVE !== '0',
    // M1: invoke — matches the handle signature, returns {status,reason}
    send: (sessionId: string, text: string, attachments?: string[]) => ipcRenderer.invoke(IPC.NATIVE_SEND, { sessionId, text, attachments }),
    // Task 11: cancel/edit a queued message before it sends. Request-response
    // (unlike interrupt below) — the renderer needs the true/false result to
    // decide between "removed, proceed" and a "too late" toast.
    queueRemove: (sessionId: string, queueId: string) => ipcRenderer.invoke(IPC.NATIVE_QUEUE_REMOVE, { sessionId, queueId }),
    // Fire-and-forget: match ipcMain.on handler that destructures { sessionId }.
    interrupt: (sessionId: string) => ipcRenderer.send(IPC.NATIVE_INTERRUPT, { sessionId }),
    // Fire-and-forget like interrupt: the stalled card needs no answer — either
    // the step re-runs (the card clears itself) or nothing was parked (the card
    // is already gone).
    retry: (sessionId: string) => ipcRenderer.send(IPC.NATIVE_RETRY, { sessionId }),
    // User-initiated /compact. Request-response, NOT fire-and-forget: the caller
    // needs the {ok, reason} result to tell the user why nothing happened when a
    // compaction is refused (turn in flight, nothing to compact, summary failed).
    compact: (sessionId: string) => ipcRenderer.invoke(IPC.NATIVE_COMPACT, { sessionId }),
    // /clear as a context barrier — appends a marker, never erases the log.
    clear: (sessionId: string) => ipcRenderer.invoke(IPC.NATIVE_CLEAR, { sessionId }),
    invokeSkill: (sessionId: string, skill: string, args?: string) => ipcRenderer.invoke(IPC.NATIVE_INVOKE_SKILL, { sessionId, skill, args }),
    // Request-response: match the positional ipcMain.handle signatures.
    setBinding: (sessionId: string, binding: unknown) => ipcRenderer.invoke(IPC.NATIVE_SET_BINDING, sessionId, binding),
    setPermissionMode: (sessionId: string, mode: string) => ipcRenderer.invoke(IPC.NATIVE_SET_PERMISSION_MODE, sessionId, mode),
    // Read the session's current permission mode — seeds the chip on create/resume.
    getPermissionMode: (sessionId: string) => ipcRenderer.invoke(IPC.NATIVE_GET_PERMISSION_MODE, sessionId),
    getStepGuard: () => ipcRenderer.invoke(IPC.NATIVE_GET_STEP_GUARD),
    setStepGuard: (value: number | null) => ipcRenderer.invoke(IPC.NATIVE_SET_STEP_GUARD, value),
    sessionsList: () => ipcRenderer.invoke(IPC.NATIVE_SESSIONS_LIST),
    // G-1: the Bash card's Stop button. Request-response — the card needs
    // {ok, reason} to stop showing "Stopping…" when nothing was stopped.
    killShell: (sessionId: string, shellId: string) => ipcRenderer.invoke(IPC.NATIVE_KILL_SHELL, { sessionId, shellId }),
    // Per-session bound-model residency push (unloaded/loading/loaded/sleeping)
    // → ChatView's model-unloaded banner + loading indicator (2026-07-14).
    onModelState: (cb: (s: unknown) => void) => {
      const listener = (_e: unknown, s: unknown) => cb(s);
      ipcRenderer.on(IPC.NATIVE_MODEL_STATE, listener);
      return () => ipcRenderer.removeListener(IPC.NATIVE_MODEL_STATE, listener);
    },
  },
  // Provider registry — CRUD + connection test + model catalog for native
  // runtime model providers. All request-response; positional args match the
  // ipcMain.handle signatures in ipc-handlers.ts.
  providers: {
    list: () => ipcRenderer.invoke(IPC.PROVIDER_LIST),
    upsert: (config: unknown) => ipcRenderer.invoke(IPC.PROVIDER_UPSERT, config),
    remove: (id: string) => ipcRenderer.invoke(IPC.PROVIDER_REMOVE, id),
    test: (id: string) => ipcRenderer.invoke(IPC.PROVIDER_TEST, id),
    setKey: (id: string, key: string) => ipcRenderer.invoke(IPC.PROVIDER_SET_KEY, id, key),
    catalog: () => ipcRenderer.invoke(IPC.PROVIDER_CATALOG),
  },
  // Sign in with ChatGPT (backend design 2026-09-05 §5, §6). The account state
  // machine the Settings card and the first-run wizard read, and its three verbs.
  // `supported` mirrors native.supported above: YOUCODED_CHATGPT=0 is the kill
  // switch, and the renderer gates the card on `=== true` (workbench and
  // remote-shim set it explicitly for that reason — review R1-9).
  //
  // WHY the invokes go through unwrapInvokeError: signIn() THROWS the two
  // sentences the card must show verbatim ("Port 1455 is already in use…", the
  // keychain one). Electron's ipcRenderer.invoke rewraps a handler's throw as
  // "Error invoking remote method 'chatgpt:sign-in': Error: <sentence>", and
  // the card prints e.message as-is — so without this the user would read the
  // transport's prefix in front of the sentence. No other namespace in this
  // file needed it: the provider handlers' throws reach a section that shows
  // them the same prefixed way (ProvidersSection.tsx, a pre-existing wart).
  chatgpt: {
    supported: process.env.YOUCODED_CHATGPT !== '0',
    status: (): Promise<ChatGptAccountStatus> => unwrapInvokeError(ipcRenderer.invoke(IPC.CHATGPT_STATUS)),
    signIn: (): Promise<boolean> => unwrapInvokeError(ipcRenderer.invoke(IPC.CHATGPT_SIGN_IN)),
    cancelSignIn: (): Promise<boolean> => unwrapInvokeError(ipcRenderer.invoke(IPC.CHATGPT_CANCEL_SIGN_IN)),
    signOut: (): Promise<boolean> => unwrapInvokeError(ipcRenderer.invoke(IPC.CHATGPT_SIGN_OUT)),
  },
  // WebSearch providers (Phase 2 Plan B): keyed Tavily/Exa upgrades. list = the
  // fixed backend rows (hasKey flags); set/remove-key manage the encrypted key;
  // test = never-throws connectivity check. Positional args match ipc-handlers.
  search: {
    list: () => ipcRenderer.invoke('search:list'),
    setKey: (backend: string, key: string) => ipcRenderer.invoke('search:set-key', backend, key),
    removeKey: (backend: string) => ipcRenderer.invoke('search:remove-key', backend),
    test: (backend: string, key: string) => ipcRenderer.invoke('search:test', backend, key),
  },
  // Remembered "Always allow" rules (Settings → Permissions, M5 2a). Keyed by
  // PROJECT SLUG, not cwd — the cwd is not recoverable from the lossy slug, so
  // the renderer sends back the slug it was handed. remove/removeProject resolve
  // false when nothing matched, i.e. the on-screen list had gone stale.
  // Positional args match ipc-handlers, same as search:* above.
  // First bytes of a file the user attached, for the composer's preview cards.
  // Positional args like every other namespace here; main clamps maxBytes to
  // READ_HEAD_MAX_BYTES (shared/read-head.ts) and refuses sensitive paths.
  fs: {
    readHead: (filePath: string, maxBytes?: number) => ipcRenderer.invoke('fs:read-head', filePath, maxBytes),
  },
  // Games arcade scores (spec §6.1). Positional args like every other namespace
  // here. Scores cross as raw NUMBERS — how a game WORDS its score ("31 pipes")
  // comes from game-registry.ts in the renderer, so adding a game never touches
  // this file, main, or the Worker.
  arcade: {
    status: () => ipcRenderer.invoke('arcade:status'),
    leaderboard: (game: string) => ipcRenderer.invoke('arcade:leaderboard', game),
    submitScore: (game: string, score: number) => ipcRenderer.invoke('arcade:submit-score', game, score),
    // Head-to-head records. `game` is optional — omitted means every game.
    records: (game?: string) => ipcRenderer.invoke('arcade:records', game),
  },
  permissions: {
    list: () => ipcRenderer.invoke('permissions:list'),
    remove: (slug: string, rule: unknown) => ipcRenderer.invoke('permissions:remove', slug, rule),
    removeProject: (slug: string) => ipcRenderer.invoke('permissions:remove-project', slug),
  },
  // Specialists 1c (Task 8) — roster + tier reads/writes + card actions.
  // Positional args, matching every other request-response namespace above
  // (permissions, search, providers) — the remote-shim equivalent below takes
  // an object payload instead, same split as those.
  specialists: {
    list: (opts?: { cwd?: string; ensurePersonalFolder?: boolean }) => ipcRenderer.invoke('specialists:list', opts),
    getDelegatedModels: () => ipcRenderer.invoke('specialists:delegated-get'),
    setDelegatedModel: (tier: 'budget' | 'frontier', binding: { providerId: string; modelId: string } | null) =>
      ipcRenderer.invoke('specialists:delegated-set', tier, binding),
    steer: (sessionId: string, childId: string, text: string) => ipcRenderer.invoke('specialists:steer', sessionId, childId, text),
    interrupt: (sessionId: string, childId: string) => ipcRenderer.invoke('specialists:interrupt', sessionId, childId),
  },
  // Local llama.cpp engine (Plan B). Progress/status pushes return an
  // unsubscribe, matching every other on* subscription in this file.
  engine: {
    status: (): Promise<unknown> => ipcRenderer.invoke(IPC.ENGINE_STATUS),
    install: (): Promise<unknown> => ipcRenderer.invoke(IPC.ENGINE_INSTALL),
    restart: (): Promise<unknown> => ipcRenderer.invoke(IPC.ENGINE_RESTART),
    // Plan C context-length knob. Now a thin alias for setConfig({contextSize}).
    setContext: (contextSize: number): Promise<unknown> => ipcRenderer.invoke(IPC.ENGINE_SET_CONTEXT, contextSize),
    // Every engine-wide setting in one write. The value saves at once; it
    // reaches the engine after the reply that is streaming right now.
    setConfig: (patch: { contextSize?: number; speed?: { speculative?: boolean; compressCache?: boolean } }): Promise<unknown> =>
      ipcRenderer.invoke(IPC.ENGINE_SET_CONFIG, patch),
    // Opens a plain-shell session in the folder this window is working in and
    // types `command` onto its prompt. It is NOT run — the user presses Enter.
    // The returned id is the session the caller then selects.
    runInTerminal: (command: string): Promise<{ sessionId: string }> =>
      ipcRenderer.invoke(IPC.ENGINE_RUN_IN_TERMINAL, command),
    // What a faster engine build needs on this machine before it can be
    // installed (Linux ROCm). The card's "Check again" re-invokes this.
    prereqs: (backend: string): Promise<unknown> => ipcRenderer.invoke(IPC.ENGINE_PREREQS, backend),
    onInstallProgress: (cb: (p: unknown) => void) => {
      const listener = (_e: unknown, p: unknown) => cb(p);
      ipcRenderer.on(IPC.ENGINE_INSTALL_PROGRESS, listener);
      return () => ipcRenderer.removeListener(IPC.ENGINE_INSTALL_PROGRESS, listener);
    },
    onStatusChanged: (cb: (s: unknown) => void) => {
      const listener = (_e: unknown, s: unknown) => cb(s);
      ipcRenderer.on(IPC.ENGINE_STATUS_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC.ENGINE_STATUS_CHANGED, listener);
    },
    // Live per-model residency (state: unloaded|loading|loaded|sleeping).
    models: (): Promise<unknown> => ipcRenderer.invoke(IPC.ENGINE_MODELS),
    onModelsChanged: (cb: (models: unknown) => void) => {
      const listener = (_e: unknown, models: unknown) => cb(models);
      ipcRenderer.on(IPC.ENGINE_MODELS_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC.ENGINE_MODELS_CHANGED, listener);
    },
  },
  // Model manager (Plan C) — curated catalog, HF search, downloads, endpoint
  // detectors, engine backend switch. Download progress pushes return an
  // unsubscribe, matching engine.onInstallProgress above.
  models: {
    curated: () => ipcRenderer.invoke(IPC.MODELS_CURATED),
    search: (query: string) => ipcRenderer.invoke(IPC.MODELS_SEARCH, query),
    quants: (repo: string) => ipcRenderer.invoke(IPC.MODELS_QUANTS, repo),
    download: (repo: string, quant: unknown) => ipcRenderer.invoke(IPC.MODELS_DOWNLOAD, repo, quant),
    downloadCancel: (downloadId: string) => ipcRenderer.invoke(IPC.MODELS_DOWNLOAD_CANCEL, downloadId),
    delete: (id: string) => ipcRenderer.invoke(IPC.MODELS_DELETE, id),
    installed: () => ipcRenderer.invoke(IPC.MODELS_INSTALLED),
    // Resume an interrupted download from the manifest beside its .partial
    // (2026-08-26) — no Hugging Face round trip, so it works when the network
    // is the reason the download stopped.
    resume: (modelId: string) => ipcRenderer.invoke(IPC.MODELS_RESUME, modelId),
    // One model's stored settings (2026-09-05). The answer is the STORED shape,
    // which carries two things the user never sets: whether the last save is
    // still waiting on the reply that is streaming, and why the model last
    // failed to load.
    settings: (modelId: string) => ipcRenderer.invoke(IPC.MODELS_SETTINGS, modelId),
    // Save one model's settings. The patch holds the four fields the dialog
    // owns, plus `dismissMemoryWarning: true|false` — a signal, not a value:
    // main works out the context length to remember it against, because only
    // main knows how this model's setting and the engine-wide default combine.
    setSettings: (modelId: string, patch: unknown) => ipcRenderer.invoke(IPC.MODELS_SET_SETTINGS, modelId, patch),
    // Give a downloaded model its eye: fetch the vision file and move the model
    // into a folder of its own. Progress rides the ordinary download stream.
    addVision: (modelId: string) => ipcRenderer.invoke(IPC.MODELS_ADD_VISION, modelId),
    detectEndpoints: () => ipcRenderer.invoke(IPC.ENDPOINTS_DETECT),
    setBackend: (backend: string) => ipcRenderer.invoke(IPC.ENGINE_SET_BACKEND, backend),
    // Create-time / swap memory guard + [Reload Model] (2026-07-14).
    memoryCheck: (modelId: string) => ipcRenderer.invoke(IPC.MODELS_MEMORY_CHECK, modelId),
    load: (modelId: string) => ipcRenderer.invoke(IPC.MODELS_LOAD, modelId),
    onDownloadProgress: (cb: (p: unknown) => void) => {
      const listener = (_e: unknown, p: unknown) => cb(p);
      ipcRenderer.on(IPC.MODELS_DOWNLOAD_PROGRESS, listener);
      return () => ipcRenderer.removeListener(IPC.MODELS_DOWNLOAD_PROGRESS, listener);
    },
  },
  // System namespace — platform integrations like hardware back button.
  // Desktop no-op stub: notifyStackState / onBack are only meaningful on
  // Android, where MainActivity uses them to enable/disable
  // OnBackPressedCallback and broadcast back-press events. Exposed here for
  // shape parity with remote-shim.ts (PITFALLS.md → Cross-Platform parity).
  // Voice typing. `sendAudio` and `micAccess` are DESKTOP ONLY on purpose: on a
  // phone the operating system's own recogniser owns the microphone, and the
  // Activity's permission launcher owns the permission question — so the shared
  // renderer tests `typeof bridge.sendAudio === 'function'` instead of assuming.
  voice: {
    status: (): Promise<unknown> => ipcRenderer.invoke(IPC.VOICE_STATUS),
    download: (): Promise<void> => ipcRenderer.invoke(IPC.VOICE_DOWNLOAD),
    start: (): Promise<void> => ipcRenderer.invoke(IPC.VOICE_START),
    stop: (): Promise<void> => ipcRenderer.invoke(IPC.VOICE_STOP),
    cancel: (): Promise<void> => ipcRenderer.invoke(IPC.VOICE_CANCEL),
    micAccess: (): Promise<unknown> => ipcRenderer.invoke(IPC.VOICE_MIC_ACCESS),
    // One 100 ms slice of microphone audio plus the loudness the audio worklet
    // already measured for it. The loudness travels with the audio because the
    // main process owns the two-second silence stop and must not re-measure
    // what the worklet already knows.
    sendAudio: (chunk: ArrayBuffer, rms: number) => ipcRenderer.send(IPC.VOICE_AUDIO, chunk, rms),
    onEvent: (cb: (e: unknown) => void) => {
      const listener = (_e: unknown, payload: unknown) => cb(payload);
      ipcRenderer.on(IPC.VOICE_EVENT, listener);
      return () => ipcRenderer.removeListener(IPC.VOICE_EVENT, listener);
    },
  },
  system: {
    notifyStackState: (_empty: boolean) => {
      // No-op on desktop. Electron has no hardware back button.
    },
    onBack: (_cb: () => void) => {
      // No-op on desktop. Returns an empty unsubscribe function so callers
      // can call it unconditionally without platform branching.
      return () => {};
    },
  },
  artifacts: {
    listSession: (sessionId: string, projectRoot: string) =>
      ipcRenderer.invoke('artifacts:list-session', sessionId, projectRoot),
    listProject: (projectId: string, opts?: { withCount?: boolean }) =>
      ipcRenderer.invoke('artifacts:list-project', projectId, opts),
    listAllFiles: (projectId: string, opts?: { force?: boolean }) =>
      ipcRenderer.invoke('artifacts:list-all-files', projectId, opts),
    listProjectsIndex: (opts?: { withCounts?: boolean }) =>
      ipcRenderer.invoke('artifacts:list-projects-index', opts),
    // opts: { full? } — full opts into reading up to FULL_READ_MAX_BYTES for a
    // file the pane is currently showing as a prefix.
    get: (projectRoot: string, artifactId: string, opts?: { full?: boolean }) =>
      ipcRenderer.invoke('artifacts:get', projectRoot, artifactId, opts),
    // Read a file as base64 — binary viewers (xlsx/docx/pdf/image) decode this
    // to bytes (renderer can't fetch a file:// URL from the http/app origin).
    readBinary: (absolutePath: string) =>
      ipcRenderer.invoke('artifacts:read-binary', absolutePath),
    // opts: { baseMtimeMs?, confirmed? } — concurrency token + confirm-tier ack
    save: (projectRoot: string, projectId: string, projectName: string,
           artifactId: string, content: string, sessionId: string,
           opts?: { baseMtimeMs?: number; confirmed?: boolean }) =>
      ipcRenderer.invoke('artifacts:save', projectRoot, projectId, projectName, artifactId, content, sessionId, opts),
    // Fix: data-flow gap — renderer Tracker calls this on Write/Edit/MultiEdit
    // transcript events so the central index is populated automatically.
    appendVersion: (projectRoot: string, sessionId: string, args: any) =>
      ipcRenderer.invoke('artifacts:append-version', projectRoot, sessionId, args),
    // Copy or move a picked file INTO the project folder — see
    // artifacts/import-file.ts for the traversal/collision/protected-path policy.
    importFile: (projectRoot: string, sourcePath: string, destDir: string,
                 opts: {
                   mode: 'move' | 'copy';
                   onCollision: 'replace' | 'keep-both' | 'skip';
                   // The colliding basenames the dialog NAMED to the user —
                   // 'replace' is limited to these, so an undisclosed collision
                   // can never be overwritten. See artifacts/import-file.ts.
                   disclosedCollisions?: string[];
                 }) =>
      ipcRenderer.invoke('artifacts:import-file', projectRoot, sourcePath, destDir, opts),
    includeExternal: (projectRoot: string, absolutePath: string) =>
      ipcRenderer.invoke('artifacts:include-external', projectRoot, absolutePath),
    exclude: (projectRoot: string, canonicalPath: string) =>
      ipcRenderer.invoke('artifacts:exclude', projectRoot, canonicalPath),
    // Task 7.3: remove a project from the central index (files untouched)
    deleteProject: (projectId: string, deleteSidecar: boolean) =>
      ipcRenderer.invoke('artifacts:delete-project', projectId, deleteSidecar),
    // Returns the subset of artifactIds whose underlying file is missing from
    // disk. Used to fold "file not on disk" into the deleted UI state.
    checkExistence: (projectRoot: string, artifactIds: string[]) =>
      ipcRenderer.invoke('artifacts:check-existence', projectRoot, artifactIds),
    // Rename an artifact's file on disk; newName is the basename without extension.
    rename: (projectRoot: string, artifactId: string, newName: string) =>
      ipcRenderer.invoke('artifacts:rename', projectRoot, artifactId, newName),
    // Remove a tracking RECORD from the sidecar (never the file on disk).
    removeRecord: (projectRoot: string, artifactId: string) =>
      ipcRenderer.invoke('artifacts:remove-record', projectRoot, artifactId),
    // Subscribe/unsubscribe this renderer to external file-change events for a
    // project root — events arrive via onChanged with by:'external'.
    watchProject: (projectRoot: string) =>
      ipcRenderer.invoke('artifacts:watch-project', projectRoot),
    unwatchProject: (projectRoot: string) =>
      ipcRenderer.invoke('artifacts:unwatch-project', projectRoot),
    // Project-wide content search (ripgrep in main; desktop-only).
    searchContent: (projectRoot: string, query: string) =>
      ipcRenderer.invoke('artifacts:search-content', projectRoot, query),
    onChanged: (cb: (event: any) => void) => {
      const handler = (_e: any, payload: any) => cb(payload);
      ipcRenderer.on('artifacts:changed', handler);
      return () => ipcRenderer.removeListener('artifacts:changed', handler);
    },
  },
  git: {
    fileStatus: (projectRoot: string, relPath: string) =>
      ipcRenderer.invoke('git:file-status', projectRoot, relPath),
    fileReview: (projectRoot: string, relPath: string, opts?: { logSkip?: number }) =>
      ipcRenderer.invoke('git:file-review', projectRoot, relPath, opts),
    // prevPath (project-root-relative old name) is passed for the rename
    // commit itself so the main-process handler can pair the rename with -M
    // instead of rendering the add-side full-file wall.
    commitFileDiff: (projectRoot: string, sha: string, relPath: string, prevPath?: string) =>
      ipcRenderer.invoke('git:commit-file-diff', projectRoot, sha, relPath, prevPath),
    stage: (projectRoot: string, relPath: string) =>
      ipcRenderer.invoke('git:stage', projectRoot, relPath),
    unstage: (projectRoot: string, relPath: string) =>
      ipcRenderer.invoke('git:unstage', projectRoot, relPath),
    commit: (projectRoot: string, message: string) =>
      ipcRenderer.invoke('git:commit', projectRoot, message),
    discard: (projectRoot: string, relPath: string) =>
      ipcRenderer.invoke('git:discard', projectRoot, relPath),
    watch: (projectRoot: string) => ipcRenderer.invoke('git:watch', projectRoot),
    unwatch: (projectRoot: string) => ipcRenderer.invoke('git:unwatch', projectRoot),
    onChanged: (cb: (event: any) => void) => {
      const handler = (_e: any, payload: any) => cb(payload);
      ipcRenderer.on('git:changed', handler);
      return () => ipcRenderer.removeListener('git:changed', handler);
    },
  },
  // Project View IPC — sibling to artifacts. Backs the project overlay's
  // conversations / repo / context tabs.
  project: {
    listConversations: (projectPath: string) =>
      ipcRenderer.invoke('project:list-conversations', projectPath),
    conversationHistory: (projectPath: string, sessionId: string, count: number, all: boolean) =>
      ipcRenderer.invoke('project:conversation-history', projectPath, sessionId, count, all),
    repoInfo: (projectPath: string) =>
      ipcRenderer.invoke('project:repo-info', projectPath),
    listContext: (projectPath: string) =>
      ipcRenderer.invoke('project:list-context', projectPath),
    readContextFile: (projectPath: string, absolutePath: string) =>
      ipcRenderer.invoke('project:read-context-file', projectPath, absolutePath),
    writeContextFile: (projectPath: string, absolutePath: string, content: string) =>
      ipcRenderer.invoke('project:write-context-file', projectPath, absolutePath, content),
  },
  // Session references: turn the short ids a chatsearch result printed back
  // into conversations, and read a bounded slice of one for the preview pane.
  chatsearch: {
    resolve: (shortIds: string[]) => ipcRenderer.invoke('chatsearch:resolve', shortIds),
    read: (req: { provider: string; id: string; tail: number; before?: number }) =>
      ipcRenderer.invoke('chatsearch:read', req),
  },
});
