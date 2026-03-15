package com.destins.claudemobile.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.destins.claudemobile.config.defaultChips
import com.destins.claudemobile.runtime.PtyBridge
import kotlinx.coroutines.launch

@Composable
fun ChatScreen(bridge: PtyBridge) {
    val chatState = remember { ChatState() }
    val listState = rememberLazyListState()
    val coroutineScope = rememberCoroutineScope()
    var prefillText by remember { mutableStateOf("") }

    LaunchedEffect(bridge) {
        bridge.outputFlow.collect { output ->
            if (output.isNotBlank()) {
                chatState.addRawOutput(output)
            }
        }
    }

    LaunchedEffect(chatState.messages.size) {
        if (chatState.messages.isNotEmpty()) {
            listState.animateScrollToItem(chatState.messages.size - 1)
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
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
                Text(
                    if (bridge.isRunning) "Connected" else "Disconnected",
                    color = if (bridge.isRunning)
                        MaterialTheme.colorScheme.secondary
                    else
                        MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall
                )
            }
        }

        LazyColumn(
            state = listState,
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
            contentPadding = PaddingValues(vertical = 8.dp)
        ) {
            items(chatState.messages) { message ->
                MessageBubble(message)
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
}
