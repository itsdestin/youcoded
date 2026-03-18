package com.destins.claudemobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destins.claudemobile.runtime.ManagedSession
import com.destins.claudemobile.runtime.SessionStatus
import com.destins.claudemobile.ui.theme.CascadiaMono

@Composable
fun SessionSwitcherPill(
    currentSession: ManagedSession?,
    expanded: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val name by currentSession?.name?.collectAsState() ?: remember { mutableStateOf("No Session") }
    val status by currentSession?.status?.collectAsState() ?: remember { mutableStateOf(SessionStatus.Dead) }

    Row(
        modifier = modifier
            .clip(RoundedCornerShape(6.dp))
            .clickable { onToggle() }
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        StatusDot(status)
        Text(
            "▾",
            fontSize = 10.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
        )
        Text(
            name,
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurface,
            fontFamily = CascadiaMono,
            maxLines = 1,
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
    DropdownMenu(
        expanded = expanded,
        onDismissRequest = onDismiss,
        offset = DpOffset(0.dp, 4.dp),
    ) {
        sessions.entries.sortedBy { it.value.createdAt }.forEach { (id, session) ->
            val name by session.name.collectAsState()
            val status by session.status.collectAsState()
            val isCurrent = id == currentSessionId

            DropdownMenuItem(
                text = {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        StatusDot(status)
                        Text(
                            name,
                            fontSize = 13.sp,
                            fontFamily = CascadiaMono,
                            color = if (isCurrent) MaterialTheme.colorScheme.primary
                                    else MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.weight(1f),
                        )
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
                },
                onClick = { onSelect(id); onDismiss() },
            )
        }

        HorizontalDivider()

        DropdownMenuItem(
            text = {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(16.dp))
                    Text("New Session", fontSize = 13.sp)
                }
            },
            onClick = { onNewSession(); onDismiss() },
        )
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
