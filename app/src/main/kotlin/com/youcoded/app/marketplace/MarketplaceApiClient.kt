package com.youcoded.app.marketplace

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/**
 * Kotlin mirror of the TS MarketplaceApiClient in desktop/src/renderer/state/marketplace-api-client.ts.
 * Calls the YouCoded Cloudflare Worker backend.
 *
 * WHY OkHttp: already a project dependency (for the WebSocket bridge server), so no new deps needed.
 * WHY suspend: all callers live in SessionService's serviceScope (Dispatchers.IO), consistent with
 * how other blocking I/O in that service is dispatched.
 */

private const val TAG = "MarketplaceApiClient"
private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

/** Mirrors the TS ApiResult<T> discriminated union — returned as JSON to the React renderer. */
sealed class ApiResult<out T> {
    data class Ok<T>(val value: T) : ApiResult<T>()
    data class Err(val status: Int, val message: String) : ApiResult<Nothing>()

    /** Serialize to a JSONObject matching the TS shape: { ok, value } or { ok, status, message } */
    fun toJson(serializeValue: (T) -> Any? = { v -> v }): JSONObject = when (this) {
        is Ok -> JSONObject().apply {
            put("ok", true)
            val v = serializeValue(value)
            when (v) {
                null               -> put("value", JSONObject.NULL)
                is JSONObject      -> put("value", v)
                is Boolean         -> put("value", v)
                is Int             -> put("value", v)
                is String          -> put("value", v)
                else               -> put("value", v.toString())
            }
        }
        is Err -> JSONObject().apply {
            put("ok", false)
            put("status", status)
            put("message", message)
        }
    }
}

class MarketplaceApiClient(
    private val store: MarketplaceAuthStore,
    private val host: String = "https://wecoded-marketplace-api.destinj101.workers.dev",
) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    // ── Internal helpers ─────────────────────────────────────────────────────

    private suspend fun request(
        path: String,
        method: String = "GET",
        body: JSONObject? = null,
        auth: Boolean = false,
    ): Pair<Int, JSONObject> = withContext(Dispatchers.IO) {
        val reqBody = body?.toString()?.toRequestBody(JSON_MEDIA_TYPE)
        val builder = Request.Builder()
            .url("$host$path")
            .method(method, reqBody ?: if (method == "GET") null else "{}".toRequestBody(JSON_MEDIA_TYPE))
            .addHeader("Content-Type", "application/json")

        if (auth) {
            val token = store.getToken()
            // WHY: we don't log the token value — only whether it's present
            if (token == null) {
                return@withContext Pair(401, JSONObject().put("message", "not signed in"))
            }
            builder.addHeader("Authorization", "Bearer $token")
        }

        try {
            val resp = http.newCall(builder.build()).execute()
            val code = resp.code
            val raw = resp.body?.string() ?: "{}"
            // 202 Accepted = poll-pending — return synthetic pending body
            val json = if (code == 202) {
                JSONObject().put("status", "pending")
            } else {
                try { JSONObject(raw) } catch (_: Exception) { JSONObject() }
            }
            Pair(code, json)
        } catch (e: Exception) {
            Log.w(TAG, "HTTP $method $path failed: ${e.message}")
            Pair(0, JSONObject().put("message", e.message ?: "network error"))
        }
    }

    private fun errFromResponse(code: Int, body: JSONObject): ApiResult.Err =
        ApiResult.Err(code, body.optString("message", "HTTP $code"))

    // ── Public API (mirrors TS client method by method) ──────────────────────

    /** GET /stats — no auth required */
    suspend fun getStats(): ApiResult<JSONObject> {
        val (code, body) = request("/stats")
        return if (code == 200) ApiResult.Ok(body) else errFromResponse(code, body)
    }

    /** POST /auth/github/start — initiates device-code OAuth flow */
    suspend fun authStart(): ApiResult<JSONObject> {
        val (code, body) = request("/auth/github/start", method = "POST")
        return if (code == 200) ApiResult.Ok(body) else errFromResponse(code, body)
    }

    /**
     * POST /auth/github/poll — polls for token.
     * Returns either { status: "pending" } (202) or { status: "complete", token: "..." } (200).
     * WHY: on complete, the caller in SessionService saves the token to the store.
     */
    suspend fun authPoll(deviceCode: String): ApiResult<JSONObject> {
        val (code, body) = request(
            "/auth/github/poll",
            method = "POST",
            body = JSONObject().put("device_code", deviceCode),
        )
        return if (code == 200 || code == 202) ApiResult.Ok(body) else errFromResponse(code, body)
    }

    /** POST /installs — records an install. Requires token. */
    suspend fun postInstall(pluginId: String): ApiResult<Unit> {
        val (code, body) = request(
            "/installs",
            method = "POST",
            body = JSONObject().put("plugin_id", pluginId),
            auth = true,
        )
        return if (code in 200..299) ApiResult.Ok(Unit) else errFromResponse(code, body)
    }

    /** POST /ratings — submit or update a rating. Requires token. */
    suspend fun postRating(
        pluginId: String,
        stars: Int,
        reviewText: String?,
    ): ApiResult<JSONObject> {
        val payload = JSONObject().apply {
            put("plugin_id", pluginId)
            put("stars", stars)
            if (!reviewText.isNullOrEmpty()) put("review_text", reviewText)
        }
        val (code, body) = request("/ratings", method = "POST", body = payload, auth = true)
        return if (code in 200..299) ApiResult.Ok(body) else errFromResponse(code, body)
    }

    /** DELETE /ratings/:pluginId — remove the caller's rating. Requires token. */
    suspend fun deleteRating(pluginId: String): ApiResult<Unit> {
        val encoded = URLEncoder.encode(pluginId, "UTF-8")
        val (code, body) = request("/ratings/$encoded", method = "DELETE", auth = true)
        return if (code in 200..299) ApiResult.Ok(Unit) else errFromResponse(code, body)
    }

    /** POST /themes/:themeId/like — toggle like. Requires token. */
    suspend fun toggleThemeLike(themeId: String): ApiResult<JSONObject> {
        val encoded = URLEncoder.encode(themeId, "UTF-8")
        val (code, body) = request("/themes/$encoded/like", method = "POST", auth = true)
        return if (code in 200..299) ApiResult.Ok(body) else errFromResponse(code, body)
    }

    /** POST /reports — report a rating. Requires token. */
    suspend fun postReport(
        ratingUserId: String,
        ratingPluginId: String,
        reason: String?,
    ): ApiResult<Unit> {
        val payload = JSONObject().apply {
            put("rating_user_id", ratingUserId)
            put("rating_plugin_id", ratingPluginId)
            if (!reason.isNullOrEmpty()) put("reason", reason)
        }
        val (code, body) = request("/reports", method = "POST", body = payload, auth = true)
        return if (code in 200..299) ApiResult.Ok(Unit) else errFromResponse(code, body)
    }
}
