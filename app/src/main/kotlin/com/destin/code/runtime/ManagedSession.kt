package com.destin.code.runtime

import android.os.FileObserver
import com.destin.code.bridge.LocalBridgeServer
import com.destin.code.bridge.TranscriptSerializer
import com.destin.code.bridge.HookSerializer
import com.destin.code.parser.HookEvent
import com.destin.code.parser.InkSelectParser
import com.destin.code.parser.PromptButton
import com.destin.code.parser.TranscriptEvent
import com.destin.code.parser.TranscriptWatcher
import org.json.JSONObject
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
import kotlinx.coroutines.isActive
import java.io.File
import java.util.UUID
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue

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
    /** Bridge server for forwarding events to React UI. Set by SessionRegistry. */
    var bridgeServer: LocalBridgeServer? = null

    /** Current Claude Code permission mode, detected from terminal status bar. */
    var permissionMode: String = "Normal"

    /** Draft text in the input bar — shared across Chat/Terminal/Shell modes */
    var inputDraft by mutableStateOf(TextFieldValue())

    /** Set draft text with cursor at end */
    fun setDraftText(text: String) {
        inputDraft = TextFieldValue(text, TextRange(text.length))
    }

    /** Clear draft */
    fun clearDraft() {
        inputDraft = TextFieldValue()
    }

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
     * Derive session status from simple heuristics now that ChatReducer is gone.
     * The React UI tracks tool/approval state; here we just use idle/unseen.
     */
    private fun deriveStatus(): SessionStatus {
        return when {
            !hasBeenViewed -> SessionStatus.Unseen
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
                }

                // Forward to bridge server for React UI
                bridgeServer?.let { server ->
                    when (event) {
                        is HookEvent.PermissionRequest -> {
                            val suggestions = event.permissionSuggestions?.let { arr ->
                                (0 until arr.length()).map { arr.optString(it) }
                            } ?: emptyList()
                            server.broadcast(HookSerializer.permissionRequest(
                                sessionId = id,
                                requestId = event.requestId,
                                toolName = event.toolName,
                                toolInput = event.toolInput,
                                suggestions = suggestions
                            ))
                        }
                        is HookEvent.Notification -> {
                            server.broadcast(HookSerializer.notification(
                                sessionId = id,
                                message = event.message
                            ))
                        }
                        else -> {}
                    }
                }
            }
        }

        // 1b. Transcript event collector — forwards events to React UI via bridge server.
        //     TranscriptWatcher starts once we learn the Claude session ID (in hook collector above).
        scope.launch {
            val watcher = transcriptWatcher ?: return@launch
            watcher.events.collect { event ->
                withContext(Dispatchers.Main) {
                    // Mark unseen on turn complete if session isn't focused
                    if (event is TranscriptEvent.TurnComplete) {
                        if (isCurrentSession?.invoke() != true) {
                            hasBeenViewed = false
                        }
                    }
                }

                // Forward to bridge server for React UI
                bridgeServer?.let { server ->
                    val serialized = when (event) {
                        is TranscriptEvent.UserMessage -> TranscriptSerializer.userMessage(event.sessionId, event.uuid, event.timestamp, event.text)
                        is TranscriptEvent.AssistantText -> TranscriptSerializer.assistantText(event.sessionId, event.uuid, event.timestamp, event.text)
                        is TranscriptEvent.ToolUse -> TranscriptSerializer.toolUse(event.sessionId, event.uuid, event.timestamp, event.toolUseId, event.toolName, event.toolInput)
                        is TranscriptEvent.ToolResult -> TranscriptSerializer.toolResult(event.sessionId, event.uuid, event.timestamp, event.toolUseId, event.result, event.isError)
                        is TranscriptEvent.TurnComplete -> TranscriptSerializer.turnComplete(event.sessionId, event.uuid, event.timestamp)
                        is TranscriptEvent.StreamingText -> TranscriptSerializer.streamingText(event.sessionId, event.text)
                    }
                    server.broadcast(JSONObject().apply {
                        put("type", "transcript:event")
                        put("payload", serialized)
                    })
                }
            }
        }

        // 2. isRunning poller — makes Dead status reactive.
        scope.launch {
            while (true) {
                delay(5000)
                _isRunningFlow.value = bridge.isRunning
                if (!bridge.isRunning) break
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
                var lastScreenHash = 0
                var sessionReadyBroadcast = false
                while (true) {
                    delay(1000)
                    if (!bridge.isRunning) break
                    val screen = try { bridge.readScreenText() } catch (_: Exception) { "" }
                    val raw = try { bridge.rawBuffer.takeLast(4000) } catch (_: Exception) { "" }
                    val combined = screen + "\n" + raw
                    val screenHash = screen.hashCode()
                    withContext(Dispatchers.Main) {
                        if (screenHash != lastScreenHash) {
                            lastScreenHash = screenHash
                        }
                        detectPrompts(screen, combined, activePrompts)
                        detectPermissionMode(screen)

                        // Detect Claude Code ready state — dismiss React "Initializing" overlay
                        if (!sessionReadyBroadcast && screen.isNotBlank()) {
                            // Claude Code shows a ">" prompt or has visible content
                            // Any non-blank screen after session start means it's alive
                            sessionReadyBroadcast = true
                            bridgeServer?.broadcast(JSONObject().apply {
                                put("type", "prompt:show")
                                put("payload", JSONObject().apply {
                                    put("sessionId", id)
                                    put("promptId", "_session_ready")
                                    put("title", "")
                                    put("buttons", org.json.JSONArray())
                                })
                            })
                            // Immediately dismiss it
                            bridgeServer?.broadcast(JSONObject().apply {
                                put("type", "prompt:dismiss")
                                put("payload", JSONObject().apply {
                                    put("sessionId", id)
                                    put("promptId", "_session_ready")
                                })
                            })
                        }
                    }
                }
            } catch (_: Exception) {}
        }
    }

    // Track prompts that have been completed so we don't re-create them
    private val completedPromptIds = mutableSetOf<String>()

    // Track consecutive polls where a prompt was absent — debounce dismissal
    private val absentPollCounts = mutableMapOf<String, Int>()
    private val DISMISS_THRESHOLD = 2

    /** Titles of known setup prompts — only these are broadcast via prompt:show.
     *  Matches InkSelectParser.TITLE_OVERRIDES values. Runtime permission prompts
     *  (Yes/No/Always Allow) are handled by the hook system and must NOT be
     *  broadcast here to avoid duplicate UI (PromptCard + ToolCard). */
    private val SETUP_PROMPT_TITLES = setOf(
        "Trust This Folder?",
        "Choose a Theme for the Terminal",
        "Select Login Method",
    )

    /** Detect permission mode from visible screen only (not raw buffer). */
    private fun detectPermissionMode(screen: String) {
        val lower = screen.lowercase()
        permissionMode = when {
            "bypass permissions on" in lower -> "Bypass"
            "accept edits on" in lower -> "Auto-Accept"
            "plan mode on" in lower -> "Plan Mode"
            else -> "Normal"
        }
    }

    /** Known setup prompts and their button mappings.
     *  @param screenText visible terminal screen only (for menu parsing)
     *  @param combined screen + raw buffer (for keyword-based special cases)
     */
    private fun detectPrompts(screenText: String, combined: String, activePrompts: MutableSet<String>) {
        val lower = combined.lowercase()
        val screenLower = screenText.lowercase()

        // --- Hardcoded: Login method selection ---
        if ("select login method" in screenLower) {
            absentPollCounts.remove("auth")
            if ("auth" !in activePrompts && "auth" !in completedPromptIds) {
                activePrompts.add("auth")
                // Forward prompt to React UI via bridge
                val down = "\u001b[B"
                broadcastPrompt("auth", "Select Login Method", listOf(
                    PromptButton("Claude Account (Pro/Max/Team)", "\r"),
                    PromptButton("Anthropic Console (API)", "$down\r"),
                    PromptButton("3rd-Party Platform", "$down$down\r"),
                ))
            }
            return
        } else if ("auth" in activePrompts) {
            val count = absentPollCounts.getOrDefault("auth", 0) + 1
            absentPollCounts["auth"] = count
            if (count >= DISMISS_THRESHOLD) {
                activePrompts.remove("auth")
                broadcastPromptDismiss("auth")
                absentPollCounts.remove("auth")
            }
        }

        // --- Hardcoded: Bypass permissions warning ---
        // Detect ❯ position to determine correct input. The prompt defaults ❯ to
        // "No, exit" — accepting requires navigating DOWN to "Yes" first.
        // PtyBridge.writeInput splits escape+Enter with a delay to prevent PTY
        // buffering from causing ESC to be read as standalone Escape key.
        if ("bypass permission" in screenLower && "enter to confirm" in screenLower) {
            absentPollCounts.remove("bypass_warning")
            if ("bypass_warning" !in activePrompts && "bypass_warning" !in completedPromptIds) {
                activePrompts.add("bypass_warning")
                // Check if ❯ is already on a "Yes"/"accept" option
                val afterSelector = screenText.substringAfter("❯", "").lowercase().trim()
                val selectorOnAccept = afterSelector.startsWith("yes") ||
                    afterSelector.startsWith("2.") || afterSelector.startsWith("accept")
                val acceptInput = if (selectorOnAccept) "\r" else "\u001b[B\r"
                broadcastPrompt("bypass_warning",
                    "Bypass Permissions Mode — Claude will run tools without asking for approval.",
                    listOf(
                        PromptButton("Accept the Risks", acceptInput),
                        PromptButton("Exit", "\u001b"),
                    ))
            }
            return
        } else if ("bypass_warning" in activePrompts) {
            val count = absentPollCounts.getOrDefault("bypass_warning", 0) + 1
            absentPollCounts["bypass_warning"] = count
            if (count >= DISMISS_THRESHOLD) {
                activePrompts.remove("bypass_warning")
                broadcastPromptDismiss("bypass_warning")
                absentPollCounts.remove("bypass_warning")
            }
        }

        // --- Generic Ink Select menu detection ---
        // Only broadcast menus that are known setup prompts. Permission prompts
        // (Yes/No/Always Allow) are handled exclusively by the hook system via
        // EventBridge → HookSerializer → hook:event → React ToolCard.
        // Broadcasting them here would create duplicate UI (PromptCard + ToolCard).
        val parsed = InkSelectParser.parse(screenText)
        val isKnownSetupPrompt = parsed != null && SETUP_PROMPT_TITLES.any {
            parsed.title.equals(it, ignoreCase = true)
        }
        if (parsed != null && isKnownSetupPrompt) {
            absentPollCounts.remove(parsed.id)
            if (parsed.id !in activePrompts && parsed.id !in completedPromptIds) {
                val staleMenus = activePrompts.filter { it.startsWith("menu_") }
                for (stale in staleMenus) {
                    activePrompts.remove(stale)
                    completedPromptIds.add(stale)
                    broadcastPromptDismiss(stale)
                    absentPollCounts.remove(stale)
                }
                activePrompts.add(parsed.id)
                broadcastPrompt(parsed.id, parsed.title,
                    InkSelectParser.toPromptButtons(parsed))
            }
        } else {
            val staleMenus = activePrompts.filter { it.startsWith("menu_") }
            for (stale in staleMenus) {
                val count = absentPollCounts.getOrDefault(stale, 0) + 1
                absentPollCounts[stale] = count
                if (count >= DISMISS_THRESHOLD) {
                    activePrompts.remove(stale)
                    broadcastPromptDismiss(stale)
                    absentPollCounts.remove(stale)
                }
            }
        }

        // --- Browser auth / paste code prompt ---
        if (("paste code" in lower || "paste the code" in lower || "browser" in lower) &&
            ("sign" in lower || "code" in lower || "authorize" in lower)) {
            if ("paste_code" !in activePrompts && "paste_code" !in completedPromptIds) {
                activePrompts.add("paste_code")
                broadcastPrompt("paste_code", "Complete Sign-In in Your Browser", listOf(
                    PromptButton("Browser opened — waiting for code...", ""),
                ))
            }
        } else if ("paste_code" in activePrompts) {
            val count = absentPollCounts.getOrDefault("paste_code", 0) + 1
            absentPollCounts["paste_code"] = count
            if (count >= DISMISS_THRESHOLD) {
                activePrompts.remove("paste_code")
                broadcastPromptDismiss("paste_code")
                absentPollCounts.remove("paste_code")
            }
        }

        // --- "Press Enter to continue" ---
        if ("press enter to continue" in lower) {
            if ("paste_code" in activePrompts) {
                activePrompts.remove("paste_code")
                completedPromptIds.add("paste_code")
                broadcastPromptComplete("paste_code", "Signed in")
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
                broadcastPrompt(continueKey, title, listOf(PromptButton("Continue", "\r")))
            }
        } else {
            val staleContinues = activePrompts.filter { it.startsWith("continue_") }
            for (stale in staleContinues) {
                val count = absentPollCounts.getOrDefault(stale, 0) + 1
                absentPollCounts[stale] = count
                if (count >= DISMISS_THRESHOLD) {
                    activePrompts.remove(stale)
                    broadcastPromptDismiss(stale)
                    absentPollCounts.remove(stale)
                }
            }
        }
    }

    /** Broadcast a prompt event to the React UI via bridge server. */
    private fun broadcastPrompt(promptId: String, title: String, buttons: List<PromptButton>) {
        bridgeServer?.broadcast(JSONObject().apply {
            put("type", "prompt:show")
            put("payload", JSONObject().apply {
                put("sessionId", id)
                put("promptId", promptId)
                put("title", title)
                put("buttons", org.json.JSONArray().also { arr ->
                    buttons.forEach { btn ->
                        arr.put(JSONObject().apply {
                            put("label", btn.label)
                            put("input", btn.input)
                        })
                    }
                })
            })
        })
    }

    private fun broadcastPromptDismiss(promptId: String) {
        bridgeServer?.broadcast(JSONObject().apply {
            put("type", "prompt:dismiss")
            put("payload", JSONObject().apply {
                put("sessionId", id)
                put("promptId", promptId)
            })
        })
    }

    private fun broadcastPromptComplete(promptId: String, selection: String) {
        bridgeServer?.broadcast(JSONObject().apply {
            put("type", "prompt:complete")
            put("payload", JSONObject().apply {
                put("sessionId", id)
                put("promptId", promptId)
                put("selection", selection)
            })
        })
    }

    /**
     * Route a hook event to this session.
     * Must be called on Main dispatcher.
     */
    private fun routeHookEvent(event: HookEvent) {
        when (event) {
            is HookEvent.PostToolUse -> cleanupOrphanedSocket(event.toolUseId)
            is HookEvent.PostToolUseFailure -> cleanupOrphanedSocket(event.toolUseId)
            else -> {}
        }
    }

    /** Close an orphaned PermissionRequest socket if the tool completes via another path. */
    private fun cleanupOrphanedSocket(toolUseId: String) {
        // With React UI, permission state lives on the bridge/React side.
        // We just ensure the socket is closed so the hook process can exit.
        ptyBridge?.getEventBridge()?.closeSocket(toolUseId)
    }

    /** Mark a prompt as completed so the detector won't re-create it. */
    fun markPromptCompleted(promptId: String) {
        completedPromptIds.add(promptId)
    }

    // ─── Transcript watcher integration ─────────────────────────

    private var transcriptWatcherStarted = false

    private fun startTranscriptWatcherIfNeeded(claudeSessionId: String) {
        if (transcriptWatcherStarted) return
        val transcriptPath = ptyBridge?.getEventBridge()?.getTranscriptPath(id)
        if (transcriptPath.isNullOrBlank()) return
        transcriptWatcherStarted = true
        transcriptWatcher?.startWatching(id, transcriptPath)
    }

    fun startTitleObserver() {
        titleFile.parentFile?.mkdirs()
        if (!titleFile.exists()) titleFile.writeText("")

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
