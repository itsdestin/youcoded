package com.destins.claudemobile.ui

import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.background
import androidx.compose.ui.draw.clip
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Code
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destins.claudemobile.config.defaultChips
import com.destins.claudemobile.parser.ParsedEvent
import com.destins.claudemobile.runtime.PtyBridge
import kotlinx.coroutines.launch

@Composable
fun ChatScreen(bridge: PtyBridge) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val chatState = remember { ChatState() }
    val listState = rememberLazyListState()
    val coroutineScope = rememberCoroutineScope()
    var prefillText by remember { mutableStateOf("") }
    var chatInputText by remember { mutableStateOf("") }
    val onPrefillConsumed = { prefillText = "" }
    var isTerminalMode by remember { mutableStateOf(false) }
    var hasUnhandledInteractive by remember { mutableStateOf(false) }

    // Menu accumulator — collects numbered options arriving as separate text events
    val menuAccumulator = remember { mutableListOf<String>() }
    var menuFlushJob by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }
    // var showBtwSheet by remember { mutableStateOf(false) } // /btw deferred

    // Collect screen version to trigger terminal panel recomposition on PTY output
    val screenVersion by bridge.screenVersion.collectAsState()

    LaunchedEffect(bridge) {
        val eventBridge = bridge.getEventBridge()
        if (eventBridge != null) {
            eventBridge.events.collect { event ->
                android.util.Log.d("ChatEvents", "EVENT: ${event::class.simpleName} → ${event.toString().take(200)}")
                when (event) {
                    is ParsedEvent.ApprovalPrompt -> chatState.requestApproval(event.tool, event.summary)
                    is ParsedEvent.ToolStart -> chatState.addToolStart(event.tool, event.args)
                    is ParsedEvent.ToolEnd -> {
                        // Deferred: updating duration on matching ToolCall card
                    }
                    is ParsedEvent.DiffBlock -> chatState.addDiff(event.filename, event.hunks)
                    is ParsedEvent.CodeBlock -> chatState.addCode(event.language, event.code)
                    is ParsedEvent.Error -> chatState.addError(event.message, event.details)
                    is ParsedEvent.Progress -> chatState.addProgress(event.message)
                    is ParsedEvent.Text -> {
                        if (event.text.isNotBlank()) {
                            val text = event.text.trim()

                            // Filter out terminal noise that doesn't belong in chat:
                            // - ASCII art (block chars, stars alone, dots)
                            // - Decoration lines (box drawing, dashes)
                            // - Very short non-alphabetic lines
                            val noiseChars = setOf('█', '▓', '░', '▄', '▀', '▌', '▐', '╌', '─', '━',
                                '═', '┄', '┈', '╍', '…', '·', '╸', '╺', '╴', '╶', '*', '●', '○')
                            val isNoise = text.length < 3 && text.all { it in noiseChars || it.isWhitespace() } ||
                                text.all { it in noiseChars || it.isWhitespace() || it == '│' || it == '┃' } ||
                                text.matches(Regex("""^[*\s░▓█▄▀▌▐\s]+$"""))
                            if (isNoise) {
                                // Skip — don't add to chat
                            }
                            // Detect numbered menu options
                            else if (Regex("""^.*\d+\.\s+\S""").containsMatchIn(text) && text.length < 100) {
                                menuAccumulator.add(text.replace(Regex("""^[❯>\s]*"""), "").trim())
                                menuFlushJob?.cancel()
                                menuFlushJob = coroutineScope.launch {
                                    kotlinx.coroutines.delay(300)
                                    if (menuAccumulator.size >= 2) {
                                        chatState.addMenu(menuAccumulator.toList(), menuAccumulator.joinToString("\n"))
                                    } else {
                                        menuAccumulator.forEach { chatState.addClaudeText(it) }
                                    }
                                    menuAccumulator.clear()
                                }
                            } else {
                                // Flush menu accumulator on real content
                                if (menuAccumulator.isNotEmpty() && !text.all { it in noiseChars || it.isWhitespace() }) {
                                    menuFlushJob?.cancel()
                                    if (menuAccumulator.size >= 2) {
                                        chatState.addMenu(menuAccumulator.toList(), menuAccumulator.joinToString("\n"))
                                    } else {
                                        menuAccumulator.forEach { chatState.addClaudeText(it) }
                                    }
                                    menuAccumulator.clear()
                                }
                                chatState.addClaudeText(text)
                            }
                        }
                    }
                    is ParsedEvent.InteractiveMenu -> {
                        // Try to parse menu options from raw text
                        val lines = event.raw.lines().filter { it.isNotBlank() }
                        val options = lines.map { it.trim().removePrefix("❯").removePrefix(">").trim() }
                        if (options.size >= 2) {
                            chatState.addMenu(options, event.raw)
                        } else {
                            chatState.addRawOutput(event.raw)
                            hasUnhandledInteractive = true
                        }
                    }
                    is ParsedEvent.Confirmation -> chatState.addConfirm(event.question)
                    is ParsedEvent.TextPrompt -> chatState.addClaudeText(event.prompt)
                    is ParsedEvent.OAuthRedirect -> {
                        chatState.addOAuth(event.url)
                        // Also auto-open in browser
                        try {
                            val intent = android.content.Intent(
                                android.content.Intent.ACTION_VIEW,
                                android.net.Uri.parse(event.url)
                            )
                            context.startActivity(intent)
                        } catch (_: Exception) {}
                    }
                }
            }
        } else {
            // Fallback: raw PTY output (parser not connected)
            android.util.Log.d("ChatEvents", "NO PARSER — using raw output fallback")
            bridge.outputFlow.collect { output ->
                if (output.isNotBlank()) {
                    android.util.Log.d("ChatEvents", "RAW: ${output.take(100)}")
                    chatState.addRawOutput(output)
                }
            }
        }
    }

    // Also watch raw output for URLs the parser might miss (e.g., auth URLs)
    // This catches URLs regardless of parser state
    val urlPattern = remember { Regex("""https?://[^\s"'<>]+""") }
    val openedUrls = remember { mutableSetOf<String>() }
    LaunchedEffect(bridge) {
        bridge.outputFlow.collect { output ->
            // Only auto-open URLs that look like auth/login flows
            if (output.contains("anthropic.com") || output.contains("oauth") ||
                output.contains("login") || output.contains("authorize")) {
                val match = urlPattern.find(output)
                if (match != null && match.value !in openedUrls) {
                    openedUrls.add(match.value)
                    try {
                        val intent = android.content.Intent(
                            android.content.Intent.ACTION_VIEW,
                            android.net.Uri.parse(match.value)
                        )
                        context.startActivity(intent)
                    } catch (_: Exception) {}
                }
            }
        }
    }

    LaunchedEffect(chatState.messages.size) {
        if (chatState.messages.isNotEmpty()) {
            listState.animateScrollToItem(chatState.messages.size - 1)
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        if (isTerminalMode) {
            // ── Full-screen terminal mode ──────────────────────────────
            var terminalInput by remember { mutableStateOf("") }

            Column(modifier = Modifier.fillMaxSize()) {
                // Top bar — icon left, centered title, Claude icon right
                val borderColor = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.surfaceBorder
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.background)
                        .padding(horizontal = 6.dp, vertical = 5.dp),
                ) {
                    // Chat toggle pill — left
                    Box(
                        modifier = Modifier
                            .align(Alignment.CenterStart)
                            .height(34.dp)
                            .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.surface)
                            .border(0.5.dp, borderColor.copy(alpha = 0.5f), androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                            .clickable { isTerminalMode = false }
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
                    // Centered title
                    Text(
                        "Terminal",
                        fontSize = 13.sp,
                        color = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.textSecondary,
                        modifier = Modifier.align(Alignment.Center),
                    )
                    // Claude icon pill — right
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
                // Divider below top bar
                HorizontalDivider(color = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.surfaceBorder, thickness = 0.5.dp)

                // Terminal canvas — fills all available space
                TerminalPanel(
                    session = bridge.getSession(),
                    screenVersion = screenVersion,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                )

                // Divider above text input
                HorizontalDivider(color = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.surfaceBorder, thickness = 0.5.dp)

                // Text input row
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.background)
                        .padding(horizontal = 6.dp, vertical = 5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    // Text field styled as a pill matching the key buttons
                    val borderColor = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.surfaceBorder
                    androidx.compose.foundation.layout.Box(
                        modifier = Modifier
                            .weight(1f)
                            .height(42.dp)
                            .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.surface)
                            .border(
                                0.5.dp,
                                borderColor.copy(alpha = 0.5f),
                                androidx.compose.foundation.shape.RoundedCornerShape(6.dp)
                            ),
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
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 10.dp),
                            decorationBox = { innerTextField ->
                                if (terminalInput.isEmpty()) {
                                    Text(
                                        "Type here...",
                                        fontSize = 13.sp,
                                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f),
                                    )
                                }
                                innerTextField()
                            },
                        )
                    }

                    // Send button styled as a key pill
                    androidx.compose.foundation.layout.Box(
                        modifier = Modifier
                            .size(42.dp)
                            .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.15f))
                            .border(
                                0.5.dp,
                                borderColor.copy(alpha = 0.5f),
                                androidx.compose.foundation.shape.RoundedCornerShape(6.dp)
                            )
                            .clickable {
                                if (terminalInput.isNotBlank()) {
                                    bridge.writeInput(terminalInput + "\n")
                                    terminalInput = ""
                                }
                            },
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

                // Special keys row — below text input
                TerminalKeyboardRow(
                    onKeyPress = { seq -> bridge.writeInput(seq) },
                )
            }
        } else {
            // ── Chat mode — mirrors terminal page formatting ─────────
            Column(modifier = Modifier.fillMaxSize()) {
                val borderColor = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.surfaceBorder

                // Top bar — icon left, centered title, Claude icon right
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.background)
                        .padding(horizontal = 6.dp, vertical = 5.dp),
                ) {
                    // Terminal toggle pill — left
                    Box(
                        modifier = Modifier
                            .align(Alignment.CenterStart)
                            .height(34.dp)
                            .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.surface)
                            .border(0.5.dp, borderColor.copy(alpha = 0.5f), androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                            .clickable { isTerminalMode = true }
                            .padding(horizontal = 10.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            com.destins.claudemobile.ui.theme.AppIcons.Terminal,
                            contentDescription = "Switch to terminal",
                            tint = if (hasUnhandledInteractive)
                                MaterialTheme.colorScheme.primary
                            else
                                MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                    // Centered title
                    Text(
                        "Chat",
                        fontSize = 13.sp,
                        color = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.textSecondary,
                        modifier = Modifier.align(Alignment.Center),
                    )
                    // Claude icon pill — right
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

                // Chat messages
                LazyColumn(
                    state = listState,
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth(),
                    contentPadding = PaddingValues(vertical = 8.dp)
                ) {
                    items(chatState.messages) { message ->
                        MessageBubble(
                            message = message,
                            expandedCardId = chatState.expandedCardId,
                            onToggleCard = { chatState.toggleCard(it) },
                            onApprove = { bridge.sendApproval(true); chatState.resolveApproval() },
                            onReject = { bridge.sendApproval(false); chatState.resolveApproval() },
                            onViewTerminal = { isTerminalMode = true },
                            onMenuSelect = { index ->
                                // Send arrow-down × index + enter to navigate ink menu
                                repeat(index) { bridge.writeInput("\u001b[B") }
                                bridge.writeInput("\r")
                            },
                            onConfirmYes = { bridge.writeInput("y\n") },
                            onConfirmNo = { bridge.writeInput("n\n") },
                        )
                    }
                }

                HorizontalDivider(color = borderColor, thickness = 0.5.dp)

                // Input row — above chips, matching terminal layout
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
                            .border(
                                0.5.dp,
                                borderColor.copy(alpha = 0.5f),
                                androidx.compose.foundation.shape.RoundedCornerShape(6.dp)
                            ),
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
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 10.dp),
                            decorationBox = { innerTextField ->
                                if (chatInputText.isEmpty()) {
                                    Text(
                                        "Type a message...",
                                        fontSize = 14.sp,
                                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f),
                                    )
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
                            .border(
                                0.5.dp,
                                borderColor.copy(alpha = 0.5f),
                                androidx.compose.foundation.shape.RoundedCornerShape(6.dp)
                            )
                            .clickable {
                                if (chatInputText.isNotBlank()) {
                                    chatState.addUserMessage(chatInputText)
                                    bridge.writeInput(chatInputText + "\n")
                                    chatInputText = ""
                                }
                            },
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

                // Quick chips — below text input, matching terminal pills position
                if (!chatState.isWaitingForApproval) {
                    QuickChips(
                        chips = defaultChips,
                        onChipTap = { chip ->
                            if (chip.needsCompletion) {
                                chatInputText = chip.prompt
                            } else {
                                chatState.addUserMessage(chip.prompt)
                                bridge.writeInput(chip.prompt + "\n")
                            }
                        }
                    )
                }
            }

        }
    }
}
