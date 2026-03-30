package com.destin.code.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.destin.code.runtime.BaseTerminalViewClient
import com.destin.code.runtime.SessionService
import com.termux.view.TerminalView
import java.io.File

/** Apply theme-appropriate foreground/background/cursor colors to a terminal emulator. */
private fun applyTerminalColors(session: com.termux.terminal.TerminalSession?, isDark: Boolean) {
    val emulator = session?.emulator ?: return
    if (isDark) {
        emulator.mColors.tryParseColor(256, "#E0E0E0") // foreground
        emulator.mColors.tryParseColor(257, "#0A0A0A") // background
        emulator.mColors.tryParseColor(258, "#E0E0E0") // cursor
    } else {
        emulator.mColors.tryParseColor(256, "#D8D8D8")
        emulator.mColors.tryParseColor(257, "#2A2A2A")
        emulator.mColors.tryParseColor(258, "#D8D8D8")
        emulator.mColors.tryParseColor(0, "#3A3A3A")
        emulator.mColors.tryParseColor(1, "#F07070")
        emulator.mColors.tryParseColor(2, "#70D070")
        emulator.mColors.tryParseColor(3, "#D0C060")
        emulator.mColors.tryParseColor(4, "#70A0E0")
        emulator.mColors.tryParseColor(5, "#C080D0")
        emulator.mColors.tryParseColor(6, "#60C8C8")
        emulator.mColors.tryParseColor(7, "#C8C8C8")
        emulator.mColors.tryParseColor(8, "#606060")
        emulator.mColors.tryParseColor(9, "#FF8888")
        emulator.mColors.tryParseColor(10, "#88E888")
        emulator.mColors.tryParseColor(11, "#E8D878")
        emulator.mColors.tryParseColor(12, "#88B8F0")
        emulator.mColors.tryParseColor(13, "#D898E0")
        emulator.mColors.tryParseColor(14, "#78D8D8")
        emulator.mColors.tryParseColor(15, "#E8E8E8")
    }
}

enum class ScreenMode { Chat, Terminal }

@Composable
fun ChatScreen(service: SessionService) {
    val sessions by service.sessionRegistry.sessions.collectAsState()
    val currentSessionId by service.sessionRegistry.currentSessionId.collectAsState()
    val currentSession = currentSessionId?.let { sessions[it] }

    var screenMode by remember { mutableStateOf(ScreenMode.Chat) }

    // Auto-switch to terminal for shell sessions
    LaunchedEffect(currentSession?.shellMode) {
        if (currentSession?.shellMode == true) {
            screenMode = ScreenMode.Terminal
        }
    }

    val context = LocalContext.current
    val isDark = com.destin.code.ui.theme.LocalIsDarkTheme.current

    var showTierDialog by remember { mutableStateOf(false) }
    var showManageDirectories by remember { mutableStateOf(false) }
    var showAbout by remember { mutableStateOf(false) }

    val workingDirStore = remember(service.bootstrap) {
        service.bootstrap?.let { com.destin.code.config.WorkingDirStore(it.homeDir) }
    }
    val tierStore = remember { com.destin.code.config.TierStore(context) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF111111))
            .statusBarsPadding()
            .navigationBarsPadding()
    ) {
        // WebView — always alive, React handles its own empty state
        Box(
            modifier = Modifier
                .fillMaxSize()
                .then(
                    if (screenMode == ScreenMode.Chat) Modifier
                    else Modifier.size(0.dp)
                )
        ) {
            WebViewHost(modifier = Modifier.fillMaxSize())
        }

        if (currentSession != null) {

            // Terminal — shown when toggled or when session is a shell
            if (screenMode == ScreenMode.Terminal) {
                val termViewClient = remember { BaseTerminalViewClient() }
                val termScreenVersion by currentSession.screenVersion.collectAsState()
                var userScrolledUp by remember { mutableStateOf(false) }
                var attachedSession by remember { mutableStateOf<com.termux.terminal.TerminalSession?>(null) }
                val borderColor = com.destin.code.ui.theme.DestinCodeTheme.extended.surfaceBorder

                Column(modifier = Modifier.fillMaxSize()) {
                    Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                        AndroidView(
                            factory = { ctx ->
                                val termSession = currentSession.getTerminalSession()
                                TerminalView(ctx, null).apply {
                                    setTextSize((12 * resources.displayMetrics.scaledDensity).toInt())
                                    setTerminalViewClient(termViewClient)
                                    isFocusable = true
                                    isFocusableInTouchMode = true
                                    termSession?.let {
                                        attachSession(it)
                                        attachedSession = it
                                    }
                                }
                            },
                            update = { view ->
                                val session = currentSession.getTerminalSession()
                                if (session != null && session !== attachedSession) {
                                    view.attachSession(session)
                                    attachedSession = session
                                }
                                applyTerminalColors(session, isDark)
                                val termBgColor = if (isDark) 0xFF0A0A0A.toInt() else 0xFF2A2A2A.toInt()
                                view.setBackgroundColor(termBgColor)
                                @Suppress("UNUSED_EXPRESSION")
                                termScreenVersion
                                try {
                                    val wasScrolledUp = view.topRow < 0
                                    if (wasScrolledUp) userScrolledUp = true
                                    if (userScrolledUp && wasScrolledUp) {
                                        val saved = view.topRow
                                        view.onScreenUpdated()
                                        view.topRow = saved
                                    } else {
                                        userScrolledUp = false
                                        view.onScreenUpdated()
                                    }
                                } catch (_: Exception) {
                                    // Termux TerminalBuffer throws during resize race — safe to ignore
                                }
                            },
                            modifier = Modifier.fillMaxSize(),
                        )

                        // Floating up/down arrows — overlaid on terminal, bottom-right
                        Column(
                            modifier = Modifier
                                .align(Alignment.BottomEnd)
                                .padding(end = 8.dp, bottom = 8.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            FloatingArrowButton(
                                icon = Icons.Filled.KeyboardArrowUp,
                                contentDescription = "Up",
                                borderColor = borderColor,
                                onClick = { currentSession.writeInput("\u001b[A") },
                            )
                            FloatingArrowButton(
                                icon = Icons.Filled.KeyboardArrowDown,
                                contentDescription = "Down",
                                borderColor = borderColor,
                                onClick = { currentSession.writeInput("\u001b[B") },
                            )
                        }
                    }

                    HorizontalDivider(color = borderColor, thickness = 0.5.dp)
                    TerminalKeyboardRow(
                        onKeyPress = { key -> currentSession.writeInput(key) },
                        permissionMode = currentSession.permissionMode,
                        hasBypassMode = currentSession.dangerousMode,
                        onPermissionCycle = { currentSession.writeInput("\u001b[Z") },
                    )
                }
            }

            // Native floating toggle button — switches between Chat and Terminal
            FloatingViewToggle(
                screenMode = screenMode,
                onToggle = {
                    screenMode = if (screenMode == ScreenMode.Chat) ScreenMode.Terminal else ScreenMode.Chat
                },
            )
        }
    }

    // ── Overlay screens ────────────────────────────────────────────────
    if (showTierDialog) {
        TierPickerDialog(
            tierStore = tierStore,
            context = context,
            onDismiss = { showTierDialog = false },
        )
    }

    if (showManageDirectories && workingDirStore != null && service.bootstrap != null) {
        ManageDirectoriesScreen(
            homeDir = service.bootstrap!!.homeDir,
            workingDirStore = workingDirStore,
            onBack = { showManageDirectories = false },
        )
    }

    if (showAbout) {
        AboutScreen(onBack = { showAbout = false })
    }
}

// ─── Floating View Toggle ───────────────────────────────────────────────────

@Composable
private fun FloatingViewToggle(screenMode: ScreenMode, onToggle: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        contentAlignment = Alignment.BottomEnd,
    ) {
        Box(
            modifier = Modifier
                .clip(RoundedCornerShape(20.dp))
                .background(Color(0xFF333333))
                .clickable { onToggle() }
                .padding(horizontal = 16.dp, vertical = 10.dp),
        ) {
            Text(
                text = if (screenMode == ScreenMode.Chat) "Terminal" else "Chat",
                color = Color(0xFFE0E0E0),
                fontSize = 13.sp,
                fontFamily = com.destin.code.ui.theme.CascadiaMono,
            )
        }
    }
}

// ─── Tier Picker Dialog ─────────────────────────────────────────────────────

@Composable
private fun TierPickerDialog(
    tierStore: com.destin.code.config.TierStore,
    context: android.content.Context,
    onDismiss: () -> Unit,
) {
    var dialogTier by remember { mutableStateOf(tierStore.selectedTier) }
    var showRestartConfirm by remember { mutableStateOf(false) }

    if (!showRestartConfirm) {
        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text("Package Tier", fontSize = 16.sp, fontFamily = com.destin.code.ui.theme.CascadiaMono) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    com.destin.code.config.PackageTier.entries.forEach { tier ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(6.dp))
                                .then(
                                    if (dialogTier == tier)
                                        Modifier.background(MaterialTheme.colorScheme.primary.copy(alpha = 0.15f))
                                    else Modifier
                                )
                                .clickable { dialogTier = tier }
                                .padding(horizontal = 10.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(
                                if (dialogTier == tier) "●" else "○",
                                fontSize = 10.sp,
                                color = if (dialogTier == tier)
                                    MaterialTheme.colorScheme.primary
                                else
                                    MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f),
                            )
                            Column {
                                Text(tier.displayName, fontWeight = FontWeight.Bold, fontSize = 13.sp, fontFamily = com.destin.code.ui.theme.CascadiaMono)
                                Text(tier.description, fontSize = 11.sp, fontFamily = com.destin.code.ui.theme.CascadiaMono, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                            }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    if (dialogTier != tierStore.selectedTier) {
                        tierStore.selectedTier = dialogTier
                        showRestartConfirm = true
                    } else {
                        onDismiss()
                    }
                }) { Text("Save") }
            },
            dismissButton = {
                TextButton(onClick = onDismiss) { Text("Cancel") }
            },
        )
    } else {
        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text("Tier Updated", fontSize = 16.sp, fontFamily = com.destin.code.ui.theme.CascadiaMono) },
            text = {
                Text("Package tier changed to ${dialogTier.displayName}. Restart now to install new packages.")
            },
            confirmButton = {
                TextButton(onClick = {
                    val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
                    if (launchIntent != null) {
                        launchIntent.addFlags(
                            Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
                        )
                        context.startActivity(launchIntent)
                    }
                    kotlin.system.exitProcess(0)
                }) { Text("Restart Now") }
            },
            dismissButton = {
                TextButton(onClick = onDismiss) { Text("Later") }
            },
        )
    }
}

// ─── Floating Arrow Button ──────────────────────────────────────────────────

@Composable
private fun FloatingArrowButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    contentDescription: String,
    borderColor: androidx.compose.ui.graphics.Color,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(32.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.9f))
            .border(0.5.dp, borderColor.copy(alpha = 0.5f), RoundedCornerShape(6.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            icon,
            contentDescription = contentDescription,
            tint = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.size(20.dp),
        )
    }
}
