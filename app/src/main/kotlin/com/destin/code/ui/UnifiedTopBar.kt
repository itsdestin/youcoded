package com.destin.code.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destin.code.runtime.ManagedSession
import com.destin.code.ui.theme.AppIcons
import com.destin.code.ui.theme.CascadiaMono
import com.destin.code.ui.theme.DestinCodeTheme

enum class ScreenMode { Chat, Terminal, Shell }

@Composable
fun UnifiedTopBar(
    screenMode: ScreenMode,
    onModeChange: (ScreenMode) -> Unit,
    currentSession: ManagedSession?,
    switcherExpanded: Boolean,
    onSwitcherToggle: () -> Unit,
    // Settings menu content
    settingsMenuContent: @Composable (onDismiss: () -> Unit) -> Unit,
    // Session dropdown content
    sessionDropdownContent: @Composable () -> Unit,
) {
    val borderColor = DestinCodeTheme.extended.surfaceBorder
    val pillShape = RoundedCornerShape(6.dp)
    val pillModifier = Modifier
        .height(34.dp)
        .clip(pillShape)
        .background(MaterialTheme.colorScheme.surface)
        .border(0.5.dp, borderColor.copy(alpha = 0.5f), pillShape)

    Column {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.background)
                .padding(horizontal = 6.dp, vertical = 5.dp),
        ) {
            // LEFT: Settings button
            Box(modifier = Modifier.align(Alignment.CenterStart)) {
                var menuExpanded by remember { mutableStateOf(false) }

                Box(
                    modifier = pillModifier
                        .clickable { menuExpanded = true }
                        .padding(horizontal = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Default.Settings,
                        contentDescription = "Settings",
                        tint = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.size(18.dp),
                    )
                }

                DropdownMenu(
                    expanded = menuExpanded,
                    onDismissRequest = { menuExpanded = false },
                    containerColor = MaterialTheme.colorScheme.surface,
                ) {
                    settingsMenuContent { menuExpanded = false }
                }
            }

            // CENTER: Session selector pill
            Box(modifier = Modifier.align(Alignment.Center)) {
                SessionSwitcherPill(
                    currentSession = currentSession,
                    expanded = switcherExpanded,
                    onToggle = onSwitcherToggle,
                )
                sessionDropdownContent()
            }

            // RIGHT: Chat/Terminal segmented toggle — tap anywhere to switch
            Box(modifier = Modifier.align(Alignment.CenterEnd)) {
                Row(
                    modifier = pillModifier
                        .clickable {
                            val next = when (screenMode) {
                                ScreenMode.Chat -> ScreenMode.Terminal
                                else -> ScreenMode.Chat
                            }
                            onModeChange(next)
                        }
                        .padding(horizontal = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // Chat segment
                    Box(
                        modifier = Modifier
                            .height(30.dp)
                            .clip(RoundedCornerShape(4.dp))
                            .then(
                                if (screenMode == ScreenMode.Chat)
                                    Modifier.background(
                                        MaterialTheme.colorScheme.onSurface.copy(alpha = 0.1f)
                                    )
                                else Modifier
                            )
                            .padding(horizontal = 8.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            AppIcons.Chat,
                            contentDescription = "Chat",
                            tint = MaterialTheme.colorScheme.onSurface.copy(
                                alpha = if (screenMode == ScreenMode.Chat) 1f else 0.4f
                            ),
                            modifier = Modifier.size(18.dp),
                        )
                    }

                    // Terminal segment
                    Box(
                        modifier = Modifier
                            .height(30.dp)
                            .clip(RoundedCornerShape(4.dp))
                            .then(
                                when (screenMode) {
                                    ScreenMode.Terminal -> Modifier.background(
                                        MaterialTheme.colorScheme.onSurface.copy(alpha = 0.1f)
                                    )
                                    ScreenMode.Shell -> Modifier.background(
                                        MaterialTheme.colorScheme.tertiaryContainer
                                    )
                                    else -> Modifier
                                }
                            )
                            .padding(horizontal = 8.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            AppIcons.Terminal,
                            contentDescription = "Terminal",
                            tint = MaterialTheme.colorScheme.onSurface.copy(
                                alpha = if (screenMode != ScreenMode.Chat) 1f else 0.4f
                            ),
                            modifier = Modifier.size(18.dp),
                        )
                    }
                }
            }
        }

        HorizontalDivider(color = borderColor, thickness = 0.5.dp)
    }
}
