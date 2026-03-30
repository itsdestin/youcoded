package com.destin.code.ui.v2

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.destin.code.ui.state.*
import kotlinx.coroutines.launch

/**
 * Turn-based chat view matching the desktop's ChatView.tsx.
 *
 * Renders the timeline from ChatReducer's SessionChatState:
 *   [User] → [AssistantTurn] → [Prompt] → [User] → ...
 *
 * Tools awaiting approval are rendered as standalone cards at the bottom,
 * separate from the turn they belong to (matching desktop behavior).
 *
 * Auto-scrolls to bottom on new content unless user has scrolled up.
 */
@Composable
fun ChatViewV2(
    reducer: ChatReducer,
    onPromptAction: (promptId: String, input: String) -> Unit,
    onAcceptTool: (ToolCallState) -> Unit,
    onAcceptAlwaysTool: (ToolCallState) -> Unit,
    onRejectTool: (ToolCallState) -> Unit,
    modifier: Modifier = Modifier,
) {
    val state = reducer.state

    val listState = rememberLazyListState()
    val coroutineScope = rememberCoroutineScope()

    // Track which tool is expanded
    var expandedToolId by remember { mutableStateOf<String?>(null) }

    // Collect tools awaiting approval (rendered at bottom, outside turns).
    // Reading from SnapshotStateMap — Compose observes mutations directly.
    val awaitingApproval = state.toolCalls.values.filter {
        it.status == ToolCallStatus.AwaitingApproval
    }

    // Build display list: timeline entries + awaiting approval + thinking indicator.
    // state.timeline is a mutableStateListOf — Compose observes additions/removals.
    val displayItems = buildList {
        for (entry in state.timeline) {
            add(DisplayItem.Timeline(entry))
        }
        // Optimistic user message echo — shown before transcript confirms
        val pendingText = state.pendingUserText
        if (pendingText.isNotBlank()) {
            add(DisplayItem.PendingUser(pendingText))
        }
        for (tool in awaitingApproval) {
            add(DisplayItem.ApprovalCard(tool))
        }
        if (state.isThinking && awaitingApproval.isEmpty()) {
            add(DisplayItem.Thinking)
        }
    }

    // Auto-scroll to bottom when new content arrives
    LaunchedEffect(displayItems.size) {
        if (displayItems.isNotEmpty()) {
            val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()
            val totalItems = listState.layoutInfo.totalItemsCount
            // Only auto-scroll if we're near the bottom (within 3 items)
            if (lastVisible != null && totalItems - lastVisible.index <= 3) {
                coroutineScope.launch {
                    listState.animateScrollToItem(displayItems.size - 1)
                }
            }
        }
    }

    LazyColumn(
        state = listState,
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(vertical = 8.dp),
    ) {
        items(
            items = displayItems,
            key = { it.key },
        ) { item ->
            when (item) {
                is DisplayItem.Timeline -> {
                    when (val entry = item.entry) {
                        is TimelineEntry.User -> {
                            UserMessageBubble(message = entry.message)
                        }
                        is TimelineEntry.Turn -> {
                            val turn = state.assistantTurns[entry.turnId]
                            if (turn != null) {
                                AssistantTurnBubble(
                                    turn = turn,
                                    toolGroups = state.toolGroups,
                                    toolCalls = state.toolCalls,
                                    expandedToolId = expandedToolId,
                                    onToggleTool = { id ->
                                        expandedToolId = if (expandedToolId == id) null else id
                                    },
                                    onAccept = onAcceptTool,
                                    onAcceptAlways = onAcceptAlwaysTool,
                                    onReject = onRejectTool,
                                )
                            }
                        }
                        is TimelineEntry.Prompt -> {
                            PromptCardV2(
                                prompt = entry.prompt,
                                onAction = onPromptAction,
                            )
                        }
                    }
                }
                is DisplayItem.ApprovalCard -> {
                    // Standalone approval card at bottom — desktop: px-4
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 4.dp),
                        horizontalArrangement = Arrangement.Start,
                    ) {
                        ToolCardV2(
                            tool = item.tool,
                            isExpanded = true,
                            onAccept = { onAcceptTool(item.tool) },
                            onAcceptAlways = { onAcceptAlwaysTool(item.tool) },
                            onReject = { onRejectTool(item.tool) },
                            modifier = Modifier.fillMaxWidth(0.85f),
                        )
                    }
                }
                is DisplayItem.PendingUser -> {
                    UserMessageBubble(
                        message = ChatMessage(
                            id = "pending",
                            role = ChatRole.User,
                            content = item.text,
                            timestamp = System.currentTimeMillis(),
                        ),
                    )
                }
                is DisplayItem.Thinking -> {
                    ThinkingIndicator()
                }
            }
        }
    }
}

/** Sealed items for the display list — provides stable keys for LazyColumn. */
private sealed class DisplayItem {
    abstract val key: String

    data class Timeline(val entry: TimelineEntry) : DisplayItem() {
        override val key: String get() = when (entry) {
            is TimelineEntry.User -> "user-${entry.message.id}"
            is TimelineEntry.Turn -> "turn-${entry.turnId}"
            is TimelineEntry.Prompt -> "prompt-${entry.prompt.promptId}"
        }
    }

    data class ApprovalCard(val tool: ToolCallState) : DisplayItem() {
        override val key: String get() = "approval-${tool.toolUseId}"
    }

    data class PendingUser(val text: String) : DisplayItem() {
        override val key: String = "pending-user"
    }

    data object Thinking : DisplayItem() {
        override val key: String = "thinking"
    }
}
