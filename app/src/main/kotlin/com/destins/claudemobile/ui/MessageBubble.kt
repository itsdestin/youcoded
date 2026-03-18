package com.destins.claudemobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destins.claudemobile.ui.cards.*
import com.termux.terminal.TerminalSession

private val URL_PATTERN = Regex("""https?://[^\s)>\]"'`]+""")
private val LINK_COLOR = Color(0xFF66AAFF)

/** Text composable with clickable URL detection using LinkAnnotation for reliable tap handling. */
@Composable
private fun LinkableText(
    text: String,
    style: androidx.compose.ui.text.TextStyle,
    color: Color,
) {
    val matches = URL_PATTERN.findAll(text).toList()

    if (matches.isEmpty()) {
        Text(text = text, style = style, color = color)
        return
    }

    val annotated = buildAnnotatedString {
        append(text)
        addStyle(SpanStyle(color = color), 0, text.length)
        for (match in matches) {
            val url = match.value.trimEnd('.', ',', ';', ':', '!')
            val end = match.range.first + url.length
            addLink(
                LinkAnnotation.Url(
                    url,
                    TextLinkStyles(style = SpanStyle(color = LINK_COLOR, textDecoration = TextDecoration.Underline)),
                ),
                match.range.first, end,
            )
        }
    }

    Text(text = annotated, style = style)
}

@Composable
fun MessageBubble(
    message: ChatMessage,
    expandedCardId: String? = null,
    onToggleCard: (String) -> Unit = {},
    onAcceptApproval: () -> Unit = {},
    onAcceptAlwaysApproval: () -> Unit = {},
    onRejectApproval: () -> Unit = {},
    onPromptAction: ((promptId: String, input: String) -> Unit)? = null,
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
                onAcceptAlways = onAcceptAlwaysApproval,
                onReject = onRejectApproval,
                hasAlwaysOption = content.hasAlwaysOption,
            )
            return
        }
        is MessageContent.ToolComplete -> {
            ToolCard(
                cardId = content.cardId,
                tool = content.tool,
                args = content.args,
                state = ToolCardState.Complete,
                result = content.result,
                isExpanded = expandedCardId == content.cardId,
                onToggle = onToggleCard,
            )
            return
        }
        is MessageContent.ToolFailed -> {
            ToolCard(
                cardId = content.cardId,
                tool = content.tool,
                args = content.args,
                state = ToolCardState.Failed,
                errorMessage = content.error.optString("message", content.error.toString()),
                isExpanded = expandedCardId == content.cardId,
                onToggle = onToggleCard,
            )
            return
        }
        is MessageContent.InteractivePrompt -> {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 8.dp, vertical = 4.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(MaterialTheme.colorScheme.surface)
                    .padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    content.title,
                    color = MaterialTheme.colorScheme.primary,
                    fontSize = 14.sp,
                    style = MaterialTheme.typography.titleSmall,
                )
                Spacer(modifier = Modifier.height(2.dp))
                for (button in content.buttons) {
                    Button(
                        onClick = { onPromptAction?.invoke(content.promptId, button.input) },
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(8.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.15f),
                            contentColor = MaterialTheme.colorScheme.primary,
                        ),
                    ) {
                        Text(button.label, fontSize = 13.sp)
                    }
                }
            }
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
