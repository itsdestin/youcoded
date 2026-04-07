package com.destin.code.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.destin.code.runtime.BaseTerminalViewClient
import com.destin.code.runtime.SessionService
import com.termux.view.TerminalView
import java.io.File
import androidx.compose.ui.Alignment

/** Apply dark terminal colors to a terminal emulator. */
private fun applyTerminalColors(session: com.termux.terminal.TerminalSession?) {
    val emulator = session?.emulator ?: return
    emulator.mColors.tryParseColor(256, "#E0E0E0") // foreground
    emulator.mColors.tryParseColor(257, "#0A0A0A") // background
    emulator.mColors.tryParseColor(258, "#E0E0E0") // cursor
}

enum class ScreenMode { Chat, Terminal }

@Composable
fun ChatScreen(service: SessionService) {
    val sessions by service.sessionRegistry.sessions.collectAsState()
    val currentSessionId by service.sessionRegistry.currentSessionId.collectAsState()
    val currentSession = currentSessionId?.let { sessions[it] }

    var screenMode by remember { mutableStateOf(ScreenMode.Chat) }

    // React UI and native code send view switch requests via SharedFlow
    LaunchedEffect(Unit) {
        service.viewModeRequest.collect { mode ->
            when (mode) {
                "terminal" -> screenMode = ScreenMode.Terminal
                "chat" -> screenMode = ScreenMode.Chat
            }
        }
    }

    // Auto-switch to terminal for shell sessions
    LaunchedEffect(currentSession?.shellMode) {
        if (currentSession?.shellMode == true) {
            screenMode = ScreenMode.Terminal
        }
    }

    // Layout insets from React UI (header and bottom bar heights in px)
    var headerHeightPx by remember { mutableIntStateOf(0) }
    var bottomBarHeightPx by remember { mutableIntStateOf(0) }

    LaunchedEffect(Unit) {
        service.layoutInsets.collect { insets ->
            headerHeightPx = insets.headerPx
            bottomBarHeightPx = insets.bottomPx
        }
    }

    val density = LocalDensity.current
    val headerHeightDp = with(density) { headerHeightPx.toDp() }
    val bottomBarHeightDp = with(density) { bottomBarHeightPx.toDp() }

    val context = LocalContext.current

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
        // Layer 1 (behind): Native terminal — padded to fit the React UI "hole"
        if (currentSession != null && screenMode == ScreenMode.Terminal) {
            key(currentSessionId) {
                val termViewClient = remember { BaseTerminalViewClient() }
                val termScreenVersion by currentSession.screenVersion.collectAsState()
                var userScrolledUp by remember { mutableStateOf(false) }
                var attachedSession by remember { mutableStateOf<com.termux.terminal.TerminalSession?>(null) }

                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(top = headerHeightDp, bottom = bottomBarHeightDp)
                ) {
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
                            applyTerminalColors(session)
                            view.setBackgroundColor(0xFF0A0A0A.toInt())
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
                }
            } // key(currentSessionId)
        }

        // Layer 2 (on top): WebView — ALWAYS full size, transparent middle lets terminal show through
        WebViewHost(modifier = Modifier.fillMaxSize())
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
