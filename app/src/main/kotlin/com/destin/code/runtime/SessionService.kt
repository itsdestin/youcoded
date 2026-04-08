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
import com.destin.code.skills.LocalSkillProvider
import com.destin.code.skills.PluginInstaller

class SessionService : Service() {
    private val binder = LocalBinder()
    val sessionRegistry = SessionRegistry()
    val bridgeServer = LocalBridgeServer()
    var platformBridge: PlatformBridge? = null
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

    private var wakeLock: PowerManager.WakeLock? = null
    private var urlObserver: FileObserver? = null
    private var usageRefreshTimer: java.util.Timer? = null
    var skillProvider: LocalSkillProvider? = null
        private set
    var pluginInstaller: PluginInstaller? = null
        private set
    var bootstrap: Bootstrap? = null
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
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildSessionNotification())

        val homeDir = bootstrap?.homeDir ?: filesDir
        platformBridge = PlatformBridge(applicationContext, homeDir)
        sessionRegistry.bridgeServer = bridgeServer
        if (!bridgeServer.isRunning) {
            bridgeServer.start { ws, msg ->
                serviceScope.launch {
                    handleBridgeMessage(ws, msg)
                }
            }
        }

        return START_STICKY
    }

    fun initBootstrap(bs: Bootstrap) {
        bootstrap = bs
        titlesDir.mkdirs()
        startUrlObserver(bs)
        startUsageRefresh(bs)
        skillProvider = LocalSkillProvider(bs.homeDir, applicationContext)
        skillProvider?.ensureMigrated()
        pluginInstaller = PluginInstaller(bs.homeDir, bs, skillProvider!!.configStore)
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
                    if (url.startsWith("http")) {
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
        bridgeServer.stop()
        urlObserver?.stopWatching()
        urlObserver = null
        usageRefreshTimer?.cancel()
        usageRefreshTimer = null
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
                val dangerous = msg.payload.optBoolean("skipPermissions", false)
                // Use model from payload (sent by React) if provided, else fall back to preference file
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
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, info) }
                bridgeServer.broadcast(JSONObject().apply {
                    put("type", "session:created")
                    put("payload", info)
                })
            }
            "session:destroy" -> {
                val sessionId = msg.payload.optString("sessionId", "")
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
                if (text.isNotEmpty()) {
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
                val id = msg.payload.optString("id")
                val entry = skillProvider?.getMarketplaceEntry(id)

                if (entry != null && entry.optString("type") == "plugin"
                    && entry.optString("sourceMarketplace") != "destinclaude") {
                    // Plugin install — delegate to PluginInstaller
                    val result = pluginInstaller?.install(entry)
                        ?: PluginInstaller.InstallResult.Failed("Installer not initialized")
                    val response = when (result) {
                        is PluginInstaller.InstallResult.Success -> {
                            skillProvider?.invalidateCache()
                            // Convenience: reload plugins in active Claude Code session
                            sessionRegistry.getCurrentSession()
                                ?.takeIf { !it.shellMode && it.isRunning }
                                ?.writeInput("/reload-plugins\r")
                            JSONObject().put("status", "installed")
                        }
                        is PluginInstaller.InstallResult.AlreadyInstalled ->
                            JSONObject().put("status", "already_installed").put("via", result.via)
                        is PluginInstaller.InstallResult.Failed ->
                            JSONObject().put("status", "failed").put("error", result.error)
                        is PluginInstaller.InstallResult.InProgress ->
                            JSONObject().put("status", "installing")
                    }
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, response) }
                } else {
                    // Prompt skill install — existing path
                    try {
                        skillProvider?.install(id)
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                            JSONObject().put("status", "installed")) }
                    } catch (e: Exception) {
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                            JSONObject().put("status", "failed").put("error", e.message ?: "Unknown")) }
                    }
                }
            }
            "skills:uninstall" -> {
                val id = msg.payload.optString("id")
                // Check if this is a marketplace-installed plugin
                if (pluginInstaller?.isInstalled(id) == true) {
                    val ok = pluginInstaller?.uninstall(id) ?: false
                    skillProvider?.invalidateCache()
                    if (ok) {
                        sessionRegistry.getCurrentSession()
                            ?.takeIf { !it.shellMode && it.isRunning }
                            ?.writeInput("/reload-plugins\r")
                    }
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                        JSONObject().put("ok", ok)) }
                } else {
                    skillProvider?.uninstall(id)
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it,
                        JSONObject().put("ok", true)) }
                }
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
            "skills:publish" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("error", "Publishing not yet implemented")) }
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
                val arr = org.json.JSONArray()
                for (s in pastSessions) {
                    arr.put(JSONObject().apply {
                        put("sessionId", s.sessionId)
                        put("projectSlug", s.projectSlug)
                        put("name", s.name)
                        put("lastModified", s.lastModified)
                        put("projectPath", s.projectPath)
                    })
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, arr) }
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
                val prefs = applicationContext.getSharedPreferences("remote_devices", android.content.Context.MODE_PRIVATE)
                val json = prefs.getString("paired_devices", null)
                val devices = if (json != null) {
                    try { org.json.JSONArray(json) } catch (_: Exception) { org.json.JSONArray() }
                } else org.json.JSONArray()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("devices", devices)) }
            }
            "android:save-paired-device" -> {
                val prefs = applicationContext.getSharedPreferences("remote_devices", android.content.Context.MODE_PRIVATE)
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
                val prefs = applicationContext.getSharedPreferences("remote_devices", android.content.Context.MODE_PRIVATE)
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
                    }
                } catch (_: Exception) {
                    JSONObject().apply {
                        put("skipPermissions", false)
                        put("model", "sonnet")
                        put("projectFolder", "")
                    }
                }
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
                    }
                }
                // Merge payload keys into current
                msg.payload.keys().forEach { key ->
                    current.put(key, msg.payload.get(key))
                }
                defaultsFile.writeText(current.toString(2))
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, current) }
            }

            // --- Sync management ---
            // Reads toolkit state files from ~/.claude/ for the Sync Management UI.
            // Force sync shells out to the toolkit's sync.sh script.
            "sync:get-status" -> {
                val claudeDir = File(bootstrap!!.homeDir, ".claude")
                val configFile = File(claudeDir, "toolkit-state/config.json")
                val config = try { org.json.JSONObject(configFile.readText()) } catch (_: Exception) { org.json.JSONObject() }

                val backendStr = config.optString("PERSONAL_SYNC_BACKEND", "none")
                val driveRoot = config.optString("DRIVE_ROOT", "Claude")
                val syncRepo = config.optString("PERSONAL_SYNC_REPO", "")
                val icloudPath = config.optString("ICLOUD_PATH", "")
                val activeBackends = backendStr.split(",").map { it.trim().lowercase() }.filter { it.isNotEmpty() && it != "none" }

                val backends = org.json.JSONArray().apply {
                    put(JSONObject().put("name", "drive").put("configured", activeBackends.contains("drive"))
                        .put("detail", if (activeBackends.contains("drive")) "gdrive:$driveRoot/Backup/personal" else "Not configured"))
                    put(JSONObject().put("name", "github").put("configured", activeBackends.contains("github"))
                        .put("detail", if (activeBackends.contains("github") && syncRepo.isNotEmpty()) syncRepo else "Not configured"))
                    put(JSONObject().put("name", "icloud").put("configured", activeBackends.contains("icloud"))
                        .put("detail", if (activeBackends.contains("icloud") && icloudPath.isNotEmpty()) icloudPath else "Not configured"))
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
                    put("PERSONAL_SYNC_BACKEND", config.optString("PERSONAL_SYNC_BACKEND", "none"))
                    put("DRIVE_ROOT", config.optString("DRIVE_ROOT", "Claude"))
                    put("PERSONAL_SYNC_REPO", config.optString("PERSONAL_SYNC_REPO", ""))
                    put("ICLOUD_PATH", config.optString("ICLOUD_PATH", ""))
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
                    put("PERSONAL_SYNC_BACKEND", existing.optString("PERSONAL_SYNC_BACKEND", "none"))
                    put("DRIVE_ROOT", existing.optString("DRIVE_ROOT", "Claude"))
                    put("PERSONAL_SYNC_REPO", existing.optString("PERSONAL_SYNC_REPO", ""))
                    put("ICLOUD_PATH", existing.optString("ICLOUD_PATH", ""))
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "sync:force" -> {
                // Clear debounce marker and run sync.sh via shell
                val claudeDir = File(bootstrap!!.homeDir, ".claude")
                val markerFile = File(claudeDir, "toolkit-state/.sync-marker")
                try { markerFile.delete() } catch (_: Exception) {}

                val configFile = File(claudeDir, "toolkit-state/config.json")
                val config = try { org.json.JSONObject(configFile.readText()) } catch (_: Exception) { org.json.JSONObject() }
                val toolkitRoot = config.optString("toolkit_root", "")

                if (toolkitRoot.isEmpty()) {
                    msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()
                        .put("success", false).put("output", "").put("error", "Toolkit not installed")) }
                } else {
                    val syncScript = "$toolkitRoot/core/hooks/sync.sh"
                    try {
                        val env = bootstrap!!.buildRuntimeEnv().toMutableMap()
                        env["CLAUDE_DIR"] = claudeDir.absolutePath
                        val envArray = env.map { "${it.key}=${it.value}" }.toTypedArray()
                        val process = Runtime.getRuntime().exec(
                            arrayOf("bash", syncScript),
                            envArray,
                            claudeDir
                        )
                        // Write synthetic stdin JSON to trigger personal data path
                        process.outputStream.write("{\"tool_input\":{\"file_path\":\"${claudeDir.absolutePath}/CLAUDE.md\"}}".toByteArray())
                        process.outputStream.close()
                        val stdout = process.inputStream.bufferedReader().readText()
                        val stderr = process.errorStream.bufferedReader().readText()
                        val exitCode = process.waitFor()
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()
                            .put("success", exitCode == 0).put("output", stdout).put("error", stderr)) }
                    } catch (e: Exception) {
                        msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()
                            .put("success", false).put("output", "").put("error", e.message ?: "Unknown error")) }
                    }
                }
            }
            "sync:get-log" -> {
                val logFile = File(bootstrap!!.homeDir, ".claude/backup.log")
                val lines = msg.payload.optInt("lines", 30)
                val result = org.json.JSONArray().apply {
                    try {
                        logFile.readLines().takeLast(lines).forEach { put(it) }
                    } catch (_: Exception) {}
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "sync:dismiss-warning" -> {
                val warningsFile = File(bootstrap!!.homeDir, ".claude/.sync-warnings")
                val warning = msg.payload.optString("warning", "")
                if (warning.isNotEmpty() && warningsFile.exists()) {
                    val remaining = warningsFile.readLines().filter { it.trim() != warning.trim() }
                    if (remaining.isEmpty()) {
                        warningsFile.delete()
                    } else {
                        warningsFile.writeText(remaining.joinToString("\n") + "\n")
                    }
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("ok", true)) }
            }

            else -> {
                android.util.Log.w("SessionService", "Unknown bridge message: ${msg.type}")
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, MessageRouter.buildErrorResponse("Unknown: ${msg.type}")) }
            }
        }
    }

    companion object {
        const val CHANNEL_SESSION = "destincode_session"
        const val CHANNEL_APPROVAL = "destincode_approval"
        const val NOTIFICATION_ID = 1
        const val APPROVAL_NOTIFICATION_BASE = 1000
    }
}
