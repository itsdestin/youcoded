package com.destins.claudemobile.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
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
import androidx.compose.material.icons.outlined.Image
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destins.claudemobile.config.defaultChips
import com.destins.claudemobile.parser.HookEvent
import com.destins.claudemobile.runtime.DirectShellBridge
import com.destins.claudemobile.runtime.PtyBridge
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File

private enum class ScreenMode { Chat, Terminal, Shell }

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ChatScreen(bridge: PtyBridge) {
    val chatState = remember { ChatState() }
    val listState = rememberLazyListState()
    val coroutineScope = rememberCoroutineScope()
    var chatInputText by remember { mutableStateOf("") }
    var screenMode by remember { mutableStateOf(ScreenMode.Chat) }
    var directShellBridge by remember { mutableStateOf<DirectShellBridge?>(null) }
    // Clean up shell process when composable leaves composition (config change, navigation)
    DisposableEffect(Unit) { onDispose { directShellBridge?.stop() } }
    val haptic = LocalHapticFeedback.current
    val context = LocalContext.current

    // Image attachment state
    var attachmentPath by rememberSaveable { mutableStateOf<String?>(null) }
    var attachmentBitmap by remember { mutableStateOf<Bitmap?>(null) }

    // Reconstruct thumbnail from saved path on restore
    LaunchedEffect(attachmentPath) {
        attachmentBitmap = attachmentPath?.let { path ->
            try {
                val opts = BitmapFactory.Options().apply { inSampleSize = 8 }
                BitmapFactory.decodeFile(path, opts)
            } catch (_: Exception) { null }
        }
    }

    val photoPickerLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        uri?.let { selectedUri ->
            coroutineScope.launch(kotlinx.coroutines.Dispatchers.IO) {
                val attachDir = File(bridge.homeDir, "attachments").also { it.mkdirs() }
                val timestamp = System.currentTimeMillis()
                val destFile = File(attachDir, "$timestamp.png")
                try {
                    context.contentResolver.openInputStream(selectedUri)?.use { input ->
                        destFile.outputStream().use { output -> input.copyTo(output) }
                    }
                    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
                        attachmentPath = destFile.absolutePath
                    }
                } catch (_: Exception) {
                    // Silently fail — user can retry
                }
            }
        }
    }

    val screenVersion by bridge.screenVersion.collectAsState()
    val lastPtyOutput by bridge.lastPtyOutputTime.collectAsState()

    // Hook event collector — retries until EventBridge is available
    LaunchedEffect(bridge) {
        var eventBridge = bridge.getEventBridge()
        while (eventBridge == null) {
            delay(200)
            eventBridge = bridge.getEventBridge()
        }
        eventBridge.events.collect { event ->
            android.util.Log.d("ChatEvents", "HOOK: ${event::class.simpleName}")
            when (event) {
                is HookEvent.PreToolUse -> {
                    val argsSummary = event.toolInput.optString("command",
                        event.toolInput.optString("file_path",
                            event.toolInput.optString("pattern",
                                event.toolInput.toString().take(80))))
                    chatState.addToolRunning(event.toolUseId, event.toolName, argsSummary)
                }
                is HookEvent.PostToolUse -> {
                    chatState.updateToolToComplete(event.toolUseId, event.toolResponse)
                }
                is HookEvent.PostToolUseFailure -> {
                    chatState.updateToolToFailed(event.toolUseId, event.toolResponse)
                }
                is HookEvent.Stop -> {
                    chatState.addResponse(event.lastAssistantMessage)
                }
                is HookEvent.Notification -> {
                    if (event.notificationType == "permission_prompt") {
                        // Find the most recent running tool and transition to approval
                        val lastRunning = chatState.messages.lastOrNull {
                            it.content is MessageContent.ToolRunning
                        }
                        val toolUseId = (lastRunning?.content as? MessageContent.ToolRunning)?.toolUseId
                        if (toolUseId != null) {
                            val hasAlways = bridge.hasAlwaysAllowOption()
                            chatState.updateToolToApproval(toolUseId, hasAlways)
                        }
                    } else {
                        chatState.addSystemNotice(event.message)
                    }
                }
            }
        }
    }

    // Fallback approval detection: PTY silence heuristic
    LaunchedEffect(chatState.messages.size, "approval_heuristic") {
        val lastMsg = chatState.messages.lastOrNull()
        val running = lastMsg?.content as? MessageContent.ToolRunning ?: return@LaunchedEffect
        delay(2000)
        // Re-check the tool's current state — the real event path may have
        // already transitioned it to Complete/Failed/AwaitingApproval
        val currentMsg = chatState.messages.lastOrNull {
            val c = it.content
            c is MessageContent.ToolRunning && c.toolUseId == running.toolUseId
        }
        // Only apply heuristic if the tool is still in Running state
        if (currentMsg != null) {
            val now = System.currentTimeMillis()
            val lastOutput = bridge.lastPtyOutputTime.value
            if (now - lastOutput > 2000) {
                val hasAlways = bridge.hasAlwaysAllowOption()
                chatState.updateToolToApproval(running.toolUseId, hasAlways)
            }
        }
    }

    // Auto-scroll on new messages
    LaunchedEffect(chatState.messages.size, "auto_scroll") {
        if (chatState.messages.isNotEmpty()) {
            listState.animateScrollToItem(chatState.messages.size - 1)
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        when (screenMode) {
        ScreenMode.Terminal -> {
            // ── Full-screen terminal mode ──────────────────────────────
            var termScrollOffset by remember { mutableFloatStateOf(0f) }
            val termFocusRequester = remember { FocusRequester() }

            Column(modifier = Modifier.fillMaxSize()) {
                val borderColor = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.surfaceBorder
                ModeHeader(
                    title = "Terminal",
                    leftIcon = com.destins.claudemobile.ui.theme.AppIcons.Chat,
                    onLeftClick = { screenMode = ScreenMode.Chat },
                )

                // Terminal + floating scroll-to-bottom button
                Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                    TerminalPanel(
                        session = bridge.getSession(),
                        screenVersion = screenVersion,
                        modifier = Modifier.fillMaxSize(),
                        scrollOffset = termScrollOffset,
                        onScrollOffsetChanged = { termScrollOffset = it },
                        onTap = { termFocusRequester.requestFocus() },
                    )

                    // Floating "return to bottom" pill
                    if (termScrollOffset > 1f) {
                        Box(
                            modifier = Modifier
                                .align(Alignment.BottomCenter)
                                .padding(bottom = 8.dp)
                                .height(30.dp)
                                .clip(androidx.compose.foundation.shape.RoundedCornerShape(15.dp))
                                .background(MaterialTheme.colorScheme.surface)
                                .border(0.5.dp, borderColor.copy(alpha = 0.5f), androidx.compose.foundation.shape.RoundedCornerShape(15.dp))
                                .clickable { termScrollOffset = 0f }
                                .padding(horizontal = 14.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                "↓ Return to bottom",
                                fontSize = 11.sp,
                                color = MaterialTheme.colorScheme.primary,
                                fontFamily = com.destins.claudemobile.ui.theme.CascadiaMono,
                            )
                        }
                    }
                }

                HorizontalDivider(color = borderColor, thickness = 0.5.dp)
                PtyInputField(
                    focusRequester = termFocusRequester,
                    onInput = { bridge.writeInput(it) },
                    onEnter = { bridge.writeInput("\r") },
                )
                TerminalKeyboardRow(onKeyPress = { seq -> bridge.writeInput(seq) })
            }
        }

        ScreenMode.Shell -> {
            // ── Direct shell mode ─────────────────────────────────────
            val shell = directShellBridge ?: return@Box
            val shellScreenVersion by shell.screenVersion.collectAsState()
            val shellFocusRequester = remember { FocusRequester() }

            Column(modifier = Modifier.fillMaxSize()) {
                val borderColor = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.surfaceBorder
                ModeHeader(
                    title = "Shell",
                    leftIcon = com.destins.claudemobile.ui.theme.AppIcons.Chat,
                    onLeftClick = { screenMode = ScreenMode.Chat },
                    rightIcon = com.destins.claudemobile.ui.theme.AppIcons.ClaudeMascot,
                    onRightClick = { screenMode = ScreenMode.Terminal },
                )

                TerminalPanel(
                    session = shell.getSession(),
                    screenVersion = shellScreenVersion,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    onTap = { shellFocusRequester.requestFocus() },
                )

                HorizontalDivider(color = borderColor, thickness = 0.5.dp)
                PtyInputField(
                    focusRequester = shellFocusRequester,
                    onInput = { shell.writeInput(it) },
                    onEnter = { shell.writeInput("\r") },
                )
                TerminalKeyboardRow(onKeyPress = { seq -> shell.writeInput(seq) })
            }
        }

        ScreenMode.Chat -> {
            // ── Chat mode ─────────────────────────────────────────────
            Column(modifier = Modifier.fillMaxSize()) {
                val borderColor = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.surfaceBorder

                // Top bar
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.background)
                        .padding(horizontal = 6.dp, vertical = 5.dp),
                ) {
                    // Terminal toggle pill — tap = Claude terminal, long-press = direct shell
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
                                        directShellBridge = bridge.createDirectShell()
                                    }
                                    screenMode = ScreenMode.Shell
                                },
                            )
                            .padding(horizontal = 10.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            com.destins.claudemobile.ui.theme.AppIcons.Terminal,
                            contentDescription = "Switch to terminal",
                            tint = MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                    Text("Chat", fontSize = 15.sp,
                        color = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.textSecondary,
                        modifier = Modifier.align(Alignment.Center))
                    Box(
                        modifier = Modifier
                            .align(Alignment.CenterEnd)
                            .size(34.dp)
                            .clip(androidx.compose.foundation.shape.CircleShape)
                            .background(MaterialTheme.colorScheme.surface)
                            .border(0.5.dp, borderColor.copy(alpha = 0.5f), androidx.compose.foundation.shape.CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(com.destins.claudemobile.ui.theme.AppIcons.ClaudeMascot,
                            contentDescription = "Claude",
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(20.dp))
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
                                bridge.sendApproval(com.destins.claudemobile.runtime.PtyBridge.ApprovalOption.Yes)
                            },
                            onAcceptAlwaysApproval = {
                                toolUseId?.let { chatState.revertApprovalToRunning(it) }
                                bridge.sendApproval(com.destins.claudemobile.runtime.PtyBridge.ApprovalOption.YesAlways)
                            },
                            onRejectApproval = {
                                toolUseId?.let { chatState.revertApprovalToRunning(it) }
                                bridge.sendApproval(com.destins.claudemobile.runtime.PtyBridge.ApprovalOption.No)
                            },
                            session = bridge.getSession(),
                            screenVersion = screenVersion,
                        )
                    }
                    // Activity indicator — only when PTY is active and no tool card is showing
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
                                contentDescription = "Attached image",
                                modifier = Modifier
                                    .size(48.dp)
                                    .clip(RoundedCornerShape(6.dp)),
                            )
                        }
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Image attached", fontSize = 12.sp,
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
                    verticalAlignment = Alignment.CenterVertically,
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
                            value = chatInputText,
                            onValueChange = { chatInputText = it },
                            singleLine = false,
                            maxLines = 5,
                            textStyle = androidx.compose.ui.text.TextStyle(
                                fontSize = 14.sp,
                                fontFamily = com.destins.claudemobile.ui.theme.CascadiaMono,
                                color = MaterialTheme.colorScheme.onSurface,
                            ),
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 10.dp, vertical = 10.dp)
                                .verticalScroll(inputScrollState),
                            decorationBox = { innerTextField ->
                                Row(
                                    verticalAlignment = Alignment.Top,
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    Box(modifier = Modifier.weight(1f)) {
                                        if (chatInputText.isEmpty()) {
                                            Text("Type a message...", fontSize = 14.sp,
                                                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f))
                                        }
                                        innerTextField()
                                    }
                                    Icon(
                                        Icons.Outlined.Image,
                                        contentDescription = "Attach image",
                                        tint = if (attachmentPath != null)
                                            Color(0xFFc96442)
                                        else
                                            Color(0xFF555555),
                                        modifier = Modifier
                                            .size(20.dp)
                                            .clickable {
                                                photoPickerLauncher.launch(
                                                    PickVisualMediaRequest(
                                                        ActivityResultContracts.PickVisualMedia.ImageOnly
                                                    )
                                                )
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
                                if (chatInputText.isNotBlank() || attachmentPath != null) {
                                    val messageText = buildString {
                                        attachmentPath?.let { path ->
                                            appendLine("[Image attached: $path]")
                                            appendLine()
                                        }
                                        append(chatInputText)
                                    }.trim()
                                    val displayText = when {
                                        attachmentPath != null && chatInputText.isBlank() -> "[image]"
                                        attachmentPath != null -> "[image] $chatInputText"
                                        else -> chatInputText
                                    }
                                    chatState.addUserMessage(displayText)
                                    bridge.writeInput(messageText + "\r")
                                    chatInputText = ""
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
                            chatInputText = chip.prompt
                        } else {
                            chatState.addUserMessage(chip.prompt)
                            bridge.writeInput(chip.prompt + "\r")
                        }
                    }
                )
            }
        }

        } // when
    }
}

/** Shared header bar for Terminal and Shell modes. */
@Composable
private fun ModeHeader(
    title: String,
    leftIcon: androidx.compose.ui.graphics.vector.ImageVector,
    onLeftClick: () -> Unit,
    rightIcon: androidx.compose.ui.graphics.vector.ImageVector = com.destins.claudemobile.ui.theme.AppIcons.ClaudeMascot,
    onRightClick: (() -> Unit)? = null,
) {
    val borderColor = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.surfaceBorder
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
            color = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.textSecondary,
            modifier = Modifier.align(Alignment.Center))
        Box(
            modifier = Modifier
                .align(Alignment.CenterEnd)
                .size(34.dp)
                .clip(androidx.compose.foundation.shape.CircleShape)
                .background(MaterialTheme.colorScheme.surface)
                .border(0.5.dp, borderColor.copy(alpha = 0.5f), androidx.compose.foundation.shape.CircleShape)
                .then(if (onRightClick != null) Modifier.clickable(onClick = onRightClick) else Modifier),
            contentAlignment = Alignment.Center,
        ) {
            Icon(rightIcon, contentDescription = title,
                tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
        }
    }
    HorizontalDivider(color = borderColor, thickness = 0.5.dp)
}

/** Invisible text field that forwards soft keyboard input to a PTY.
 *  Uses content-aware diffing to correctly handle autocorrect, swipe
 *  typing, and IME composition replacements — not just length changes. */
@Composable
private fun PtyInputField(
    focusRequester: FocusRequester,
    onInput: (String) -> Unit,
    onEnter: () -> Unit,
) {
    var buffer by remember { mutableStateOf("") }
    BasicTextField(
        value = buffer,
        onValueChange = { newValue ->
            // Content-aware diff: find common prefix, then delete back to
            // the change point and retype from there. We can't do positional
            // edits in a terminal — only delete from the cursor (end) and type.
            // e.g. autocorrect "dod" → "did": delete 3 back to "d", send "id".
            val commonPrefix = buffer.commonPrefixWith(newValue).length
            val charsToDelete = buffer.length - commonPrefix
            val charsToInsert = newValue.substring(commonPrefix)

            repeat(charsToDelete) { onInput("\u007f") }
            if (charsToInsert.isNotEmpty()) onInput(charsToInsert)

            buffer = if (newValue.length > 1000) newValue.takeLast(500) else newValue
        },
        singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
        keyboardActions = KeyboardActions(onSend = {
            onEnter()
            buffer = ""  // reset after send to avoid drift
        }),
        textStyle = androidx.compose.ui.text.TextStyle(fontSize = 1.sp),
        modifier = Modifier
            .fillMaxWidth()
            .height(1.dp)
            .alpha(0f)
            .focusRequester(focusRequester),
    )
}
