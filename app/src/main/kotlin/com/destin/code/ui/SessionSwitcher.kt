package com.destin.code.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import com.destin.code.runtime.ManagedSession
import com.destin.code.runtime.SessionStatus
import com.destin.code.ui.theme.CascadiaMono

@Composable
fun SessionSwitcherPill(
    currentSession: ManagedSession?,
    expanded: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val name by currentSession?.name?.collectAsState() ?: remember { mutableStateOf("No Session") }
    val status by currentSession?.status?.collectAsState() ?: remember { mutableStateOf(SessionStatus.Dead) }

    val borderColor = com.destin.code.ui.theme.DestinCodeTheme.extended.surfaceBorder
    // Detect if name overflows a single line at full size to switch modes.
    // Reset when name changes; only transition single → multi, never back
    // (prevents layout oscillation where 13sp overflows but 11sp fits).
    var needsMultiLine by remember(name) { mutableStateOf(false) }
    val singleLineFontSize = 13.sp
    val multiLineFontSize = 11.sp
    val multiLineHeight = 14.sp

    Row(
        modifier = modifier
            .widthIn(max = 180.dp)
            .then(if (needsMultiLine) Modifier.heightIn(max = 38.dp) else Modifier.height(34.dp))
            .clip(RoundedCornerShape(6.dp))
            .background(MaterialTheme.colorScheme.surface)
            .border(0.5.dp, borderColor.copy(alpha = 0.5f), RoundedCornerShape(6.dp))
            .clickable { onToggle() }
            .padding(horizontal = 10.dp, vertical = if (needsMultiLine) 4.dp else 0.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        StatusDot(status)
        Text(
            name,
            fontSize = if (needsMultiLine) multiLineFontSize else singleLineFontSize,
            lineHeight = if (needsMultiLine) multiLineHeight else TextUnit.Unspecified,
            color = MaterialTheme.colorScheme.onSurface,
            fontFamily = CascadiaMono,
            maxLines = if (needsMultiLine) 2 else 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
            onTextLayout = { result ->
                if (result.hasVisualOverflow) needsMultiLine = true
            },
        )
        Text(
            "▾",
            fontSize = 10.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
        )
    }
}

@Composable
fun SessionDropdown(
    expanded: Boolean,
    onDismiss: () -> Unit,
    sessions: Map<String, ManagedSession>,
    currentSessionId: String?,
    onSelect: (String) -> Unit,
    onDestroy: (String) -> Unit,
    onRelaunch: (String) -> Unit,
    onNewSession: () -> Unit,
) {
    if (!expanded) return

    Popup(
        alignment = Alignment.TopCenter,
        onDismissRequest = onDismiss,
        properties = PopupProperties(focusable = true),
    ) {
        // Scrim + centered card
        Box(
            modifier = Modifier
                .fillMaxSize()
                .clickable(
                    indication = null,
                    interactionSource = remember { MutableInteractionSource() },
                ) { onDismiss() },
            contentAlignment = Alignment.TopCenter,
        ) {
            Card(
                modifier = Modifier
                    .padding(top = 48.dp, start = 16.dp, end = 16.dp)
                    .widthIn(max = 320.dp)
                    .shadow(8.dp, RoundedCornerShape(12.dp))
                    .clickable(
                        indication = null,
                        interactionSource = remember { MutableInteractionSource() },
                    ) { /* consume clicks so they don't hit the scrim */ },
                shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            ) {
                Column(modifier = Modifier.padding(vertical = 4.dp)) {
                    sessions.entries.sortedBy { it.value.createdAt }.forEach { (id, session) ->
                        val name by session.name.collectAsState()
                        val status by session.status.collectAsState()
                        val isCurrent = id == currentSessionId

                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { onSelect(id); onDismiss() }
                                .padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            StatusDot(status)
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    name,
                                    fontSize = 13.sp,
                                    fontFamily = CascadiaMono,
                                    color = if (isCurrent) MaterialTheme.colorScheme.primary
                                            else MaterialTheme.colorScheme.onSurface,
                                )
                                Row(
                                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(
                                        session.cwd.name,
                                        fontSize = 11.sp,
                                        fontFamily = CascadiaMono,
                                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                                    )
                                    if (session.dangerousMode) {
                                        Text(
                                            "SKIP PERMISSIONS",
                                            fontSize = 9.sp,
                                            fontFamily = CascadiaMono,
                                            color = MaterialTheme.colorScheme.error,
                                        )
                                    }
                                }
                            }
                            if (status == SessionStatus.Dead) {
                                TextButton(onClick = { onRelaunch(id); onDismiss() }) {
                                    Text("Relaunch", fontSize = 11.sp)
                                }
                            } else {
                                Icon(
                                    Icons.Default.Close,
                                    contentDescription = "Close session",
                                    modifier = Modifier
                                        .size(18.dp)
                                        .clickable { onDestroy(id); onDismiss() },
                                    tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f),
                                )
                            }
                        }
                    }

                    HorizontalDivider(modifier = Modifier.padding(horizontal = 8.dp))

                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onNewSession(); onDismiss() }
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(16.dp))
                        Text("New Session", fontSize = 13.sp, fontFamily = CascadiaMono)
                    }
                }
            }
        }
    }
}

@Composable
fun StatusDot(status: SessionStatus, modifier: Modifier = Modifier) {
    val color = when (status) {
        SessionStatus.Active -> Color(0xFF4CAF50)
        SessionStatus.AwaitingApproval -> Color(0xFFFF9800)
        SessionStatus.Idle -> Color(0xFF666666)
        SessionStatus.Dead -> Color(0xFFDD4444)
    }
    Box(
        modifier = modifier
            .size(8.dp)
            .clip(CircleShape)
            .background(color)
    )
}
