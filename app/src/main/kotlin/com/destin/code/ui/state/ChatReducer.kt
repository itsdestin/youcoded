package com.destin.code.ui.state

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONObject
import java.util.UUID

/**
 * Actions that can be dispatched to the chat reducer.
 * Mirrors the desktop's ChatAction union type from chat-types.ts.
 *
 * Two sources feed actions:
 *   1. TranscriptWatcher → TRANSCRIPT_* actions (chat content)
 *   2. EventBridge → PERMISSION_* actions (approval flow)
 */
sealed class ChatAction {
    // ─── Transcript events (primary timeline source) ─────────────
    data class TranscriptUserMessage(
        val uuid: String,
        val text: String,
        val timestamp: Long,
    ) : ChatAction()

    data class TranscriptAssistantText(
        val uuid: String,
        val text: String,
        val timestamp: Long,
    ) : ChatAction()

    data class TranscriptToolUse(
        val uuid: String,
        val toolUseId: String,
        val toolName: String,
        val toolInput: JSONObject,
    ) : ChatAction()

    data class TranscriptToolResult(
        val uuid: String,
        val toolUseId: String,
        val result: String,
        val isError: Boolean,
    ) : ChatAction()

    data class TranscriptTurnComplete(
        val uuid: String,
        val timestamp: Long,
    ) : ChatAction()

    // ─── Hook events (permission/approval flow) ──────────────────
    data class PermissionRequest(
        val toolName: String,
        val input: JSONObject,
        val requestId: String,
        val permissionSuggestions: List<String>? = null,
    ) : ChatAction()

    data class PermissionResponded(
        val requestId: String,
    ) : ChatAction()

    data class PermissionExpired(
        val requestId: String,
    ) : ChatAction()

    // ─── Interactive prompts ─────────────────────────────────────
    data class ShowPrompt(
        val promptId: String,
        val title: String,
        val buttons: List<PromptButton>,
    ) : ChatAction()

    data class CompletePrompt(
        val promptId: String,
        val selection: String,
    ) : ChatAction()

    data class DismissPrompt(
        val promptId: String,
    ) : ChatAction()

    // ─── Thinking/activity ───────────────────────────────────────
    data object ThinkingTimeout : ChatAction()
    data object TerminalActivity : ChatAction()

    // ─── Optimistic echo ────────────────────────────────────────
    data class MessageSent(val text: String) : ChatAction()

    // ─── Streaming text ─────────────────────────────────────────────────────
    data class StreamingText(val text: String) : ChatAction()
}

/**
 * Manages a [SessionChatState] by processing [ChatAction]s.
 * Must be called on the Main thread (state uses Compose snapshot state).
 *
 * Mirrors the desktop's chatReducer from chat-reducer.ts.
 */
class ChatReducer {
    val state = createSessionChatState()

    /** Incremented on every state change for Compose recomposition triggers. */
    var version by mutableStateOf(0)
        private set

    private var messageIdCounter = 0
    private var groupIdCounter = 0
    private var turnIdCounter = 0

    private fun nextMessageId() = "msg-${messageIdCounter++}"
    private fun nextGroupId() = "group-${groupIdCounter++}"
    private fun nextTurnId() = "turn-${turnIdCounter++}"

    /** Seen uuids for deduplication (transcript events can arrive via both sources). */
    private val seenUuids = mutableSetOf<String>()

    fun dispatch(action: ChatAction) {
        when (action) {
            is ChatAction.TranscriptUserMessage -> handleUserMessage(action)
            is ChatAction.TranscriptAssistantText -> handleAssistantText(action)
            is ChatAction.TranscriptToolUse -> handleToolUse(action)
            is ChatAction.TranscriptToolResult -> handleToolResult(action)
            is ChatAction.TranscriptTurnComplete -> handleTurnComplete(action)
            is ChatAction.PermissionRequest -> handlePermissionRequest(action)
            is ChatAction.PermissionResponded -> handlePermissionResponded(action)
            is ChatAction.PermissionExpired -> handlePermissionExpired(action)
            is ChatAction.ShowPrompt -> handleShowPrompt(action)
            is ChatAction.CompletePrompt -> handleCompletePrompt(action)
            is ChatAction.DismissPrompt -> handleDismissPrompt(action)
            is ChatAction.ThinkingTimeout -> handleThinkingTimeout()
            is ChatAction.TerminalActivity -> handleTerminalActivity()
            is ChatAction.MessageSent -> handleMessageSent(action)
            is ChatAction.StreamingText -> handleStreamingText(action)
        }
        version++
    }

    // ─── Transcript event handlers ───────────────────────────────

    private fun handleUserMessage(action: ChatAction.TranscriptUserMessage) {
        if (!seenUuids.add(action.uuid)) return

        // Close current turn — user message starts a new cycle
        state.currentTurnId = null
        state.currentGroupId = null
        state.isThinking = true
        state.pendingUserText = ""
        state.streamingText = ""
        state.lastActivityAt = System.currentTimeMillis()
        state.activeToolName = null

        val msg = ChatMessage(
            id = nextMessageId(),
            role = ChatRole.User,
            content = action.text,
            timestamp = action.timestamp,
        )
        state.timeline.add(TimelineEntry.User(msg))
    }

    private fun handleAssistantText(action: ChatAction.TranscriptAssistantText) {
        if (!seenUuids.add(action.uuid)) return

        state.streamingText = ""
        state.isThinking = false
        state.lastActivityAt = System.currentTimeMillis()
        state.activeToolName = null

        val turn = getOrCreateTurn()
        val messageId = nextMessageId()
        turn.segments.add(AssistantTurnSegment.Text(action.text, messageId))
    }

    private fun handleToolUse(action: ChatAction.TranscriptToolUse) {
        if (!seenUuids.add(action.uuid)) return

        state.isThinking = false
        state.lastActivityAt = System.currentTimeMillis()
        state.activeToolName = action.toolName

        // Check if this tool already exists (permission hook may have created it)
        if (state.toolCalls.containsKey(action.toolUseId)) return

        val turn = getOrCreateTurn()
        val group = getOrCreateGroup(turn)

        val toolCall = ToolCallState(
            toolUseId = action.toolUseId,
            toolName = action.toolName,
            input = action.toolInput,
            status = ToolCallStatus.Running,
        )
        state.toolCalls[action.toolUseId] = toolCall
        group.toolIds.add(action.toolUseId)
    }

    private fun handleToolResult(action: ChatAction.TranscriptToolResult) {
        if (!seenUuids.add(action.uuid)) return

        state.lastActivityAt = System.currentTimeMillis()
        state.activeToolName = null

        val existing = state.toolCalls[action.toolUseId] ?: return

        // Don't overwrite awaiting-approval status — let permission flow handle it
        if (existing.status == ToolCallStatus.AwaitingApproval) return

        state.toolCalls[action.toolUseId] = if (action.isError) {
            existing.copy(status = ToolCallStatus.Failed, error = action.result)
        } else {
            existing.copy(status = ToolCallStatus.Complete, response = action.result)
        }

        // Start a new tool group for the next batch of tools
        state.currentGroupId = null
    }

    private fun handleTurnComplete(action: ChatAction.TranscriptTurnComplete) {
        if (!seenUuids.add(action.uuid)) return

        state.isThinking = false
        state.currentTurnId = null
        state.currentGroupId = null
        state.streamingText = ""
        state.activeToolName = null
    }

    // ─── Permission/approval handlers ────────────────────────────

    private fun handlePermissionRequest(action: ChatAction.PermissionRequest) {
        state.lastActivityAt = System.currentTimeMillis()

        // Find the matching tool call. If it doesn't exist yet (transcript watcher
        // hasn't caught up), create a synthetic entry — same as desktop.
        val toolCall = state.toolCalls.values.find {
            it.toolName == action.toolName && it.status == ToolCallStatus.Running
        }

        if (toolCall != null) {
            state.toolCalls[toolCall.toolUseId] = toolCall.copy(
                status = ToolCallStatus.AwaitingApproval,
                requestId = action.requestId,
                permissionSuggestions = action.permissionSuggestions,
            )
        } else {
            // Synthetic tool entry — permission hook arrived before transcript
            val syntheticId = "synthetic-${UUID.randomUUID()}"
            val turn = getOrCreateTurn()
            val group = getOrCreateGroup(turn)

            state.toolCalls[syntheticId] = ToolCallState(
                toolUseId = syntheticId,
                toolName = action.toolName,
                input = action.input,
                status = ToolCallStatus.AwaitingApproval,
                requestId = action.requestId,
                permissionSuggestions = action.permissionSuggestions,
            )
            group.toolIds.add(syntheticId)
        }
    }

    private fun handlePermissionResponded(action: ChatAction.PermissionResponded) {
        val toolCall = state.toolCalls.values.find { it.requestId == action.requestId }
        if (toolCall != null) {
            state.toolCalls[toolCall.toolUseId] = toolCall.copy(
                status = ToolCallStatus.Running,
                requestId = null,
            )
        }
    }

    private fun handlePermissionExpired(action: ChatAction.PermissionExpired) {
        val toolCall = state.toolCalls.values.find { it.requestId == action.requestId }
        if (toolCall != null) {
            state.toolCalls[toolCall.toolUseId] = toolCall.copy(
                status = ToolCallStatus.Failed,
                requestId = null,
                error = "Permission request timed out",
            )
        }
    }

    // ─── Prompt handlers ─────────────────────────────────────────

    private fun handleShowPrompt(action: ChatAction.ShowPrompt) {
        // Remove existing prompt with same ID to avoid duplicates
        state.timeline.removeAll { entry ->
            entry is TimelineEntry.Prompt && entry.prompt.promptId == action.promptId
        }
        state.timeline.add(TimelineEntry.Prompt(InteractivePrompt(
            promptId = action.promptId,
            title = action.title,
            buttons = action.buttons,
        )))
    }

    private fun handleCompletePrompt(action: ChatAction.CompletePrompt) {
        val idx = state.timeline.indexOfLast { entry ->
            entry is TimelineEntry.Prompt && entry.prompt.promptId == action.promptId
        }
        if (idx >= 0) {
            val prompt = (state.timeline[idx] as TimelineEntry.Prompt).prompt
            state.timeline[idx] = TimelineEntry.Prompt(prompt.copy(completed = action.selection))
        }
    }

    private fun handleDismissPrompt(action: ChatAction.DismissPrompt) {
        state.timeline.removeAll { entry ->
            entry is TimelineEntry.Prompt &&
                entry.prompt.promptId == action.promptId &&
                entry.prompt.completed == null // only remove active prompts
        }
    }

    // ─── Thinking/activity ───────────────────────────────────────

    private fun handleThinkingTimeout() {
        if (state.isThinking) {
            state.isThinking = false
        }
    }

    private fun handleTerminalActivity() {
        state.lastActivityAt = System.currentTimeMillis()
    }

    private fun handleMessageSent(action: ChatAction.MessageSent) {
        state.isThinking = true
        state.pendingUserText = action.text
    }

    private fun handleStreamingText(action: ChatAction.StreamingText) {
        state.streamingText = action.text
        state.isThinking = false
        state.lastActivityAt = System.currentTimeMillis()
    }

    // ─── Helpers ─────────────────────────────────────────────────

    /**
     * Get or create the current assistant turn.
     * If no turn exists, create one and add it to the timeline.
     */
    private fun getOrCreateTurn(): AssistantTurn {
        val existingId = state.currentTurnId
        if (existingId != null) {
            val existing = state.assistantTurns[existingId]
            if (existing != null) return existing
        }

        val turnId = nextTurnId()
        val turn = AssistantTurn(id = turnId)
        state.assistantTurns[turnId] = turn
        state.currentTurnId = turnId
        state.timeline.add(TimelineEntry.Turn(turnId))
        return turn
    }

    /**
     * Get or create the current tool group within the current turn.
     * If no group exists, create one and add a reference to the turn's segments.
     */
    private fun getOrCreateGroup(turn: AssistantTurn): ToolGroupState {
        val existingId = state.currentGroupId
        if (existingId != null) {
            val existing = state.toolGroups[existingId]
            if (existing != null) return existing
        }

        val groupId = nextGroupId()
        val group = ToolGroupState(id = groupId)
        state.toolGroups[groupId] = group
        state.currentGroupId = groupId
        turn.segments.add(AssistantTurnSegment.ToolGroupRef(groupId))
        return group
    }

    /** Check if any tool is currently awaiting approval. */
    fun isAwaitingApproval(): Boolean {
        return state.toolCalls.values.any { it.status == ToolCallStatus.AwaitingApproval }
    }

    /** Get the tool currently awaiting approval (if any). */
    fun getAwaitingApproval(): ToolCallState? {
        return state.toolCalls.values.find { it.status == ToolCallStatus.AwaitingApproval }
    }
}
