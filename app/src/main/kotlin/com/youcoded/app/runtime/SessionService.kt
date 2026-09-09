package com.youcoded.app.runtime

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Binder
import android.os.FileObserver
import android.os.IBinder
import android.os.PowerManager
import android.provider.Settings
import com.youcoded.app.BuildConfig
import com.youcoded.app.MainActivity
import com.youcoded.app.analytics.AnalyticsService
import com.youcoded.app.bridge.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.withContext
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys
import com.youcoded.app.marketplace.ApiResult
import com.youcoded.app.marketplace.MarketplaceApiClient
import com.youcoded.app.marketplace.MarketplaceAuthStore
import com.youcoded.app.marketplace.MarketplaceUser
import com.youcoded.app.artifacts.*
import com.youcoded.app.skills.BundledPlugins
import com.youcoded.app.skills.LocalSkillProvider
import com.youcoded.app.skills.PluginInstaller
import com.youcoded.app.util.forEachKey
import com.youcoded.app.social.PresenceClient

// The analytics Worker base URL, spelled once for the three AnalyticsService call sites below.
// WHY: Moved to its own domain so Cloudflare's cache and rate limiter apply; the old workers.dev address still answers for older app versions.
private const val ANALYTICS_API_BASE = "https://api.youcoded.ai"

class SessionService : Service() {
    private val binder = LocalBinder()
    val sessionRegistry = SessionRegistry()
    val bridgeServer = LocalBridgeServer()
    var platformBridge: PlatformBridge? = null

    // Security: track which client ID created each session, so session:input
    // can only be sent by the connection that owns the session. Uses client ID
    // strings (not WebSocket refs) so ownership survives reconnects — the same
    // WebView gets a new WebSocket object but the same incrementing client ID
    // pattern. On Android there's typically one client, so we also allow input
    // if there's only one authenticated connection (covers reconnect cases).
    private val sessionOwnership = ConcurrentHashMap<String, String>()

    // Tracks the per-session coroutine job that collects rawByteFlow and
    // broadcasts pty:raw-bytes push events. Cancelled when the session is destroyed
    // or (implicitly) when serviceScope.cancel() fires in onDestroy().
    // Fix: ConcurrentHashMap instead of mutableMapOf — handleBridgeMessage runs on
    // Dispatchers.IO so concurrent create/destroy could race on a plain HashMap.
    // Matches the sessionOwnership field above, which uses ConcurrentHashMap for the same reason.
    private val rawByteJobs = ConcurrentHashMap<String, Job>()

    /**
     * The last friends leaderboard we successfully fetched, per game id, with the
     * clock time we fetched it. Desktop parity: the boardCache in
     * desktop/src/main/arcade-handlers.ts.
     *
     * WHY keep it at all: if the network blips, showing an EMPTY leaderboard
     * teaches the player their scores were lost — alarming and untrue. Serving
     * the remembered board with `cachedAt` set lets the UI label it as out of
     * date instead. WHY memory and not disk: a board that survived an app
     * restart would be stale in a way the user could not explain to themselves.
     * ConcurrentHashMap for the same reason as rawByteJobs above —
     * handleBridgeMessage runs on Dispatchers.IO.
     */
    private val arcadeBoardCache = ConcurrentHashMap<String, Pair<JSONObject, Long>>()

    // Concurrency guard: prevent two concurrent dev:install-workspace ops from
    // cloning/pulling the workspace simultaneously (e.g. double-tap the button).
    @Volatile private var devInstallInFlight: Boolean = false

    /**
     * Security: use EncryptedSharedPreferences for paired device storage so
     * passwords are encrypted at rest. Falls back to regular SharedPreferences
     * if the Android Keystore is unavailable (e.g. corrupted key on some devices).
     */
    private fun getEncryptedPrefs(): android.content.SharedPreferences {
        return try {
            val masterKeyAlias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC)
            EncryptedSharedPreferences.create(
                "remote_devices_encrypted",
                masterKeyAlias,
                applicationContext,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        } catch (e: Exception) {
            android.util.Log.w("SessionService", "EncryptedSharedPreferences unavailable, using fallback: ${e.message}")
            applicationContext.getSharedPreferences("remote_devices", android.content.Context.MODE_PRIVATE)
        }
    }
    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    /** Layout insets reported by React UI (header and bottom bar pixel heights). */
    data class LayoutInsets(val headerPx: Int, val bottomPx: Int)
    private val _layoutInsets = kotlinx.coroutines.flow.MutableSharedFlow<LayoutInsets>(replay = 1)
    val layoutInsets: kotlinx.coroutines.flow.SharedFlow<LayoutInsets> = _layoutInsets

    /** File picker bridge: Service sets the deferred, Activity completes it with paths. */
    var pendingFilePicker: CompletableDeferred<List<String>>? = null
    /** Callback for Activity to know when to launch the file picker. */
    var onFilePickerRequested: (() -> Unit)? = null

    /** Folder picker bridge: Service sets the deferred, Activity completes it with path. */
    var pendingFolderPicker: CompletableDeferred<String?>? = null
    /** Callback for Activity to know when to launch the folder picker. */
    var onFolderPickerRequested: (() -> Unit)? = null

    /** QR scanner bridge: Service sets the deferred, Activity completes it with scanned URL. */
    var pendingQrScanner: CompletableDeferred<String?>? = null
    /** Callback for Activity to know when to launch the QR scanner. */
    var onQrScanRequested: (() -> Unit)? = null

    // ── Voice prompting ─────────────────────────────────────────────────────
    // Talking to the chat box uses the phone's own speech recognition. Two
    // things about Android force the shape of this code: only the app WINDOW can
    // ask the user for microphone permission (this Service cannot), and the
    // recogniser itself refuses to be touched from any thread but the main one.

    /** Microphone permission bridge: Service parks the deferred, the Activity's
     *  permission launcher completes it with the user's answer — the same
     *  hand-off the file, folder and QR pickers above already use. */
    var pendingMicPermission: CompletableDeferred<Boolean>? = null
    /** Callback for the Activity to know when to show the microphone prompt. */
    var onMicPermissionRequested: (() -> Unit)? = null

    /** True only once the user has actually SEEN the permission prompt and said no.
     *  WHY it matters: "permission not granted" must never be reported before the
     *  question has been asked — that would grey the mic button out for someone who
     *  was never offered the choice, with a reason that is not yet true. */
    private var micPermissionDenied = false

    /** Lives for the life of the app; only ever touched on the main thread. */
    private var voiceRecognizer: VoiceRecognizer? = null

    /** Runs work on the main thread, which is the only thread Android's speech
     *  recogniser tolerates (bridge messages arrive on the web-socket thread). */
    private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())

    // ── Marketplace auth + API ───────────────────────────────────────────────
    // WHY lazy: applicationContext is not available during construction; initialized
    // on first use inside handleBridgeMessage which always runs after onCreate().
    private val marketplaceAuthStore: MarketplaceAuthStore by lazy {
        MarketplaceAuthStore.create(applicationContext)
    }
    private val marketplaceApiClient: MarketplaceApiClient by lazy {
        MarketplaceApiClient(marketplaceAuthStore)
    }

    // Platform-owned presence socket (Task 6) — mirror of desktop's
    // presence-socket.ts. The token + WebSocket live here; every presence event
    // is relayed to React via a social:presence-event broadcast. Lazy so the
    // OkHttp client isn't built until presence is first used.
    private val presenceClient: PresenceClient by lazy {
        PresenceClient(
            getToken = { marketplaceAuthStore.getToken() },
            onEvent = { ev ->
                bridgeServer.broadcast(JSONObject().apply {
                    put("type", "social:presence-event")
                    put("payload", ev)
                })
            },
        )
    }

    /**
     * A 401 from an auth'd account endpoint means the Worker no longer recognizes
     * this session (identity-migration row drop, 90-day idle expiry, revocation).
     * Keeping the local token would strand the user "signed in" with every call
     * failing, so clear it — the UI then flips to signed-out and offers a fresh
     * sign-in. Only reacts to a 401 that already happened; never proactively
     * validates. Desktop parity: marketplace-api-handlers.ts clearSessionOn401.
     */
    private fun clearSessionOn401(result: ApiResult<*>) {
        if (result is ApiResult.Err && result.status == 401) marketplaceAuthStore.signOut()
    }

    /**
     * Serialize a stored profile to the snake_case wire shape React reads (matches
     * the desktop stored MarketplaceUser). Shared by account:user and account:refresh.
     */
    private fun accountUserJson(user: MarketplaceUser): JSONObject = JSONObject().apply {
        put("id",           user.id)
        put("login",        user.login)
        put("avatar_url",   user.avatarUrl)
        put("display_name", user.displayName ?: JSONObject.NULL)
        put("handle",       user.handle ?: JSONObject.NULL)
    }

    /**
     * The value shape arcade:leaderboard returns: the board itself plus
     * `cachedAt`, which is set ONLY when this is a remembered copy served
     * because the live fetch failed. Desktop parity: BoardResult in
     * arcade-handlers.ts. The renderer writes the staleness wording — this
     * layer only reports the fact.
     */
    private fun arcadeBoardResultJson(board: JSONObject, cachedAt: Long?): JSONObject =
        JSONObject().apply {
            put("board", board)
            put("cachedAt", cachedAt ?: JSONObject.NULL)
        }

    /**
     * Write a text file into the public Downloads collection via MediaStore
     * (used by account:export). WHY MediaStore: the Android WebView has no
     * save-dialog path, and scoped storage (API 29+) blocks direct writes to the
     * Downloads directory — RELATIVE_PATH targets Environment.DIRECTORY_DOWNLOADS.
     * Caller MUST gate on Build.VERSION.SDK_INT >= 29 (MediaStore.Downloads is API 29+).
     */
    @androidx.annotation.RequiresApi(android.os.Build.VERSION_CODES.Q)
    private fun writeExportToDownloads(filename: String, content: String) {
        val resolver = applicationContext.contentResolver
        val values = android.content.ContentValues().apply {
            put(android.provider.MediaStore.Downloads.DISPLAY_NAME, filename)
            put(android.provider.MediaStore.Downloads.MIME_TYPE, "application/json")
            put(android.provider.MediaStore.Downloads.RELATIVE_PATH, android.os.Environment.DIRECTORY_DOWNLOADS)
        }
        val uri = resolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw java.io.IOException("could not create Downloads entry")
        resolver.openOutputStream(uri)?.use { it.write(content.toByteArray(Charsets.UTF_8)) }
            ?: throw java.io.IOException("could not open Downloads output stream")
    }
    /**
     * Callback for the Activity to open the device's browser at the given URL.
     * Follows the same deferred-callback pattern as onFilePickerRequested and
     * onFolderPickerRequested — the Activity sets this after binding to the service.
     */
    var onMarketplaceAuthUrlRequested: ((String) -> Unit)? = null

    /**
     * MainActivity binds this to flip OnBackPressedCallback.isEnabled.
     * `empty = true` means the React dismissal stack is empty (so hardware
     * back should fall through to Android default — background the app).
     * `empty = false` means at least one overlay/full-screen view is open
     * and back should be intercepted to call dismissTop().
     *
     * The setter replays the cached lastStackEmpty so MainActivity rebinds
     * (e.g. after rotation) get the current state immediately. Without this
     * replay, OnBackPressedCallback would default to disabled until the user
     * opens or closes another overlay.
     */
    var onStackStateChanged: ((empty: Boolean) -> Unit)? = null
        set(value) {
            field = value
            value?.invoke(lastStackEmpty)
        }

    /** Cached most-recent stack-empty value. Defaults to true so that until
     *  React first signals, hardware back behaves as Android default
     *  (back backgrounds the app — no regression vs pre-feature behavior). */
    private var lastStackEmpty: Boolean = true

    private var wakeLock: PowerManager.WakeLock? = null
    private var urlObserver: FileObserver? = null
    private var statusBroadcastTimer: java.util.Timer? = null
    private var announcementService: AnnouncementService? = null
    // Phase 5d: FileObserver for theme hot-reload
    private var themeWatcher: FileObserver? = null
    var skillProvider: LocalSkillProvider? = null
        private set
    // Command drawer — provides slash commands list from plugins, skills, and project.
    private var commandProvider: CommandProvider? = null
    var pluginInstaller: PluginInstaller? = null
        private set
    var bootstrap: Bootstrap? = null
        private set
    // Native sync engine — owns push/pull lifecycle, background timer.
    // Replaces bash sync.sh hooks when the app is running.
    var syncService: SyncService? = null
        private set

    // Restore service — directional user-initiated pull from a backup. Paused
    // push loop during execute prevents uploading half-restored state.
    var restoreService: RestoreService? = null
        private set

    // Legacy single-session API — kept for ServiceBinder compatibility during migration
    var ptyBridge: PtyBridge? = null
        private set

    inner class LocalBinder : Binder() {
        val service: SessionService get() = this@SessionService
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        createNotificationChannels()

        // Start the WebSocket bridge server early — before onServiceConnected fires —
        // so it's already listening when ChatScreen renders the WebView. Previously
        // this lived in onStartCommand, which races with BIND_AUTO_CREATE: the Activity
        // could render ChatScreen (and load the React WebView) before startForegroundService
        // triggered onStartCommand, causing the initial WebSocket connect to be refused.
        sessionRegistry.bridgeServer = bridgeServer
        if (!bridgeServer.isRunning) {
            bridgeServer.start { ws, msg ->
                serviceScope.launch {
                    handleBridgeMessage(ws, msg)
                }
            }
        }

        // Privacy analytics: fire install + daily-heartbeat ping to the marketplace
        // Worker. Fire-and-forget: no await, no logging. Respects opt-out internally
        // (AnalyticsService.runOnLaunch returns early if state.optIn is false).
        // Runs on a raw thread so service startup is never blocked by network I/O.
        // Mirror of desktop/src/main/main.ts's analytics wire-in.
        Thread {
            try {
                AnalyticsService(
                    apiBase = ANALYTICS_API_BASE,
                    // $HOME is set by Bootstrap to the Termux home dir, but onCreate
                    // runs BEFORE initBootstrap, so fall back to filesDir.parent
                    // (Android internal files root) or filesDir itself.
                    homeDir = File(System.getenv("HOME") ?: filesDir.parent ?: filesDir.absolutePath),
                    appVersion = BuildConfig.VERSION_NAME,
                    // Settings.Secure.ANDROID_ID is per-(app-signing-key, user, device)
                    // since Android 8 — stable across reinstalls of THIS app, resets
                    // only on factory reset. Empty/null falls back to a persisted UUID.
                    machineIdReader = {
                        Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: ""
                    },
                ).runOnLaunch()
            } catch (_: Exception) {
                // Swallow — analytics must never impact app startup.
            }
        }.start()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildSessionNotification())

        val homeDir = bootstrap?.homeDir ?: filesDir
        platformBridge = PlatformBridge(applicationContext, homeDir)

        return START_STICKY
    }

    fun initBootstrap(bs: Bootstrap) {
        bootstrap = bs
        titlesDir.mkdirs()
        startUrlObserver(bs)
        announcementService = AnnouncementService(bs.homeDir).also { it.start() }
        startStatusBroadcast(bs)
        skillProvider = LocalSkillProvider(bs.homeDir, applicationContext)
        skillProvider?.ensureMigrated()
        // Command drawer — builds the merged commands list from CC built-ins, plugins, and skills.
        commandProvider = CommandProvider(
            homeDir = bs.homeDir,
            skillProvider = skillProvider!!,
            getProjectCwd = {
                // Use the first registered session's cwd; null if no sessions yet.
                sessionRegistry.sessions.value.values.firstOrNull()?.cwd?.absolutePath
            },
        )
        pluginInstaller = PluginInstaller(bs.homeDir, bs, skillProvider!!.configStore)
        // Wire up plugin installer and reload callback so LocalSkillProvider
        // handles all install/uninstall routing (consolidates SessionService logic)
        skillProvider?.pluginInstaller = pluginInstaller
        // Fire-and-forget: install bundled plugins if missing. Silent retry on
        // every launch. Dispatched on IO so service startup isn't blocked by
        // marketplace HTTP.
        //
        // Fix (Track B final review, Finding F13): this launch used to sit
        // ABOVE the `pluginInstaller = PluginInstaller(...)` assignment two
        // lines below. reconcileBundledPlugins() reads skillProvider.pluginInstaller
        // and bails out with a single "installer not initialized" row if it's
        // still null — a real race, not hypothetical: if the IO-dispatched
        // coroutine started running before this thread reached the
        // assignment, nothing reconciles until the next launch. Was
        // pre-existing as a one-time-install race; Track B makes it cost an
        // upgrade per lost race instead. Moved below the assignment so the
        // installer is guaranteed non-null before the coroutine can read it.
        serviceScope.launch(Dispatchers.IO) {
            skillProvider?.ensureBundledPluginsInstalled()
        }
        skillProvider?.onPluginsChanged = {
            // Mirror of desktop's SessionManager.broadcastReloadPlugins gating
            // (stray-Enter fix, youcoded#110): typing "/reload-plugins\r" while a
            // permission/AskUserQuestion request is pending lands on Claude
            // Code's live Ink select menu — the trailing \r presses Enter on the
            // highlighted option and silently answers the prompt. Delay so CC is
            // ready for input, then defer with bounded retries while a request
            // is pending. A missed reload is recoverable (next install or a
            // manual /reload-plugins); an auto-answered prompt is not.
            serviceScope.launch {
                delay(1500)
                var attempts = 0
                while (true) {
                    val session = sessionRegistry.getCurrentSession()
                    if (session == null || session.shellMode || !session.isRunning) return@launch
                    if (!session.hasPendingPermission()) {
                        session.writeInput("/reload-plugins\r")
                        return@launch
                    }
                    if (++attempts >= 24) return@launch // ~2 min of deferral, then give up
                    delay(5000)
                }
            }
        }

        // Decomposition v3 §9.2: reconcile plugin hooks-manifest.json into
        // settings.json. Adds required hooks, updates stale paths (e.g.,
        // flattened core/hooks/ → hooks/), enforces MAX timeout.
        val hookReconciler = HookReconciler(bs.homeDir)
        skillProvider?.hookReconciler = hookReconciler
        try {
            val hr = hookReconciler.reconcile()
            android.util.Log.i("SessionService", "Hook reconciled: added=${hr.added} updatedPath=${hr.updatedPath} updatedTimeout=${hr.updatedTimeout}")
        } catch (e: Exception) {
            android.util.Log.w("SessionService", "Initial hook reconcile failed", e)
        }

        // Force CC's prompt-suggestion feature off in settings.json on every
        // launch. CC pre-fills the input bar with a generated next-prompt
        // suggestion that interacts badly with our chat→PTY write path (the
        // body gets concatenated with the ghost text and submitted on the
        // trailing CR). Mirror of desktop's `enforcePromptSuggestionDisabled`.
        try {
            val r = PromptSuggestionDisabler(bs.homeDir).enforce()
            if (r.changed) android.util.Log.i("SessionService", "Prompt suggestion force-disabled: priorWasEnabled=${r.priorWasEnabled}")
        } catch (e: Exception) {
            android.util.Log.w("SessionService", "Failed to force-disable prompt suggestion", e)
        }

        // Seed transcript retention so CC's 30-day cleanup doesn't delete
        // Resume Browser history. Mirrors desktop retention-default.ts.
        try {
            val seeded = RetentionDefault(bs.homeDir).seedIfAbsent()
            if (seeded) android.util.Log.i("SessionService", "Seeded cleanupPeriodDays=${RetentionDefault.DEFAULT_DAYS}")
        } catch (e: Exception) {
            android.util.Log.w("SessionService", "Failed to seed cleanupPeriodDays", e)
        }

        // Decomposition v3 §9.3: reconcile plugin mcp-manifest.json into
        // .claude.json mcpServers. Only auto:true entries; filtered to "linux"/"all".
        val mcpReconciler = com.youcoded.app.skills.McpReconciler(bs.homeDir)
        skillProvider?.mcpReconciler = mcpReconciler
        try {
            val mr = mcpReconciler.reconcile()
            android.util.Log.i("SessionService", "MCP reconciled: added=${mr.added} skippedPlatform=${mr.skippedPlatform} skippedManual=${mr.skippedManual}")
        } catch (e: Exception) {
            android.util.Log.w("SessionService", "Initial MCP reconcile failed", e)
        }
        // Phase 5d: start watching themes directory for hot-reload
        startThemeWatcher(bs)

        // Start native sync engine — pulls on launch, pushes every 15 min
        syncService = SyncService(applicationContext, bs).also { it.start() }

        // Wire up restore service — owns the snapshot + atomic-swap machinery.
        // Startup housekeeping (orphan staging cleanup + retention) runs once here.
        restoreService = RestoreService(syncService!!, File(bs.homeDir, ".claude")).also {
            it.cleanupOrphanedStaging()
            it.enforceRetention()
        }
    }

    /** Watch ~/.claude-mobile/open-url for URLs written by the JS wrapper.
     *  Opens them via Android Intent (only way to launch browser from app UID). */
    private fun startUrlObserver(bs: Bootstrap) {
        val mobileDir = File(bs.homeDir, ".claude-mobile")
        mobileDir.mkdirs()
        val urlFile = File(mobileDir, "open-url")

        urlObserver?.stopWatching()
        urlObserver = object : FileObserver(mobileDir, CLOSE_WRITE or MODIFY) {
            override fun onEvent(event: Int, path: String?) {
                if (path != "open-url") return
                try {
                    val url = urlFile.readText().trim()
                    // Security: only allow http/https schemes — prevents intent:// injection
                    if (url.startsWith("http://") || url.startsWith("https://")) {
                        urlFile.delete()
                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        }
                        startActivity(intent)
                    }
                } catch (_: Exception) {}
            }
        }
        urlObserver?.startWatching()
    }

    // (No usage-refresh timer any more. It ran ~/.claude-mobile/usage-fetch.js
    // every 5 minutes, which read the Claude.ai OAuth token and called Anthropic's
    // usage API — forbidden for third-party apps by Anthropic's Claude Code terms.
    // .usage-cache.json is now written by assets/statusline.sh from the
    // rate_limits object Claude Code passes to the status line; the broadcast
    // below keeps reading the same file unchanged.)

    /**
     * Broadcasts status:data to React UI every 10s, mirroring desktop's status poller.
     * Reads usage cache, context %, and session stats files written by statusline.sh.
     */
    private fun startStatusBroadcast(bs: Bootstrap) {
        statusBroadcastTimer?.cancel()
        val claudeDir = File(bs.homeDir, ".claude")

        statusBroadcastTimer = java.util.Timer("status-broadcast", true).apply {
            scheduleAtFixedRate(object : java.util.TimerTask() {
                override fun run() {
                    try {
                        val payload = JSONObject()

                        // Usage cache (rate limits)
                        val usageFile = File(claudeDir, ".usage-cache.json")
                        if (usageFile.exists()) {
                            try { payload.put("usage", JSONObject(usageFile.readText())) } catch (_: Exception) {}
                        }

                        // Announcement cache (mirror of desktop's
                        // ipc-handlers.ts:1287). The renderer's StatusBar
                        // gates on isExpired so stale entries don't render
                        // even if they slipped through the fetch-time filter.
                        val announcementFile = File(claudeDir, ".announcement-cache.json")
                        if (announcementFile.exists()) {
                            try {
                                payload.put("announcement", JSONObject(announcementFile.readText()))
                            } catch (_: Exception) {}
                        }

                        // No "syncStatus" key: the desktop dropped its matching producer —
                        // the value reached StatusBar and was never read. Keeping it here
                        // would drift the status payload away from desktop for no consumer.
                        // .sync-status itself is still read by assets/statusline.sh.
                        val warnFile = File(claudeDir, ".sync-warnings")
                        if (warnFile.exists()) {
                            try { payload.put("syncWarnings", warnFile.readText().trim()) } catch (_: Exception) {}
                        }

                        // Per-session context %, session stats, and git branch.
                        // Mirrors desktop's ipc-handlers.ts:buildStatusData per-session
                        // loop — the git branch file is written by statusline.sh at
                        // `~/.claude/.gitbranch-$claudeId`. Without this map, the
                        // git-branch status bar widget receives no data and hides.
                        val contextMap = JSONObject()
                        val sessionStatsMap = JSONObject()
                        val gitBranchMap = JSONObject()
                        for ((mobileId, session) in sessionRegistry.sessions.value) {
                            val claudeId = session.ptyBridge?.getEventBridge()
                                ?.getClaudeSessionId(mobileId) ?: continue
                            val ctxFile = File(claudeDir, ".context-$claudeId")
                            if (ctxFile.exists()) {
                                try { contextMap.put(mobileId, ctxFile.readText().trim().toInt()) } catch (_: Exception) {}
                            }
                            val statsFile = File(claudeDir, ".session-stats-$claudeId.json")
                            if (statsFile.exists()) {
                                try { sessionStatsMap.put(mobileId, JSONObject(statsFile.readText())) } catch (_: Exception) {}
                            }
                            val branchFile = File(claudeDir, ".gitbranch-$claudeId")
                            if (branchFile.exists()) {
                                try {
                                    val branch = branchFile.readText().trim()
                                    if (branch.isNotEmpty()) gitBranchMap.put(mobileId, branch)
                                } catch (_: Exception) {}
                            }
                        }
                        payload.put("contextMap", contextMap)
                        payload.put("sessionStatsMap", sessionStatsMap)
                        payload.put("gitBranchMap", gitBranchMap)

                        // Background bulk-conversations pull state — non-null
                        // while a recent restore is still fetching older
                        // history. Renders as a chip in StatusBar so the user
                        // knows why conversations are still appearing after
                        // the restore wizard's "Done" screen closed.
                        val bgState = syncService?.backgroundPullState
                        if (bgState != null) {
                            payload.put("backgroundPull", JSONObject().apply {
                                put("type", bgState.type)
                                put("startedAt", bgState.startedAt)
                            })
                        } else {
                            payload.put("backgroundPull", JSONObject.NULL)
                        }

                        bridgeServer.broadcast(JSONObject().apply {
                            put("type", "status:data")
                            put("payload", payload)
                        })
                    } catch (_: Exception) {}
                }
            }, 5_000, 10_000) // initial 5s delay, then every 10s (matches desktop)
        }
    }

    /**
     * Phase 5d: Watch ~/.claude/wecoded-themes/ for changes.
     * Sends theme:reload push events via WebSocket when theme files change,
     * matching desktop's theme-watcher.ts behavior with per-slug debouncing.
     */
    private fun startThemeWatcher(bs: Bootstrap) {
        val watchDir = File(bs.homeDir, ".claude/wecoded-themes")
        watchDir.mkdirs()

        themeWatcher?.stopWatching()

        // Debounce map: slug → pending runnable
        val debounceMap = java.util.concurrent.ConcurrentHashMap<String, Runnable>()
        val handler = android.os.Handler(android.os.Looper.getMainLooper())

        // FileObserver watches CREATE, MODIFY, DELETE events on the themes dir.
        // Android's FileObserver is non-recursive, so we watch the root dir and
        // parse slug from subdirectory paths.
        @Suppress("DEPRECATION") // FileObserver(String) deprecated in API 29 but still works
        themeWatcher = object : FileObserver(
            watchDir.absolutePath,
            CREATE or MODIFY or DELETE or MOVED_TO or MOVED_FROM
        ) {
            override fun onEvent(event: Int, path: String?) {
                if (path == null) return
                // Extract slug from path (first component of relative path)
                val normalized = path.replace("\\", "/")
                val slug = normalized.split("/").firstOrNull() ?: return

                // Only trigger on relevant file types
                val ext = normalized.substringAfterLast(".", "").lowercase()
                if (ext !in listOf("json", "svg", "png", "jpg", "jpeg", "webp", "css")) return

                // Debounce per slug (~100ms, matching desktop)
                val existing = debounceMap[slug]
                if (existing != null) handler.removeCallbacks(existing)

                val runnable = Runnable {
                    debounceMap.remove(slug)
                    // Send theme:reload push event (no id — it's a broadcast)
                    bridgeServer.broadcast(JSONObject().apply {
                        put("type", "theme:reload")
                        put("payload", JSONObject().apply {
                            put("slug", slug)
                        })
                    })
                }
                debounceMap[slug] = runnable
                handler.postDelayed(runnable, 100)
            }
        }
        themeWatcher?.startWatching()
    }

    val titlesDir: File get() = File(bootstrap?.homeDir ?: File("/"), ".claude-mobile/titles")

    fun createSession(cwd: File, dangerousMode: Boolean, apiKey: String?, model: String? = null): ManagedSession {
        val bs = bootstrap ?: throw IllegalStateException("Bootstrap not initialized")
        val session = sessionRegistry.createSession(bs, cwd, dangerousMode, apiKey, titlesDir, model = model)

        // Wire clipboard callback
        session.ptyBridge?.onCopyToClipboard = { text ->
            val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("Terminal", text))
        }

        // Wire approval notification callbacks
        session.onApprovalNeeded = { sessionId, sessionName ->
            postApprovalNotification(sessionId, sessionName)
        }
        session.onApprovalCleared = { sessionId ->
            clearApprovalNotification(sessionId)
        }

        acquireWakeLock()
        updateNotification()
        return session
    }

    fun destroySession(sessionId: String) {
        // Push this session's JSONL to all backends before destroying
        // (mirrors desktop main.ts session-exit → syncService.pushSession)
        // Capture the hook-supplied transcript path BEFORE sessionRegistry.destroySession()
        // tears down the PTY bridge/EventBridge below — same design as desktop's
        // watcher: no derivation can be wrong about a path CC handed us.
        val transcriptPath = sessionRegistry.sessions.value[sessionId]?.ptyBridge?.getEventBridge()?.getTranscriptPath(sessionId)
        syncService?.let { sync ->
            serviceScope.launch {
                try {
                    sync.pushSession(sessionId, transcriptPath)
                } catch (e: Exception) {
                    android.util.Log.w("SessionService", "Session-end sync failed for $sessionId: $e")
                }
            }
        }
        sessionRegistry.destroySession(sessionId)
        if (sessionRegistry.sessionCount == 0) {
            releaseWakeLock()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        } else {
            updateNotification()
        }
    }

    fun destroyAllSessions() {
        sessionRegistry.destroyAll()
        ptyBridge = null
        releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun acquireWakeLock() {
        if (wakeLock == null) {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "YouCoded::Session").apply {
                acquire(4 * 60 * 60 * 1000L) // 4 hour timeout
            }
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.let {
            if (it.isHeld) it.release()
        }
        wakeLock = null
    }

    // ── Voice prompting helpers ─────────────────────────────────────────────

    /** Has the user given this app permission to use the microphone? */
    private fun micPermissionGranted(): Boolean =
        checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED

    /** What came back when we needed the microphone. */
    private enum class MicPermission {
        /** The user has said yes (now, or at some point before). */
        GRANTED,
        /** The user saw the prompt and said no. */
        DENIED,
        /** Nobody could ask — the app window is not on screen, or it never replied. */
        UNANSWERED,
    }

    /**
     * Make sure we may use the microphone, asking the user if we have not already.
     *
     * A background Service cannot show a permission prompt on Android; only an
     * Activity can. So this parks a "waiting for an answer" slot the way the file,
     * folder and QR pickers already do, asks MainActivity to launch its permission
     * prompt, and waits for the Activity to fill the slot in.
     */
    private suspend fun ensureMicPermission(): MicPermission {
        if (micPermissionGranted()) {
            micPermissionDenied = false
            return MicPermission.GRANTED
        }
        // No Activity bound means no window on screen and therefore no way to ask.
        val ask = onMicPermissionRequested ?: return MicPermission.UNANSWERED

        val deferred = CompletableDeferred<Boolean>()
        pendingMicPermission = deferred
        withContext(Dispatchers.Main) { ask() }
        // A timeout rather than an endless wait: if the window is swiped away while
        // the prompt is up, the answer never arrives and this coroutine would leak.
        val granted = try {
            withTimeoutOrNull(120_000) { deferred.await() }
        } catch (_: Exception) { null }
        pendingMicPermission = null

        return when (granted) {
            true -> { micPermissionDenied = false; MicPermission.GRANTED }
            false -> { micPermissionDenied = true; MicPermission.DENIED }
            // Never answered — deliberately NOT recorded as a refusal.
            null -> MicPermission.UNANSWERED
        }
    }

    /**
     * Whether the mic can listen right now, in the shape
     * `desktop/src/shared/voice-types.ts` defines (`VoiceReadiness`).
     *
     * Note the middle branch: we only say the permission was refused once the user
     * has actually turned the prompt down. Before that — permission not yet given,
     * never asked — this reports `ready`, because the first tap on the mic is what
     * asks the question.
     */
    private fun voiceReadiness(): JSONObject = when {
        !android.speech.SpeechRecognizer.isRecognitionAvailable(this) ->
            JSONObject().put("state", "unavailable")
                .put("reason", "This phone has no speech recognition service installed.")
        micPermissionDenied && !micPermissionGranted() ->
            JSONObject().put("state", "unavailable")
                .put("reason", "Microphone permission was not granted.")
        else ->
            JSONObject().put("state", "ready").put("engine", "your phone's speech recognition")
    }

    /** Push one voice event to the chat UI (no id — it is a broadcast, not a reply). */
    private fun broadcastVoiceEvent(event: JSONObject) {
        bridgeServer.broadcast(JSONObject().apply {
            put("type", "voice:event")
            put("payload", event)
        })
    }

    /** Open the microphone. MAIN THREAD ONLY — Android's recogniser demands it. */
    private fun startVoiceRecognizer() {
        val recognizer = voiceRecognizer
            ?: VoiceRecognizer.create(this) { event -> broadcastVoiceEvent(event) }
                .also { voiceRecognizer = it }
        recognizer.start()
    }

    /** Push permission overrides to all active sessions' in-memory cache. */
    private fun syncPermissionOverridesToSessions(overrides: JSONObject) {
        sessionRegistry.sessions.value.values.forEach { session ->
            session.permissionOverridesCache = overrides
        }
    }

    private fun createNotificationChannels() {
        val manager = getSystemService(NotificationManager::class.java)

        val sessionChannel = NotificationChannel(
            CHANNEL_SESSION, "YouCoded Sessions", NotificationManager.IMPORTANCE_LOW
        ).apply { description = "Active YouCoded sessions" }

        val approvalChannel = NotificationChannel(
            CHANNEL_APPROVAL, "Approval Prompts", NotificationManager.IMPORTANCE_HIGH
        ).apply { description = "YouCoded permission prompts" }

        manager.createNotificationChannel(sessionChannel)
        manager.createNotificationChannel(approvalChannel)
    }

    private fun buildSessionNotification(): Notification {
        val count = sessionRegistry.sessionCount
        val text = if (count <= 1) "Session active" else "$count sessions active"

        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pending = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE)

        return Notification.Builder(this, CHANNEL_SESSION)
            .setContentTitle("YouCoded")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_edit)
            .setContentIntent(pending)
            .setOngoing(true)
            .build()
    }

    fun postApprovalNotification(sessionId: String, sessionName: String) {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("session_id", sessionId)
        }
        val pending = PendingIntent.getActivity(
            this, sessionId.hashCode(), intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val notification = Notification.Builder(this, CHANNEL_APPROVAL)
            .setContentTitle("$sessionName: waiting for approval")
            .setContentText("Tap to review permission request")
            .setSmallIcon(android.R.drawable.ic_menu_edit)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()

        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(APPROVAL_NOTIFICATION_BASE + sessionId.hashCode(), notification)
    }

    fun clearApprovalNotification(sessionId: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.cancel(APPROVAL_NOTIFICATION_BASE + sessionId.hashCode())
    }

    private fun updateNotification() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildSessionNotification())
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Keep service running when user swipes app from recents
    }

    override fun onDestroy() {
        // Hand the microphone back to Android. onDestroy already runs on the main
        // thread, which is the only thread the recogniser may be touched from.
        try { voiceRecognizer?.release() } catch (_: Exception) {}
        voiceRecognizer = null

        // Stop sync service — cancels timer, releases locks, removes .app-sync-active marker
        try { syncService?.stop() } catch (_: Exception) {}
        syncService = null
        restoreService = null
        bridgeServer.stop()
        urlObserver?.stopWatching()
        urlObserver = null
        // Phase 5d: stop theme watcher
        themeWatcher?.stopWatching()
        themeWatcher = null
        statusBroadcastTimer?.cancel()
        statusBroadcastTimer = null
        announcementService?.stop()
        announcementService = null
        sessionRegistry.destroyAll()
        releaseWakeLock()
        // Cancel any pending coroutines on serviceScope (bridge dispatch,
        // bundled-plugin install at startup, end-of-session sync pushes).
        // SyncService and bridgeServer are stopped above, so pushes/messages
        // that were already in-flight have nowhere to land — cancelling here
        // matches the pattern SyncService.stop() uses for its own scope.
        serviceScope.cancel()
        super.onDestroy()
    }

    private suspend fun handleBridgeMessage(
        ws: org.java_websocket.WebSocket,
        msg: MessageRouter.ParsedMessage
    ) {
        when (msg.type) {
            "session:create" -> {
                val cwd = msg.payload.optString("cwd", bootstrap?.homeDir?.absolutePath ?: "")
                // Security note: skipPermissions is safe to read from the payload because
                // the bridge now requires token auth (2a) — only the authenticated WebView
                // (our bundled React UI) can send this message. The token prevents
                // unauthenticated clients from escalating privileges.
                val dangerous = msg.payload.optBoolean("skipPermissions", false)
                val payloadModel = msg.payload.optString("model", "")
                val model = if (payloadModel.isNotEmpty()) payloadModel else {
                    val prefFile = File(bootstrap!!.homeDir, ".claude-mobile/model-preference.json")
                    try {
                        val json = org.json.JSONObject(prefFile.readText())
                        json.optString("model", "sonnet")
                    } catch (_: Exception) { "sonnet" }
                }
                android.util.Log.i("SessionService", "Bridge session:create cwd=$cwd dangerous=$dangerous")
                // TerminalSession requires the main thread (Looper)
                val session = withContext(Dispatchers.Main) {
                    createSession(File(cwd), dangerous, null, model = model)
                }
                android.util.Log.i("SessionService", "Session created: id=${session.id} ptyBridge=${session.ptyBridge != null} termSession=${session.getTerminalSession() != null}")
                val info = MessageRouter.buildSessionInfo(
                    id = session.id, name = session.name.value,
                    cwd = cwd, status = "active",
                    // Fix: derive permissionMode from the dangerous flag (parity with
                    // desktop session-manager.ts). Hardcoding "normal" here meant the
                    // initial session:created broadcast told React permissionMode=normal
                    // even when dangerous=true, so SessionStrip's danger indicator missed
                    // until the next cycle of session:list. Now correct from message #1.
                    permissionMode = if (dangerous) "bypass" else "normal", skipPermissions = dangerous,
                    createdAt = session.createdAt,
                    // Pass the resolved model (payload > model-preference.json > "sonnet")
                    // so React's status-bar switcher shows the right alias immediately,
                    // not after the first assistant-text event reconciles it.
                    model = model,
                )
                // Security: record which client ID owns this session
                val ownerClientId = ws.getAttachment<String>() ?: "unknown"
                sessionOwnership[session.id] = ownerClientId
                // Start broadcasting raw PTY bytes for this session. The coroutine
                // lives on serviceScope so it's cancelled automatically on onDestroy();
                // it's also cancelled explicitly in session:destroy below.
                session.ptyBridge?.let { ptyBridge ->
                    rawByteJobs[session.id] = launchRawByteBroadcast(session.id, ptyBridge)
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, info) }
                bridgeServer.broadcast(JSONObject().apply {
                    put("type", "session:created")
                    put("payload", info)
                })
            }
            "session:destroy" -> {
                val sessionId = msg.payload.optString("sessionId", "")
                sessionOwnership.remove(sessionId) // Clean up ownership tracking
                // Cancel the raw-byte broadcast coroutine for this session.
                rawByteJobs.remove(sessionId)?.cancel()
                withContext(Dispatchers.Main) {
                    destroySession(sessionId)
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, true) }
                // Broadcast so React UI removes the session from the selector
                // (parity with desktop ipc-handlers.ts SESSION_DESTROYED)
                bridgeServer.broadcast(JSONObject().apply {
                    put("type", "session:destroyed")
                    put("payload", JSONObject().apply {
                        put("sessionId", sessionId)
                    })
                })
            }
            "session:list" -> {
                val sessions = sessionRegistry.sessions.value.map { (id, session) ->
                    MessageRouter.buildSessionInfo(
                        id = id, name = session.name.value,
                        cwd = session.cwd.absolutePath,
                        status = if (session.status.value == SessionStatus.Dead) "destroyed" else "active",
                        permissionMode = session.permissionMode,
                        skipPermissions = session.dangerousMode,
                        createdAt = session.createdAt
                    )
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, org.json.JSONArray(sessions)) }
            }
            "session:switch" -> {
                val sessionId = msg.payload.optString("sessionId", "")
                if (sessionId.isNotEmpty()) {
                    sessionRegistry.switchTo(sessionId)
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, true) }
            }
            "session:input" -> {
                val sessionId = msg.payload.optString("sessionId", "")
                val text = msg.payload.optString("text", "")
                // Security: validate session ownership by client ID + cap input to 1MB.
                // Allow input if: no ownership recorded (pre-existing session), owner matches,
                // or only one authenticated client (covers WebSocket reconnect — same WebView,
                // new client ID after the old connection dropped).
                val callerClientId = ws.getAttachment<String>() ?: ""
                val ownerClientId = sessionOwnership[sessionId]
                val singleClient = bridgeServer.authenticatedClientCount <= 1
                val allowed = ownerClientId == null || ownerClientId == callerClientId || singleClient
                if (!allowed) {
                    android.util.Log.w("SessionService", "session:input rejected — client $callerClientId does not own session $sessionId (owner: $ownerClientId)")
                } else if (text.isNotEmpty() && text.length <= 1_048_576) {
                    sessionRegistry.sessions.value[sessionId]?.writeInput(text)
                }
            }
            "session:resize" -> {
                val sessionId = msg.payload.optString("sessionId", "")
                val cols = msg.payload.optInt("cols", 80)
                val rows = msg.payload.optInt("rows", 24)
                if (cols > 0 && rows > 0) {
                    try {
                        withContext(Dispatchers.Main) {
                            sessionRegistry.sessions.value[sessionId]?.getTerminalSession()?.updateSize(cols, rows)
                        }
                    } catch (e: Exception) {
                        android.util.Log.w("SessionService", "Resize failed: ${e.message}")
                    }
                }
            }
            "terminal:get-screen-text" -> {
                // Returns the current visible screen buffer as plain text.
                // Used by the React-side attention classifier so it can run on
                // standalone Android with the same classifyBuffer function as
                // desktop. Unknown sessionId returns {text: ""} — callers
                // (classifier) already tolerate empty buffers during startup.
                val sessionId = msg.payload.optString("sessionId", "")
                val session = sessionRegistry.sessions.value[sessionId]
                val text = session?.ptyBridge?.readScreenText() ?: ""
                val response = JSONObject().apply { put("text", text) }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, response) }
            }
            "permission:respond" -> {
                val requestId = msg.payload.optString("requestId", "")
                val decision = msg.payload.optJSONObject("decision") ?: JSONObject()
                sessionRegistry.sessions.value.values.forEach { session ->
                    session.ptyBridge?.getEventBridge()?.respond(requestId, decision)
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, true) }
            }
            "skills:list" -> {
                val result = skillProvider?.getInstalled() ?: org.json.JSONArray()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "commands:list" -> {
                val result = commandProvider?.getCommands() ?: org.json.JSONArray()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "skills:list-marketplace" -> {
                val result = skillProvider?.listMarketplace(msg.payload) ?: org.json.JSONArray()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "skills:get-detail" -> {
                val id = msg.payload.optString("id")
                val result = skillProvider?.getSkillDetail(id) ?: JSONObject()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "skills:search" -> {
                val query = msg.payload.optString("query")
                val result = skillProvider?.search(query) ?: org.json.JSONArray()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "skills:install" -> {
                // All install routing consolidated in LocalSkillProvider — handles
                // both prompts and plugins (any sourceMarketplace) with /reload-plugins
                val id = msg.payload.optString("id")
                val result = skillProvider?.install(id)
                    ?: JSONObject().put("status", "failed").put("error", "Skill provider not initialized")
                // Invalidate command cache so newly installed plugin commands appear immediately.
                commandProvider?.invalidateCache()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "skills:uninstall" -> {
                val id = msg.payload.optString("id")
                val result = if (BundledPlugins.isBundled(id)) {
                    // Defense-in-depth: UI disables the button; reject here too.
                    JSONObject()
                        .put("ok", false)
                        .put("error", "bundled")
                        .put("type", "plugin")
                } else {
                    skillProvider?.uninstall(id)
                        ?: JSONObject().put("ok", false).put("error", "Skill provider not initialized")
                }
                // Invalidate command cache so uninstalled plugin commands are removed immediately.
                commandProvider?.invalidateCache()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "skills:get-favorites" -> {
                val result = skillProvider?.getFavorites() ?: org.json.JSONArray()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "skills:set-favorite" -> {
                val id = msg.payload.optString("id")
                val favorited = msg.payload.optBoolean("favorited")
                skillProvider?.setFavorite(id, favorited)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("ok", true)) }
            }
            // Theme favorites — parity with desktop appearance:get-favorite-themes /
            // appearance:favorite-theme IPC. Reads/writes themeFavorites in
            // ~/.claude/youcoded-skills.json via the same SkillConfigStore used
            // by skill favorites above.
            "appearance:get-favorite-themes" -> {
                val favorites = skillProvider?.getThemeFavorites() ?: org.json.JSONArray()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, favorites) }
            }
            "appearance:favorite-theme" -> {
                val slug = msg.payload.optString("slug")
                val favorited = msg.payload.optBoolean("favorited")
                skillProvider?.setThemeFavorite(slug, favorited)
                val updated = skillProvider?.getThemeFavorites() ?: org.json.JSONArray()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, updated) }
            }
            "skills:get-chips" -> {
                val result = skillProvider?.getChips() ?: org.json.JSONArray()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "skills:set-chips" -> {
                val chips = msg.payload.optJSONArray("chips") ?: org.json.JSONArray()
                skillProvider?.setChips(chips)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("ok", true)) }
            }
            "skills:get-override" -> {
                val id = msg.payload.optString("id")
                val result = skillProvider?.getOverride(id) ?: JSONObject.NULL
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "skills:set-override" -> {
                val id = msg.payload.optString("id")
                val override = msg.payload.optJSONObject("override") ?: JSONObject()
                skillProvider?.setOverride(id, override)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("ok", true)) }
            }
            "skills:create-prompt" -> {
                val result = skillProvider?.createPromptSkill(msg.payload) ?: JSONObject()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "skills:delete-prompt" -> {
                val id = msg.payload.optString("id")
                skillProvider?.deletePromptSkill(id)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("ok", true)) }
            }
            // Phase 4a: publish a user-created plugin to the marketplace via gh CLI.
            // Mirrors the desktop flow: verify auth, fork, create branch, upload files,
            // open PR. Runs gh commands using the runtime environment so Termux's gh
            // binary is available through linker64.
            "skills:publish" -> {
                val pluginId = msg.payload.optString("id")
                if (pluginId.isBlank()) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("error", "Missing plugin id")) }
                    return
                }
                try {
                    val result = publishPluginViaGh(pluginId)
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
                } catch (e: Exception) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("error", e.message ?: "Publish failed")) }
                }
            }
            "skills:get-share-link" -> {
                val id = msg.payload.optString("id")
                val result = skillProvider?.generateShareLink(id) ?: ""
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "skills:import-from-link" -> {
                val encoded = msg.payload.optString("encoded")
                val result = skillProvider?.importFromLink(encoded) ?: JSONObject()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "skills:get-curated-defaults" -> {
                val result = skillProvider?.getCuratedDefaults() ?: org.json.JSONArray()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            // Marketplace redesign Phase 1 — curation data for hero/rails UI
            "skills:get-featured" -> {
                val result = skillProvider?.getFeatured() ?: JSONObject()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            // Marketplace redesign Phase 3 — integrations.
            // List returns the catalog (fetched from the wecoded-marketplace
            // registry) with a default state attached; install/connect/etc.
            // are still stubs that fail with not-implemented until the
            // Android Workspace slice ships.
            "integrations:list" -> {
                val result = skillProvider?.listIntegrations() ?: org.json.JSONArray()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            // Phase 4 — no-op on Android. Android MarketplaceFetcher caches
            // in a separate dir; if we ever add a bust there, wire here.
            "marketplace:invalidate-cache" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()) }
            }
            "integrations:status",
            "integrations:install",
            "integrations:uninstall",
            "integrations:connect",
            "integrations:configure" -> {
                val result = JSONObject().apply {
                    put("slug", msg.payload?.optString("slug") ?: "")
                    put("installed", false)
                    put("connected", false)
                    put("error", "not-implemented: integrations available on Android in a follow-up")
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            // Renderer-side platform detection. Android is explicitly "android"
            // — distinct from "linux" so integrations declaring
            // `platforms: ['linux']` don't accidentally enable here. Desktop
            // returns the raw process.platform string ('darwin'/'win32'/'linux').
            "platform:get" -> {
                val payload = JSONObject().apply { put("platform", "android") }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, payload) }
            }
            // Decomposition v3 §9.9: integration badges for the detail view
            "skills:get-integration-info" -> {
                val idArg = msg.payload?.optString("id") ?: ""
                val result = skillProvider?.getIntegrationInfo(idArg) ?: JSONObject()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            // Decomposition v3 §9.10: onboarding bulk install of curated packages
            "skills:install-many" -> {
                val idsJson = msg.payload?.optJSONArray("ids")
                val ids = mutableListOf<String>()
                if (idsJson != null) for (i in 0 until idsJson.length()) ids.add(idsJson.optString(i))
                val result = skillProvider?.installMany(ids) ?: org.json.JSONArray()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            // Decomposition v3 §9.10: onboarding output style selection
            "skills:apply-output-style" -> {
                val styleId = msg.payload?.optString("styleId") ?: ""
                skillProvider?.applyOutputStyle(styleId)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("ok", true)) }
            }
            // Phase 3a: unified packages map — lets the renderer compare installed
            // versions against the marketplace index to detect available updates
            "marketplace:get-packages" -> {
                val result = skillProvider?.configStore?.getPackages() ?: JSONObject()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            // Phase 3b: update an installed plugin to the latest marketplace version
            "skills:update" -> {
                val id = msg.payload.optString("id")
                val result = skillProvider?.update(id)
                    ?: JSONObject().put("ok", false).put("error", "Skill provider not initialized")
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            // Phase 3c: per-entry config storage
            "marketplace:get-config" -> {
                val id = msg.payload.optString("id")
                val configDir = File(bootstrap?.homeDir ?: filesDir, ".claude/youcoded-config")
                val configFile = File(configDir, "$id.json")
                val result = try {
                    if (configFile.exists()) JSONObject(configFile.readText()) else JSONObject()
                } catch (_: Exception) { JSONObject() }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "marketplace:set-config" -> {
                val id = msg.payload.optString("id")
                val values = msg.payload.optJSONObject("values") ?: JSONObject()
                val configDir = File(bootstrap?.homeDir ?: filesDir, ".claude/youcoded-config")
                configDir.mkdirs()
                File(configDir, "$id.json").writeText(values.toString(2))
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("ok", true)) }
            }
            // In-app file viewer — reads a plugin's SKILL.md / command / agent.
            // Tries on-disk install first, falls back to raw.githubusercontent.com.
            // Mirrors desktop's readComponent() from marketplace-file-reader.ts
            // (same {content, source, path} / {error} response shape).
            "marketplace:read-component" -> {
                val pluginId = msg.payload.optString("pluginId")
                val kind = msg.payload.optString("kind")
                val name = msg.payload.optString("name")
                val result = withContext(Dispatchers.IO) {
                    try {
                        val home = bootstrap?.homeDir ?: filesDir
                        val index = skillProvider?.listMarketplace(null) ?: org.json.JSONArray()
                        com.youcoded.app.skills.MarketplaceFileReader.readComponent(
                            home, pluginId, kind, name, index
                        )
                    } catch (e: Exception) {
                        JSONObject().put("error", e.message ?: "read-component failed")
                    }
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            // Reads the last model name from a Claude Code JSONL transcript —
            // used by the model picker to remember which model the session was
            // running. Mirrors desktop's model:read-last in ipc-handlers.ts.
            "model:read-last" -> {
                val transcriptPath = msg.payload.optString("transcriptPath")
                val result: Any = withContext(Dispatchers.IO) {
                    try {
                        val home = bootstrap?.homeDir ?: filesDir
                        val projectsDir = File(home, ".claude/projects").canonicalFile
                        val file = File(transcriptPath).canonicalFile
                        // Security: confine reads to ~/.claude/projects (no arbitrary paths)
                        if (!file.absolutePath.startsWith(projectsDir.absolutePath + File.separator)) {
                            JSONObject.NULL
                        } else if (!file.exists()) {
                            JSONObject.NULL
                        } else {
                            val lines = file.readLines()
                            var model: String? = null
                            for (i in lines.indices.reversed()) {
                                val line = lines[i].trim()
                                if (line.isEmpty()) continue
                                try {
                                    val entry = JSONObject(line)
                                    if (entry.optString("type") == "assistant") {
                                        val m = entry.optJSONObject("message")?.optString("model", "")
                                        if (!m.isNullOrEmpty()) { model = m; break }
                                    }
                                } catch (_: Exception) { /* skip malformed line */ }
                            }
                            if (model != null) model else JSONObject.NULL
                        }
                    } catch (_: Exception) {
                        JSONObject.NULL
                    }
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "favorites:get" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("favorites", org.json.JSONArray())) }
            }
            "favorites:set" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("ok", true)) }
            }
            "game:getIncognito" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, false) }
            }
            "game:setIncognito" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("ok", true)) }
            }
            "get-home-path" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, platformBridge?.getHomePath() ?: "") }
            }
            "dialog:open-file" -> {
                // Route through Activity — Service can't launch ActivityResultContracts
                val deferred = CompletableDeferred<List<String>>()
                pendingFilePicker = deferred
                withContext(Dispatchers.Main) {
                    onFilePickerRequested?.invoke()
                }
                try {
                    val paths = deferred.await()
                    val arr = org.json.JSONArray(paths)
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("paths", arr)) }
                } catch (_: Exception) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("paths", org.json.JSONArray())) }
                }
            }
            "dialog:open-folder" -> {
                // Route through Activity — same deferred pattern as file picker
                val deferred = CompletableDeferred<String?>()
                pendingFolderPicker = deferred
                withContext(Dispatchers.Main) {
                    onFolderPickerRequested?.invoke()
                }
                try {
                    val path = deferred.await()
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, path ?: JSONObject.NULL) }
                } catch (_: Exception) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject.NULL) }
                }
            }

            // ── Folders API (shared with desktop FolderSwitcher) ───────
            "folders:list" -> {
                val homeDir = bootstrap?.homeDir ?: filesDir
                val store = com.youcoded.app.config.WorkingDirStore(homeDir)
                val arr = org.json.JSONArray()
                // Always include home as first entry
                val home = JSONObject().apply {
                    put("path", homeDir.absolutePath)
                    put("nickname", "Home")
                    put("addedAt", 0)
                    put("exists", true)
                }
                arr.put(home)
                store.dirs.value.forEach { wd ->
                    arr.put(JSONObject().apply {
                        put("path", wd.path)
                        put("nickname", wd.label)
                        put("addedAt", 0)
                        put("exists", File(wd.path).isDirectory)
                        // WHY: serve the per-folder description on the wire so the shared
                        // React folder switcher can render it, matching desktop's
                        // youcoded-folders.json entries (Task 4).
                        put("description", wd.description)
                    })
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, arr) }
            }
            "folders:add" -> {
                val folderPath = msg.payload.optString("folderPath", "")
                val nickname = msg.payload.optString("nickname", "")
                if (folderPath.isNotEmpty()) {
                    val homeDir = bootstrap?.homeDir ?: filesDir
                    val store = com.youcoded.app.config.WorkingDirStore(homeDir)
                    val label = nickname.ifEmpty { File(folderPath).name }
                    store.add(com.youcoded.app.config.WorkingDir(label = label, path = folderPath))
                    msg.id?.let {
                        bridgeServer.respond(ws, msg.type, it, JSONObject().apply {
                            put("path", folderPath)
                            put("nickname", label)
                            put("addedAt", System.currentTimeMillis())
                            put("exists", File(folderPath).isDirectory)
                        })
                    }
                } else {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject.NULL) }
                }
            }
            "folders:remove" -> {
                val folderPath = msg.payload.optString("folderPath", "")
                if (folderPath.isNotEmpty()) {
                    val homeDir = bootstrap?.homeDir ?: filesDir
                    val store = com.youcoded.app.config.WorkingDirStore(homeDir)
                    store.remove(folderPath)
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, folderPath.isNotEmpty()) }
            }
            "folders:rename" -> {
                val folderPath = msg.payload.optString("folderPath", "")
                val nickname = msg.payload.optString("nickname", "")
                var renamed = false
                if (folderPath.isNotEmpty() && nickname.isNotEmpty()) {
                    val homeDir = bootstrap?.homeDir ?: filesDir
                    val store = com.youcoded.app.config.WorkingDirStore(homeDir)
                    val existing = store.dirs.value.find { it.path == folderPath }
                    if (existing != null) {
                        store.rename(folderPath, nickname)
                        renamed = true
                    }
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, renamed) }
            }
            "folders:set-description" -> {
                // WHY: local-folder counterpart to desktop's saved-folder description
                // (Task 4) — folders:rename has a real Android implementation, so this
                // needs one too instead of silently no-oping on mobile (see Task 5 brief).
                val folderPath = msg.payload.optString("folderPath", "")
                val description = msg.payload.optString("description", "")
                var ok = false
                if (folderPath.isNotEmpty()) {
                    val homeDir = bootstrap?.homeDir ?: filesDir
                    val store = com.youcoded.app.config.WorkingDirStore(homeDir)
                    if (store.dirs.value.any { it.path == folderPath }) {
                        store.setDescription(folderPath, description)
                        ok = true
                    }
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, ok) }
            }

            "clipboard:save-image" -> {
                val result = platformBridge?.saveClipboardImage() ?: JSONObject().put("path", JSONObject.NULL)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "remote:get-client-count" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, 1) }
            }
            "remote:get-config" -> {
                msg.id?.let {
                    bridgeServer.respond(ws, msg.type, it, JSONObject().apply {
                        put("enabled", false)
                        put("port", 9901)
                        put("hasPassword", false)
                        put("trustTailscale", false)
                        put("keepAwakeHours", 0)
                        put("clientCount", 1)
                    })
                }
            }
            "remote:detect-tailscale" -> {
                msg.id?.let { id ->
                    val installed = try {
                        packageManager.getPackageInfo("com.tailscale.ipn", 0); true
                    } catch (_: Exception) { false }

                    // Check if any network interface has a Tailscale CGNAT IP (100.64.0.0/10)
                    var connected = false
                    var tsIp: String? = null
                    try {
                        for (iface in java.net.NetworkInterface.getNetworkInterfaces()) {
                            for (addr in iface.inetAddresses) {
                                if (addr is java.net.Inet4Address) {
                                    val bytes = addr.address
                                    // 100.64.0.0/10 = first byte 100, second byte 64-127
                                    if (bytes[0] == 100.toByte() && (bytes[1].toInt() and 0xFF) in 64..127) {
                                        connected = true
                                        tsIp = addr.hostAddress
                                    }
                                }
                            }
                        }
                    } catch (_: Exception) {}

                    bridgeServer.respond(ws, msg.type, id, JSONObject().apply {
                        put("installed", installed)
                        put("connected", connected)
                        if (tsIp != null) put("ip", tsIp)
                    })
                }
            }
            "remote:get-client-list" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, org.json.JSONArray()) }
            }
            "remote:set-password" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, true) }
            }
            "remote:set-config" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()) }
            }
            "remote:disconnect-client" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, true) }
            }
            "transcript:read-meta" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject.NULL) }
            }
            "session:terminal-ready" -> {
                // fire-and-forget — no response needed
            }
            "session:browse" -> {
                val homeDir = bootstrap?.homeDir ?: filesDir
                val projectsDir = File(homeDir, ".claude/projects")
                val topicsDir = File(homeDir, ".claude/topics")
                // Collect active Claude session IDs to exclude from past sessions
                val activeIds = sessionRegistry.sessions.value.values.mapNotNull { s ->
                    s.ptyBridge?.getEventBridge()?.getClaudeSessionId(s.id)
                }.toSet()
                val pastSessions = withContext(Dispatchers.IO) {
                    SessionBrowser.listPastSessions(projectsDir, topicsDir, activeIds)
                }
                // Read user-set flag map from the synced conversation-index.json
                val flagMap = withContext(Dispatchers.IO) { readFlagMap(homeDir) }
                // Topic files are pruned after 30 days and never sync across
                // devices; conversation-index.json keeps the name longer and
                // does sync — fall back to it when the topic-file name is missing.
                val topicMap = withContext(Dispatchers.IO) { readTopicMap(homeDir) }
                val arr = org.json.JSONArray()
                for (s in pastSessions) {
                    // Name precedence: topic-file name > conversation-index topic
                    // > transcript-derived title > "Untitled". The topic file is
                    // pruned/unsynced, the index topic syncs but the auto-title
                    // hook may never have fired, so the transcript's first user
                    // message is the last-resort name. Mirrors desktop's
                    // session-browser.ts precedence. derivedTitle stays
                    // server-side — the payload's `name` already carries the
                    // final value, so the IPC shape is unchanged.
                    val indexTopic = topicMap[s.sessionId]
                    val resolvedName = when {
                        s.name != "Untitled" -> s.name
                        !indexTopic.isNullOrBlank() -> indexTopic
                        !s.derivedTitle.isNullOrBlank() -> s.derivedTitle!!
                        else -> "Untitled"
                    }
                    arr.put(JSONObject().apply {
                        put("sessionId", s.sessionId)
                        put("projectSlug", s.projectSlug)
                        put("name", resolvedName)
                        put("lastModified", s.lastModified)
                        put("projectPath", s.projectPath)
                        // Fix: React's formatSize(undefined) rendered as "NaNMB".
                        // The size field exists on PastSession but was never
                        // copied into the JSON response before.
                        put("size", s.size)
                        // flags: { complete: true, priority: true, ... } — only set flags included
                        val entryFlags = flagMap[s.sessionId]
                        if (entryFlags != null && entryFlags.isNotEmpty()) {
                            put("flags", JSONObject().apply {
                                for ((name, v) in entryFlags) put(name, v)
                            })
                        }
                    })
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, arr) }
            }
            "tags:list" -> {
                // Android tagging UI is deferred (Plan A design §"Cross-platform
                // parity & Android"). Return an empty registry so a shared-UI Tag
                // Picker degrades to "no tags" instead of hanging on a missing handler.
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, org.json.JSONArray()) }
            }
            "session:get-meta" -> {
                // Read channel — return an EMPTY meta object (not an error) so the
                // shared-UI in-session Tag chip degrades to "no tags/note" on touch.
                // supported=false because the WRITE handlers below are stubs: the
                // shared renderer reverts a refused write, so without this the chip
                // would accept a tag, flash it, and snap back with no explanation.
                // The reason string is Android's own — the desktop's "native
                // sessions" wording would be a misleading message here.
                val payload = org.json.JSONObject()
                    .put("tags", org.json.JSONArray())
                    .put("note", "")
                    .put("supported", false)
                    .put("unsupportedReason", "Tags and notes aren't available on mobile yet.")
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, payload) }
            }
            "tags:create", "tags:update", "tags:delete",
            "session:set-tag", "session:set-note" -> {
                // unsupported=true marks this as a CAPABILITY gap, not a transient
                // failure, so the renderer disables the control instead of retrying.
                val payload = org.json.JSONObject()
                    .put("ok", false)
                    .put("unsupported", true)
                    .put("error", "not-implemented-on-mobile")
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, payload) }
            }
            "session:set-flag" -> {
                // Set a named flag on a past session. Writes the same
                // conversation-index.json the desktop writes — sync picks it
                // up through the existing backup pipeline. Unknown flag names
                // are rejected so a typo surfaces as an error.
                val sessionId = msg.payload.optString("sessionId", "")
                val flag = msg.payload.optString("flag", "")
                val value = msg.payload.optBoolean("value", false)
                // 'helpful' retired (2026-07 custom-tags design) — parity with desktop
                // which dropped it from SESSION_FLAG_NAMES; custom tags supersede it.
                val allowed = setOf("complete", "priority")
                if (sessionId.isEmpty() || flag !in allowed) {
                    msg.id?.let {
                        bridgeServer.respond(ws, msg.type, it, JSONObject().apply {
                            put("ok", false)
                            put("error", if (sessionId.isEmpty()) "missing sessionId" else "unknown flag: $flag")
                        })
                    }
                } else {
                    val homeDir = bootstrap?.homeDir ?: filesDir
                    val ok = withContext(Dispatchers.IO) {
                        writeSessionFlag(homeDir, sessionId, flag, value)
                    }
                    msg.id?.let {
                        bridgeServer.respond(ws, msg.type, it, JSONObject().apply {
                            put("ok", ok)
                        })
                    }
                    bridgeServer.broadcast(JSONObject().apply {
                        put("type", "session:meta-changed")
                        put("payload", JSONObject().apply {
                            put("sessionId", sessionId)
                            put("flag", flag)
                            put("value", value)
                        })
                    })
                }
            }
            "session:history" -> {
                val sessionId = msg.payload.optString("sessionId", "")
                val projectSlug = msg.payload.optString("projectSlug", "")
                val count = msg.payload.optInt("count", 10)
                val all = msg.payload.optBoolean("all", false)
                if (sessionId.isEmpty()) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, org.json.JSONArray()) }
                } else {
                    val homeDir = bootstrap?.homeDir ?: filesDir
                    val projectsDir = File(homeDir, ".claude/projects")
                    // If no slug provided, scan for the session file
                    val slug = projectSlug.ifEmpty {
                        withContext(Dispatchers.IO) {
                            projectsDir.listFiles { f -> f.isDirectory }
                                ?.firstOrNull { dir -> File(dir, "$sessionId.jsonl").exists() }
                                ?.name ?: ""
                        }
                    }
                    if (slug.isEmpty()) {
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, org.json.JSONArray()) }
                    } else {
                        val result = withContext(Dispatchers.IO) {
                            SessionBrowser.loadHistory(projectsDir, slug, sessionId, count, all)
                        }
                        val arr = org.json.JSONArray()
                        for (m in result.messages) {
                            arr.put(JSONObject().apply {
                                put("role", m.role)
                                put("content", m.content)
                                put("timestamp", m.timestamp)
                            })
                        }
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, arr) }
                    }
                }
            }
            "ui:action" -> {
                val action = msg.payload.optString("action", "")
                // No "switch-view" branch on purpose: since Tier 2 the React UI owns
                // chat↔terminal switching entirely (xterm.js in the WebView is the only
                // terminal renderer — see ChatScreen.kt). The old native viewModeRequest
                // flow existed solely to drive the deleted Compose TerminalView block, and
                // desktop's relay of this action only exists to fan it out to OTHER remote
                // clients, which Android doesn't host. So switch-view needs no native work.
                when (action) {
                    "layout-update" -> {
                        val headerPx = msg.payload.optInt("headerHeight", 0)
                        val bottomPx = msg.payload.optInt("bottomHeight", 0)
                        _layoutInsets.tryEmit(LayoutInsets(headerPx, bottomPx))
                    }
                }
            }

            // ── Android-only settings bridge ────────────────────────────
            "android:get-tier" -> {
                val tierStore = com.youcoded.app.config.TierStore(applicationContext)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("tier", tierStore.selectedTier.name)) }
            }
            "android:set-tier" -> {
                val tierName = msg.payload.optString("tier", "CORE")
                val tierStore = com.youcoded.app.config.TierStore(applicationContext)
                val newTier = try {
                    com.youcoded.app.config.PackageTier.valueOf(tierName)
                } catch (_: Exception) { com.youcoded.app.config.PackageTier.CORE }
                val changed = newTier != tierStore.selectedTier
                tierStore.selectedTier = newTier
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("restartRequired", changed)) }
            }
            "android:get-about" -> {
                val pm = applicationContext.packageManager
                val info = pm.getPackageInfo(applicationContext.packageName, 0)
                msg.id?.let {
                    bridgeServer.respond(ws, msg.type, it, JSONObject().apply {
                        put("version", info.versionName ?: "unknown")
                        put("build", info.longVersionCode.toString())
                    })
                }
            }
            "android:get-paired-devices" -> {
                // Security: use encrypted storage for paired device credentials
                val prefs = getEncryptedPrefs()
                var json = prefs.getString("paired_devices", null)
                // Migration: if no data in encrypted prefs, check old unencrypted prefs
                if (json == null) {
                    val oldPrefs = applicationContext.getSharedPreferences("remote_devices", android.content.Context.MODE_PRIVATE)
                    val oldJson = oldPrefs.getString("paired_devices", null)
                    if (oldJson != null) {
                        prefs.edit().putString("paired_devices", oldJson).apply()
                        oldPrefs.edit().remove("paired_devices").apply() // Remove plaintext copy
                        json = oldJson
                    }
                }
                val devices = if (json != null) {
                    try { org.json.JSONArray(json) } catch (_: Exception) { org.json.JSONArray() }
                } else org.json.JSONArray()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("devices", devices)) }
            }
            "android:save-paired-device" -> {
                // Security: use encrypted storage for paired device credentials
                val prefs = getEncryptedPrefs()
                val existing = try {
                    org.json.JSONArray(prefs.getString("paired_devices", "[]"))
                } catch (_: Exception) { org.json.JSONArray() }
                val host = msg.payload.optString("host", "")
                val port = msg.payload.optInt("port", 9900)
                // Remove existing entry with same host:port
                val filtered = org.json.JSONArray()
                for (i in 0 until existing.length()) {
                    val d = existing.getJSONObject(i)
                    if (d.optString("host") != host || d.optInt("port") != port) {
                        filtered.put(d)
                    }
                }
                filtered.put(JSONObject().apply {
                    put("name", msg.payload.optString("name", "Desktop"))
                    put("host", host)
                    put("port", port)
                    put("password", msg.payload.optString("password", ""))
                })
                prefs.edit().putString("paired_devices", filtered.toString()).apply()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, true) }
            }
            "android:remove-paired-device" -> {
                // Security: use encrypted storage for paired device credentials
                val prefs = getEncryptedPrefs()
                val existing = try {
                    org.json.JSONArray(prefs.getString("paired_devices", "[]"))
                } catch (_: Exception) { org.json.JSONArray() }
                val host = msg.payload.optString("host", "")
                val port = msg.payload.optInt("port", 9900)
                val filtered = org.json.JSONArray()
                for (i in 0 until existing.length()) {
                    val d = existing.getJSONObject(i)
                    if (d.optString("host") != host || d.optInt("port") != port) {
                        filtered.put(d)
                    }
                }
                prefs.edit().putString("paired_devices", filtered.toString()).apply()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, true) }
            }
            "android:scan-qr" -> {
                // Route through Activity — camera requires Activity context
                val deferred = CompletableDeferred<String?>()
                pendingQrScanner = deferred
                withContext(Dispatchers.Main) {
                    onQrScanRequested?.invoke()
                }
                try {
                    val url = withTimeoutOrNull(120_000) { deferred.await() }
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("url", url ?: JSONObject.NULL)) }
                } catch (_: Exception) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("url", JSONObject.NULL)) }
                }
            }

            "model:get-preference" -> {
                val prefFile = File(bootstrap!!.homeDir, ".claude-mobile/model-preference.json")
                val model = try {
                    val json = org.json.JSONObject(prefFile.readText())
                    json.optString("model", "sonnet")
                } catch (_: Exception) { "sonnet" }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, model) }
            }
            "model:set-preference" -> {
                val model = msg.payload.optString("model", "sonnet")
                val prefFile = File(bootstrap!!.homeDir, ".claude-mobile/model-preference.json")
                prefFile.parentFile?.mkdirs()
                prefFile.writeText(org.json.JSONObject().put("model", model).toString())
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, true) }
            }

            "appearance:get" -> {
                val prefFile = File(bootstrap!!.homeDir, ".claude-mobile/youcoded-appearance.json")
                val result: Any = try {
                    org.json.JSONObject(prefFile.readText())
                } catch (_: Exception) { org.json.JSONObject.NULL }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "appearance:set" -> {
                val prefFile = File(bootstrap!!.homeDir, ".claude-mobile/youcoded-appearance.json")
                try {
                    val existing = try {
                        org.json.JSONObject(prefFile.readText())
                    } catch (_: Exception) { org.json.JSONObject() }
                    msg.payload.forEachKey { key ->
                        existing.put(key, msg.payload.get(key))
                    }
                    prefFile.parentFile?.mkdirs()
                    prefFile.writeText(existing.toString())
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, true) }
                } catch (_: Exception) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, false) }
                }
            }

            "defaults:get" -> {
                val defaultsFile = File(bootstrap!!.homeDir, ".claude-mobile/youcoded-defaults.json")
                val defaults = try {
                    val json = org.json.JSONObject(defaultsFile.readText())
                    JSONObject().apply {
                        put("skipPermissions", json.optBoolean("skipPermissions", false))
                        put("model", json.optString("model", "sonnet"))
                        put("projectFolder", json.optString("projectFolder", ""))
                        put("permissionOverrides", json.optJSONObject("permissionOverrides") ?: JSONObject())
                    }
                } catch (_: Exception) {
                    JSONObject().apply {
                        put("skipPermissions", false)
                        put("model", "sonnet")
                        put("projectFolder", "")
                        put("permissionOverrides", JSONObject())
                    }
                }
                // Sync overrides cache to all sessions
                syncPermissionOverridesToSessions(defaults.optJSONObject("permissionOverrides") ?: JSONObject())
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, defaults) }
            }
            "defaults:set" -> {
                val defaultsFile = File(bootstrap!!.homeDir, ".claude-mobile/youcoded-defaults.json")
                defaultsFile.parentFile?.mkdirs()
                // Read current, merge updates, write back
                val current = try {
                    org.json.JSONObject(defaultsFile.readText())
                } catch (_: Exception) {
                    JSONObject().apply {
                        put("skipPermissions", false)
                        put("model", "sonnet")
                        put("projectFolder", "")
                        put("permissionOverrides", JSONObject())
                    }
                }
                // Deep-merge permissionOverrides instead of replacing
                val payloadOverrides = msg.payload.optJSONObject("permissionOverrides")
                msg.payload.keys().forEach { key ->
                    if (key != "permissionOverrides") current.put(key, msg.payload.get(key))
                }
                if (payloadOverrides != null) {
                    val merged = current.optJSONObject("permissionOverrides") ?: JSONObject()
                    payloadOverrides.keys().forEach { key -> merged.put(key, payloadOverrides.get(key)) }
                    current.put("permissionOverrides", merged)
                }
                defaultsFile.writeText(current.toString(2))
                // Update in-memory cache so hook handler picks up changes immediately
                syncPermissionOverridesToSessions(current.optJSONObject("permissionOverrides") ?: JSONObject())
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, current) }
            }

            // --- Sync management (V2: multi-instance backend model) ---
            // Reads storage_backends array from config.json. Falls back to legacy
            // flat keys if the array doesn't exist yet (auto-migration on desktop).
            "sync:get-status" -> {
                val claudeDir = File(bootstrap!!.homeDir, ".claude")
                val configFile = File(claudeDir, "toolkit-state/config.json")
                val config = try { org.json.JSONObject(configFile.readText()) } catch (_: Exception) { org.json.JSONObject() }

                // Read backend instances from storage_backends array or build from legacy keys
                val backends = org.json.JSONArray()
                val storageBackends = config.optJSONArray("storage_backends")
                if (storageBackends != null) {
                    for (i in 0 until storageBackends.length()) {
                        val b = storageBackends.getJSONObject(i)
                        val id = b.getString("id")
                        // Read per-backend marker for last push time
                        val markerFile = File(claudeDir, "toolkit-state/.sync-marker-$id")
                        val lastPush = try { markerFile.readText().trim().toLong() } catch (_: Exception) { 0L }
                        // Read per-backend error file
                        val errorFile = File(claudeDir, "toolkit-state/.sync-error-$id")
                        val lastError = try { errorFile.readText().trim().ifEmpty { null } } catch (_: Exception) { null as String? }

                        backends.put(JSONObject().apply {
                            put("id", id)
                            put("type", b.getString("type"))
                            put("label", b.getString("label"))
                            put("syncEnabled", b.getBoolean("syncEnabled"))
                            put("config", b.getJSONObject("config"))
                            put("connected", lastError == null)
                            put("lastPushEpoch", if (lastPush > 0) lastPush else org.json.JSONObject.NULL)
                            put("lastError", lastError ?: org.json.JSONObject.NULL)
                        })
                    }
                } else {
                    // Legacy fallback: build from flat keys (pre-migration)
                    val backendStr = config.optString("PERSONAL_SYNC_BACKEND", "none")
                    val driveRoot = config.optString("DRIVE_ROOT", "Claude")
                    val syncRepo = config.optString("PERSONAL_SYNC_REPO", "")
                    val active = backendStr.split(",").map { it.trim().lowercase() }.filter { it.isNotEmpty() && it != "none" }
                    if (active.contains("drive")) {
                        backends.put(JSONObject().put("id", "drive-default").put("type", "drive").put("label", "Google Drive")
                            .put("syncEnabled", true).put("config", JSONObject().put("DRIVE_ROOT", driveRoot).put("rcloneRemote", "gdrive"))
                            .put("connected", true).put("lastPushEpoch", org.json.JSONObject.NULL).put("lastError", org.json.JSONObject.NULL))
                    }
                    if (active.contains("github")) {
                        backends.put(JSONObject().put("id", "github-default").put("type", "github").put("label", "GitHub")
                            .put("syncEnabled", true).put("config", JSONObject().put("PERSONAL_SYNC_REPO", syncRepo))
                            .put("connected", true).put("lastPushEpoch", org.json.JSONObject.NULL).put("lastError", org.json.JSONObject.NULL))
                    }
                }

                val markerFile = File(claudeDir, "toolkit-state/.sync-marker")
                val lastSyncEpoch = try { markerFile.readText().trim().toLong() } catch (_: Exception) { 0L }
                val metaFile = File(claudeDir, "backup-meta.json")
                val backupMeta: Any = try { org.json.JSONObject(metaFile.readText()) } catch (_: Exception) { org.json.JSONObject.NULL }
                val warningsFile = File(claudeDir, ".sync-warnings")
                val warnings = org.json.JSONArray().apply {
                    try { warningsFile.readText().lines().filter { it.isNotBlank() }.forEach { put(it) } } catch (_: Exception) {}
                }
                val lockDir = File(claudeDir, "toolkit-state/.sync-lock")

                val result = JSONObject().apply {
                    put("backends", backends)
                    put("lastSyncEpoch", if (lastSyncEpoch > 0) lastSyncEpoch else org.json.JSONObject.NULL)
                    put("backupMeta", backupMeta)
                    put("warnings", warnings)
                    put("syncInProgress", lockDir.isDirectory)
                    put("syncingBackendId", org.json.JSONObject.NULL)
                    put("syncedCategories", org.json.JSONArray().apply {
                        if (File(claudeDir, "projects").isDirectory) { put("memory"); put("conversations") }
                        if (File(claudeDir, "encyclopedia").isDirectory) put("encyclopedia")
                        if (File(claudeDir, "skills").isDirectory) put("skills")
                        if (File(claudeDir, "settings.json").exists()) put("system-config")
                    })
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "sync:get-config" -> {
                val configFile = File(bootstrap!!.homeDir, ".claude/toolkit-state/config.json")
                val config = try { org.json.JSONObject(configFile.readText()) } catch (_: Exception) { org.json.JSONObject() }
                val result = JSONObject().apply {
                    put("backends", config.optJSONArray("storage_backends") ?: org.json.JSONArray())
                    put("PERSONAL_SYNC_BACKEND", config.optString("PERSONAL_SYNC_BACKEND", "none"))
                    put("DRIVE_ROOT", config.optString("DRIVE_ROOT", "Claude"))
                    put("PERSONAL_SYNC_REPO", config.optString("PERSONAL_SYNC_REPO", ""))
                    put("ICLOUD_PATH", "")
                    put("SYNC_WIFI_ONLY", config.optString("SYNC_WIFI_ONLY", "true"))
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "sync:set-config" -> {
                val configFile = File(bootstrap!!.homeDir, ".claude/toolkit-state/config.json")
                configFile.parentFile?.mkdirs()
                val existing = try { org.json.JSONObject(configFile.readText()) } catch (_: Exception) { org.json.JSONObject() }
                val updates = msg.payload.optJSONObject("updates") ?: msg.payload
                updates.keys().forEach { key -> existing.put(key, updates.get(key)) }
                configFile.writeText(existing.toString(2))
                val result = JSONObject().apply {
                    put("backends", existing.optJSONArray("storage_backends") ?: org.json.JSONArray())
                    put("PERSONAL_SYNC_BACKEND", existing.optString("PERSONAL_SYNC_BACKEND", "none"))
                    put("DRIVE_ROOT", existing.optString("DRIVE_ROOT", "Claude"))
                    put("PERSONAL_SYNC_REPO", existing.optString("PERSONAL_SYNC_REPO", ""))
                    put("ICLOUD_PATH", existing.optString("ICLOUD_PATH", ""))
                    put("SYNC_WIFI_ONLY", existing.optString("SYNC_WIFI_ONLY", "true"))
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "sync:force" -> {
                val sync = syncService
                if (sync == null) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()
                        .put("success", false).put("output", "").put("error", "SyncService not initialized")) }
                } else {
                    try {
                        val result = sync.push(force = true)
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()
                            .put("success", result.success)
                            .put("output", result.backends.joinToString(", ").ifEmpty { "No backends configured" })
                            .put("error", if (result.errors > 0) "${result.errors} backend(s) had errors" else "")) }
                    } catch (e: Exception) {
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()
                            .put("success", false).put("output", "").put("error", e.message ?: "SyncService push failed")) }
                    }
                }
            }
            "sync:get-log" -> {
                val logFile = File(bootstrap!!.homeDir, ".claude/backup.log")
                val lines = msg.payload.optInt("lines", 30)
                val result = org.json.JSONArray().apply {
                    try { logFile.readLines().takeLast(lines).forEach { put(it) } } catch (_: Exception) {}
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "sync:dismiss-warning" -> {
                val warningsFile = File(bootstrap!!.homeDir, ".claude/.sync-warnings")
                val warning = msg.payload.optString("warning", "")
                if (warning.isNotEmpty() && warningsFile.exists()) {
                    val remaining = warningsFile.readLines().filter { it.trim() != warning.trim() }
                    if (remaining.isEmpty()) warningsFile.delete()
                    else warningsFile.writeText(remaining.joinToString("\n") + "\n")
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("ok", true)) }
            }

            // V2: Per-instance backend management
            "sync:add-backend" -> {
                val configFile = File(bootstrap!!.homeDir, ".claude/toolkit-state/config.json")
                configFile.parentFile?.mkdirs()
                val config = try { org.json.JSONObject(configFile.readText()) } catch (_: Exception) { org.json.JSONObject() }
                val backends = config.optJSONArray("storage_backends") ?: org.json.JSONArray()

                val type = msg.payload.getString("type")
                val label = msg.payload.getString("label")
                val slug = label.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-')
                var id = "$type-${slug.ifEmpty { "default" }}"
                // Ensure uniqueness
                val existingIds = (0 until backends.length()).map { backends.getJSONObject(it).getString("id") }.toSet()
                var counter = 2
                while (existingIds.contains(id)) { id = "$type-$slug-$counter"; counter++ }

                val newInstance = JSONObject().apply {
                    put("id", id)
                    put("type", type)
                    put("label", label)
                    put("syncEnabled", msg.payload.optBoolean("syncEnabled", true))
                    put("config", msg.payload.optJSONObject("config") ?: JSONObject())
                }
                backends.put(newInstance)
                config.put("storage_backends", backends)
                configFile.writeText(config.toString(2))
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, newInstance) }
            }
            "sync:remove-backend" -> {
                val id = msg.payload.optString("id", "")
                val configFile = File(bootstrap!!.homeDir, ".claude/toolkit-state/config.json")
                val config = try { org.json.JSONObject(configFile.readText()) } catch (_: Exception) { org.json.JSONObject() }
                val backends = config.optJSONArray("storage_backends") ?: org.json.JSONArray()
                val filtered = org.json.JSONArray()
                for (i in 0 until backends.length()) {
                    val b = backends.getJSONObject(i)
                    if (b.getString("id") != id) filtered.put(b)
                }
                config.put("storage_backends", filtered)
                configFile.writeText(config.toString(2))
                // Clean up per-backend state files
                val claudeDir = File(bootstrap!!.homeDir, ".claude")
                File(claudeDir, "toolkit-state/.sync-marker-$id").delete()
                File(claudeDir, "toolkit-state/.sync-error-$id").delete()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("ok", true)) }
            }
            "sync:update-backend" -> {
                val id = msg.payload.optString("id", "")
                val updates = msg.payload.optJSONObject("updates") ?: JSONObject()
                val configFile = File(bootstrap!!.homeDir, ".claude/toolkit-state/config.json")
                val config = try { org.json.JSONObject(configFile.readText()) } catch (_: Exception) { org.json.JSONObject() }
                val backends = config.optJSONArray("storage_backends") ?: org.json.JSONArray()
                var updated: JSONObject? = null
                for (i in 0 until backends.length()) {
                    val b = backends.getJSONObject(i)
                    if (b.getString("id") == id) {
                        if (updates.has("label")) b.put("label", updates.getString("label"))
                        if (updates.has("syncEnabled")) b.put("syncEnabled", updates.getBoolean("syncEnabled"))
                        if (updates.has("config")) {
                            val cfg = b.optJSONObject("config") ?: JSONObject()
                            val newCfg = updates.getJSONObject("config")
                            newCfg.keys().forEach { key -> cfg.put(key, newCfg.get(key)) }
                            b.put("config", cfg)
                        }
                        updated = b
                        break
                    }
                }
                config.put("storage_backends", backends)
                configFile.writeText(config.toString(2))
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, updated ?: JSONObject().put("error", "not found")) }
            }
            "sync:push-backend" -> {
                val id = msg.payload.optString("id", "")
                val sync = syncService
                if (sync == null) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("success", false).put("error", "SyncService not initialized")) }
                } else {
                    try {
                        val result = sync.push(force = true, backendId = id)
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()
                            .put("success", result.success).put("error", if (result.errors > 0) "Push had errors" else "")) }
                    } catch (e: Exception) {
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("success", false).put("error", e.message ?: "Push failed")) }
                    }
                }
            }
            "sync:pull-backend" -> {
                val id = msg.payload.optString("id", "")
                val sync = syncService
                if (sync == null) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("success", false).put("error", "SyncService not initialized")) }
                } else {
                    try {
                        sync.pull(backendId = id)
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("success", true).put("error", "")) }
                    } catch (e: Exception) {
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("success", false).put("error", e.message ?: "Pull failed")) }
                    }
                }
            }
            "sync:open-folder" -> {
                // On Android, return the URL so the WebView can open it via window.open
                val id = msg.payload.optString("id", "")
                val configFile = File(bootstrap!!.homeDir, ".claude/toolkit-state/config.json")
                val config = try { org.json.JSONObject(configFile.readText()) } catch (_: Exception) { org.json.JSONObject() }
                val backends = config.optJSONArray("storage_backends")
                var url = ""
                if (backends != null) {
                    for (i in 0 until backends.length()) {
                        val b = backends.getJSONObject(i)
                        if (b.getString("id") == id) {
                            when (b.getString("type")) {
                                "drive" -> url = "https://drive.google.com"
                                "github" -> url = b.optJSONObject("config")?.optString("PERSONAL_SYNC_REPO", "") ?: ""
                            }
                            break
                        }
                    }
                }
                if (url.isNotEmpty()) {
                    try {
                        val intent = android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))
                        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                        applicationContext.startActivity(intent)
                    } catch (_: Exception) {}
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("url", url)) }
            }

            // ── Restore from backup — directional user-initiated pull ─────────
            // Separate code path from sync (which is bidirectional merge). See
            // RestoreService.kt header for safety invariants (snapshot-first,
            // atomic swap, paused push loop).
            "sync:restore:probe" -> {
                val backendId = msg.payload.optString("backendId", "")
                val svc = restoreService
                if (svc == null) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("hasData", false).put("categories", org.json.JSONArray())) }
                } else {
                    try {
                        val (hasData, cats) = svc.probe(backendId)
                        val payload = JSONObject()
                            .put("hasData", hasData)
                            .put("categories", org.json.JSONArray(cats.map { c -> c.wire }))
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, payload) }
                    } catch (e: Exception) {
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("hasData", false).put("categories", org.json.JSONArray()).put("error", e.message ?: "probe failed")) }
                    }
                }
            }
            // Android's half of Electron's shell.openExternal. The React UI
            // runs under file:// here, where window.open from a promise
            // callback silently does nothing (see the sync:restore:browse-url
            // comment below) — so a Deliverables link tile would be a dead
            // button without this. Scheme-gated exactly like desktop's
            // OPEN_EXTERNAL handler: http/https only, never file:, intent:,
            // javascript:. The tap is always the user's own.
            "shell:open-external" -> {
                val url = msg.payload.optString("url", "")
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    try {
                        val intent = android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))
                        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                        applicationContext.startActivity(intent)
                    } catch (_: Exception) {}
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()) }
            }

            "sync:restore:browse-url" -> {
                // Resolve a deep link into the remote backend for a given
                // category (Drive folder, GitHub tree). UI shows a "browse remote"
                // button from the preview screen. Adapters that don't support
                // browse URLs return null → we pass JSONObject.NULL over the wire.
                val backendId = msg.payload.optString("backendId", "")
                val categoryStr = msg.payload.optString("category", "")
                val versionRef = msg.payload.optString("versionRef", "HEAD")
                val svc = restoreService
                if (svc == null) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("url", JSONObject.NULL)) }
                } else {
                    val cat = RestoreCategory.fromWire(categoryStr)
                    val url = if (cat == null) {
                        null
                    } else {
                        try {
                            svc.browseCategoryUrl(backendId, cat, versionRef)
                        } catch (_: Exception) { null }
                    }
                    // Fire Intent.ACTION_VIEW here — desktop's handler calls
                    // shell.openExternal as a side effect, but React on Android
                    // runs under file:// so its window.open fallback is a no-op.
                    // Without this, tapping the folder icon silently does
                    // nothing on mobile. Still return the URL so the IPC
                    // response shape stays identical to desktop.
                    if (url != null) {
                        platformBridge?.openUrl(url)
                    }
                    msg.id?.let {
                        bridgeServer.respond(ws, msg.type, it,
                            JSONObject().put("url", url ?: JSONObject.NULL))
                    }
                }
            }
            "sync:restore:list-versions" -> {
                val backendId = msg.payload.optString("backendId", "")
                val svc = restoreService
                if (svc == null) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, org.json.JSONArray()) }
                } else {
                    try {
                        val points = svc.listVersions(backendId)
                        val arr = org.json.JSONArray()
                        points.forEach { p -> arr.put(p.toJson()) }
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, arr) }
                    } catch (e: Exception) {
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("error", e.message ?: "listVersions failed")) }
                    }
                }
            }
            "sync:restore:preview" -> {
                val svc = restoreService
                if (svc == null) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("error", "RestoreService not initialized")) }
                } else {
                    try {
                        // React shim wraps as { opts: {...} } for preview/execute;
                        // other sync:restore:* handlers pass backendId at the top
                        // level. Mirror desktop's `payload.opts || payload` fallback.
                        val optsJson = msg.payload.optJSONObject("opts") ?: msg.payload
                        val opts = RestoreOptions.fromJson(optsJson)
                        val preview = svc.previewRestore(opts)
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, preview.toJson()) }
                    } catch (e: Exception) {
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("error", e.message ?: "preview failed")) }
                    }
                }
            }
            "sync:restore:execute" -> {
                val svc = restoreService
                if (svc == null) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("error", "RestoreService not initialized")) }
                } else {
                    try {
                        // Same { opts } unwrap as sync:restore:preview above.
                        val optsJson = msg.payload.optJSONObject("opts") ?: msg.payload
                        val opts = RestoreOptions.fromJson(optsJson)
                        // Progress events are broadcast (no id) — matches desktop's
                        // sync:restore:progress push-event shape. Wizard UI subscribes
                        // to them across every connected client.
                        val result = svc.executeRestore(opts) { evt ->
                            bridgeServer.broadcast(JSONObject().apply {
                                put("type", "sync:restore:progress")
                                put("payload", evt.toJson())
                            })
                        }
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, result.toJson()) }
                    } catch (e: Exception) {
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("error", e.message ?: "execute failed")) }
                    }
                }
            }
            "sync:restore:list-snapshots" -> {
                val svc = restoreService
                if (svc == null) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, org.json.JSONArray()) }
                } else {
                    try {
                        val arr = org.json.JSONArray()
                        svc.listSnapshots().forEach { s -> arr.put(s.toJson()) }
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, arr) }
                    } catch (e: Exception) {
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("error", e.message ?: "listSnapshots failed")) }
                    }
                }
            }
            "sync:restore:undo" -> {
                val svc = restoreService
                if (svc == null) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("ok", false).put("error", "RestoreService not initialized")) }
                } else {
                    try {
                        val snapshotId = msg.payload.optString("snapshotId", "")
                        svc.undoRestore(snapshotId)
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("ok", true)) }
                    } catch (e: Exception) {
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("ok", false).put("error", e.message ?: "undo failed")) }
                    }
                }
            }
            "sync:restore:delete-snapshot" -> {
                val svc = restoreService
                if (svc == null) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("ok", false).put("error", "RestoreService not initialized")) }
                } else {
                    try {
                        val snapshotId = msg.payload.optString("snapshotId", "")
                        svc.deleteSnapshot(snapshotId)
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("ok", true)) }
                    } catch (e: Exception) {
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("ok", false).put("error", e.message ?: "delete failed")) }
                    }
                }
            }

            // ── Theme file IPC — parity with desktop's theme:list /
            // theme:read-file / theme:write-file handlers. theme-context.tsx
            // calls these to populate the appearance picker with installed
            // themes (both user-created and marketplace-installed). Without
            // them, remote-shim's .catch(() => []) swallows the error and
            // community theme installs appear to do nothing. ────────────
            "theme:list" -> {
                val slugs = org.json.JSONArray()
                try {
                    if (themesDir.exists() && themesDir.isDirectory) {
                        themesDir.listFiles()?.forEach { child ->
                            if (child.isDirectory && File(child, "manifest.json").exists()) {
                                slugs.put(child.name)
                            }
                        }
                    }
                } catch (e: Exception) {
                    android.util.Log.w("SessionService", "theme:list failed", e)
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, slugs) }
            }
            "theme:read-file" -> {
                val slug = msg.payload.optString("slug", "")
                val result: Any = if (!safeSlugRe.matches(slug)) {
                    "" // remote-shim normalizes empty/null to null — React falls through
                } else {
                    try {
                        val manifest = File(themesDir, "$slug/manifest.json")
                        // Path-traversal guard: resolved path must stay inside themesDir
                        val canonical = manifest.canonicalFile
                        if (!canonical.path.startsWith(themesDir.canonicalPath + File.separator)) ""
                        else if (!canonical.exists()) ""
                        else canonical.readText()
                    } catch (e: Exception) {
                        android.util.Log.w("SessionService", "theme:read-file failed for $slug", e)
                        ""
                    }
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "theme:write-file" -> {
                val slug = msg.payload.optString("slug", "")
                val content = msg.payload.optString("content", "")
                if (safeSlugRe.matches(slug)) {
                    try {
                        val themeDir = File(themesDir, slug).canonicalFile
                        if (themeDir.path.startsWith(themesDir.canonicalPath + File.separator)) {
                            File(themeDir, "assets").mkdirs()
                            File(themeDir, "manifest.json").writeText(content)
                        }
                    } catch (e: Exception) {
                        android.util.Log.w("SessionService", "theme:write-file failed for $slug", e)
                    }
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("ok", true)) }
            }

            // ── Phase 5a: Theme marketplace browsing ─────────────────
            "theme-marketplace:list" -> {
                val result = withContext(Dispatchers.IO) {
                    themeMarketplaceList(msg.payload)
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "theme-marketplace:detail" -> {
                val slug = msg.payload.optString("slug", "")
                val result = withContext(Dispatchers.IO) {
                    themeMarketplaceDetail(slug)
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "theme-marketplace:install" -> {
                val slug = msg.payload.optString("slug", "")
                val result = withContext(Dispatchers.IO) {
                    themeMarketplaceInstall(slug)
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "theme-marketplace:uninstall" -> {
                val slug = msg.payload.optString("slug", "")
                val result = withContext(Dispatchers.IO) {
                    themeMarketplaceUninstall(slug)
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "theme-marketplace:update" -> {
                val slug = msg.payload.optString("slug", "")
                val result = withContext(Dispatchers.IO) {
                    themeMarketplaceInstall(slug)
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "theme-marketplace:publish" -> {
                val slug = msg.payload.optString("slug", "")
                val result = withContext(Dispatchers.IO) {
                    publishThemeViaGh(slug)
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "theme-marketplace:generate-preview" -> {
                android.util.Log.i("SessionService", "generate-preview not supported on Android")
                msg.id?.let {
                    bridgeServer.respond(ws, msg.type, it,
                        JSONObject().put("path", JSONObject.NULL))
                }
            }
            // --- Guided setup wizard: prereq detection, install, OAuth, repo creation ---
            "sync:setup:check-prereqs" -> {
                val backend = msg.payload.optString("backend", "")
                val boot = bootstrap!!
                val result = JSONObject()

                // rclone is bundled in Android Bootstrap — always installed
                val rcloneBin = File(boot.usrDir, "bin/rclone")
                result.put("rcloneInstalled", rcloneBin.exists())

                // Check if a Google Drive rclone remote exists
                var gdriveConfigured = false
                var gdriveRemoteName: String? = null
                if (rcloneBin.exists()) {
                    val listResult = syncService?.execCommand(listOf("rclone", "listremotes"))
                    if (listResult != null && listResult.code == 0) {
                        val remotes = listResult.stdout.lines().map { it.trim().trimEnd(':') }.filter { it.isNotEmpty() }
                        for (remote in remotes) {
                            val showResult = syncService?.execCommand(listOf("rclone", "config", "show", remote))
                            if (showResult != null && showResult.code == 0 && showResult.stdout.contains("type = drive")) {
                                gdriveConfigured = true
                                gdriveRemoteName = remote
                                break
                            }
                        }
                    }
                }
                result.put("gdriveConfigured", gdriveConfigured)
                result.put("gdriveRemoteName", gdriveRemoteName ?: org.json.JSONObject.NULL)

                // Check gh CLI
                val ghBin = File(boot.usrDir, "bin/gh")
                result.put("ghInstalled", ghBin.exists())
                var ghAuthenticated = false
                var ghUsername: String? = null
                if (ghBin.exists()) {
                    val authResult = syncService?.execCommand(listOf("gh", "auth", "status"))
                    ghAuthenticated = authResult != null && authResult.code == 0
                    if (ghAuthenticated) {
                        val userResult = syncService?.execCommand(listOf("gh", "api", "user", "--jq", ".login"))
                        if (userResult != null && userResult.code == 0) ghUsername = userResult.stdout.trim().ifEmpty { null }
                    }
                }
                result.put("ghAuthenticated", ghAuthenticated)
                result.put("ghUsername", ghUsername ?: org.json.JSONObject.NULL)

                // iCloud not available on Android
                result.put("icloudPath", org.json.JSONObject.NULL)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "sync:setup:install-rclone" -> {
                // No-op on Android — rclone is bundled in Bootstrap CORE tier
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("success", true)) }
            }
            "sync:setup:check-gdrive" -> {
                var configured = false
                var remoteName: String? = null
                val listResult = syncService?.execCommand(listOf("rclone", "listremotes"))
                if (listResult != null && listResult.code == 0) {
                    val remotes = listResult.stdout.lines().map { it.trim().trimEnd(':') }.filter { it.isNotEmpty() }
                    for (remote in remotes) {
                        val showResult = syncService?.execCommand(listOf("rclone", "config", "show", remote))
                        if (showResult != null && showResult.code == 0 && showResult.stdout.contains("type = drive")) {
                            configured = true
                            remoteName = remote
                            break
                        }
                    }
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()
                    .put("configured", configured).put("remoteName", remoteName ?: org.json.JSONObject.NULL)) }
            }
            "sync:setup:auth-gdrive" -> {
                // Stream rclone's stderr and open the OAuth URL via Intent —
                // rclone can't auto-open xdg-open on Android (Go's raw execve
                // bypasses termux-exec's LD_PRELOAD shim; see PITFALLS.md →
                // Android Runtime). PlatformBridge.openUrl uses
                // Intent.ACTION_VIEW, the SELinux-safe path.
                val sync = syncService
                val pb = platformBridge
                if (sync == null) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()
                        .put("success", false).put("remoteName", "gdrive").put("error", "SyncService not initialized")) }
                } else {
                    try {
                        val result = sync.authGdriveWithBrowserIntent { url ->
                            pb?.openUrl(url)
                        }
                        if (result.code == 0) {
                            msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()
                                .put("success", true).put("remoteName", "gdrive")) }
                        } else {
                            msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()
                                .put("success", false).put("remoteName", "gdrive").put("error", result.stderr.ifEmpty { "Google sign-in failed" })) }
                        }
                    } catch (e: Exception) {
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()
                            .put("success", false).put("remoteName", "gdrive").put("error", e.message ?: "Sign-in failed")) }
                    }
                }
            }
            "sync:setup:auth-github" -> {
                val sync = syncService
                if (sync == null) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()
                        .put("success", false).put("username", org.json.JSONObject.NULL).put("error", "SyncService not initialized")) }
                } else {
                    try {
                        val result = sync.execCommand(listOf("gh", "auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"), timeoutSeconds = 120)
                        if (result.code == 0) {
                            val userResult = sync.execCommand(listOf("gh", "api", "user", "--jq", ".login"))
                            val username = if (userResult.code == 0) userResult.stdout.trim().ifEmpty { null } else null
                            msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()
                                .put("success", true).put("username", username ?: org.json.JSONObject.NULL)) }
                        } else {
                            msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()
                                .put("success", false).put("username", org.json.JSONObject.NULL).put("error", result.stderr.ifEmpty { "GitHub sign-in failed" })) }
                        }
                    } catch (e: Exception) {
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()
                            .put("success", false).put("username", org.json.JSONObject.NULL).put("error", e.message ?: "Sign-in failed")) }
                    }
                }
            }
            "sync:setup:create-repo" -> {
                val repoName = msg.payload.optString("repoName", "")
                if (!repoName.matches(Regex("^[a-zA-Z0-9._-]+$")) || repoName.length > 100) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()
                        .put("success", false).put("repoUrl", org.json.JSONObject.NULL).put("error", "Invalid repository name")) }
                } else {
                    val sync = syncService
                    if (sync == null) {
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()
                            .put("success", false).put("repoUrl", org.json.JSONObject.NULL).put("error", "SyncService not initialized")) }
                    } else {
                        val userResult = sync.execCommand(listOf("gh", "api", "user", "--jq", ".login"))
                        val username = if (userResult.code == 0) userResult.stdout.trim() else ""
                        if (username.isEmpty()) {
                            msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()
                                .put("success", false).put("repoUrl", org.json.JSONObject.NULL).put("error", "Not signed in to GitHub")) }
                        } else {
                            val result = sync.execCommand(listOf("gh", "repo", "create", "$username/$repoName", "--private",
                                "--description", "Personal Claude data backup (managed by YouCoded)"))
                            if (result.code == 0 || result.stderr.contains("already exists")) {
                                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()
                                    .put("success", true).put("repoUrl", "https://github.com/$username/$repoName")) }
                            } else {
                                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()
                                    .put("success", false).put("repoUrl", org.json.JSONObject.NULL).put("error", result.stderr.ifEmpty { "Failed to create repository" })) }
                            }
                        }
                    }
                }
            }

            // ── Account (device-code OAuth + profile) ───────────────────────────
            // These account:* types mirror the desktop marketplace-api-handlers.ts
            // account:* channels exactly. Renamed from marketplace:auth:* in the
            // accounts Phase 1 rework; wire shapes (ApiResult.toJson) are unchanged.

            "account:start" -> {
                // Calls the Worker to start device-code flow, then opens the browser
                // via the Activity callback so the user can authorize on GitHub.
                // WHY Activity callback: Service cannot startActivity() with FLAG_ACTIVITY_NEW_TASK
                // for browser intents reliably — we delegate to MainActivity which is in foreground.
                val result = marketplaceApiClient.authStart()
                if (result is ApiResult.Ok) {
                    val authUrl = result.value.optString("auth_url", "")
                    if (authUrl.isNotEmpty()) {
                        // Non-fatal: if no browser is installed, log and no-op —
                        // the renderer still receives auth_url and can display it for manual copy.
                        try {
                            withContext(Dispatchers.Main) {
                                onMarketplaceAuthUrlRequested?.invoke(authUrl)
                            }
                        } catch (e: Exception) {
                            android.util.Log.w("SessionService", "account:start — browser open failed: ${e.message}")
                        }
                    }
                }
                msg.id?.let {
                    bridgeServer.respond(ws, msg.type, it, result.toJson { v -> v })
                }
            }

            "account:poll" -> {
                // payload: { deviceCode } (camelCase — matches remote-shim.ts invoke call)
                val deviceCode = msg.payload.optString("deviceCode", "")
                val result = marketplaceApiClient.authPoll(deviceCode)
                if (result is ApiResult.Ok) {
                    // If complete, persist the token immediately so subsequent calls are authenticated
                    val pollBody = result.value
                    if (pollBody.optString("status") == "complete") {
                        val token = pollBody.optString("token", "")
                        if (token.isNotEmpty()) {
                            // WHY: token not logged — only status logged
                            android.util.Log.i("SessionService", "account:poll — complete, saving token")
                            marketplaceAuthStore.setToken(token)
                            // Persist user info if returned alongside token. The Worker now
                            // returns the full account profile (display_name/handle) so the
                            // account:user query works immediately without a /auth/me round-trip.
                            val userObj = pollBody.optJSONObject("user")
                            if (userObj != null) {
                                val user = MarketplaceUser(
                                    id        = userObj.optString("id", ""),
                                    login     = userObj.optString("login", ""),
                                    avatarUrl = userObj.optString("avatar_url", ""),
                                    // isNull() guards: optString(name, null) returns the Java "null" string, not real null.
                                    displayName = if (userObj.isNull("display_name")) null else userObj.optString("display_name"),
                                    handle      = if (userObj.isNull("handle")) null else userObj.optString("handle"),
                                )
                                marketplaceAuthStore.setSession(token, user)
                            }
                        }
                    }
                }
                msg.id?.let {
                    bridgeServer.respond(ws, msg.type, it, result.toJson { v -> v })
                }
            }

            "account:signed-in" -> {
                // Plain boolean — no HTTP call, reads local store only
                val signedIn = marketplaceAuthStore.getToken() != null
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, signedIn) }
            }

            "account:user" -> {
                // Returns the stored MarketplaceUser as a JSONObject, or null.
                var user = marketplaceAuthStore.getUser()
                // WHY capture the token BEFORE the suspend: authMe() can take up to 30s;
                // a sign-out processed during that window would make a re-read + `!!` throw
                // NPE and crash the service scope. Capturing matches desktop, which reads
                // the token before its await. Worst case we re-persist a session the user
                // just cleared — the next sign-out clears it again; no crash path.
                val healToken = marketplaceAuthStore.getToken()
                if (user == null && healToken != null) {
                    // Heal (desktop parity): a token stored before profile storage existed
                    // (pre-2026-07 sign-ins) has no cached user — fetch /auth/me once and persist.
                    // On any failure (offline, revoked) leave user null; the token stays untouched.
                    val me = marketplaceApiClient.authMe()
                    if (me is ApiResult.Ok) {
                        val healed = MarketplaceUser(
                            id        = me.value.optString("id"),
                            login     = me.value.optString("login"),
                            avatarUrl = me.value.optString("avatar_url", ""),
                            // isNull() checks — optString(name, null) is a Java-null trap.
                            displayName = if (me.value.isNull("display_name")) null else me.value.optString("display_name"),
                            handle      = if (me.value.isNull("handle")) null else me.value.optString("handle"),
                        )
                        marketplaceAuthStore.setSession(healToken, healed)
                        user = healed
                    } else if (me is ApiResult.Err && me.status == 401) {
                        // Fix: the stored token is dead server-side — clear the local
                        // session so the UI flips to signed-out (desktop parity with the
                        // account:user heal path). Leave `user` null; we respond null below.
                        marketplaceAuthStore.signOut()
                    }
                }
                // Shared serializer (accountUserJson) — same wire shape as account:refresh,
                // so the snake_case format React reads can't drift between the two cases.
                val result: Any = user?.let { u -> accountUserJson(u) } ?: JSONObject.NULL
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }

            "account:refresh" -> {
                // Force-revalidate the cached profile against /auth/me. Unlike
                // account:user (which heals ONLY when the cache is empty), this ALWAYS
                // re-fetches — so a rename or newly-claimed @handle made on another
                // device reaches this client without a sign-out/in cycle (knowledge-debt #8).
                // WHY capture the token BEFORE the suspend: authMe() can take up to 30s;
                // a sign-out processed during that window would make a re-read + `!!`
                // throw NPE. Desktop parity: marketplace-api-handlers.ts account:refresh.
                val refreshToken = marketplaceAuthStore.getToken()
                val result: Any = if (refreshToken == null) {
                    JSONObject.NULL
                } else {
                    val me = marketplaceApiClient.authMe()
                    if (me is ApiResult.Ok) {
                        val fresh = MarketplaceUser(
                            id        = me.value.optString("id"),
                            login     = me.value.optString("login"),
                            avatarUrl = me.value.optString("avatar_url", ""),
                            // isNull() checks — optString(name, null) is a Java-null trap.
                            displayName = if (me.value.isNull("display_name")) null else me.value.optString("display_name"),
                            handle      = if (me.value.isNull("handle")) null else me.value.optString("handle"),
                        )
                        marketplaceAuthStore.setSession(refreshToken, fresh)
                        accountUserJson(fresh)
                    } else if (me is ApiResult.Err && me.status == 401) {
                        // Dead token server-side — clear the local session so the UI flips
                        // signed-out (desktop parity with clearSessionOn401). Respond null.
                        marketplaceAuthStore.signOut()
                        JSONObject.NULL
                    } else {
                        // Any other failure (offline, parse) leaves the session untouched.
                        // Respond with the CACHED profile so a network blip can't blank a
                        // signed-in UI — the renderer's focus/interval revalidation retries.
                        val cached = marketplaceAuthStore.getUser()
                        if (cached != null) accountUserJson(cached) else JSONObject.NULL
                    }
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }

            "account:sign-out" -> {
                // Best-effort server-side revocation first (desktop parity), then clear locally.
                // Offline sign-out still clears local credentials — never trap the user signed in.
                // WHY no runCatching: request() already catches I/O errors internally and returns
                // Err, so wrapping here could only swallow CancellationException (a coroutine
                // anti-pattern) or real programming bugs. Log Err so orphaned server-side
                // session rows are debuggable (the 90-day expiry + prune cron mop them up).
                val revoke = marketplaceApiClient.logout()
                if (revoke is ApiResult.Err) {
                    android.util.Log.w("SessionService", "account:sign-out — server logout failed (${revoke.status}): ${revoke.message}")
                }
                marketplaceAuthStore.signOut()
                // Drop the presence socket so we don't linger online after the
                // local token is cleared (desktop parity: notifySignedOut).
                presenceClient.setDesired(false)
                // And forget the remembered friends leaderboards — the next person
                // to sign in on this device must never be shown the last one's
                // friends (desktop parity: clearArcadeCache).
                arcadeBoardCache.clear()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, true) }
            }

            "account:update-profile" -> {
                // payload: { displayName } (camelCase — matches remote-shim.ts)
                val result = marketplaceApiClient.updateProfile(msg.payload.optString("displayName", ""))
                // Mirror the new display name into the stored profile so account:user reflects it without a /auth/me round-trip.
                if (result is ApiResult.Ok) {
                    val user = marketplaceAuthStore.getUser()
                    val token = marketplaceAuthStore.getToken()
                    if (user != null && token != null) {
                        // isNull() guard — same Java-null-trap convention as the heal path above.
                        val echoed = if (result.value.isNull("display_name")) null else result.value.optString("display_name")
                        marketplaceAuthStore.setSession(token, user.copy(displayName = echoed))
                    }
                }
                // Fix: a 401 means the token is dead server-side (migration drop, 90-day
                // idle expiry, revocation). Clear the local session so the UI flips to
                // signed-out instead of stranding the user "signed in" with every call
                // failing. Still respond with the Err so the renderer shows the message.
                clearSessionOn401(result)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result.toJson { v -> v }) }
            }

            "account:set-handle" -> {
                // payload: { handle } (camelCase — matches remote-shim.ts)
                val result = marketplaceApiClient.setHandle(msg.payload.optString("handle", ""))
                // Mirror the claimed handle into the stored profile.
                if (result is ApiResult.Ok) {
                    val user = marketplaceAuthStore.getUser()
                    val token = marketplaceAuthStore.getToken()
                    if (user != null && token != null) {
                        // isNull() guard — same Java-null-trap convention as the heal path above.
                        val echoed = if (result.value.isNull("handle")) null else result.value.optString("handle")
                        marketplaceAuthStore.setSession(token, user.copy(handle = echoed))
                    }
                }
                // Fix: 401 → clear local session (dead/expired token) so the UI flips to
                // signed-out. This is the exact migration bug: the post-sign-in handle
                // prompt returned "invalid token" with no way out. Still respond with Err.
                clearSessionOn401(result)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result.toJson { v -> v }) }
            }

            "account:delete" -> {
                // Permanent hard-delete (Worker cascades all rows). Clear the local session only on success.
                val result = marketplaceApiClient.deleteAccount()
                if (result is ApiResult.Ok) {
                    marketplaceAuthStore.signOut()
                    // Drop the presence socket on account deletion too (desktop parity).
                    presenceClient.setDesired(false)
                    // Forget the remembered friends leaderboards too (desktop parity).
                    arcadeBoardCache.clear()
                }
                // Fix: a 401 also means the session is dead (already deleted / expired) —
                // clear locally so the UI flips to signed-out rather than looping on a
                // delete that can never authenticate. Still respond with the Err.
                clearSessionOn401(result)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result.toJson { v -> v }) }
            }

            "account:export" -> {
                // WHY: Android WebView has no native save-dialog path (desktop opens
                // dialog.showSaveDialog). We write the export JSON into the public
                // Downloads collection via MediaStore, which requires API 29+ (minSdk
                // is 28). Below 29, respond an error the renderer surfaces inline.
                if (android.os.Build.VERSION.SDK_INT < 29) {
                    msg.id?.let {
                        // status:0 = local/non-API failure (desktop convention) — keeps the
                        // renderer's error type ({ ok:false, status, error }) required and truthful.
                        bridgeServer.respond(ws, msg.type, it, JSONObject().put("ok", false).put("status", 0).put("error", "export requires Android 10+"))
                    }
                } else {
                    val result = marketplaceApiClient.exportData()
                    val response: JSONObject = if (result is ApiResult.Ok) {
                        val stamp = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(java.util.Date())
                        val filename = "youcoded-account-export-$stamp.json"
                        try {
                            writeExportToDownloads(filename, result.value.toString(2))
                            // Match desktop's { path } success shape (relative label — the
                            // absolute MediaStore path isn't a plain filesystem path anyway).
                            JSONObject().put("path", "Downloads/$filename")
                        } catch (e: Exception) {
                            android.util.Log.w("SessionService", "account:export write failed: ${e.message}")
                            // status:0 = local write failure, matching desktop's non-API convention.
                            JSONObject().put("ok", false).put("status", 0).put("error", (e.message ?: "failed to write export"))
                        }
                    } else {
                        // Fetch failure — clear on 401 (dead session) and surface { ok:false }
                        // like the desktop handler, preserving .status for the UI.
                        clearSessionOn401(result)
                        val err = result as ApiResult.Err
                        JSONObject().put("ok", false).put("status", err.status).put("error", err.message)
                    }
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, response) }
                }
            }

            // ── Marketplace write endpoints ───────────────────────────────────

            "marketplace:install" -> {
                // payload: { pluginId } (camelCase)
                val pluginId = msg.payload.optString("pluginId", "")
                val result = marketplaceApiClient.postInstall(pluginId)
                msg.id?.let {
                    bridgeServer.respond(ws, msg.type, it, result.toJson { _ -> JSONObject.NULL })
                }
            }

            "marketplace:rate" -> {
                // payload passed flat: { plugin_id, stars, review_text? } (snake_case from TS input)
                val pluginId   = msg.payload.optString("plugin_id", "")
                val stars      = msg.payload.optInt("stars", 0)
                val reviewText = msg.payload.optString("review_text", "").ifEmpty { null }
                val result = marketplaceApiClient.postRating(pluginId, stars, reviewText)
                msg.id?.let {
                    // value shape: { hidden: boolean }
                    bridgeServer.respond(ws, msg.type, it, result.toJson { v -> v })
                }
            }

            "marketplace:rate:delete" -> {
                // payload: { pluginId } (camelCase)
                val pluginId = msg.payload.optString("pluginId", "")
                val result = marketplaceApiClient.deleteRating(pluginId)
                msg.id?.let {
                    bridgeServer.respond(ws, msg.type, it, result.toJson { _ -> JSONObject.NULL })
                }
            }

            "marketplace:theme:like" -> {
                // payload: { themeId } (camelCase)
                val themeId = msg.payload.optString("themeId", "")
                val result = marketplaceApiClient.toggleThemeLike(themeId)
                msg.id?.let {
                    // value shape: { liked: boolean }
                    bridgeServer.respond(ws, msg.type, it, result.toJson { v -> v })
                }
            }

            "marketplace:thumb" -> {
                // payload passed flat: { plugin_id, value: "up" | "down" | null }
                val pluginId = msg.payload.optString("plugin_id", "")
                val value = if (msg.payload.isNull("value")) null else msg.payload.optString("value", "")
                val result = marketplaceApiClient.setThumb(pluginId, value)
                msg.id?.let {
                    // value shape: { vote, thumbs_up, thumbs_down } — the totals ride
                    // along so the UI moves the number without re-fetching /stats.
                    bridgeServer.respond(ws, msg.type, it, result.toJson { v ->
                        JSONObject()
                            .put("vote", v.opt("vote") ?: JSONObject.NULL)
                            .put("thumbs_up", v.optInt("thumbs_up"))
                            .put("thumbs_down", v.optInt("thumbs_down"))
                    })
                }
            }

            "marketplace:thumb:get" -> {
                // payload: { plugin_id } — the shim wraps the id in an object on
                // purpose; a bare string would not be a JSONObject here.
                val pluginId = msg.payload.optString("plugin_id", "")
                val result = marketplaceApiClient.getThumb(pluginId)
                msg.id?.let {
                    // value shape: { vote: "up" | "down" | null }
                    bridgeServer.respond(ws, msg.type, it, result.toJson { v ->
                        JSONObject().put("vote", v.opt("vote") ?: JSONObject.NULL)
                    })
                }
            }

            "marketplace:comment" -> {
                // payload passed flat: { plugin_id, text }
                val pluginId = msg.payload.optString("plugin_id", "")
                val text = msg.payload.optString("text", "")
                val result = marketplaceApiClient.postComment(pluginId, text)
                msg.id?.let {
                    // value shape: { id, hidden }
                    bridgeServer.respond(ws, msg.type, it, result.toJson { v ->
                        JSONObject().put("id", v.optString("id")).put("hidden", v.optBoolean("hidden"))
                    })
                }
            }

            "marketplace:report" -> {
                // payload passed flat: { rating_user_id, rating_plugin_id, reason? } (snake_case)
                val ratingUserId   = msg.payload.optString("rating_user_id", "")
                val ratingPluginId = msg.payload.optString("rating_plugin_id", "")
                val reason         = msg.payload.optString("reason", "").ifEmpty { null }
                val result = marketplaceApiClient.postReport(ratingUserId, ratingPluginId, reason)
                msg.id?.let {
                    bridgeServer.respond(ws, msg.type, it, result.toJson { _ -> JSONObject.NULL })
                }
            }

            // ── Social graph (accounts Phase 2) ─────────────────────────────────
            // These social:* types mirror the desktop social-handlers.ts channels
            // exactly (wire shapes via ApiResult.toJson). Payloads are object-wrapped
            // by remote-shim.ts and read here via optString. Every handler clears the
            // local session on a 401 (dead token) — desktop parity with clearSessionOn401.

            "social:lookup-handle" -> {
                // payload: { handle } (matches remote-shim.ts invoke call)
                val result = marketplaceApiClient.lookupHandle(msg.payload.optString("handle", ""))
                clearSessionOn401(result)
                // value shape: a user card (JSONObject)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result.toJson { v -> v }) }
            }

            "social:send-request" -> {
                // payload: { handle }
                val result = marketplaceApiClient.sendRequest(msg.payload.optString("handle", ""))
                clearSessionOn401(result)
                // value shape: { status: "pending" | "friends" }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result.toJson { v -> v }) }
            }

            "social:list-requests" -> {
                val result = marketplaceApiClient.listRequests()
                clearSessionOn401(result)
                // value shape: { incoming: [...], outgoing: [...] }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result.toJson { v -> v }) }
            }

            "social:accept-request" -> {
                // payload: { id }
                val result = marketplaceApiClient.acceptRequest(msg.payload.optString("id", ""))
                clearSessionOn401(result)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result.toJson { _ -> JSONObject.NULL }) }
            }

            "social:decline-request" -> {
                // payload: { id }
                val result = marketplaceApiClient.declineRequest(msg.payload.optString("id", ""))
                clearSessionOn401(result)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result.toJson { _ -> JSONObject.NULL }) }
            }

            "social:cancel-request" -> {
                // payload: { id }
                val result = marketplaceApiClient.cancelRequest(msg.payload.optString("id", ""))
                clearSessionOn401(result)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result.toJson { _ -> JSONObject.NULL }) }
            }

            "social:list-friends" -> {
                val result = marketplaceApiClient.listFriends()
                clearSessionOn401(result)
                // value shape: bare array of FriendRow (toJson has a JSONArray branch)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result.toJson { v -> v }) }
            }

            "social:unfriend" -> {
                // payload: { userId }
                val result = marketplaceApiClient.unfriend(msg.payload.optString("userId", ""))
                clearSessionOn401(result)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result.toJson { _ -> JSONObject.NULL }) }
            }

            "social:block" -> {
                // payload: { userId } — the client sends the Worker's snake_case { user_id }
                val result = marketplaceApiClient.block(msg.payload.optString("userId", ""))
                clearSessionOn401(result)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result.toJson { _ -> JSONObject.NULL }) }
            }

            "social:unblock" -> {
                // payload: { userId }
                val result = marketplaceApiClient.unblock(msg.payload.optString("userId", ""))
                clearSessionOn401(result)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result.toJson { _ -> JSONObject.NULL }) }
            }

            "social:list-blocks" -> {
                val result = marketplaceApiClient.listBlocks()
                clearSessionOn401(result)
                // value shape: bare array of BlockRow
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result.toJson { v -> v }) }
            }

            // ── Games arcade (spec §6.1, §6.2, §6.6) ──────────────────────────────
            // Mirrors desktop/src/main/arcade-handlers.ts channel for channel. The
            // channel strings are byte-identical to the ones in preload.ts,
            // remote-shim.ts and remote-server.ts — drift silently breaks Android
            // only, and the games panel would quietly show "no board".
            //
            // Scores cross this boundary as RAW NUMBERS; how a game words a score
            // lives in the renderer's game-registry.ts.

            "arcade:status" -> {
                // No payload. Every solo game I have played, keyed by game id:
                // { "flappy": { best, best_at, runs } }. Signed out this is
                // { ok:false, status:401 } and the renderer falls back to the
                // bests saved on this device — playing offline never costs a score.
                val result = marketplaceApiClient.gameScores()
                clearSessionOn401(result)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result.toJson { v -> v }) }
            }

            "arcade:leaderboard" -> {
                // payload: { game }
                val game = msg.payload.optString("game", "")
                val result = marketplaceApiClient.gameBoard(game)
                clearSessionOn401(result)
                val response: JSONObject = when (result) {
                    is ApiResult.Ok -> {
                        arcadeBoardCache[game] = Pair(result.value, System.currentTimeMillis())
                        ApiResult.Ok(arcadeBoardResultJson(result.value, null)).toJson { v -> v }
                    }
                    is ApiResult.Err ->
                        // A 401 is NOT an outage — it means signed out, and there is
                        // genuinely no friends board to show. Serving a remembered one
                        // would show a signed-out user other people's names, so the
                        // entry is dropped and the error passed through.
                        if (result.status == 401) {
                            arcadeBoardCache.remove(game)
                            result.toJson()
                        } else {
                            // Any other failure (network down, Worker 5xx): degrade to
                            // the last board we held, labelled with when we got it.
                            // The leaderboard being down must never look like the GAME
                            // being down. With nothing remembered, report the real error.
                            val cached = arcadeBoardCache[game]
                            if (cached != null) {
                                ApiResult.Ok(arcadeBoardResultJson(cached.first, cached.second)).toJson { v -> v }
                            } else {
                                result.toJson()
                            }
                        }
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, response) }
            }

            "arcade:submit-score" -> {
                // payload: { game, score }
                val game = msg.payload.optString("game", "")
                // A missing score is a malformed frame, not a run worth zero —
                // optInt's default would publish a fake 0 and could not be told
                // apart from a real one. Report it as-is rather than guessing.
                // (An empty/unknown `game` IS sent on: the Worker answers with the
                // exact list of games it accepts, which beats a guess made here.)
                val response: JSONObject = if (!msg.payload.has("score")) {
                    JSONObject().put("ok", false).put("status", 0).put("message", "missing score")
                } else {
                    val result = marketplaceApiClient.submitGameScore(game, msg.payload.optInt("score"))
                    clearSessionOn401(result)
                    // value shape: { ok, best, best_at, runs, is_best }
                    result.toJson { v -> v }
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, response) }
            }

            "arcade:records" -> {
                // payload: { game } — OPTIONAL. Absent/empty means every game, so
                // null is passed through rather than "" (which would ask for the
                // game literally named "" and always answer nothing).
                //
                // DELIBERATELY NOT CACHED, unlike arcade:leaderboard above.
                // Desktop parity: arcade-handlers.ts. A leaderboard is on screen
                // DURING play, so blanking it on an outage reads as "my scores are
                // gone" — worth showing a labelled old copy. A records list is only
                // read on a screen the player opened on purpose, where a stale
                // "4-2" is a wrong FACT about a friend and is worse than no number.
                // Signed out or offline, the error goes back untouched.
                val game = msg.payload.optString("game", "").ifEmpty { null }
                val result = marketplaceApiClient.gameRecords(game)
                clearSessionOn401(result)
                // value shape: bare array of HeadToHead
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result.toJson { v -> v }) }
            }

            // ── Presence socket (Task 6) ─────────────────────────────────────────
            // Express desired state / send one protocol message. No data is
            // returned — the socket relays everything back via the
            // social:presence-event broadcast (see the presenceClient onEvent).

            "social:presence-connect" -> {
                presenceClient.setDesired(true)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("ok", true)) }
            }

            "social:presence-disconnect" -> {
                presenceClient.setDesired(false)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("ok", true)) }
            }

            "social:presence-send" -> {
                // payload: { message: {...} } (remote-shim wraps the protocol frame).
                // Guard a missing/malformed message so a bad frame is a clean error,
                // not a crash. Honest receipt (desktop parity): sending with no
                // OPEN socket would silently drop the frame, so respond with the
                // ApiResult-style error shape ({ok:false, status:0, message}) the
                // other social cases use instead of a success the renderer trusts.
                val message = msg.payload.optJSONObject("message")
                val response: JSONObject = when {
                    message == null ->
                        JSONObject().put("ok", false).put("status", 0).put("message", "missing message")
                    !presenceClient.isConnected() ->
                        JSONObject().put("ok", false).put("status", 0).put("message", "not connected")
                    else -> {
                        presenceClient.send(message)
                        JSONObject().put("ok", true)
                    }
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, response) }
            }

            // ── Settings → Development IPC handlers ──────────────────────────────
            // Android parity for the six dev:* types in desktop/src/main/ipc-handlers.ts.
            // Logic is delegated to DevTools.kt which mirrors dev-tools.ts.

            "dev:log-tail" -> {
                val maxLines = (msg.payload as? Number)?.toInt() ?: 200
                val homeDir = bootstrap?.homeDir ?: filesDir
                val tail = withContext(Dispatchers.IO) {
                    DevTools.readLogTail(homeDir.absolutePath, maxLines)
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, tail) }
            }

            "dev:diagnostics" -> {
                // Environment snapshot for the bug-report flow. Mirrors
                // gatherDiagnostics() in desktop/src/main/dev-tools.ts. The
                // probe set differs because Android's runtime is Termux-rooted —
                // claude lives in $PREFIX/bin, $HOME points at the app sandbox.
                val pm = applicationContext.packageManager
                val pkgInfo = pm.getPackageInfo(applicationContext.packageName, 0)
                val versionName = pkgInfo.versionName ?: "unknown"
                val osRelease = "Android ${android.os.Build.VERSION.RELEASE}"
                val arch = android.os.Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown"
                val text = withContext(Dispatchers.IO) {
                    val bs = bootstrap
                    DevTools.gatherDiagnostics(
                        env = bs?.buildRuntimeEnv(),
                        homeDir = bs?.homeDir,
                        usrDir = bs?.usrDir,
                        appVersion = versionName,
                        osRelease = osRelease,
                        arch = arch,
                    )
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, text) }
            }

            "dev:summarize-issue" -> {
                val kind = msg.payload.optString("kind", "bug")
                val description = msg.payload.optString("description", "")
                // Only include the log block for bug reports, not feature requests.
                val log = if (kind == "bug") msg.payload.optString("log", "") else ""
                val prompt = DevTools.buildSummarizerPrompt(kind, description, log)
                val result = withContext(Dispatchers.IO) {
                    val bs = bootstrap
                    if (bs == null) {
                        DevTools.parseSummary("", description, false)
                    } else {
                        val env = bs.buildRuntimeEnv()
                        // claude is a Node.js program — runs via LD_PRELOAD (not linker64),
                        // so we can pass it directly through runStreamed without the linker64 prefix.
                        // Fix: pipe prompt via stdin (matches Phase 3 TS fix) so large prompts
                        // don't hit ARG_MAX and special characters don't need shell-escaping.
                        val (exit, out) = DevTools.runStreamed(
                            env,
                            listOf("claude", "-p"),
                            bs.homeDir,
                            stdinInput = prompt,
                            onLine = { /* ignore intermediate lines — we only need final stdout */ },
                        )
                        DevTools.parseSummary(out, description, exit == 0)
                    }
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }

            "dev:submit-issue" -> {
                // Fix: read new SubmitArgs shape { kind, title, summary, description, log?, label }
                // matching the Phase 5 TS fix. Old shape ({ title, body, label }) sent an empty body.
                val kind = msg.payload.optString("kind", "bug")
                val title = msg.payload.optString("title", "")
                val summary = msg.payload.optString("summary", "")
                val description = msg.payload.optString("description", "")
                val log = msg.payload.optString("log", "")
                val label = msg.payload.optString("label", "bug")
                // Build body using canonical helper (mirrors buildIssueBody() in dev-tools.ts).
                val pm = applicationContext.packageManager
                val pkgInfo = pm.getPackageInfo(applicationContext.packageName, 0)
                val versionName = pkgInfo.versionName ?: "unknown"
                val osString = "Android ${android.os.Build.VERSION.RELEASE}"
                val body = DevTools.buildIssueBody(kind, summary, description, log, versionName, osString)
                val result = withContext(Dispatchers.IO) {
                    val bs = bootstrap
                    if (bs == null) {
                        JSONObject().apply {
                            put("ok", false)
                            put("fallbackUrl", DevTools.buildPrefillUrl(title, body, label))
                        }
                    } else {
                        val env = bs.buildRuntimeEnv()
                        // gh is a Go binary — must be routed through linker64 directly
                        // (bypasses LD_PRELOAD), same as the other gh invocations here.
                        val ghPath = File(bs.usrDir, "bin/gh").absolutePath
                        val (authExit, _) = DevTools.runStreamed(
                            env,
                            listOf("/system/bin/linker64", ghPath, "auth", "status"),
                            bs.homeDir,
                            onLine = {},
                        )
                        if (authExit != 0) {
                            JSONObject().apply {
                                put("ok", false)
                                put("fallbackUrl", DevTools.buildPrefillUrl(title, body, label))
                            }
                        } else {
                            // Write body to a temp file so we avoid shell-escaping issues
                            // with special characters in the issue body.
                            val tmp = File.createTempFile("youcoded-issue-", ".md", cacheDir)
                            try {
                                tmp.writeText(body)
                                val (exit, stdout) = DevTools.runStreamed(
                                    env,
                                    listOf(
                                        "/system/bin/linker64", ghPath,
                                        "issue", "create",
                                        "--repo", "itsdestin/youcoded",
                                        "--title", title,
                                        "--body-file", tmp.absolutePath,
                                        "--label", label,
                                        "--label", "youcoded-app:reported",
                                    ),
                                    bs.homeDir,
                                    onLine = {},
                                )
                                val url = Regex("https://github\\.com/[^\\s]+").find(stdout)?.value
                                if (exit == 0 && url != null) {
                                    JSONObject().apply { put("ok", true); put("url", url) }
                                } else {
                                    JSONObject().apply {
                                        put("ok", false)
                                        put("fallbackUrl", DevTools.buildPrefillUrl(title, body, label))
                                    }
                                }
                            } finally {
                                tmp.delete()
                            }
                        }
                    }
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }

            "dev:install-workspace" -> {
                // Concurrency guard: reject a second install if one is already running.
                if (devInstallInFlight) {
                    msg.id?.let {
                        bridgeServer.respond(ws, msg.type, it, JSONObject().apply {
                            put("error", "Install already in progress")
                        })
                    }
                    return@handleBridgeMessage
                }
                devInstallInFlight = true
                val result = try {
                    withContext(Dispatchers.IO) {
                        val bs = bootstrap
                        if (bs == null) {
                            JSONObject().apply { put("error", "Bootstrap not initialised") }
                        } else {
                            val env = bs.buildRuntimeEnv()
                            // Clone target: $HOME/youcoded-dev (parallel to user's project folders).
                            val target = File(bs.homeDir, "youcoded-dev")
                            // Fix: capture whether the workspace already existed BEFORE the
                            // if/else so the response accurately reflects clone vs pull.
                            val wasAlreadyInstalled = target.exists()
                            val onLine: (String) -> Unit = { line ->
                                // Stream progress lines to the React UI so the ContributePopup
                                // can show a live log of the clone/pull. Mirrors the desktop
                                // ipc-handlers.ts install-workspace progress push.
                                bridgeServer.broadcast(JSONObject().apply {
                                    put("type", "dev:install-progress")
                                    put("payload", line)
                                })
                            }
                            try {
                                if (wasAlreadyInstalled) {
                                    // Already present — check whether it's the right repo.
                                    val (_, remote) = DevTools.runStreamed(
                                        env,
                                        listOf("git", "-C", target.absolutePath, "remote", "get-url", "origin"),
                                        bs.homeDir,
                                        onLine = {},
                                    )
                                    val cls = DevTools.classifyExistingWorkspace(remote.trim())
                                    if (cls != "workspace") {
                                        return@withContext JSONObject().apply {
                                            put("error", "${target.absolutePath} already exists but isn't the YouCoded dev workspace. Move or rename it and try again.")
                                        }
                                    }
                                    onLine("Found existing workspace, pulling latest…")
                                    DevTools.runStreamed(
                                        env,
                                        listOf("git", "-C", target.absolutePath, "pull", "--ff-only"),
                                        bs.homeDir,
                                        onLine = onLine,
                                    )
                                } else {
                                    onLine("Cloning workspace…")
                                    DevTools.runStreamed(
                                        env,
                                        listOf("git", "clone", "--depth", "50",
                                            "https://github.com/itsdestin/youcoded-dev",
                                            target.absolutePath),
                                        bs.homeDir,
                                        onLine = onLine,
                                    )
                                }
                                onLine("Cloning sub-repos (this may take a minute)…")
                                DevTools.runStreamed(
                                    env, listOf("bash", "setup.sh"), target, onLine = onLine,
                                )
                                // Register as a project folder via the same WorkingDirStore
                                // that backs the folders:add IPC — this is the Android folder
                                // picker's persistent store.
                                val store = com.youcoded.app.config.WorkingDirStore(bs.homeDir)
                                store.add(com.youcoded.app.config.WorkingDir(
                                    label = "youcoded-dev",
                                    path = target.absolutePath,
                                ))
                                JSONObject().apply {
                                    put("path", target.absolutePath)
                                    put("alreadyInstalled", wasAlreadyInstalled)
                                }
                            } catch (e: Exception) {
                                JSONObject().apply { put("error", e.message ?: "Install failed") }
                            }
                        }
                    }
                } finally {
                    devInstallInFlight = false
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }

            "dev:install-progress" -> {
                // Fire-and-forget push from server → clients; no handler needed on this side.
                // Incoming messages of this type are server-originated broadcasts, not client
                // requests — log and ignore if one arrives unexpectedly.
                android.util.Log.d("SessionService", "dev:install-progress received (unexpected direction)")
            }

            "dev:open-session-in" -> {
                val cwd = msg.payload.optString("cwd", "")
                val initialInput = msg.payload.optString("initialInput", "").ifEmpty { null }
                if (cwd.isEmpty()) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, MessageRouter.buildErrorResponse("cwd is required")) }
                } else {
                    val session = withContext(Dispatchers.Main) {
                        createSession(File(cwd), dangerousMode = false, apiKey = null)
                    }
                    val info = MessageRouter.buildSessionInfo(
                        id = session.id,
                        name = session.name.value,
                        cwd = cwd,
                        status = "active",
                        permissionMode = "normal",
                        skipPermissions = false,
                        createdAt = session.createdAt,
                    )
                    val ownerClientId = ws.getAttachment<String>() ?: "unknown"
                    sessionOwnership[session.id] = ownerClientId
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, info) }
                    // Broadcast session:created so the React SessionStrip updates — includes
                    // initialInput so InputBar.tsx can pre-fill the text box on the new session.
                    bridgeServer.broadcast(JSONObject().apply {
                        put("type", "session:created")
                        put("payload", JSONObject(info.toString()).apply {
                            if (initialInput != null) put("initialInput", initialInput)
                        })
                    })
                }
            }

            // Privacy analytics opt-in toggle — exposed via window.claude.analytics.
            // Mirrors desktop's ipc-handlers.ts `analytics:get-opt-in` /
            // `analytics:set-opt-in`. Both build a fresh AnalyticsService per call
            // (the service is stateless aside from its JSON file, so reconstruction
            // is cheap and avoids wiring a long-lived singleton through initBootstrap).
            "analytics:get-opt-in" -> {
                val svc = AnalyticsService(
                    apiBase = ANALYTICS_API_BASE,
                    homeDir = File(System.getenv("HOME") ?: filesDir.parent ?: filesDir.absolutePath),
                    appVersion = BuildConfig.VERSION_NAME,
                    machineIdReader = {
                        Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: ""
                    },
                )
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, svc.getOptIn()) }
            }

            "analytics:set-opt-in" -> {
                val enabled = msg.payload.optBoolean("enabled", true)
                val svc = AnalyticsService(
                    apiBase = ANALYTICS_API_BASE,
                    homeDir = File(System.getenv("HOME") ?: filesDir.parent ?: filesDir.absolutePath),
                    appVersion = BuildConfig.VERSION_NAME,
                    machineIdReader = {
                        Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: ""
                    },
                )
                svc.setOptIn(enabled)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, null) }
            }

            "performance:get-config" -> {
                // Android has no userland GPU choice. Always return defaults so
                // the renderer's Performance section stays hidden (it gates on
                // multiGpuDetected). Keeps IPC parity green without surfacing
                // a setting that has no effect on Android.
                val payload = JSONObject().apply {
                    put("preferPowerSaving", false)
                    put("appliedAtLaunch", false)
                    put("multiGpuDetected", false)
                    put("gpuList", org.json.JSONArray())
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, payload) }
            }
            "performance:set-config" -> {
                // No-op write. We accept the payload silently so the renderer
                // doesn't see an error if it ever fires this on Android.
                val payload = JSONObject().apply { put("ok", true) }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, payload) }
            }
            "app:restart" -> {
                // Android session lifecycle differs — a restart equivalent
                // would be killing and respawning SessionService. Out of scope
                // for the GPU-toggle feature. Acknowledge so the parity test
                // stays green; the Performance section is hidden on Android
                // so this branch is unreachable in normal use anyway.
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject.NULL) }
            }

            "update:changelog" -> {
                // Desktop-only feature. Android never renders the version pill, so this
                // handler should be unreachable — but IPC-parity invariant (docs/PITFALLS.md
                // "Cross-Platform") requires the type string to exist in all three files.
                // If Android ever does render the pill, error:true routes the React UI to
                // the "Open on GitHub" fallback (in UpdatePanel.tsx) rather than a blank
                // panel. Prefer fail-loud over fail-silent for an unreachable-today path.
                msg.id?.let {
                    bridgeServer.respond(ws, msg.type, it, JSONObject()
                        .put("markdown", JSONObject.NULL)
                        .put("entries", org.json.JSONArray())
                        .put("fromCache", false)
                        .put("error", true))
                }
            }

            // Desktop in-app update installer stubs (Android uses Play Store / direct APK sideload)
            "update:download",
            "update:cancel",
            "update:launch",
            "update:get-cached-download" -> {
                msg.id?.let {
                    bridgeServer.respond(ws, msg.type, it, UpdateInstallerStub.unsupported())
                }
            }
            "update:progress" -> {
                // Push-event channel — no-op on Android. Desktop pushes these; Android
                // never subscribes because it never downloads desktop installers.
            }

            "system:notify-stack-state" -> {
                // React signals dismissal-stack non-emptiness. Cache the
                // value (so MainActivity rebinds get it replayed) and forward
                // to the bound callback. Fire-and-forget — no msg.id, no
                // response. Default to true if payload is missing or malformed
                // so worst case is "back backgrounds the app" (Android default).
                val payload = msg.payload as? JSONObject
                val empty = payload?.optBoolean("empty", true) ?: true
                lastStackEmpty = empty
                onStackStateChanged?.invoke(empty)
            }

            // ── Artifact viewer IPC ───────────────────────────────────────────────
            // Mirrors desktop/src/main/ipc-handlers.ts ARTIFACT_IPC handlers.
            // claudeDir convention: bootstrap?.homeDir + "/.claude" (matches the
            // CentralIndex INDEX_FILE path used on desktop).

            "artifacts:list-session" -> {
                // Return all artifacts tracked in the sidecar that have at least one
                // VersionEvent whose sessionId matches the requested session.
                val sessionId   = msg.payload.optString("sessionId", "")
                val projectRoot = msg.payload.optString("projectRoot", "")
                if (sessionId.isEmpty() || projectRoot.isEmpty()) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                        org.json.JSONObject().put("ok", false).put("error", "sessionId and projectRoot are required")) }
                    return@handleBridgeMessage
                }
                val sidecar = readSidecar(projectRoot)
                val artifacts = if (sidecar is ReadResult.Ok) {
                    sidecar.sidecar.artifacts.filter { a ->
                        a.versions.any { it.sessionId == sessionId }
                    }
                } else emptyList()
                val payload = org.json.JSONObject()
                    .put("ok", true)
                    .put("artifacts", org.json.JSONArray(artifacts.map { it.toJson() }))
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, payload) }
            }

            "artifacts:get" -> {
                // Return one artifact record plus its current on-disk content.
                // Sets orphan=true when the backing file is missing.
                val projectRoot = msg.payload.optString("projectRoot", "")
                val artifactId  = msg.payload.optString("artifactId", "")
                // full: the user tapped "Load the whole file" on the partial-view
                // bar. Opts into a BIGGER read, not an unbounded one.
                val wantsFullFlag = msg.payload.optBoolean("full", false)
                if (projectRoot.isEmpty() || artifactId.isEmpty()) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                        org.json.JSONObject().put("ok", false).put("error", "projectRoot and artifactId are required")) }
                    return@handleBridgeMessage
                }
                val sidecar = readSidecar(projectRoot)
                if (sidecar !is ReadResult.Ok) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                        org.json.JSONObject().put("ok", false).put("error", "sidecar-missing")) }
                    return@handleBridgeMessage
                }
                val artifact = sidecar.sidecar.artifacts.find { it.id == artifactId }
                if (artifact == null) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                        org.json.JSONObject().put("ok", false).put("error", "artifact-not-found")) }
                    return@handleBridgeMessage
                }
                // A corrupt record (relative absolutePath) would resolve against the
                // app process cwd, not the project — report it as an orphan rather
                // than reading whatever happens to sit at that relative location.
                val extAbs = artifact.absolutePath
                if (artifact.kind != "internal" && (extAbs == null || !isAbsoluteRecorded(extAbs))) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                        org.json.JSONObject().put("ok", true).put("orphan", true)
                            .put("artifact", artifact.toJson()).put("content", org.json.JSONObject.NULL)) }
                    return@handleBridgeMessage
                }
                val fullPath = if (artifact.kind == "internal") java.io.File(projectRoot, artifact.path)
                               else java.io.File(extAbs!!)
                // Resolve symlinks BEFORE any policy decision (D5 2026-07-22):
                // canonicalize() is string work and readBytes follows links, so a
                // link inside the root could dodge the sensitive-path deny.
                val resolved = try { fullPath.canonicalFile } catch (_: java.io.IOException) { fullPath.absoluteFile }
                // Internal sidecar paths were never traversal-checked — enforce
                // in-root on the RESOLVED path (matches desktop write-authorization).
                if (artifact.kind == "internal") {
                    val rootReal = try { java.io.File(projectRoot).canonicalFile.path } catch (_: java.io.IOException) { null }
                    if (rootReal == null || !(resolved.path == rootReal || resolved.path.startsWith(rootReal + java.io.File.separator))) {
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                            org.json.JSONObject().put("ok", false).put("error", "artifact-not-found")) }
                        return@handleBridgeMessage
                    }
                }
                // Sensitive read deny — the set read-binary refuses MINUS dotenv
                // (.env stays viewable: it is confirm-tier EDITABLE, see D5).
                if (EditablePathPolicy.protectedReadPath(canonicalize(resolved.path, null))) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                        org.json.JSONObject().put("ok", false).put("error", "protected-path")) }
                    return@handleBridgeMessage
                }
                if (!resolved.exists()) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, org.json.JSONObject()
                        .put("ok", true).put("artifact", artifact.toJson())
                        .put("content", org.json.JSONObject.NULL).put("orphan", true)) }
                    return@handleBridgeMessage
                }
                // Size gate BEFORE reading (spec §2.3) — a multi-MB read blocks the
                // bridge and the WebView renderer. mtimeMs doubles as the optimistic-
                // concurrency token round-tripped into artifacts:save.
                //
                // Above the cap we do NOT refuse blind: sniff the head first, because
                // an over-cap IMAGE must reach the binary handoff rather than the TEXT
                // editor's refusal (spec §4.2). Text comes back as a readable prefix.
                // Mirrors desktop ipc-handlers.ts.
                val wantsFull = wantsFullFlag &&
                    resolved.length() <= EditablePathPolicy.FULL_READ_MAX_BYTES
                if (resolved.length() > EditablePathPolicy.EDIT_MAX_BYTES && !wantsFull) {
                    val head = ByteArray(8192)
                    val headLen = EditablePathPolicy.readFully(resolved, head)
                    val out = org.json.JSONObject()
                        .put("ok", true).put("artifact", artifact.toJson()).put("orphan", false)
                        .put("sizeBytes", resolved.length())
                        .put("mtimeMs", resolved.lastModified().toDouble())
                    if (EditablePathPolicy.looksBinary(head.copyOf(headLen))) {
                        out.put("content", org.json.JSONObject.NULL)
                           .put("binary", true).put("truncated", false)
                    } else {
                        val cap = EditablePathPolicy.EDIT_MAX_BYTES.toInt()
                        val win = ByteArray(cap)
                        val winLen = EditablePathPolicy.readFully(resolved, win)
                        out.put("content", EditablePathPolicy.textPrefix(win, winLen, cap))
                           .put("binary", false).put("truncated", true)
                    }
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, out) }
                    return@handleBridgeMessage
                }
                val bytes = try { resolved.readBytes() } catch (_: java.io.IOException) { null }
                if (bytes == null) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, org.json.JSONObject()
                        .put("ok", true).put("artifact", artifact.toJson())
                        .put("content", org.json.JSONObject.NULL).put("orphan", true)) }
                    return@handleBridgeMessage
                }
                // NUL-sniff: binary bytes as UTF-8 turn into U+FFFD soup — return
                // binary:true + null content so the renderer routes to its fallback.
                val binary = EditablePathPolicy.looksBinary(bytes)
                val payload  = org.json.JSONObject()
                    .put("ok", true)
                    .put("artifact", artifact.toJson())
                    .put("content",  if (binary) org.json.JSONObject.NULL else String(bytes, Charsets.UTF_8))
                    .put("orphan",   false)
                    .put("binary",   binary)
                    // sizeBytes and truncated ride EVERY response: the renderer
                    // derives editability from the size, not from a separate flag.
                    .put("truncated", false)
                    .put("sizeBytes", resolved.length())
                    .put("mtimeMs",  resolved.lastModified().toDouble())
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, payload) }
            }

            "fs:read-head" -> {
                // First bytes of a user-chosen file for the composer's attachment
                // preview cards (rendered markdown / mono text). Mirrors desktop
                // main/fs-read-head.ts: absolute paths only, the read-binary
                // sensitive-path deny list, a hard 4096-byte cap whatever the
                // caller asks for (READ_HEAD_MAX_BYTES in shared/read-head.ts),
                // and a NUL sniff so a binary never comes back as U+FFFD soup.
                // NOT roots-gated — the user attaches whatever the picker gives.
                val headPath = msg.payload.optString("filePath", "")
                if (headPath.isEmpty() || !java.io.File(headPath).isAbsolute) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                        org.json.JSONObject().put("ok", false).put("error", "no path")) }
                    return@handleBridgeMessage
                }
                val headFile = try { java.io.File(headPath).canonicalFile } catch (_: java.io.IOException) { java.io.File(headPath).absoluteFile }
                if (EditablePathPolicy.isSensitivePath(canonicalize(headFile.path, null)) ||
                    EditablePathPolicy.isSensitivePath(canonicalize(headPath, null))) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                        org.json.JSONObject().put("ok", false).put("error", "not-allowed")) }
                    return@handleBridgeMessage
                }
                val requested = msg.payload.optInt("maxBytes", 600)
                val cap = requested.coerceIn(1, 4096)
                val payload = if (!headFile.exists()) {
                    org.json.JSONObject().put("ok", false).put("error", "orphan")
                } else if (!headFile.isFile) {
                    org.json.JSONObject().put("ok", false).put("error", "not-a-file")
                } else try {
                    val buf = ByteArray(cap)
                    val len = EditablePathPolicy.readFully(headFile, buf)
                    val head = buf.copyOf(len)
                    if (EditablePathPolicy.looksBinary(head)) {
                        org.json.JSONObject().put("ok", false).put("error", "binary")
                    } else {
                        val truncated = headFile.length() > len
                        // A cut mid-character decodes to U+FFFD at the very end;
                        // when truncated that is the cut, not the file — drop it.
                        var text = String(head, Charsets.UTF_8)
                        if (truncated && text.endsWith("\uFFFD")) text = text.dropLast(1)
                        org.json.JSONObject().put("ok", true).put("text", text).put("truncated", truncated)
                    }
                } catch (e: java.io.IOException) {
                    org.json.JSONObject().put("ok", false).put("error", e.message ?: "read failed")
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, payload) }
            }

            "artifacts:read-binary" -> {
                // Read a file as base64 for the binary viewers (xlsx/docx/pdf/image).
                // The WebView can't fetch a file:// URL from the asset origin, so
                // bytes come through the bridge. Takes an absolute path.
                val absolutePath = msg.payload.optString("absolutePath", "")
                if (absolutePath.isEmpty()) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                        org.json.JSONObject().put("ok", false).put("error", "no path")) }
                    return@handleBridgeMessage
                }
                // Sensitive-path deny (2026-07-22): port of the desktop
                // read-binary-access guard, which this handler never had — .ssh,
                // credential stores, and dotenv were readable by absolute path.
                // The desktop roots-allowlist half is NOT ported: it needs the
                // saved-folders store, and the Android bridge is only reachable
                // from the local WebView (no remote server), so the deny-list is
                // the load-bearing part here.
                val resolvedBin = try { java.io.File(absolutePath).canonicalFile } catch (_: java.io.IOException) { java.io.File(absolutePath).absoluteFile }
                if (EditablePathPolicy.isSensitivePath(canonicalize(resolvedBin.path, null))) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                        org.json.JSONObject().put("ok", false).put("error", "not-allowed")) }
                    return@handleBridgeMessage
                }
                // 50MB gate, matching desktop READ_BINARY_MAX_BYTES — base64
                // inflates 33% and it all transits the bridge.
                if (resolvedBin.exists() && resolvedBin.length() > EditablePathPolicy.READ_BINARY_MAX_BYTES) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                        org.json.JSONObject().put("ok", false).put("error", "too-large")) }
                    return@handleBridgeMessage
                }
                val payload = try {
                    val bytes = resolvedBin.readBytes()
                    val b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
                    org.json.JSONObject().put("ok", true).put("base64", b64)
                } catch (e: java.io.IOException) {
                    org.json.JSONObject().put("ok", false).put("error", "orphan")
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, payload) }
            }

            "artifacts:save" -> {
                // Overwrite the on-disk file with the edited content and append a
                // "edit" VersionEvent to the sidecar so the history stays consistent.
                // Broadcasts artifacts:changed so any other connected client refreshes.
                val projectRoot = msg.payload.optString("projectRoot", "")
                val projectId   = msg.payload.optString("projectId", "")
                val projectName = msg.payload.optString("projectName", "")
                val artifactId  = msg.payload.optString("artifactId", "")
                val newContent  = msg.payload.optString("content", "")
                val sessionId   = msg.payload.optString("sessionId", "")
                if (projectRoot.isEmpty() || artifactId.isEmpty()) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                        org.json.JSONObject().put("ok", false).put("error", "projectRoot and artifactId are required")) }
                    return@handleBridgeMessage
                }
                val sidecar = readSidecar(projectRoot)
                if (sidecar !is ReadResult.Ok) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                        org.json.JSONObject().put("ok", false).put("error", "sidecar-missing")) }
                    return@handleBridgeMessage
                }
                val artifact = sidecar.sidecar.artifacts.find { it.id == artifactId }
                if (artifact == null) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                        org.json.JSONObject().put("ok", false).put("error", "artifact-not-found")) }
                    return@handleBridgeMessage
                }
                // Same corrupt-record guard as artifacts:get. Critical on the write
                // path: a relative record would create a stray file under the app
                // process cwd instead of refusing. Matches desktop's
                // authorizeArtifactWrite refusal (error: 'artifact-not-found').
                val extAbs = artifact.absolutePath
                if (artifact.kind != "internal" && (extAbs == null || !isAbsoluteRecorded(extAbs))) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                        org.json.JSONObject().put("ok", false).put("error", "artifact-not-found")) }
                    return@handleBridgeMessage
                }
                val fullPath = if (artifact.kind == "internal") java.io.File(projectRoot, artifact.path)
                               else java.io.File(extAbs!!)
                // D5 boundary (2026-07-22), mirroring desktop write-authorization:
                // this branch historically wrote absolutePath!! with NO checks —
                // the sidecar-escalation hole (spec §12.1). Resolve symlinks first,
                // enforce in-root for internal artifacts on the RESOLVED path, then
                // apply the tier policy and the optimistic-concurrency token.
                val resolvedSave = try { fullPath.canonicalFile } catch (_: java.io.IOException) { fullPath.absoluteFile }
                if (artifact.kind == "internal") {
                    val rootReal = try { java.io.File(projectRoot).canonicalFile.path } catch (_: java.io.IOException) { null }
                    if (rootReal == null || !(resolvedSave.path == rootReal || resolvedSave.path.startsWith(rootReal + java.io.File.separator))) {
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                            org.json.JSONObject().put("ok", false).put("error", "artifact-not-found")) }
                        return@handleBridgeMessage
                    }
                }
                val canonSave = canonicalize(resolvedSave.path, null)
                when (EditablePathPolicy.editTier(canonSave)) {
                    EditablePathPolicy.EditTier.DENIED -> {
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                            org.json.JSONObject().put("ok", false).put("error", "protected-path").put("path", canonSave)) }
                        return@handleBridgeMessage
                    }
                    EditablePathPolicy.EditTier.NEEDS_CONFIRM -> {
                        if (!msg.payload.optBoolean("confirmed", false)) {
                            msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                                org.json.JSONObject().put("ok", false).put("error", "needs-confirm").put("path", canonSave)) }
                            return@handleBridgeMessage
                        }
                    }
                    EditablePathPolicy.EditTier.FREE -> { /* no friction */ }
                }
                // Concurrency token: GET returns lastModified().toDouble(), the
                // renderer round-trips it verbatim, so Double equality is exact.
                // A missing file falls through — the save recreates it (delete-
                // then-save keeps the user's draft, matching desktop).
                if (msg.payload.has("baseMtimeMs") && resolvedSave.exists()
                    && resolvedSave.lastModified().toDouble() != msg.payload.getDouble("baseMtimeMs")) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                        org.json.JSONObject().put("ok", false).put("error", "conflict")) }
                    return@handleBridgeMessage
                }
                // Atomic write: temp file + rename, matching desktop behaviour
                val tmpPath = java.io.File(resolvedSave.path + ".tmp")
                tmpPath.writeText(newContent, Charsets.UTF_8)
                java.nio.file.Files.move(
                    tmpPath.toPath(),
                    resolvedSave.toPath(),
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                )
                appendVersion(
                    projectRoot = projectRoot,
                    projectId   = projectId,
                    projectName = projectName,
                    input = AppendVersionInput(
                        path         = artifact.path,
                        kind         = artifact.kind,
                        absolutePath = artifact.absolutePath,
                        sessionId    = sessionId,
                        type         = "edit",
                        author       = "user",
                    )
                )
                // Broadcast push event so connected clients refresh their view
                bridgeServer.broadcast(org.json.JSONObject().apply {
                    put("type", "artifacts:changed")
                    put("payload", org.json.JSONObject()
                        .put("projectRoot", projectRoot)
                        .put("artifactId",  artifactId)
                        .put("kind",        "edit")
                        .put("by",          "user"))
                })
                // Fresh concurrency token so the editor can keep saving without a
                // refetch round-trip (parity with desktop).
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, org.json.JSONObject()
                    .put("ok", true).put("mtimeMs", resolvedSave.lastModified().toDouble())) }
            }

            // Fix: data-flow gap — renderer Tracker calls this when it sees a
            // Write/Edit/MultiEdit transcript event so the central index is populated
            // and artifacts appear in the Session Drawer. ensureProject +
            // applyGitTreatment + appendVersion are all idempotent.
            "artifacts:append-version" -> {
                val projectRoot = msg.payload.optString("projectRoot", "")
                val sessionId   = msg.payload.optString("sessionId", "")
                val args        = msg.payload.optJSONObject("args")
                if (projectRoot.isEmpty() || sessionId.isEmpty() || args == null) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                        org.json.JSONObject().put("ok", false).put("error", "projectRoot, sessionId and args are required")) }
                    return@handleBridgeMessage
                }
                // claudeDir convention: Bootstrap homeDir + "/.claude" (matches the
                // CentralIndex INDEX_FILE path used on desktop). bootstrap?.homeDir
                // resolves to context.filesDir/home/.claude-mobile parent; the Kotlin
                // artifact helpers expect the ~/.claude equivalent, which on Android is
                // the same parent (session-manager sets CLAUDE_HOME there).
                // Fix: Bootstrap.homeDir is a java.io.File, so mixing it with a String
                // in the Elvis made the expression type `Any` and broke compilation
                // (master Android CI red since the artifact-viewer merge). Take .path
                // so both Elvis arms are Strings.
                val claudeDir = java.io.File(bootstrap?.homeDir?.path ?: android.os.Environment.getExternalStorageDirectory().path, ".claude")
                    .absolutePath
                val ensured = ensureProject(claudeDir, projectRoot, sessionId)
                applyGitTreatment(projectRoot)
                val result = appendVersion(
                    projectRoot = projectRoot,
                    projectId   = ensured.project.id,
                    projectName = ensured.project.name,
                    input = AppendVersionInput(
                        path         = args.optString("path", ""),
                        kind         = args.optString("kind", "internal"),
                        absolutePath = if (args.isNull("absolutePath")) null else args.optString("absolutePath"),
                        sessionId    = sessionId,
                        type         = args.optString("type", "edit"),
                        author       = args.optString("author", "agent"),
                        // Replay-dedupe key from the tracker (see VersionEvent.toolUseId).
                        toolUseId    = args.optString("toolUseId", "").ifEmpty { null },
                    )
                )
                // Broadcast push event so connected clients refresh their view
                bridgeServer.broadcast(org.json.JSONObject().apply {
                    put("type", "artifacts:changed")
                    put("payload", org.json.JSONObject()
                        .put("projectRoot", projectRoot)
                        .put("artifactId",  org.json.JSONObject.NULL)
                        .put("kind",        args.optString("type", "edit"))
                        .put("by",          args.optString("author", "agent")))
                })
                // Fix: Kotlin appendVersion returns a plain Boolean (committed or not),
                // not an object — `.committed` didn't exist and broke compilation.
                msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                    org.json.JSONObject().put("ok", result)) }
            }

            // ── Desktop-only channels: return not-implemented so the React layer
            //    gets a clean error rather than a silent timeout. The central-index
            //    browser (list-projects-index) and project-level file-tree management
            //    (list-project, include-external, exclude, delete-project) are
            //    desktop-only in v1. ──────────────────────────────────────────────

            // Android has no chatsearch index; the shared UI falls back to plain
            // shell output when resolve answers not-implemented, so a search
            // result on a phone reads as the CLI's own table rather than a card.
            "chatsearch:resolve",
            "chatsearch:read" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                    org.json.JSONObject().put("ok", false).put("error", "not-implemented-on-mobile")) }
            }

            "artifacts:list-project" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                    org.json.JSONObject().put("ok", false).put("error", "not-implemented-on-mobile")) }
            }
            // ALL FILES (full-browser on-disk discovery) — Project View v2 on mobile;
            // desktop is authoritative. Stub keeps the IPC type-string parity.
            "artifacts:list-all-files" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                    org.json.JSONObject().put("ok", false).put("error", "not-implemented-on-mobile")) }
            }
            "artifacts:list-projects-index" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                    org.json.JSONObject().put("ok", false).put("error", "not-implemented-on-mobile")) }
            }
            // Every artifacts:* channel on Android returns not-implemented-on-mobile —
            // mobile Project View is v2. import-file follows the same convention.
            "artifacts:import-file" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                    org.json.JSONObject().put("ok", false).put("error", "not-implemented-on-mobile")) }
            }
            "artifacts:include-external" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                    org.json.JSONObject().put("ok", false).put("error", "not-implemented-on-mobile")) }
            }
            "artifacts:exclude" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                    org.json.JSONObject().put("ok", false).put("error", "not-implemented-on-mobile")) }
            }
            "artifacts:delete-project" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                    org.json.JSONObject().put("ok", false).put("error", "not-implemented-on-mobile")) }
            }
            // Stub: existence check returns an empty missingIds list on mobile so the
            // SessionDrawer renders every artifact as present. Real implementation
            // arrives when mobile Project View / orphan handling lands (v2).
            "artifacts:check-existence" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                    org.json.JSONObject().put("ok", true).put("missingIds", org.json.JSONArray())) }
            }
            // Stub: artifact rename is desktop-only for now (mobile file-op + sidecar
            // rename path lands with the v2 mobile artifact work).
            "artifacts:rename" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                    org.json.JSONObject().put("ok", false).put("error", "not-implemented-on-mobile")) }
            }
            // Stub: removing a tracking record is desktop-only for now (same v2
            // mobile artifact work as rename). The Session Drawer remove button
            // no-ops gracefully on the error response.
            "artifacts:remove-record" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                    org.json.JSONObject().put("ok", false).put("error", "not-implemented-on-mobile")) }
            }

            // External-change watcher (desktop-only: the filesystem watcher lives in
            // Electron main — see desktop project-watcher.ts). Stub cases keep the
            // type strings in parity; the renderer hook tolerates ok:false by
            // degrading to "no live refresh".
            // Content search is desktop-only: no ripgrep binary on Android (D2).
            "artifacts:search-content" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                    org.json.JSONObject().put("ok", false).put("error", "not-implemented-on-mobile")) }
            }
            "artifacts:watch-project", "artifacts:unwatch-project" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                    org.json.JSONObject().put("ok", false).put("error", "not-implemented-on-mobile")) }
            }
            // artifacts:changed is a server-push event only — no inbound handler needed.

            // ── Voice prompting ─────────────────────────────────────────────
            // Talking instead of typing. On a phone this is Android's own speech
            // recognition, so there is nothing to download and no audio for the
            // app to handle — Android listens and hands back words.

            /** Can the mic be used right now, and if not, what is in the way? */
            "voice:status" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, voiceReadiness()) }
            }

            /** Open the microphone. Asks for permission first if it has not been given. */
            "voice:start" -> {
                when (ensureMicPermission()) {
                    MicPermission.GRANTED -> {
                        // The recogniser is main-thread-only and this runs on the
                        // web-socket thread, so hop before touching it.
                        mainHandler.post { startVoiceRecognizer() }
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                            org.json.JSONObject().put("ok", true)) }
                    }
                    MicPermission.DENIED -> {
                        // Push the new readiness as well as answering the call, so the
                        // card in the chat box explains itself instead of the button
                        // just going quiet.
                        broadcastVoiceEvent(org.json.JSONObject()
                            .put("type", "readiness")
                            .put("readiness", voiceReadiness()))
                        // And PUSH it as an error too. WHY both: this bridge has no
                        // error channel — the shim resolves every reply, so an
                        // `ok:false` payload reads to the composer as a SUCCESSFUL
                        // start, and the phone would sit saying "Listening…" over a
                        // microphone that was never opened, with no clock to end it.
                        // The pushed `error` is what returns the box to idle.
                        broadcastVoiceEvent(org.json.JSONObject()
                            .put("type", "error")
                            .put("message", "Microphone permission was not granted."))
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                            org.json.JSONObject().put("ok", false)
                                .put("error", "Microphone permission was not granted.")) }
                    }
                    MicPermission.UNANSWERED -> {
                        // Nobody could show the prompt (the app window is not on
                        // screen). Say exactly that — do NOT record this as a refusal,
                        // because the user was never asked.
                        // Pushed as an error for the same reason as the DENIED branch.
                        broadcastVoiceEvent(org.json.JSONObject()
                            .put("type", "error")
                            .put("message", "The YouCoded window is not open, so the microphone permission could not be requested."))
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                            org.json.JSONObject().put("ok", false)
                                .put("error", "The YouCoded window is not open, so the microphone permission could not be requested.")) }
                    }
                }
            }

            /** Close the microphone and keep the words. */
            "voice:stop" -> {
                mainHandler.post { voiceRecognizer?.stop() }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                    org.json.JSONObject().put("ok", true)) }
            }

            /** Close the microphone and throw the words away. */
            "voice:cancel" -> {
                mainHandler.post { voiceRecognizer?.cancel() }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                    org.json.JSONObject().put("ok", true)) }
            }

            "git:file-status", "git:file-review", "git:commit-file-diff", "git:stage",
            "git:unstage", "git:commit", "git:discard", "git:watch", "git:unwatch" -> {
                // Git surface is desktop-only for now (spec 2026-07-22); the shared
                // renderer hides the footer entry when these reject.
                msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                    org.json.JSONObject().put("ok", false).put("error", "not-implemented-on-mobile")) }
            }

            // Project View hub (conversations, repo, context) is desktop-only in v1
            // (see docs/superpowers/specs/2026-06-14-project-view-redesign-design.md).
            // Reply not-implemented so the shared React UI can degrade to an
            // "available on desktop" state instead of timing out.
            "project:list-conversations",
            "project:conversation-history",
            "project:repo-info",
            "project:list-context",
            "project:read-context-file",
            "project:write-context-file" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                    org.json.JSONObject().put("ok", false).put("error", "not-implemented-on-mobile")) }
            }

            // The six local-engine upgrade channels (2026-09-05). Desktop-only for
            // the same reason as every other branch here — a phone runs no local
            // engine, holds no model folder and has no terminal to open — but they
            // answer `unsupported` as well as `ok:false`, and the difference is
            // something the user reads.
            //
            // WHY: the shared shim RE-THROWS an `ok:false` answer for exactly these
            // six (remote-shim.ts REJECT_ON_NOT_OK), because over the remote link
            // that shape means "the host's handler failed". Answered the plain way,
            // a phone would put the literal words "not-implemented-on-mobile" in the
            // model settings dialog as if the engine had said them. `unsupported`
            // takes the shim's other path instead: one plain-language notice naming
            // the feature, and a rejection the caller can recognise.
            //
            // WHY IT IS ITS OWN BRANCH, WHOLE, HERE: a Kotlin `when` branch runs
            // from its FIRST comma-separated value to the one carrying the `-> {`.
            // Written into the middle of the long not-implemented list below, this
            // `-> {` silently captured the eighteen native:* / provider:* channels
            // above it — so `provider:list`, which the model picker calls every time
            // it opens, started answering `unsupported` and popping a toast on a
            // phone doing no remote access. Six labels, one branch, its own
            // boundaries. The label set is pinned by ipc-channels.test.ts.
            "engine:set-config",
            "engine:prereqs",
            "engine:run-in-terminal",
            "models:settings",
            "models:set-settings",
            "models:add-vision" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                    org.json.JSONObject().put("ok", false).put("unsupported", true)
                        .put("error", "not-implemented-on-mobile")) }
            }

            // Native runtime (YouCoded's first-party harness) + provider registry
            // are desktop-only in Plan A. Reply not-implemented so the shared React
            // UI degrades to a "desktop only" state instead of timing out.
            // native:send / native:interrupt are fire-and-forget (no msg.id) on
            // desktop; the msg.id?.let guard makes those a no-op here, correctly.
            "native:send",
            // Task 11 (cancel/edit queued messages): request/response like
            // native:set-binding below — has a msg.id, so this replies
            // not-implemented-on-mobile rather than no-op'ing.
            "native:queue-remove",
            "native:interrupt",
            // Stalled-turn Retry. Fire-and-forget (no msg.id) exactly like
            // native:send / native:interrupt, so this is a correct no-op here:
            // Android hosts Claude Code sessions only and has no streaming
            // watchdog to park.
            "native:retry",
            // User-initiated /compact (M3 item 2). Request/response like
            // native:set-binding below — carries a msg.id, so this replies
            // not-implemented-on-mobile rather than no-op'ing. Android's native
            // runtime is M8; an honest refusal beats a silently ignored command.
            "native:compact",
            "native:clear",
            // /skill-name (M3 item 1). Same honest refusal: Android has no native
            // harness to load a skill's instructions into until M8.
            "native:invoke-skill",
            "native:set-binding",
            "native:set-permission-mode",
            "native:get-permission-mode",
            "native:get-step-guard",
            "native:set-step-guard",
            "native:sessions-list",
            // G-1 background Bash: Stop a desktop command. Android has no
            // native harness, so this is the honest refusal; the phone stops a
            // DESKTOP command through the remote WebSocket path instead.
            "native:kill-shell",
            "provider:list",
            "provider:upsert",
            "provider:remove",
            "provider:test",
            "provider:set-key",
            "provider:catalog",
            // Sign in with ChatGPT (backend design 2026-09-05 §5). The account,
            // its encrypted tokens and the 127.0.0.1:1455 sign-in listener all
            // live in the DESKTOP main process; Android has no native runtime to
            // hold any of that until M8. Reply not-implemented so the shared
            // React UI degrades to a "desktop only" state instead of timing out
            // (the card is hidden here anyway — chatgpt.supported is false off
            // the desktop preload).
            "chatgpt:status",
            "chatgpt:sign-in",
            "chatgpt:cancel-sign-in",
            "chatgpt:sign-out",
            // WebSearch providers (Phase 2 Plan B) — keyed Tavily/Exa upgrades.
            // Desktop-only; no Android runtime yet. Reply not-implemented so the
            // shared React UI degrades to a "desktop only" state instead of timing out.
            "search:list",
            "search:set-key",
            "search:remove-key",
            "search:test",
            // Remembered "Always allow" rules (M5 2a — permissions management UI).
            // These read/revoke the DESKTOP native harness's ~/.youcoded/permissions.json;
            // Android has no native harness to hold those grants until M8, which is
            // where M5's Android parity belongs. Reply not-implemented so the shared
            // React UI degrades to a "desktop only" state instead of timing out.
            "permissions:list",
            "permissions:remove",
            "permissions:remove-project",
            // Specialists 1c (Task 8) — roster + tier reads/writes + card
            // actions all read/write the DESKTOP native harness (SpecialistCatalog,
            // DelegationLedger, DelegatedModels), same as permissions:* above;
            // Android has no native harness to hold any of that until M8. Reply
            // not-implemented so the shared React UI degrades to a "desktop only"
            // state instead of timing out. specialists:event (the ledger push) is
            // OUTBOUND-only — same as native:model-state above — so it needs no
            // entry here at all.
            "specialists:list",
            "specialists:delegated-get",
            "specialists:delegated-set",
            "specialists:steer",
            "specialists:interrupt",
            // Local llama.cpp engine (Plan B) — desktop-only; no Android runtime yet.
            "engine:status",
            "engine:install",
            "engine:restart",
            "engine:set-context",   // Plan C context-length knob — desktop-only
            // Model manager (Plan C) — curated catalog, HF search, downloads,
            // endpoint detectors, backend switch. Desktop-only; no Android runtime.
            "engine:set-backend",
            "models:curated",
            "models:search",
            "models:quants",
            "models:download",
            "models:download-cancel",
            "models:delete",
            "models:installed",
            "models:resume",  // resume an interrupted download (2026-08-26) — desktop-only
            "endpoints:detect",
            // Model memory lifecycle (2026-07-14) — per-model residency, memory
            // guard, [Reload Model]. Desktop-only; no Android runtime. The push
            // events engine:models-changed / native:model-state are outbound-only
            // (no inbound handler needed).
            "engine:models",
            "models:memory-check",
            "models:load",
            // Cross-device project rename (display-name) + stop-syncing (2026-07-12)
            // are desktop-only (Phase 3 on Android).
            "syncspaces:rename-project",
            // Synced project description (Task 3) — desktop-only for now; without this
            // arm the description editor on a phone would wait ~30s for a response
            // that never arrives instead of failing fast.
            "syncspaces:set-project-description",
            "syncspaces:stop-project",
            // Plan 2b — conversation leases/takeover + device registry are
            // desktop-only (Android has no lease/takeover). The shared React UI
            // degrades: these invokes reject fast with this stub instead of
            // 30s-timing-out. (session:moved is a PUSH event — no request handler.)
            "syncspaces:lease-query",
            "syncspaces:lease-takeover",
            "syncspaces:lease-force",
            "syncspaces:list-devices",
            "syncspaces:rename-device",
            "syncspaces:remove-device",
            // Connect-GitHub modal (device-flow auth) is desktop-only. Android
            // signs into GitHub via its own gh-auth flow; the shared React modal
            // degrades — these invokes reject fast with this stub instead of
            // 30s-timing-out. (github:connect-done is a PUSH event — no handler.)
            // Voice prompting's two desktop-only calls. The desktop downloads a
            // speech model and asks the operating system about microphone access;
            // a phone needs neither — Android's own speech recognition is already
            // installed, and the permission question belongs to the app window's
            // prompt (voice:start above), not to a call the UI can make.
            "voice:download",
            "voice:mic-access",
            "github:status",
            "github:connect-start",
            "github:connect-cancel",
            "github:install-gh",
            "github:disconnect" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                    org.json.JSONObject().put("ok", false).put("error", "not-implemented-on-mobile")) }
            }

            else -> {
                android.util.Log.w("SessionService", "Unknown bridge message: ${msg.type}")
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, MessageRouter.buildErrorResponse("Unknown: ${msg.type}")) }
            }
        }
    }

    /**
     * Phase 4a: Publish a user-created plugin to the marketplace via `gh` CLI.
     * Runs gh commands using the Termux runtime environment (linker64 routing).
     * Mirrors the desktop publish flow: verify auth, fork, branch, upload, PR.
     */
    /**
     * Shared fork-and-PR publisher for community submissions (plugins →
     * wecoded-marketplace, themes → wecoded-themes). Extracted from the former
     * publishPluginViaGh/publishThemeViaGh, which were ~110 lines of byte-identical
     * fork → create-branch → recursive-upload → open-PR logic. Desktop already factored
     * the equivalent into github-fork-publish.ts (forkPublish); this brings Android to
     * the same single-helper shape (dead/duplicative-code review, 2026-07-22).
     *
     * gh routes through /system/bin/linker64 for SELinux (see android-runtime.md).
     * `noun` is the capitalized kind ("Plugin"/"Theme"); branch prefix, repo subdir, and
     * PR text all derive from it. `resolveDir` runs on the IO dispatcher and returns the
     * local directory to upload (letting each caller do its own existence check inline).
     */
    private suspend fun forkPublishViaGh(
        upstreamRepo: String,
        noun: String,
        id: String,
        resolveDir: () -> File,
    ): JSONObject = withContext(Dispatchers.IO) {
        val bs = bootstrap ?: throw IllegalStateException("Bootstrap not initialized")
        val env = bs.buildRuntimeEnv().toMutableMap()
        val ghBin = File(bs.usrDir, "bin/gh").absolutePath
        val sourceDir = resolveDir()

        // Helper: run a gh command and return stdout
        fun runGh(vararg args: String): String {
            val envArray = env.map { "${it.key}=${it.value}" }.toTypedArray()
            val cmd = arrayOf("/system/bin/linker64", ghBin, *args)
            val process = Runtime.getRuntime().exec(cmd, envArray, bs.homeDir)
            val stdout = process.inputStream.bufferedReader().readText()
            val stderr = process.errorStream.bufferedReader().readText()
            val exitCode = process.waitFor()
            if (exitCode != 0 && !stderr.contains("already exists")) {
                throw RuntimeException("gh ${args.firstOrNull()} failed: $stderr")
            }
            return stdout.trim()
        }

        val username = runGh("api", "user", "--jq", ".login")
        if (username.isBlank()) throw IllegalStateException("GitHub CLI not authenticated")

        val branchPrefix = noun.lowercase()          // "plugin" / "theme"
        val repoSubdir = "${branchPrefix}s"          // "plugins" / "themes"
        val forkRepo = "$username/${upstreamRepo.substringAfter('/')}"
        val branchName = "$branchPrefix/$id"

        // Fork (idempotent)
        try { runGh("repo", "fork", upstreamRepo, "--clone=false") } catch (_: Exception) {}

        // Get base SHA and create branch from upstream main
        val baseSha = runGh("api", "repos/$upstreamRepo/git/ref/heads/main", "--jq", ".object.sha")
        try {
            runGh("api", "repos/$forkRepo/git/refs", "-X", "POST",
                "-f", "ref=refs/heads/$branchName", "-f", "sha=$baseSha")
        } catch (_: Exception) {
            runGh("api", "repos/$forkRepo/git/refs/heads/$branchName", "-X", "PATCH",
                "-f", "sha=$baseSha", "-f", "force=true")
        }

        // Upload files (skip sensitive files, .git, node_modules). Superset of the two
        // former lists — the plugin path already blocked credentials.json/secrets.*; a
        // theme never contains those, so applying the same list to both is purely safer.
        val sensitivePatterns = listOf(
            Regex("\\.env$", RegexOption.IGNORE_CASE),
            Regex("\\.env\\..*", RegexOption.IGNORE_CASE),
            Regex("credentials\\.json$", RegexOption.IGNORE_CASE),
            Regex("secrets?\\.(json|ya?ml|toml)$", RegexOption.IGNORE_CASE),
            Regex("\\.pem$", RegexOption.IGNORE_CASE),
            Regex("\\.key$", RegexOption.IGNORE_CASE),
            Regex("tokens?\\.(json|txt)$", RegexOption.IGNORE_CASE),
        )
        val uploadedFiles = mutableListOf<String>()

        fun uploadRecursive(dir: File, prefix: String) {
            dir.listFiles()?.sortedBy { it.name }?.forEach { file ->
                val relPath = if (prefix.isEmpty()) file.name else "$prefix/${file.name}"
                if (file.isDirectory) {
                    if (file.name != ".git" && file.name != "node_modules") {
                        uploadRecursive(file, relPath)
                    }
                } else {
                    if (sensitivePatterns.any { it.containsMatchIn(relPath) }) return@forEach
                    val repoPath = "$repoSubdir/$id/$relPath"
                    val content = android.util.Base64.encodeToString(file.readBytes(), android.util.Base64.NO_WRAP)
                    try {
                        runGh("api", "repos/$forkRepo/contents/$repoPath", "-X", "PUT",
                            "-f", "message=Add $repoPath", "-f", "content=$content", "-f", "branch=$branchName")
                    } catch (_: Exception) {
                        // File exists — get SHA and update
                        val sha = runGh("api", "repos/$forkRepo/contents/$repoPath",
                            "-q", ".sha", "-H", "Accept: application/vnd.github.v3+json",
                            "--method", "GET", "-f", "ref=$branchName")
                        runGh("api", "repos/$forkRepo/contents/$repoPath", "-X", "PUT",
                            "-f", "message=Update $repoPath", "-f", "content=$content",
                            "-f", "sha=$sha", "-f", "branch=$branchName")
                    }
                    uploadedFiles.add(repoPath)
                }
            }
        }
        uploadRecursive(sourceDir, "")

        if (uploadedFiles.isEmpty()) throw IllegalStateException("No files to upload")

        // Create PR
        val prTitle = "[$noun] $id"
        val prBody = "## New $noun: $id\n\nSubmitted via YouCoded (Android)\n\n" +
            "### Files\n" + uploadedFiles.joinToString("\n") { "- `$it`" }

        val prUrl = try {
            runGh("pr", "create", "--repo", upstreamRepo,
                "--head", "$username:$branchName", "--title", prTitle, "--body", prBody)
        } catch (e: Exception) {
            // PR may already exist
            val existing = runGh("pr", "list", "--repo", upstreamRepo,
                "--head", "$username:$branchName", "--json", "url", "--jq", ".[0].url")
            if (existing.isNotBlank()) existing
            else throw RuntimeException("Failed to create PR: ${e.message}")
        }

        JSONObject().put("prUrl", prUrl)
    }

    private suspend fun publishPluginViaGh(pluginId: String): JSONObject =
        forkPublishViaGh("itsdestin/wecoded-marketplace", "Plugin", pluginId) {
            val bs = bootstrap ?: throw IllegalStateException("Bootstrap not initialized")
            // Look for the plugin in both the legacy toolkit root and the
            // marketplace subtree — match whichever directory actually exists.
            com.youcoded.app.skills.ClaudeCodeRegistry
                .listInstalledPluginDirs(bs.homeDir)
                .firstOrNull { it.name == pluginId }
                ?: throw IllegalStateException("Plugin directory not found: $pluginId")
        }

    /** Phase 5b: Publish a user-created theme to the wecoded-themes registry. */
    private suspend fun publishThemeViaGh(slug: String): JSONObject =
        forkPublishViaGh("itsdestin/wecoded-themes", "Theme", slug) {
            File(themesDir, slug).also {
                if (!it.exists()) throw IllegalStateException("Theme directory not found: $slug")
            }
        }

    // ── Phase 5a: Theme marketplace helpers ────────────────────────
    // Registry URL matches desktop's theme-marketplace-provider.ts REGISTRY_URL
    private val themeRegistryUrl =
        "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/registry/theme-registry.json"
    // In-memory cache with 15-min TTL (same as desktop)
    private var cachedThemeRegistry: org.json.JSONObject? = null
    private var themeCacheTimestamp = 0L
    private val themeCacheTtlMs = 15 * 60 * 1000L

    /** Themes directory — same path as desktop's THEMES_DIR */
    private val themesDir: File
        get() = File(bootstrap?.homeDir ?: filesDir, ".claude/wecoded-themes")

    /** Fetch theme registry, apply filters, annotate install status. */
    private fun themeMarketplaceList(filters: JSONObject): Any {
        val registry = fetchThemeRegistry()
        val themesArr = registry.optJSONArray("themes") ?: org.json.JSONArray()
        val results = org.json.JSONArray()

        // Read filter params
        val query = filters.optString("query", "").lowercase()
        val sourceFilter = filters.optString("source", "all")
        val modeFilter = filters.optString("mode", "all")
        val featuresArr = filters.optJSONArray("features")
        val wantedFeatures = mutableSetOf<String>()
        if (featuresArr != null) {
            for (i in 0 until featuresArr.length()) wantedFeatures.add(featuresArr.getString(i))
        }
        val sort = filters.optString("sort", "newest")

        // Collect matching themes
        val matched = mutableListOf<JSONObject>()
        for (i in 0 until themesArr.length()) {
            val t = themesArr.getJSONObject(i)
            // Source filter
            if (sourceFilter != "all" && t.optString("source") != sourceFilter) continue
            // Mode filter (dark/light)
            if (modeFilter == "dark" && !t.optBoolean("dark", false)) continue
            if (modeFilter == "light" && t.optBoolean("dark", false)) continue
            // Features filter
            if (wantedFeatures.isNotEmpty()) {
                val feats = t.optJSONArray("features") ?: org.json.JSONArray()
                var hasAny = false
                for (j in 0 until feats.length()) {
                    if (wantedFeatures.contains(feats.getString(j))) { hasAny = true; break }
                }
                if (!hasAny) continue
            }
            // Query filter
            if (query.isNotEmpty()) {
                val name = t.optString("name", "").lowercase()
                val author = t.optString("author", "").lowercase()
                val desc = t.optString("description", "").lowercase()
                if (!name.contains(query) && !author.contains(query) && !desc.contains(query)) continue
            }
            matched.add(t)
        }

        // Sort
        if (sort == "name") {
            matched.sortBy { it.optString("name", "") }
        } else {
            // newest first
            matched.sortByDescending { it.optString("created", "") }
        }

        // Annotate with installed status
        for (t in matched) {
            val slug = t.optString("slug", "")
            t.put("installed", isThemeInstalled(slug))
            results.put(t)
        }

        return results
    }

    /** Get a single theme's detail with install status. */
    private fun themeMarketplaceDetail(slug: String): Any {
        if (slug.isEmpty()) return JSONObject.NULL
        val registry = fetchThemeRegistry()
        val themesArr = registry.optJSONArray("themes") ?: org.json.JSONArray()
        for (i in 0 until themesArr.length()) {
            val t = themesArr.getJSONObject(i)
            if (t.optString("slug") == slug) {
                t.put("installed", isThemeInstalled(slug))
                return t
            }
        }
        return JSONObject.NULL
    }

    // Slug must be kebab-case — matches desktop's SAFE_SLUG_RE
    private val safeSlugRe = Regex("^[a-z0-9]+(?:-[a-z0-9]+)*$")
    // Max total download size per theme (10 MB, matches desktop)
    private val maxThemeSizeBytes = 10 * 1024 * 1024

    /**
     * Phase 5b: Install a theme from the marketplace.
     * Downloads manifest.json from the registry entry's manifestUrl, validates
     * required token fields, writes to ~/.claude/wecoded-themes/<slug>/.
     * Records install in the unified packages map for version tracking.
     */
    private fun themeMarketplaceInstall(slug: String): JSONObject {
        try {
            if (!safeSlugRe.matches(slug)) {
                return JSONObject().put("status", "failed").put("error", "Invalid theme slug")
            }

            // Look up registry entry for manifestUrl
            val registry = fetchThemeRegistry()
            val themesArr = registry.optJSONArray("themes") ?: org.json.JSONArray()
            var entry: JSONObject? = null
            for (i in 0 until themesArr.length()) {
                val t = themesArr.getJSONObject(i)
                if (t.optString("slug") == slug) { entry = t; break }
            }
            if (entry == null) {
                return JSONObject().put("status", "failed").put("error", "Theme not found in registry")
            }

            val manifestUrl = entry.optString("manifestUrl", "")
            if (manifestUrl.isEmpty()) {
                return JSONObject().put("status", "failed").put("error", "No manifest URL in registry")
            }

            // Download manifest
            val manifestText = try {
                java.net.URL(manifestUrl).readText()
            } catch (e: Exception) {
                return JSONObject().put("status", "failed")
                    .put("error", "Failed to download manifest: ${e.message}")
            }

            // Parse and inject source: 'community'
            val manifest = try {
                JSONObject(manifestText)
            } catch (e: Exception) {
                return JSONObject().put("status", "failed")
                    .put("error", "Invalid manifest JSON: ${e.message}")
            }
            manifest.put("source", "community")

            // Create theme directory + assets subdirectory
            val themeDir = File(themesDir, slug)
            val assetsDir = File(themeDir, "assets")
            assetsDir.mkdirs()

            // Phase 5c: Download asset files listed in the registry entry's assetUrls
            // map (mirrors desktop's theme-marketplace-provider.ts install flow).
            var totalBytes = manifestText.toByteArray().size.toLong()
            val assetUrls = entry.optJSONObject("assetUrls")
            if (assetUrls != null) {
                val keys = assetUrls.keys()
                while (keys.hasNext()) {
                    val relativePath = keys.next()
                    val url = assetUrls.getString(relativePath)

                    // Validate relative path — no path traversal
                    val resolved = File(themeDir, relativePath).canonicalFile
                    if (!resolved.path.startsWith(themeDir.canonicalPath + File.separator)) {
                        // Cleanup partial download
                        themeDir.deleteRecursively()
                        return JSONObject().put("status", "failed")
                            .put("error", "Invalid asset path: $relativePath")
                    }

                    val assetBytes = try {
                        java.net.URL(url).readBytes()
                    } catch (e: Exception) {
                        themeDir.deleteRecursively()
                        return JSONObject().put("status", "failed")
                            .put("error", "Failed to download asset $relativePath: ${e.message}")
                    }

                    totalBytes += assetBytes.size
                    if (totalBytes > maxThemeSizeBytes) {
                        themeDir.deleteRecursively()
                        return JSONObject().put("status", "failed")
                            .put("error", "Theme exceeds 10MB size limit")
                    }

                    // Ensure parent directory exists for nested assets
                    resolved.parentFile?.mkdirs()
                    resolved.writeBytes(assetBytes)
                }
            }

            // Write manifest last — theme-watcher triggers on manifest.json presence
            File(themeDir, "manifest.json").writeText(manifest.toString(2))

            // Phase 5b: record install in unified packages map (mirrors desktop)
            try {
                skillProvider?.configStore?.recordPackageInstall("theme:$slug", JSONObject().apply {
                    put("version", entry.optString("version", "1.0.0"))
                    put("source", "marketplace")
                    put("installedAt", java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US)
                        .apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
                        .format(java.util.Date()))
                    put("removable", true)
                    put("components", org.json.JSONArray().put(JSONObject().apply {
                        put("type", "theme")
                        put("path", themeDir.absolutePath)
                    }))
                })
            } catch (e: Exception) {
                // Non-fatal — theme is still on disk
                android.util.Log.w("SessionService", "Failed to record theme package install: ${e.message}")
            }

            // Fix: FileObserver on the themes-dir root is non-recursive, so it
            // doesn't see manifest.json created inside a new slug subdir. Without
            // an explicit broadcast, React's appearance picker never learns about
            // newly-installed themes until app restart. Broadcast the slug so
            // theme-context's onReload(slug) fetches and merges it into userThemes.
            bridgeServer.broadcast(JSONObject().apply {
                put("type", "theme:reload")
                put("payload", JSONObject().apply { put("slug", slug) })
            })

            return JSONObject().put("status", "installed")
        } catch (e: Exception) {
            return JSONObject().put("status", "failed").put("error", e.message ?: "Unknown error")
        }
    }

    /**
     * Phase 5b: Uninstall a community theme. Refuses to delete user-created themes.
     * Removes the theme directory and the unified packages entry.
     */
    private fun themeMarketplaceUninstall(slug: String): JSONObject {
        try {
            if (!safeSlugRe.matches(slug)) {
                return JSONObject().put("status", "failed").put("error", "Invalid theme slug")
            }

            val themeDir = File(themesDir, slug)
            val manifestFile = File(themeDir, "manifest.json")
            if (!manifestFile.exists()) {
                return JSONObject().put("status", "failed").put("error", "Theme not found on disk")
            }

            // Verify it's a community theme (not user-created)
            val manifest = try { JSONObject(manifestFile.readText()) } catch (_: Exception) { JSONObject() }
            if (manifest.optString("source") != "community") {
                return JSONObject().put("status", "failed")
                    .put("error", "Cannot uninstall non-community themes via marketplace")
            }

            // Delete the theme directory
            themeDir.deleteRecursively()

            // Remove from unified packages map
            try {
                skillProvider?.configStore?.removePackage("theme:$slug")
            } catch (e: Exception) {
                android.util.Log.w("SessionService", "Failed to remove theme package entry: ${e.message}")
            }

            return JSONObject().put("status", "uninstalled")
        } catch (e: Exception) {
            return JSONObject().put("status", "failed").put("error", e.message ?: "Unknown error")
        }
    }

    /** Check if a theme is installed by looking for its manifest.json on disk. */
    private fun isThemeInstalled(slug: String): Boolean {
        return try {
            File(themesDir, "$slug/manifest.json").exists()
        } catch (_: Exception) { false }
    }

    /** Fetch theme registry with in-memory + disk caching (mirrors desktop). */
    private fun fetchThemeRegistry(): org.json.JSONObject {
        // Return in-memory cache if fresh
        val cached = cachedThemeRegistry
        if (cached != null && System.currentTimeMillis() - themeCacheTimestamp < themeCacheTtlMs) {
            return cached
        }

        // Disk cache path
        val cacheDir = File(bootstrap?.homeDir ?: filesDir, ".claude/youcoded-cache")
        val cacheFile = File(cacheDir, "theme-registry.json")

        // Try remote fetch
        try {
            val data = java.net.URL(themeRegistryUrl).readText()
            val registry = org.json.JSONObject(data)
            cachedThemeRegistry = registry
            themeCacheTimestamp = System.currentTimeMillis()
            // Write disk cache (best-effort)
            try {
                cacheDir.mkdirs()
                cacheFile.writeText(data)
            } catch (_: Exception) {}
            return registry
        } catch (e: Exception) {
            android.util.Log.w("SessionService", "Theme registry fetch failed: ${e.message}")
        }

        // Fall back to disk cache
        try {
            if (cacheFile.exists()) {
                val data = cacheFile.readText()
                val registry = org.json.JSONObject(data)
                cachedThemeRegistry = registry
                themeCacheTimestamp = System.currentTimeMillis()
                return registry
            }
        } catch (_: Exception) {}

        // No cache — return empty registry
        return org.json.JSONObject().apply {
            put("version", 0)
            put("generatedAt", "")
            put("themes", org.json.JSONArray())
        }
    }

    /**
     * Read all user-set flags from ~/.claude/conversation-index.json.
     * Returns { sessionId: { flagName: true } } for flags whose value is true.
     * Also lifts v1 legacy `complete` field into flags.complete on read so
     * entries written before the flags generalization still show up correctly.
     */
    private fun readFlagMap(homeDir: File): Map<String, Map<String, Boolean>> {
        val indexFile = File(homeDir, ".claude/conversation-index.json")
        if (!indexFile.exists()) return emptyMap()
        return try {
            val root = JSONObject(indexFile.readText())
            val sessions = root.optJSONObject("sessions") ?: return emptyMap()
            val out = mutableMapOf<String, MutableMap<String, Boolean>>()
            val keys = sessions.keys()
            while (keys.hasNext()) {
                val sid = keys.next()
                val entry = sessions.optJSONObject(sid) ?: continue
                val row = mutableMapOf<String, Boolean>()
                entry.optJSONObject("flags")?.let { flagsObj ->
                    val fkeys = flagsObj.keys()
                    while (fkeys.hasNext()) {
                        val name = fkeys.next()
                        val state = flagsObj.optJSONObject(name) ?: continue
                        if (state.optBoolean("value", false)) row[name] = true
                    }
                }
                // v1 legacy — tolerated on read
                if (!row.containsKey("complete") && entry.optBoolean("complete", false)) {
                    row["complete"] = true
                }
                if (row.isNotEmpty()) out[sid] = row
            }
            out
        } catch (_: Throwable) { emptyMap() }
    }

    /**
     * Read per-session topic names from ~/.claude/conversation-index.json.
     * Used as a fallback for the Resume Browser when the ephemeral
     * ~/.claude/topics/topic-<id> file has been pruned (30-day) or was never
     * synced from another device — the index keeps the name longer and does
     * sync. Excludes blank / placeholder names. Mirrors the desktop's
     * readIndexMeta() topic map in session-browser.ts.
     */
    private fun readTopicMap(homeDir: File): Map<String, String> {
        val indexFile = File(homeDir, ".claude/conversation-index.json")
        if (!indexFile.exists()) return emptyMap()
        return try {
            val root = JSONObject(indexFile.readText())
            val sessions = root.optJSONObject("sessions") ?: return emptyMap()
            val out = mutableMapOf<String, String>()
            val keys = sessions.keys()
            while (keys.hasNext()) {
                val sid = keys.next()
                val entry = sessions.optJSONObject(sid) ?: continue
                val topic = entry.optString("topic", "").trim()
                if (topic.isNotBlank() && topic != "New Session" && topic != "Untitled") {
                    out[sid] = topic
                }
            }
            out
        } catch (_: Throwable) { emptyMap() }
    }

    /**
     * Set a named flag on a session in ~/.claude/conversation-index.json.
     * Writes under entry.flags[name] = { value, updatedAt } — mirrors
     * SyncService.setSessionFlag() on desktop so cross-device merge treats
     * each flag's updatedAt independently.
     */
    private fun writeSessionFlag(homeDir: File, sessionId: String, flag: String, value: Boolean): Boolean {
        val indexFile = File(homeDir, ".claude/conversation-index.json")
        return try {
            indexFile.parentFile?.mkdirs()
            val root = if (indexFile.exists()) {
                JSONObject(indexFile.readText())
            } else {
                JSONObject().apply { put("version", 1); put("sessions", JSONObject()) }
            }
            val sessions = root.optJSONObject("sessions") ?: JSONObject().also { root.put("sessions", it) }
            val nowIso = java.time.OffsetDateTime.now(java.time.ZoneOffset.UTC).toString()
            val entry = sessions.optJSONObject(sessionId) ?: JSONObject().apply {
                put("topic", "Untitled")
                put("lastActive", nowIso)
                put("slug", "")
                put("device", android.os.Build.MODEL ?: "android")
            }
            val flags = entry.optJSONObject("flags") ?: JSONObject().also { entry.put("flags", it) }
            flags.put(flag, JSONObject().apply {
                put("value", value)
                put("updatedAt", nowIso)
            })
            // Drop v1 legacy complete fields if present — canonical form is flags.complete now
            entry.remove("complete")
            entry.remove("completeUpdatedAt")
            sessions.put(sessionId, entry)
            val tmp = File(indexFile.parentFile, indexFile.name + ".tmp")
            tmp.writeText(root.toString(2))
            tmp.renameTo(indexFile) || run { indexFile.writeText(root.toString(2)); true }
            true
        } catch (_: Throwable) { false }
    }

    /**
     * Broadcast raw PTY bytes over the WebSocket as pty:raw-bytes push events.
     * Batches to coalesce bursts: flush every 16ms (~1 frame at 60fps) OR
     * when the pending buffer hits 8KB, whichever comes first. Base64 encodes
     * the payload so JSON can carry arbitrary bytes (ANSI control chars with
     * high bits are common). Broadcast recipient: all authenticated clients.
     *
     * WHY: The React-side terminal renderer (xterm.js) needs a raw byte feed
     * rather than a cooked-text snapshot so it can replay ANSI sequences and
     * render the terminal state faithfully on remote/WebView clients.
     */
    private fun launchRawByteBroadcast(sessionId: String, ptyBridge: PtyBridge): Job {
        return serviceScope.launch {
            val pending = java.io.ByteArrayOutputStream()
            var lastFlushNs = System.nanoTime()
            val flushIntervalNs = 16_000_000L  // 16 ms — ~1 frame at 60fps
            val maxBufferBytes = 8192           // 8 KB cap prevents unbounded latency on slow connections

            // Note: flush is data-driven — a partial buffer is only flushed when
            // the next byte arrives or when we hit 8KB. If the PTY goes silent
            // mid-batch, the tail bytes stay pending until the next emission.
            // Tier 1 has no render consumer so this is acceptable; Tier 2
            // xterm.js will need to tolerate up to one-batch lag on shell-idle
            // or handle it with a timer-driven flush (withTimeoutOrNull around
            // collect) if frame-accurate rendering matters.
            ptyBridge.rawByteFlow.collect { bytes ->
                pending.write(bytes)
                val now = System.nanoTime()
                if (pending.size() >= maxBufferBytes || now - lastFlushNs >= flushIntervalNs) {
                    try {
                        val payload = JSONObject().apply {
                            put("sessionId", sessionId)
                            put("data", android.util.Base64.encodeToString(
                                pending.toByteArray(), android.util.Base64.NO_WRAP))
                        }
                        bridgeServer.broadcast(
                            JSONObject().apply {
                                put("type", "pty:raw-bytes")
                                put("payload", payload)
                            }
                        )
                    } catch (e: Exception) {
                        // Broadcast failure (e.g. WebSocket gone mid-send) is best-effort;
                        // log and continue — the flow source (PtyBridge) is unaffected.
                        android.util.Log.w("SessionService", "pty:raw-bytes broadcast failed for $sessionId: ${e.message}")
                    }
                    pending.reset()
                    lastFlushNs = now
                }
            }
        }
    }

    companion object {
        const val CHANNEL_SESSION = "youcoded_session"
        const val CHANNEL_APPROVAL = "youcoded_approval"
        const val NOTIFICATION_ID = 1
        const val APPROVAL_NOTIFICATION_BASE = 1000
    }
}
