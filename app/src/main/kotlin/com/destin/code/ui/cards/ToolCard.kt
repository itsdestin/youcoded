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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import com.destin.code.runtime.ReadOnlyTerminalViewClient
import com.destin.code.ui.theme.DestinCodeTheme
import com.termux.terminal.TerminalSession
import com.termux.view.TerminalView
import kotlinx.coroutines.delay
import org.json.JSONObject

enum class ToolCardState { Running, AwaitingApproval, Complete, Failed }

private fun friendlyToolAction(tool: String): String = when (tool) {
    "Read" -> "Reading"
    "Write" -> "Writing"
    "Edit" -> "Editing"
    "Bash" -> "Bashing"
    "Glob" -> "Globbing"
    "Grep" -> "Grepping"
    "Agent" -> "Agenting"
    "WebSearch" -> "Searching"
    "WebFetch" -> "Fetching"
    "Skill" -> "Skilling"
    "LS" -> "Listing"
    else -> "Working"
}

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
    errorMessage: String? = null,
    onAccept: () -> Unit = {},
    onAcceptAlways: () -> Unit = {},
    onReject: () -> Unit = {},
    hasAlwaysOption: Boolean = true,
) {
    val borderColor = when (state) {
        ToolCardState.Running -> MaterialTheme.colorScheme.primary.copy(alpha = 0.3f)
        ToolCardState.AwaitingApproval -> MaterialTheme.colorScheme.primary
        ToolCardState.Complete -> DestinCodeTheme.extended.surfaceBorder
        ToolCardState.Failed -> MaterialTheme.colorScheme.error
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 2.dp)
            .clip(RoundedCornerShape(8.dp))
            .border(if (state == ToolCardState.Failed) 1.dp else 0.5.dp, borderColor, RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surface)
            .clickable { onToggle(cardId) }
            .padding(10.dp)
    ) {
        // Header: status icon + tool action + args
        Row(verticalAlignment = Alignment.CenterVertically) {
            when (state) {
                ToolCardState.Running -> {
                    val dotCount by produceState(initialValue = 1) {
                        while (true) { delay(400); value = (value % 3) + 1 }
                    }
                    Text(
                        "${friendlyToolAction(tool)}${".".repeat(dotCount)}",
                        color = MaterialTheme.colorScheme.primary,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 13.sp,
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        args.take(50) + if (args.length > 50) "..." else "",
                        color = DestinCodeTheme.extended.textSecondary,
                        fontSize = 12.sp,
                        maxLines = 1,
                    )
                }
                ToolCardState.AwaitingApproval -> {
                    Text("\u26A0", fontSize = 13.sp)
                    Spacer(Modifier.width(6.dp))
                    Text(
                        tool,
                        color = MaterialTheme.colorScheme.primary,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 13.sp,
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        args.take(50) + if (args.length > 50) "..." else "",
                        color = DestinCodeTheme.extended.textSecondary,
                        fontSize = 12.sp,
                        maxLines = 1,
                    )
                }
                ToolCardState.Complete -> {
                    Text("\u2713", fontSize = 13.sp)
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
                        color = DestinCodeTheme.extended.textSecondary,
                        fontSize = 12.sp,
                        maxLines = 1,
                    )
                }
                ToolCardState.Failed -> {
                    Text("\u2717", fontSize = 13.sp, color = MaterialTheme.colorScheme.error)
                    Spacer(Modifier.width(6.dp))
                    Text(
                        tool,
                        color = MaterialTheme.colorScheme.error,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 13.sp,
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        args.take(60) + if (args.length > 60) "..." else "",
                        color = DestinCodeTheme.extended.textSecondary,
                        fontSize = 12.sp,
                        maxLines = 1,
                    )
                }
            }
        }

        // Awaiting approval: mini-terminal + 3-button row
        if (state == ToolCardState.AwaitingApproval && session != null) {
            Spacer(Modifier.height(6.dp))
            val readOnlyClient = remember { ReadOnlyTerminalViewClient() }
            AndroidView(
                factory = { ctx ->
                    TerminalView(ctx, null).apply {
                        setTerminalViewClient(readOnlyClient)
                        attachSession(session)
                    }
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(160.dp)
                    .clip(RoundedCornerShape(4.dp)),
            )
            Spacer(Modifier.height(8.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                // Yes
                Box(
                    modifier = Modifier
                        .then(if (hasAlwaysOption) Modifier.size(42.dp) else Modifier.weight(1f).height(42.dp))
                        .clip(RoundedCornerShape(6.dp))
                        .background(Color(0xFF2E7D32))
                        .clickable { onAccept() },
                    contentAlignment = Alignment.Center,
                ) {
                    Text("Yes", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                }
                // Always allow — only shown for 3-option prompts
                if (hasAlwaysOption) {
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .height(42.dp)
                            .clip(RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.primary)
                            .clickable { onAcceptAlways() },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text("Always Allow", color = MaterialTheme.colorScheme.onPrimary, fontSize = 13.sp)
                    }
                }
                // No
                Box(
                    modifier = Modifier
                        .then(if (hasAlwaysOption) Modifier.size(42.dp) else Modifier.weight(1f).height(42.dp))
                        .clip(RoundedCornerShape(6.dp))
                        .background(Color(0xFFCC3333))
                        .clickable { onReject() },
                    contentAlignment = Alignment.Center,
                ) {
                    Text("No", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                }
            }
        }

        // Complete: expandable result
        if (state == ToolCardState.Complete) {
            AnimatedVisibility(visible = isExpanded) {
                Column(modifier = Modifier.padding(top = 6.dp)) {
                    val resultText = result?.toString(2) ?: ""
                    if (resultText.length > 200) {
                        Text(
                            resultText.take(200) + "...",
                            fontFamily = com.destin.code.ui.theme.CascadiaMono,
                            color = MaterialTheme.colorScheme.onSurface,
                            fontSize = 11.sp,
                        )
                    } else if (resultText.isNotBlank()) {
                        Text(
                            resultText,
                            fontFamily = com.destin.code.ui.theme.CascadiaMono,
                            color = MaterialTheme.colorScheme.onSurface,
                            fontSize = 11.sp,
                        )
                    }
                }
            }
        }

        // Failed: expandable error details
        if (state == ToolCardState.Failed) {
            AnimatedVisibility(visible = isExpanded) {
                Column(modifier = Modifier.padding(top = 6.dp)) {
                    if (!errorMessage.isNullOrBlank()) {
                        Text(
                            errorMessage,
                            fontFamily = com.destin.code.ui.theme.CascadiaMono,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                            fontSize = 11.sp,
                        )
                    }
                }
            }
        }
    }
}
