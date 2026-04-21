package com.youcoded.app.runtime

import android.util.Log
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Android-side announcement fetcher. Mirror of desktop's
 * `announcement-service.ts`. Fetches youcoded/announcements.txt once per
 * hour and writes ~/.claude/.announcement-cache.json so that:
 *
 *   - the terminal statusline.sh can render the ★ announcement line, AND
 *   - SessionService.startStatusBroadcast() can fold the cache into
 *     status:data for the React status-bar widget.
 *
 * Lifecycle rules (must match desktop):
 *   - Fetch-time expiry filter: if the first non-comment line has a
 *     YYYY-MM-DD prefix that is strictly less than today (device local
 *     date), treat it as empty. Already-stale content never reaches cache.
 *   - Clear propagation: when the remote file is empty (after comment
 *     stripping), write { message: null, fetched_at } so readers can
 *     distinguish "explicitly cleared" from "no cache yet."
 *   - Offline tolerance: any exception during fetch leaves the existing
 *     cache untouched.
 *
 * Launch from SessionService.onCreate() via startAnnouncementService(homeDir).
 */
class AnnouncementService(private val homeDir: File) {

    private var timer: java.util.Timer? = null

    fun start() {
        stop()
        timer = java.util.Timer("announcement-fetch", true).apply {
            scheduleAtFixedRate(object : java.util.TimerTask() {
                override fun run() {
                    try {
                        fetchOnce()
                    } catch (e: Exception) {
                        Log.w(TAG, "fetch threw: ${e.message}")
                    }
                }
            }, INITIAL_DELAY_MS, REFRESH_MS)
        }
    }

    fun stop() {
        timer?.cancel()
        timer = null
    }

    private fun fetchOnce() {
        val text: String = try {
            val conn = (URL(URL_STR).openConnection() as HttpURLConnection).apply {
                connectTimeout = 10_000
                readTimeout = 10_000
                requestMethod = "GET"
            }
            try {
                if (conn.responseCode !in 200..299) return
                conn.inputStream.bufferedReader().use { it.readText() }
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            // Offline / DNS / network: leave existing cache alone.
            return
        }

        val parsed: ParsedAnnouncement? = parseAnnouncement(text)

        val nowIso = iso8601Now()
        val json = JSONObject()
        if (parsed != null) {
            json.put("message", parsed.message)
            json.put("fetched_at", nowIso)
            if (parsed.expires != null) json.put("expires", parsed.expires)
        } else {
            // Explicit clear: message: null lets StatusBar's isExpired gate
            // hide the pill even if the on-disk cache was previously
            // populated with an unrelated entry.
            json.put("message", JSONObject.NULL)
            json.put("fetched_at", nowIso)
        }

        writeAtomic(json.toString(2))
    }

    private fun writeAtomic(contents: String) {
        val claudeDir = File(homeDir, ".claude").apply { mkdirs() }
        val cache = File(claudeDir, ".announcement-cache.json")
        val tmp = File(claudeDir, ".announcement-cache.json.tmp")
        try {
            tmp.writeText(contents, Charsets.UTF_8)
            if (!tmp.renameTo(cache)) {
                // Rename can fail if dest is on a different mount; fall back
                // to copy + delete to preserve atomic-ish behavior.
                cache.writeText(contents, Charsets.UTF_8)
                tmp.delete()
            }
        } catch (e: Exception) {
            try { tmp.delete() } catch (_: Exception) {}
            Log.w(TAG, "cache write failed: ${e.message}")
        }
    }

    companion object {
        private const val TAG = "AnnouncementService"
        private const val URL_STR =
            "https://raw.githubusercontent.com/itsdestin/youcoded/master/announcements.txt"
        private const val INITIAL_DELAY_MS = 5_000L
        private const val REFRESH_MS = 60L * 60L * 1000L // 1 hour

        data class ParsedAnnouncement(val message: String, val expires: String?)

        // Pure function; unit-testable in isolation if needed.
        fun parseAnnouncement(text: String): ParsedAnnouncement? {
            val datePrefix = Regex("""^(\d{4}-\d{2}-\d{2}): (.+)$""")
            for (raw in text.split('\n')) {
                val trimmed = raw.trim()
                if (trimmed.isEmpty() || trimmed.startsWith("#")) continue
                val m = datePrefix.matchEntire(trimmed)
                if (m != null) {
                    val expires = m.groupValues[1]
                    // Fetch-time expiry filter — mirrors desktop's isExpired.
                    if (expires < todayYYYYMMDD()) return null
                    return ParsedAnnouncement(m.groupValues[2].trim(), expires)
                }
                return ParsedAnnouncement(trimmed, null)
            }
            return null
        }

        private fun todayYYYYMMDD(): String {
            val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
                timeZone = TimeZone.getDefault()
            }
            return fmt.format(Date())
        }

        private fun iso8601Now(): String {
            val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
                timeZone = TimeZone.getTimeZone("UTC")
            }
            return fmt.format(Date())
        }
    }
}
