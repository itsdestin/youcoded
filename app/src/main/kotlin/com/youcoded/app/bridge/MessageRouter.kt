package com.youcoded.app.bridge

import org.json.JSONArray
import org.json.JSONObject

/** Protocol parser/builder for the WebSocket bridge. */
object MessageRouter {
    data class ParsedMessage(
        val type: String,
        val id: String?,
        val payload: JSONObject
    )

    fun parseMessage(raw: String): ParsedMessage? {
        return try {
            val json = JSONObject(raw)
            ParsedMessage(
                type = json.getString("type"),
                id = json.optString("id", null),
                payload = json.optJSONObject("payload") ?: JSONObject()
            )
        } catch (e: Exception) {
            null
        }
    }

    // WHY (one-core R4-1, seam S7): the version of the handshake and what this screen can do, so the shared UI asks
    // `capabilities.x` instead of guessing from "am I Android". The VALUES mirror ANDROID_LOCAL_CAPABILITIES in
    // desktop/src/shared/capabilities.ts (tests/capabilities-parity.test.ts reads this file to keep them equal): the
    // WebView here talks to this device's own runtime, which has the terminal buffer and sends raw terminal bytes, and
    // has no windows, no git, no engine for the app's own assistant. Minimal on purpose: A3 deletes this file's role.
    const val PROTOCOL_VERSION = 1

    fun buildCapabilities(): JSONObject {
        return JSONObject().apply {
            put("nativeWindows", false)
            put("openInOs", false)
            put("openExternal", false)
            put("git", false)
            put("themePictures", true)
            put("themeRigs", false)
            put("terminalTransport", "raw-bytes")
            put("terminalScreenRead", true)
            put("nativeSessions", false)
            put("buddy", false)
            put("projectWrites", true)
            put("contentSearch", false)
            put("liveHandoff", false)
        }
    }

    fun buildAuthOkResponse(platform: String): JSONObject {
        return JSONObject().apply {
            put("type", "auth:ok")
            put("token", java.util.UUID.randomUUID().toString())
            put("platform", platform)
            put("protocolVersion", PROTOCOL_VERSION)
            put("capabilities", buildCapabilities())
        }
    }

    fun buildSessionInfo(
        id: String,
        name: String,
        cwd: String,
        status: String,
        permissionMode: String,
        skipPermissions: Boolean,
        createdAt: Long = 0L,
        model: String? = null,
        awaitingStart: Boolean = false,
    ): JSONObject {
        return JSONObject().apply {
            put("id", id)
            put("name", name)
            put("cwd", cwd)
            put("status", status)
            put("permissionMode", permissionMode)
            put("skipPermissions", skipPermissions)
            put("createdAt", createdAt)
            // Parity with desktop SessionInfo.model — lets the React status-bar model
            // switcher show the correct alias immediately on session:created, instead
            // of falling back to 'sonnet' until the first assistant-text transcript
            // event reconciles it (App.tsx line 520 reads info.model).
            if (model != null) put("model", model)
            // Desktop parity (SessionInfo.awaitingStart): still on its startup
            // dialogs — a WebView that reloads must not treat it as running.
            if (awaitingStart) put("awaitingStart", true)
        }
    }

    fun buildSessionListResponse(sessions: List<JSONObject>): JSONObject {
        val array = JSONArray()
        sessions.forEach { array.put(it) }
        return JSONObject().apply {
            put("sessions", array)
        }
    }

    fun buildErrorResponse(error: String): JSONObject {
        return JSONObject().apply {
            put("error", error)
        }
    }

    /**
     * The refusal shape the React shim understands: `unsupported: true` makes it REJECT
     * the caller's promise and show one plain-language notice per feature. WHY a
     * separate builder: buildErrorResponse's bare `{error}` is not a refusal to the
     * shim — it RESOLVES as an ordinary value, so a channel the phone had no handler
     * for handed callers a junk object (Project View crashed on a "status" with no
     * spaces; the chat reducer threw on every launch). Found 2026-09-10; the browser
     * side had the same fix months earlier. Used by the dispatcher's catch-all.
     */
    fun buildUnsupportedResponse(error: String): JSONObject {
        return JSONObject().apply {
            put("ok", false)
            put("unsupported", true)
            put("error", error)
        }
    }
}
