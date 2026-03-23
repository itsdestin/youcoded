package com.destin.code.runtime

import android.os.FileObserver
import com.destin.code.parser.HookEvent
import com.destin.code.parser.InkSelectParser
import com.destin.code.ui.ChatState
import com.destin.code.ui.MessageContent
import com.destin.code.ui.PromptButton
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

enum class SessionStatus { Active, AwaitingApproval, Idle, Dead }

class ManagedSession(
    val id: String = UUID.randomUUID().toString(),
    val cwd: File,
    val dangerousMode: Boolean,
    val ptyBridge: PtyBridge,
    val chatState: ChatState = ChatState(),
    val createdAt: Long = System.currentTimeMillis(),
    private val titleFile: File,
    private val scope: CoroutineScope,
    /** Callback when session enters AwaitingApproval (for notification posting). */
    var onApprovalNeeded: ((sessionId: String, sessionName: String) -> Unit)? = null,
    /** Callback when session leaves AwaitingApproval (for notification clearing). */
    var onApprovalCleared: ((sessionId: String) -> Unit)? = null,
) {
    private val _name = MutableStateFlow(cwd.name)
    val name: StateFlow<String> = _name

    private var titleObserver: FileObserver? = null

    // Status uses combine + a periodic isRunning check (isRunning is not reactive).
    // A 5-second polling coroutine feeds _isRunningFlow to make Dead detection reactive.
    private val _isRunningFlow = MutableStateFlow(true)

    val status: StateFlow<SessionStatus> = combine(
        ptyBridge.lastPtyOutputTime,
        _isRunningFlow,
    ) { lastOutput, isRunning ->
        when {
            !isRunning -> SessionStatus.Dead
            isAwaitingApproval() -> SessionStatus.AwaitingApproval
            System.currentTimeMillis() - lastOutput < 2000 -> SessionStatus.Active
            else -> SessionStatus.Idle
        }
    }.stateIn(scope, SharingStarted.WhileSubscribed(5000), SessionStatus.Idle)

    private fun isAwaitingApproval(): Boolean {
        val lastMsg = chatState.messages.lastOrNull() ?: return false
        return lastMsg.content is MessageContent.ToolAwaitingApproval
    }

    /**
     * Start background collectors that run for the session's entire lifetime.
     * This includes: hook event collection, isRunning polling, approval notifications.
     */
    fun startBackgroundCollectors() {
        // 1. Per-session hook event collector — runs regardless of which session is "current".
        //    All ChatState mutations dispatched to Main to avoid snapshot state race conditions.
        scope.launch {
            // Wait for EventBridge to become available
            var eventBridge = ptyBridge.getEventBridge()
            while (eventBridge == null) {
                delay(200)
                eventBridge = ptyBridge.getEventBridge()
            }
            eventBridge.events.collect { event ->
                withContext(Dispatchers.Main) {
                    routeHookEvent(event)
                }
            }
        }

        // 2. isRunning poller — makes Dead status reactive.
        //    Also force-clears the message queue when the session dies (Fix 5).
        scope.launch {
            while (true) {
                delay(5000)
                _isRunningFlow.value = ptyBridge.isRunning
                if (!ptyBridge.isRunning) {
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
                if (!ptyBridge.isRunning) break
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
        //    Reacts to screenVersion changes (new PTY output) + also polls the raw buffer
        //    since screen text depends on emulator viewport size which may be tiny initially.
        scope.launch {
            try {
                val activePrompts = mutableSetOf<String>()
                while (true) {
                    delay(1000)
                    if (!ptyBridge.isRunning) break
                    val screen = try { ptyBridge.readScreenText() } catch (_: Exception) { "" }
                    val raw = try { ptyBridge.rawBuffer.takeLast(4000) } catch (_: Exception) { "" }
                    val combined = screen + "\n" + raw
                    withContext(Dispatchers.Main) {
                        // Use screen-only for menu parsing (raw buffer has stale menus)
                        // Use combined for special-case keyword detection (paste_code, press-enter)
                        detectPrompts(screen, combined, activePrompts)
                        detectPermissionMode(screen)
                    }
                }
            } catch (_: Exception) {}
        }

        // 5. PTY output consumer — surfaces important terminal messages (errors, warnings)
        //    in the chat view. Without this, raw PTY output is invisible in chat mode.
        scope.launch {
            val debounceMs = 500L
            var pendingNotice: String? = null
            var lastEmitTime = 0L
            ptyBridge.outputFlow.collect { delta ->
                // Only surface lines containing error/warning keywords
                val lines = delta.lines().filter { line ->
                    val lower = line.lowercase().trim()
                    lower.isNotEmpty() &&
                    (lower.startsWith("error") || lower.startsWith("warning") ||
                     lower.contains("fatal:") || lower.contains("panic:") ||
                     lower.contains("exception:") || lower.contains("segfault"))
                }
                if (lines.isNotEmpty()) {
                    val notice = lines.joinToString("\n").take(300)
                    val now = System.currentTimeMillis()
                    // Debounce: don't spam the chat with rapid-fire errors
                    if (now - lastEmitTime > debounceMs) {
                        lastEmitTime = now
                        withContext(Dispatchers.Main) {
                            chatState.addSystemNotice(notice)
                        }
                    } else {
                        pendingNotice = notice
                    }
                }
            }
        }
    }

    // Track prompts that have been completed so we don't re-create them
    private val completedPromptIds = mutableSetOf<String>()

    /** Detect permission mode from visible screen only (not raw buffer). */
    private fun detectPermissionMode(screen: String) {
        val lower = screen.lowercase()
        chatState.permissionMode = when {
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

        // --- Hardcoded: Login method selection (multi-line options break generic parser) ---
        if ("select login method" in screenLower) {
            if ("auth" !in activePrompts && "auth" !in completedPromptIds) {
                activePrompts.add("auth")
                val down = "\u001b[B"
                chatState.showInteractivePrompt("auth", "Select Login Method", listOf(
                    PromptButton("Claude Account (Pro/Max/Team)", "\r"),
                    PromptButton("Anthropic Console (API)", "$down\r"),
                    PromptButton("3rd-Party Platform", "$down$down\r"),
                ))
            }
            return  // skip generic parser for this screen
        } else if ("auth" in activePrompts) {
            activePrompts.remove("auth")
            chatState.dismissPrompt("auth")
        }

        // --- Skip generic parser when a tool approval card is already handling the prompt ---
        val hasActiveApproval = chatState.messages.any {
            it.content is MessageContent.ToolAwaitingApproval
        }
        if (hasActiveApproval) return

        // --- Generic Ink Select menu detection (screen only, not raw buffer) ---
        val parsed = InkSelectParser.parse(screenText)
        if (parsed != null) {
            if (parsed.id !in activePrompts && parsed.id !in completedPromptIds) {
                // Clear any previous generic menu that is no longer showing
                val staleMenus = activePrompts.filter { it.startsWith("menu_") }
                for (stale in staleMenus) {
                    activePrompts.remove(stale)
                    chatState.dismissPrompt(stale)
                }
                activePrompts.add(parsed.id)
                chatState.showInteractivePrompt(
                    parsed.id,
                    parsed.title,
                    InkSelectParser.toPromptButtons(parsed),
                )
            }
        } else {
            // No menu detected — dismiss any active generic menus
            val staleMenus = activePrompts.filter { it.startsWith("menu_") }
            for (stale in staleMenus) {
                activePrompts.remove(stale)
                chatState.dismissPrompt(stale)
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
            }
        } else if ("paste_code" in activePrompts) {
            activePrompts.remove("paste_code")
            chatState.dismissPrompt("paste_code")
        }

        // --- Special-case: "Press Enter to continue" ---
        // (Single-action prompt, not an Ink Select menu)
        if ("press enter to continue" in lower) {
            // Auto-collapse the browser sign-in card if still active
            if ("paste_code" in activePrompts) {
                activePrompts.remove("paste_code")
                completedPromptIds.add("paste_code")
                chatState.completePrompt("paste_code", "Signed in")
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
            }
        } else {
            // Dismiss any active continue prompts when "press enter" leaves the screen
            val staleContinues = activePrompts.filter { it.startsWith("continue_") }
            for (stale in staleContinues) {
                activePrompts.remove(stale)
                chatState.dismissPrompt(stale)
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
                    val lastRunning = chatState.messages.lastOrNull {
                        it.content is MessageContent.ToolRunning
                    }
                    val toolUseId = (lastRunning?.content as? MessageContent.ToolRunning)?.toolUseId
                    if (toolUseId != null) {
                        val hasAlways = ptyBridge.hasAlwaysAllowOption()
                        chatState.updateToolToApproval(toolUseId, hasAlways)
                    }
                } else {
                    chatState.addSystemNotice(event.message)
                }
            }
            is HookEvent.PermissionRequest -> {
                val lastRunning = chatState.messages.lastOrNull {
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
            ptyBridge.getEventBridge()?.closeSocket(approval.requestId)
        }
    }

    /** Mark a prompt as completed so the detector won't re-create it. */
    fun markPromptCompleted(promptId: String) {
        completedPromptIds.add(promptId)
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
    }

    fun destroy() {
        titleObserver?.stopWatching()
        titleObserver = null
        ptyBridge.stop()
        try { titleFile.delete() } catch (_: Exception) {}
    }
}
