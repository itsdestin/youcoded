// Mirror of desktop/src/main/analytics-service.ts. Posts /app/heartbeat once
// per UTC day with a HMAC of (machine_id || platform), computed locally.
// Fire-and-forget — network failures do not throw and do not mutate state.
//
// Privacy: the raw machine_id never leaves the device. See the design
// spec at docs/superpowers/specs/2026-05-01-device-id-analytics-design.md
// for the threat model.
package com.youcoded.app.analytics

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.TimeZone
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

data class AnalyticsState(
    val optIn: Boolean = true,
    val lastPingedDate: String = "",
    val fallbackDeviceId: String? = null,
)

class AnalyticsService(
    private val apiBase: String,
    private val homeDir: File,
    private val appVersion: String,
    private val http: OkHttpClient = OkHttpClient(),
    // Default reader fails loudly — production callers MUST inject a real reader
    // (typically a Settings.Secure.ANDROID_ID lookup; see SessionService.kt).
    private val machineIdReader: () -> String = ::defaultReaderUnimplemented,
) {
    private val stateFile get() = File(homeDir, ".claude/youcoded-analytics.json")

    fun runOnLaunch() {
        var state = readState()
        if (!state.optIn) return

        val today = todayUtc()
        if (state.lastPingedDate == today) return

        val (newState, hash) = computeDeviceIdHash(state)
        state = newState

        val payload = JSONObject().apply {
            put("deviceIdHash", hash)
            put("appVersion", appVersion)
            put("platform", "android")
            put("os", "")
        }
        if (postEvent("/app/heartbeat", payload)) {
            state = state.copy(lastPingedDate = today)
            writeState(state)
        }
    }

    fun getOptIn(): Boolean = readState().optIn

    fun setOptIn(value: Boolean) {
        val state = readState()
        writeState(state.copy(optIn = value))
    }

    // Internal helper for tests.
    fun debugReadState(): AnalyticsState = readState()

    private fun computeDeviceIdHash(state: AnalyticsState): Pair<AnalyticsState, String> {
        var current = state
        var raw = try { machineIdReader() } catch (_: Exception) { "" }
        if (raw.length < 8) {
            if (current.fallbackDeviceId == null) {
                current = current.copy(fallbackDeviceId = UUID.randomUUID().toString())
                writeState(current)
            }
            raw = "fallback:${current.fallbackDeviceId}"
        }
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(ANALYTICS_SALT.toByteArray(), "HmacSHA256"))
        val digest = mac.doFinal("$raw|android".toByteArray())
        val hash = digest.joinToString("") { "%02x".format(it) }
        return current to hash
    }

    private fun readState(): AnalyticsState {
        if (!stateFile.exists()) return AnalyticsState()
        return try {
            val json = JSONObject(stateFile.readText())
            // Drop legacy installId / installReported silently; they're meaningless
            // post-cutover and the file gets rewritten on the next writeState().
            AnalyticsState(
                optIn = json.optBoolean("optIn", true),
                lastPingedDate = json.optString("lastPingedDate", ""),
                fallbackDeviceId = if (json.has("fallbackDeviceId") && !json.isNull("fallbackDeviceId"))
                    json.getString("fallbackDeviceId") else null,
            )
        } catch (_: Exception) {
            AnalyticsState()
        }
    }

    private fun writeState(state: AnalyticsState) {
        stateFile.parentFile?.mkdirs()
        val json = JSONObject().apply {
            put("optIn", state.optIn)
            put("lastPingedDate", state.lastPingedDate)
            if (state.fallbackDeviceId != null) put("fallbackDeviceId", state.fallbackDeviceId)
        }
        stateFile.writeText(json.toString(2))
    }

    private fun postEvent(path: String, body: JSONObject): Boolean {
        return try {
            val req = Request.Builder()
                .url(apiBase + path)
                .post(body.toString().toRequestBody("application/json".toMediaType()))
                .build()
            http.newCall(req).execute().use { it.isSuccessful }
        } catch (_: Exception) {
            false
        }
    }

    companion object {
        // WHY a cap: a sleeping phone pauses the countdown, so one wait until
        // midnight could run hours late. Each wake-up only looks at the clock;
        // runOnLaunch() sends at most once per UTC day. Mirrors desktop's
        // msUntilNextCheck in analytics-service.ts.
        private const val MAX_WAIT_MS = 3L * 60 * 60 * 1000
        private const val DAY_MS = 24L * 60 * 60 * 1000

        fun todayUtc(): String {
            val fmt = SimpleDateFormat("yyyy-MM-dd").apply { timeZone = TimeZone.getTimeZone("UTC") }
            return fmt.format(Date())
        }

        // Milliseconds until one second past the next UTC midnight, capped at 3 hours.
        // Epoch milliseconds count UTC days exactly, so no calendar is needed.
        fun msUntilNextCheck(nowMs: Long): Long {
            val nextMidnight = (nowMs / DAY_MS + 1) * DAY_MS + 1000
            return minOf(nextMidnight - nowMs, MAX_WAIT_MS)
        }
    }
}

// Sentinel for the default constructor argument. Production callers MUST
// inject a real reader at construction time (see SessionService.kt where
// AnalyticsService is instantiated with a Settings.Secure.ANDROID_ID lambda).
private fun defaultReaderUnimplemented(): String {
    throw IllegalStateException(
        "AnalyticsService.machineIdReader was not injected. " +
        "Pass a Settings.Secure.ANDROID_ID lambda from your Android Context."
    )
}
