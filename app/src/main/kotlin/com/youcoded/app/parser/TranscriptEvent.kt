package com.youcoded.app.parser

import org.json.JSONObject

/**
 * Events parsed from Claude Code's JSONL transcript files.
 * Mirrors the desktop's TranscriptEvent types from shared/types.ts.
 *
 * The transcript file is the primary source of chat content (user messages,
 * assistant text, tool invocations, tool results). Hook events (EventBridge)
 * remain the source for permission approval flow only.
 */
sealed class TranscriptEvent {
    /** Desktop session ID (used for routing) */
    abstract val sessionId: String
    /** Unique line ID from the JSONL — used for deduplication */
    abstract val uuid: String
    abstract val timestamp: Long

    /** User sent a message (has promptId, no tool_result in content) */
    data class UserMessage(
        override val sessionId: String,
        override val uuid: String,
        override val timestamp: Long,
        val text: String,
    ) : TranscriptEvent()

    /** Assistant produced text output */
    data class AssistantText(
        override val sessionId: String,
        override val uuid: String,
        override val timestamp: Long,
        val text: String,
        val model: String? = null,
        // Subagent threading: set when this output originated inside a Tool (subagent) call
        val parentAgentToolUseId: String? = null,
        val agentId: String? = null,
    ) : TranscriptEvent()

    /** Assistant invoked a tool */
    data class ToolUse(
        override val sessionId: String,
        override val uuid: String,
        override val timestamp: Long,
        val toolUseId: String,
        val toolName: String,
        val toolInput: JSONObject,
        // Subagent threading: set when this tool use originated inside a subagent turn
        val parentAgentToolUseId: String? = null,
        val agentId: String? = null,
    ) : TranscriptEvent()

    /** Tool execution produced a result (user-type line with tool_result content) */
    data class ToolResult(
        override val sessionId: String,
        override val uuid: String,
        override val timestamp: Long,
        val toolUseId: String,
        val result: String,
        val isError: Boolean,
        // Subagent threading: set when this result originated inside a subagent turn
        val parentAgentToolUseId: String? = null,
        val agentId: String? = null,
    ) : TranscriptEvent()

    /** Assistant turn completed (stop_reason == "end_turn") */
    data class TurnComplete(
        override val sessionId: String,
        override val uuid: String,
        override val timestamp: Long,
    ) : TranscriptEvent()

    /** Streaming assistant text from progress events */
    data class StreamingText(
        override val sessionId: String,
        val text: String,
        override val uuid: String = "",
        override val timestamp: Long = 0L,
    ) : TranscriptEvent()

    /** Canonical compaction-complete signal: emitted when Claude Code writes
     *  a {type:"user", isCompactSummary:true} entry. Covers both in-session
     *  /compact (appends to same JSONL, so shrink cannot fire) and
     *  resume-from-summary (first entry of a new JSONL). */
    data class CompactSummary(
        override val sessionId: String,
        override val uuid: String,
        override val timestamp: Long,
    ) : TranscriptEvent()
}
