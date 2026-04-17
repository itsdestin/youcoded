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
  /** Model alias the session was started with (e.g. 'claude-sonnet-4-6') */
  model?: string;
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
    /** Edit/MultiEdit tool-result payloads carry structuredPatch hunks. */
    structuredPatch?: StructuredPatchHunk[];
    // Task 1.1: widened turn-complete payload so the reducer can attach the
    // per-turn model, token/cache usage, and the Anthropic requestId to the
    // completing AssistantTurn for UI surfacing. All optional — the field is
    // shared across event types, and turn-complete is the only current writer.
    /** Model ID used for the completing turn (e.g. "claude-opus-4-7"). */
    model?: string;
    /** Anthropic API request id from the JSONL line's top-level `requestId`. */
    anthropicRequestId?: string;
    /** Token + cache usage snapshot from message.usage. */
    usage?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    };
  };
}

// --- Chat view types ---

export type ToolCallStatus = 'running' | 'complete' | 'failed' | 'awaiting-approval';

// jsdiff-style hunk. Claude Code's Edit/MultiEdit tool results include
// `toolUseResult.structuredPatch`: pre-computed hunks with absolute file
// line numbers + interleaved context/add/del rows. Preferred over
// reconstructing a diff from old_string/new_string because line numbers
// reflect the real file position.
export interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Each string begins with ' ' (context), '-' (deletion), or '+' (addition). */
  lines: string[];
}

export interface ToolCallState {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  status: ToolCallStatus;
  requestId?: string;
  permissionSuggestions?: string[];
  response?: string;
  error?: string;
  /** Set when the tool result carries a structuredPatch (Edit/MultiEdit). */
  structuredPatch?: StructuredPatchHunk[];
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
  source: 'youcoded-core' | 'self' | 'plugin' | 'marketplace';
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

  // Marketplace redesign Phase 1 — soft filter/curation fields populated from
  // overrides/<id>.json; all optional so pre-extension cache reads still work.
  tags?: string[];
  tagline?: string;
  longDescription?: string;
  lifeArea?: string[];
  audience?: 'general' | 'developer';

  // Marketplace redesign Phase 1 — component inventory from extract-components.
  // `null` means extraction failed (see componentsError). UI should hide the
  // "What's inside" peek for null; empty object {} means the plugin genuinely
  // has no components.
  components?: SkillComponents | null;
  componentsError?: string;

  // Propagated from sync.js for UI "deprecated" badges. Present only when true.
  deprecated?: boolean;
  deprecatedAt?: string;

  // When true, the plugins grid should hide this entry because it is surfaced
  // through the dedicated Integrations tile instead (e.g. google-services,
  // imessage). The entry is still installable — just not double-listed.
  integrationOnly?: boolean;

  // Source info from index.json — needed by the in-app file viewer to fetch
  // raw SKILL.md/commands/agents content when the plugin isn't installed.
  // 'local' = subdir in wecoded-marketplace repo (sourceRef is that subdir).
  // 'url' = git URL (sourceRef is the clone URL).
  // 'git-subdir' = git URL with a subdir (sourceRef is clone URL, sourceSubdir is the subdir).
  sourceType?: string;
  sourceRef?: string;
  sourceSubdir?: string;
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

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  author?: { name?: string } | string;
  license?: string;
  recommends?: string[];   // soft recommendation — package works without these
  provides?: Record<string, { description: string; skill: string }>;
  optionalIntegrations?: Record<string, { whenAvailable: string; whenUnavailable: string }>;
  postInstall?: string;    // shell command run after install (trusted-org only)
}

// Tracked marketplace package — records what the marketplace installed
export interface PackageInfo {
  version: string;
  source: 'marketplace' | 'user';
  installedAt: string;
  removable: boolean;
  components: PackageComponent[];
  // Decomposition v3 §9.8: cross-device sync can surface a package that's
  // present in config but not yet on disk (e.g., Android pulled a desktop
  // config but hasn't installed the package yet). "pending" UIs can show an
  // Install CTA without confusing the user about whether it's really there.
  status?: 'installed' | 'pending';
}

export interface UserSkillConfig {
  version: 1 | 2;
  favorites: string[];
  chips: ChipConfig[];
  overrides: Record<string, MetadataOverride>;
  privateSkills: SkillEntry[];
  // v2: unified package tracking (replaces installed_plugins)
  packages?: Record<string, PackageInfo>;
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
  getFeatured?(): Promise<FeaturedData>;
}

// Marketplace redesign Phase 1 — discovery curation. Driven by featured.json
// in the wecoded-marketplace repo; edited via /feature admin skill.
export interface FeaturedHeroSlot {
  id: string;
  blurb: string;
  accentColor?: string;
}

export interface FeaturedRail {
  title: string;
  description?: string;
  slugs: string[];
}

export interface FeaturedData {
  hero?: FeaturedHeroSlot[];
  rails?: FeaturedRail[];
  // Legacy shape — passed through for older clients; to be dropped in Phase 2.
  skills?: Array<{ id: string; tagline?: string }>;
  themes?: Array<{ slug: string; tagline?: string }>;
}

// Marketplace redesign Phase 3 — integrations as a first-class kind.
// 'plugin' kind wraps an existing marketplace plugin + optional post-install
// slash command, avoiding a second install pipeline.
export type IntegrationKind = 'mcp' | 'shell' | 'http' | 'plugin';
export type IntegrationStatusValue =
  | 'not-installed'
  | 'installing'
  | 'needs-auth'
  | 'connected'
  | 'error';

export interface IntegrationSetup {
  type: 'script' | 'api-key' | 'macos-only' | 'plugin';
  path?: string;
  requiresOAuth?: boolean;
  oauthProvider?: string;
  keyName?: string;
  // setup.type === 'plugin' — the marketplace plugin id to install and an
  // optional slash command the app runs in a fresh session after install.
  pluginId?: string;
  postInstallCommand?: string;
}

export interface IntegrationEntry {
  slug: string;
  displayName: string;
  tagline: string;
  longDescription?: string;
  kind: IntegrationKind;
  setup: IntegrationSetup;
  status: 'available' | 'planned' | 'deprecated';
  accentColor?: string;
  lifeArea?: string[];
  // Relative path under integrations/icons/ in the marketplace repo; the UI
  // resolves this against the raw.githubusercontent.com base URL.
  iconUrl?: string;
  // Platforms where this integration can run. When present and the current
  // platform isn't listed, the card shows a "<platform>-only" affordance.
  platforms?: Array<'darwin' | 'linux' | 'win32'>;
}

export interface IntegrationIndex {
  version: string;
  integrations: IntegrationEntry[];
}

export interface IntegrationState {
  slug: string;
  installed: boolean;
  connected: boolean;
  lastSync?: string;
  error?: string;
}

// Marketplace redesign Phase 1 — per-entry component inventory for the
// "What's inside" peek on cards and detail overlays. Extracted at sync time
// by scripts/extract-components.js; `null` on the entry signals extraction
// failure and the UI should hide the peek.
export interface SkillComponents {
  skills: string[];
  hooks: string[];
  commands: string[];
  agents: string[];
  mcpServers: string[];
  hasHooksManifest: boolean;
  hasMcpConfig: boolean;
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

// Decomposition v3 §9.9: what SkillDetail needs to render integration badges.
// Populated by skill-provider.getIntegrationInfo() which reads the plugin's
// own plugin.json (if installed) or the marketplace entry (if not).
export interface IntegrationInfo {
  // Capabilities the package says it needs (with fallback behavior)
  optionalIntegrations: Array<{
    capability: string;
    installed: boolean;                 // does any installed plugin provide this?
    providerPackageId?: string;         // which one, if installed
    whenAvailable?: string;
    whenUnavailable?: string;
  }>;
  // Capabilities the package itself provides
  provides: Array<{ capability: string; description: string; skill: string }>;
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
  // Marketplace redesign Phase 1: featured (hero/rails) for the redesigned
  // discovery UI.
  SKILLS_GET_FEATURED: 'skills:get-featured',
  // Marketplace redesign Phase 3: integrations as a first-class content kind.
  INTEGRATIONS_LIST: 'integrations:list',
  INTEGRATIONS_INSTALL: 'integrations:install',
  INTEGRATIONS_UNINSTALL: 'integrations:uninstall',
  INTEGRATIONS_STATUS: 'integrations:status',
  INTEGRATIONS_CONFIGURE: 'integrations:configure',
  // Decomposition v3 §9.9: used by SkillDetail to render integration badges
  SKILLS_GET_INTEGRATION_INFO: 'skills:get-integration-info',
  // Decomposition v3 §9.10: onboarding bulk install + output-style apply
  SKILLS_INSTALL_MANY: 'skills:install-many',
  SKILLS_APPLY_OUTPUT_STYLE: 'skills:apply-output-style',
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
  // Repositions macOS traffic lights so they sit inside the floating chrome's
  // rounded header; null restores OS default. Called from theme-engine.
  WINDOW_SET_TRAFFIC_LIGHT_POS: 'window:set-traffic-light-pos',
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
  // Phase 4 — force-refresh the featured/index caches without waiting for
  // the 24h TTL. Useful right after /feature curation lands.
  MARKETPLACE_INVALIDATE_CACHE: 'marketplace:invalidate-cache',
  // In-app file viewer — reads a plugin's SKILL.md / command / agent markdown.
  // Tries the local install dir first, falls back to a raw GitHub URL derived
  // from the marketplace entry's sourceType/sourceRef.
  MARKETPLACE_READ_COMPONENT: 'marketplace:read-component',
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
  // Chrome-style live tear-off: spawn the peer window mid-drag (before pointerup)
  // once the pill has moved far enough from the header. Source window then
  // streams cursor positions via SESSION_DRAG_WINDOW_MOVE so the new window
  // tracks the cursor until the user releases.
  SESSION_DETACH_LIVE: 'session:detach-live',
  SESSION_DRAG_WINDOW_MOVE: 'session:drag-window-move',
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
  // Restore from backup — directional, user-initiated pull (separate from sync's merge semantics)
  SYNC_RESTORE_LIST_VERSIONS: 'sync:restore:list-versions',
  SYNC_RESTORE_PREVIEW: 'sync:restore:preview',
  SYNC_RESTORE_EXECUTE: 'sync:restore:execute',
  SYNC_RESTORE_PROGRESS: 'sync:restore:progress',
  SYNC_RESTORE_LIST_SNAPSHOTS: 'sync:restore:list-snapshots',
  SYNC_RESTORE_UNDO: 'sync:restore:undo',
  SYNC_RESTORE_DELETE_SNAPSHOT: 'sync:restore:delete-snapshot',
  SYNC_RESTORE_PROBE: 'sync:restore:probe',
  SYNC_RESTORE_BROWSE_URL: 'sync:restore:browse-url',
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

// --- Restore from backup types ---
// Restore is a one-time, directional, user-initiated pull that treats the remote as authoritative.
// This is distinct from sync (bidirectional merge) — different invariants, different code paths.

export type RestoreCategory =
  | 'memory'
  | 'conversations'
  | 'encyclopedia'
  | 'skills'
  | 'plans'
  | 'specs';

export interface RestorePoint {
  /** 'HEAD' for Drive/iCloud (HEAD-only backends), git SHA for GitHub (full history). */
  ref: string;
  timestamp: number;
  label: string;
  summary?: string;
}

/**
 * Restore mode. Two very different semantics:
 *   - 'merge': union. Remote→local adds + overwrites only (no local deletions),
 *              then local→remote uploads anything that was local-only. Reuses
 *              the sync loop's push/pull under the hood. Non-destructive on
 *              both sides. toDelete in the preview is always 0.
 *   - 'wipe':  mirror. Local tree is replaced with the backup's tree exactly.
 *              Files on device but NOT on the backup are deleted. Snapshot-first
 *              is forced ON so the user can always Undo within retention.
 */
export type RestoreMode = 'merge' | 'wipe';

export interface RestoreOptions {
  backendId: string;
  versionRef: string;
  categories: RestoreCategory[];
  snapshotFirst: boolean;
  mode: RestoreMode;
}

export interface CategoryPreview {
  category: RestoreCategory;
  remoteFiles: number;
  localFiles: number;
  toAdd: number;
  toOverwrite: number;
  /** Files on device NOT on the backup — wipe mode deletes these; merge leaves them. */
  toDelete: number;
  /** Merge-mode only: files present locally but NOT on backup (will be uploaded). */
  toUpload?: number;
  bytes: number;
}

export interface RestorePreview {
  perCategory: CategoryPreview[];
  totalBytes: number;
  estimatedSeconds: number;
  warnings: string[];
  /** Echoes the mode the preview was computed for — UI keys column labels off this. */
  mode: RestoreMode;
}

export interface RestoreResult {
  snapshotId?: string;
  categoriesRestored: RestoreCategory[];
  filesWritten: number;
  durationMs: number;
  /** true if skills/memory restored — app restart recommended to pick up new files. */
  requiresRestart: boolean;
}

export interface Snapshot {
  /** ISO timestamp, also used as directory name under ~/.claude/restore-snapshots/. */
  id: string;
  timestamp: number;
  categories: RestoreCategory[];
  backendId: string;
  sizeBytes: number;
  triggeredBy: 'restore' | 'manual';
}

export interface RestoreProgressEvent {
  category: RestoreCategory;
  filesDone: number;
  filesTotal: number;
  currentFile?: string;
  phase: 'snapshotting' | 'fetching' | 'staging' | 'swapping' | 'done';
}
