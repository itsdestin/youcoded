package com.destin.code.runtime

import android.os.FileObserver
import com.destin.code.parser.HookEvent
import com.destin.code.parser.InkSelectParser
import com.destin.code.parser.TranscriptEvent
import com.destin.code.parser.TranscriptWatcher
import com.destin.code.ui.ChatState
import com.destin.code.ui.MessageContent
import com.destin.code.ui.state.PromptButton
import com.destin.code.ui.state.ChatAction
import com.destin.code.ui.state.ChatReducer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

/** Matches desktop's SessionStatusColor: green, red, blue, gray */
enum class SessionStatus { Active, AwaitingApproval, Unseen, Idle, Dead }

class ManagedSession(
    val id: String = UUID.randomUUID().toString(),
    val cwd: File,
    val homeDir: File,
    val dangerousMode: Boolean,
    val ptyBridge: PtyBridge? = null,
    val directShellBridge: DirectShellBridge? = null,
    val shellMode: Boolean = false,
    val chatState: ChatState = ChatState(),
    /** New turn-based state model — runs alongside old ChatState during transition. */
    val chatReducer: ChatReducer = ChatReducer(),
    /** Transcript watcher for this session — set externally by SessionRegistry. */
    var transcriptWatcher: TranscriptWatcher? = null,
    val createdAt: Long = System.currentTimeMillis(),
    private val titleFile: File,
    private val scope: CoroutineScope,
    /** Callback when session enters AwaitingApproval (for notification posting). */
    var onApprovalNeeded: ((sessionId: String, sessionName: String) -> Unit)? = null,
    /** Callback when session leaves AwaitingApproval (for notification clearing). */
    var onApprovalCleared: ((sessionId: String) -> Unit)? = null,
) {
    val isRunning: Boolean get() = ptyBridge?.isRunning ?: directShellBridge?.isRunning ?: false
    fun getTerminalSession(): com.termux.terminal.TerminalSession? =
        ptyBridge?.getSession() ?: directShellBridge?.getSession()
    fun writeInput(text: String) {
        ptyBridge?.writeInput(text) ?: directShellBridge?.writeInput(text)
    }
    val screenVersion: StateFlow<Int> get() =
        ptyBridge?.screenVersion ?: directShellBridge?.screenVersion ?: MutableStateFlow(0)

    /** Whether this session has been viewed since last response. Used for blue "unseen" status. */
    var hasBeenViewed: Boolean = true

    /** Callback to check if this session is currently focused. Set by SessionRegistry. */
    var isCurrentSession: (() -> Boolean)? = null

    private val _name = MutableStateFlow(if (shellMode) "Shell" else "New Session")
    val name: StateFlow<String> = _name

    private var titleObserver: FileObserver? = null
    private var topicObserver: FileObserver? = null

    // Status uses combine + a periodic isRunning check (isRunning is not reactive).
    // A 5-second polling coroutine feeds _isRunningFlow to make Dead detection reactive.
    private val _isRunningFlow = MutableStateFlow(true)

    /** Bumped when viewed state changes — forces status flow to re-derive. */
    private val _viewedTrigger = MutableStateFlow(0)

    /** Call when user switches to or away from this session. */
    fun notifyViewedStateChanged() {
        _viewedTrigger.value++
    }

    val status: StateFlow<SessionStatus> = if (ptyBridge != null) {
        combine(
            ptyBridge.lastPtyOutputTime,
            _isRunningFlow,
            _viewedTrigger,
        ) { _, isRunning, _ ->
            when {
                !isRunning -> SessionStatus.Dead
                else -> deriveStatus()
            }
        }.stateIn(scope, SharingStarted.WhileSubscribed(5000), SessionStatus.Idle)
    } else {
        // Shell sessions: simple isRunning-based status
        _isRunningFlow.let { flow ->
            combine(flow, flow) { isRunning, _ ->
                if (isRunning) SessionStatus.Active else SessionStatus.Dead
            }.stateIn(scope, SharingStarted.WhileSubscribed(5000), SessionStatus.Active)
        }
    }

    /**
     * Derive session status matching desktop's logic:
     *   red:   any tool awaiting approval
     *   green: isThinking or any tool running
     *   gray:  idle / no activity
     */
    private fun deriveStatus(): SessionStatus {
        val state = chatReducer.state
        val hasAwaiting = state.toolCalls.values.any {
            it.status == com.destin.code.ui.state.ToolCallStatus.AwaitingApproval
        }
        val hasRunning = state.toolCalls.values.any {
            it.status == com.destin.code.ui.state.ToolCallStatus.Running
        }
        return when {
            hasAwaiting -> SessionStatus.AwaitingApproval
            state.isThinking || hasRunning -> SessionStatus.Active
            state.timeline.isNotEmpty() && !hasBeenViewed -> SessionStatus.Unseen
            else -> SessionStatus.Idle
        }
    }

    /**
     * Start background collectors that run for the session's entire lifetime.
     * This includes: hook event collection, isRunning polling, approval notifications.
     */
    fun startBackgroundCollectors() {
        if (shellMode) {
            // Shell sessions only need isRunning polling
            scope.launch {
                while (true) {
                    delay(5000)
                    val running = directShellBridge?.isRunning ?: false
                    _isRunningFlow.value = running
                    if (!running) break
                }
            }
            return
        }

        val bridge = ptyBridge ?: return

        // 1. Per-session hook event collector — runs regardless of which session is "current".
        //    All ChatState mutations dispatched to Main to avoid snapshot state race conditions.
        scope.launch {
            // Wait for EventBridge to become available
            var eventBridge = bridge.getEventBridge()
            while (eventBridge == null) {
                delay(200)
                eventBridge = bridge.getEventBridge()
            }
            eventBridge.events.collect { event ->
                // Check for session ID mapping and start topic/transcript observers
                val claudeSessionId = eventBridge.getClaudeSessionId(id)
                if (claudeSessionId != null) {
                    if (topicObserver == null) startTopicObserver(claudeSessionId)
                    startTranscriptWatcherIfNeeded(claudeSessionId)
                }
                withContext(Dispatchers.Main) {
                    routeHookEvent(event)
                    routeHookEventToReducer(event)
                }
            }
        }

        // 1b. Transcript event collector — primary source for the new turn-based UI.
        //     TranscriptWatcher starts once we learn the Claude session ID (in hook collector above).
        scope.launch {
            val watcher = transcriptWatcher ?: return@launch
            watcher.events.collect { event ->
                withContext(Dispatchers.Main) {
                    routeTranscriptEvent(event)
                }
            }
        }

        // 2. isRunning poller — makes Dead status reactive.
        //    Also force-clears the message queue when the session dies (Fix 5).
        scope.launch {
            while (true) {
                delay(5000)
                _isRunningFlow.value = bridge.isRunning
                if (!bridge.isRunning) {
                    withContext(Dispatchers.Main) {
                        chatState.resetStaleProcessingPeriodic()
                    }
                    break
                }
            }
        }

        // 2b. Periodic queue health check — catches stuck processing state
        //     even when no new user message triggers resetStaleProcessing().
        scope.launch {
            while (true) {
                delay(5000)
                if (!bridge.isRunning) break
                if (chatState.isProcessing) {
                    withContext(Dispatchers.Main) {
                        chatState.resetStaleProcessingPeriodic()
                    }
                }
            }
        }

        // 3. Approval notification observer — fires callbacks when status changes.
        scope.launch {
            var wasAwaiting = false
            status.collect { s ->
                val isAwaiting = s == SessionStatus.AwaitingApproval
                if (isAwaiting && !wasAwaiting) {
                    onApprovalNeeded?.invoke(id, _name.value)
                } else if (!isAwaiting && wasAwaiting) {
                    onApprovalCleared?.invoke(id)
                }
                wasAwaiting = isAwaiting
            }
        }

        // 4. Setup prompt detector — watches PTY output for known interactive prompts.
        scope.launch {
            try {
                val activePrompts = mutableSetOf<String>()
                while (true) {
                    delay(1000)
                    if (!bridge.isRunning) break
                    val screen = try { bridge.readScreenText() } catch (_: Exception) { "" }
                    val raw = try { bridge.rawBuffer.takeLast(4000) } catch (_: Exception) { "" }
                    val combined = screen + "\n" + raw
                    withContext(Dispatchers.Main) {
                        detectPrompts(screen, combined, activePrompts)
                        detectPermissionMode(screen)
                    }
                }
            } catch (_: Exception) {}
        }

        // 5. PTY output consumer — previously surfaced error/warning lines from terminal
        // output as chat notices, but the keyword filter was too broad and created noise.
        // Removed: errors and warnings are visible in terminal view if needed.
    }

    // Track prompts that have been completed so we don't re-create them
    private val completedPromptIds = mutableSetOf<String>()

    // Track consecutive polls where a prompt was absent — debounce dismissal
    // to prevent flicker when terminal output temporarily hides a prompt
    private val absentPollCounts = mutableMapOf<String, Int>()
    private val DISMISS_THRESHOLD = 2  // require 2+ absent polls before dismissing

    /** Detect permission mode from visible screen only (not raw buffer). */
    private fun detectPermissionMode(screen: String) {
        val lower = screen.lowercase()
        val mode = when {
            "bypass permissions on" in lower -> "Bypass"
            "accept edits on" in lower -> "Auto-Accept"
            "plan mode on" in lower -> "Plan Mode"
            else -> "Normal"
        }
        chatState.permissionMode = mode
        chatReducer.state.permissionMode = mode
    }

    /** Known setup prompts and their button mappings.
     *  @param screenText visible terminal screen only (for menu parsing)
     *  @param combined screen + raw buffer (for keyword-based special cases)
     */
    private fun detectPrompts(screenText: String, combined: String, activePrompts: MutableSet<String>) {
        val lower = combined.lowercase()
        val screenLower = screenText.lowercase()

        // --- Hardcoded: Login method selection (multi-line options break generic parser) ---
        if ("select login method" in screenLower) {
            absentPollCounts.remove("auth")
            if ("auth" !in activePrompts && "auth" !in completedPromptIds) {
                activePrompts.add("auth")
                val down = "\u001b[B"
                chatState.showInteractivePrompt("auth", "Select Login Method", listOf(
                    PromptButton("Claude Account (Pro/Max/Team)", "\r"),
                    PromptButton("Anthropic Console (API)", "$down\r"),
                    PromptButton("3rd-Party Platform", "$down$down\r"),
                ))
                chatReducer.dispatch(ChatAction.ShowPrompt(
                    promptId = "auth",
                    title = "Select Login Method",
                    buttons = listOf(
                        PromptButton("Claude Account (Pro/Max/Team)", "\r"),
                        PromptButton("Anthropic Console (API)", "$down\r"),
                        PromptButton("3rd-Party Platform", "$down$down\r"),
                    ),
                ))
            }
            return  // skip generic parser for this screen
        } else if ("auth" in activePrompts) {
            val count = absentPollCounts.getOrDefault("auth", 0) + 1
            absentPollCounts["auth"] = count
            if (count >= DISMISS_THRESHOLD) {
                activePrompts.remove("auth")
                chatState.dismissPrompt("auth")
                chatReducer.dispatch(ChatAction.DismissPrompt("auth"))
                absentPollCounts.remove("auth")
            }
        }

        // --- Skip generic parser when a tool approval card is already handling the prompt ---
        val hasActiveApproval = chatState.messages.any {
            it.content is MessageContent.ToolAwaitingApproval
        }
        if (hasActiveApproval) return

        // --- Generic Ink Select menu detection (screen only, not raw buffer) ---
        val parsed = InkSelectParser.parse(screenText)
        if (parsed != null) {
            absentPollCounts.remove(parsed.id)
            if (parsed.id !in activePrompts && parsed.id !in completedPromptIds) {
                // Clear any previous generic menu that is no longer showing
                val staleMenus = activePrompts.filter { it.startsWith("menu_") }
                for (stale in staleMenus) {
                    activePrompts.remove(stale)
                    completedPromptIds.add(stale)
                    chatState.dismissPrompt(stale)
                    chatReducer.dispatch(ChatAction.DismissPrompt(stale))
                    absentPollCounts.remove(stale)
                }
                activePrompts.add(parsed.id)
                chatState.showInteractivePrompt(
                    parsed.id,
                    parsed.title,
                    InkSelectParser.toPromptButtons(parsed),
                )
                chatReducer.dispatch(ChatAction.ShowPrompt(
                    promptId = parsed.id,
                    title = parsed.title,
                    buttons = InkSelectParser.toPromptButtons(parsed),
                ))
            }
        } else {
            // No menu detected — debounce dismissal of active generic menus
            val staleMenus = activePrompts.filter { it.startsWith("menu_") }
            for (stale in staleMenus) {
                val count = absentPollCounts.getOrDefault(stale, 0) + 1
                absentPollCounts[stale] = count
                if (count >= DISMISS_THRESHOLD) {
                    activePrompts.remove(stale)
                    chatState.dismissPrompt(stale)
                    chatReducer.dispatch(ChatAction.DismissPrompt(stale))
                    absentPollCounts.remove(stale)
                }
            }
        }

        // --- Special-case: Browser auth / paste code prompt ---
        // (Not an Ink Select menu — just informational text with no selectable options)
        if (("paste code" in lower || "paste the code" in lower || "browser" in lower) &&
            ("sign" in lower || "code" in lower || "authorize" in lower)) {
            if ("paste_code" !in activePrompts && "paste_code" !in completedPromptIds) {
                activePrompts.add("paste_code")
                chatState.showInteractivePrompt("paste_code", "Complete Sign-In in Your Browser", listOf(
                    PromptButton("Browser opened — waiting for code...", ""),
                ))
                chatReducer.dispatch(ChatAction.ShowPrompt(
                    promptId = "paste_code",
                    title = "Complete Sign-In in Your Browser",
                    buttons = listOf(PromptButton("Browser opened — waiting for code...", "")),
                ))
            }
        } else if ("paste_code" in activePrompts) {
            val count = absentPollCounts.getOrDefault("paste_code", 0) + 1
            absentPollCounts["paste_code"] = count
            if (count >= DISMISS_THRESHOLD) {
                activePrompts.remove("paste_code")
                chatState.dismissPrompt("paste_code")
                chatReducer.dispatch(ChatAction.DismissPrompt("paste_code"))
                absentPollCounts.remove("paste_code")
            }
        }

        // --- Special-case: "Press Enter to continue" ---
        // (Single-action prompt, not an Ink Select menu)
        if ("press enter to continue" in lower) {
            // Auto-collapse the browser sign-in card if still active
            if ("paste_code" in activePrompts) {
                activePrompts.remove("paste_code")
                completedPromptIds.add("paste_code")
                chatState.completePrompt("paste_code", "Signed in")
                chatReducer.dispatch(ChatAction.CompletePrompt(promptId = "paste_code", selection = "Signed in"))
            }
            val continueKey = when {
                "login successful" in lower -> "continue_login"
                "security" in lower -> "continue_security"
                else -> "continue_other"
            }
            if (continueKey !in activePrompts && continueKey !in completedPromptIds) {
                activePrompts.add(continueKey)
                val title = when {
                    "login successful" in lower -> "Login Successful!"
                    "security" in lower -> "Remember, Claude Can Make Mistakes"
                    else -> "Ready"
                }
                chatState.showInteractivePrompt(continueKey, title, listOf(
                    PromptButton("Continue", "\r"),
                ))
                chatReducer.dispatch(ChatAction.ShowPrompt(
                    promptId = continueKey,
                    title = title,
                    buttons = listOf(PromptButton("Continue", "\r")),
                ))
            }
        } else {
            // Debounce dismissal of continue prompts
            val staleContinues = activePrompts.filter { it.startsWith("continue_") }
            for (stale in staleContinues) {
                val count = absentPollCounts.getOrDefault(stale, 0) + 1
                absentPollCounts[stale] = count
                if (count >= DISMISS_THRESHOLD) {
                    activePrompts.remove(stale)
                    chatState.dismissPrompt(stale)
                    chatReducer.dispatch(ChatAction.DismissPrompt(stale))
                    absentPollCounts.remove(stale)
                }
            }
        }
    }

    /**
     * Route a hook event to this session's ChatState.
     * Must be called on Main dispatcher (ChatState uses Compose snapshot state).
     */
    private fun routeHookEvent(event: HookEvent) {
        when (event) {
            is HookEvent.PreToolUse -> {
                val argsSummary = event.toolInput.optString("command",
                    event.toolInput.optString("file_path",
                        event.toolInput.optString("pattern",
                            event.toolInput.toString().take(80))))
                chatState.addToolRunning(event.toolUseId, event.toolName, argsSummary)
            }
            is HookEvent.PostToolUse -> {
                // Cross-path cleanup: if tool was awaiting approval with a held socket, close it
                cleanupOrphanedSocket(event.toolUseId)
                chatState.updateToolToComplete(event.toolUseId, event.toolResponse)
            }
            is HookEvent.PostToolUseFailure -> {
                cleanupOrphanedSocket(event.toolUseId)
                chatState.updateToolToFailed(event.toolUseId, event.toolResponse)
            }
            is HookEvent.Stop -> {
                chatState.addResponse(event.lastAssistantMessage)
            }
            is HookEvent.Notification -> {
                if (event.notificationType == "permission_prompt") {
                    // Best-effort match: Notification events don't carry tool_name,
                    // so we still fall back to last running tool
                    val lastRunning = chatState.messages.lastOrNull {
                        it.content is MessageContent.ToolRunning
                    }
                    val toolUseId = (lastRunning?.content as? MessageContent.ToolRunning)?.toolUseId
                    if (toolUseId != null) {
                        val hasAlways = ptyBridge?.hasAlwaysAllowOption() ?: false
                        chatState.updateToolToApproval(toolUseId, hasAlways)
                    }
                } else {
                    chatState.addSystemNotice(event.message)
                }
            }
            is HookEvent.PermissionRequest -> {
                // Match by tool name first for accuracy when multiple tools fire rapidly,
                // then fall back to last running tool if no name match
                val matchByName = chatState.messages.lastOrNull {
                    val c = it.content
                    c is MessageContent.ToolRunning && c.tool == event.toolName
                }
                val lastRunning = matchByName ?: chatState.messages.lastOrNull {
                    it.content is MessageContent.ToolRunning
                }
                val toolUseId = (lastRunning?.content as? MessageContent.ToolRunning)?.toolUseId
                if (toolUseId != null) {
                    val hasAlways = event.permissionSuggestions != null &&
                        event.permissionSuggestions.length() > 0
                    chatState.updateToolToApproval(
                        toolUseId,
                        hasAlways,
                        event.requestId,
                        event.permissionSuggestions,
                    )
                }
            }
        }
    }

    /** Close an orphaned PermissionRequest socket if the tool completes via another path. */
    private fun cleanupOrphanedSocket(toolUseId: String) {
        val approval = chatState.messages.lastOrNull {
            (it.content as? MessageContent.ToolAwaitingApproval)?.toolUseId == toolUseId
        }?.content as? MessageContent.ToolAwaitingApproval
        if (approval?.requestId != null) {
            ptyBridge?.getEventBridge()?.closeSocket(approval.requestId)
        }
    }

    /** Mark a prompt as completed so the detector won't re-create it. */
    fun markPromptCompleted(promptId: String) {
        completedPromptIds.add(promptId)
    }

    // ─── Transcript watcher integration ─────────────────────────

    private var transcriptWatcherStarted = false

    private fun startTranscriptWatcherIfNeeded(claudeSessionId: String) {
        if (transcriptWatcherStarted) return
        // Use the transcript path from Claude Code (avoids symlink/slug mismatches)
        val transcriptPath = ptyBridge?.getEventBridge()?.getTranscriptPath(id)
        if (transcriptPath.isNullOrBlank()) return
        transcriptWatcherStarted = true
        transcriptWatcher?.startWatching(id, transcriptPath)
    }

    /**
     * Route transcript events to the new ChatReducer.
     * Must be called on Main dispatcher.
     */
    private fun routeTranscriptEvent(event: TranscriptEvent) {
        when (event) {
            is TranscriptEvent.UserMessage -> chatReducer.dispatch(
                ChatAction.TranscriptUserMessage(event.uuid, event.text, event.timestamp)
            )
            is TranscriptEvent.AssistantText -> chatReducer.dispatch(
                ChatAction.TranscriptAssistantText(event.uuid, event.text, event.timestamp)
            )
            is TranscriptEvent.ToolUse -> chatReducer.dispatch(
                ChatAction.TranscriptToolUse(
                    event.uuid, event.toolUseId, event.toolName, event.toolInput,
                )
            )
            is TranscriptEvent.ToolResult -> chatReducer.dispatch(
                ChatAction.TranscriptToolResult(
                    event.uuid, event.toolUseId, event.result, event.isError,
                )
            )
            is TranscriptEvent.TurnComplete -> {
                chatReducer.dispatch(
                    ChatAction.TranscriptTurnComplete(event.uuid, event.timestamp)
                )
                // Only mark unseen if user is NOT currently looking at this session
                if (isCurrentSession?.invoke() != true) {
                    hasBeenViewed = false
                }
            }
            is TranscriptEvent.StreamingText -> {
                chatReducer.dispatch(ChatAction.StreamingText(event.text))
            }
        }
    }

    /**
     * Route hook events to the new ChatReducer (permission flow only).
     * Must be called on Main dispatcher.
     */
    private fun routeHookEventToReducer(event: HookEvent) {
        when (event) {
            is HookEvent.PermissionRequest -> {
                val suggestions = event.permissionSuggestions?.let { arr ->
                    (0 until arr.length()).map { arr.optString(it) }
                }
                chatReducer.dispatch(ChatAction.PermissionRequest(
                    toolName = event.toolName,
                    input = event.toolInput,
                    requestId = event.requestId,
                    permissionSuggestions = suggestions,
                ))
            }
            // PostToolUse/PostToolUseFailure are handled by transcript watcher
            // via ToolResult events — no need to duplicate here.
            else -> {}
        }
    }

    fun startTitleObserver() {
        titleFile.parentFile?.mkdirs()
        if (!titleFile.exists()) titleFile.writeText("")

        // Use File-based constructor (non-deprecated on API 29+)
        titleObserver = object : FileObserver(titleFile, CLOSE_WRITE or MODIFY) {
            override fun onEvent(event: Int, path: String?) {
                try {
                    val newName = titleFile.readText().trim()
                    if (newName.isNotBlank()) {
                        _name.value = newName
                    }
                } catch (_: Exception) {}
            }
        }
        titleObserver?.startWatching()

        // Read current value if the file already has a title
        val existing = titleFile.readText().trim()
        if (existing.isNotBlank()) {
            _name.value = existing
        }
    }

    fun startTopicObserver(claudeSessionId: String) {
        val topicDir = File(homeDir, ".claude/topics")
        topicDir.mkdirs()
        val topicFileName = "topic-$claudeSessionId"
        val topicFile = File(topicDir, topicFileName)

        // Watch the DIRECTORY, not the file — the file may not exist yet.
        topicObserver = object : FileObserver(topicDir, CLOSE_WRITE or MODIFY or CREATE) {
            override fun onEvent(event: Int, path: String?) {
                if (path != topicFileName) return
                try {
                    val newName = topicFile.readText().trim()
                    if (newName.isNotBlank() && newName != "New Session") {
                        _name.value = newName
                        try { titleFile.writeText(newName) } catch (_: Exception) {}
                    }
                } catch (_: Exception) {}
            }
        }
        topicObserver?.startWatching()

        // Read current value if the file already exists
        if (topicFile.exists()) {
            val currentTopic = topicFile.readText().trim()
            if (currentTopic.isNotBlank() && currentTopic != "New Session") {
                _name.value = currentTopic
            }
        }
    }

    fun destroy() {
        titleObserver?.stopWatching()
        titleObserver = null
        topicObserver?.stopWatching()
        topicObserver = null
        transcriptWatcher?.stopWatching(id)
        ptyBridge?.stop()
        directShellBridge?.stop()
        try { titleFile.delete() } catch (_: Exception) {}
    }
}
