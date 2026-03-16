package com.destins.claudemobile.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONObject

enum class MessageRole { USER, CLAUDE, SYSTEM }

sealed class MessageContent {
    data class Text(val text: String) : MessageContent()
    data class Response(val markdown: String) : MessageContent()
    data class ToolRunning(
        val cardId: String,
        val toolUseId: String,
        val tool: String,
        val args: String,
    ) : MessageContent()
    data class ToolAwaitingApproval(
        val cardId: String,
        val toolUseId: String,
        val tool: String,
        val args: String,
    ) : MessageContent()
    data class ToolComplete(
        val cardId: String,
        val toolUseId: String,
        val tool: String,
        val args: String,
        val result: JSONObject,
    ) : MessageContent()
    data class ToolFailed(
        val cardId: String,
        val toolUseId: String,
        val tool: String,
        val args: String,
        val error: JSONObject,
    ) : MessageContent()
    data class SystemNotice(val text: String) : MessageContent()
}

data class ChatMessage(
    val role: MessageRole,
    val content: MessageContent,
    val isBtw: Boolean = false,
    val timestamp: Long = System.currentTimeMillis(),
)

class ChatState {
    val messages = mutableStateListOf<ChatMessage>()
    var expandedCardId: String? by mutableStateOf(null)

    /** Current tool being worked on — for activity indicator text */
    var activeToolName: String? by mutableStateOf(null)

    private var nextCardId = 0
    private fun nextId(): String = "card-${nextCardId++}"

    fun toggleCard(cardId: String) {
        expandedCardId = if (expandedCardId == cardId) null else cardId
    }

    fun addUserMessage(text: String, isBtw: Boolean = false) {
        messages.add(ChatMessage(MessageRole.USER, MessageContent.Text(text), isBtw = isBtw))
    }

    fun addResponse(markdown: String) {
        if (markdown.isNotBlank()) {
            messages.add(ChatMessage(MessageRole.CLAUDE, MessageContent.Response(markdown)))
        }
        activeToolName = null
    }

    fun addToolRunning(toolUseId: String, tool: String, args: String) {
        val id = nextId()
        activeToolName = tool
        messages.add(ChatMessage(
            MessageRole.CLAUDE,
            MessageContent.ToolRunning(id, toolUseId, tool, args),
        ))
    }

    fun updateToolToApproval(toolUseId: String) {
        val idx = messages.indexOfLast {
            val c = it.content
            c is MessageContent.ToolRunning && c.toolUseId == toolUseId
        }
        if (idx >= 0) {
            val running = messages[idx].content as MessageContent.ToolRunning
            messages[idx] = messages[idx].copy(
                content = MessageContent.ToolAwaitingApproval(
                    cardId = running.cardId,
                    toolUseId = running.toolUseId,
                    tool = running.tool,
                    args = running.args,
                )
            )
        }
    }

    fun updateToolToComplete(toolUseId: String, result: JSONObject) {
        val idx = messages.indexOfLast {
            val c = it.content
            (c is MessageContent.ToolRunning && c.toolUseId == toolUseId) ||
            (c is MessageContent.ToolAwaitingApproval && c.toolUseId == toolUseId)
        }
        if (idx >= 0) {
            val existing = messages[idx].content
            val (cardId, tool, args) = when (existing) {
                is MessageContent.ToolRunning -> Triple(existing.cardId, existing.tool, existing.args)
                is MessageContent.ToolAwaitingApproval -> Triple(existing.cardId, existing.tool, existing.args)
                else -> return
            }
            messages[idx] = messages[idx].copy(
                content = MessageContent.ToolComplete(cardId, toolUseId, tool, args, result),
            )
            activeToolName = null
        }
    }

    fun updateToolToFailed(toolUseId: String, error: JSONObject) {
        val idx = messages.indexOfLast {
            val c = it.content
            (c is MessageContent.ToolRunning && c.toolUseId == toolUseId) ||
            (c is MessageContent.ToolAwaitingApproval && c.toolUseId == toolUseId)
        }
        if (idx >= 0) {
            val existing = messages[idx].content
            val (cardId, tool, args) = when (existing) {
                is MessageContent.ToolRunning -> Triple(existing.cardId, existing.tool, existing.args)
                is MessageContent.ToolAwaitingApproval -> Triple(existing.cardId, existing.tool, existing.args)
                else -> return
            }
            messages[idx] = messages[idx].copy(
                content = MessageContent.ToolFailed(cardId, toolUseId, tool, args, error),
            )
            activeToolName = null
        }
    }

    fun addSystemNotice(text: String) {
        messages.add(ChatMessage(MessageRole.SYSTEM, MessageContent.SystemNotice(text)))
    }
}
