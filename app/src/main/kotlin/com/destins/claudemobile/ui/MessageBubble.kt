package com.destins.claudemobile.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.ClickableText
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destins.claudemobile.ui.cards.*
import com.termux.terminal.TerminalSession

private val URL_PATTERN = Regex("""https?://[^\s)>\]"'`]+""")
private val LINK_COLOR = Color(0xFF66AAFF)

/** Text composable with clickable URL detection. */
@Composable
private fun LinkableText(
    text: String,
    style: androidx.compose.ui.text.TextStyle,
    color: Color,
) {
    val context = LocalContext.current
    val matches = URL_PATTERN.findAll(text).toList()

    if (matches.isEmpty()) {
        Text(text = text, style = style, color = color)
        return
    }

    val annotated = buildAnnotatedString {
        append(text)
        // Apply default color to entire string
        addStyle(SpanStyle(color = color), 0, text.length)
        for (match in matches) {
            val url = match.value.trimEnd('.', ',', ';', ':', '!')
            addStyle(
                SpanStyle(color = LINK_COLOR, textDecoration = TextDecoration.Underline),
                match.range.first, match.range.last + 1,
            )
            addStringAnnotation("URL", url, match.range.first, match.range.last + 1)
        }
    }

    ClickableText(text = annotated, style = style) { offset ->
        annotated.getStringAnnotations("URL", offset, offset).firstOrNull()?.let {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(it.item)))
        }
    }
}

@Composable
fun MessageBubble(
    message: ChatMessage,
    expandedCardId: String? = null,
    onToggleCard: (String) -> Unit = {},
    onAcceptApproval: () -> Unit = {},
    onAcceptAlwaysApproval: () -> Unit = {},
    onRejectApproval: () -> Unit = {},
    session: TerminalSession? = null,
    screenVersion: Int = 0,
) {
    when (val content = message.content) {
        is MessageContent.ToolRunning -> {
            ToolCard(
                cardId = content.cardId,
                tool = content.tool,
                args = content.args,
                state = ToolCardState.Running,
                isExpanded = expandedCardId == content.cardId,
                onToggle = onToggleCard,
            )
            return
        }
        is MessageContent.ToolAwaitingApproval -> {
            ToolCard(
                cardId = content.cardId,
                tool = content.tool,
                args = content.args,
                state = ToolCardState.AwaitingApproval,
                isExpanded = true, // Always expanded when awaiting approval
                onToggle = onToggleCard,
                session = session,
                screenVersion = screenVersion,
                onAccept = onAcceptApproval,
                onReject = onRejectApproval,
            )
            return
        }
        is MessageContent.ToolComplete -> {
            when (content.tool) {
                "Bash" -> {
                    val command = content.result.optString("command", content.args)
                    val output = content.result.optString("stdout",
                        content.result.optString("output", content.result.toString()))
                    CodeCard(
                        cardId = content.cardId,
                        language = "bash",
                        code = "$ $command\n$output",
                        isExpanded = expandedCardId == content.cardId,
                        onToggle = onToggleCard,
                    )
                }
                else -> {
                    ToolCard(
                        cardId = content.cardId,
                        tool = content.tool,
                        args = content.args,
                        state = ToolCardState.Complete,
                        result = content.result,
                        isExpanded = expandedCardId == content.cardId,
                        onToggle = onToggleCard,
                        session = session,
                        screenVersion = screenVersion,
                    )
                }
            }
            return
        }
        is MessageContent.ToolFailed -> {
            ErrorCard(
                cardId = content.cardId,
                message = "${content.tool} failed",
                details = content.error.optString("message", content.error.toString()),
                isExpanded = expandedCardId == content.cardId,
                onToggle = onToggleCard,
            )
            return
        }
        is MessageContent.SystemNotice -> {
            Text(
                text = content.text,
                fontSize = 12.sp,
                color = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.textSecondary,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
            )
            return
        }
        else -> Unit
    }

    // Text bubbles (user messages and Claude responses)
    val isUser = message.role == MessageRole.USER
    val isQueued = message.isQueued
    val bgColor = when {
        isQueued -> MaterialTheme.colorScheme.primary.copy(alpha = 0.35f)
        message.isBtw -> MaterialTheme.colorScheme.surface.copy(alpha = 0.5f)
        isUser -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.surface
    }
    val alignment = if (isUser) Arrangement.End else Arrangement.Start

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 2.dp),
        horizontalArrangement = alignment
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth(0.85f)
                .clip(RoundedCornerShape(12.dp))
                .background(bgColor)
                .padding(10.dp)
        ) {
            if (!isUser) {
                Text(
                    text = if (message.isBtw) "aside" else "Claude",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(bottom = 2.dp)
                )
            }

            when (val content = message.content) {
                is MessageContent.Text -> {
                    LinkableText(
                        text = content.text,
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (isQueued) Color.White.copy(alpha = 0.5f)
                            else if (isUser) Color.White
                            else MaterialTheme.colorScheme.onSurface,
                    )
                    if (isQueued) {
                        Text(
                            text = "queued",
                            fontSize = 10.sp,
                            color = Color.White.copy(alpha = 0.4f),
                            modifier = Modifier.padding(top = 2.dp),
                        )
                    }
                }
                is MessageContent.Response -> {
                    MarkdownRenderer(
                        markdown = content.markdown,
                        textColor = MaterialTheme.colorScheme.onSurface,
                        expandedCardId = expandedCardId,
                        onToggleCard = onToggleCard,
                    )
                }
                else -> Unit
            }
        }
    }
}
