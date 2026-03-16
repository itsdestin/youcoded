package com.destins.claudemobile.ui.cards

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
import com.destins.claudemobile.ui.TerminalPanel
import com.destins.claudemobile.ui.theme.ClaudeMobileTheme
import com.termux.terminal.TerminalSession
import kotlinx.coroutines.delay
import org.json.JSONObject

enum class ToolCardState { Running, AwaitingApproval, Complete }

@Composable
fun ToolCard(
    cardId: String,
    tool: String,
    args: String,
    state: ToolCardState,
    result: JSONObject? = null,
    isExpanded: Boolean = false,
    onToggle: (String) -> Unit = {},
    session: TerminalSession? = null,
    screenVersion: Int = 0,
    onAccept: () -> Unit = {},
    onReject: () -> Unit = {},
) {
    val borderColor = when (state) {
        ToolCardState.Running -> MaterialTheme.colorScheme.primary.copy(alpha = 0.3f)
        ToolCardState.AwaitingApproval -> MaterialTheme.colorScheme.primary
        ToolCardState.Complete -> ClaudeMobileTheme.extended.surfaceBorder
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 2.dp)
            .clip(RoundedCornerShape(8.dp))
            .border(0.5.dp, borderColor, RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surface)
            .clickable { onToggle(cardId) }
            .padding(10.dp)
    ) {
        // Header: status icon + tool name + args
        Row(verticalAlignment = Alignment.CenterVertically) {
            val statusText = when (state) {
                ToolCardState.Running -> "\u23F3" // hourglass
                ToolCardState.AwaitingApproval -> "\u26A0" // warning
                ToolCardState.Complete -> "\u2713" // checkmark
            }
            Text(statusText, fontSize = 13.sp)
            Spacer(Modifier.width(6.dp))
            Text(
                tool,
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.SemiBold,
                fontSize = 13.sp,
            )
            Spacer(Modifier.width(6.dp))
            Text(
                args.take(60) + if (args.length > 60) "..." else "",
                color = ClaudeMobileTheme.extended.textSecondary,
                fontSize = 12.sp,
                maxLines = 1,
            )
        }

        // Running: animated dots
        if (state == ToolCardState.Running) {
            val dotCount by produceState(initialValue = 1) {
                while (true) {
                    delay(400)
                    value = (value % 3) + 1
                }
            }
            Text(
                ".".repeat(dotCount),
                color = ClaudeMobileTheme.extended.textSecondary,
                fontSize = 12.sp,
            )
        }

        // Awaiting approval: mini-terminal + buttons
        if (state == ToolCardState.AwaitingApproval && session != null) {
            Spacer(Modifier.height(6.dp))
            TerminalPanel(
                session = session,
                screenVersion = screenVersion,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(160.dp)
                    .clip(RoundedCornerShape(4.dp)),
            )
            Spacer(Modifier.height(8.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly,
            ) {
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .background(MaterialTheme.colorScheme.primary)
                        .clickable { onAccept() }
                        .padding(horizontal = 24.dp, vertical = 8.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("Accept", color = MaterialTheme.colorScheme.onPrimary, fontSize = 14.sp)
                }
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .border(0.5.dp, ClaudeMobileTheme.extended.surfaceBorder, RoundedCornerShape(6.dp))
                        .clickable { onReject() }
                        .padding(horizontal = 24.dp, vertical = 8.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("Reject", color = MaterialTheme.colorScheme.onSurface, fontSize = 14.sp)
                }
            }
        }

        // Complete: expandable result
        if (state == ToolCardState.Complete) {
            AnimatedVisibility(visible = isExpanded) {
                Column(modifier = Modifier.padding(top = 6.dp)) {
                    if (session != null && tool == "Bash") {
                        TerminalPanel(
                            session = session,
                            screenVersion = screenVersion,
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(120.dp)
                                .clip(RoundedCornerShape(4.dp)),
                        )
                    } else {
                        val resultText = result?.toString(2) ?: ""
                        if (resultText.length > 200) {
                            Text(
                                resultText.take(200) + "...",
                                fontFamily = com.destins.claudemobile.ui.theme.CascadiaMono,
                                color = MaterialTheme.colorScheme.onSurface,
                                fontSize = 11.sp,
                            )
                        } else if (resultText.isNotBlank()) {
                            Text(
                                resultText,
                                fontFamily = com.destins.claudemobile.ui.theme.CascadiaMono,
                                color = MaterialTheme.colorScheme.onSurface,
                                fontSize = 11.sp,
                            )
                        }
                    }
                }
            }
        }
    }
}
