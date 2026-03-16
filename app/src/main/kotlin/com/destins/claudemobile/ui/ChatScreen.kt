package com.destins.claudemobile.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Code
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.destins.claudemobile.config.defaultChips
import com.destins.claudemobile.parser.ParsedEvent
import com.destins.claudemobile.runtime.PtyBridge
import kotlinx.coroutines.launch

@Composable
fun ChatScreen(bridge: PtyBridge) {
    val chatState = remember { ChatState() }
    val listState = rememberLazyListState()
    val coroutineScope = rememberCoroutineScope()
    var prefillText by remember { mutableStateOf("") }
    var isTerminalMode by remember { mutableStateOf(false) }
    var hasUnhandledInteractive by remember { mutableStateOf(false) }

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
                    is ParsedEvent.OAuthRedirect -> chatState.addClaudeText("Open: ${event.url}")
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

    LaunchedEffect(chatState.messages.size) {
        if (chatState.messages.isNotEmpty()) {
            listState.animateScrollToItem(chatState.messages.size - 1)
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        // Top bar
        Surface(
            color = MaterialTheme.colorScheme.background,
            tonalElevation = 2.dp,
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text("Claude Mobile", style = MaterialTheme.typography.titleMedium)
                Row {
                    IconButton(onClick = { isTerminalMode = !isTerminalMode }) {
                        Icon(
                            if (isTerminalMode) Icons.Filled.Chat else Icons.Filled.Code,
                            contentDescription = "Toggle terminal",
                            tint = if (hasUnhandledInteractive)
                                MaterialTheme.colorScheme.primary
                            else
                                MaterialTheme.colorScheme.onSurface
                        )
                    }
                    Text(
                        if (bridge.isRunning) "Connected" else "Disconnected",
                        color = if (bridge.isRunning)
                            MaterialTheme.colorScheme.secondary
                        else
                            MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(top = 12.dp)
                    )
                }
            }
        }

        // Chat messages — compressed when terminal is open
        LazyColumn(
            state = listState,
            modifier = Modifier
                .weight(if (isTerminalMode) 0.4f else 1f)
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

        // Terminal panel — only shown when toggled
        if (isTerminalMode) {
            Column(modifier = Modifier.weight(0.6f)) {
                TerminalPanel(
                    session = bridge.getSession(),
                    modifier = Modifier.weight(1f),
                )
                TerminalKeyboardRow(
                    onKeyPress = { seq -> bridge.writeInput(seq) },
                )
            }
        }

        HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.3f))

        // Normal input + chips — hidden when terminal is open
        if (!isTerminalMode) {
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
    }
}
