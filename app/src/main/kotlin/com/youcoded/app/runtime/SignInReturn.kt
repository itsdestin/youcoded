package com.youcoded.app.runtime

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import com.youcoded.app.MainActivity

/**
 * Getting the person back to YouCoded after they sign in on the web (Claude, ChatGPT).
 *
 * WHY (2026-11-01 phone test): sign-in opened Chrome, and when it finished the person was left on "You can
 * close this window". Two parts:
 *  1. [openInTab]: the sign-in page opens as a Custom Tab, which Android keeps inside YouCoded's own task. That
 *     matters because Android 10+ only lets an app jump to its own screen from the background when it already has
 *     a screen in the front task; a separate Chrome window gives it none.
 *  2. [bringBack]: when the backend reports the sign-in finished, MainActivity is brought forward (clearing the
 *     tab above it). Android can still refuse (it varies by version and maker), so if YouCoded is not on screen
 *     a moment later a "Signed in" notification is shown; tapping it is always allowed to open the app.
 */
object SignInReturn {
    private const val CHANNEL_ID = "sign_in_return"
    private const val NOTIFICATION_ID = 4101

    /** Sign-in pages worth keeping inside the app. Other links still go to the person's browser as before. */
    fun isSignInLink(url: String): Boolean {
        val u = Uri.parse(url)
        val host = (u.host ?: "").lowercase()
        val known = listOf("claude.ai", "claude.com", "anthropic.com", "openai.com", "chatgpt.com")
        return known.any { host == it || host.endsWith(".$it") } && (u.getQueryParameter("redirect_uri") != null || u.path?.contains("oauth") == true)
    }

    /** Show [url] as a Custom Tab on top of [activity]. Works with no extra library: the "session" extra is what marks an
     *  ACTION_VIEW as a Custom Tab request (Chrome and other browsers fall back to a normal page if they don't support it). */
    fun openInTab(activity: android.app.Activity, url: String) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        val extras = Bundle().apply { putBinder("android.support.customtabs.extra.SESSION", null) }
        intent.putExtras(extras)
        activity.startActivity(intent)
    }

    fun bringBack(context: Context) {
        val back = Intent(context, MainActivity::class.java).addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or
                Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
        )
        runCatching { context.startActivity(back) }
        Handler(Looper.getMainLooper()).postDelayed({
            if (MainActivity.visible) return@postDelayed
            val nm = context.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Sign-in finished", NotificationManager.IMPORTANCE_HIGH))
            val open = PendingIntent.getActivity(context, 0, back, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            nm.notify(NOTIFICATION_ID, Notification.Builder(context, CHANNEL_ID)
                .setContentTitle("Signed in")
                .setContentText("Tap to go back to YouCoded.")
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentIntent(open).setAutoCancel(true).build())
        }, 1500)
    }
}
