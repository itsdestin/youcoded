package com.destin.code.bridge

import org.json.JSONObject

/**
 * Converts TranscriptEvent data into the JSON payload the desktop
 * React app expects on its `transcript:event` WebSocket channel.
 *
 * Every method returns the inner payload:
 *   { type, sessionId, uuid, timestamp, data: { ... } }
 *
 * The outer `{ type: "transcript:event", payload: ... }` wrapper is added
 * by the broadcast call in ManagedSession, NOT here.
 */
object TranscriptSerializer {

    fun userMessage(sessionId: String, uuid: String, timestamp: Long, text: String): JSONObject {
        return build("user-message", sessionId, uuid, timestamp, JSONObject().apply {
            put("text", text)
        })
    }

    fun assistantText(sessionId: String, uuid: String, timestamp: Long, text: String): JSONObject {
        return build("assistant-text", sessionId, uuid, timestamp, JSONObject().apply {
            put("text", text)
        })
    }

    fun toolUse(
        sessionId: String,
        uuid: String,
        timestamp: Long,
        toolUseId: String,
        toolName: String,
        toolInput: JSONObject,
    ): JSONObject {
        return build("tool-use", sessionId, uuid, timestamp, JSONObject().apply {
            put("toolUseId", toolUseId)
            put("toolName", toolName)
            put("toolInput", toolInput)
        })
    }

    fun toolResult(
        sessionId: String,
        uuid: String,
        timestamp: Long,
        toolUseId: String,
        result: String,
        isError: Boolean,
    ): JSONObject {
        return build("tool-result", sessionId, uuid, timestamp, JSONObject().apply {
            put("toolUseId", toolUseId)
            put("toolResult", result)
            put("isError", isError)
        })
    }

    fun turnComplete(sessionId: String, uuid: String, timestamp: Long): JSONObject {
        return build("turn-complete", sessionId, uuid, timestamp, JSONObject())
    }

    /** streamingText is a custom event — not part of the desktop protocol. Keep flat. */
    fun streamingText(sessionId: String, text: String): JSONObject =
        JSONObject().apply {
            put("type", "streaming-text")
            put("sessionId", sessionId)
            put("text", text)
        }

    private fun build(
        type: String,
        sessionId: String,
        uuid: String,
        timestamp: Long,
        data: JSONObject,
    ): JSONObject = JSONObject().apply {
        put("type", type)
        put("sessionId", sessionId)
        put("uuid", uuid)
        put("timestamp", timestamp)
        put("data", data)
    }
}
