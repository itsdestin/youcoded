package com.destin.code.ui.cards

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destin.code.ui.ChatMessage
import com.destin.code.ui.MessageContent
import com.destin.code.ui.theme.DestinCodeTheme

/**
 * Collapsed summary card for a group of completed/failed tool calls.
 * Shows "▸ N tool calls (X ✓, Y ✗)" collapsed, expands to individual lines on tap.
 */
@Composable
fun ToolGroupCard(
    messages: List<ChatMessage>,
    isExpanded: Boolean,
    onToggle: () -> Unit,
    expandedCardId: String? = null,
    onToggleCard: (String) -> Unit = {},
) {
    val successCount = messages.count { it.content is MessageContent.ToolComplete }
    val failCount = messages.count { it.content is MessageContent.ToolFailed }
    val borderColor = if (failCount > 0)
        MaterialTheme.colorScheme.error.copy(alpha = 0.3f)
    else
        DestinCodeTheme.extended.surfaceBorder

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 2.dp)
            .clip(RoundedCornerShape(8.dp))
            .border(0.5.dp, borderColor, RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surface)
            .clickable { onToggle() }
            .padding(10.dp)
    ) {
        // Summary header
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (isExpanded) "▾" else "▸",
                fontSize = 12.sp,
                color = DestinCodeTheme.extended.textSecondary,
            )
            Spacer(Modifier.width(6.dp))
            Text(
                "${messages.size} tool calls",
                color = MaterialTheme.colorScheme.onSurface,
                fontWeight = FontWeight.Medium,
                fontSize = 13.sp,
            )
            Spacer(Modifier.width(6.dp))
            val summary = buildString {
                if (successCount > 0) append("$successCount \u2713")
                if (successCount > 0 && failCount > 0) append("  ")
                if (failCount > 0) append("$failCount \u2717")
            }
            Text(
                summary,
                color = DestinCodeTheme.extended.textSecondary,
                fontSize = 12.sp,
            )
        }

        // Expanded: show individual tool lines (compact, no padding/borders)
        AnimatedVisibility(visible = isExpanded) {
            Column(modifier = Modifier.padding(top = 6.dp)) {
                for (msg in messages) {
                    val (tool, args, failed) = when (val c = msg.content) {
                        is MessageContent.ToolComplete -> Triple(c.tool, c.args, false)
                        is MessageContent.ToolFailed -> Triple(c.tool, c.args, true)
                        else -> continue
                    }
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 1.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            if (failed) "\u2717" else "\u2713",
                            fontSize = 11.sp,
                            color = if (failed) MaterialTheme.colorScheme.error
                                else DestinCodeTheme.extended.textSecondary,
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(
                            tool,
                            color = if (failed) MaterialTheme.colorScheme.error
                                else MaterialTheme.colorScheme.primary,
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 12.sp,
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(
                            args.take(45) + if (args.length > 45) "..." else "",
                            color = DestinCodeTheme.extended.textSecondary,
                            fontSize = 11.sp,
                            maxLines = 1,
                        )
                    }
                }
            }
        }
    }
}
