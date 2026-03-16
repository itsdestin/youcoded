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
    var isTerminalMode by remember { mutableStateOf(false) }
    var hasUnhandledInteractive by remember { mutableStateOf(false) }
    var showBtwSheet by remember { mutableStateOf(false) }

    // Collect screen version to trigger terminal panel recomposition on PTY output
    val screenVersion by bridge.screenVersion.collectAsState()

    LaunchedEffect(bridge) {
        val eventBridge = bridge.getEventBridge()
        if (eventBridge != null) {
            eventBridge.events.collect { event ->
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
                        if (event.text.isNotBlank()) chatState.addClaudeText(event.text)
                    }
                    is ParsedEvent.InteractiveMenu -> {
                        chatState.addRawOutput(event.raw)
                        hasUnhandledInteractive = true
                    }
                    is ParsedEvent.Confirmation -> chatState.addClaudeText(event.question)
                    is ParsedEvent.TextPrompt -> chatState.addClaudeText(event.prompt)
                    is ParsedEvent.OAuthRedirect -> {
                        // Auto-open auth URL in system browser
                        try {
                            val intent = android.content.Intent(
                                android.content.Intent.ACTION_VIEW,
                                android.net.Uri.parse(event.url)
                            )
                            context.startActivity(intent)
                        } catch (_: Exception) {}
                        chatState.addClaudeText("Opening: ${event.url}")
                    }
                }
            }
        } else {
            // Fallback: raw PTY output
            bridge.outputFlow.collect { output ->
                if (output.isNotBlank()) {
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
                // Top bar with toggle on the left
                Surface(
                    color = MaterialTheme.colorScheme.background,
                    tonalElevation = 2.dp,
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        IconButton(onClick = { isTerminalMode = false }) {
                            Icon(
                                com.destins.claudemobile.ui.theme.AppIcons.Chat,
                                contentDescription = "Switch to chat",
                                tint = MaterialTheme.colorScheme.onSurface,
                            )
                        }
                        Spacer(Modifier.width(4.dp))
                        Text("Terminal", style = MaterialTheme.typography.titleSmall)
                    }
                }

                // Terminal canvas — fills all available space
                TerminalPanel(
                    session = bridge.getSession(),
                    screenVersion = screenVersion,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                )

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
            // ── Chat mode ──────────────────────────────────────────────
            Column(modifier = Modifier.fillMaxSize()) {
                // Top bar with toggle on the left
                Surface(
                    color = MaterialTheme.colorScheme.background,
                    tonalElevation = 2.dp,
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        IconButton(onClick = { isTerminalMode = true }) {
                            Icon(
                                com.destins.claudemobile.ui.theme.AppIcons.Terminal,
                                contentDescription = "Switch to terminal",
                                tint = if (hasUnhandledInteractive)
                                    MaterialTheme.colorScheme.primary
                                else
                                    MaterialTheme.colorScheme.onSurface,
                            )
                        }
                        Spacer(Modifier.width(4.dp))
                        Text("Claude Mobile", style = MaterialTheme.typography.titleMedium)
                        Spacer(Modifier.weight(1f))
                        Text(
                            if (bridge.isRunning) "Connected" else "Disconnected",
                            color = if (bridge.isRunning)
                                MaterialTheme.colorScheme.secondary
                            else
                                MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }

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
                        )
                    }
                }

                HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.3f))

                if (!chatState.isWaitingForApproval) {
                    QuickChips(
                        chips = defaultChips,
                        onChipTap = { chip ->
                            if (chip.needsCompletion) {
                                prefillText = chip.prompt
                            } else {
                                chatState.addUserMessage(chip.prompt)
                                bridge.writeInput(chip.prompt + "\n")
                            }
                        }
                    )
                }

                InputBar(
                    isApprovalMode = chatState.isWaitingForApproval,
                    approvalSummary = chatState.approvalSummary,
                    prefillText = prefillText,
                    onPrefillConsumed = { prefillText = "" },
                    onSend = { text ->
                        chatState.addUserMessage(text)
                        bridge.writeInput(text + "\n")
                    },
                    onApprove = {
                        bridge.sendApproval(true)
                        chatState.resolveApproval()
                    },
                    onReject = {
                        bridge.sendApproval(false)
                        chatState.resolveApproval()
                    },
                )
            }

            // /btw FAB
            FloatingActionButton(
                onClick = { showBtwSheet = true },
                containerColor = MaterialTheme.colorScheme.primary,
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(end = 16.dp, bottom = 80.dp),
            ) {
                Text("/btw", color = Color.White, fontSize = 12.sp)
            }
        }
    }

    // Bottom sheet (outside the Box)
    if (showBtwSheet) {
        BtwSheet(
            messages = chatState.messages,
            onSend = { text ->
                chatState.addUserMessage(text, isBtw = true)
                bridge.sendBtw(text)
            },
            onDismiss = { showBtwSheet = false },
        )
    }
}
