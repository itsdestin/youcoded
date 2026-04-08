export type PermissionMode = 'normal' | 'auto-accept' | 'plan' | 'bypass';

export interface SessionInfo {
  id: string;
  name: string;
  cwd: string;
  permissionMode: PermissionMode;
  skipPermissions: boolean;
  status: 'active' | 'idle' | 'destroyed';
  createdAt: number;
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
  | 'turn-complete';

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

export interface UserSkillConfig {
  version: 1;
  favorites: string[];
  chips: ChipConfig[];
  overrides: Record<string, MetadataOverride>;
  privateSkills: SkillEntry[];
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
  uninstall(id: string): Promise<void>;
  setFavorite(id: string, favorited: boolean): Promise<void>;
  setChips(chips: ChipConfig[]): Promise<void>;
  setOverride(id: string, override: MetadataOverride): Promise<void>;
  createPromptSkill(skill: Omit<SkillEntry, 'id'>): Promise<SkillEntry>;
  deletePromptSkill(id: string): Promise<void>;
  publish(id: string): Promise<{ prUrl: string }>;
  generateShareLink(id: string): Promise<string>;
  importFromLink(encoded: string): Promise<SkillEntry>;
}

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
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
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
  // Session browser
  SESSION_BROWSE: 'session:browse',
  SESSION_HISTORY: 'session:history',
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
  // Theme marketplace
  THEME_MARKETPLACE_LIST: 'theme-marketplace:list',
  THEME_MARKETPLACE_DETAIL: 'theme-marketplace:detail',
  THEME_MARKETPLACE_INSTALL: 'theme-marketplace:install',
  THEME_MARKETPLACE_UNINSTALL: 'theme-marketplace:uninstall',
  THEME_MARKETPLACE_PUBLISH: 'theme-marketplace:publish',
  THEME_MARKETPLACE_GENERATE_PREVIEW: 'theme-marketplace:generate-preview',
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
} as const;
