package com.youcoded.app.parser

import org.json.JSONObject

sealed class HookEvent {
    /** Common fields available on all hook events */
    abstract val sessionId: String
    abstract val hookEventName: String

    data class PreToolUse(
        override val sessionId: String,
        override val hookEventName: String,
        val toolName: String,
        val toolInput: JSONObject,
        val toolUseId: String,
    ) : HookEvent()

    data class PostToolUse(
        override val sessionId: String,
        override val hookEventName: String,
        val toolName: String,
        val toolInput: JSONObject,
        val toolResponse: JSONObject,
        val toolUseId: String,
    ) : HookEvent()

    data class PostToolUseFailure(
        override val sessionId: String,
        override val hookEventName: String,
        val toolName: String,
        val toolInput: JSONObject,
        val toolResponse: JSONObject,
        val toolUseId: String,
    ) : HookEvent()

    data class Stop(
        override val sessionId: String,
        override val hookEventName: String,
        val lastAssistantMessage: String,
    ) : HookEvent()

    data class Notification(
        override val sessionId: String,
        override val hookEventName: String,
        val message: String,
        val title: String?,
        val notificationType: String?,
    ) : HookEvent()

    data class PermissionRequest(
        override val sessionId: String,
        override val hookEventName: String,
        val toolName: String,
        val toolInput: JSONObject,
        val permissionSuggestions: org.json.JSONArray?,
        val requestId: String,
        /** Claude Code's OWN live permission mode ('default'|'acceptEdits'|
         *  'bypassPermissions'|'plan'|'dontAsk'|'auto') — part of every hook
         *  payload's common base shape (desktop mirror: main.ts reads
         *  `event.payload.permission_mode`, docs/cc-dependencies.md's "hook
         *  payload permission_mode field" entry). Optional by the CLI's own
         *  schema — absent reads as null, which
         *  DocCommentsPermission.shouldAutoApproveDocComment treats as "don't
         *  know, don't approve." hook-relay-blocking.js forwards the CLI's
         *  whole hook JSON verbatim (only adding mobileSessionId/claudePid),
         *  so this field was already reaching EventBridge unread until now. */
        val permissionMode: String?,
    ) : HookEvent()

    /** Emitted when a held PermissionRequest ends without a delivered user
     *  decision. `reason` says why (2026-07-30 permission-ask-timeout spec §2,
     *  same values as desktop hook-relay.ts): "app-timeout" (our own 2h hold
     *  fired and a deny WAS delivered), "delivery-failed" (respond()'s write
     *  threw), "hook-closed" (the relay died or Claude Code killed the hook —
     *  Claude Code's own menu may still be on screen, so React keeps the card),
     *  or null (older producers; React resolves the card). */
    data class PermissionExpired(
        override val sessionId: String,
        override val hookEventName: String,
        val requestId: String,
        val reason: String? = null,
    ) : HookEvent()

    companion object {
        fun fromJson(json: String): HookEvent? {
            return try {
                val obj = JSONObject(json)
                val sessionId = obj.optString("session_id", "")
                val eventName = obj.optString("hook_event_name", "")

                when (eventName) {
                    "PreToolUse" -> PreToolUse(
                        sessionId = sessionId,
                        hookEventName = eventName,
                        toolName = obj.optString("tool_name", ""),
                        toolInput = obj.optJSONObject("tool_input") ?: JSONObject(),
                        toolUseId = obj.optString("tool_use_id", ""),
                    )
                    "PostToolUse" -> PostToolUse(
                        sessionId = sessionId,
                        hookEventName = eventName,
                        toolName = obj.optString("tool_name", ""),
                        toolInput = obj.optJSONObject("tool_input") ?: JSONObject(),
                        toolResponse = obj.optJSONObject("tool_response") ?: JSONObject(),
                        toolUseId = obj.optString("tool_use_id", ""),
                    )
                    "PostToolUseFailure" -> PostToolUseFailure(
                        sessionId = sessionId,
                        hookEventName = eventName,
                        toolName = obj.optString("tool_name", ""),
                        toolInput = obj.optJSONObject("tool_input") ?: JSONObject(),
                        toolResponse = obj.optJSONObject("tool_response") ?: JSONObject(),
                        toolUseId = obj.optString("tool_use_id", ""),
                    )
                    "Stop" -> {
                        // Try multiple field names — Claude Code versions may differ
                        val assistantMsg = TranscriptWatcher.stripSystemTags(
                            obj.optString("last_assistant_message", "")
                                .ifBlank { obj.optString("message", "") }
                                .ifBlank { obj.optString("response", "") }
                                .ifBlank { obj.optString("assistant_message", "") }
                        )
                        if (assistantMsg.isBlank()) {
                            android.util.Log.w("HookEvent", "Stop event has no assistant message")
                        }
                        Stop(
                            sessionId = sessionId,
                            hookEventName = eventName,
                            lastAssistantMessage = assistantMsg,
                        )
                    }
                    "Notification" -> Notification(
                        sessionId = sessionId,
                        hookEventName = eventName,
                        message = obj.optString("message", ""),
                        title = if (obj.has("title")) obj.getString("title") else null,
                        notificationType = if (obj.has("notification_type")) obj.getString("notification_type") else null,
                    )
                    "PermissionRequest" -> PermissionRequest(
                        sessionId = sessionId,
                        hookEventName = eventName,
                        toolName = obj.optString("tool_name", ""),
                        toolInput = obj.optJSONObject("tool_input") ?: JSONObject(),
                        permissionSuggestions = if (obj.has("permission_suggestions"))
                            obj.optJSONArray("permission_suggestions") else null,
                        requestId = obj.optString("_requestId", ""),
                        permissionMode = if (obj.has("permission_mode") && !obj.isNull("permission_mode"))
                            obj.optString("permission_mode") else null,
                    )
                    else -> null
                }
            } catch (e: Exception) {
                null
            }
        }
    }
}
