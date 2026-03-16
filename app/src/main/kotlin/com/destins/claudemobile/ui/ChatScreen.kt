package com.destins.claudemobile.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.background
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destins.claudemobile.config.defaultChips
import com.destins.claudemobile.parser.HookEvent
import com.destins.claudemobile.runtime.DirectShellBridge
import com.destins.claudemobile.runtime.PtyBridge
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

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
    val haptic = LocalHapticFeedback.current

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
                            chatState.updateToolToApproval(toolUseId)
                        }
                    } else {
                        chatState.addSystemNotice(event.message)
                    }
                }
            }
        }
    }

    // Fallback approval detection: PTY silence heuristic
    LaunchedEffect(chatState.messages.size) {
        val lastMsg = chatState.messages.lastOrNull()
        val running = lastMsg?.content as? MessageContent.ToolRunning ?: return@LaunchedEffect
        delay(2000)
        // Check if still in running state and PTY is quiet
        val stillRunning = chatState.messages.lastOrNull {
            val c = it.content
            c is MessageContent.ToolRunning && c.toolUseId == running.toolUseId
        }
        if (stillRunning != null) {
            val now = System.currentTimeMillis()
            val lastOutput = bridge.lastPtyOutputTime.value
            if (now - lastOutput > 2000) {
                chatState.updateToolToApproval(running.toolUseId)
            }
        }
    }

    // Auto-scroll on new messages
    LaunchedEffect(chatState.messages.size) {
        if (chatState.messages.isNotEmpty()) {
            listState.animateScrollToItem(chatState.messages.size - 1)
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        when (screenMode) {
        ScreenMode.Terminal -> {
            // ── Full-screen terminal mode ──────────────────────────────
            var terminalInput by remember { mutableStateOf("") }
            var termScrollOffset by remember { mutableFloatStateOf(0f) }

            Column(modifier = Modifier.fillMaxSize()) {
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
                            .clickable { screenMode = ScreenMode.Chat }
                            .padding(horizontal = 10.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            com.destins.claudemobile.ui.theme.AppIcons.Chat,
                            contentDescription = "Switch to chat",
                            tint = MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                    Text(
                        "Terminal",
                        fontSize = 15.sp,
                        color = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.textSecondary,
                        modifier = Modifier.align(Alignment.Center),
                    )
                    Box(
                        modifier = Modifier
                            .align(Alignment.CenterEnd)
                            .size(34.dp)
                            .clip(androidx.compose.foundation.shape.CircleShape)
                            .background(MaterialTheme.colorScheme.surface)
                            .border(0.5.dp, borderColor.copy(alpha = 0.5f), androidx.compose.foundation.shape.CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            com.destins.claudemobile.ui.theme.AppIcons.ClaudeMascot,
                            contentDescription = "Claude",
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
                HorizontalDivider(color = borderColor, thickness = 0.5.dp)

                // Terminal + floating scroll-to-bottom button
                Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                    TerminalPanel(
                        session = bridge.getSession(),
                        screenVersion = screenVersion,
                        modifier = Modifier.fillMaxSize(),
                        scrollOffset = termScrollOffset,
                        onScrollOffsetChanged = { termScrollOffset = it },
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
                            .height(42.dp)
                            .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.surface)
                            .border(0.5.dp, borderColor.copy(alpha = 0.5f), androidx.compose.foundation.shape.RoundedCornerShape(6.dp)),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        BasicTextField(
                            value = terminalInput,
                            onValueChange = { terminalInput = it },
                            singleLine = true,
                            textStyle = androidx.compose.ui.text.TextStyle(
                                fontSize = 13.sp,
                                fontFamily = com.destins.claudemobile.ui.theme.CascadiaMono,
                                color = MaterialTheme.colorScheme.onSurface,
                            ),
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp),
                            decorationBox = { innerTextField ->
                                if (terminalInput.isEmpty()) {
                                    Text("Type here...", fontSize = 13.sp,
                                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f))
                                }
                                innerTextField()
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
                                if (terminalInput.isNotBlank()) {
                                    bridge.writeInput(terminalInput + "\r")
                                    terminalInput = ""
                                }
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send",
                            tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
                    }
                }

                TerminalKeyboardRow(onKeyPress = { seq -> bridge.writeInput(seq) })
            }
        }

        ScreenMode.Shell -> {
            // ── Direct shell mode ─────────────────────────────────────
            val shell = directShellBridge ?: return@Box
            val shellScreenVersion by shell.screenVersion.collectAsState()
            var shellInput by remember { mutableStateOf("") }

            Column(modifier = Modifier.fillMaxSize()) {
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
                            .clickable { screenMode = ScreenMode.Chat }
                            .padding(horizontal = 10.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(com.destins.claudemobile.ui.theme.AppIcons.Chat,
                            contentDescription = "Switch to chat",
                            tint = MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.size(18.dp))
                    }
                    Text("Shell", fontSize = 15.sp,
                        color = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.textSecondary,
                        modifier = Modifier.align(Alignment.Center))
                    Box(
                        modifier = Modifier
                            .align(Alignment.CenterEnd)
                            .size(34.dp)
                            .clip(androidx.compose.foundation.shape.CircleShape)
                            .background(MaterialTheme.colorScheme.surface)
                            .border(0.5.dp, borderColor.copy(alpha = 0.5f), androidx.compose.foundation.shape.CircleShape)
                            .clickable { screenMode = ScreenMode.Terminal },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(com.destins.claudemobile.ui.theme.AppIcons.ClaudeMascot,
                            contentDescription = "Claude terminal",
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(20.dp))
                    }
                }
                HorizontalDivider(color = borderColor, thickness = 0.5.dp)

                TerminalPanel(
                    session = shell.getSession(),
                    screenVersion = shellScreenVersion,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                )

                HorizontalDivider(color = borderColor, thickness = 0.5.dp)

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
                            .height(42.dp)
                            .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.surface)
                            .border(0.5.dp, borderColor.copy(alpha = 0.5f), androidx.compose.foundation.shape.RoundedCornerShape(6.dp)),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        BasicTextField(
                            value = shellInput,
                            onValueChange = { shellInput = it },
                            singleLine = true,
                            textStyle = androidx.compose.ui.text.TextStyle(
                                fontSize = 13.sp,
                                fontFamily = com.destins.claudemobile.ui.theme.CascadiaMono,
                                color = MaterialTheme.colorScheme.onSurface,
                            ),
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp),
                            decorationBox = { innerTextField ->
                                if (shellInput.isEmpty()) {
                                    Text("$ ", fontSize = 13.sp,
                                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f))
                                }
                                innerTextField()
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
                                if (shellInput.isNotBlank()) {
                                    shell.writeInput(shellInput + "\r")
                                    shellInput = ""
                                }
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send",
                            tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
                    }
                }

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
                        MessageBubble(
                            message = message,
                            expandedCardId = chatState.expandedCardId,
                            onToggleCard = { chatState.toggleCard(it) },
                            onAcceptApproval = { bridge.sendApproval(true) },
                            onRejectApproval = { bridge.sendApproval(false) },
                            session = bridge.getSession(),
                            screenVersion = screenVersion,
                        )
                    }
                    // Activity indicator as trailing item
                    item {
                        var now by remember { mutableStateOf(System.currentTimeMillis()) }
                        LaunchedEffect(Unit) { while (true) { delay(500); now = System.currentTimeMillis() } }
                        val isActive = (now - lastPtyOutput) < 2000 || chatState.activeToolName != null
                        ActivityIndicator(isActive = isActive, toolName = chatState.activeToolName)
                    }
                }

                HorizontalDivider(color = borderColor, thickness = 0.5.dp)

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
                            .height(42.dp)
                            .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.surface)
                            .border(0.5.dp, borderColor.copy(alpha = 0.5f), androidx.compose.foundation.shape.RoundedCornerShape(6.dp)),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        BasicTextField(
                            value = chatInputText,
                            onValueChange = { chatInputText = it },
                            singleLine = true,
                            textStyle = androidx.compose.ui.text.TextStyle(
                                fontSize = 14.sp,
                                fontFamily = com.destins.claudemobile.ui.theme.CascadiaMono,
                                color = MaterialTheme.colorScheme.onSurface,
                            ),
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp),
                            decorationBox = { innerTextField ->
                                if (chatInputText.isEmpty()) {
                                    Text("Type a message...", fontSize = 14.sp,
                                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f))
                                }
                                innerTextField()
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
                                if (chatInputText.isNotBlank()) {
                                    chatState.addUserMessage(chatInputText)
                                    bridge.writeInput(chatInputText + "\r")
                                    chatInputText = ""
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
