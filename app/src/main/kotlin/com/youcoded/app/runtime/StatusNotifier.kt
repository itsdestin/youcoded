package com.youcoded.app.runtime

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import com.youcoded.app.MainActivity
import org.json.JSONObject

/**
 * Shows what the backend says about its sessions (host call "status", desktop/src/main/background-status.ts).
 *
 * WHY (background notifications, owner decision 2026-11-01): the backend works out the counts ("2 working · 1 waiting for you · 3 done")
 * and who needs the person; this only DRAWS them. Two notifications: the always-on foreground-service one (its text updates), and a
 * loud one per session that needs the person, shown only while the app is off screen and removed when answered or when the app opens.
 */
class StatusNotifier(private val context: Context, private val ongoing: (String) -> Notification) {
    private val nm = context.getSystemService(NotificationManager::class.java)
    private val posted = HashSet<String>() // session ids with a visible "needs you"

    init {
        nm.createNotificationChannel(
            NotificationChannel(NEEDS_CHANNEL, "Needs you", NotificationManager.IMPORTANCE_HIGH)
                .apply { description = "When the assistant is waiting for your approval or an answer" }
        )
    }

    @Synchronized
    fun show(status: JSONObject) {
        nm.notify(ONGOING_ID, ongoing(status.optString("text").ifBlank { "Your assistant is running" }))
        val needs = status.optJSONArray("needs")
        val current = HashMap<String, JSONObject>()
        if (needs != null) for (i in 0 until needs.length()) needs.optJSONObject(i)?.let { current[it.optString("sessionId")] = it }
        // Answered (or session ended): take its alert down.
        for (id in posted.toList()) if (id !in current) { nm.cancel(idFor(id)); posted.remove(id) }
        // The app is on screen: the person can see the prompt, so no alert (and any old one goes).
        if (MainActivity.visible) { cancelNeeds(); return }
        for ((id, n) in current) if (posted.add(id)) {
            val open = Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(EXTRA_SESSION_ID, id)
            // A distinct request code per session, or Android would reuse the first session's intent for all.
            val tap = PendingIntent.getActivity(context, idFor(id), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            nm.notify(idFor(id), Notification.Builder(context, NEEDS_CHANNEL)
                .setContentTitle("${n.optString("name").ifBlank { "A session" }} needs you")
                .setContentText(n.optString("text"))
                .setStyle(Notification.BigTextStyle().bigText(n.optString("text")))
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setContentIntent(tap)
                .setAutoCancel(true)
                .build())
        }
    }

    /** The app came on screen. */
    @Synchronized
    fun cancelNeeds() {
        for (id in posted) nm.cancel(idFor(id))
        posted.clear()
    }

    private fun idFor(sessionId: String) = 1000 + (sessionId.hashCode() and 0xFFFFF)

    companion object {
        const val ONGOING_ID = 1 // BackendService's foreground notification
        const val NEEDS_CHANNEL = "needs_you"
        /** Set on the intent that opens the app from a "needs you" alert; MainActivity/the page should switch to this session. */
        const val EXTRA_SESSION_ID = "com.youcoded.app.SESSION_ID"
    }
}
