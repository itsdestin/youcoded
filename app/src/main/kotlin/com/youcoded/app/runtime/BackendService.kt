package com.youcoded.app.runtime

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import com.youcoded.app.BuildConfig
import com.youcoded.app.MainActivity
import java.io.File
import java.security.SecureRandom
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * Runs the YouCoded backend — the desktop app's own backend, headless, in a Node process — and keeps it
 * alive while the app is in use.
 *
 * WHY (2026-10-14, Android clean rebuild): the phone no longer has its own copy of the app's features.
 * This service lays out the bundled programs (RuntimeInstaller), starts `node headless-main.js` with a
 * fresh sign-in token, waits for its ready line, and publishes [state] for the screen. A backend that
 * exits is restarted with a growing pause. As a foreground service it keeps Android from freezing the
 * backend while a reply streams with the screen off. It also answers the backend's few requests for
 * things only the phone can do (HostSocketServer) and keeps resolv.conf matched to the active network.
 */
class BackendService : Service() {

    sealed interface State {
        data class Starting(val message: String) : State
        data class Ready(val port: Int, val token: String) : State
        data class Failed(val message: String) : State
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var runJob: Job? = null
    private var process: Process? = null
    private var hostServer: HostSocketServer? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private lateinit var installer: RuntimeInstaller

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        installer = RuntimeInstaller(applicationContext)
        createChannel()
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        watchNetwork()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_RESTART) { stopBackend(); runJob?.cancel(); runJob = null }
        if (runJob?.isActive != true) runJob = scope.launch { runLoop() }
        return START_STICKY
    }

    override fun onDestroy() {
        stopBackend()
        hostServer?.close()
        networkCallback?.let { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) }
        setKeepAwake(false)
        scope.cancel()
        _state.value = State.Starting("Stopped")
        super.onDestroy()
    }

    /** Start, wait, restart. Pauses grow 1 s → 30 s while the backend keeps dying, and reset once it runs a while. */
    private suspend fun runLoop() {
        var pauseMs = 1_000L
        while (true) {
            try {
                if (!installer.isCurrent()) installer.install { _state.value = State.Starting(it) }
                writeResolvConf()
                val started = System.currentTimeMillis()
                val code = runBackendOnce()
                Log.w(TAG, "backend exited with $code")
                if (System.currentTimeMillis() - started > 60_000) pauseMs = 1_000L
            } catch (e: Exception) {
                Log.e(TAG, "backend failed to start", e)
                _state.value = State.Failed(e.message ?: "The assistant could not start.")
            }
            _state.value = State.Starting("Restarting the assistant…")
            delay(pauseMs)
            pauseMs = (pauseMs * 2).coerceAtMost(30_000L)
        }
    }

    /** One run of the backend. Returns its exit code. */
    private fun runBackendOnce(): Int {
        _state.value = State.Starting("Starting the assistant…")
        val port = BuildConfig.BRIDGE_PORT
        val token = randomHex(32)
        val hostName = "youcoded-host-${packageName}"
        if (hostServer == null) hostServer = HostSocketServer(hostName, ::handleHostCall).also { it.start() }

        val env = installer.environment(mapOf(
            "YOUCODED_HEADLESS_PORT" to port.toString(),
            "YOUCODED_HEADLESS_TOKEN" to token,
            "YOUCODED_HOST_SOCKET" to "@$hostName",
            "YOUCODED_SECRET_KEY" to SecretKeyStore.key(applicationContext),
            "YOUCODED_APP_VERSION" to appVersion(),
        ))
        val pb = ProcessBuilder(File(installer.bin, "node").path, "dist/main/headless/headless-main.js")
            .directory(installer.backend)
            .redirectErrorStream(true)
        pb.environment().clear()
        pb.environment().putAll(env)
        val p = pb.start()
        process = p
        val log = File(installer.userData, "backend.log")
        log.parentFile?.mkdirs()
        p.inputStream.bufferedReader().use { reader ->
            log.bufferedWriter().use { out ->
                while (true) {
                    val line = reader.readLine() ?: break
                    out.write(line); out.newLine(); out.flush()
                    if (line.startsWith("YOUCODED_HEADLESS_READY")) _state.value = State.Ready(port, token)
                }
            }
        }
        val code = p.waitFor()
        process = null
        if (_state.value is State.Ready) _state.value = State.Starting("The assistant stopped; restarting…")
        else _state.value = State.Failed(lastLines(log))
        return code
    }

    private fun stopBackend() {
        process?.let { p ->
            p.destroy()
            if (!p.waitFor(3, java.util.concurrent.TimeUnit.SECONDS)) p.destroyForcibly()
        }
        process = null
    }

    /** What the backend asks of the phone (headless/host-bridge.ts). Runs off the main thread. */
    private fun handleHostCall(method: String, params: org.json.JSONObject): Any? = when (method) {
        "openExternal" -> {
            val url = params.optString("url")
            if (!url.startsWith("http://") && !url.startsWith("https://")) throw IllegalArgumentException("Only web links can be opened.")
            // Android blocks an app that is not on screen from opening another app (seen: a sign-in link from
            // `claude auth login` while the phone was locked). Then the link waits in a notification instead.
            val view = Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (MainActivity.visible) startActivity(view) else Notifier.showLink(applicationContext, "Open link", url, view)
            null
        }
        "keepAwake" -> { setKeepAwake(params.optBoolean("on")); null }
        "notify" -> { Notifier.show(applicationContext, params.optString("title"), params.optString("body")); null }
        else -> throw IllegalArgumentException("The phone has no '$method'.")
    }

    private fun setKeepAwake(on: Boolean) {
        if (on) {
            val wl = wakeLock ?: getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "YouCoded:backend").also { wakeLock = it }
            if (!wl.isHeld) wl.acquire(4 * 60 * 60 * 1000L) // a ceiling, so a forgotten "on" cannot drain the battery forever
        } else {
            wakeLock?.takeIf { it.isHeld }?.release()
        }
    }

    /** musl and c-ares read usr/etc/resolv.conf (patch-musl.py, ycshim.c): keep it matched to the active network. */
    private fun writeResolvConf(lp: LinkProperties? = null) {
        val cm = getSystemService(ConnectivityManager::class.java)
        val props = lp ?: cm.activeNetwork?.let { cm.getLinkProperties(it) }
        val servers = props?.dnsServers?.mapNotNull { it.hostAddress?.substringBefore('%') }.orEmpty()
        // Public resolvers only when the network names none (rare): a lookup that fails is worse.
        val lines = (servers.ifEmpty { listOf("1.1.1.1", "8.8.8.8") }).take(3).joinToString("\n") { "nameserver $it" }
        installer.etc.mkdirs()
        File(installer.etc, "resolv.conf").writeText(lines + "\n")
    }

    private fun watchNetwork() {
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onLinkPropertiesChanged(network: Network, lp: LinkProperties) { runCatching { writeResolvConf(lp) } }
        }
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(cb)
        networkCallback = cb
    }

    private fun appVersion(): String = runCatching {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "0.0.0"
    }.getOrDefault("0.0.0")

    private fun lastLines(log: File): String = runCatching {
        log.readLines().takeLast(6).joinToString("\n").ifBlank { "The assistant stopped before it was ready." }
    }.getOrDefault("The assistant stopped before it was ready.")

    private fun createChannel() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "YouCoded running", NotificationManager.IMPORTANCE_LOW)
                .apply { description = "Shown while YouCoded's assistant is running" }
        )
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("YouCoded")
            .setContentText("Your assistant is running")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val TAG = "BackendService"
        private const val CHANNEL_ID = "backend"
        private const val NOTIFICATION_ID = 1
        const val ACTION_RESTART = "com.youcoded.app.RESTART_BACKEND"

        private val _state = MutableStateFlow<State>(State.Starting("Starting YouCoded…"))
        val state: StateFlow<State> = _state

        fun start(context: Context, restart: Boolean = false) {
            val intent = Intent(context, BackendService::class.java)
            if (restart) intent.action = ACTION_RESTART
            context.startForegroundService(intent)
        }

        private fun randomHex(bytes: Int): String {
            val b = ByteArray(bytes); SecureRandom().nextBytes(b)
            return b.joinToString("") { "%02x".format(it) }
        }
    }
}
