// ── backend-contract.ts — the one description of what the app's backend offers ──
//
// WHY (2026-09-29 one-core R2): the same feature list used to be kept by hand in
// SEVEN places — shared/types.ts's IPC constant, preload's inlined copy (the
// sandbox cannot import), ipc-handlers, remote-server's `case` labels,
// remote-shim, the workbench's fake backend, and useIpc.ts's second, mostly-`any`
// copy of the window.claude type. Only `session` and `on` were compile-checked.
// This file is the single source for:
//   1. IPC            — every channel NAME (types.ts re-exports it, so both doors
//                       and the tests read one list).
//   2. ChannelDef     — the shape of one entry in the channel table (an EMPTY
//                       table today; main/ipc/channel-table.ts holds it). R3 moves
//                       real channels in, one family at a time.
//   3. ClaudeApi      — the window.claude type. `Window['claude']` is derived from
//                       it (bottom of this file), so preload.ts, remote-shim.ts,
//                       the workbench's mock-shim.ts and every renderer call site
//                       are checked against ONE definition.
//
// Preload's own channel-name list stays HAND-WRITTEN on purpose (decision D10:
// the bridge is the security boundary and stays explicitly enumerated). Instead
// tests/backend-contract.test.ts fails when preload's list and IPC below
// disagree, in either direction.
//
// Type-only imports from main/ and renderer/ below (marketplace user + social
// cards, ModelChoice): erased at build, so nothing crosses the process boundary
// at runtime. They are the reason a few members are still typed against a
// non-shared file — R3 moves each type into shared/ as it tightens that family.

import type { VoiceBridge, VoiceVocabularyBridge } from './voice-types';
import type { PagesBridge } from './pages-types';
import type { OfficeBridge } from './office-types';
import type { SavedFolder, PickerFolder, SessionDefaults, ModelModes } from './prefs-types';
import type { TagListResult, TagMutationResult, TagDeleteResult, TagPatch } from './tags';
import type {
  DevSummarizeArgs, DevSummaryResult, DevSubmitArgs, DevSubmitResult, DevInstallWorkspaceResult,
  DevSetupWorkspaceResult, DevSetupStatus, DevOpenSessionInArgs,
} from './dev-types';
import type {
  ApiResult, AuthStartResponse, AuthPollResponse, MarketplaceUser, AccountExportResult,
} from './account-types';
import type {
  UpdateDownloadResult, UpdateLaunchResult, UpdateCachedDownload, UpdateBetaChannelState, UpdateChangelogResult,
} from './update-install-types';
import type { SessionInfo, TranscriptEvent } from './types';
import type { MarketplaceChannelTypes, SkillsBridge, MarketplaceBridge, FirstRunBridge } from './marketplace-channel-types';
import type { SyncChannelTypes } from './sync-channel-types';
import type { SessionChannelTypes } from './session-channel-types';
import type { NativeChannelTypes } from './native-channel-types';
import type { ModelsChannelTypes } from './models-channel-types';
import type { FilesChannelTypes } from './files-channel-types';
import type { AppChannelTypes } from './app-channel-types';
import type { OfficeChannelTypes } from './office-channel-types';
export type { MarketplaceThumbs } from './marketplace-channel-types';
import type {
  NativeSendResult, SessionContext, SessionContextText,
  SessionMetaResult, HandoffAttemptResult, HandoffCreateParams,
  SpecialistsEvent, ShellEvent,
} from './types';
import type { Capabilities } from './capabilities';

// ── Channel names ──────────────────────────────────────────────────────────────

// IPC channel names
export const IPC = {
  // Renderer -> Main
  SESSION_CREATE: 'session:create',
  // WHY: pending handoff is not a started session; keep its actions off session:create.
  HANDOFF_BEGIN: 'handoff:begin',
  HANDOFF_STATUS: 'handoff:status',
  HANDOFF_WAIT: 'handoff:wait',
  HANDOFF_RETRY: 'handoff:retry',
  HANDOFF_SAVED_COPY: 'handoff:saved-copy',
  HANDOFF_FORCE: 'handoff:force',
  HANDOFF_CANCEL: 'handoff:cancel',
  HANDOFF_CREATE_PARAMS: 'handoff:create-params',
  SESSION_DESTROY: 'session:destroy',
  SESSION_INPUT: 'session:input',
  SESSION_RESIZE: 'session:resize',
  SESSION_LIST: 'session:list',
  SESSION_SWITCH: 'session:switch',
  // Remote access batch 2 (§2): a window tells main which session it shows.
  SESSION_SELECTED: 'session:selected',
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
  // Marketplace redesign Phase 1: featured (hero/rails) for the redesigned
  // discovery UI.
  SKILLS_GET_FEATURED: 'skills:get-featured',
  // Marketplace redesign Phase 3: integrations as a first-class content kind.
  INTEGRATIONS_LIST: 'integrations:list',
  INTEGRATIONS_INSTALL: 'integrations:install',
  INTEGRATIONS_UNINSTALL: 'integrations:uninstall',
  INTEGRATIONS_STATUS: 'integrations:status',
  INTEGRATIONS_CONFIGURE: 'integrations:configure',
  // Re-runs postInstallCommand for an already-installed integration; used
  // by the detail overlay's Connect button when state is installed-but-not-
  // connected (e.g. OAuth expired).
  INTEGRATIONS_CONNECT: 'integrations:connect',
  // Static-per-session lookup — returns 'darwin' | 'win32' | 'linux' | 'android'.
  // Used by the integration cards to gate UI by platform before the user
  // clicks (backend integration-installer.ts also re-checks).
  PLATFORM_GET: 'platform:get',
  // Decomposition v3 §9.9: used by SkillDetail to render integration badges
  SKILLS_GET_INTEGRATION_INFO: 'skills:get-integration-info',
  // Decomposition v3 §9.10: onboarding bulk install + output-style apply
  SKILLS_INSTALL_MANY: 'skills:install-many',
  SKILLS_APPLY_OUTPUT_STYLE: 'skills:apply-output-style',
  TERMINAL_READY: 'session:terminal-ready',
  // Main -> Renderer
  SESSION_CREATED: 'session:created',
  SESSION_DESTROYED: 'session:destroyed',
  // Plan 2b Task 8: pushed to the renderer + remote when another device took over
  // a conversation this device held — the holder-side takeover ends the local
  // session and the UI shows a "moved to <device>" banner.
  SESSION_MOVED: 'session:moved',
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
  UPDATE_CHANGELOG: 'update:changelog',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_CANCEL: 'update:cancel',
  UPDATE_LAUNCH: 'update:launch',
  UPDATE_PROGRESS: 'update:progress',
  UPDATE_GET_CACHED_DOWNLOAD: 'update:get-cached-download',
  UPDATE_GET_BETA_CHANNEL: 'update:get-beta-channel',   // () -> { betaChannel, effective }
  UPDATE_SET_BETA_CHANNEL: 'update:set-beta-channel',   // (enabled: boolean)
  OPEN_EXTERNAL: 'shell:open-external',
  SHOW_ITEM_IN_FOLDER: 'shell:show-item-in-folder',
  // Open a local file with the OS default app (HTML→browser, .docx→Word, etc.).
  // Desktop-only: Android has no desktop shell; remote-shim no-ops it.
  OPEN_PATH: 'shell:open-path',
  PERMISSION_RESPOND: 'permission:respond',
  // Remote settings
  REMOTE_GET_CONFIG: 'remote:get-config',
  REMOTE_SET_PASSWORD: 'remote:set-password',
  REMOTE_SET_CONFIG: 'remote:set-config',
  REMOTE_DETECT_TAILSCALE: 'remote:detect-tailscale',
  REMOTE_GET_CLIENT_COUNT: 'remote:get-client-count',
  REMOTE_GET_CLIENT_LIST: 'remote:get-client-list',
  REMOTE_STATUS: 'remote:status',
  REMOTE_DEVICES_LIST: 'remote:devices:list',
  REMOTE_DEVICES_RENAME: 'remote:devices:rename',
  REMOTE_DEVICES_UNPAIR: 'remote:devices:unpair',
  REMOTE_INSTALL_TAILSCALE: 'remote:install-tailscale',
  REMOTE_AUTH_TAILSCALE: 'remote:auth-tailscale',
  // Remote access batch 2 (§6): Refresh on a phone. The desktop answers not-remote.
  REMOTE_REHYDRATE: 'remote:rehydrate',
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
  SESSION_MENU_LOCK: 'session:menu-lock',
  // Broadcast when session metadata changes (carries a flag + value)
  SESSION_META_CHANGED: 'session:meta-changed',
  // Custom session tags (registry CRUD + application) and per-session notes.
  SESSION_SET_TAG: 'session:set-tag',   // (sessionId, tagId, value)
  SESSION_SET_NOTE: 'session:set-note', // (sessionId, note)
  // Session naming (2026-09-09). get/set are the Assistant-settings preference;
  // title/rename are per-conversation name ownership. `rename` accepts EITHER a
  // live desktop session id or a saved conversation id — the handler resolves
  // both through sessionIdMap. There is deliberately NO return-to-automatic
  // channel: review 3 removed that action from the dialog (contract R11), and an
  // unreachable write endpoint on the remote WebSocket is worse than a missing
  // feature.
  SESSION_NAMING_GET: 'session-naming:get',       // () -> { mode, model }
  SESSION_NAMING_SET: 'session-naming:set',       // ({ mode, model })
  SESSION_NAMING_TITLE: 'session-naming:title',   // (sessionId, fallback) -> { title, manual }
  SESSION_NAMING_RENAME: 'session-naming:rename', // (sessionId, title)
  SESSION_GET_META: 'session:get-meta', // (sessionId) → { tags, note, supported }
  // Welcome back (design 2026-09-24 §3): the per-install "open at last
  // shutdown" list. Desktop-only — Android always answers []/{ok:true}.
  SESSION_REOPEN_LIST: 'session:reopen-list',     // () → string[] (conversation ids)
  SESSION_FORGET_REOPEN: 'session:forget-reopen', // (ids: string[]) → { ok: true }
  TAGS_LIST: 'tags:list',
  TAGS_CREATE: 'tags:create',           // (label, color)
  TAGS_UPDATE: 'tags:update',           // (id, { label?, color?, archived? })
  TAGS_DELETE: 'tags:delete',           // (id)
  TAGS_CHANGED: 'tags:changed',         // push: registry mutated
  // Folder switcher
  FOLDERS_LIST: 'folders:list',
  FOLDERS_ADD: 'folders:add',
  FOLDERS_REMOVE: 'folders:remove',
  FOLDERS_RENAME: 'folders:rename',
  // Local-only description on a saved folder — sibling of FOLDERS_RENAME, same
  // store (saved-folders.ts), never syncs (see SavedFolder.description).
  FOLDERS_SET_DESCRIPTION: 'folders:set-description',
  // Theme system
  THEME_RELOAD: 'theme:reload',   // Main -> Renderer: a theme file changed
  THEME_LIST: 'theme:list',       // Renderer -> Main: get list of user theme slugs
  THEME_READ_FILE: 'theme:read-file', // Renderer -> Main: read a user theme JSON by slug
  THEME_WRITE_FILE: 'theme:write-file',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_SET_ICON: 'window:set-icon', // theme-driven window + dock icon hot-swap
  // Repositions macOS traffic lights so they sit inside the floating chrome's
  // rounded header; null restores OS default. Called from theme-engine.
  WINDOW_SET_TRAFFIC_LIGHT_POS: 'window:set-traffic-light-pos',
  // Welcome back's in-app quit warning (design §4, plan T3). Electron-only
  // (window.claude.window) — no remote-shim/Android twin, same as the other
  // WINDOW_* entries above: a phone or browser tab never owns a desktop
  // session for this to ask about.
  WINDOW_CLOSE_REQUEST: 'window:close-request',                       // Main -> Renderer (push): {requestId, sessions}
  WINDOW_ANSWER_CLOSE: 'window:answer-close',                         // Renderer -> Main: {requestId, close, reopen?}
  WINDOW_CLOSE_REQUEST_CANCELLED: 'window:close-request-cancelled',   // Main -> Renderer (push): {requestId}
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
  // The sign-in wait screen's Cancel (2026-10-03). Replaced FIRST_RUN_DEV_MODE_DONE: setup has no Developer Mode step now.
  FIRST_RUN_CANCEL_AUTH: 'first-run:cancel-auth',
  FIRST_RUN_SKIP: 'first-run:skip',
  // First-run local models (2026-09-14): local setup's suggestion, finishing setup
  // on a model app already running, and the first download's band above the
  // message box. Desktop-only: first-run never shows on a phone or a remote browser.
  FIRST_RUN_LOCAL_SETUP: 'first-run:local-setup',
  FIRST_RUN_CONNECT_LOCAL_APP: 'first-run:connect-local-app',
  FIRST_RUN_LOCAL_DOWNLOAD: 'first-run:local-download',
  FIRST_RUN_RESUME_LOCAL_DOWNLOAD: 'first-run:resume-local-download',
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
  // Synced project description (Task 3). preload.ts keeps its own inlined copy
  // of this constant (sandboxed preload can't import); this is the copy
  // ipc-handlers.ts resolves IPC.SYNC_SPACES_SET_PROJECT_DESCRIPTION against.
  SYNC_SPACES_SET_PROJECT_DESCRIPTION: 'syncspaces:set-project-description',
  SYNC_SPACES_STOP_PROJECT: 'syncspaces:stop-project',
  // Conversation-lease takeover (Plan 2b Task 9). query = who holds this session;
  // takeover = ask-hand-off-then-poll-and-acquire; force = overwrite a stale lease.
  SYNC_SPACES_LEASE_QUERY: 'syncspaces:lease-query',
  SYNC_SPACES_LEASE_TAKEOVER: 'syncspaces:lease-takeover',
  SYNC_SPACES_LEASE_FORCE: 'syncspaces:lease-force',
  // Device registry (Plan 2b spec §10a) — the "Your devices" list + rename.
  SYNC_SPACES_LIST_DEVICES: 'syncspaces:list-devices',
  SYNC_SPACES_RENAME_DEVICE: 'syncspaces:rename-device',
  SYNC_SPACES_REMOVE_DEVICE: 'syncspaces:remove-device',
  SYNC_SPACES_EVENT: 'syncspaces:event',
  // Connect-GitHub modal (device-flow auth) — lets non-developers connect GitHub
  // in-app so enabling Sync never dead-ends on "gh not installed / not signed in".
  // status/install are plain request-response; connect-start kicks off main-side
  // device-flow polling and pushes GITHUB_CONNECT_DONE when it settles.
  GITHUB_STATUS: 'github:status',
  GITHUB_CONNECT_START: 'github:connect-start',
  GITHUB_CONNECT_CANCEL: 'github:connect-cancel',
  GITHUB_INSTALL_GH: 'github:install-gh',
  GITHUB_DISCONNECT: 'github:disconnect', // clears the app's stored token (Connected accounts)
  GITHUB_CONNECT_DONE: 'github:connect-done', // push: {ok, login?, error?}
  // Multi-window detach subsystem (Renderer <-> Main)
  WINDOW_GET_ID: 'window:get-id',
  WINDOW_DIRECTORY_UPDATED: 'window:directory-updated',
  WINDOW_GET_DIRECTORY: 'window:get-directory',
  WINDOW_LEADER_CHANGED: 'window:leader-changed',
  WINDOW_OPEN_DETACHED: 'window:open-detached',
  WINDOW_FOCUS_AND_SWITCH: 'window:focus-and-switch',
  SESSION_OWNERSHIP_ACQUIRED: 'session:ownership-acquired',
  SESSION_OWNERSHIP_LOST: 'session:ownership-lost',
  // Pull half of SESSION_OWNERSHIP_ACQUIRED. A window created BY a tear-off is
  // handed its session before its renderer can subscribe, and Electron drops
  // (never queues) a send with no listener — so the renderer asks for what it
  // inherited once mounted. Returns SessionOwnershipAcquired[] and clears it.
  DETACH_CLAIM_PENDING: 'detach:claim-pending',
  // The ONE way a screen is filled (one-core R5-2, session-open.ts): invoke({ sessionId, have?, pty? }) → the newest page, the
  // record's recent past and what only memory holds, or just the events a reconnecting screen missed. Replaced the remote
  // snapshot, the torn-off window's replay and the hook-event replay.
  SESSION_OPEN: 'session:open',
  // Stop receiving ONE session's pushes (one-core R5-3). `session:open` starts a phone's watch (and fills it); this ends it. A phone
  // watches the conversation on its screen plus a few it looked at lately; everything else reaches it only as `session:summary`.
  SESSION_UNWATCH: 'session:unwatch',
  SESSION_SEND_OUTCOMES: 'session:send-outcomes',
  // Push to everyone: the small per-session facts (working, asks waiting, attention, history) the session strip's dots are drawn from,
  // so a phone can colour a session it does not watch (R5-1 added it, R5-3 reads it).
  SESSION_SUMMARY: 'session:summary',
  // Numbered, session-scoped push of the shared lines and live facts the host's record publishes (one-core R5-4a): the queue of messages
  // waiting on the computer, the model label, the model-switch and "Conversation cleared" dividers, the compaction spinner and the
  // prompt cards. Payload `SessionLive` (shared/session-live-types.ts). Every screen draws them; none infers them (capabilities.sessionRecord).
  SESSION_LIVE: 'session:live',
  // Push: a Claude Code session's permission mode as the HOST read it off the terminal (one-core R5-4a). Payload `{ sessionId, mode }`. The Android
  // app's own runtime pushes the same name for the same fact, so one handler serves both.
  SESSION_PERMISSION_MODE: 'session:permission-mode',
  // A computer window reports a card it saw in its terminal; the host numbers it and publishes it to every screen (one-core R5-4a).
  // Computer windows only: a phone's terminal copy is not read for cards, it draws the host's.
  // Push to ONE window: its fill never completed (the hold expired), so it must fill that conversation again (R5-2 review fix).
  SESSION_REFILL: 'session:refill',
  // The asks still open in a session, replayed at the end of every fill (a push in the answer's `after`, never sent by itself).
  HOOK_REPLAY_COMPLETE: 'hook:replay-complete',
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
  SESSION_DRAG_ADOPT: 'session:drag-adopt',
  SESSION_DROP_RESOLVE: 'session:drop-resolve',
  CROSS_WINDOW_CURSOR: 'session:cross-window-cursor',
  // Perf cycle 2: request/response. Returns the last page of history (the most
  // recent PAGE_TURNS turns), or the page before a cursor. The whole-transcript
  // replay it replaced is gone (R5-2): a screen fills through SESSION_OPEN.
  TRANSCRIPT_PAGE: 'transcript:page',
  // Appearance sync across peer windows — Renderer → Main broadcasts, Main
  // → other Renderers applies without re-broadcasting. Lets a theme change
  // in window 2 propagate to window 1 without a reload.
  APPEARANCE_BROADCAST: 'appearance:broadcast',
  APPEARANCE_SYNC: 'appearance:sync',
  APPEARANCE_GET_FAVORITE_THEMES: 'appearance:get-favorite-themes',
  APPEARANCE_FAVORITE_THEME: 'appearance:favorite-theme',
  // Buddy floater (desktop-only MVP)
  BUDDY_SHOW: 'buddy:show',
  BUDDY_HIDE: 'buddy:hide',
  BUDDY_TOGGLE_CHAT: 'buddy:toggle-chat',
  BUDDY_SET_SESSION: 'buddy:set-session',
  BUDDY_SUBSCRIBE: 'buddy:subscribe',
  BUDDY_UNSUBSCRIBE: 'buddy:unsubscribe',
  BUDDY_GET_VIEWED_SESSION: 'buddy:get-viewed-session',
  // Renderer → main drag events. Fire-and-forget because drag generates
  // ~60 events/sec while the pointer moves; invoke() round-trips would
  // starve the renderer's event loop. Main clamps and calls setPosition.
  BUDDY_MOVE_MASCOT: 'buddy:move-mascot',
  // Capture the desktop with buddy windows excluded, write to a temp PNG,
  // and push the file path to the chat renderer on BUDDY_ATTACH_FILE.
  // Invoked from the capture-icon renderer; main does the hide/capture/
  // restore sequence because the renderer can't hide Electron windows.
  BUDDY_CAPTURE_DESKTOP: 'buddy:capture-desktop',
  // Main → chat-renderer push. Chat renderer's InputBar listens and adds
  // the file as an attachment (same pipeline as clipboard-image paste).
  BUDDY_ATTACH_FILE: 'buddy:attach-file',
  // ── Buddy upgrades (action bar, dismiss, dock/peek) ──
  // Fire-and-forget: mascot + bar renderers report pointer enter/leave; main
  // coalesces with a grace timeout to decide bar visibility.
  // Fire-and-forget: mascot renderer signals drag release so main can run
  // edge-snap detection against the window's final bounds.
  BUDDY_DRAG_ENDED: 'buddy:drag-ended',
  // Fire-and-forget: is the pointer over the mascot's drawn body (vs. the empty rest of his window)? Main toggles
  // click-through on it.
  BUDDY_MASCOT_HIT: 'buddy:mascot-hit',
  // Restore + focus the main window and switch it to the buddy's viewed session.
  BUDDY_OPEN_MAIN: 'buddy:open-main',
  // Hide the buddy for this app run only (preference stays enabled).
  BUDDY_DISMISS: 'buddy:dismiss',
  BUDDY_GET_STATUS: 'buddy:get-status',
  // Main → all windows: { dismissed, visible } so open Settings panels update live.
  BUDDY_STATUS_CHANGED: 'buddy:status-changed',
  // Main → bar renderer: fade the action bar in/out (window stays shown; CSS animates).
  BUDDY_BAR_STATE: 'buddy:bar-state',
  // Main → mascot renderer: dock/peek state for the sink animation + peek pose.
  BUDDY_MASCOT_STATE: 'buddy:mascot-state',
  // Main → chat renderer: entrance/exit animation cue around show/hide.
  BUDDY_CHAT_STATE: 'buddy:chat-state',
  // ── The Linux/KDE buddy helper (docs/active/design/2026-09-04-linux-buddy-helper/) ──
  // On a native-Wayland desktop an app is not allowed to move its own windows,
  // so the buddy appears but cannot be dragged. A small script that runs inside
  // KDE's window manager can move it. These three channels are the app's side
  // of that script: ask whether it is needed/possible/present, put it in the
  // user's KDE settings, and take it back out again.
  //
  // Deliberately three surfaces, not five: buddy has NO Android (SessionService.kt)
  // or remote-server presence today, and adding one would turn this feature into
  // a platform-parity sweep (design §4). ipc-channels.test.ts's `buddy:*` block
  // records that omission so it does not read as an oversight.
  BUDDY_HELPER_STATUS: 'buddy:helper-status',
  BUDDY_INSTALL_HELPER: 'buddy:install-helper',
  BUDDY_REMOVE_HELPER: 'buddy:remove-helper',
  // Main → main window: switch active session (sent by buddy:open-main).
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
  // Managed development workspace (contract R9/R10). Separate from install-workspace
  // above, which targets a fixed folder and pulls into an existing one.
  DEV_SETUP_WORKSPACE: 'dev:setup-workspace',
  DEV_SETUP_STATUS: 'dev:setup-status',
  DEV_SETUP_CLEAR: 'dev:setup-clear',
  DEV_INSTALL_PROGRESS: 'dev:install-progress',
  DEV_OPEN_SESSION_IN: 'dev:open-session-in',
  // Performance / GPU settings — not app:restart because future restart-required
  // settings (e.g. renderer process changes) can reuse the same generic channel.
  PERFORMANCE_GET_CONFIG: 'performance:get-config',
  PERFORMANCE_SET_CONFIG: 'performance:set-config',
  APP_RESTART: 'app:restart',
  // System namespace — hardware back button bridge (Android only)
  SYSTEM_NOTIFY_STACK_STATE: 'system:notify-stack-state',
  SYSTEM_BACK: 'system:back',
  // ---- Native runtime (YouCoded first-party harness — platform roadmap Phase 1+) ----
  // Capability probe: false everywhere until Phase 1 ships the engine.
  NATIVE_SUPPORTED: 'native:supported',
  // ---- Native runtime Plan A (Phase 1): session I/O + provider management ----
  NATIVE_SEND: 'native:send',
  // Task 11: cancel/edit a queued-but-not-yet-sent message. invoke →
  // NativeSessionHost.removeQueued(sessionId, queueId): boolean.
  NATIVE_QUEUE_REMOVE: 'native:queue-remove',
  // "Send now" on a waiting message: invoke → NativeSessionHost.sendQueuedNow
  // (sessionId, queueId): boolean — stops the current task, sends this next.
  NATIVE_QUEUE_SEND_NOW: 'native:queue-send-now',
  NATIVE_INTERRUPT: 'native:interrupt',
  // Stalled-turn Retry (fire-and-forget like interrupt above). Re-runs the ONE
  // parked step; unlike interrupt it never cascades to specialist children or
  // cancels pending permission asks.
  NATIVE_RETRY: 'native:retry',
  // M3 item 2 — user-initiated /compact for a native session. invoke (not send):
  // the caller needs the {ok, reason} result to explain a refusal.
  NATIVE_COMPACT: 'native:compact',
  // M3 item 2 — /clear as a context barrier. invoke: the caller needs {ok, reason}.
  NATIVE_CLEAR: 'native:clear',
  NATIVE_INVOKE_SKILL: 'native:invoke-skill',
  NATIVE_SET_BINDING: 'native:set-binding',
  // U11: fit-checked switch from the model picker (NativeSwitchResult).
  NATIVE_SWITCH_MODEL: 'native:switch-model',
  NATIVE_SET_PERMISSION_MODE: 'native:set-permission-mode',
  // Read the session's current native permission mode. Seeds the StatusBar chip
  // on create/resume so a fresh Coder session shows AUTO EDIT (not the default ASK).
  NATIVE_GET_PERMISSION_MODE: 'native:get-permission-mode',
  // push → { sessionId, mode } whenever a session's mode is seeded or changed,
  // to every window showing it and every phone. The get above can answer
  // before a starting session has its mode; this push corrects it.
  NATIVE_PERMISSION_MODE: 'native:permission-mode',
  NATIVE_GET_CONTEXT_PREFERENCES: 'native:get-context-preferences',
  NATIVE_SET_CONTEXT_PREFERENCES: 'native:set-context-preferences',
  NATIVE_GET_STEP_GUARD: 'native:get-step-guard',
  NATIVE_SET_STEP_GUARD: 'native:set-step-guard',
  NATIVE_SESSIONS_LIST: 'native:sessions-list',
  NATIVE_KILL_SHELL: 'native:kill-shell',   // G-1: the Bash card's Stop button
  // admin-password design §2.5: the card's Confirm button. Request-response —
  // the card needs the boolean to know whether to show the ask as ended.
  NATIVE_SUBMIT_ADMIN_PASSWORD: 'native:submit-admin-password',
  // "What the assistant was given" (2026-09-10): the session-start push carrying
  // the inventory, and the on-demand read of ONE file's text. Two channels
  // because file bodies do not belong in a push — see SessionContext above.
  NATIVE_SESSION_CONTEXT: 'native:session-context',
  NATIVE_SESSION_CONTEXT_TEXT: 'native:session-context-text',
  PROVIDER_LIST: 'provider:list',
  PROVIDER_UPSERT: 'provider:upsert',
  PROVIDER_REMOVE: 'provider:remove',
  PROVIDER_TEST: 'provider:test',
  PROVIDER_SET_KEY: 'provider:set-key',
  PROVIDER_CATALOG: 'provider:catalog',
  // ---- Sign in with ChatGPT (design 2026-09-04, backend design 2026-09-05 §5) ----
  // status → ChatGptAccountStatus (shared/chatgpt-types.ts); the three verbs →
  // boolean, or a THROWN sentence the card renders verbatim. Kill switch
  // YOUCODED_CHATGPT=0: the handlers stay registered (parity) and answer
  // signed-out / false.
  CHATGPT_STATUS: 'chatgpt:status',
  CHATGPT_SIGN_IN: 'chatgpt:sign-in',
  CHATGPT_CANCEL_SIGN_IN: 'chatgpt:cancel-sign-in',
  CHATGPT_SIGN_OUT: 'chatgpt:sign-out',
  // Sign in with OpenRouter (connection-trust §3.5): status → OpenRouterSignInStatus
  // (shared/provider-types.ts); sign-in / cancel → boolean, or a THROWN sentence.
  OPENROUTER_SIGN_IN_STATUS: 'openrouter:sign-in-status',
  OPENROUTER_SIGN_IN: 'openrouter:sign-in',
  OPENROUTER_CANCEL_SIGN_IN: 'openrouter:cancel-sign-in',
  // ---- Claude Code's own sign-in, read LIVE (2026-09-09) ----
  // → ClaudeAccountStatus (shared/claude-account-types.ts). Payload
  // `{refresh?: true}` drops the cache first. There is no sign-in/sign-out verb
  // here on purpose: Claude Code owns its login, and the app has never had a
  // way to clear it (the card says to use /logout in a terminal).
  CLAUDE_CODE_STATUS: 'claude-code:status',
  // Install Claude Code on demand (first-run local models, F-5): setup no longer
  // installs it for everyone, so Settings offers it. Desktop and remote desktop only.
  CLAUDE_CODE_INSTALL: 'claude-code:install',
  // ---- WebSearch providers (Phase 2 Plan B): keyed Tavily/Exa upgrades ----
  // list = the fixed upgradeable-backend rows (hasKey flags); set/remove-key
  // manage the encrypted key; test = never-throws connectivity check.
  SEARCH_LIST: 'search:list',
  SEARCH_SET_KEY: 'search:set-key',
  SEARCH_REMOVE_KEY: 'search:remove-key',
  SEARCH_TEST: 'search:test',
  // ---- YouCoded Pages (Phase 1) — shared/pages-types.ts PagesBridge ----
  PAGES_LIST: 'pages:list',
  PAGES_GET: 'pages:get',
  PAGES_SET_PINNED: 'pages:set-pinned',
  PAGES_SET_DATA: 'pages:set-data',
  PAGES_CHANGED: 'pages:changed',
  // ---- Phase 2: connections, keys and the one door out of a page ----
  PAGES_APPROVE: 'pages:approve',
  PAGES_REMOVE_CONNECTION: 'pages:remove-connection',
  PAGES_REFRESH: 'pages:refresh',
  PAGES_SAVED_KEYS: 'pages:saved-keys',
  PAGES_DELETE_SAVED_KEY: 'pages:delete-saved-key',
  PAGES_FETCH: 'pages:fetch',
  PAGES_PLAID: 'pages:plaid', // bank balances via main/pages/plaid.ts, desktop only
  // ---- Live sockets and camera video a page holds through main (spec 2026-10-04); events ride PAGES_SOCKET_EVENT ----
  PAGES_SOCKET_OPEN: 'pages:socket-open',
  PAGES_SOCKET_SEND: 'pages:socket-send',
  PAGES_SOCKET_CLOSE: 'pages:socket-close',
  PAGES_SOCKET_PING: 'pages:socket-ping',
  PAGES_SOCKET_EVENT: 'pages:socket-event',
  PAGES_VIDEO_START: 'pages:video-start',
  PAGES_VIDEO_STOP: 'pages:video-stop',
  PAGES_VIDEO_PING: 'pages:video-ping',
  // ---- Remembered "Always allow" rules (M5 2a: permissions management UI) ----
  // list = every project's stored grants; remove/remove-project revoke them.
  // Keyed by PROJECT SLUG, not cwd — permissions.json never stored the cwd for
  // pre-existing entries and nativeStoreSlug is lossy, so the slug is the only
  // stable handle the renderer can send back.
  // ---- fs:read-head — first bytes of a user-chosen file for a preview tile ----
  // Capped in main at READ_HEAD_MAX_BYTES (shared/read-head.ts) whatever the
  // renderer asks for; sensitive paths refused. See main/fs-read-head.ts.
  FS_READ_HEAD: 'fs:read-head',
  FILE_UPLOAD: 'file:upload',
  PERMISSIONS_LIST: 'permissions:list',
  PERMISSIONS_REMOVE: 'permissions:remove',
  PERMISSIONS_REMOVE_PROJECT: 'permissions:remove-project',
  // ---- Specialists 1c (Task 8): roster + tier reads/writes + card actions ----
  // list ALWAYS re-reads the three definition folders (never a cached
  // snapshot) so a file dropped in a moment ago shows up without a Refresh
  // click; delegated-get/set are the two model-tier reads/writes; steer/
  // interrupt are the card's user-facing "send a note" / "stop" actions.
  // specialists:event is a PUSH (no request) — the delegation ledger's own
  // write is what triggers it, never a direct emit from a handler here.
  SPECIALISTS_LIST: 'specialists:list',
  SPECIALISTS_DELEGATED_GET: 'specialists:delegated-get',
  SPECIALISTS_DELEGATED_SET: 'specialists:delegated-set',
  SPECIALISTS_STEER: 'specialists:steer',
  SPECIALISTS_INTERRUPT: 'specialists:interrupt',
  SPECIALISTS_EVENT: 'specialists:event',
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
  // One write for every engine-wide setting — { contextSize?, speed? } (design
  // §B). Both are applied only once no reply is streaming, so a switch flipped
  // mid-answer cannot kill the answer. ENGINE_SET_CONTEXT above is now a thin
  // alias onto this for the callers already wired to it.
  ENGINE_SET_CONFIG: 'engine:set-config',
  // Open a plain-shell session (SessionProvider 'shell') in the folder the
  // calling window is working in and TYPE the command onto its prompt —
  // invoke(command) → { sessionId }. Nothing is executed: the user presses
  // Enter. The renderer that made the call selects the session it gets back.
  ENGINE_RUN_IN_TERMINAL: 'engine:run-in-terminal',
  // What a faster engine build needs installed before it can be offered
  // (Linux ROCm) — 2026-09-05 local-engine upgrades §A3/§A5.
  ENGINE_PREREQS: 'engine:prereqs',
  MODELS_CURATED: 'models:curated',
  MODELS_SEARCH: 'models:search',
  MODELS_QUANTS: 'models:quants',
  MODELS_DOWNLOAD: 'models:download',
  MODELS_DOWNLOAD_CANCEL: 'models:download-cancel',
  MODELS_DOWNLOAD_PROGRESS: 'models:download-progress',  // push
  MODELS_DELETE: 'models:delete',
  MODELS_INSTALLED: 'models:installed',
  // Resume an interrupted download from its manifest (2026-08-26) — invoke(modelId)
  // → { downloadId }. Replaces MODELS_ORPHANED_PARTIALS, removed the same day.
  MODELS_RESUME: 'models:resume',
  // ---- Per-model settings + vision (2026-09-05 local-engine upgrades) ----
  // Read one model's stored settings — invoke(modelId) -> StoredModelSettings.
  // The READ is the stored shape, not the four fields the dialog writes: the
  // dialog also has to show `pendingApply` ("Applies after the current reply")
  // and `lastLoadError`, and neither of those is anything the user can set.
  MODELS_SETTINGS: 'models:settings',
  // Save one model's settings — invoke(modelId, patch) -> StoredModelSettings.
  // The patch is `ModelSettingsWrite`: the four user-settable fields, plus the
  // `dismissMemoryWarning` SIGNAL. It is a signal and not a value because the
  // number that gets stored is the resolved effective context length, and only
  // main knows how the per-model setting and the engine-wide default combine.
  MODELS_SET_SETTINGS: 'models:set-settings',
  // Fetch the vision projector for a model already on disk and move both into a
  // folder of its own — invoke(modelId) -> { downloadId }. Progress arrives on
  // the ordinary models:download-progress stream.
  MODELS_ADD_VISION: 'models:add-vision',
  ENDPOINTS_DETECT: 'endpoints:detect',
  // ---- Model memory lifecycle (2026-07-14): per-model residency + guards ----
  ENGINE_MODELS: 'engine:models',                 // invoke → EngineModel[] with live state
  ENGINE_MODELS_CHANGED: 'engine:models-changed', // push → EngineModel[] on any state change
  NATIVE_MODEL_STATE: 'native:model-state',       // push → per-session bound-model state
  NATIVE_SHELL_EVENT: 'native:shell-event',       // push → one background command's run record changed (G-1)
  MODELS_MEMORY_CHECK: 'models:memory-check',     // invoke(modelId) → MemoryVerdict
  MODELS_LOAD: 'models:load',                     // invoke(modelId) → true ([Reload Model])
  // ---- Voice prompting (design 2026-09-05) ----
  // Mirrors preload.ts. Added here when the buddy-helper branch's channel-map
  // guard caught them as preload-only: the voice work declared them on one side
  // of the pair only, which is exactly the drift that guard exists to name.
  VOICE_STATUS: 'voice:status',
  VOICE_DOWNLOAD: 'voice:download',
  VOICE_START: 'voice:start',
  VOICE_STOP: 'voice:stop',
  VOICE_CANCEL: 'voice:cancel',
  VOICE_MIC_ACCESS: 'voice:mic-access',
  VOICE_VOCABULARY_GET: 'voice:vocabulary-get',
  VOICE_VOCABULARY_SAVE: 'voice:vocabulary-save',
  VOICE_AUDIO: 'voice:audio',
  VOICE_EVENT: 'voice:event',   // push
  // Office (main/ipc/office.ts). Requests the editor page makes, and the window's answers to main's pushes.
  OFFICE_STATUS: 'office:status',
  OFFICE_CREATE: 'office:create',
  OFFICE_PICK: 'office:pick',
  OFFICE_OPEN: 'office:open',
  OFFICE_INVOKE: 'office:invoke',
  OFFICE_CLOSE: 'office:close',
  OFFICE_VERSIONS: 'office:versions',
  OFFICE_RESTORE: 'office:restore',
  OFFICE_SAVE_COPY: 'office:save-copy',
  OFFICE_JOURNAL_DONE: 'office:journal-done',
  OFFICE_OTHER_UNSAVED: 'office:other-unsaved',
  OFFICE_PROCEED: 'office:proceed',
  OFFICE_DISMISS: 'office:dismiss',
  OFFICE_COMMENTS_ANSWER: 'office:comments-answer',
  OFFICE_COMMENTS_CHANGED: 'office:comments-changed',
  // Pushes from main (no request): a restore replaced the open file; close-time journal request; a refused quit's
  // list; a comment request for the editor.
  OFFICE_CHANGED: 'office:changed',
  OFFICE_JOURNAL_REQUEST: 'office:journal-request',
  OFFICE_UNSAVED_PROMPT: 'office:unsaved-prompt',
  OFFICE_COMMENTS_REQUEST: 'office:comments-request',
  // ---- Preload-only names, folded in by one-core R2 (2026-09-29) ----
  // Before R2 preload.ts kept its own hand-typed copy of this list, and 52 constants existed
  // only there (account:, social:, marketplace:, settings:, ...). Generating preload's list from
  // THIS file would have silently dropped them, so they live here now. Values are byte-for-byte
  // what preload used.
  PTY_RAW_BYTES: 'pty:raw-bytes',
  MODEL_GET_PREFERENCE: 'model:get-preference',
  MODEL_SET_PREFERENCE: 'model:set-preference',
  APPEARANCE_GET: 'appearance:get',
  APPEARANCE_SET: 'appearance:set',
  MODEL_READ_LAST: 'model:read-last',
  DEFAULTS_GET: 'defaults:get',
  DEFAULTS_SET: 'defaults:set',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  MODES_GET: 'modes:get',
  MODES_SET: 'modes:set',
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
  SOCIAL_PRESENCE_CONNECT: 'social:presence-connect',
  SOCIAL_PRESENCE_DISCONNECT: 'social:presence-disconnect',
  SOCIAL_PRESENCE_SEND: 'social:presence-send',
  SOCIAL_PRESENCE_EVENT: 'social:presence-event',
  MARKETPLACE_INSTALL: 'marketplace:install',
  MARKETPLACE_RATE: 'marketplace:rate',
  MARKETPLACE_RATE_DELETE: 'marketplace:rate:delete',
  MARKETPLACE_THUMB: 'marketplace:thumb',
  MARKETPLACE_THUMB_GET: 'marketplace:thumb:get',
  MARKETPLACE_COMMENT: 'marketplace:comment',
  MARKETPLACE_THEME_LIKE: 'marketplace:theme:like',
  MARKETPLACE_REPORT: 'marketplace:report',
  REMOTE_ATTENTION_CHANGED: 'remote:attention-changed',
  ANALYTICS_GET_OPT_IN: 'analytics:get-opt-in',
  ANALYTICS_SET_OPT_IN: 'analytics:set-opt-in',
  // ---- Names added by one-core R2 (2026-09-29) ----
  // These channels already existed: preload.ts and remote-shim.ts sent them as bare string
  // literals, so this list (and the preload copy generated from it) did not know they existed.
  // Listed here so the contract is the COMPLETE set of names; R3 gives each a table entry.
  ARCADE_LEADERBOARD: 'arcade:leaderboard',
  ARCADE_RECORDS: 'arcade:records',
  ARCADE_STATUS: 'arcade:status',
  ARCADE_SUBMIT_SCORE: 'arcade:submit-score',
  ARTIFACTS_APPEND_VERSION: 'artifacts:append-version',
  ARTIFACTS_CHANGED: 'artifacts:changed',
  ARTIFACTS_CHECK_EXISTENCE: 'artifacts:check-existence',
  ARTIFACTS_DELETE_PROJECT: 'artifacts:delete-project',
  ARTIFACTS_DOWNLOAD: 'artifacts:download',
  ARTIFACTS_EXCLUDE: 'artifacts:exclude',
  ARTIFACTS_GET: 'artifacts:get',
  ARTIFACTS_IMPORT_FILE: 'artifacts:import-file',
  ARTIFACTS_INCLUDE_EXTERNAL: 'artifacts:include-external',
  ARTIFACTS_LIST_ALL_FILES: 'artifacts:list-all-files',
  ARTIFACTS_LIST_FOLDER: 'artifacts:list-folder',
  ARTIFACTS_LIST_PROJECT: 'artifacts:list-project',
  ARTIFACTS_LIST_PROJECTS_INDEX: 'artifacts:list-projects-index',
  ARTIFACTS_LIST_SESSION: 'artifacts:list-session',
  ARTIFACTS_READ_BINARY: 'artifacts:read-binary',
  ARTIFACTS_REMOVE_RECORD: 'artifacts:remove-record',
  ARTIFACTS_RENAME: 'artifacts:rename',
  ARTIFACTS_RESOLVE_PATH: 'artifacts:resolve-path',
  ARTIFACTS_SAVE: 'artifacts:save',
  ARTIFACTS_SEARCH_CONTENT: 'artifacts:search-content',
  ARTIFACTS_UNWATCH_PROJECT: 'artifacts:unwatch-project',
  ARTIFACTS_WATCH_PROJECT: 'artifacts:watch-project',
  CHATSEARCH_READ: 'chatsearch:read',
  CHATSEARCH_RESOLVE: 'chatsearch:resolve',
  DOC_COMMENTS_ADD: 'docComments:add',
  DOC_COMMENTS_CHANGED: 'docComments:changed',
  DOC_COMMENTS_DELETE: 'docComments:delete',
  DOC_COMMENTS_DELETE_REPLY: 'docComments:delete-reply',
  DOC_COMMENTS_EDIT: 'docComments:edit',
  DOC_COMMENTS_EDIT_REPLY: 'docComments:edit-reply',
  DOC_COMMENTS_LIST: 'docComments:list',
  DOC_COMMENTS_MOVE: 'docComments:move',
  DOC_COMMENTS_REOPEN: 'docComments:reopen',
  DOC_COMMENTS_REPLY: 'docComments:reply',
  DOC_COMMENTS_RESOLVE: 'docComments:resolve',
  DOC_COMMENTS_UNWATCH: 'docComments:unwatch',
  DOC_COMMENTS_WATCH: 'docComments:watch',
  FAVORITES_GET: 'favorites:get',
  FAVORITES_SET: 'favorites:set',
  GAME_GET_INCOGNITO: 'game:getIncognito',
  GAME_SET_INCOGNITO: 'game:setIncognito',
  GET_HOME_PATH: 'get-home-path',
  GIT_CHANGED: 'git:changed',
  GIT_COMMIT: 'git:commit',
  GIT_COMMIT_FILE_DIFF: 'git:commit-file-diff',
  GIT_DISCARD: 'git:discard',
  GIT_FILE_REVIEW: 'git:file-review',
  GIT_FILE_STATUS: 'git:file-status',
  GIT_STAGE: 'git:stage',
  GIT_UNSTAGE: 'git:unstage',
  GIT_UNWATCH: 'git:unwatch',
  GIT_WATCH: 'git:watch',
  PROJECT_LIST_CONTEXT: 'project:list-context',
  PROJECT_LIST_CONVERSATIONS: 'project:list-conversations',
  PROJECT_READ_CONTEXT_FILE: 'project:read-context-file',
  PROJECT_REPO_INFO: 'project:repo-info',
  PROJECT_WRITE_CONTEXT_FILE: 'project:write-context-file',
  SYNC_ADD_BACKEND: 'sync:add-backend',
  SYNC_OPEN_FOLDER: 'sync:open-folder',
  SYNC_PUSH_BACKEND: 'sync:push-backend',
  SYNC_REMOVE_BACKEND: 'sync:remove-backend',
  SYNC_SETUP_AUTH_GDRIVE: 'sync:setup:auth-gdrive',
  SYNC_SETUP_AUTH_GITHUB: 'sync:setup:auth-github',
  SYNC_SETUP_CHECK_GDRIVE: 'sync:setup:check-gdrive',
  SYNC_SETUP_CHECK_PREREQS: 'sync:setup:check-prereqs',
  SYNC_SETUP_CREATE_REPO: 'sync:setup:create-repo',
  SYNC_SETUP_INSTALL_RCLONE: 'sync:setup:install-rclone',
  SYNC_UPDATE_BACKEND: 'sync:update-backend',
  TERMINAL_GET_SCREEN_TEXT: 'terminal:get-screen-text',
  WINDOW_FULLSCREEN_CHANGED: 'window:fullscreen-changed',
} as const;


// ── The channel table's entry shape ────────────────────────────────────────────

/** handle = request/response; on = fire-and-forget request; push = main → renderer event (no handler). */
type ChannelKind = 'handle' | 'on' | 'push';

/** What the phone door answers when it refuses a channel (replaces today's per-case refusals).
 *  reply = a fixed answer; unsupported = the generic "not available over remote" answer;
 *  silent = no answer at all (a push, or a no-op the caller never awaits). */
type RemoteRefusal =
  | { kind: 'reply'; payload: unknown }
  | { kind: 'unsupported' }
  | { kind: 'silent' };

/** What a handler is given besides the payload. Both doors fill the same fields; `Rt` is the
 *  native-runtime type (main/create-runtime.ts), left generic so shared/ never imports main/. */
export interface ChannelCtx<Rt = unknown> {
  /** Which door the call came in through. Handlers should almost never branch on it. */
  door: 'desktop' | 'remote';
  /** The runtime both doors share; null before it is built (the phone door can beat it). */
  runtime: Rt | null;
  /** Remote only: the paired device making the call. */
  deviceId?: string;
  /** Desktop only: the Electron webContents id of the calling window. */
  windowId?: number;
  /** Remote only: the connected phone's id. WHY (2026-09-30 one-core R3-5): a handoff attempt is owned by
   *  the connection that began it, so it can be cancelled when that connection closes. */
  clientId?: string;
  /** Remote only: is the phone that sent this still connected? WHY (2026-09-30 one-core R3-6): a call
   *  that WAITS (the boot wait for the session ops) must not run after its phone has gone, or it would
   *  create a session nobody asked to see. Absent on the computer's door, which never waits. */
  isConnected?(): boolean;
  /** WHY (2026-09-30 one-core R3-1): tell EVERY screen that something changed: this computer's
   *  windows AND every paired phone, whichever door the change came in through. Before, a tag
   *  edited on a phone only told the other phones. Each door fills this the same way. */
  broadcast(channel: string, payload: unknown): void;
}

// WHY (2026-09-30 one-core R3-1) three fields R2 declared are gone: `sessionScoped` (nothing reads
// it until R5's per-session delivery, which re-adds it together with its reader), and
// `messageKind` / `rejectOnNotOk` (they describe how the phone's BROWSER PAGE treats a channel,
// and remote-shim.ts, which needs them, cannot import main/ where the table lives). No moved
// family needs either: MESSAGE_KIND only lists fire-and-forget channels and REJECT_ON_NOT_OK
// none of these. A later family that needs them moves the shim's list into a shared/ file then,
// with the reader in the same commit. A field with no reader is a promise nobody keeps.
// TABLE_ERROR_FLAG lives in ./table-error-flag (re-exported here) so the phone's page can import
// it without pulling this whole contract into its bundle.
export { TABLE_ERROR_FLAG } from './table-error-flag';

export interface ChannelDef<Ctx = ChannelCtx, Payload = any, Result = any> {
  /** One of the IPC names above. */
  name: string;
  kind: ChannelKind;
  /** Runs the feature. ONE object argument in, a plain value out (never wrapped for the door). */
  handler: (payload: Payload, ctx: Ctx) => Result | Promise<Result>;
  /** Electron-only (windows, dialogs, detach): the phone door refuses it from the table. */
  desktopOnly?: boolean;
  /** false = the phone door refuses even though the feature exists (host-admin channels). Default true. */
  remoteAllowed?: boolean;
  /** What the phone door answers when it refuses; default { kind: 'unsupported' }. */
  refusal?: RemoteRefusal;
  /** Phone door only: what a phone is told when the handler THROWS. Default is `{ ok:false, error }`.
   *  For a channel whose caller expects a list, a boolean or null, that default object would take
   *  the screen down, so the entry declares the soft answer the phone always got. The desktop
   *  door ignores it: a throw rejects the invoke there, as it always did. */
  remoteOnError?: (error: unknown, payload: Payload) => unknown;
  /** Phone door only: a check on what a phone sent, run BEFORE the handler. Returns undefined to let it
   *  through, or the answer to give instead (the handler then never runs). WHY (2026-09-30 one-core R3-4):
   *  session:create's "a terminal can only be opened from the app itself" refusal was a check buried in
   *  the phone's old `case`; a mechanical merge into one handler would have dropped it or applied it to
   *  the computer's own windows. As table policy it is declared once, on the entry, for the phone only. */
  remoteGuard?: (payload: Payload, ctx: Ctx) => unknown | undefined | Promise<unknown | undefined>;
  /** Phone door only, after remoteGuard lets a call through: the payload the handler is given. WHY
   *  (2026-09-30 one-core R3-7): the phone's file reads carry a smaller size ceiling than the computer's;
   *  declared here it is forced by the door, so a phone cannot send a bigger one of its own. */
  remotePayload?: (payload: Payload, ctx: Ctx) => Payload | Promise<Payload>;
  /** Phone door only, after the handler succeeds: reshapes what the phone is sent. WHY (2026-10-01 one-core R3-8):
   *  remote:devices:list answers a bare list to a window but `{ devices: [...] }` to a phone, and the phone's page reads the
   *  wrapped form; declared on the entry it stays byte-identical without a second handler. */
  remoteReply?: (result: Result, payload: Payload) => unknown;
  /** Only the phone door serves it: the desktop door registers nothing. WHY (2026-09-30 one-core R3-7):
   *  file:upload exists only for a phone's attach button; registering it on the computer would add a
   *  write-to-disk channel to the window surface that never existed. */
  remoteOnly?: boolean;
}

/** The request and response type of every channel a table family owns. ONE place: the table
 *  entry (main/ipc/<family>.ts, via defineChannel) and the window.claude type below both read it,
 *  so a handler, the desktop bridge and the phone shim cannot disagree about a channel's shape.
 *  `request` is the ONE object the caller sends (void = no payload). A family adds its rows here
 *  when it moves into the table. */
export interface ChannelTypes extends MarketplaceChannelTypes, SyncChannelTypes, SessionChannelTypes, NativeChannelTypes, ModelsChannelTypes, FilesChannelTypes, AppChannelTypes, OfficeChannelTypes {
  'tags:list': { request: void; response: TagListResult };
  'tags:create': { request: { label: string; color: string }; response: TagMutationResult };
  'tags:update': { request: { id: string; patch: TagPatch }; response: TagMutationResult };
  'tags:delete': { request: { id: string }; response: TagDeleteResult };
  'folders:list': { request: void; response: PickerFolder[] };
  'folders:add': { request: { folderPath: string; nickname?: string }; response: SavedFolder | null };
  'folders:remove': { request: { folderPath: string }; response: boolean };
  'folders:rename': { request: { folderPath: string; nickname: string }; response: boolean };
  'folders:set-description': { request: { folderPath: string; description: string }; response: boolean };
  'defaults:get': { request: void; response: SessionDefaults };
  'defaults:set': { request: Partial<SessionDefaults>; response: SessionDefaults | null };
  'settings:get': { request: { field: string }; response: unknown };
  'settings:set': { request: { field: string; value: unknown }; response: boolean };
  'modes:get': { request: void; response: ModelModes };
  'modes:set': { request: Partial<ModelModes>; response: ModelModes | null };
  'analytics:get-opt-in': { request: void; response: boolean };
  'analytics:set-opt-in': { request: { enabled: boolean }; response: void };
  // dev:* — Settings → Development (one-core R3-2). log-tail stays a bare number on the wire: Android reads it that way.
  'dev:log-tail': { request: number | undefined; response: string };
  'dev:diagnostics': { request: void; response: string };
  'dev:summarize-issue': { request: DevSummarizeArgs; response: DevSummaryResult };
  'dev:submit-issue': { request: DevSubmitArgs; response: DevSubmitResult };
  'dev:install-workspace': { request: void; response: DevInstallWorkspaceResult };
  'dev:setup-workspace': { request: void; response: DevSetupWorkspaceResult };
  'dev:setup-status': { request: void; response: DevSetupStatus };
  'dev:setup-clear': { request: void; response: void };
  'dev:open-session-in': { request: DevOpenSessionInArgs; response: Pick<SessionInfo, 'id'> };
  // update:* — the app's own update (one-core R3-2). update:progress is a push, not an entry.
  'update:changelog': { request: { forceRefresh?: boolean } | undefined; response: UpdateChangelogResult };
  'update:download': { request: void; response: UpdateDownloadResult };
  'update:cancel': { request: { jobId: string }; response: { success: boolean } };
  'update:launch': { request: { jobId: string; filePath: string }; response: UpdateLaunchResult };
  'update:get-cached-download': { request: { version: string }; response: UpdateCachedDownload | null };
  'update:get-beta-channel': { request: void; response: UpdateBetaChannelState };
  'update:set-beta-channel': { request: { enabled: boolean }; response: UpdateBetaChannelState };
  // account:* — the YouCoded account (one-core R3-2).
  'account:start': { request: void; response: ApiResult<AuthStartResponse> };
  'account:poll': { request: { deviceCode: string }; response: ApiResult<AuthPollResponse> };
  'account:signed-in': { request: void; response: boolean };
  'account:user': { request: void; response: MarketplaceUser | null };
  'account:refresh': { request: void; response: MarketplaceUser | null };
  'account:sign-out': { request: void; response: void };
  'account:update-profile': { request: { displayName: string }; response: ApiResult<{ display_name: string }> };
  'account:set-handle': { request: { handle: string }; response: ApiResult<{ handle: string }> };
  'account:delete': { request: void; response: ApiResult<void> };
  'account:export': { request: void; response: AccountExportResult };
}

// ── The window.claude bridge: session, on ──────────────────────────────────────
//
// (Moved here from shared/bridge-types.ts, one-core R2.) WHY these two are checked
// tightly (Plan B source-grep sweep, 2026-09-16): preload.ts (Electron) and
// remote-shim.ts (remote browser and Android) are two hand-written copies of the
// same surface, and a member missing from one crashes React on that platform. Both
// object literals end in `satisfies` (compile-time only, erased from the build):
//   - preload.ts is checked against SharedBridge EXACTLY for `session` and `on`:
//     a new member there is an "unknown property" error until it is added here,
//     and adding it here makes remote-shim.ts fail until it implements it.
//   - remote-shim.ts is checked against RemoteBridge: it must implement every
//     member here and may carry more (on.prompt*, which only
//     a remote client receives).
// Parameter TYPES are checked, names are not. Same-typed positional parameters
// (sessionId, projectSlug) could be swapped unnoticed — that is why R2 also moved
// the desktop WIRE to one object per call (see preload.ts).

/** A listener handle as the bridges return it — pass it back to `off()`. */
type BridgeHandler = (...args: any[]) => void;

/** window.claude.session — every member both bridges must implement. */
interface SessionBridge {
  // WHY: shared UI must see the same attempt API on both bridges, including Android's honest refusal.
  handoff: {
    begin(conversationId: string, provider: 'claude' | 'native', create?: HandoffCreateParams): Promise<HandoffAttemptResult>;
    status(id: string): Promise<HandoffAttemptResult>;
    wait(id: string): Promise<HandoffAttemptResult>;
    retry(id: string): Promise<HandoffAttemptResult>;
    savedCopy(id: string, consent: boolean): Promise<HandoffAttemptResult>;
    force(id: string, consent: boolean, expectedHolderId: string): Promise<HandoffAttemptResult>;
    cancel(id: string): Promise<HandoffAttemptResult>;
    setCreateParams(id: string, create: HandoffCreateParams): Promise<HandoffAttemptResult>;
  };
  create(opts: { name: string; cwd: string; skipPermissions: boolean; cols?: number; rows?: number; resumeSessionId?: string; provider?: 'claude' | 'native'; model?: string; binding?: { providerId: string; modelId: string } }): Promise<any>;
  /** The ONE way a conversation is filled (one-core R5-2; main/session-open.ts has the ask and the answer). Resolves to the answer, or to
   *  undefined when this bridge has no host record to fill from (the Android app on its own runtime). */
  open(req: { sessionId: string; claudeSessionId?: string; projectSlug?: string; fresh?: boolean }): Promise<import('./session-open-types').OpenReply | undefined>;
  /** End a phone's watch of one conversation (one-core R5-3); `open` starts it. A window answers ok and changes nothing. */
  unwatch(sessionId: string): Promise<{ ok: true }>;
  /** Hand an open's pushes (`before` / `after`) to the same listeners a live push reaches. */
  play(pushes: Array<{ type: string; payload: unknown }>): void;
  /** The computer asks this screen to fill a conversation again (its first fill never completed). */
  onRefill(cb: (sessionId: string) => void): () => void;
  destroy(sessionId: string): Promise<boolean>;
  list(): Promise<any[]>;
  /** False on a remote client whose connection is down; always true on desktop. */
  canSend(): boolean;
  /** `notice: 'model-switch'` says this write is a typed `/model <alias>` chat command, so the host draws its divider on every screen (R5-4a).
   *  `sendId` is the screen's id for a chat message (the write that submits it), so a phone that lost its connection mid-send can ask the host
   *  whether it was received (`sendOutcomes`, R5-4b). */
  sendInput(sessionId: string, text: string, notice?: 'model-switch', sendId?: string): void;
  /** Android's own runtime only (it has no host screen reader): reports whether a Claude Code pop-up holds the keyboard. Elsewhere the computer reads the terminal (session-screens.ts). */
  reportInputBlocked?(sessionId: string, blocked: boolean): void;
  /** What the computer's record noted for these send ids (one-core R5-4b). Resolves to undefined on a bridge with no host record (the Android
   *  app's own runtime), where nothing can be lost on a network. */
  sendOutcomes(sessionId: string, ids: string[]): Promise<import('./send-outcome-types').SendOutcomesReply | undefined>;
  resize(sessionId: string, cols: number, rows: number): void;
  signalReady(sessionId: string): void;
  respondToPermission(requestId: string, decision: object): Promise<boolean>;
  browse(): Promise<any[]>;
  /** Order is (sessionId, projectSlug, count, all) on every bridge and caller. */
  loadHistory(sessionId: string, projectSlug: string, count?: number, all?: boolean): Promise<any>;
  switch(sessionId: string): Promise<unknown>;
  noteSelected(sessionId: string | null): void;
  setFlag(sessionId: string, flag: string, value: boolean): Promise<unknown>;
  /** Per-session lock for answering a menu by verified navigation (one device at a time). */
  menuLock(sessionId: string, holder: string, action: 'acquire' | 'release'): Promise<boolean>;
  setTag(sessionId: string, tagId: string, value: boolean): Promise<unknown>;
  setNote(sessionId: string, note: string): Promise<unknown>;
  getMeta(sessionId: string): Promise<SessionMetaResult>;
  // Welcome back (design 2026-09-24 §3): conversation ids open at the last
  // shutdown. Desktop-only feature (Android answers []/{ok:true} instead of
  // exposing this at all), but the SHARED bridge still carries it — a remote
  // browser's preload-equivalent (remote-shim) implements it too; the
  // renderer is what skips calling it off-desktop (App.tsx, T4).
  reopenList(): Promise<string[]>;
  forgetReopen(ids: string[]): Promise<{ ok: boolean }>;
}

/** window.claude.on — the push subscriptions both bridges must implement.
 *  Members returning `() => void` hand back an unsubscribe function; the rest
 *  return a handle for `off()`. */
interface BridgeListeners {
  sessionCreated(cb: (info: any) => void): BridgeHandler;
  sessionDestroyed(cb: (id: string, exitCode: number, focusSessionId?: string | null) => void): BridgeHandler;
  ptyOutput(cb: (sessionId: string, data: string) => void): BridgeHandler;
  ptyOutputForSession(sessionId: string, cb: (data: string) => void): () => void;
  ptyRawBytesForSession(sessionId: string, cb: (data: string) => void): () => void;
  ptyResetForSession(sessionId: string, cb: () => void): () => void;
  hookReplayComplete(cb: (payload: { sessionId: string; pendingRequestIds: string[] }) => void): () => void;
  remoteConversationStatus(cb: (status: { phase: string }) => void): () => void;
  hookEvent(cb: (event: any) => void): BridgeHandler;
  statusData(cb: (data: any) => void): BridgeHandler;
  /** The shared lines and live facts of a session the screen shows (one-core R5-4a; shared/session-live-types.ts). */
  sessionLive(cb: (live: import('./session-live-types').SessionLive) => void): () => void;
  /** Per-session summaries pushed about every session (one-core R5-3): `{ summaries: { [sessionId]: SessionSummary } }`. */
  sessionSummary(cb: (payload: { summaries: Record<string, import('./session-summary-types').SessionSummary> }) => void): () => void;
  sessionRenamed(cb: (sessionId: string, name: string) => void): BridgeHandler;
  sessionMoved(cb: (payload: { sessionId: string; device?: string; claudeSessionId?: string; projectSlug?: string; projectPath?: string }) => void): BridgeHandler;
  sessionMetaChanged(cb: (sessionId: string, meta: { flag: string; value: boolean }) => void): () => void;
  tagsChanged(cb: (payload: any) => void): () => void;
  specialistEvent(cb: (e: SpecialistsEvent) => void): () => void;
  shellEvent(cb: (e: ShellEvent) => void): () => void;
  sessionPermissionMode(cb: (sessionId: string, mode: string) => void): BridgeHandler;
  uiAction(cb: (action: any) => void): BridgeHandler;
  transcriptEvent(cb: (event: TranscriptEvent) => void): BridgeHandler;
  transcriptShrink(cb: (payload: { sessionId: string; oldSize: number; newSize: number }) => void): BridgeHandler;
}

/** The members of window.claude these types pin. Every other member is
 *  unchecked here (`Record<string, unknown>` below lets it through). */
interface SharedBridge {
  /** WHY (one-core R4-1, S7): what this screen can do + the handshake version. The computer's window reads them from its
   *  preload, a phone or the Android app from `auth:ok` (conservative defaults until then); no screen guesses from the platform. */
  capabilities: Capabilities;
  protocolVersion: number;
  session: SessionBridge;
  on: BridgeListeners;
  /** The arcade's favourite games (favorites:get / favorites:set). */
  getFavorites(): Promise<string[]>;
  setFavorites(favorites: string[]): Promise<unknown>;
}

/** What preload.ts's exposed object satisfies: SharedBridge, with `session`
 *  and `on` exact, plus any other top-level member. */
export type PreloadBridge = SharedBridge & Record<string, unknown>;

/** What remote-shim.ts's window.claude satisfies: at least SharedBridge, with
 *  room for remote-only extras inside `session` and `on`. */
export type RemoteBridge = Omit<SharedBridge, 'session' | 'on'> & {
  session: SessionBridge & Record<string, unknown>;
  on: BridgeListeners & Record<string, unknown>;
} & Record<string, unknown>;

// ApiResult (a call that can fail with a status) now lives in ./account-types, imported above.

// ── window.claude, as the renderer sees it ─────────────────────────────────────
// (Moved here from renderer/hooks/useIpc.ts's `declare global`, one-core R2.)
// Most namespaces keep their previous loose types on purpose: R3 tightens them
// one family at a time, together with the channel-table entries that own them.
// `session` and `on` come from the checked bridge types above.
interface ClaudeApi {
  /** See SharedBridge (platform.ts's getCapabilities() reads it, with conservative defaults when it is missing). */
  capabilities: Capabilities;
  protocolVersion: number;
  /** Dev-instance label (run-dev.sh --label). null in the built app and on remote. */
  devLabel?: string | null;
  session: SessionBridge;
  // skills, marketplace and firstRun: their member types live beside their channel rows (one-core R3-3).
  skills: SkillsBridge;
  marketplace: MarketplaceBridge;
  firstRun: FirstRunBridge;
  on: BridgeListeners;
  dialog: {
    openFile: () => Promise<string[]>;
    openFolder: () => Promise<string | null>;
    openSound: () => Promise<string | null>;
    readTranscriptMeta: (path: string) => Promise<{ model: string; contextPercent: number } | null>;
    saveClipboardImage: () => Promise<string | null>;
  };
  shell: {
    openChangelog: () => Promise<void>;
    openExternal: (url: string) => Promise<void>;
    // Task 10: typed so Settings → Specialists' "Open folder" (and every
    // existing (window.claude as any).shell.openPath call site) can drop
    // the cast. Already real — preload.ts's shell.openPath, unrelated to
    // this feature.
    openPath: (filePath: string) => Promise<string>;
  };
  // Task 9: preload bridge for reading the xterm screen buffer from the main
  // process (used by useAttentionClassifier and the Android terminal-data parity
  // refactor). Shape mirrors the handler in preload.ts (commit 0a7594a).
  terminal: {
    getScreenText: (sessionId: string, tailRows?: number) => Promise<string>;
  };
  // Mirrors ChangelogIpcResult in preload.ts (which mirrors ChangelogResult in
  // main/changelog-service.ts). When you edit one, edit all three — this copy
  // isn't covered by the ipc-channels.test.ts parity test and will drift silently.
  update: {
    changelog: (opts: { forceRefresh: boolean }) => Promise<UpdateChangelogResult>;
    // In-app update installer (Task 7). Mirrors preload.ts + remote-shim.ts.
    download: () => Promise<UpdateDownloadResult>;
    cancel: (jobId: string) => Promise<{ success: boolean }>;
    launch: (jobId: string, filePath: string) => Promise<UpdateLaunchResult>;
    getCachedDownload: (version: string) => Promise<UpdateCachedDownload | null>;
    // Beta update channel. `betaChannel` is the saved answer (null = never
    // chosen); `effective` is what the next check will use, which for an
    // unchosen install is whether this build is itself a pre-release.
    getBetaChannel: () => Promise<UpdateBetaChannelState>;
    setBetaChannel: (enabled: boolean) => Promise<UpdateBetaChannelState>;
    onProgress: (handler: (ev: import('./update-install-types').UpdateProgressEvent) => void) => () => void;
  };
  remote: {
    getConfig: () => Promise<any>;
    // Returns false when the password is under the minimum length (2026-09-10
    // security review #5); true on success.
    setPassword: (pw: string) => Promise<boolean>;
    setConfig: (config: any) => Promise<void>;
    detectTailscale: () => Promise<any>;
    getClientCount: () => Promise<number>;
    getClientList: () => Promise<any[]>;
    getStatus: () => Promise<{ state: string; reason?: string; port: number; clientCount: number } | null>;
    onStatus: (cb: (status: any) => void) => () => void;
    devices: {
      list: () => Promise<any[]>;
      rename: (deviceId: string, name: string) => Promise<boolean>;
      unpair: (deviceId: string) => Promise<boolean>;
    };
    broadcastAction: (action: any) => void;
  };
  off: (channel: string, handler: (...args: any[]) => void) => void;
  removeAllListeners: (channel: string) => void;
  getHomePath: () => Promise<string>;
  getFavorites: () => Promise<any>;
  setFavorites: (favorites: any) => Promise<void>;
  // Fix: YouCoded account — start/poll/updateProfile/setHandle/deleteAccount return
  // typed ApiResult discriminated unions; signedIn/user/signOut return plain values
  // (not wrapped). Keep these types local — do NOT import from main; the
  // renderer/main boundary must stay clean.
  account: {
    start: () => Promise<ApiResult<AuthStartResponse>>;
    poll: (deviceCode: string) => Promise<ApiResult<AuthPollResponse>>;
    signedIn: () => Promise<boolean>;
    user: () => Promise<MarketplaceUser | null>;
    // Force a /auth/me round-trip; returns the fresh profile or null (401-cleared).
    refresh: () => Promise<MarketplaceUser | null>;
    signOut: () => Promise<void>;
    updateProfile: (displayName: string) => Promise<ApiResult<{ display_name: string }>>;
    setHandle: (handle: string) => Promise<ApiResult<{ handle: string }>>;
    deleteAccount: () => Promise<ApiResult<void>>;
    // Export all account data (GET /auth/export). Not ApiResult — resolves to
    // { path } on save, { canceled: true } on cancel, { ok:false, ... } on error.
    exportData: () => Promise<AccountExportResult>;
  };
  // Social graph (accounts Phase 2). All return ApiResult so callers can read
  // .status (404 unknown/blocked handle, 429 caps, 400 self-request). Payload
  // types live in renderer/state (importable — same renderer boundary).
  social: {
    lookupHandle: (handle: string) => Promise<ApiResult<import('../renderer/state/marketplace-api-client').SocialUserCard>>;
    sendRequest: (handle: string) => Promise<ApiResult<{ status: 'pending' | 'friends' }>>;
    listRequests: () => Promise<ApiResult<import('../renderer/state/marketplace-api-client').RequestsPayload>>;
    acceptRequest: (id: string) => Promise<ApiResult<void>>;
    declineRequest: (id: string) => Promise<ApiResult<void>>;
    cancelRequest: (id: string) => Promise<ApiResult<void>>;
    listFriends: () => Promise<ApiResult<import('../renderer/state/marketplace-api-client').FriendRow[]>>;
    unfriend: (userId: string) => Promise<ApiResult<void>>;
    block: (userId: string) => Promise<ApiResult<void>>;
    unblock: (userId: string) => Promise<ApiResult<void>>;
    listBlocks: () => Promise<ApiResult<import('../renderer/state/marketplace-api-client').BlockRow[]>>;
    // Presence socket (Task 6). connect/disconnect/send return { ok:true };
    // real presence data arrives via onPresenceEvent. The event object is a
    // relayed server frame (presence/user-joined/challenge/…) or a synthetic
    // connection-state event ({type:'connected'|'disconnected'|'error'}) — all
    // carry a `type` discriminator; the renderer (Task 7) narrows on it.
    presenceConnect: () => Promise<{ ok: true }>;
    presenceDisconnect: () => Promise<{ ok: true }>;
    // Honest receipt: { ok:false, status:0, message:'not connected' } when
    // no live socket exists — don't treat presenceSend as infallible.
    presenceSend: (message: Record<string, unknown>) => Promise<{ ok: true } | { ok: false; status: number; message: string }>;
    onPresenceEvent: (cb: (ev: { type: string; [k: string]: unknown }) => void) => () => void;
  };
  // Fix: expose marketplaceApi on Window.claude so Tasks 9-12 can call install,
  // rate, deleteRating, likeTheme, and report without (window as any) casts.
  // Shape mirrors preload.ts — all methods return ApiResult<T> so callers can
  // distinguish 403 install-gate errors from generic failures.
  marketplaceApi: {
    install(pluginId: string): Promise<ApiResult<void>>;
    rate(input: {
      plugin_id: string;
      stars: 1 | 2 | 3 | 4 | 5;
      review_text?: string;
    }): Promise<ApiResult<{ hidden: boolean }>>;
    deleteRating(pluginId: string): Promise<ApiResult<void>>;
    likeTheme(themeId: string): Promise<ApiResult<{ liked: boolean }>>;
    /** Marketplace overhaul: one-tap vote. Returns the plugin's NEW totals
     *  with the write, so the button moves the number without re-fetching
     *  /stats (which is max-age=300 and would lag five minutes). */
    thumb(input: { plugin_id: string; value: 'up' | 'down' | null }): Promise<ApiResult<{ vote: 'up' | 'down' | null; thumbs_up: number; thumbs_down: number }>>;
    /** The caller's own vote, so the buttons don't forget it between visits. */
    myThumb(pluginId: string): Promise<ApiResult<{ vote: 'up' | 'down' | null; thumbs_up: number; thumbs_down: number }>>;
    comment(input: { plugin_id: string; text: string }): Promise<ApiResult<{ id: string; hidden: boolean }>>;
    report(input: {
      rating_user_id: string;
      rating_plugin_id: string;
      reason?: string;
    }): Promise<ApiResult<void>>;
  };
  buddy: import('./types').BuddyApi;
  attention: import('./types').AttentionApi;
  // Multi-window detach / window directory APIs.
  // Shape mirrors preload.ts detach block; typed loosely here so the buddy
  // components can call them without importing from main across the boundary.
  detach: {
    getDirectory: () => Promise<import('./types').WindowDirectory>;
    onDirectoryUpdated: (cb: (dir: import('./types').WindowDirectory) => void) => () => void;
    /** Ownership handoffs main queued while this window was booting (the hand-off itself: which session, the unsent
     *  draft, whether to open on it; the session's CONTENT arrives through session.open). */
    claimPending: () => Promise<import('./types').SessionOwnershipAcquired[]>;
    /** Perf cycle 2: one page of history. `beforeCursor` null = the newest
     *  page; pass a previous page's `cursor` for the page before it. */
    requestTranscriptPage: (req: { sessionId: string; beforeCursor: import('./types').PageCursor | null; claudeSessionId?: string; projectSlug?: string })
      => Promise<import('./types').TranscriptPageResult>;
  };
  // App-level defaults (skipPermissions, model, projectFolder). Types come from ChannelTypes.
  defaults: {
    get: () => Promise<ChannelTypes['defaults:get']['response']>;
    set: (updates: ChannelTypes['defaults:set']['request']) => Promise<ChannelTypes['defaults:set']['response']>;
  };
  // Anonymous analytics opt-out — read/write the gate the analytics-service
  // checks on launch. Shape mirrors preload.ts + remote-shim.ts (Phase 6).
  analytics: {
    getOptIn: () => Promise<boolean>;
    setOptIn: (enabled: boolean) => Promise<void>;
  };
  // Custom session tags: the registry, shared across sessions (tags:changed says it moved).
  tags: {
    list: () => Promise<TagListResult>;
    create: (label: string, color: string) => Promise<TagMutationResult>;
    update: (id: string, patch: TagPatch) => Promise<TagMutationResult>;
    delete: (id: string) => Promise<TagDeleteResult>;
  };
  // The new-session folder picker's saved folders.
  folders: {
    list: () => Promise<PickerFolder[]>;
    add: (folderPath: string, nickname?: string) => Promise<SavedFolder | null>;
    remove: (folderPath: string) => Promise<boolean>;
    rename: (folderPath: string, nickname: string) => Promise<boolean>;
    setDescription: (folderPath: string, description: string) => Promise<boolean>;
  };
  // Claude Code's settings.json, one dot-path field at a time (e.g. 'permissions.defaultMode').
  settings: {
    get: (field: string) => Promise<unknown>;
    set: (field: string, value: unknown) => Promise<boolean>;
  };
  // Fast mode + effort level — local-only state for the /fast and /effort UI.
  modes: {
    get: () => Promise<ModelModes>;
    set: (modes: Partial<ModelModes>) => Promise<ModelModes | null>;
  };
  // Settings → Development feature (bug report, contribute, known issues).
  // Shape mirrors preload.ts dev namespace and remote-shim.ts dev namespace.
  dev: {
    logTail: (maxLines?: number) => Promise<string>;
    // Environment snapshot (git/claude/network/perms) prepended to log
    // tail by the bug-report flow. See dev-tools.ts gatherDiagnostics().
    diagnostics: () => Promise<string>;
    // `assisted: false` means NOTHING rewrote the text — the fields are the user's
    // own words. A caller that presents them as a result is lying to the user; say
    // `unavailable` instead (design review F17).
    summarizeIssue: (args: DevSummarizeArgs) => Promise<DevSummaryResult>;
    // WHY: body is now assembled in the main process; renderer passes raw fields (Fix 2).
    // `summary` is OPTIONAL as of 2026-09-10: AI help is a separate choice (contract R12).
    // The result is a DISCRIMINATED union (R23) so a failed submit can say why.
    submitIssue: (args: DevSubmitArgs) => Promise<DevSubmitResult>;
    installWorkspace: () => Promise<DevInstallWorkspaceResult>;
    onInstallProgress: (handler: (line: string) => void) => () => void;
    openSessionIn: (args: DevOpenSessionInArgs) => Promise<{ id: string }>;
    // Contribution workspace as a managed project (contract R9/R10). Deliberately NOT
    // installWorkspace(): that one clones into a fixed folder and pulls into an existing one.
    setupWorkspace: () => Promise<DevSetupWorkspaceResult>;
    // Setup runs in the main process, so closing the dialog cannot cancel it. The
    // screen asks where it got to when it reopens.
    setupStatus: () => Promise<DevSetupStatus>;
    /** Forget a finished outcome. Without it one failure makes the start button
     *  unreachable for the rest of the session (code review C12). */
    clearSetupStatus: () => Promise<void>;
  };
  // GPU / performance preference — multiGpuDetected: false means the
  // Performance section in Settings hides itself (no hardware to toggle).
  performance: {
    get: () => Promise<import('./types').PerformanceConfigSnapshot>;
    set: (preferPowerSaving: boolean) => Promise<{ ok: true }>;
  };
  // WHY: named 'app' (not 'performance') so future restart-required settings
  // can reuse the same generic restart channel.
  app: {
    restart: () => Promise<void>;
  };
  // Native runtime capability flag (platform roadmap Phase 0 seam). Plain
  // boolean — no IPC round-trip. Hard-false everywhere except dev Electron
  // builds launched with YOUCODED_NATIVE=1; the runtime selector gates on it.
  native: {
    supported: boolean;
    // M1: acks sent/queued/failed (Task 2 switched the channel from
    // fire-and-forget to invoke) — Task 3's InputBar awaits this to
    // decide whether to show the bubble or a failure toast.
    // attachments: absolute composer file paths. Image ones are attached to
    // the user message when the model can see images; they ALSO remain in
    // `text`, which is the optimistic bubble's dedup key.
    send: (sessionId: string, text: string, attachments?: string[], sendId?: string) => Promise<NativeSendResult>;
    // Task 11: cancel/edit a queued-but-not-yet-sent message. true = removed
    // (caller may now safely refill the composer); false = too late (already
    // draining/sent) or the session isn't live — never throws.
    queueRemove: (sessionId: string, queueId: string) => Promise<boolean>;
    /** Stop the current task and send this waiting message next. false = already sending. */
    queueSendNow: (sessionId: string, queueId: string) => Promise<boolean>;
    interrupt: (sessionId: string) => void;
    // Stalled-turn Retry — fire-and-forget, same shape as interrupt above.
    retry: (sessionId: string) => void;
    // M3 item 2: user-initiated /compact. Resolves a coded result rather than
    // a bare boolean so a refusal can be explained to the user rather than
    // swallowed — `reason` is one of turn-in-flight | nothing-to-compact |
    // summary-failed | not-live | error.
    compact: (sessionId: string, focus?: string) => Promise<{ ok: true } | { ok: false; reason: string; detail?: string }>;
    // M3 item 2: /clear as a context BARRIER — appends a marker so the model
    // stops seeing prior turns; the on-disk log is never rewritten.
    clear: (sessionId: string) => Promise<{ ok: true } | { ok: false; reason: string; detail?: string }>;
    // M3 item 1: /skill-name. Loads one skill's instructions as a turn — the
    // path that works on every model, since the Skill TOOL is withheld from
    // small windows. `reason` is one of not-a-skill | unreadable |
    // turn-in-flight | not-live | queue-full | error.
    invokeSkill: (sessionId: string, skill: string, args?: string) => Promise<{ ok: true } | { ok: false; reason: string; detail?: string }>;
    setBinding: (sessionId: string, binding: { providerId: string; modelId: string }) => Promise<boolean>;
    // U11: switch only if the chat fits the chosen model; otherwise
    // 'needs-summary' (nothing changed) until called with summarize=true.
    switchModel: (sessionId: string, binding: { providerId: string; modelId: string }, summarize?: boolean) => Promise<import('./types').NativeSwitchResult>;
    // Per-session native permission mode (StatusBar chip, Task 13). Returns
    // the APPLIED mode — authoritative; the chip renders the return value.
    setPermissionMode: (sessionId: string, mode: 'ask' | 'auto-edit' | 'full-auto') => Promise<'ask' | 'auto-edit' | 'full-auto'>;
    // Push: a session's mode was seeded or changed anywhere. Returns unsubscribe.
    onPermissionMode?: (cb: (e: { sessionId: string; mode: string }) => void) => () => void;
    getContextPreferences: () => Promise<import('./context-preferences').ContextPreferences>;
    setContextPreferences: (patch: Partial<import('./context-preferences').ContextPreferences>) => Promise<import('./context-preferences').ContextPreferences>;
    getStepGuard: () => Promise<number | null>;
    setStepGuard: (value: number | null) => Promise<number | null>;
    sessionsList: () => Promise<any[]>;
    killShell: (sessionId: string, shellId: string) => Promise<{ ok: true } | { ok: false; reason: string }>;   // G-1
    // admin-password design §2.5: the card's Confirm button. false means the
    // ask expired (no live askpass connection left to deliver into) — the
    // card shows itself as ended, never a retry of the same field.
    submitAdminPassword: (requestId: string, password: string) => Promise<boolean>;
    // Per-session bound-model residency push (2026-07-14): { sessionId,
    // modelId, state: 'unloaded'|'loading'|'loaded'|'sleeping', sizeBytes }.
    onModelState: (cb: (s: any) => void) => () => void;
    // "What the assistant was given" (2026-09-10). onSessionContext returns
    // its unsubscribe fn; sessionContextText answers { error } rather than
    // throwing, so the panel shows a line instead of an unhandled rejection.
    sessionContextText: (sessionId: string, kind: 'project' | 'user' | 'skill', id?: string) => Promise<SessionContextText | { error: string }>;
    onSessionContext: (cb: (e: { sessionId: string; context: SessionContext | null }) => void) => () => void;
  };
  // Provider registry — native runtime model providers (desktop-only; the
  // Android/remote stubs reject with not-implemented).
  providers: {
    list: () => Promise<any[]>;
    upsert: (config: any) => Promise<string>;
    remove: (id: string) => Promise<boolean>;
    /** `key` checks a candidate instead of the saved key. `verdict` is set
     *  where the provider can tell a refused key from an unreachable one. */
    test: (id: string, key?: string) => Promise<{ ok: boolean; message: string; verdict?: 'verified' | 'rejected' | 'unchecked' }>;
    setKey: (id: string, key: string) => Promise<boolean>;
    catalog: () => Promise<any[]>;
  };
  // Remembered "Always allow" rules (M5 2a). Keyed by PROJECT SLUG, not
  // cwd — permissions.json never stored the cwd, and the slug is lossy.
  // First bytes of a user-chosen file for a preview tile (composer
  // attachment cards). Capped in main; see shared/read-head.ts.
  fs: {
    readHead: (filePath: string, maxBytes?: number) => Promise<import('./read-head').ReadHeadResult>;
  };
  permissions: {
    list: () => Promise<import('./permission-types').StoredProject[]>;
    remove: (slug: string, rule: import('./permission-types').PermissionRule) => Promise<boolean>;
    removeProject: (slug: string) => Promise<boolean>;
  };
  // Specialists 1c (Task 8) — roster + tier reads/writes + card actions.
  // list ALWAYS re-reads the three definition folders; ensurePersonalFolder
  // is opt-in (only "Open folder" needs the folder to exist before any
  // file has ever been written there).
  specialists: {
    // Fix: omitting `cwd` when a project folder IS known silently returns
    // a roster missing that project's OWN specialists — no error, the
    // user's files just don't appear. Always pass the active session's
    // cwd when one exists (see useSpecialistRoster/useSpecialistDefinition
    // in hooks/useSpecialists.ts, which every caller should go through).
    list: (opts?: { cwd?: string; ensurePersonalFolder?: boolean }) => Promise<import('./types').SpecialistsListResult>;
    getDelegatedModels: () => Promise<import('./types').DelegatedModelsView>;
    setDelegatedModel: (
      tier: 'budget' | 'frontier',
      binding: { providerId: string; modelId: string } | null,
    ) => Promise<{ ok: true } | { ok: false; error: string }>;
    steer: (sessionId: string, childId: string, text: string) => Promise<{ ok: true } | { ok: false; error: string }>;
    interrupt: (sessionId: string, childId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  };
  // Local llama.cpp engine (Plan B). install() streams progress via
  // onInstallProgress; onStatusChanged pushes state transitions
  // (not-installed → starting → running / error). EngineCard consumes these.
  engine: {
    status: () => Promise<any>;
    install: () => Promise<any>;
    restart: () => Promise<any>;
    // Plan C context-length knob — a thin alias for setConfig({contextSize}).
    setContext: (contextSize: number) => Promise<any>;
    /** Every engine-wide setting in one write: the context length and the two
     *  speed switches. The value saves immediately; it reaches the engine
     *  once the reply that is streaming right now has finished, which is what
     *  the returned status's `configApplyPending` reports. */
    setConfig: (patch: {
      contextSize?: number;
      speed?: Partial<import('./engine-types').EngineSpeedSettings>;
    }) => Promise<any>;
    onInstallProgress: (cb: (p: any) => void) => () => void;
    onStatusChanged: (cb: (s: any) => void) => () => void;
    // Live per-model residency (2026-07-14).
    models: () => Promise<import('./engine-types').EngineModel[]>;
    onModelsChanged: (cb: (models: import('./engine-types').EngineModel[]) => void) => () => void;
    // 2026-09-05 local-engine upgrades. Real on every surface now; the
    // workbench keeps a fake for each so the flows can be walked without a
    // machine, a PTY or a running engine.
    /** What a faster backend needs before it can be installed (Linux ROCm). */
    prereqs: (backend: string) => Promise<import('./engine-types').EnginePrereqs>;
    /** Open a plain-shell session in the app and TYPE an install command onto
     *  its prompt — nothing is run; the user presses Enter. Resolves with the
     *  session it made, which the renderer then selects (App.tsx's
     *  session-created handler already focuses a new session). */
    runInTerminal: (command: string) => Promise<{ sessionId: string }>;
  };
  // Voice prompting (2026-09-05 deck). Optional: absent on hosts with no
  // speech engine yet (remote browser, older builds) — the composer hides
  // the mic when it is undefined. Shape: shared/voice-types.ts.
  voice?: VoiceBridge;
  voiceVocabulary?: VoiceVocabularyBridge;
  // YouCoded Pages (Phase 1 shell). Optional: absent until the backend
  // lands; the header hides the pinned buttons and the library shows an
  // error when it is undefined. Shape: shared/pages-types.ts.
  pages?: PagesBridge;
  // Office (build plan Task 5). Optional: absent in any host with no Office channels, and the file panels then keep their
  // usual buttons. The remote client and the phone carry it, but their hosts refuse every call (desktop only).
  // Shape: shared/office-types.ts.
  office?: OfficeBridge;
  // Model manager (Plan C) — curated catalog, HF search, downloads, endpoint
  // detectors, engine backend switch. Task 9's Local Models panel consumes
  // these. onDownloadProgress returns an unsubscribe.
  models: {
    curated: () => Promise<any[]>;
    search: (query: string) => Promise<any[]>;
    quants: (repo: string) => Promise<any[]>;
    download: (repo: string, quant: any) => Promise<{ downloadId: string }>;
    downloadCancel: (downloadId: string) => Promise<boolean>;
    delete: (id: string) => Promise<boolean>;
    installed: () => Promise<import('./model-manager-types').InstalledLocalModel[]>;
    // Resume an interrupted download (2026-08-26). Main reads the manifest
    // written beside the .partial — no Hugging Face round trip.
    resume: (modelId: string) => Promise<{ downloadId: string }>;
    detectEndpoints: () => Promise<any[]>;
    setBackend: (backend: string) => Promise<any>;
    onDownloadProgress: (cb: (p: any) => void) => () => void;
    // Create-time / swap memory guard + [Reload Model] (2026-07-14).
    memoryCheck: (modelId: string) => Promise<{ verdict: 'ok' | 'tight' | 'too-large'; headline: string; detail: string }>;
    load: (modelId: string) => Promise<boolean>;
    // 2026-09-05 local-engine upgrades. Real on every surface now.
    /** One model's engine settings as STORED (deck Q-2). The stored shape,
     *  not the four fields the dialog writes: the dialog also shows whether
     *  the last save is still waiting on a streaming reply, and why the
     *  model last failed to load. */
    settings: (modelId: string) => Promise<import('./model-manager-types').StoredModelSettings>;
    /** Save one model's settings, and remember (or forget) the memory
     *  warning for it — `dismissMemoryWarning` replaced the separate
     *  `models.dismissMemoryWarning` channel, so there is ONE write for
     *  everything this dialog owns. */
    setSettings: (
      modelId: string,
      patch: import('./model-manager-types').ModelSettingsWrite,
    ) => Promise<import('./model-manager-types').StoredModelSettings>;
    /** Fetch the vision projector for a model already on disk and move both into a folder (S-3). */
    addVision: (modelId: string) => Promise<{ downloadId: string }>;
  };
  // Platform integration for hardware back button (Android). On desktop,
  // both methods are no-op stubs (preload.ts). On Android, notifyStackState
  // enables/disables OnBackPressedCallback and onBack subscribes to
  // system:back push events from MainActivity.
  system?: {
    notifyStackState: (empty: boolean) => void;
    onBack: (cb: () => void) => () => void;
  };
  // Cross-device sync spaces (spec 2026-07-03). Optional so remote/Android
  // builds that predate the shim member don't break typecheck; the Task 9
  // sync panel consumes these. onEvent returns an unsubscribe function.
  syncSpaces?: {
    status: () => Promise<any>;
    enable: (enabled: boolean) => Promise<any>;
    // Optional spaceId narrows to one space (Project View "Sync now"); omit for all.
    syncNow: (spaceId?: string) => Promise<{ ok: boolean }>;
    createProject: (name: string) => Promise<{ ok: true; path: string } | { ok: false; error: string }>;
    // Cross-device rename (display-name only) + stop-syncing (2026-07-12).
    renameProject?: (name: string, displayName: string) => Promise<{ ok: boolean; error?: string }>;
    stopProject?: (name: string) => Promise<{ ok: boolean; error?: string }>;
    // Conversation-lease takeover (Plan 2b Task 9). Optional so remote/Android
    // builds predating these members still typecheck; the Resume Browser gate
    // guards every call. leaseQuery answers who holds the session; leaseTakeover
    // asks the holder to hand off then polls+acquires; leaseForce overwrites a
    // stale lease when the holder is unresponsive.
    // `self` is derived in the main process from the per-install deviceId, so
    // the resume gate can skip the takeover dialog for OUR OWN held lease.
    leaseQuery?: (claudeSessionId: string) => Promise<{ held: boolean; device?: string; deviceId?: string; self?: boolean; source?: string }>;
    // 'undeliverable': the hub had no delivery path (holder never asked) —
    // distinct from 'timeout' (asked, no answer within the poll budget).
    leaseTakeover?: (claudeSessionId: string) => Promise<{ outcome: 'ready' | 'timeout' | 'error' | 'undeliverable' }>;
    leaseForce?: (claudeSessionId: string) => Promise<{ ok: boolean }>;
    // Device registry (Plan 2b spec §10a): the "Your devices" list. Optional so
    // remote / older Android builds without the handler still typecheck — every
    // caller keeps a `typeof fn === 'function'` runtime guard. listDevices marks
    // the current machine with self:true; renameDevice sets a friendly label.
    listDevices?: () => Promise<Array<{ schemaVersion: number; id: string; name: string; platform: string; lastSeen: number; updatedAt: number; self: boolean }>>;
    renameDevice?: (id: string, name: string) => Promise<{ ok: boolean }>;
    // Returns { ok:false, error } on the self-guard path (the handlers refuse to
    // remove THIS machine's own row, since upsertSelf re-creates it next launch).
    removeDevice?: (id: string) => Promise<{ ok: boolean; error?: string }>;
    onEvent: (cb: (e: unknown) => void) => () => void;
  };
}

// WHY here and not in useIpc.ts: one global declaration, derived from the contract, so every
// renderer call site sees exactly the type preload/remote-shim/mock-shim are checked against.
declare global {
  interface Window {
    claude: ClaudeApi;
  }
}
