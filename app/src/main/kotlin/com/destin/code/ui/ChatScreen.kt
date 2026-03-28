package com.destin.code.ui

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.ui.text.font.FontWeight
import com.destin.code.config.PackageTier
import com.destin.code.config.TierStore
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.destin.code.config.chipsForTier
import com.destin.code.runtime.BaseTerminalViewClient
import com.destin.code.runtime.DirectShellBridge
import com.destin.code.runtime.SessionService
import com.termux.view.TerminalView
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File

/** Apply theme-appropriate foreground/background/cursor colors to a terminal emulator. */
private fun applyTerminalColors(session: com.termux.terminal.TerminalSession?, isDark: Boolean) {
    val emulator = session?.emulator ?: return
    if (isDark) {
        emulator.mColors.tryParseColor(256, "#E0E0E0") // foreground
        emulator.mColors.tryParseColor(257, "#0A0A0A") // background
        emulator.mColors.tryParseColor(258, "#E0E0E0") // cursor
    } else {
        // Medium-dark terminal in light mode — readable without being full black
        emulator.mColors.tryParseColor(256, "#D8D8D8") // foreground (light gray on dark bg)
        emulator.mColors.tryParseColor(257, "#2A2A2A") // background (charcoal, not pure black)
        emulator.mColors.tryParseColor(258, "#D8D8D8") // cursor

        // Override 16 ANSI colors for better contrast on charcoal bg
        emulator.mColors.tryParseColor(0, "#3A3A3A")  // black (slightly visible)
        emulator.mColors.tryParseColor(1, "#F07070")  // red
        emulator.mColors.tryParseColor(2, "#70D070")  // green
        emulator.mColors.tryParseColor(3, "#D0C060")  // yellow
        emulator.mColors.tryParseColor(4, "#70A0E0")  // blue
        emulator.mColors.tryParseColor(5, "#C080D0")  // magenta
        emulator.mColors.tryParseColor(6, "#60C8C8")  // cyan
        emulator.mColors.tryParseColor(7, "#C8C8C8")  // white
        emulator.mColors.tryParseColor(8, "#606060")  // bright black (gray)
        emulator.mColors.tryParseColor(9, "#FF8888")  // bright red
        emulator.mColors.tryParseColor(10, "#88E888") // bright green
        emulator.mColors.tryParseColor(11, "#E8D878") // bright yellow
        emulator.mColors.tryParseColor(12, "#88B8F0") // bright blue
        emulator.mColors.tryParseColor(13, "#D898E0") // bright magenta
        emulator.mColors.tryParseColor(14, "#78D8D8") // bright cyan
        emulator.mColors.tryParseColor(15, "#E8E8E8") // bright white
    }
}

@Composable
fun ChatScreen(service: SessionService) {
    // Top-level mode: local sessions or remote desktop
    var remoteMode by remember { mutableStateOf(false) }

    if (remoteMode) {
        com.destin.code.ui.v2.RemoteDesktopScreen(
            onBack = { remoteMode = false },
        )
        return
    }

    val sessions by service.sessionRegistry.sessions.collectAsState()
    val currentSessionId by service.sessionRegistry.currentSessionId.collectAsState()
    val currentSession = currentSessionId?.let { sessions[it] }
    val bridge = currentSession?.ptyBridge
    val chatState = currentSession?.chatState ?: remember { ChatState() }

    val listState = rememberLazyListState()
    val coroutineScope = rememberCoroutineScope()
    var screenMode by remember { mutableStateOf(ScreenMode.Chat) }

    // Auto-switch to terminal mode for shell sessions
    LaunchedEffect(currentSession?.shellMode) {
        if (currentSession?.shellMode == true) {
            screenMode = ScreenMode.Shell
        }
    }
    val context = LocalContext.current
    val tierStore = remember { TierStore(context) }
    var showTierDialog by remember { mutableStateOf(false) }

    val workingDirStore = remember(service.bootstrap) {
        service.bootstrap?.let { com.destin.code.config.WorkingDirStore(it.homeDir) }
    }
    var showManageDirectories by remember { mutableStateOf(false) }
    var showAbout by remember { mutableStateOf(false) }

    // Session switcher state
    var switcherExpanded by remember { mutableStateOf(false) }
    var showNewSessionDialog by remember { mutableStateOf(false) }

    // Image attachment state
    var attachmentPaths by rememberSaveable { mutableStateOf(listOf<String>()) }
    var attachmentBitmap by remember { mutableStateOf<Bitmap?>(null) }

    LaunchedEffect(attachmentPaths) {
        attachmentBitmap = attachmentPaths.firstOrNull()?.let { path ->
            try {
                val opts = BitmapFactory.Options().apply { inSampleSize = 8 }
                BitmapFactory.decodeFile(path, opts)
            } catch (_: Exception) { null }
        }
    }

    val filePickerLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.GetMultipleContents()
    ) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        coroutineScope.launch(kotlinx.coroutines.Dispatchers.IO) {
            val homeDir = service.bootstrap?.homeDir ?: return@launch
            val attachDir = File(homeDir, "attachments").also { it.mkdirs() }
            val newPaths = mutableListOf<String>()
            for (selectedUri in uris) {
                val timestamp = System.currentTimeMillis()
                val mime = context.contentResolver.getType(selectedUri)
                val ext = when {
                    mime?.startsWith("image/png") == true -> "png"
                    mime?.startsWith("image/jpeg") == true || mime?.startsWith("image/jpg") == true -> "jpg"
                    mime?.startsWith("image/") == true -> mime.substringAfter("/")
                    else -> selectedUri.lastPathSegment?.substringAfterLast('.', "bin") ?: "bin"
                }
                val destFile = File(attachDir, "$timestamp.$ext")
                try {
                    context.contentResolver.openInputStream(selectedUri)?.use { input ->
                        destFile.outputStream().use { output -> input.copyTo(output) }
                    }
                    newPaths.add(destFile.absolutePath)
                } catch (_: Exception) {}
            }
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
                attachmentPaths = attachmentPaths + newPaths
            }
        }
    }

    val lastPtyOutput by (bridge?.lastPtyOutputTime?.collectAsState()
        ?: remember { mutableStateOf(0L) })

    // Auto-scroll is handled inside ScreenMode.Chat after displayItems is computed

    val isDark = com.destin.code.ui.theme.LocalIsDarkTheme.current

    Column(modifier = Modifier.fillMaxSize()) {
        if (currentSession != null) UnifiedTopBar(
            screenMode = screenMode,
            onModeChange = { newMode -> screenMode = newMode },
            currentSession = currentSession,
            switcherExpanded = switcherExpanded,
            onSwitcherToggle = { switcherExpanded = !switcherExpanded },
            settingsMenuContent = { onDismiss ->
                var themeSubmenuExpanded by remember { mutableStateOf(false) }
                val currentThemeMode = com.destin.code.ui.theme.LocalThemeMode.current
                val setThemeMode = com.destin.code.ui.theme.LocalSetThemeMode.current

                // Menu items styled to match desktop dark panel
                MenuItem("Package Tier") { onDismiss(); showTierDialog = true }
                MenuItem("Manage Directories") { onDismiss(); showManageDirectories = true }

                // Theme section
                MenuItem(
                    label = "Theme",
                    trailing = if (themeSubmenuExpanded) "▴" else "▾",
                ) { themeSubmenuExpanded = !themeSubmenuExpanded }

                androidx.compose.animation.AnimatedVisibility(
                    visible = themeSubmenuExpanded,
                    enter = androidx.compose.animation.expandVertically(
                        animationSpec = androidx.compose.animation.core.spring(
                            stiffness = androidx.compose.animation.core.Spring.StiffnessMedium,
                        ),
                    ) + androidx.compose.animation.fadeIn(),
                    exit = androidx.compose.animation.shrinkVertically() + androidx.compose.animation.fadeOut(),
                ) {
                    Column(
                        modifier = Modifier
                            .padding(start = 16.dp, end = 8.dp, bottom = 4.dp)
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(6.dp))
                            .background(Color(0xFF222222))
                            .padding(4.dp),
                    ) {
                        for (mode in com.destin.code.ui.theme.ThemeMode.entries) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(4.dp))
                                    .clickable { setThemeMode(mode); onDismiss() }
                                    .padding(horizontal = 10.dp, vertical = 6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Text(
                                    if (mode == currentThemeMode) "●" else "○",
                                    fontSize = 8.sp,
                                    color = if (mode == currentThemeMode) Color(0xFFB0B0B0)
                                    else Color(0xFF666666),
                                )
                                Text(
                                    mode.label,
                                    fontSize = 12.sp,
                                    fontFamily = com.destin.code.ui.theme.CascadiaMono,
                                    color = if (mode == currentThemeMode) Color(0xFFE0E0E0)
                                    else Color(0xFF999999),
                                )
                            }
                        }
                    }
                }

                // Divider
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 4.dp)
                        .height(0.5.dp)
                        .background(Color(0xFF333333)),
                )

                MenuItem("Connect to Desktop") { onDismiss(); remoteMode = true }
                MenuItem("Donate") {
                    onDismiss()
                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://buymeacoffee.com/itsdestin")))
                }

                // Divider
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 4.dp)
                        .height(0.5.dp)
                        .background(Color(0xFF333333)),
                )

                MenuItem("About", textColor = Color(0xFF666666)) {
                    onDismiss(); showAbout = true
                }
            },
            sessionDropdownContent = {
                SessionDropdown(
                    expanded = switcherExpanded,
                    onDismiss = { switcherExpanded = false },
                    sessions = sessions,
                    currentSessionId = currentSessionId,
                    onSelect = { service.sessionRegistry.switchTo(it) },
                    onDestroy = { service.destroySession(it) },
                    onRelaunch = {
                        service.sessionRegistry.relaunchSession(
                            it, service.bootstrap!!, null, service.titlesDir
                        )
                    },
                    onNewSession = { showNewSessionDialog = true },
                    knownDirs = workingDirStore?.allDirs()
                        ?: listOf("Home (~)" to service.bootstrap!!.homeDir),
                    onCreateSession = { cwd, dangerous, shell ->
                        if (shell) {
                            service.bootstrap?.let { bs ->
                                service.sessionRegistry.createShellSession(bs, service.titlesDir)
                            }
                        } else {
                            service.createSession(cwd, dangerous, null)
                        }
                    },
                )
            },
        )

        Box(modifier = Modifier.weight(1f).fillMaxSize()) {
        if (currentSession == null) {
            // No session — matches desktop's empty state
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color(0xFF111111)),
            ) {
                // Settings gear — top left, no background (matches desktop)
                Box(modifier = Modifier.align(Alignment.TopStart).padding(8.dp)) {
                    var emptyMenuExpanded by remember { mutableStateOf(false) }

                    Icon(
                        com.destin.code.ui.theme.AppIcons.SettingsGear,
                        contentDescription = "Settings",
                        tint = Color(0xFF999999),
                        modifier = Modifier
                            .size(16.dp)
                            .clickable { emptyMenuExpanded = true },
                    )

                    if (emptyMenuExpanded) {
                        ExpandingSettingsMenu(
                            onDismiss = { emptyMenuExpanded = false },
                        ) {
                            var emptyThemeSubmenuExpanded by remember { mutableStateOf(false) }
                            val currentThemeMode = com.destin.code.ui.theme.LocalThemeMode.current
                            val setThemeMode = com.destin.code.ui.theme.LocalSetThemeMode.current

                            DropdownMenuItem(
                                text = { Text("Theme", fontSize = 13.sp, fontFamily = com.destin.code.ui.theme.CascadiaMono) },
                                onClick = { emptyThemeSubmenuExpanded = !emptyThemeSubmenuExpanded },
                            )
                            if (emptyThemeSubmenuExpanded) {
                                for (mode in com.destin.code.ui.theme.ThemeMode.entries) {
                                    DropdownMenuItem(
                                        text = {
                                            Row(
                                                verticalAlignment = Alignment.CenterVertically,
                                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                            ) {
                                                Text(
                                                    if (mode == currentThemeMode) "●" else "○",
                                                    fontSize = 10.sp,
                                                    color = if (mode == currentThemeMode) Color(0xFFB0B0B0)
                                                    else Color(0xFF999999).copy(alpha = 0.4f),
                                                )
                                                Text(mode.label, fontSize = 12.sp, fontFamily = com.destin.code.ui.theme.CascadiaMono)
                                            }
                                        },
                                        onClick = { setThemeMode(mode); emptyMenuExpanded = false },
                                        modifier = Modifier.padding(start = 12.dp),
                                    )
                                }
                            }
                            DropdownMenuItem(
                                text = { Text("Donate", fontSize = 13.sp, fontFamily = com.destin.code.ui.theme.CascadiaMono) },
                                onClick = {
                                    emptyMenuExpanded = false
                                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://buymeacoffee.com/itsdestin")))
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("About", fontSize = 13.sp, fontFamily = com.destin.code.ui.theme.CascadiaMono) },
                                onClick = { emptyMenuExpanded = false; showAbout = true },
                            )
                        }
                    }
                }

                // Centered content
                // pickerMode: null = show buttons, "normal" or "dangerous" = show project picker
                var pickerMode by remember { mutableStateOf<String?>(null) }
                val knownDirs = workingDirStore?.allDirs()
                    ?: listOf("Home (~)" to (service.bootstrap?.homeDir ?: File("/")))
                var selectedDir by remember { mutableStateOf(knownDirs.firstOrNull()?.second) }

                Column(
                    modifier = Modifier.align(Alignment.Center),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    // "No Active Session" heading
                    Text(
                        "No Active Session",
                        fontSize = 20.sp,
                        fontFamily = com.destin.code.ui.theme.CascadiaMono,
                        color = Color(0xFF666666),
                    )

                    // WelcomeAppIcon
                    androidx.compose.foundation.Image(
                        painter = androidx.compose.ui.res.painterResource(com.destin.code.R.drawable.ic_welcome_mascot),
                        contentDescription = "DestinCode mascot",
                        modifier = Modifier.size(136.dp),
                    )

                    if (pickerMode == null) {
                        // Button group — show both session buttons
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Box(
                                modifier = Modifier
                                    .widthIn(min = 200.dp)
                                    .clip(RoundedCornerShape(8.dp))
                                    .background(Color(0xFFB0B0B0))
                                    .clickable {
                                        if (knownDirs.size <= 1) {
                                            // Only home — skip picker, create immediately
                                            service.createSession(knownDirs.first().second, false, null)
                                        } else {
                                            pickerMode = "normal"
                                        }
                                    }
                                    .padding(horizontal = 20.dp, vertical = 12.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    "New Session",
                                    fontSize = 18.sp,
                                    fontFamily = com.destin.code.ui.theme.CascadiaMono,
                                    color = Color(0xFF111111),
                                )
                            }

                            Box(
                                modifier = Modifier
                                    .clip(RoundedCornerShape(6.dp))
                                    .background(Color(0xFFDD4444).copy(alpha = 0.4f))
                                    .clickable {
                                        if (knownDirs.size <= 1) {
                                            service.createSession(knownDirs.first().second, true, null)
                                        } else {
                                            pickerMode = "dangerous"
                                        }
                                    }
                                    .padding(horizontal = 14.dp, vertical = 6.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                    Text(
                                        "New Session",
                                        fontSize = 18.sp,
                                        fontFamily = com.destin.code.ui.theme.CascadiaMono,
                                        fontWeight = FontWeight.Bold,
                                        color = Color(0xFFFCA5A5),
                                    )
                                    Text(
                                        "Dangerous Mode",
                                        fontSize = 10.sp,
                                        fontFamily = com.destin.code.ui.theme.CascadiaMono,
                                        color = Color(0xFFFCA5A5).copy(alpha = 0.7f),
                                    )
                                }
                            }
                        }
                    } else {
                        // Project picker — inline directory list with Continue button
                        val isDangerous = pickerMode == "dangerous"

                        Column(
                            modifier = Modifier
                                .widthIn(max = 280.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .background(Color(0xFF191919))
                                .border(1.dp, Color(0xFF333333), RoundedCornerShape(8.dp))
                                .padding(12.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(
                                "PROJECT FOLDER",
                                fontSize = 10.sp,
                                fontFamily = com.destin.code.ui.theme.CascadiaMono,
                                color = Color(0xFF666666),
                                letterSpacing = 1.sp,
                            )

                            // Directory list
                            knownDirs.forEach { (label, dir) ->
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clip(RoundedCornerShape(6.dp))
                                        .then(
                                            if (selectedDir == dir) Modifier.background(Color(0xFF222222))
                                            else Modifier
                                        )
                                        .clickable { selectedDir = dir }
                                        .padding(horizontal = 10.dp, vertical = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(
                                        if (selectedDir == dir) "●" else "○",
                                        fontSize = 10.sp,
                                        color = if (selectedDir == dir) Color(0xFFB0B0B0) else Color(0xFF666666),
                                        modifier = Modifier.padding(end = 8.dp),
                                    )
                                    Text(
                                        label,
                                        fontSize = 13.sp,
                                        fontFamily = com.destin.code.ui.theme.CascadiaMono,
                                        color = Color(0xFFE0E0E0),
                                    )
                                }
                            }

                            // Continue + Back buttons
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                // Back
                                Box(
                                    modifier = Modifier
                                        .clip(RoundedCornerShape(6.dp))
                                        .background(Color(0xFF333333))
                                        .clickable { pickerMode = null }
                                        .padding(horizontal = 12.dp, vertical = 8.dp),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        "Back",
                                        fontSize = 13.sp,
                                        fontFamily = com.destin.code.ui.theme.CascadiaMono,
                                        color = Color(0xFFE0E0E0),
                                    )
                                }

                                // Continue
                                Box(
                                    modifier = Modifier
                                        .weight(1f)
                                        .clip(RoundedCornerShape(6.dp))
                                        .background(
                                            if (isDangerous) Color(0xFFDD4444).copy(alpha = 0.6f)
                                            else Color(0xFFB0B0B0)
                                        )
                                        .clickable {
                                            selectedDir?.let { dir ->
                                                service.createSession(dir, isDangerous, null)
                                            }
                                        }
                                        .padding(horizontal = 12.dp, vertical = 8.dp),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        "Continue",
                                        fontSize = 13.sp,
                                        fontFamily = com.destin.code.ui.theme.CascadiaMono,
                                        color = if (isDangerous) Color(0xFFFCA5A5) else Color(0xFF111111),
                                    )
                                }
                            }
                        }
                    }
                }

                // "Connect to Desktop" pinned at bottom
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .padding(bottom = 24.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .border(1.dp, Color(0xFF333333), RoundedCornerShape(6.dp))
                        .clickable { remoteMode = true }
                        .padding(horizontal = 14.dp, vertical = 8.dp),
                ) {
                    Text(
                        "Connect to Desktop",
                        fontSize = 13.sp,
                        fontFamily = com.destin.code.ui.theme.CascadiaMono,
                        color = Color(0xFF666666),
                    )
                }
            }
        } else
        androidx.compose.animation.Crossfade(
            targetState = screenMode,
            animationSpec = androidx.compose.animation.core.tween(200),
            label = "screenMode",
        ) { mode -> when (mode) {
        ScreenMode.Terminal -> {
            val termFocusRequester = remember { FocusRequester() }
            val termViewClient = remember { BaseTerminalViewClient() }
            val termScreenVersion by (bridge?.screenVersion?.collectAsState()
                ?: remember { mutableStateOf(0) })
            // Track whether user has scrolled up — suppress auto-scroll while they browse history.
            // topRow < 0 means scrolled up; topRow == 0 means at the bottom.
            var userScrolledUp by remember { mutableStateOf(false) }
            // Track which session is currently attached to avoid re-attaching on every recomposition.
            // Re-attaching resets the terminal view, causing text to flicker (write/unwrite/rewrite).
            var attachedSession by remember { mutableStateOf<com.termux.terminal.TerminalSession?>(null) }

            Column(modifier = Modifier.fillMaxSize()) {
                val borderColor = com.destin.code.ui.theme.DestinCodeTheme.extended.surfaceBorder

                // Terminal view + floating arrows overlay
                Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                    AndroidView(
                        factory = { ctx ->
                            TerminalView(ctx, null).apply {
                                setTextSize((12 * resources.displayMetrics.scaledDensity).toInt())
                                setTerminalViewClient(termViewClient)
                                isFocusable = true
                                isFocusableInTouchMode = true
                                bridge?.getSession()?.let {
                                    attachSession(it)
                                    attachedSession = it
                                }
                            }
                        },
                        update = { view ->
                            // Only re-attach when the session object actually changes (e.g. session
                            // switch or relaunch). Re-attaching on every recomposition resets the
                            // terminal view, causing visible text flicker.
                            val session = bridge?.getSession()
                            if (session != null && session !== attachedSession) {
                                view.attachSession(session)
                                attachedSession = session
                            }
                            applyTerminalColors(session, isDark)
                            val termBgColor = if (isDark) 0xFF0A0A0A.toInt() else 0xFF2A2A2A.toInt()
                            view.setBackgroundColor(termBgColor)
                            @Suppress("UNUSED_EXPRESSION")
                            termScreenVersion
                            // Preserve user's scroll position when they've scrolled up into history.
                            // TerminalView.onScreenUpdated() unconditionally resets topRow to 0,
                            // causing aggressive rubber-banding when Claude is producing output.
                            val wasScrolledUp = view.topRow < 0
                            if (wasScrolledUp) userScrolledUp = true
                            if (userScrolledUp && wasScrolledUp) {
                                // Save position, let onScreenUpdated() process new content
                                // (clear scroll counter, clamp bounds, invalidate), then restore.
                                val saved = view.topRow
                                view.onScreenUpdated()
                                view.topRow = saved
                            } else {
                                // At bottom — resume normal auto-scroll.
                                userScrolledUp = false
                                view.onScreenUpdated()
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
                            onClick = { bridge?.writeInput("\u001b[A") },
                        )
                        FloatingArrowButton(
                            icon = Icons.Filled.KeyboardArrowDown,
                            contentDescription = "Down",
                            borderColor = borderColor,
                            onClick = { bridge?.writeInput("\u001b[B") },
                        )
                    }
                }

                HorizontalDivider(color = borderColor, thickness = 0.5.dp)
                TerminalInputBar(
                    focusRequester = termFocusRequester,
                    draft = chatState.inputDraft,
                    onDraftChange = { chatState.inputDraft = it },
                    onSend = { text ->
                        if (text.isNotBlank()) chatState.addUserMessage(text)
                        bridge?.writeInput(text + "\r")
                        chatState.clearDraft()
                    },
                    onKeyPress = { seq -> bridge?.writeInput(seq) },
                    onAttachImage = {
                        filePickerLauncher.launch("*/*")
                    },
                    hasAttachments = attachmentPaths.isNotEmpty(),
                    permissionMode = chatState.permissionMode,
                    hasBypassMode = currentSession?.dangerousMode == true,
                    onPermissionCycle = { chatState.permissionMode = it },
                )
            }
        }

        ScreenMode.Shell -> {
            val shellSession = currentSession ?: return@Crossfade
            val shellFocusRequester = remember { FocusRequester() }
            val shellViewClient = remember { BaseTerminalViewClient() }
            val shellScreenVersion by shellSession.screenVersion.collectAsState()
            var shellUserScrolledUp by remember { mutableStateOf(false) }
            var shellAttachedSession by remember { mutableStateOf<com.termux.terminal.TerminalSession?>(null) }

            Column(modifier = Modifier.fillMaxSize()) {
                val borderColor = com.destin.code.ui.theme.DestinCodeTheme.extended.surfaceBorder

                AndroidView(
                    factory = { ctx ->
                        TerminalView(ctx, null).apply {
                            setTextSize((12 * resources.displayMetrics.scaledDensity).toInt())
                            setTerminalViewClient(shellViewClient)
                            isFocusable = true
                            isFocusableInTouchMode = true
                            shellSession.getTerminalSession()?.let {
                                attachSession(it)
                                shellAttachedSession = it
                            }
                        }
                    },
                    update = { view ->
                        val session = shellSession.getTerminalSession()
                        if (session != null && session !== shellAttachedSession) {
                            view.attachSession(session)
                            shellAttachedSession = session
                        }
                        applyTerminalColors(session, isDark)
                        val shellTermBgColor = if (isDark) 0xFF0A0A0A.toInt() else 0xFF2A2A2A.toInt()
                        view.setBackgroundColor(shellTermBgColor)
                        @Suppress("UNUSED_EXPRESSION")
                        shellScreenVersion
                        val wasScrolledUp = view.topRow < 0
                        if (wasScrolledUp) shellUserScrolledUp = true
                        if (shellUserScrolledUp && wasScrolledUp) {
                            val saved = view.topRow
                            view.onScreenUpdated()
                            view.topRow = saved
                        } else {
                            shellUserScrolledUp = false
                            view.onScreenUpdated()
                        }
                    },
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                )

                HorizontalDivider(color = borderColor, thickness = 0.5.dp)
                TerminalInputBar(
                    focusRequester = shellFocusRequester,
                    draft = chatState.inputDraft,
                    onDraftChange = { chatState.inputDraft = it },
                    onSend = { text ->
                        shellSession.writeInput(text + "\r")
                        chatState.clearDraft()
                    },
                    onKeyPress = { seq -> shellSession.writeInput(seq) },
                    onAttachImage = {
                        filePickerLauncher.launch("*/*")
                    },
                    hasAttachments = attachmentPaths.isNotEmpty(),
                    permissionMode = chatState.permissionMode,
                    hasBypassMode = currentSession?.dangerousMode == true,
                    onPermissionCycle = { chatState.permissionMode = it },
                )
            }
        }

        ScreenMode.Chat -> {
            val reducer = currentSession?.chatReducer
                ?: remember { com.destin.code.ui.state.ChatReducer() }

            Column(modifier = Modifier.fillMaxSize()) {
                val borderColor = com.destin.code.ui.theme.DestinCodeTheme.extended.surfaceBorder

                // New turn-based chat view
                com.destin.code.ui.v2.ChatViewV2(
                    reducer = reducer,
                    onPromptAction = { promptId, input ->
                        bridge?.writeInput(input)
                        reducer.dispatch(
                            com.destin.code.ui.state.ChatAction.CompletePrompt(
                                promptId = promptId,
                                selection = input,
                            )
                        )
                        currentSession?.markPromptCompleted(promptId)
                    },
                    onAcceptTool = { tool ->
                        reducer.dispatch(
                            com.destin.code.ui.state.ChatAction.PermissionResponded(
                                requestId = tool.requestId ?: "",
                            )
                        )
                        if (tool.requestId != null) {
                            val decision = org.json.JSONObject()
                                .put("decision", org.json.JSONObject().put("behavior", "allow"))
                            bridge?.getEventBridge()?.respond(tool.requestId, decision)
                        } else {
                            android.util.Log.w("ChatScreen", "onAcceptTool: no requestId, falling back to PTY")
                            bridge?.sendApproval(com.destin.code.runtime.PtyBridge.ApprovalOption.Yes)
                        }
                    },
                    onAcceptAlwaysTool = { tool ->
                        reducer.dispatch(
                            com.destin.code.ui.state.ChatAction.PermissionResponded(
                                requestId = tool.requestId ?: "",
                            )
                        )
                        if (tool.requestId != null && !tool.permissionSuggestions.isNullOrEmpty()) {
                            // Parse the suggestion string back to a JSON object
                            val suggestionObj = try {
                                org.json.JSONObject(tool.permissionSuggestions[0])
                            } catch (_: Exception) {
                                // If it's not valid JSON, use it as a string
                                null
                            }
                            val permsArray = org.json.JSONArray()
                            if (suggestionObj != null) {
                                permsArray.put(suggestionObj)
                            } else {
                                permsArray.put(tool.permissionSuggestions[0])
                            }
                            val decision = org.json.JSONObject()
                                .put("decision", org.json.JSONObject()
                                    .put("behavior", "allow")
                                    .put("updatedPermissions", permsArray))
                            bridge?.getEventBridge()?.respond(tool.requestId, decision)
                        } else {
                            bridge?.sendApproval(com.destin.code.runtime.PtyBridge.ApprovalOption.YesAlways)
                        }
                    },
                    onRejectTool = { tool ->
                        reducer.dispatch(
                            com.destin.code.ui.state.ChatAction.PermissionResponded(
                                requestId = tool.requestId ?: "",
                            )
                        )
                        if (tool.requestId != null) {
                            val decision = org.json.JSONObject()
                                .put("decision", org.json.JSONObject().put("behavior", "deny"))
                            bridge?.getEventBridge()?.respond(tool.requestId, decision)
                        } else {
                            bridge?.sendApproval(com.destin.code.runtime.PtyBridge.ApprovalOption.No)
                        }
                    },
                    modifier = Modifier.weight(1f),
                )

                HorizontalDivider(color = borderColor, thickness = 0.5.dp)

                // Attachment thumbnail preview
                if (attachmentPaths.isNotEmpty()) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        attachmentBitmap?.let { bmp ->
                            Image(
                                bitmap = bmp.asImageBitmap(),
                                contentDescription = "Attached file",
                                modifier = Modifier
                                    .size(48.dp)
                                    .clip(RoundedCornerShape(6.dp)),
                            )
                        }
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            if (attachmentPaths.size == 1) "File attached"
                            else "${attachmentPaths.size} files attached",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                        )
                        Spacer(modifier = Modifier.weight(1f))
                        Icon(
                            Icons.Filled.Close,
                            contentDescription = "Remove attachments",
                            tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                            modifier = Modifier
                                .size(20.dp)
                                .clickable {
                                    attachmentPaths = emptyList()
                                    attachmentBitmap = null
                                },
                        )
                    }
                }

                // Input row — matches desktop: bg-gray-800 rounded-xl with icons inline
                val isAwaitingApproval = reducer.isAwaitingApproval()
                val inputIconColor = com.destin.code.ui.v2.ThemedColors.inputBarIcon

                // Send action extracted for reuse
                val sendMessage = {
                    val text = chatState.inputDraft.text
                    if (text.isNotBlank() || attachmentPaths.isNotEmpty()) {
                        val messageText = buildString {
                            for (path in attachmentPaths) {
                                appendLine("[File attached: $path]")
                            }
                            if (attachmentPaths.isNotEmpty()) appendLine()
                            append(text)
                        }.trim()
                        bridge?.writeInput(messageText + "\r")
                        chatState.clearDraft()
                        attachmentPaths = emptyList()
                        attachmentBitmap = null
                    }
                }

                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.background)
                        .padding(horizontal = 8.dp, vertical = 8.dp),
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(com.destin.code.ui.v2.ThemedColors.inputBarBg)
                            .padding(horizontal = 8.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        // Attach icon (desktop: AttachIcon w-5 h-5)
                        Icon(
                            com.destin.code.ui.theme.AppIcons.Attach,
                            contentDescription = "Attach file",
                            tint = if (attachmentPaths.isNotEmpty()) com.destin.code.ui.v2.ThemedColors.inputBarText else inputIconColor,
                            modifier = Modifier
                                .size(20.dp)
                                .clickable(enabled = !isAwaitingApproval) {
                                    filePickerLauncher.launch("*/*")
                                }
                                .alpha(if (isAwaitingApproval) 0.3f else 1f),
                        )

                        // Compass icon (desktop: CompassIcon w-5 h-5 — browse skills)
                        Icon(
                            com.destin.code.ui.theme.AppIcons.Compass,
                            contentDescription = "Browse skills",
                            tint = inputIconColor,
                            modifier = Modifier
                                .size(20.dp)
                                .clickable(enabled = !isAwaitingApproval) {
                                    // TODO: open command drawer
                                }
                                .alpha(if (isAwaitingApproval) 0.3f else 1f),
                        )

                        // Text input (desktop: flex-1 bg-transparent)
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .heightIn(min = 20.dp, max = 100.dp),
                            contentAlignment = Alignment.CenterStart,
                        ) {
                            val inputScrollState = rememberScrollState()
                            BasicTextField(
                                value = chatState.inputDraft,
                                onValueChange = { chatState.inputDraft = it },
                                cursorBrush = SolidColor(com.destin.code.ui.v2.ThemedColors.inputBarCursor),
                                singleLine = false,
                                maxLines = 3,
                                textStyle = androidx.compose.ui.text.TextStyle(
                                    fontSize = 14.sp,
                                    fontFamily = com.destin.code.ui.theme.CascadiaMono,
                                    color = com.destin.code.ui.v2.ThemedColors.inputBarText,
                                ),
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .verticalScroll(inputScrollState),
                                decorationBox = { innerTextField ->
                                    Box {
                                        if (chatState.inputDraft.text.isEmpty()) {
                                            Text(
                                                if (isAwaitingApproval) "Waiting for approval..." else "Message Claude...",
                                                fontSize = 14.sp,
                                                color = com.destin.code.ui.v2.ThemedColors.inputBarPlaceholder,
                                                fontFamily = com.destin.code.ui.theme.CascadiaMono,
                                            )
                                        }
                                        innerTextField()
                                    }
                                },
                            )
                        }

                        // Send button (desktop: w-7 h-7 bg-gray-300 rounded-lg)
                        val canSend = chatState.inputDraft.text.isNotBlank() || attachmentPaths.isNotEmpty()
                        Box(
                            modifier = Modifier
                                .size(28.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .background(
                                    if (canSend && !isAwaitingApproval) com.destin.code.ui.v2.ThemedColors.sendButtonBg
                                    else com.destin.code.ui.v2.ThemedColors.sendButtonBg.copy(alpha = 0.3f)
                                )
                                .clickable(enabled = canSend && !isAwaitingApproval) { sendMessage() },
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                com.destin.code.ui.theme.AppIcons.ArrowRight,
                                contentDescription = "Send",
                                tint = com.destin.code.ui.v2.ThemedColors.sendButtonIcon,
                                modifier = Modifier.size(16.dp),
                            )
                        }
                    }
                }

                // Quick chips
                QuickChips(
                    tier = tierStore.selectedTier,
                    onChipTap = { chip ->
                        chatState.setDraftText(chip.prompt)
                    }
                )
            }
        }

        } } // Crossfade + when
        } // Box(weight)
    } // Column(fillMaxSize)

    // Tier change dialog
    if (showTierDialog) {
        var dialogTier by remember { mutableStateOf(tierStore.selectedTier) }
        var showRestartConfirm by remember { mutableStateOf(false) }

        if (!showRestartConfirm) {
            AlertDialog(
                onDismissRequest = { showTierDialog = false },
                title = { Text("Package Tier", fontSize = 16.sp, fontFamily = com.destin.code.ui.theme.CascadiaMono) },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        PackageTier.entries.forEach { tier ->
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
                                    Text(tier.displayName, fontWeight = FontWeight.Bold, fontSize = 13.sp,
                                        fontFamily = com.destin.code.ui.theme.CascadiaMono)
                                    Text(tier.description, fontSize = 11.sp,
                                        fontFamily = com.destin.code.ui.theme.CascadiaMono,
                                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
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
                            showTierDialog = false
                        }
                    }) { Text("Save") }
                },
                dismissButton = {
                    TextButton(onClick = { showTierDialog = false }) { Text("Cancel") }
                },
            )
        } else {
            AlertDialog(
                onDismissRequest = { showTierDialog = false },
                title = { Text("Tier Updated", fontSize = 16.sp, fontFamily = com.destin.code.ui.theme.CascadiaMono) },
                text = {
                    Text("Package tier changed to ${dialogTier.displayName}. " +
                        "Restart now to install new packages.")
                },
                confirmButton = {
                    TextButton(onClick = {
                        // Kill process and relaunch — bootstrap will install missing packages
                        val launchIntent = context.packageManager
                            .getLaunchIntentForPackage(context.packageName)
                        if (launchIntent != null) {
                            launchIntent.addFlags(
                                android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP or
                                android.content.Intent.FLAG_ACTIVITY_NEW_TASK
                            )
                            context.startActivity(launchIntent)
                        }
                        kotlin.system.exitProcess(0)
                    }) { Text("Restart Now") }
                },
                dismissButton = {
                    TextButton(onClick = {
                        showTierDialog = false
                    }) { Text("Later") }
                },
            )
        }
    }

    // New session dialog
    if (showNewSessionDialog) {
        if (service.sessionRegistry.sessionCount >= 5) {
            AlertDialog(
                onDismissRequest = { showNewSessionDialog = false },
                title = { Text("Session Limit", fontSize = 16.sp, fontFamily = com.destin.code.ui.theme.CascadiaMono) },
                text = { Text("You have 5 active sessions. Close one before creating a new session.") },
                confirmButton = {
                    TextButton(onClick = { showNewSessionDialog = false }) { Text("OK") }
                },
            )
        } else {
            val knownDirs = workingDirStore?.allDirs() ?: listOf("Home (~)" to service.bootstrap!!.homeDir)
            NewSessionDialog(
                knownDirs = knownDirs,
                homeDir = service.bootstrap!!.homeDir,
                onDismiss = { showNewSessionDialog = false },
                centered = currentSession == null,
                onCreate = { config ->
                    showNewSessionDialog = false
                    if (config.shellMode) {
                        service.bootstrap?.let { bs ->
                            service.sessionRegistry.createShellSession(bs, service.titlesDir)
                        }
                    } else {
                        service.createSession(config.cwd, config.dangerousMode, null)
                    }
                },
                onAddDirectory = { dir ->
                    workingDirStore?.add(
                        com.destin.code.config.WorkingDir(label = dir.name, path = dir.absolutePath)
                    )
                },
            )
        }
    }

    if (showManageDirectories && workingDirStore != null) {
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

/** Visible terminal input bar */
@Composable
private fun TerminalInputBar(
    focusRequester: FocusRequester,
    draft: TextFieldValue,
    onDraftChange: (TextFieldValue) -> Unit,
    onSend: (String) -> Unit,
    onKeyPress: (String) -> Unit,
    onAttachImage: (() -> Unit)? = null,
    hasAttachments: Boolean = false,
    permissionMode: String = "Normal",
    hasBypassMode: Boolean = false,
    onPermissionCycle: ((String) -> Unit)? = null,
) {
    val borderColor = com.destin.code.ui.theme.DestinCodeTheme.extended.surfaceBorder

    Column {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 6.dp, vertical = 5.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Box(
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = 42.dp, max = 120.dp)
                    .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                    .background(MaterialTheme.colorScheme.surface)
                    .border(0.5.dp, borderColor.copy(alpha = 0.5f),
                        androidx.compose.foundation.shape.RoundedCornerShape(6.dp)),
                contentAlignment = Alignment.TopStart,
            ) {
                BasicTextField(
                    value = draft,
                    onValueChange = onDraftChange,
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    singleLine = false,
                    maxLines = 5,
                    textStyle = androidx.compose.ui.text.TextStyle(
                        fontSize = 14.sp,
                        fontFamily = com.destin.code.ui.theme.CascadiaMono,
                        color = MaterialTheme.colorScheme.onSurface,
                    ),
                    keyboardOptions = KeyboardOptions(
                        imeAction = ImeAction.Send,
                    ),
                    keyboardActions = KeyboardActions(onSend = {
                        onSend(draft.text)
                    }),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 10.dp, vertical = 10.dp)
                        .focusRequester(focusRequester),
                    decorationBox = { innerTextField ->
                        Box(modifier = Modifier.fillMaxWidth()) {
                            Box(modifier = Modifier
                                .fillMaxWidth()
                                .padding(end = if (onAttachImage != null) 24.dp else 0.dp)) {
                                if (draft.text.isEmpty()) {
                                    Text(
                                        "Type a message...",
                                        fontSize = 14.sp,
                                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f),
                                    )
                                }
                                innerTextField()
                            }
                            if (onAttachImage != null) {
                                Icon(
                                    com.destin.code.ui.theme.AppIcons.Attach,
                                    contentDescription = "Attach file",
                                    tint = if (hasAttachments)
                                        Color(0xFFB0B0B0)
                                    else
                                        Color(0xFF555555),
                                    modifier = Modifier
                                        .size(20.dp)
                                        .align(Alignment.BottomEnd)
                                        .clickable { onAttachImage() },
                                )
                            }
                        }
                    },
                )
            }

            // Send button
            Box(
                modifier = Modifier
                    .size(42.dp)
                    .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                    .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.15f))
                    .border(0.5.dp, borderColor.copy(alpha = 0.5f),
                        androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                    .clickable { onSend(draft.text) },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.AutoMirrored.Filled.Send,
                    contentDescription = "Send",
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(16.dp),
                )
            }
        }

        TerminalKeyboardRow(
            onKeyPress = onKeyPress,
            permissionMode = permissionMode,
            hasBypassMode = hasBypassMode,
            onPermissionCycle = onPermissionCycle,
        )
    }
}

/** Styled settings menu item matching desktop dark panel aesthetic. */
@Composable
private fun MenuItem(
    label: String,
    textColor: Color = Color(0xFFE0E0E0),
    trailing: String? = null,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            label,
            fontSize = 13.sp,
            fontFamily = com.destin.code.ui.theme.CascadiaMono,
            color = textColor,
        )
        if (trailing != null) {
            Text(
                trailing,
                fontSize = 10.sp,
                color = Color(0xFF666666),
            )
        }
    }
}

@Composable
private fun FloatingArrowButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    contentDescription: String,
    borderColor: androidx.compose.ui.graphics.Color,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(42.dp)
            .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
            .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.95f))
            .border(0.5.dp, borderColor.copy(alpha = 0.5f),
                androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            icon,
            contentDescription = contentDescription,
            tint = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.size(22.dp),
        )
    }
}
