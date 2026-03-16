package com.destins.claudemobile.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

enum class MessageRole { USER, CLAUDE, SYSTEM }

sealed class MessageContent {
    data class Text(val text: String) : MessageContent()
    data class RawTerminal(val text: String) : MessageContent()
    data class ApprovalRequest(val tool: String, val summary: String) : MessageContent()
    data class ToolCall(val cardId: String, val tool: String, val args: String, val duration: Long? = null) : MessageContent()
    data class Diff(val cardId: String, val filename: String, val hunks: List<com.destins.claudemobile.parser.DiffHunk>) : MessageContent()
    data class Code(val cardId: String, val language: String, val code: String) : MessageContent()
    data class Error(val cardId: String, val message: String, val details: String) : MessageContent()
    data class Progress(val message: String) : MessageContent()
}

data class ChatMessage(
    val role: MessageRole,
    val content: MessageContent,
    val isBtw: Boolean = false,
    val timestamp: Long = System.currentTimeMillis(),
)

class ChatState {
    val messages = mutableStateListOf<ChatMessage>()
    var isWaitingForApproval by mutableStateOf(false)
    var approvalSummary by mutableStateOf("")
    var expandedCardId: String? by mutableStateOf(null)
    private var nextCardId = 0

    fun nextId(): String = "card-${nextCardId++}"

    fun toggleCard(cardId: String) {
        expandedCardId = if (expandedCardId == cardId) null else cardId
    }

    fun addUserMessage(text: String, isBtw: Boolean = false) {
        messages.add(ChatMessage(MessageRole.USER, MessageContent.Text(text), isBtw = isBtw))
    }

    fun addClaudeText(text: String) {
        messages.add(ChatMessage(MessageRole.CLAUDE, MessageContent.Text(text)))
    }

    fun addRawOutput(text: String) {
        messages.add(ChatMessage(MessageRole.CLAUDE, MessageContent.RawTerminal(text)))
    }

    fun requestApproval(tool: String, summary: String) {
        isWaitingForApproval = true
        approvalSummary = summary
        messages.add(ChatMessage(MessageRole.CLAUDE, MessageContent.ApprovalRequest(tool, summary)))
    }

    fun resolveApproval() {
        isWaitingForApproval = false
        approvalSummary = ""
    }

    fun addToolStart(tool: String, args: String) {
        val id = nextId()
        messages.add(ChatMessage(MessageRole.CLAUDE, MessageContent.ToolCall(id, tool, args)))
    }

    fun addDiff(filename: String, hunks: List<com.destins.claudemobile.parser.DiffHunk>) {
        val id = nextId()
        messages.add(ChatMessage(MessageRole.CLAUDE, MessageContent.Diff(id, filename, hunks)))
    }

    fun addCode(language: String, code: String) {
        val id = nextId()
        messages.add(ChatMessage(MessageRole.CLAUDE, MessageContent.Code(id, language, code)))
    }

    fun addError(message: String, details: String) {
        val id = nextId()
        messages.add(ChatMessage(MessageRole.CLAUDE, MessageContent.Error(id, message, details)))
    }

    fun addProgress(message: String) {
        val lastIdx = messages.indexOfLast { it.content is MessageContent.Progress }
        if (lastIdx >= 0) {
            messages[lastIdx] = ChatMessage(MessageRole.CLAUDE, MessageContent.Progress(message))
        } else {
            messages.add(ChatMessage(MessageRole.CLAUDE, MessageContent.Progress(message)))
        }
    }
}
