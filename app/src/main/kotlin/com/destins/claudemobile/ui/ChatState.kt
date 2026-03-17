package com.destins.claudemobile.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONObject
import java.util.UUID

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
    val id: String = UUID.randomUUID().toString(),
    val isQueued: Boolean = false,
)

class ChatState {
    val messages = mutableStateListOf<ChatMessage>()
    var expandedCardId: String? by mutableStateOf(null)

    /** Current tool being worked on — for activity indicator text */
    var activeToolName: String? by mutableStateOf(null)

    /** True while Claude is processing a user message (between send and Stop) */
    var isProcessing: Boolean by mutableStateOf(false)
        private set

    private var nextCardId = 0
    private fun nextId(): String = "card-${nextCardId++}"

    // Insertion cursor — Claude events (tools, responses) insert here,
    // which is always before any queued user messages.
    private var insertPos = 0

    // IDs of user messages waiting for Claude to process them
    private val queuedIds = mutableListOf<String>()

    fun toggleCard(cardId: String) {
        expandedCardId = if (expandedCardId == cardId) null else cardId
    }

    fun addUserMessage(text: String, isBtw: Boolean = false) {
        val shouldQueue = isProcessing
        val msg = ChatMessage(
            role = MessageRole.USER,
            content = MessageContent.Text(text),
            isBtw = isBtw,
            isQueued = shouldQueue,
        )
        messages.add(msg) // queued messages always go at the end
        if (shouldQueue) {
            queuedIds.add(msg.id)
        } else {
            isProcessing = true
            insertPos = messages.size // after this user message
        }
    }

    fun addResponse(markdown: String) {
        if (markdown.isNotBlank()) {
            messages.add(insertPos, ChatMessage(
                MessageRole.CLAUDE, MessageContent.Response(markdown),
            ))
            insertPos++
        }
        activeToolName = null
        advanceQueue()
    }

    fun addToolRunning(toolUseId: String, tool: String, args: String) {
        val id = nextId()
        activeToolName = tool
        messages.add(insertPos, ChatMessage(
            MessageRole.CLAUDE,
            MessageContent.ToolRunning(id, toolUseId, tool, args),
        ))
        insertPos++
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
        messages.add(insertPos, ChatMessage(
            MessageRole.SYSTEM, MessageContent.SystemNotice(text),
        ))
        insertPos++
    }

    /** Advance to the next queued user message, or stop processing. */
    private fun advanceQueue() {
        if (queuedIds.isNotEmpty()) {
            val nextId = queuedIds.removeFirst()
            val idx = messages.indexOfFirst { it.id == nextId }
            if (idx >= 0) {
                messages[idx] = messages[idx].copy(isQueued = false)
                insertPos = idx + 1
            } else {
                // Queued message was lost — recover by inserting at end
                insertPos = messages.size
            }
            // isProcessing stays true — Claude will process the un-queued message
        } else {
            isProcessing = false
        }
    }
}
