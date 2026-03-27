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
import com.destin.code.ui.cards.ToolGroupCard
import com.destin.code.runtime.BaseTerminalViewClient
import com.destin.code.runtime.DirectShellBridge
import com.destin.code.runtime.SessionService
import com.termux.view.TerminalView
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File

/** A display item in the chat list — either a single message or a collapsed group of tool calls. */
private sealed class DisplayItem {
    data class Single(val message: ChatMessage) : DisplayItem()
    data class ToolGroup(val messages: List<ChatMessage>, val key: String) : DisplayItem()
}

/** Returns true if this message is a completed or failed tool call (should be grouped). */
private fun ChatMessage.isFinishedTool(): Boolean =
    content is MessageContent.ToolComplete || content is MessageContent.ToolFailed

/**
 * Groups consecutive finished tool calls into [DisplayItem.ToolGroup]s.
 * Active tools (Running, AwaitingApproval) and all non-tool messages stay individual.
 * Only groups runs of 2+ consecutive finished tools; a single finished tool stays individual.
 */
private fun groupMessages(messages: List<ChatMessage>): List<DisplayItem> {
    val result = mutableListOf<DisplayItem>()
    var i = 0
    while (i < messages.size) {
        if (messages[i].isFinishedTool()) {
            // Collect the consecutive run of finished tools
            val start = i
            while (i < messages.size && messages[i].isFinishedTool()) i++
            val group = messages.subList(start, i)
            if (group.size >= 2) {
                // Use first message's id as stable key for the group
                result.add(DisplayItem.ToolGroup(group, "group_${group.first().id}"))
            } else {
                result.add(DisplayItem.Single(group.first()))
            }
        } else {
            result.add(DisplayItem.Single(messages[i]))
            i++
        }
    }
    return result
}

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

                DropdownMenuItem(
                    text = {
                        Text(
                            "Package Tier",
                            fontSize = 13.sp,
                            fontFamily = com.destin.code.ui.theme.CascadiaMono,
                        )
                    },
                    onClick = {
                        onDismiss()
                        showTierDialog = true
                    },
                )
                DropdownMenuItem(
                    text = {
                        Text(
                            "Manage Directories",
                            fontSize = 13.sp,
                            fontFamily = com.destin.code.ui.theme.CascadiaMono,
                        )
                    },
                    onClick = {
                        onDismiss()
                        showManageDirectories = true
                    },
                )
                DropdownMenuItem(
                    text = {
                        Text(
                            "Theme",
                            fontSize = 13.sp,
                            fontFamily = com.destin.code.ui.theme.CascadiaMono,
                        )
                    },
                    onClick = { themeSubmenuExpanded = !themeSubmenuExpanded },
                )
                if (themeSubmenuExpanded) {
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
                                        color = if (mode == currentThemeMode)
                                            MaterialTheme.colorScheme.primary
                                        else
                                            MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f),
                                    )
                                    Text(
                                        mode.label,
                                        fontSize = 12.sp,
                                        fontFamily = com.destin.code.ui.theme.CascadiaMono,
                                    )
                                }
                            },
                            onClick = {
                                setThemeMode(mode)
                                onDismiss()
                            },
                            modifier = Modifier.padding(start = 12.dp),
                        )
                    }
                }
                DropdownMenuItem(
                    text = {
                        Text(
                            "Donate",
                            fontSize = 13.sp,
                            fontFamily = com.destin.code.ui.theme.CascadiaMono,
                        )
                    },
                    onClick = {
                        onDismiss()
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://buymeacoffee.com/itsdestin")))
                    },
                )
                DropdownMenuItem(
                    text = {
                        Text(
                            "About",
                            fontSize = 13.sp,
                            fontFamily = com.destin.code.ui.theme.CascadiaMono,
                        )
                    },
                    onClick = {
                        onDismiss()
                        showAbout = true
                    },
                )
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
                )
            },
        )

        Box(modifier = Modifier.weight(1f).fillMaxSize()) {
        if (currentSession == null) {
            // No session active — show empty state with mascot
            Box(modifier = Modifier.fillMaxSize()) {
                // Settings gear — top left
                Box(modifier = Modifier.align(Alignment.TopStart).padding(6.dp)) {
                    var emptyMenuExpanded by remember { mutableStateOf(false) }
                    val emptyBorderColor = com.destin.code.ui.theme.DestinCodeTheme.extended.surfaceBorder

                    Box(
                        modifier = Modifier
                            .height(34.dp)
                            .clip(RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.surface)
                            .border(0.5.dp, emptyBorderColor.copy(alpha = 0.5f), RoundedCornerShape(6.dp))
                            .clickable { emptyMenuExpanded = true }
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
                                                    color = if (mode == currentThemeMode) MaterialTheme.colorScheme.primary
                                                    else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f),
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
                Column(
                    modifier = Modifier.align(Alignment.Center),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Icon(
                        com.destin.code.ui.theme.AppIcons.AppIcon,
                        contentDescription = "DestinCode mascot",
                        modifier = Modifier.size(64.dp),
                        tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.3f),
                    )
                    Spacer(modifier = Modifier.height(16.dp))
                    Text(
                        "DestinCode",
                        style = MaterialTheme.typography.headlineMedium,
                        color = MaterialTheme.colorScheme.primary,
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        "No active sessions",
                        fontSize = 14.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                    )
                    Spacer(modifier = Modifier.height(24.dp))
                    Button(
                        onClick = { showNewSessionDialog = true },
                        shape = RoundedCornerShape(8.dp),
                    ) {
                        Text("New Session")
                    }
                }
            }
        } else
        when (screenMode) {
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
            val shellSession = currentSession ?: return@Box
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
            Column(modifier = Modifier.fillMaxSize()) {
                val borderColor = com.destin.code.ui.theme.DestinCodeTheme.extended.surfaceBorder

                // Messages + activity indicator
                // Group consecutive completed/failed tool calls into collapsible summaries.
                // Recompute when list size changes OR when any tool state transitions
                // (e.g. Running→Complete). activeToolName changes on transitions, making
                // it a lightweight proxy for "some tool card changed state".
                val displayItems = remember(
                    chatState.messages.size,
                    chatState.activeToolName,
                    chatState.messageVersion,
                    chatState.messages.lastOrNull()?.content,
                ) {
                    groupMessages(chatState.messages)
                }
                // Track which tool groups are expanded
                val expandedGroups = remember { mutableStateMapOf<String, Boolean>() }

                // Auto-scroll on new messages (uses displayItems count for correct index)
                LaunchedEffect(chatState.messages.size) {
                    if (displayItems.isNotEmpty()) {
                        // +1 for the activity indicator item at the end
                        listState.animateScrollToItem(displayItems.size)
                    }
                }

                LazyColumn(
                    state = listState,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    contentPadding = PaddingValues(vertical = 8.dp),
                ) {
                    items(displayItems.size, key = { index ->
                        when (val item = displayItems[index]) {
                            is DisplayItem.Single -> item.message.id
                            is DisplayItem.ToolGroup -> item.key
                        }
                    }) { index ->
                        when (val item = displayItems[index]) {
                            is DisplayItem.ToolGroup -> {
                                ToolGroupCard(
                                    messages = item.messages,
                                    isExpanded = expandedGroups[item.key] == true,
                                    onToggle = {
                                        expandedGroups[item.key] = expandedGroups[item.key] != true
                                    },
                                    expandedCardId = chatState.expandedCardId,
                                    onToggleCard = { chatState.toggleCard(it) },
                                )
                            }
                            is DisplayItem.Single -> {
                                val message = item.message
                                val approval = message.content as? MessageContent.ToolAwaitingApproval
                                val toolUseId = approval?.toolUseId
                                MessageBubble(
                                    message = message,
                                    expandedCardId = chatState.expandedCardId,
                                    onToggleCard = { chatState.toggleCard(it) },
                                    onAcceptApproval = {
                                        toolUseId?.let { chatState.revertApprovalToRunning(it) }
                                        if (approval?.requestId != null) {
                                            val decision = org.json.JSONObject()
                                                .put("decision", org.json.JSONObject().put("behavior", "allow"))
                                            bridge?.getEventBridge()?.respond(approval.requestId, decision)
                                        } else {
                                            bridge?.sendApproval(com.destin.code.runtime.PtyBridge.ApprovalOption.Yes)
                                        }
                                    },
                                    onAcceptAlwaysApproval = {
                                        toolUseId?.let { chatState.revertApprovalToRunning(it) }
                                        if (approval?.requestId != null && approval.permissionSuggestions != null && approval.permissionSuggestions.length() > 0) {
                                            val decision = org.json.JSONObject()
                                                .put("decision", org.json.JSONObject()
                                                    .put("behavior", "allow")
                                                    .put("updatedPermissions", org.json.JSONArray().put(approval.permissionSuggestions.get(0))))
                                            bridge?.getEventBridge()?.respond(approval.requestId, decision)
                                        } else {
                                            bridge?.sendApproval(com.destin.code.runtime.PtyBridge.ApprovalOption.YesAlways)
                                        }
                                    },
                                    onRejectApproval = {
                                        toolUseId?.let { chatState.revertApprovalToRunning(it) }
                                        if (approval?.requestId != null) {
                                            val decision = org.json.JSONObject()
                                                .put("decision", org.json.JSONObject().put("behavior", "deny"))
                                            bridge?.getEventBridge()?.respond(approval.requestId, decision)
                                        } else {
                                            bridge?.sendApproval(com.destin.code.runtime.PtyBridge.ApprovalOption.No)
                                        }
                                    },
                                    onPromptAction = { promptId, input ->
                                        bridge?.writeInput(input)
                                        val currentMsg = chatState.messages.lastOrNull {
                                            (it.content as? MessageContent.InteractivePrompt)?.promptId == promptId
                                        }
                                        val prompt = currentMsg?.content as? MessageContent.InteractivePrompt
                                        val label = prompt?.buttons?.find { it.input == input }?.label ?: input
                                        chatState.completePrompt(promptId, label)
                                        currentSession?.markPromptCompleted(promptId)
                                    },
                                    session = bridge?.getSession(),
                                    screenVersion = 0,
                                )
                            }
                        }
                    }
                    item {
                        var now by remember { mutableStateOf(System.currentTimeMillis()) }
                        LaunchedEffect(Unit) { while (true) { delay(500); now = System.currentTimeMillis() } }
                        val ptyActive = (now - lastPtyOutput) < 2000
                        val hasActiveTool = chatState.activeToolName != null
                        ActivityIndicator(isActive = ptyActive && !hasActiveTool)
                    }
                }

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

                // Input row
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.background)
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
                            .border(0.5.dp, borderColor.copy(alpha = 0.5f), androidx.compose.foundation.shape.RoundedCornerShape(6.dp)),
                        contentAlignment = Alignment.TopStart,
                    ) {
                        val inputScrollState = rememberScrollState()
                        BasicTextField(
                            value = chatState.inputDraft,
                            onValueChange = { chatState.inputDraft = it },
                            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                            singleLine = false,
                            maxLines = 5,
                            textStyle = androidx.compose.ui.text.TextStyle(
                                fontSize = 14.sp,
                                fontFamily = com.destin.code.ui.theme.CascadiaMono,
                                color = MaterialTheme.colorScheme.onSurface,
                            ),
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 10.dp, vertical = 10.dp)
                                .verticalScroll(inputScrollState),
                            decorationBox = { innerTextField ->
                                Box(modifier = Modifier.fillMaxWidth()) {
                                    Box(modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(end = 24.dp)) {
                                        if (chatState.inputDraft.text.isEmpty()) {
                                            Text("Type a message...", fontSize = 14.sp,
                                                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f))
                                        }
                                        innerTextField()
                                    }
                                    Icon(
                                        com.destin.code.ui.theme.AppIcons.Attach,
                                        contentDescription = "Attach file",
                                        tint = if (attachmentPaths.isNotEmpty())
                                            Color(0xFFB0B0B0)
                                        else
                                            Color(0xFF555555),
                                        modifier = Modifier
                                            .size(20.dp)
                                            .align(Alignment.BottomEnd)
                                            .clickable {
                                                filePickerLauncher.launch("*/*")
                                            },
                                    )
                                }
                            },
                        )
                    }

                    Box(
                        modifier = Modifier
                            .size(42.dp)
                            .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.15f))
                            .border(0.5.dp, borderColor.copy(alpha = 0.5f), androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                            .clickable {
                                val text = chatState.inputDraft.text
                                if (text.isNotBlank() || attachmentPaths.isNotEmpty()) {
                                    val messageText = buildString {
                                        for (path in attachmentPaths) {
                                            appendLine("[File attached: $path]")
                                        }
                                        if (attachmentPaths.isNotEmpty()) appendLine()
                                        append(text)
                                    }.trim()
                                    val imageCount = attachmentPaths.size
                                    val displayText = when {
                                        imageCount > 1 && text.isBlank() -> "[$imageCount images]"
                                        imageCount == 1 && text.isBlank() -> "[image]"
                                        imageCount > 0 -> "[$imageCount image${if (imageCount > 1) "s" else ""}] $text"
                                        else -> text
                                    }
                                    chatState.addUserMessage(displayText)
                                    bridge?.writeInput(messageText + "\r")
                                    chatState.clearDraft()
                                    attachmentPaths = emptyList()
                                    attachmentBitmap = null
                                }
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send",
                            tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
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

        } // when
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
