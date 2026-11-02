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
    @Volatile private var generation = 0
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
        if (intent?.action == ACTION_RESTART || runJob?.isActive != true) {
            // WHY a generation and an IO hop (independent review, 2026-10-15): a Retry used to cancel the loop while it
            // was still blocked reading the old process's output; when that read ended, the old loop cleared the NEW
            // process's handle, and stopping the old process waited up to 3 s on the main thread. Each loop now owns
            // one generation and quits as soon as a newer one starts; stopping happens off the main thread.
            val gen = ++generation
            runJob?.cancel()
            runJob = scope.launch {
                stopBackend()
                runLoop(gen)
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        // Main thread: ask the backend to stop and move on (no waiting here); a newer generation ends any loop.
        generation++
        synchronized(this) { process?.also { process = null } }?.destroy()
        hostServer?.close()
        networkCallback?.let { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) }
        setKeepAwake(false)
        scope.cancel()
        _state.value = State.Starting("Stopped")
        super.onDestroy()
    }

    /** Start, wait, restart. A backend that ran and then stopped is restarted, with pauses growing 1 s → 30 s while
     *  it keeps dying. One that never became ready stops here and shows Failed (with its own last words) until Retry —
     *  WHY (independent review, 2026-10-15): looping set "Restarting…" straight over Failed, so the screen with Retry
     *  never showed and the app sat on a spinner. */
    private suspend fun runLoop(gen: Int) {
        var pauseMs = 1_000L
        while (gen == generation) {
            val becameReady: Boolean
            try {
                if (!installer.isCurrent()) installer.install { _state.value = State.Starting(it) }
                writeResolvConf()
                val started = System.currentTimeMillis()
                becameReady = runBackendOnce(gen)
                if (System.currentTimeMillis() - started > 60_000) pauseMs = 1_000L
            } catch (e: Exception) {
                Log.e(TAG, "backend failed to start", e)
                if (gen == generation) _state.value = State.Failed(e.message ?: "The assistant could not start.")
                return
            }
            if (gen != generation) return
            if (!becameReady) return // Failed is on screen; Retry starts a new generation
            _state.value = State.Starting("Restarting the assistant…")
            delay(pauseMs)
            pauseMs = (pauseMs * 2).coerceAtMost(30_000L)
        }
    }

    @android.annotation.SuppressLint("HardwareIds") // the analytics identity; hashed before it leaves the phone
    private fun androidId(): String =
        runCatching { android.provider.Settings.Secure.getString(contentResolver, android.provider.Settings.Secure.ANDROID_ID) }
            .getOrNull().orEmpty()

    /** One run of the backend. True when it became ready before it exited. */
    private fun runBackendOnce(gen: Int): Boolean {
        _state.value = State.Starting("Starting the assistant…")
        val port = BuildConfig.BRIDGE_PORT
        val token = randomHex(32)
        val hostName = "youcoded-host-${packageName}"
        if (hostServer == null) hostServer = HostSocketServer(hostName, ::handleHostCall).also { it.start() }

        val env = installer.environment(mapOf(
            "YOUCODED_HEADLESS_PORT" to port.toString(),
            // The token and the secrets key go on stdin, never in the environment (headless-main.ts readSecrets — why).
            "YOUCODED_SECRETS_ON_STDIN" to "1",
            "YOUCODED_HOST_SOCKET" to "@$hostName",
            "YOUCODED_APP_VERSION" to appVersion(),
            // WHY: the backend's daily analytics check-in identifies a phone by this ID
            // (hashed on the phone before sending), exactly as the 1.3.0 app did, so a
            // reinstall is not counted as a new person. headless-boot.ts reads it once
            // and removes it, so programs the backend starts never see it.
            "YOUCODED_ANDROID_ID" to androidId(),
        ))
        val pb = ProcessBuilder(File(installer.bin, "node").path, "dist/main/headless/headless-main.js")
            .directory(installer.backend)
            .redirectErrorStream(true)
        pb.environment().clear()
        pb.environment().putAll(env)
        val p = pb.start()
        p.outputStream.use { stdin ->
            val secrets = org.json.JSONObject().put("token", token).put("key", SecretKeyStore.key(applicationContext))
            stdin.write((secrets.toString() + "\n").toByteArray())
        }
        synchronized(this) {
            if (gen != generation) { p.destroyForcibly(); return false }
            process = p
        }
        var ready = false
        val log = File(installer.userData, "backend.log")
        log.parentFile?.mkdirs()
        p.inputStream.bufferedReader().use { reader ->
            log.bufferedWriter().use { out ->
                while (true) {
                    val line = reader.readLine() ?: break
                    out.write(line); out.newLine(); out.flush()
                    if (line.startsWith("YOUCODED_HEADLESS_READY") && gen == generation) {
                        ready = true
                        _state.value = State.Ready(port, token)
                    }
                }
            }
        }
        val code = p.waitFor()
        synchronized(this) { if (process === p) process = null }
        Log.w(TAG, "backend exited with $code")
        if (gen == generation && !ready) _state.value = State.Failed(lastLines(log))
        return ready
    }

    /** Stop the running backend, if any. Blocking (up to 3 s): never call on the main thread. */
    private fun stopBackend() {
        val p = synchronized(this) { process.also { process = null } } ?: return
        p.destroy()
        if (!p.waitFor(3, java.util.concurrent.TimeUnit.SECONDS)) p.destroyForcibly()
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
