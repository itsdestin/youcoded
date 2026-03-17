package com.destins.claudemobile.runtime

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Binder
import android.os.IBinder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import com.destins.claudemobile.MainActivity

class SessionService : Service() {
    private val binder = LocalBinder()
    var ptyBridge: PtyBridge? = null
        private set

    inner class LocalBinder : Binder() {
        val service: SessionService get() = this@SessionService
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    private var bridgeScope: CoroutineScope? = null

    fun startSession(bootstrap: Bootstrap, apiKey: String? = null) {
        // Clean up any previous session to avoid orphaned coroutines/sockets
        bridgeScope?.cancel()
        bridgeScope = null
        ptyBridge?.stop()
        ptyBridge = null

        val bridge = PtyBridge(bootstrap, apiKey)
        ptyBridge = bridge

        // Start EventBridge BEFORE Claude Code — hooks fire immediately on launch
        // and hook-relay.js silently drops events if the socket isn't ready.
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        bridge.startEventBridge(scope)
        bridgeScope = scope

        bridge.start()

        startForeground(NOTIFICATION_ID, buildNotification())
    }

    fun stopSession() {
        bridgeScope?.cancel()
        bridgeScope = null
        ptyBridge?.stop()
        ptyBridge = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Claude Code Session",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Active Claude Code session"
        }
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pending = PendingIntent.getActivity(
            this, 0, intent, PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Claude Code")
            .setContentText("Session active")
            .setSmallIcon(android.R.drawable.ic_menu_edit)
            .setContentIntent(pending)
            .setOngoing(true)
            .build()
    }

    companion object {
        const val CHANNEL_ID = "claude_session"
        const val NOTIFICATION_ID = 1
    }
}
