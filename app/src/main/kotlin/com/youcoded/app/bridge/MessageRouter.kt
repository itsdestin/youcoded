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

    fun buildAuthOkResponse(platform: String): JSONObject {
        return JSONObject().apply {
            put("type", "auth:ok")
            put("token", java.util.UUID.randomUUID().toString())
            put("platform", platform)
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
}
