// Mirror of desktop/src/main/analytics-service.ts. Fires /app/install once per
// install_id and /app/heartbeat once per UTC day. Fire-and-forget — network
// failures do not throw and do not mutate state, so the next launch retries.
//
// Privacy: install_id is a random UUID, never tied to a user account or device
// identifier. Country is NOT sent from the client — the Worker reads it from
// the CF-IPCountry header.
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

data class AnalyticsState(
    val installId: String = "",
    val optIn: Boolean = true,
    val lastPingedDate: String = "",
    val installReported: Boolean = false,
)

class AnalyticsService(
    private val apiBase: String,
    private val homeDir: File,
    private val appVersion: String,
    private val http: OkHttpClient = OkHttpClient(),
) {
    private val stateFile get() = File(homeDir, ".claude/youcoded-analytics.json")

    fun runOnLaunch() {
        var state = readState()
        if (!state.optIn) return

        if (state.installId.isEmpty()) {
            state = state.copy(installId = UUID.randomUUID().toString(), installReported = false)
            writeState(state)
        }

        val payload = JSONObject().apply {
            put("installId", state.installId)
            put("appVersion", appVersion)
            put("platform", "android")
            put("os", "")
        }

        if (!state.installReported) {
            if (postEvent("/app/install", payload)) {
                state = state.copy(installReported = true)
                writeState(state)
            }
        }

        val today = todayUtc()
        if (state.lastPingedDate != today) {
            if (postEvent("/app/heartbeat", payload)) {
                state = state.copy(lastPingedDate = today)
                writeState(state)
            }
        }
    }

    fun getOptIn(): Boolean = readState().optIn

    fun setOptIn(value: Boolean) {
        var state = readState()
        if (state.installId.isEmpty()) state = state.copy(installId = UUID.randomUUID().toString())
        writeState(state.copy(optIn = value))
    }

    // Internal helper for tests.
    fun debugReadState(): AnalyticsState = readState()

    private fun readState(): AnalyticsState {
        if (!stateFile.exists()) return AnalyticsState()
        return try {
            val json = JSONObject(stateFile.readText())
            AnalyticsState(
                installId = json.optString("installId", ""),
                optIn = json.optBoolean("optIn", true),
                lastPingedDate = json.optString("lastPingedDate", ""),
                installReported = json.optBoolean("installReported", false),
            )
        } catch (_: Exception) {
            AnalyticsState()
        }
    }

    private fun writeState(state: AnalyticsState) {
        stateFile.parentFile?.mkdirs()
        val json = JSONObject().apply {
            put("installId", state.installId)
            put("optIn", state.optIn)
            put("lastPingedDate", state.lastPingedDate)
            put("installReported", state.installReported)
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
        fun todayUtc(): String {
            val fmt = SimpleDateFormat("yyyy-MM-dd").apply { timeZone = TimeZone.getTimeZone("UTC") }
            return fmt.format(Date())
        }
    }
}
