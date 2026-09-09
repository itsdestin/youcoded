import type { VoiceBridge } from '../../shared/voice-types';
import { useEffect, useRef } from 'react';
// M1 Task 3: native.send's declared return type below was stale (`void`) from
// before Task 2 switched the IPC channel to invoke/ack. shared/types.ts (not
// main-only) is the existing exception to the "no cross-boundary import"
// comment just below — native-send.ts already imports it the same way.
import type { NativeSendResult } from '../../shared/types';

// Discriminated union for IPC calls that can fail with a structured error.
// Using a local type (not imported from main) keeps the renderer/main boundary
// clean — consistent with how remote-shim.ts duplicates types rather than
// importing across the Node/browser boundary.
type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; message: string };

// Type declaration for the preload API
declare global {
  interface Window {
    claude: {
      /** Dev-instance label (run-dev.sh --label). null in the built app and on remote. */
      devLabel?: string | null;
      session: {
        create: (opts: { name: string; cwd: string; skipPermissions: boolean; cols?: number; rows?: number; model?: string; provider?: 'claude' | 'native'; resumeSessionId?: string; binding?: { providerId: string; modelId: string } }) => Promise<any>;
        destroy: (sessionId: string) => Promise<boolean>;
        list: () => Promise<any[]>;
        sendInput: (sessionId: string, text: string) => void;
        resize: (sessionId: string, cols: number, rows: number) => void;
        signalReady: (sessionId: string) => void;
        respondToPermission: (requestId: string, decision: object) => Promise<boolean>;
        browse: () => Promise<any[]>;
        loadHistory: (sessionId: string, projectSlug: string, count?: number, all?: boolean) => Promise<any>;
      };
      skills: {
        list: () => Promise<import('../../shared/types').SkillEntry[]>;
        listMarketplace: (filters?: import('../../shared/types').SkillFilters) => Promise<import('../../shared/types').SkillEntry[]>;
        getDetail: (id: string) => Promise<import('../../shared/types').SkillDetailView>;
        search: (query: string) => Promise<import('../../shared/types').SkillEntry[]>;
        install: (id: string) => Promise<void>;
        uninstall: (id: string) => Promise<void>;
        getFavorites: () => Promise<string[]>;
        setFavorite: (id: string, favorited: boolean) => Promise<void>;
        getChips: () => Promise<import('../../shared/types').ChipConfig[]>;
        setChips: (chips: import('../../shared/types').ChipConfig[]) => Promise<void>;
        getOverride: (id: string) => Promise<import('../../shared/types').MetadataOverride | null>;
        setOverride: (id: string, override: import('../../shared/types').MetadataOverride) => Promise<void>;
        createPrompt: (skill: any) => Promise<import('../../shared/types').SkillEntry>;
        deletePrompt: (id: string) => Promise<void>;
        publish: (id: string) => Promise<{ prUrl: string }>;
        getShareLink: (id: string) => Promise<string>;
        importFromLink: (encoded: string) => Promise<import('../../shared/types').SkillEntry>;
        getCuratedDefaults: () => Promise<string[]>;
      };
      on: {
        sessionCreated: (cb: (info: any) => void) => (...args: any[]) => void;
        sessionDestroyed: (cb: (id: string) => void) => (...args: any[]) => void;
        ptyOutput: (cb: (sessionId: string, data: string) => void) => (...args: any[]) => void;
        hookEvent: (cb: (event: any) => void) => (...args: any[]) => void;
        statusData: (cb: (data: any) => void) => (...args: any[]) => void;
        sessionRenamed: (cb: (sessionId: string, name: string) => void) => (...args: any[]) => void;
        uiAction: (cb: (action: any) => void) => () => void;
        transcriptEvent: (cb: (event: any) => void) => () => void;
        // Remote-shim only: Electron clients don't have it (desktop EXPORTS via
        // onChatExportSnapshot instead). Remote browsers receive chat:hydrate on
        // connect so remote-shim subscribes this to dispatch HYDRATE_CHAT_STATE.
        chatHydrate?: (cb: (payload: any) => void) => () => void;
        // Optional — desktop stub returns no-op unsubscribe; Android remote-shim
        // dispatches base64-encoded raw PTY bytes for xterm.js consumption (Tier 2).
        ptyRawBytesForSession?: (sessionId: string, cb: (data: string) => void) => () => void;
        // Specialists 1c (Task 8) — one hire's ledger record changed. Push-only,
        // fed by the delegation ledger's own mutate() chokepoint (never a direct
        // emit per host method). Returns an unsubscribe fn.
        specialistEvent: (cb: (e: import('../../shared/types').SpecialistsEvent) => void) => () => void;
        shellEvent: (cb: (e: import('../../shared/types').ShellEvent) => void) => () => void;   // G-1
      };
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
        getScreenText: (sessionId: string) => Promise<string>;
      };
      // Mirrors ChangelogIpcResult in preload.ts (which mirrors ChangelogResult in
      // main/changelog-service.ts). When you edit one, edit all three — this copy
      // isn't covered by the ipc-channels.test.ts parity test and will drift silently.
      update: {
        changelog: (opts: { forceRefresh: boolean }) => Promise<{
          markdown: string | null;
          entries: Array<{ version: string; date?: string; body: string }>;
          fromCache: boolean;
          error?: boolean;
        }>;
        // In-app update installer (Task 7). Mirrors preload.ts + remote-shim.ts.
        download: () => Promise<import('../../shared/update-install-types').UpdateDownloadResult>;
        cancel: (jobId: string) => Promise<{ success: boolean }>;
        launch: (jobId: string, filePath: string) => Promise<import('../../shared/update-install-types').UpdateLaunchResult>;
        getCachedDownload: (version: string) => Promise<import('../../shared/update-install-types').UpdateCachedDownload | null>;
        onProgress: (handler: (ev: import('../../shared/update-install-types').UpdateProgressEvent) => void) => () => void;
      };
      remote: {
        getConfig: () => Promise<any>;
        setPassword: (pw: string) => Promise<void>;
        setConfig: (config: any) => Promise<void>;
        detectTailscale: () => Promise<any>;
        getClientCount: () => Promise<number>;
        getClientList: () => Promise<any[]>;
        disconnectClient: (id: string) => Promise<void>;
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
        start: () => Promise<ApiResult<{
          device_code: string;
          user_code: string;
          auth_url: string;
          expires_in: number;
        }>>;
        poll: (deviceCode: string) => Promise<ApiResult<
          | { status: "pending" }
          | {
              status: "complete";
              token: string;
              // Identity rebuild: the complete branch now carries the resolved user so
              // the renderer can prompt for a handle right after sign-in (Task 7).
              user?: {
                id: string;
                login: string;
                avatar_url: string | null;
                display_name?: string;
                handle?: string | null;
              };
            }
        >>;
        signedIn: () => Promise<boolean>;
        user: () => Promise<import('../../main/marketplace-auth-store').MarketplaceUser | null>;
        // Force a /auth/me round-trip; returns the fresh profile or null (401-cleared).
        refresh: () => Promise<import('../../main/marketplace-auth-store').MarketplaceUser | null>;
        signOut: () => Promise<void>;
        updateProfile: (displayName: string) => Promise<ApiResult<{ display_name: string }>>;
        setHandle: (handle: string) => Promise<ApiResult<{ handle: string }>>;
        deleteAccount: () => Promise<ApiResult<void>>;
        // Export all account data (GET /auth/export). Not ApiResult — resolves to
        // { path } on save, { canceled: true } on cancel, { ok:false, ... } on error.
        exportData: () => Promise<{ path: string } | { canceled: true } | { ok: false; status: number; error: string }>;
      };
      // Social graph (accounts Phase 2). All return ApiResult so callers can read
      // .status (404 unknown/blocked handle, 429 caps, 400 self-request). Payload
      // types live in renderer/state (importable — same renderer boundary).
      social: {
        lookupHandle: (handle: string) => Promise<ApiResult<import('../state/marketplace-api-client').SocialUserCard>>;
        sendRequest: (handle: string) => Promise<ApiResult<{ status: 'pending' | 'friends' }>>;
        listRequests: () => Promise<ApiResult<import('../state/marketplace-api-client').RequestsPayload>>;
        acceptRequest: (id: string) => Promise<ApiResult<void>>;
        declineRequest: (id: string) => Promise<ApiResult<void>>;
        cancelRequest: (id: string) => Promise<ApiResult<void>>;
        listFriends: () => Promise<ApiResult<import('../state/marketplace-api-client').FriendRow[]>>;
        unfriend: (userId: string) => Promise<ApiResult<void>>;
        block: (userId: string) => Promise<ApiResult<void>>;
        unblock: (userId: string) => Promise<ApiResult<void>>;
        listBlocks: () => Promise<ApiResult<import('../state/marketplace-api-client').BlockRow[]>>;
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
      buddy: import('../../shared/types').BuddyApi;
      attention: import('../../shared/types').AttentionApi;
      // Multi-window detach / window directory APIs.
      // Shape mirrors preload.ts detach block; typed loosely here so the buddy
      // components can call them without importing from main across the boundary.
      detach: {
        getDirectory: () => Promise<import('../../shared/types').WindowDirectory>;
        onDirectoryUpdated: (cb: (dir: import('../../shared/types').WindowDirectory) => void) => () => void;
        requestTranscriptReplay: (sessionId: string) => void;
        /** Ownership handoffs main queued while this window was booting. */
        claimPending: () => Promise<import('../../shared/types').SessionOwnershipAcquired[]>;
        /** Re-send the session state that exists only in main's memory. */
        replayLiveState: (sessionId: string) => Promise<void>;
        /** Perf cycle 2: one page of history. `beforeCursor` null = the newest
         *  page; pass a previous page's `cursor` for the page before it. */
        requestTranscriptPage: (req: { sessionId: string; beforeCursor: import('../../shared/types').PageCursor | null; claudeSessionId?: string; projectSlug?: string })
          => Promise<import('../../shared/types').TranscriptPageResult>;
      };
      // App-level defaults (skipPermissions, model, projectFolder).
      defaults: {
        // `startModel` — Assistant settings Q-3a (2026-09-05): one default
        // across every provider. Optional because installs that only ever set
        // the Claude alias (`model`) have no such field; `model` stays the
        // fallback and is kept in step on a Claude pick. Persisted by the same
        // defaults store, which spreads whatever keys it is given.
        get: () => Promise<{ skipPermissions: boolean; model: string; projectFolder: string; startModel?: import('../components/model/ModelPicker').ModelChoice; startModelLabel?: { provider: string; model: string } }>;
        set: (updates: Partial<{ skipPermissions: boolean; model: string; projectFolder: string; startModel: import('../components/model/ModelPicker').ModelChoice; startModelLabel: { provider: string; model: string } }>) => Promise<any>;
      };
      // Anonymous analytics opt-out — read/write the gate the analytics-service
      // checks on launch. Shape mirrors preload.ts + remote-shim.ts (Phase 6).
      analytics: {
        getOptIn: () => Promise<boolean>;
        setOptIn: (enabled: boolean) => Promise<void>;
      };
      // Settings → Development feature (bug report, contribute, known issues).
      // Shape mirrors preload.ts dev namespace and remote-shim.ts dev namespace.
      dev: {
        logTail: (maxLines?: number) => Promise<string>;
        // Environment snapshot (git/claude/network/perms) prepended to log
        // tail by the bug-report flow. See dev-tools.ts gatherDiagnostics().
        diagnostics: () => Promise<string>;
        summarizeIssue: (args: { kind: string; description: string; log?: string }) => Promise<{ title: string; summary: string; flagged_strings: string[] }>;
        // WHY: body is now assembled in the main process; renderer passes raw fields (Fix 2).
        submitIssue: (args: { kind: 'bug' | 'feature'; title: string; summary: string; description: string; log?: string; label: string }) => Promise<{ ok: boolean; url?: string; fallbackUrl?: string }>;
        installWorkspace: () => Promise<{ path: string; alreadyInstalled: boolean } | { error: string }>;
        onInstallProgress: (handler: (line: string) => void) => () => void;
        openSessionIn: (args: { cwd: string; initialInput?: string }) => Promise<{ id: string }>;
      };
      // GPU / performance preference — multiGpuDetected: false means the
      // Performance section in Settings hides itself (no hardware to toggle).
      performance: {
        get: () => Promise<import('../../shared/types').PerformanceConfigSnapshot>;
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
        send: (sessionId: string, text: string, attachments?: string[]) => Promise<NativeSendResult>;
        // Task 11: cancel/edit a queued-but-not-yet-sent message. true = removed
        // (caller may now safely refill the composer); false = too late (already
        // draining/sent) or the session isn't live — never throws.
        queueRemove: (sessionId: string, queueId: string) => Promise<boolean>;
        interrupt: (sessionId: string) => void;
        // Stalled-turn Retry — fire-and-forget, same shape as interrupt above.
        retry: (sessionId: string) => void;
        // M3 item 2: user-initiated /compact. Resolves a coded result rather than
        // a bare boolean so a refusal can be explained to the user rather than
        // swallowed — `reason` is one of turn-in-flight | nothing-to-compact |
        // summary-failed | not-live | error.
        compact: (sessionId: string) => Promise<{ ok: true } | { ok: false; reason: string; detail?: string }>;
        // M3 item 2: /clear as a context BARRIER — appends a marker so the model
        // stops seeing prior turns; the on-disk log is never rewritten.
        clear: (sessionId: string) => Promise<{ ok: true } | { ok: false; reason: string; detail?: string }>;
        // M3 item 1: /skill-name. Loads one skill's instructions as a turn — the
        // path that works on every model, since the Skill TOOL is withheld from
        // small windows. `reason` is one of not-a-skill | unreadable |
        // turn-in-flight | not-live | queue-full | error.
        invokeSkill: (sessionId: string, skill: string, args?: string) => Promise<{ ok: true } | { ok: false; reason: string; detail?: string }>;
        setBinding: (sessionId: string, binding: { providerId: string; modelId: string }) => Promise<boolean>;
        // Per-session native permission mode (StatusBar chip, Task 13). Returns
        // the APPLIED mode — authoritative; the chip renders the return value.
        setPermissionMode: (sessionId: string, mode: 'ask' | 'auto-edit' | 'full-auto') => Promise<'ask' | 'auto-edit' | 'full-auto'>;
        getStepGuard: () => Promise<number | null>;
        setStepGuard: (value: number | null) => Promise<number | null>;
        sessionsList: () => Promise<any[]>;
        killShell: (sessionId: string, shellId: string) => Promise<{ ok: true } | { ok: false; reason: string }>;   // G-1
        // Per-session bound-model residency push (2026-07-14): { sessionId,
        // modelId, state: 'unloaded'|'loading'|'loaded'|'sleeping', sizeBytes }.
        onModelState: (cb: (s: any) => void) => () => void;
      };
      // Provider registry — native runtime model providers (desktop-only; the
      // Android/remote stubs reject with not-implemented).
      providers: {
        list: () => Promise<any[]>;
        upsert: (config: any) => Promise<string>;
        remove: (id: string) => Promise<boolean>;
        test: (id: string) => Promise<{ ok: boolean; message: string }>;
        setKey: (id: string, key: string) => Promise<boolean>;
        catalog: () => Promise<any[]>;
      };
      // Remembered "Always allow" rules (M5 2a). Keyed by PROJECT SLUG, not
      // cwd — permissions.json never stored the cwd, and the slug is lossy.
      // First bytes of a user-chosen file for a preview tile (composer
      // attachment cards). Capped in main; see shared/read-head.ts.
      fs: {
        readHead: (filePath: string, maxBytes?: number) => Promise<import('../../shared/read-head').ReadHeadResult>;
      };
      permissions: {
        list: () => Promise<import('../../shared/permission-types').StoredProject[]>;
        remove: (slug: string, rule: import('../../shared/permission-types').PermissionRule) => Promise<boolean>;
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
        list: (opts?: { cwd?: string; ensurePersonalFolder?: boolean }) => Promise<import('../../shared/types').SpecialistsListResult>;
        getDelegatedModels: () => Promise<import('../../shared/types').DelegatedModelsView>;
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
          speed?: Partial<import('../../shared/engine-types').EngineSpeedSettings>;
        }) => Promise<any>;
        onInstallProgress: (cb: (p: any) => void) => () => void;
        onStatusChanged: (cb: (s: any) => void) => () => void;
        // Live per-model residency (2026-07-14).
        models: () => Promise<import('../../shared/engine-types').EngineModel[]>;
        onModelsChanged: (cb: (models: import('../../shared/engine-types').EngineModel[]) => void) => () => void;
        // 2026-09-05 local-engine upgrades. Real on every surface now; the
        // workbench keeps a fake for each so the flows can be walked without a
        // machine, a PTY or a running engine.
        /** What a faster backend needs before it can be installed (Linux ROCm). */
        prereqs: (backend: string) => Promise<import('../../shared/engine-types').EnginePrereqs>;
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
        installed: () => Promise<import('../../shared/model-manager-types').InstalledLocalModel[]>;
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
        settings: (modelId: string) => Promise<import('../../shared/model-manager-types').StoredModelSettings>;
        /** Save one model's settings, and remember (or forget) the memory
         *  warning for it — `dismissMemoryWarning` replaced the separate
         *  `models.dismissMemoryWarning` channel, so there is ONE write for
         *  everything this dialog owns. */
        setSettings: (
          modelId: string,
          patch: import('../../shared/model-manager-types').ModelSettingsWrite,
        ) => Promise<import('../../shared/model-manager-types').StoredModelSettings>;
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
        leaseTakeover?: (claudeSessionId: string) => Promise<{ outcome: 'acquired' | 'timeout' | 'error' | 'undeliverable' }>;
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
    };
  }
}

export function usePtyOutput(
  sessionId: string | null,
  onData: (data: string) => void,
) {
  const cbRef = useRef(onData);
  cbRef.current = onData;

  useEffect(() => {
    if (!sessionId) return;

    // Use per-session channel if available (avoids N+1 callback amplification)
    const claude = window.claude as any;
    if (claude?.on?.ptyOutputForSession) {
      return claude.on.ptyOutputForSession(sessionId, (data: string) => cbRef.current(data));
    }

    // Fallback: global channel with client-side filter
    const handler = window.claude.on.ptyOutput((sid, data) => {
      if (sid === sessionId) {
        cbRef.current(data);
      }
    });

    return () => {
      window.claude.off('pty:output', handler);
    };
  }, [sessionId]);
}
