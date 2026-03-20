package com.destin.code.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
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
import com.destin.code.config.defaultChips
import com.destin.code.runtime.BaseTerminalViewClient
import com.destin.code.runtime.DirectShellBridge
import com.destin.code.runtime.SessionService
import com.termux.view.TerminalView
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File

private enum class ScreenMode { Chat, Terminal, Shell }

@OptIn(ExperimentalFoundationApi::class)
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
    var directShellBridge by remember { mutableStateOf<DirectShellBridge?>(null) }
    DisposableEffect(Unit) { onDispose { directShellBridge?.stop() } }
    val haptic = LocalHapticFeedback.current
    val context = LocalContext.current

    // Session switcher state
    var switcherExpanded by remember { mutableStateOf(false) }
    var showNewSessionDialog by remember { mutableStateOf(false) }

    // Image attachment state
    var attachmentPath by rememberSaveable { mutableStateOf<String?>(null) }
    var attachmentBitmap by remember { mutableStateOf<Bitmap?>(null) }

    LaunchedEffect(attachmentPath) {
        attachmentBitmap = attachmentPath?.let { path ->
            try {
                val opts = BitmapFactory.Options().apply { inSampleSize = 8 }
                BitmapFactory.decodeFile(path, opts)
            } catch (_: Exception) { null }
        }
    }

    val filePickerLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri ->
        uri?.let { selectedUri ->
            coroutineScope.launch(kotlinx.coroutines.Dispatchers.IO) {
                val homeDir = service.bootstrap?.homeDir ?: return@launch
                val attachDir = File(homeDir, "attachments").also { it.mkdirs() }
                val timestamp = System.currentTimeMillis()
                // Derive extension from MIME type or URI
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
                    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
                        attachmentPath = destFile.absolutePath
                    }
                } catch (_: Exception) {}
            }
        }
    }

    val lastPtyOutput by (bridge?.lastPtyOutputTime?.collectAsState()
        ?: remember { mutableStateOf(0L) })

    // Auto-scroll on new messages
    LaunchedEffect(chatState.messages.size, "auto_scroll") {
        if (chatState.messages.isNotEmpty()) {
            listState.animateScrollToItem(chatState.messages.size - 1)
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        when (screenMode) {
        ScreenMode.Terminal -> {
            val termFocusRequester = remember { FocusRequester() }
            val termViewClient = remember { BaseTerminalViewClient() }
            val termScreenVersion by (bridge?.screenVersion?.collectAsState()
                ?: remember { mutableStateOf(0) })

            Column(modifier = Modifier.fillMaxSize()) {
                val borderColor = com.destin.code.ui.theme.DestinCodeTheme.extended.surfaceBorder
                ModeHeader(
                    title = "Terminal",
                    leftIcon = com.destin.code.ui.theme.AppIcons.Chat,
                    onLeftClick = { screenMode = ScreenMode.Chat },
                )

                AndroidView(
                    factory = { ctx ->
                        TerminalView(ctx, null).apply {
                            setTextSize((12 * resources.displayMetrics.scaledDensity).toInt())
                            setTerminalViewClient(termViewClient)
                            isFocusable = true
                            isFocusableInTouchMode = true
                            bridge?.getSession()?.let { attachSession(it) }
                        }
                    },
                    update = { view ->
                        bridge?.getSession()?.let { view.attachSession(it) }
                        @Suppress("UNUSED_EXPRESSION")
                        termScreenVersion
                        view.onScreenUpdated()
                    },
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                )

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
                    attachmentPath = attachmentPath,
                )
            }
        }

        ScreenMode.Shell -> {
            val shell = directShellBridge ?: return@Box
            val shellFocusRequester = remember { FocusRequester() }
            val shellViewClient = remember { BaseTerminalViewClient() }
            val shellScreenVersion by shell.screenVersion.collectAsState()

            Column(modifier = Modifier.fillMaxSize()) {
                val borderColor = com.destin.code.ui.theme.DestinCodeTheme.extended.surfaceBorder
                ModeHeader(
                    title = "Shell",
                    leftIcon = com.destin.code.ui.theme.AppIcons.Chat,
                    onLeftClick = { screenMode = ScreenMode.Chat },
                    rightIcon = com.destin.code.ui.theme.AppIcons.AppIcon,
                    onRightClick = { screenMode = ScreenMode.Terminal },
                )

                AndroidView(
                    factory = { ctx ->
                        TerminalView(ctx, null).apply {
                            setTextSize((12 * resources.displayMetrics.scaledDensity).toInt())
                            setTerminalViewClient(shellViewClient)
                            isFocusable = true
                            isFocusableInTouchMode = true
                            shell.getSession()?.let { attachSession(it) }
                        }
                    },
                    update = { view ->
                        shell.getSession()?.let { view.attachSession(it) }
                        @Suppress("UNUSED_EXPRESSION")
                        shellScreenVersion
                        view.onScreenUpdated()
                    },
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                )

                HorizontalDivider(color = borderColor, thickness = 0.5.dp)
                TerminalInputBar(
                    focusRequester = shellFocusRequester,
                    draft = chatState.inputDraft,
                    onDraftChange = { chatState.inputDraft = it },
                    onSend = { text ->
                        shell.writeInput(text + "\r")
                        chatState.clearDraft()
                    },
                    onKeyPress = { seq -> shell.writeInput(seq) },
                    onAttachImage = {
                        filePickerLauncher.launch("*/*")
                    },
                    attachmentPath = attachmentPath,
                )
            }
        }

        ScreenMode.Chat -> {
            Column(modifier = Modifier.fillMaxSize()) {
                val borderColor = com.destin.code.ui.theme.DestinCodeTheme.extended.surfaceBorder

                // Top bar
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.background)
                        .padding(horizontal = 6.dp, vertical = 5.dp),
                ) {
                    // Terminal toggle pill — tap = DestinCode terminal, long-press = direct shell
                    Box(
                        modifier = Modifier
                            .align(Alignment.CenterStart)
                            .height(34.dp)
                            .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.surface)
                            .border(0.5.dp, borderColor.copy(alpha = 0.5f), androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                            .combinedClickable(
                                onClick = { screenMode = ScreenMode.Terminal },
                                onLongClick = {
                                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                    if (directShellBridge == null) {
                                        service.bootstrap?.let { bs ->
                                            directShellBridge = service.sessionRegistry.createDirectShell(bs)
                                        }
                                    }
                                    screenMode = ScreenMode.Shell
                                },
                            )
                            .padding(horizontal = 10.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            com.destin.code.ui.theme.AppIcons.Terminal,
                            contentDescription = "Switch to terminal",
                            tint = MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.size(18.dp),
                        )
                    }

                    // Session switcher pill (center)
                    Box(modifier = Modifier.align(Alignment.Center)) {
                        SessionSwitcherPill(
                            currentSession = currentSession,
                            expanded = switcherExpanded,
                            onToggle = { switcherExpanded = !switcherExpanded },
                        )
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
                    }

                    // Menu button + dropdown
                    Box(modifier = Modifier.align(Alignment.CenterEnd)) {
                        var menuExpanded by remember { mutableStateOf(false) }
                        val isDark = com.destin.code.ui.theme.LocalIsDarkTheme.current
                        val toggleTheme = com.destin.code.ui.theme.LocalToggleTheme.current

                        Box(
                            modifier = Modifier
                                .height(34.dp)
                                .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                                .background(MaterialTheme.colorScheme.surface)
                                .border(0.5.dp, borderColor.copy(alpha = 0.5f), androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                                .clickable { menuExpanded = true }
                                .padding(horizontal = 10.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                com.destin.code.ui.theme.AppIcons.Menu,
                                contentDescription = "Menu",
                                tint = MaterialTheme.colorScheme.onSurface,
                                modifier = Modifier.size(18.dp),
                            )
                        }

                        DropdownMenu(
                            expanded = menuExpanded,
                            onDismissRequest = { menuExpanded = false },
                            containerColor = MaterialTheme.colorScheme.surface,
                        ) {
                            DropdownMenuItem(
                                text = {
                                    Text(
                                        if (isDark) "Light Mode" else "Dark Mode",
                                        fontSize = 13.sp,
                                        fontFamily = com.destin.code.ui.theme.CascadiaMono,
                                    )
                                },
                                onClick = {
                                    toggleTheme()
                                    menuExpanded = false
                                },
                            )
                        }
                    }
                }
                HorizontalDivider(color = borderColor, thickness = 0.5.dp)

                // Messages + activity indicator
                LazyColumn(
                    state = listState,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    contentPadding = PaddingValues(vertical = 8.dp),
                ) {
                    items(chatState.messages, key = { it.id }) { message ->
                        val toolUseId = (message.content as? MessageContent.ToolAwaitingApproval)?.toolUseId
                        MessageBubble(
                            message = message,
                            expandedCardId = chatState.expandedCardId,
                            onToggleCard = { chatState.toggleCard(it) },
                            onAcceptApproval = {
                                toolUseId?.let { chatState.revertApprovalToRunning(it) }
                                bridge?.sendApproval(com.destin.code.runtime.PtyBridge.ApprovalOption.Yes)
                            },
                            onAcceptAlwaysApproval = {
                                toolUseId?.let { chatState.revertApprovalToRunning(it) }
                                bridge?.sendApproval(com.destin.code.runtime.PtyBridge.ApprovalOption.YesAlways)
                            },
                            onRejectApproval = {
                                toolUseId?.let { chatState.revertApprovalToRunning(it) }
                                bridge?.sendApproval(com.destin.code.runtime.PtyBridge.ApprovalOption.No)
                            },
                            onPromptAction = { promptId, input ->
                                bridge?.writeInput(input)
                                val prompt = message.content as? MessageContent.InteractivePrompt
                                val label = prompt?.buttons?.find { it.input == input }?.label ?: ""
                                chatState.completePrompt(promptId, label)
                                currentSession?.markPromptCompleted(promptId)
                            },
                            session = bridge?.getSession(),
                            screenVersion = 0,
                        )
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
                if (attachmentBitmap != null) {
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
                        Text("File attached", fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                        Spacer(modifier = Modifier.weight(1f))
                        Icon(
                            Icons.Filled.Close,
                            contentDescription = "Remove attachment",
                            tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                            modifier = Modifier
                                .size(20.dp)
                                .clickable {
                                    attachmentPath = null
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
                                        tint = if (attachmentPath != null)
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
                                if (text.isNotBlank() || attachmentPath != null) {
                                    val messageText = buildString {
                                        attachmentPath?.let { path ->
                                            appendLine("[File attached: $path]")
                                            appendLine()
                                        }
                                        append(text)
                                    }.trim()
                                    val displayText = when {
                                        attachmentPath != null && text.isBlank() -> "[image]"
                                        attachmentPath != null -> "[image] $text"
                                        else -> text
                                    }
                                    chatState.addUserMessage(displayText)
                                    bridge?.writeInput(messageText + "\r")
                                    chatState.clearDraft()
                                    attachmentPath = null
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
                    chips = defaultChips,
                    onChipTap = { chip ->
                        if (chip.needsCompletion) {
                            chatState.setDraftText(chip.prompt)
                        } else {
                            chatState.addUserMessage(chip.prompt)
                            bridge?.writeInput(chip.prompt + "\r")
                        }
                    }
                )
            }
        }

        } // when
    }

    // New session dialog
    if (showNewSessionDialog) {
        if (service.sessionRegistry.sessionCount >= 5) {
            AlertDialog(
                onDismissRequest = { showNewSessionDialog = false },
                title = { Text("Session Limit") },
                text = { Text("You have 5 active sessions. Close one before creating a new session.") },
                confirmButton = {
                    TextButton(onClick = { showNewSessionDialog = false }) { Text("OK") }
                },
            )
        } else {
            val knownDirs = listOf(
                "Home (~)" to service.bootstrap!!.homeDir,
                "claude-mobile" to File(service.bootstrap!!.homeDir, "claude-mobile"),
                "destin-claude" to File(service.bootstrap!!.homeDir, "destin-claude"),
            )
            NewSessionDialog(
                knownDirs = knownDirs,
                onDismiss = { showNewSessionDialog = false },
                onCreate = { config ->
                    showNewSessionDialog = false
                    service.createSession(config.cwd, config.dangerousMode, null)
                },
            )
        }
    }
}

/** Shared header bar for Terminal and Shell modes. */
@Composable
private fun ModeHeader(
    title: String,
    leftIcon: androidx.compose.ui.graphics.vector.ImageVector,
    onLeftClick: () -> Unit,
    rightIcon: androidx.compose.ui.graphics.vector.ImageVector = com.destin.code.ui.theme.AppIcons.AppIcon,
    onRightClick: (() -> Unit)? = null,
) {
    val borderColor = com.destin.code.ui.theme.DestinCodeTheme.extended.surfaceBorder
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.background)
            .padding(horizontal = 6.dp, vertical = 5.dp),
    ) {
        Box(
            modifier = Modifier
                .align(Alignment.CenterStart)
                .height(34.dp)
                .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                .background(MaterialTheme.colorScheme.surface)
                .border(0.5.dp, borderColor.copy(alpha = 0.5f), androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                .clickable(onClick = onLeftClick)
                .padding(horizontal = 10.dp),
            contentAlignment = Alignment.Center,
        ) {
            Icon(leftIcon, contentDescription = "Back",
                tint = MaterialTheme.colorScheme.onSurface, modifier = Modifier.size(18.dp))
        }
        Text(title, fontSize = 15.sp,
            color = com.destin.code.ui.theme.DestinCodeTheme.extended.textSecondary,
            modifier = Modifier.align(Alignment.Center))
        Box(
            modifier = Modifier
                .align(Alignment.CenterEnd)
                .height(34.dp)
                .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                .background(MaterialTheme.colorScheme.surface)
                .border(0.5.dp, borderColor.copy(alpha = 0.5f), androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                .then(if (onRightClick != null) Modifier.clickable(onClick = onRightClick) else Modifier)
                .padding(horizontal = 10.dp),
            contentAlignment = Alignment.Center,
        ) {
            Icon(rightIcon, contentDescription = title,
                tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
        }
    }
    HorizontalDivider(color = borderColor, thickness = 0.5.dp)
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
    attachmentPath: String? = null,
) {
    val borderColor = com.destin.code.ui.theme.DestinCodeTheme.extended.surfaceBorder

    Column {
        Box(modifier = Modifier.fillMaxWidth()) {
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
                                        "Type a message…",
                                        fontSize = 14.sp,
                                        fontFamily = com.destin.code.ui.theme.CascadiaMono,
                                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f),
                                    )
                                }
                                innerTextField()
                            }
                            if (onAttachImage != null) {
                                Icon(
                                    com.destin.code.ui.theme.AppIcons.Attach,
                                    contentDescription = "Attach file",
                                    tint = if (attachmentPath != null)
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

            // Floating up/down arrows — stacked vertically above the send button
            Column(
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(end = 6.dp, bottom = 52.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                FloatingArrowButton(
                    icon = Icons.Filled.KeyboardArrowUp,
                    contentDescription = "Up",
                    borderColor = borderColor,
                    onClick = { onKeyPress("\u001b[A") },
                )
                FloatingArrowButton(
                    icon = Icons.Filled.KeyboardArrowDown,
                    contentDescription = "Down",
                    borderColor = borderColor,
                    onClick = { onKeyPress("\u001b[B") },
                )
            }
        } // end Box

        TerminalKeyboardRow(onKeyPress = onKeyPress)
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
            .size(36.dp)
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
