package com.destin.code.bridge

import org.json.JSONArray
import org.json.JSONObject

/**
 * Converts HookEvent data into the JSON envelope format the desktop React app
 * expects on its `hook:event` WebSocket channel.
 *
 * Every method returns:
 *   { type: "hook:event", payload: { type, sessionId, payload: { ... } } }
 */
object HookSerializer {

    fun permissionRequest(
        sessionId: String,
        requestId: String,
        toolName: String,
        toolInput: JSONObject,
        suggestions: List<String>,
    ): JSONObject {
        val inner = JSONObject().apply {
            put("tool_name", toolName)
            put("tool_input", toolInput)
            put("_requestId", requestId)
            put("permission_suggestions", JSONArray().apply {
                suggestions.forEach { put(it) }
            })
        }
        return envelope("PermissionRequest", sessionId, inner)
    }

    fun permissionExpired(sessionId: String, requestId: String): JSONObject {
        val inner = JSONObject().apply {
            put("_requestId", requestId)
        }
        return envelope("PermissionExpired", sessionId, inner)
    }

    /** Notification — best-guess format; desktop may not send this. */
    fun notification(sessionId: String, message: String): JSONObject {
        val inner = JSONObject().apply {
            put("message", message)
        }
        return envelope("Notification", sessionId, inner)
    }

    private fun envelope(type: String, sessionId: String, inner: JSONObject): JSONObject =
        JSONObject().apply {
            put("type", "hook:event")
            put("payload", JSONObject().apply {
                put("type", type)
                put("sessionId", sessionId)
                put("payload", inner)
            })
        }
}
