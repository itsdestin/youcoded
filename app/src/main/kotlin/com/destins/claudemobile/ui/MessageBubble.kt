package com.destins.claudemobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destins.claudemobile.ui.cards.*

@Composable
fun MessageBubble(
    message: ChatMessage,
    expandedCardId: String? = null,
    onToggleCard: (String) -> Unit = {},
    onApprove: () -> Unit = {},
    onReject: () -> Unit = {},
    onViewTerminal: () -> Unit = {},
    onMenuSelect: (Int) -> Unit = {},
    onConfirmYes: () -> Unit = {},
    onConfirmNo: () -> Unit = {},
) {
    when (val content = message.content) {
        is MessageContent.ToolCall -> {
            ToolCard(cardId = content.cardId, tool = content.tool, args = content.args,
                duration = content.duration, isExpanded = expandedCardId == content.cardId,
                onToggle = onToggleCard)
            return
        }
        is MessageContent.Diff -> {
            DiffCard(cardId = content.cardId, filename = content.filename, hunks = content.hunks,
                isExpanded = expandedCardId == content.cardId, onToggle = onToggleCard)
            return
        }
        is MessageContent.Code -> {
            CodeCard(cardId = content.cardId, language = content.language, code = content.code,
                isExpanded = expandedCardId == content.cardId, onToggle = onToggleCard)
            return
        }
        is MessageContent.Error -> {
            ErrorCard(cardId = content.cardId, message = content.message, details = content.details,
                isExpanded = expandedCardId == content.cardId, onToggle = onToggleCard)
            return
        }
        is MessageContent.Progress -> {
            ProgressCard(message = content.message)
            return
        }
        is MessageContent.ApprovalRequest -> {
            ApprovalCard(tool = content.tool, summary = content.summary,
                onAccept = onApprove, onReject = onReject, onViewTerminal = onViewTerminal)
            return
        }
        is MessageContent.Menu -> {
            com.destins.claudemobile.ui.widgets.MenuWidget(
                options = content.options,
                onSelect = onMenuSelect,
            )
            return
        }
        is MessageContent.MenuResolved -> {
            // Styled confirmation widget
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 8.dp, vertical = 4.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(MaterialTheme.colorScheme.surface)
                    .padding(12.dp),
            ) {
                Text(
                    "Claude",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(bottom = 4.dp),
                )
                Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    Text(
                        "✓",
                        color = Color(0xFF44DD44),
                        fontSize = 16.sp,
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        content.selected,
                        fontSize = 14.sp,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
            return
        }
        is MessageContent.OAuth -> {
            com.destins.claudemobile.ui.widgets.OAuthWidget(
                url = content.url,
                onSwitchToTerminal = onViewTerminal,
            )
            return
        }
        is MessageContent.Confirm -> {
            com.destins.claudemobile.ui.widgets.ConfirmationWidget(
                question = content.question,
                onYes = onConfirmYes,
                onNo = onConfirmNo,
            )
            return
        }
        else -> Unit
    }

    val isUser = message.role == MessageRole.USER
    val bgColor = when {
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
                .fillMaxWidth(0.75f)
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
                    Text(
                        text = content.text,
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (isUser) Color.White else MaterialTheme.colorScheme.onSurface,
                    )
                }
                is MessageContent.RawTerminal -> {
                    Text(
                        text = content.text,
                        fontFamily = com.destins.claudemobile.ui.theme.CascadiaMono,
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.8f),
                    )
                }
                else -> Unit
            }
        }
    }
}
