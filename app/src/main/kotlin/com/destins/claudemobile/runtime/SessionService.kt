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

    fun startSession(bootstrap: Bootstrap, apiKey: String) {
        val bridge = PtyBridge(bootstrap, apiKey)
        bridge.start()
        ptyBridge = bridge

        val parserScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        bridge.startParser(parserScope, applicationContext)
        this.parserScope = parserScope

        startForeground(NOTIFICATION_ID, buildNotification())
    }

    private var parserScope: CoroutineScope? = null

    fun stopSession() {
        parserScope?.cancel()
        parserScope = null
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
