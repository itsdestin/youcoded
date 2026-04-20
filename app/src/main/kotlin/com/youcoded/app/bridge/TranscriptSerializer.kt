package com.youcoded.app.bridge

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

    fun assistantText(
        sessionId: String,
        uuid: String,
        timestamp: Long,
        text: String,
        model: String? = null,
        // Subagent threading: included when this text originated inside a subagent turn
        parentAgentToolUseId: String? = null,
        agentId: String? = null,
    ): JSONObject {
        return build("assistant-text", sessionId, uuid, timestamp, JSONObject().apply {
            put("text", text)
            if (model != null) put("model", model)
            if (parentAgentToolUseId != null) put("parentAgentToolUseId", parentAgentToolUseId)
            if (agentId != null) put("agentId", agentId)
        })
    }

    fun toolUse(
        sessionId: String,
        uuid: String,
        timestamp: Long,
        toolUseId: String,
        toolName: String,
        toolInput: JSONObject,
        // Subagent threading: included when this tool use originated inside a subagent turn
        parentAgentToolUseId: String? = null,
        agentId: String? = null,
    ): JSONObject {
        return build("tool-use", sessionId, uuid, timestamp, JSONObject().apply {
            put("toolUseId", toolUseId)
            put("toolName", toolName)
            put("toolInput", toolInput)
            if (parentAgentToolUseId != null) put("parentAgentToolUseId", parentAgentToolUseId)
            if (agentId != null) put("agentId", agentId)
        })
    }

    fun toolResult(
        sessionId: String,
        uuid: String,
        timestamp: Long,
        toolUseId: String,
        result: String,
        isError: Boolean,
        // Subagent threading: included when this result originated inside a subagent turn
        parentAgentToolUseId: String? = null,
        agentId: String? = null,
    ): JSONObject {
        return build("tool-result", sessionId, uuid, timestamp, JSONObject().apply {
            put("toolUseId", toolUseId)
            put("toolResult", result)
            put("isError", isError)
            if (parentAgentToolUseId != null) put("parentAgentToolUseId", parentAgentToolUseId)
            if (agentId != null) put("agentId", agentId)
        })
    }

    fun turnComplete(sessionId: String, uuid: String, timestamp: Long): JSONObject {
        return build("turn-complete", sessionId, uuid, timestamp, JSONObject())
    }

    fun compactSummary(sessionId: String, uuid: String, timestamp: Long): JSONObject {
        return build("compact-summary", sessionId, uuid, timestamp, JSONObject())
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
