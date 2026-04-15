package com.destin.code.runtime

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
import com.destin.code.MainActivity
import com.destin.code.bridge.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys
import com.destin.code.marketplace.ApiResult
import com.destin.code.marketplace.MarketplaceApiClient
import com.destin.code.marketplace.MarketplaceAuthStore
import com.destin.code.marketplace.MarketplaceUser
import com.destin.code.skills.LocalSkillProvider
import com.destin.code.skills.PluginInstaller

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

    /** View mode requested by React UI — ChatScreen observes this.
     *  SharedFlow (not StateFlow) because these are events, not state:
     *  "switch to terminal" must fire even if the last request was also "terminal". */
    private val _viewModeRequest = kotlinx.coroutines.flow.MutableSharedFlow<String>(extraBufferCapacity = 1)
    val viewModeRequest: kotlinx.coroutines.flow.SharedFlow<String> = _viewModeRequest

    /** Emit a view mode change from native code. */
    fun requestViewMode(mode: String) {
        _viewModeRequest.tryEmit(mode)
    }

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

    // ── Marketplace auth + API ───────────────────────────────────────────────
    // WHY lazy: applicationContext is not available during construction; initialized
    // on first use inside handleBridgeMessage which always runs after onCreate().
    private val marketplaceAuthStore: MarketplaceAuthStore by lazy {
        MarketplaceAuthStore.create(applicationContext)
    }
    private val marketplaceApiClient: MarketplaceApiClient by lazy {
        MarketplaceApiClient(marketplaceAuthStore)
    }
    /**
     * Callback for the Activity to open the device's browser at the given URL.
     * Follows the same deferred-callback pattern as onFilePickerRequested and
     * onFolderPickerRequested — the Activity sets this after binding to the service.
     */
    var onMarketplaceAuthUrlRequested: ((String) -> Unit)? = null

    private var wakeLock: PowerManager.WakeLock? = null
    private var urlObserver: FileObserver? = null
    private var usageRefreshTimer: java.util.Timer? = null
    private var statusBroadcastTimer: java.util.Timer? = null
    // Phase 5d: FileObserver for theme hot-reload
    private var themeWatcher: FileObserver? = null
    var skillProvider: LocalSkillProvider? = null
        private set
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
        startUsageRefresh(bs)
        startStatusBroadcast(bs)
        skillProvider = LocalSkillProvider(bs.homeDir, applicationContext)
        skillProvider?.ensureMigrated()
        pluginInstaller = PluginInstaller(bs.homeDir, bs, skillProvider!!.configStore)
        // Wire up plugin installer and reload callback so LocalSkillProvider
        // handles all install/uninstall routing (consolidates SessionService logic)
        skillProvider?.pluginInstaller = pluginInstaller
        skillProvider?.onPluginsChanged = {
            sessionRegistry.getCurrentSession()
                ?.takeIf { !it.shellMode && it.isRunning }
                ?.writeInput("/reload-plugins\r")
        }
        // Decomposition v3: wire integration reconciler + run once on launch so
        // ~/.claude/integration-context.md reflects currently-installed packages
        // before any session starts. Also re-runs after every install/uninstall.
        val reconciler = com.destin.code.skills.IntegrationReconciler(bs.homeDir)
        skillProvider?.integrationReconciler = reconciler
        try {
            val summary = reconciler.reconcile()
            android.util.Log.i("SessionService", "Integration context generated: rows=${summary.rowCount} providers=${summary.providerCount}")
        } catch (e: Exception) {
            android.util.Log.w("SessionService", "Initial integration reconcile failed", e)
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

        // Decomposition v3 §9.3: reconcile plugin mcp-manifest.json into
        // .claude.json mcpServers. Only auto:true entries; filtered to "linux"/"all".
        val mcpReconciler = com.destin.code.skills.McpReconciler(bs.homeDir)
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

    /** Periodically runs usage-fetch.js to keep .usage-cache.json fresh. */
    private fun startUsageRefresh(bs: Bootstrap) {
        usageRefreshTimer?.cancel()
        val nodePath = File(bs.usrDir, "bin/node").absolutePath
        val scriptPath = File(bs.homeDir, ".claude-mobile/usage-fetch.js").absolutePath
        val env = bs.buildRuntimeEnv()

        usageRefreshTimer = java.util.Timer("usage-refresh", true).apply {
            scheduleAtFixedRate(object : java.util.TimerTask() {
                override fun run() {
                    try {
                        val pb = ProcessBuilder(nodePath, scriptPath)
                            .directory(bs.homeDir)
                            .redirectErrorStream(true)
                        pb.environment().putAll(env)
                        val process = pb.start()
                        process.waitFor(15, java.util.concurrent.TimeUnit.SECONDS)
                        if (process.isAlive) process.destroyForcibly()
                    } catch (_: Exception) {}
                }
            }, 10_000, 5 * 60 * 1000) // initial 10s delay, then every 5 min
        }
    }

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

                        // Sync status
                        val syncFile = File(claudeDir, ".sync-status")
                        if (syncFile.exists()) {
                            try { payload.put("syncStatus", syncFile.readText().trim()) } catch (_: Exception) {}
                        }
                        val warnFile = File(claudeDir, ".sync-warnings")
                        if (warnFile.exists()) {
                            try { payload.put("syncWarnings", warnFile.readText().trim()) } catch (_: Exception) {}
                        }

                        // Per-session context % and session stats
                        val contextMap = JSONObject()
                        val sessionStatsMap = JSONObject()
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
                        }
                        payload.put("contextMap", contextMap)
                        payload.put("sessionStatsMap", sessionStatsMap)

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
     * Phase 5d: Watch ~/.claude/destinclaude-themes/ for changes.
     * Sends theme:reload push events via WebSocket when theme files change,
     * matching desktop's theme-watcher.ts behavior with per-slug debouncing.
     */
    private fun startThemeWatcher(bs: Bootstrap) {
        val watchDir = File(bs.homeDir, ".claude/destinclaude-themes")
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

    // Legacy single-session API — used by ServiceBinder until full migration
    fun startSession(bs: Bootstrap, apiKey: String? = null) {
        initBootstrap(bs)
        val session = createSession(bs.homeDir, dangerousMode = false, apiKey = apiKey)
        ptyBridge = session.ptyBridge
        startForeground(NOTIFICATION_ID, buildSessionNotification())
    }

    fun stopSession() {
        sessionRegistry.destroyAll()
        ptyBridge = null
        releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

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
        syncService?.let { sync ->
            serviceScope.launch {
                try {
                    sync.pushSession(sessionId)
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
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "DestinCode::Session").apply {
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

    /** Push permission overrides to all active sessions' in-memory cache. */
    private fun syncPermissionOverridesToSessions(overrides: JSONObject) {
        sessionRegistry.sessions.value.values.forEach { session ->
            session.permissionOverridesCache = overrides
        }
    }

    private fun createNotificationChannels() {
        val manager = getSystemService(NotificationManager::class.java)

        val sessionChannel = NotificationChannel(
            CHANNEL_SESSION, "DestinCode Sessions", NotificationManager.IMPORTANCE_LOW
        ).apply { description = "Active DestinCode sessions" }

        val approvalChannel = NotificationChannel(
            CHANNEL_APPROVAL, "Approval Prompts", NotificationManager.IMPORTANCE_HIGH
        ).apply { description = "DestinCode permission prompts" }

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
            .setContentTitle("DestinCode")
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
        usageRefreshTimer?.cancel()
        usageRefreshTimer = null
        statusBroadcastTimer?.cancel()
        statusBroadcastTimer = null
        sessionRegistry.destroyAll()
        releaseWakeLock()
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
                    permissionMode = "normal", skipPermissions = dangerous,
                    createdAt = session.createdAt
                )
                // Security: record which client ID owns this session
                val ownerClientId = ws.getAttachment<String>() ?: "unknown"
                sessionOwnership[session.id] = ownerClientId
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, info) }
                bridgeServer.broadcast(JSONObject().apply {
                    put("type", "session:created")
                    put("payload", info)
                })
            }
            "session:destroy" -> {
                val sessionId = msg.payload.optString("sessionId", "")
                sessionOwnership.remove(sessionId) // Clean up ownership tracking
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
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "skills:uninstall" -> {
                // All uninstall routing consolidated in LocalSkillProvider
                val id = msg.payload.optString("id")
                val result = skillProvider?.uninstall(id)
                    ?: JSONObject().put("ok", false).put("error", "Skill provider not initialized")
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
            // Marketplace redesign Phase 3 — integrations scaffold. List
            // returns the cached catalog; the rest are stubs that will gain
            // real wiring when the desktop Google Workspace slice ships and
            // we port it to Android.
            "integrations:list" -> {
                val result = org.json.JSONArray()
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
            "integrations:configure" -> {
                val result = JSONObject().apply {
                    put("slug", msg.payload?.optString("slug") ?: "")
                    put("installed", false)
                    put("connected", false)
                    put("error", "not-implemented: integrations available on Android in a follow-up")
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
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
                val configDir = File(bootstrap?.homeDir ?: filesDir, ".claude/destincode-config")
                val configFile = File(configDir, "$id.json")
                val result = try {
                    if (configFile.exists()) JSONObject(configFile.readText()) else JSONObject()
                } catch (_: Exception) { JSONObject() }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "marketplace:set-config" -> {
                val id = msg.payload.optString("id")
                val values = msg.payload.optJSONObject("values") ?: JSONObject()
                val configDir = File(bootstrap?.homeDir ?: filesDir, ".claude/destincode-config")
                configDir.mkdirs()
                File(configDir, "$id.json").writeText(values.toString(2))
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("ok", true)) }
            }
            "github:auth" -> {
                // No GitHub auth on Android — return null
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject.NULL) }
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
                val store = com.destin.code.config.WorkingDirStore(homeDir)
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
                    })
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, arr) }
            }
            "folders:add" -> {
                val folderPath = msg.payload.optString("folderPath", "")
                val nickname = msg.payload.optString("nickname", "")
                if (folderPath.isNotEmpty()) {
                    val homeDir = bootstrap?.homeDir ?: filesDir
                    val store = com.destin.code.config.WorkingDirStore(homeDir)
                    val label = nickname.ifEmpty { File(folderPath).name }
                    store.add(com.destin.code.config.WorkingDir(label = label, path = folderPath))
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
                    val store = com.destin.code.config.WorkingDirStore(homeDir)
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
                    val store = com.destin.code.config.WorkingDirStore(homeDir)
                    val existing = store.dirs.value.find { it.path == folderPath }
                    if (existing != null) {
                        store.rename(folderPath, nickname)
                        renamed = true
                    }
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, renamed) }
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
                val arr = org.json.JSONArray()
                for (s in pastSessions) {
                    arr.put(JSONObject().apply {
                        put("sessionId", s.sessionId)
                        put("projectSlug", s.projectSlug)
                        put("name", s.name)
                        put("lastModified", s.lastModified)
                        put("projectPath", s.projectPath)
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
            "session:set-flag" -> {
                // Set a named flag on a past session. Writes the same
                // conversation-index.json the desktop writes — sync picks it
                // up through the existing backup pipeline. Unknown flag names
                // are rejected so a typo surfaces as an error.
                val sessionId = msg.payload.optString("sessionId", "")
                val flag = msg.payload.optString("flag", "")
                val value = msg.payload.optBoolean("value", false)
                val allowed = setOf("complete", "priority", "helpful")
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
                when (action) {
                    "switch-view" -> {
                        val mode = msg.payload.optString("mode", "chat")
                        _viewModeRequest.tryEmit(mode)
                    }
                    "layout-update" -> {
                        val headerPx = msg.payload.optInt("headerHeight", 0)
                        val bottomPx = msg.payload.optInt("bottomHeight", 0)
                        _layoutInsets.tryEmit(LayoutInsets(headerPx, bottomPx))
                    }
                }
            }

            // ── Android-only settings bridge ────────────────────────────
            "android:get-tier" -> {
                val tierStore = com.destin.code.config.TierStore(applicationContext)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("tier", tierStore.selectedTier.name)) }
            }
            "android:set-tier" -> {
                val tierName = msg.payload.optString("tier", "CORE")
                val tierStore = com.destin.code.config.TierStore(applicationContext)
                val newTier = try {
                    com.destin.code.config.PackageTier.valueOf(tierName)
                } catch (_: Exception) { com.destin.code.config.PackageTier.CORE }
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
                val prefFile = File(bootstrap!!.homeDir, ".claude-mobile/destincode-appearance.json")
                val result: Any = try {
                    org.json.JSONObject(prefFile.readText())
                } catch (_: Exception) { org.json.JSONObject.NULL }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "appearance:set" -> {
                val prefFile = File(bootstrap!!.homeDir, ".claude-mobile/destincode-appearance.json")
                try {
                    val existing = try {
                        org.json.JSONObject(prefFile.readText())
                    } catch (_: Exception) { org.json.JSONObject() }
                    val keys = msg.payload.keys()
                    while (keys.hasNext()) {
                        val key = keys.next()
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
                val defaultsFile = File(bootstrap!!.homeDir, ".claude-mobile/destincode-defaults.json")
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
                val defaultsFile = File(bootstrap!!.homeDir, ".claude-mobile/destincode-defaults.json")
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
                        val opts = RestoreOptions.fromJson(msg.payload)
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
                        val opts = RestoreOptions.fromJson(msg.payload)
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
                // Run rclone config create — BROWSER env var routes OAuth to Android browser
                val sync = syncService
                if (sync == null) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()
                        .put("success", false).put("remoteName", "gdrive").put("error", "SyncService not initialized")) }
                } else {
                    try {
                        val result = sync.execCommand(listOf("rclone", "config", "create", "gdrive", "drive"), timeoutSeconds = 120)
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
                                "--description", "Personal Claude data backup (managed by DestinCode)"))
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

            // ── Marketplace auth (device-code OAuth) ────────────────────────────
            // These 5 types mirror the desktop marketplace-auth-handlers.ts exactly.

            "marketplace:auth:start" -> {
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
                            android.util.Log.w("SessionService", "marketplace:auth:start — browser open failed: ${e.message}")
                        }
                    }
                }
                msg.id?.let {
                    bridgeServer.respond(ws, msg.type, it, result.toJson { v -> v })
                }
            }

            "marketplace:auth:poll" -> {
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
                            android.util.Log.i("SessionService", "marketplace:auth:poll — complete, saving token")
                            marketplaceAuthStore.setToken(token)
                            // Persist user info if returned alongside token
                            val userObj = pollBody.optJSONObject("user")
                            if (userObj != null) {
                                val user = MarketplaceUser(
                                    id        = userObj.optString("id", ""),
                                    login     = userObj.optString("login", ""),
                                    avatarUrl = userObj.optString("avatar_url", ""),
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

            "marketplace:auth:signed-in" -> {
                // Plain boolean — no HTTP call, reads local store only
                val signedIn = marketplaceAuthStore.getToken() != null
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, signedIn) }
            }

            "marketplace:auth:user" -> {
                // Returns the stored MarketplaceUser as a JSONObject, or null
                val user = marketplaceAuthStore.getUser()
                val result: Any = if (user != null) {
                    JSONObject().apply {
                        put("id",         user.id)
                        put("login",      user.login)
                        put("avatar_url", user.avatarUrl)
                    }
                } else {
                    JSONObject.NULL
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }

            "marketplace:auth:sign-out" -> {
                // Fire-and-forget: clears local credentials, no HTTP call needed
                marketplaceAuthStore.signOut()
                // Respond with void (true as success indicator, matching desktop convention)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, true) }
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
    private suspend fun publishPluginViaGh(pluginId: String): JSONObject = withContext(Dispatchers.IO) {
        val bs = bootstrap ?: throw IllegalStateException("Bootstrap not initialized")
        val env = bs.buildRuntimeEnv().toMutableMap()
        val pluginDir = File(bs.homeDir, ".claude/plugins/$pluginId")
        if (!pluginDir.exists()) throw IllegalStateException("Plugin directory not found: $pluginId")

        val ghBin = File(bs.usrDir, "bin/gh").absolutePath

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

        // 1. Get GitHub username
        val username = runGh("api", "user", "--jq", ".login")
        if (username.isBlank()) throw IllegalStateException("GitHub CLI not authenticated")

        val upstreamRepo = "itsdestin/destincode-marketplace"
        val forkRepo = "$username/destincode-marketplace"
        val branchName = "plugin/$pluginId"

        // 2. Fork (idempotent)
        try { runGh("repo", "fork", upstreamRepo, "--clone=false") } catch (_: Exception) {}

        // 3. Get base SHA and create branch
        val baseSha = runGh("api", "repos/$upstreamRepo/git/ref/heads/main", "--jq", ".object.sha")
        try {
            runGh("api", "repos/$forkRepo/git/refs", "-X", "POST",
                "-f", "ref=refs/heads/$branchName", "-f", "sha=$baseSha")
        } catch (_: Exception) {
            runGh("api", "repos/$forkRepo/git/refs/heads/$branchName", "-X", "PATCH",
                "-f", "sha=$baseSha", "-f", "force=true")
        }

        // 4. Upload plugin files (skip sensitive files, .git, node_modules)
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
                    val repoPath = "plugins/$pluginId/$relPath"
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
        uploadRecursive(pluginDir, "")

        if (uploadedFiles.isEmpty()) throw IllegalStateException("No files to upload")

        // 5. Create PR
        val prTitle = "[Plugin] $pluginId"
        val prBody = "## New Plugin: $pluginId\n\nSubmitted via DestinCode (Android)\n\n" +
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

    /**
     * Phase 5b: Publish a user-created theme to destinclaude-themes registry via `gh` CLI.
     * Mirrors publishPluginViaGh but targets the theme registry repo.
     */
    private suspend fun publishThemeViaGh(slug: String): JSONObject = withContext(Dispatchers.IO) {
        val bs = bootstrap ?: throw IllegalStateException("Bootstrap not initialized")
        val env = bs.buildRuntimeEnv().toMutableMap()
        val themeDir = File(themesDir, slug)
        if (!themeDir.exists()) throw IllegalStateException("Theme directory not found: $slug")

        val ghBin = File(bs.usrDir, "bin/gh").absolutePath

        // Helper: run a gh command and return stdout (routes through linker64 for SELinux)
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

        val upstreamRepo = "itsdestin/destinclaude-themes"
        val forkRepo = "$username/destinclaude-themes"
        val branchName = "theme/$slug"

        // Fork (idempotent)
        try { runGh("repo", "fork", upstreamRepo, "--clone=false") } catch (_: Exception) {}

        // Create branch from upstream main
        val baseSha = runGh("api", "repos/$upstreamRepo/git/ref/heads/main", "--jq", ".object.sha")
        try {
            runGh("api", "repos/$forkRepo/git/refs", "-X", "POST",
                "-f", "ref=refs/heads/$branchName", "-f", "sha=$baseSha")
        } catch (_: Exception) {
            runGh("api", "repos/$forkRepo/git/refs/heads/$branchName", "-X", "PATCH",
                "-f", "sha=$baseSha", "-f", "force=true")
        }

        // Upload theme files (skip sensitive files, .git, node_modules)
        val sensitivePatterns = listOf(
            Regex("\\.env$", RegexOption.IGNORE_CASE),
            Regex("\\.env\\..*", RegexOption.IGNORE_CASE),
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
                    val repoPath = "themes/$slug/$relPath"
                    val content = android.util.Base64.encodeToString(file.readBytes(), android.util.Base64.NO_WRAP)
                    try {
                        runGh("api", "repos/$forkRepo/contents/$repoPath", "-X", "PUT",
                            "-f", "message=Add $repoPath", "-f", "content=$content", "-f", "branch=$branchName")
                    } catch (_: Exception) {
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
        uploadRecursive(themeDir, "")

        if (uploadedFiles.isEmpty()) throw IllegalStateException("No files to upload")

        // Create PR
        val prTitle = "[Theme] $slug"
        val prBody = "## New Theme: $slug\n\nSubmitted via DestinCode (Android)\n\n" +
            "### Files\n" + uploadedFiles.joinToString("\n") { "- `$it`" }

        val prUrl = try {
            runGh("pr", "create", "--repo", upstreamRepo,
                "--head", "$username:$branchName", "--title", prTitle, "--body", prBody)
        } catch (e: Exception) {
            val existing = runGh("pr", "list", "--repo", upstreamRepo,
                "--head", "$username:$branchName", "--json", "url", "--jq", ".[0].url")
            if (existing.isNotBlank()) existing
            else throw RuntimeException("Failed to create PR: ${e.message}")
        }

        JSONObject().put("prUrl", prUrl)
    }

    // ── Phase 5a: Theme marketplace helpers ────────────────────────
    // Registry URL matches desktop's theme-marketplace-provider.ts REGISTRY_URL
    private val themeRegistryUrl =
        "https://raw.githubusercontent.com/itsdestin/destinclaude-themes/main/registry/theme-registry.json"
    // In-memory cache with 15-min TTL (same as desktop)
    private var cachedThemeRegistry: org.json.JSONObject? = null
    private var themeCacheTimestamp = 0L
    private val themeCacheTtlMs = 15 * 60 * 1000L

    /** Themes directory — same path as desktop's THEMES_DIR */
    private val themesDir: File
        get() = File(bootstrap?.homeDir ?: filesDir, ".claude/destinclaude-themes")

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
     * required token fields, writes to ~/.claude/destinclaude-themes/<slug>/.
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
        val cacheDir = File(bootstrap?.homeDir ?: filesDir, ".claude/destincode-cache")
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

    companion object {
        const val CHANNEL_SESSION = "destincode_session"
        const val CHANNEL_APPROVAL = "destincode_approval"
        const val NOTIFICATION_ID = 1
        const val APPROVAL_NOTIFICATION_BASE = 1000
    }
}
