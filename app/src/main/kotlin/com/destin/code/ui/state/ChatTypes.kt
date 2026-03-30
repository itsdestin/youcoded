package com.destin.code.ui.state

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import org.json.JSONObject

/**
 * Turn-based chat state model mirroring the desktop's chat-types.ts.
 *
 * The key concept is the AssistantTurn — a single visual unit containing
 * interleaved text segments and tool groups, rendered as one bubble.
 *
 * Timeline entries are the top-level items in the chat list:
 *   [User] → [AssistantTurn] → [User] → [AssistantTurn] → ...
 */

// ─── Tool state ──────────────────────────────────────────────────────

enum class ToolCallStatus { Running, Complete, Failed, AwaitingApproval }

data class ToolCallState(
    val toolUseId: String,
    val toolName: String,
    val input: JSONObject,
    val status: ToolCallStatus,
    val requestId: String? = null,
    val permissionSuggestions: List<String>? = null,
    val response: String? = null,
    val error: String? = null,
)

data class ToolGroupState(
    val id: String,
    val toolIds: MutableList<String> = mutableListOf(),
)

// ─── Assistant turn ──────────────────────────────────────────────────

sealed class AssistantTurnSegment {
    data class Text(val content: String, val messageId: String) : AssistantTurnSegment()
    data class ToolGroupRef(val groupId: String) : AssistantTurnSegment()
}

data class AssistantTurn(
    val id: String,
    val segments: MutableList<AssistantTurnSegment> = mutableListOf(),
)

// ─── Chat messages ───────────────────────────────────────────────────

data class ChatMessage(
    val id: String,
    val role: ChatRole,
    val content: String,
    val timestamp: Long,
)

enum class ChatRole { User, Assistant }

// ─── Interactive prompts ─────────────────────────────────────────────

data class InteractivePrompt(
    val promptId: String,
    val title: String,
    val buttons: List<PromptButton>,
    val completed: String? = null,
)

data class PromptButton(val label: String, val input: String)

// ─── Timeline ────────────────────────────────────────────────────────

sealed class TimelineEntry {
    data class User(val message: ChatMessage) : TimelineEntry()
    data class Turn(val turnId: String) : TimelineEntry()
    data class Prompt(val prompt: InteractivePrompt) : TimelineEntry()
    data class Notice(val id: String, val message: String) : TimelineEntry()
}

// ─── Session state ───────────────────────────────────────────────────

/**
 * Session chat state using Compose-observable collections.
 * NOT a data class — we use mutableStateListOf/mutableStateMapOf for reactivity.
 */
class SessionChatState {
    val timeline = androidx.compose.runtime.mutableStateListOf<TimelineEntry>()
    val toolCalls = androidx.compose.runtime.snapshots.SnapshotStateMap<String, ToolCallState>()
    val toolGroups = androidx.compose.runtime.snapshots.SnapshotStateMap<String, ToolGroupState>()
    val assistantTurns = androidx.compose.runtime.snapshots.SnapshotStateMap<String, AssistantTurn>()
    var isThinking by androidx.compose.runtime.mutableStateOf(false)
    var streamingText by androidx.compose.runtime.mutableStateOf("")
    /** Optimistic echo — shown immediately on send, cleared when transcript confirms */
    var pendingUserText by androidx.compose.runtime.mutableStateOf("")
    /** ID of the current tool group (tools accumulate here until next text/turn) */
    var currentGroupId: String? by androidx.compose.runtime.mutableStateOf(null)
    /** ID of the current assistant turn (text + tool groups accumulate here) */
    var currentTurnId: String? by androidx.compose.runtime.mutableStateOf(null)
    /** Timestamp of last activity — used for thinking timeout */
    var lastActivityAt: Long = 0L
    /** Permission mode detected from PTY output */
    var permissionMode by androidx.compose.runtime.mutableStateOf("Normal")
    /** Current tool being worked on — for activity indicator */
    var activeToolName: String? by androidx.compose.runtime.mutableStateOf(null)
}

fun createSessionChatState(): SessionChatState = SessionChatState()
