package com.youcoded.app.runtime

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import com.youcoded.app.MainActivity

/** Notifications the backend asks for (host call "notify"). Tapping one opens the app. */
object Notifier {
    private const val CHANNEL_ID = "assistant"
    private var nextId = 100

    fun show(context: Context, title: String, body: String) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Assistant updates", NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(context, CHANNEL_ID)
            .setContentTitle(title.ifBlank { "YouCoded" })
            .setContentText(body)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        nm.notify(nextId++, n)
    }

    /** A link the app could not open while it was off screen: tapping the notification opens it. */
    fun showLink(context: Context, title: String, url: String, view: Intent) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Assistant updates", NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(context, nextId, view, PendingIntent.FLAG_IMMUTABLE)
        nm.notify(nextId++, Notification.Builder(context, CHANNEL_ID)
            .setContentTitle(title).setContentText(url).setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentIntent(open).setAutoCancel(true).build())
    }
}
