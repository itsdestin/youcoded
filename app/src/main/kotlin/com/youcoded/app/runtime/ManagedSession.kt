package com.youcoded.app.runtime

import android.os.FileObserver
import com.youcoded.app.bridge.LocalBridgeServer
import com.youcoded.app.bridge.TranscriptSerializer
import com.youcoded.app.bridge.HookSerializer
import com.youcoded.app.parser.HookEvent
import com.youcoded.app.parser.InkSelectParser
import com.youcoded.app.parser.PromptButton
import com.youcoded.app.parser.TranscriptEvent
import com.youcoded.app.parser.TranscriptWatcher
import org.json.JSONObject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.Job
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

// --- Permission override classification ---
// In bypass mode, Claude Code still fires PermissionRequest for protected paths,
// compound cd commands, and AskUserQuestion. These regexes classify each request
// so the user's per-category overrides can selectively auto-approve them.
private val TITLE_HOOK_RE = Regex("""[>|].*[/\\]\.claude[/\\]topics[/\\]topic-""")
private val CONFIG_FILE_RE = Regex("""\.(bashrc|bash_profile|zshrc|zprofile|profile|gitconfig|gitmodules|ripgreprc)\b|\.mcp\.json|\.claude\.json""")
private val PROTECTED_DIR_RE = Regex("""[/\\]\.git[/\\]|[/\\]\.claude[/\\]""")
private val CD_REDIRECT_RE = Regex("""\bcd\b.*[>]""")
private val CD_GIT_RE = Regex("""\bcd\b.*\bgit\b""")

private fun classifyPermission(toolName: String, toolInput: JSONObject): String {
    val cmd = toolInput.optString("command", "")
    val filePath = toolInput.optString("file_path", "")
    val target = cmd.ifEmpty { filePath }

    if (toolName == "Bash" && TITLE_HOOK_RE.containsMatchIn(cmd)) return "titleHook"
    if (toolName == "Bash") {
        if (CD_GIT_RE.containsMatchIn(cmd)) return "compoundCdGit"
        if (CD_REDIRECT_RE.containsMatchIn(cmd)) return "compoundCdRedirect"
    }
    if (CONFIG_FILE_RE.containsMatchIn(target)) return "protectedConfigFiles"
    if (PROTECTED_DIR_RE.containsMatchIn(target)) return "protectedDirectories"
    return "unknown"
}

private fun shouldAutoApprove(category: String, overrides: JSONObject): Boolean {
    if (overrides.optBoolean("approveAll", false)) return true
    return overrides.optBoolean(category, false)
}

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
    /** Cached permission overrides from user's defaults — updated by SessionService on defaults:set. */
    var permissionOverridesCache: JSONObject = JSONObject(),
    /** Callback when session enters AwaitingApproval (for notification posting). */
    var onApprovalNeeded: ((sessionId: String, sessionName: String) -> Unit)? = null,
    /** Callback when session leaves AwaitingApproval (for notification clearing). */
    var onApprovalCleared: ((sessionId: String) -> Unit)? = null,
) {
    /** Bridge server for forwarding events to React UI. Set by SessionRegistry. */
    var bridgeServer: LocalBridgeServer? = null

    /** Current Claude Code permission mode, detected from terminal status bar.
     *  Values match React's PermissionMode type: "normal" | "auto-accept" | "plan" | "bypass". */
    var permissionMode: String = "normal"

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
    private var topicPollJob: Job? = null
    private var renameBroadcastJob: Job? = null

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
        // 0. Broadcast session:renamed to React UI when _name changes.
        //    drop(1) skips the initial value (React already has it from session:created).
        renameBroadcastJob = scope.launch {
            _name.drop(1).collect { newName ->
                bridgeServer?.broadcast(JSONObject().apply {
                    put("type", "session:renamed")
                    put("payload", JSONObject().apply {
                        put("sessionId", id)
                        put("name", newName)
                    })
                })
            }
        }

        if (shellMode) {
            // Shell sessions — poll isRunning (DirectShellBridge has no sessionFinished flow)
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
                            // Classify and auto-approve based on user's override settings.
                            // Title hooks always auto-approved; other categories per user config.
                            // AskUserQuestion is never auto-approved (needs real user input).
                            if (event.toolName != "AskUserQuestion") {
                                val category = classifyPermission(event.toolName, event.toolInput)
                                val overrides = permissionOverridesCache
                                val shouldApprove = category == "titleHook" || shouldAutoApprove(category, overrides)
                                if (shouldApprove) {
                                    val decision = JSONObject().put("decision",
                                        JSONObject().put("behavior", "allow"))
                                    ptyBridge?.getEventBridge()?.respond(event.requestId, decision)
                                    return@let
                                }
                            }
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
                        is HookEvent.PermissionExpired -> {
                            // Socket closed before user responded — relay timed out
                            // or Claude Code killed the hook. Clear the stale approval
                            // card in React UI. Desktop equivalent: main.ts
                            // hookRelay.on('permission-expired') handler.
                            server.broadcast(HookSerializer.permissionExpired(
                                sessionId = id,
                                requestId = event.requestId,
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
                        is TranscriptEvent.AssistantText -> TranscriptSerializer.assistantText(event.sessionId, event.uuid, event.timestamp, event.text, event.model, event.parentAgentToolUseId, event.agentId)
                        is TranscriptEvent.ToolUse -> TranscriptSerializer.toolUse(event.sessionId, event.uuid, event.timestamp, event.toolUseId, event.toolName, event.toolInput, event.parentAgentToolUseId, event.agentId)
                        is TranscriptEvent.ToolResult -> TranscriptSerializer.toolResult(event.sessionId, event.uuid, event.timestamp, event.toolUseId, event.result, event.isError, event.parentAgentToolUseId, event.agentId)
                        is TranscriptEvent.TurnComplete -> TranscriptSerializer.turnComplete(event.sessionId, event.uuid, event.timestamp)
                        is TranscriptEvent.StreamingText -> TranscriptSerializer.streamingText(event.sessionId, event.text)
                        is TranscriptEvent.CompactSummary -> TranscriptSerializer.compactSummary(event.sessionId, event.uuid, event.timestamp)
                    }
                    server.broadcast(JSONObject().apply {
                        put("type", "transcript:event")
                        put("payload", serialized)
                    })
                }
            }
        }

        // 2. sessionFinished — reactively marks Dead status (no polling).
        scope.launch {
            bridge.sessionFinished.first { it }
            _isRunningFlow.value = false
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
        "Resume Session", // Stale session resume — lets user choose summary vs full resume
    )

    /** Detect permission mode from visible screen only (not raw buffer).
     *  Broadcasts a `session:permission-mode` event when the mode changes so React
     *  can correct its optimistic Shift+Tab cycling state — Android does not
     *  forward raw pty:output to the renderer, so the desktop's PTY-text-based
     *  detection in App.tsx never fires here. */
    private fun detectPermissionMode(screen: String) {
        val lower = screen.lowercase()
        val newMode = when {
            "bypass permissions on" in lower -> "bypass"
            "accept edits on" in lower -> "auto-accept"
            "plan mode on" in lower -> "plan"
            else -> "normal"
        }
        if (newMode != permissionMode) {
            permissionMode = newMode
            bridgeServer?.broadcast(JSONObject().apply {
                put("type", "session:permission-mode")
                put("payload", JSONObject().apply {
                    put("sessionId", id)
                    put("mode", newMode)
                })
            })
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
                // Anchor-then-navigate: overshoot UP to snap Ink's cursor to
                // the top of the menu, THEN press DOWN to the target index.
                // Cursor-independent — survives user arrowing in the terminal
                // before clicking a button. Matches desktop InkSelectParser.
                val up = "\u001b[A"
                val down = "\u001b[B"
                val options = listOf(
                    "Claude Account (Pro/Max/Team)",
                    "Anthropic Console (API)",
                    "3rd-Party Platform",
                )
                val anchorUps = up.repeat(options.size + 2)
                broadcastPrompt("auth", "Select Login Method", options.mapIndexed { idx, label ->
                    PromptButton(label, anchorUps + down.repeat(idx) + "\r")
                })
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
        // Two-option menu: "No, exit" (index 0, default selected) and
        // "Yes, accept" (index 1). Use anchor-then-navigate so "Accept" works
        // regardless of current ❯ position (previously we read ❯ and chose
        // between "\r" and "DOWN\r", which was brittle if the user had arrowed
        // in the terminal view). Exit still sends just ESC.
        if ("bypass permission" in screenLower && "enter to confirm" in screenLower) {
            absentPollCounts.remove("bypass_warning")
            if ("bypass_warning" !in activePrompts && "bypass_warning" !in completedPromptIds) {
                activePrompts.add("bypass_warning")
                val up = "\u001b[A"
                val down = "\u001b[B"
                // 2 options → 4 UP presses (options.size + 2) anchors at top.
                val anchorUps = up.repeat(4)
                broadcastPrompt("bypass_warning",
                    "Bypass Permissions Mode — Claude will run tools without asking for approval.",
                    listOf(
                        PromptButton("Accept the Risks", anchorUps + down.repeat(1) + "\r"),
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
                    InkSelectParser.toPromptButtons(parsed), parsed.description)
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
    private fun broadcastPrompt(promptId: String, title: String, buttons: List<PromptButton>, description: String? = null) {
        bridgeServer?.broadcast(JSONObject().apply {
            put("type", "prompt:show")
            put("payload", JSONObject().apply {
                put("sessionId", id)
                put("promptId", promptId)
                put("title", title)
                // Include description when present (e.g., resume session trade-off text)
                if (description != null) put("description", description)
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
        // Previously attempted to close orphaned permission sockets here on
        // PostToolUse/PostToolUseFailure, but the code passed toolUseId to
        // closeSocket() which expects a requestId — the two IDs are unrelated,
        // so cleanup never matched anything. Socket closure is now handled by
        // EventBridge.monitorSocketClosure() which detects when the relay
        // process exits and emits PermissionExpired to clear the React UI.
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

        // Polling fallback — FileObserver can miss events on Android FUSE filesystems.
        // Same pattern as TranscriptWatcher (TranscriptWatcher.kt:113-117).
        topicPollJob = scope.launch(Dispatchers.IO) {
            while (isActive) {
                delay(2000)
                try {
                    if (!topicFile.exists()) continue
                    val newName = topicFile.readText().trim()
                    if (newName.isNotBlank() && newName != "New Session" && newName != _name.value) {
                        _name.value = newName
                        try { titleFile.writeText(newName) } catch (_: Exception) {}
                    }
                } catch (_: Exception) {}
            }
        }
    }

    fun destroy() {
        renameBroadcastJob?.cancel()
        renameBroadcastJob = null
        topicPollJob?.cancel()
        topicPollJob = null
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
