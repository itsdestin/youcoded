export type PermissionMode = 'normal' | 'auto-accept' | 'plan' | 'bypass';

// Advanced permission overrides for bypass mode. Controls which PermissionRequest
// categories are auto-approved when --dangerously-skip-permissions is active.
// These only affect the small set of requests that bypass mode still fires:
// protected path writes, compound cd commands, etc.
export interface PermissionOverrides {
  approveAll: boolean;            // Blanket approve everything (except AskUserQuestion)
  protectedConfigFiles: boolean;  // .bashrc, .gitconfig, .mcp.json, etc.
  protectedDirectories: boolean;  // .git/, .claude/ (non-exempt paths)
  compoundCdRedirect: boolean;    // cd + output redirection (path resolution bypass)
  compoundCdGit: boolean;         // cd + git (bare repository attack protection)
}

export const PERMISSION_OVERRIDES_DEFAULT: PermissionOverrides = {
  approveAll: false,
  protectedConfigFiles: false,
  protectedDirectories: false,
  compoundCdRedirect: false,
  compoundCdGit: false,
};

// Which CLI backend powers a session — defaults to 'claude' for backwards compat
export type SessionProvider = 'claude' | 'gemini';

export interface SessionInfo {
  id: string;
  name: string;
  cwd: string;
  permissionMode: PermissionMode;
  skipPermissions: boolean;
  status: 'active' | 'idle' | 'destroyed';
  createdAt: number;
  /** Which CLI backend this session runs — 'claude' (default) or 'gemini' */
  provider: SessionProvider;
}

export interface HookEvent {
  type: string;
  sessionId: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

// --- Transcript watcher types ---

export type TranscriptEventType =
  | 'user-message'
  | 'assistant-text'
  | 'tool-use'
  | 'tool-result'
  | 'thinking'
  // Extended-thinking models emit `thinking` blocks between tool calls that
  // carry no chat text — the watcher surfaces them as heartbeats so the
  // attention classifier doesn't misread the silence as 'stuck'.
  | 'assistant-thinking'
  | 'turn-complete'
  // Emitted when Claude Code writes a {type:"user", isCompactSummary:true}
  // entry — the canonical "compaction finished" signal. In-session /compact
  // appends to the SAME file (no shrink), so we can't use file-size heuristics.
  | 'compact-summary';

export interface TranscriptEvent {
  type: TranscriptEventType;
  sessionId: string; // desktop session ID
  /** The JSONL line's uuid — used for deduplication */
  uuid: string;
  timestamp: number;
  data: {
    text?: string;
    toolUseId?: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolResult?: string;
    isError?: boolean;
    stopReason?: string;
  };
}

// --- Chat view types ---

export type ToolCallStatus = 'running' | 'complete' | 'failed' | 'awaiting-approval';

export interface ToolCallState {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  status: ToolCallStatus;
  requestId?: string;
  permissionSuggestions?: string[];
  response?: string;
  error?: string;
}

export interface ToolGroupState {
  id: string;
  toolIds: string[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

// --- Command drawer / marketplace types ---

export interface SkillEntry {
  // Existing
  id: string;
  displayName: string;
  description: string;
  category: 'personal' | 'work' | 'development' | 'admin' | 'other';
  prompt: string;
  source: 'destinclaude' | 'self' | 'plugin' | 'marketplace';
  pluginName?: string;

  // New — marketplace fields
  type: 'prompt' | 'plugin';
  author?: string;
  version?: string;
  rating?: number;
  ratingCount?: number;
  installs?: number;
  visibility: 'private' | 'shared' | 'published';
  installedAt?: string;
  updatedAt?: string;
  repoUrl?: string;
  // Phase 3c: optional config schema — when present, the detail view renders
  // a settings form for this entry. Anthropic plugins using native config.json
  // should NOT set this field.
  configSchema?: ConfigSchema;
}

export interface SkillDetailView extends SkillEntry {
  fullDescription?: string;
  tags?: string[];
  publishedAt?: string;
  authorGithub?: string;
  sourceRegistry?: string;
}

export interface SkillFilters {
  type?: 'prompt' | 'plugin';
  category?: SkillEntry['category'];
  sort?: 'popular' | 'newest' | 'rating' | 'name';
  query?: string;
}

export interface ChipConfig {
  skillId?: string;  // optional — chips can exist without a backing skill (e.g., "Git Status" is just a prompt)
  label: string;
  prompt: string;
}

export interface MetadataOverride {
  displayName?: string;
  description?: string;
  category?: SkillEntry['category'];
}

// Component of an installed marketplace package (plugin, theme, etc.)
export interface PackageComponent {
  type: 'plugin' | 'theme';
  path: string;
}

// Tracked marketplace package — records what the marketplace installed
export interface PackageInfo {
  version: string;
  source: 'marketplace' | 'user';
  installedAt: string;
  removable: boolean;
  components: PackageComponent[];
}

export interface UserSkillConfig {
  version: 1 | 2;
  favorites: string[];
  chips: ChipConfig[];
  overrides: Record<string, MetadataOverride>;
  privateSkills: SkillEntry[];
  // v2: unified package tracking (replaces installed_plugins)
  packages?: Record<string, PackageInfo>;
  // Phase 6: set after one-time migration of toolkit layers + community themes
  migrated?: boolean;
}

export interface SkillProvider {
  listMarketplace(filters?: SkillFilters): Promise<SkillEntry[]>;
  getSkillDetail(id: string): Promise<SkillDetailView>;
  search(query: string): Promise<SkillEntry[]>;
  getInstalled(): Promise<SkillEntry[]>;
  getFavorites(): Promise<string[]>;
  getChips(): Promise<ChipConfig[]>;
  getOverrides(): Promise<Record<string, MetadataOverride>>;
  install(id: string): Promise<any>;
  uninstall(id: string): Promise<void | { type: 'plugin' | 'prompt' }>;
  setFavorite(id: string, favorited: boolean): Promise<void>;
  setChips(chips: ChipConfig[]): Promise<void>;
  setOverride(id: string, override: MetadataOverride): Promise<void>;
  createPromptSkill(skill: Omit<SkillEntry, 'id'>): Promise<SkillEntry>;
  deletePromptSkill(id: string): Promise<void>;
  publish(id: string): Promise<{ prUrl: string }>;
  generateShareLink(id: string): Promise<string>;
  importFromLink(encoded: string): Promise<SkillEntry>;
}

// Known session flag names. Add new flags here + in the renderer's pill list.
// Server-side validation rejects any flag name not in this union.
export type SessionFlagName = 'complete' | 'priority' | 'helpful';
export const SESSION_FLAG_NAMES: SessionFlagName[] = ['complete', 'priority', 'helpful'];

export interface PastSession {
  /** Claude Code's internal session ID (JSONL filename without extension) */
  sessionId: string;
  /** Human-readable name from topic file, or 'Untitled' */
  name: string;
  /** Project directory slug (e.g. 'C--Users-desti') */
  projectSlug: string;
  /** Display-friendly project path derived from slug */
  projectPath: string;
  /** Last modified timestamp (epoch ms) */
  lastModified: number;
  /** File size in bytes — proxy for conversation length */
  size: number;
  /** User-set flags. `complete` hides from resume menu; `priority` pins to top;
   *  `helpful` is informational only. Multiple flags per session are allowed. */
  flags?: Partial<Record<SessionFlagName, boolean>>;
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

// Phase 3c: per-entry config schema for marketplace packages. Entries
// that declare configSchema get a settings form in the detail view.
// Anthropic plugins using their own native config.json are left alone.
export interface ConfigField {
  name: string;
  type: 'string' | 'boolean' | 'number' | 'select';
  label: string;
  description?: string;
  default?: string | boolean | number;
  required?: boolean;
  options?: { value: string; label: string }[]; // for 'select' type
}

export interface ConfigSchema {
  fields: ConfigField[];
}

// IPC channel names
export const IPC = {
  // Renderer -> Main
  SESSION_CREATE: 'session:create',
  SESSION_DESTROY: 'session:destroy',
  SESSION_INPUT: 'session:input',
  SESSION_RESIZE: 'session:resize',
  SESSION_LIST: 'session:list',
  SESSION_SWITCH: 'session:switch',
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
  TERMINAL_READY: 'session:terminal-ready',
  // Main -> Renderer
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
  OPEN_CHANGELOG: 'shell:open-changelog',
  OPEN_EXTERNAL: 'shell:open-external',
  PERMISSION_RESPOND: 'permission:respond',
  // Remote settings
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
  // JSONL truncation — fired on /clear or /compact rewrite. App uses to
  // detect /compact completion (see slash-command-dispatcher).
  TRANSCRIPT_SHRINK: 'transcript:shrink',
  // Session browser
  SESSION_BROWSE: 'session:browse',
  SESSION_HISTORY: 'session:history',
  // Mark/unmark a session flag (complete, priority, helpful, …)
  SESSION_SET_FLAG: 'session:set-flag',
  // Broadcast when session metadata changes (carries a flag + value)
  SESSION_META_CHANGED: 'session:meta-changed',
  SESSION_RESUME: 'session:resume',
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
  WINDOW_SET_ICON: 'window:set-icon', // theme-driven window + dock icon hot-swap
  // Zoom controls
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
  // Unified marketplace — packages + update + config (Phase 3)
  MARKETPLACE_GET_PACKAGES: 'marketplace:get-packages',
  SKILLS_UPDATE: 'skills:update',
  MARKETPLACE_GET_CONFIG: 'marketplace:get-config',
  MARKETPLACE_SET_CONFIG: 'marketplace:set-config',
  // First-run
  FIRST_RUN_STATE: 'first-run:state',
  FIRST_RUN_RETRY: 'first-run:retry',
  FIRST_RUN_START_AUTH: 'first-run:start-auth',
  FIRST_RUN_SUBMIT_API_KEY: 'first-run:submit-api-key',
  FIRST_RUN_DEV_MODE_DONE: 'first-run:dev-mode-done',
  FIRST_RUN_SKIP: 'first-run:skip',
  // Sync management
  SYNC_GET_STATUS: 'sync:get-status',
  SYNC_GET_CONFIG: 'sync:get-config',
  SYNC_SET_CONFIG: 'sync:set-config',
  SYNC_FORCE: 'sync:force',
  SYNC_GET_LOG: 'sync:get-log',
  SYNC_DISMISS_WARNING: 'sync:dismiss-warning',
  // Multi-window detach subsystem (Renderer <-> Main)
  WINDOW_GET_ID: 'window:get-id',
  WINDOW_DIRECTORY_UPDATED: 'window:directory-updated',
  WINDOW_GET_DIRECTORY: 'window:get-directory',
  WINDOW_LEADER_CHANGED: 'window:leader-changed',
  WINDOW_OPEN_DETACHED: 'window:open-detached',
  WINDOW_FOCUS_AND_SWITCH: 'window:focus-and-switch',
  SESSION_OWNERSHIP_ACQUIRED: 'session:ownership-acquired',
  SESSION_OWNERSHIP_LOST: 'session:ownership-lost',
  SESSION_DETACH_START: 'session:detach-start',
  SESSION_DRAG_STARTED: 'session:drag-started',
  SESSION_DRAG_ENDED: 'session:drag-ended',
  SESSION_DRAG_DROPPED: 'session:drag-dropped',
  SESSION_DROP_RESOLVE: 'session:drop-resolve',
  CROSS_WINDOW_CURSOR: 'session:cross-window-cursor',
  // Request the full transcript history for a session — used when a window
  // acquires ownership and needs to hydrate its reducer from disk.
  TRANSCRIPT_REPLAY: 'transcript:replay-from-start',
  // Appearance sync across peer windows — Renderer → Main broadcasts, Main
  // → other Renderers applies without re-broadcasting. Lets a theme change
  // in window 2 propagate to window 1 without a reload.
  APPEARANCE_BROADCAST: 'appearance:broadcast',
  APPEARANCE_SYNC: 'appearance:sync',
} as const;

// --- Window registry / detach types ---

export interface WindowInfo {
  id: number;           // BrowserWindow webContentsId
  label: string;        // e.g. "window 2" (creation order)
  createdAt: number;
}

export interface WindowDirectoryEntry {
  window: WindowInfo;
  sessions: SessionInfo[];
}

export interface WindowDirectory {
  leaderWindowId: number;
  windows: WindowDirectoryEntry[];
}

export interface SessionOwnershipAcquired {
  sessionId: string;
  sessionInfo: SessionInfo;
  /** True when the window was just created for this session (skip replay delay UI). */
  freshWindow: boolean;
}

export interface SessionOwnershipLost {
  sessionId: string;
}

export interface DetachStartPayload {
  sessionId: string;
  screenX: number;
  screenY: number;
}

export interface DragDroppedPayload {
  sessionId: string;
  targetWindowId: number;
  insertIndex: number;
}

export interface CrossWindowCursor {
  screenX: number;
  screenY: number;
}
