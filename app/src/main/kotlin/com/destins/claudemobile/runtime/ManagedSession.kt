package com.destins.claudemobile.runtime

import android.os.FileObserver
import com.destins.claudemobile.parser.HookEvent
import com.destins.claudemobile.ui.ChatState
import com.destins.claudemobile.ui.MessageContent
import com.destins.claudemobile.ui.PromptButton
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
        scope.launch {
            while (true) {
                delay(5000)
                _isRunningFlow.value = ptyBridge.isRunning
                if (!ptyBridge.isRunning) break // Stop polling once dead
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
                        detectPrompts(combined, activePrompts)
                    }
                }
            } catch (_: Exception) {}
        }
    }

    // Track prompts that have been completed so we don't re-create them
    private val completedPromptIds = mutableSetOf<String>()

    /** Known setup prompts and their button mappings. */
    private fun detectPrompts(screen: String, activePrompts: MutableSet<String>) {
        val lower = screen.lowercase()

        // Theme selection
        if ("dark mode" in lower && "light mode" in lower && "/theme" in lower) {
            if ("theme" !in activePrompts && "theme" !in completedPromptIds) {
                activePrompts.add("theme")
                // Ink Select: first item is pre-selected. Navigate with ↓ arrows then Enter.
                val down = "\u001b[B"
                chatState.showInteractivePrompt("theme", "Choose a Theme for the Terminal", listOf(
                    PromptButton("Dark mode", "\r"),
                    PromptButton("Light mode", "$down\r"),
                    PromptButton("Dark (colorblind-friendly)", "$down$down\r"),
                    PromptButton("Light (colorblind-friendly)", "$down$down$down\r"),
                    PromptButton("Dark (ANSI only)", "$down$down$down$down\r"),
                    PromptButton("Light (ANSI only)", "$down$down$down$down$down\r"),
                ))
            }
        } else if ("theme" in activePrompts) {
            activePrompts.remove("theme")
            chatState.dismissPrompt("theme")
        }

        // Trust folder
        if ("do you trust" in lower && "folder" in lower) {
            if ("trust" !in activePrompts && "trust" !in completedPromptIds) {
                activePrompts.add("trust")
                chatState.showInteractivePrompt("trust", "Trust this folder?", listOf(
                    PromptButton("Yes", "\r"),
                    PromptButton("No", "\u001b[B\r"),
                ))
            }
        } else if ("trust" in activePrompts) {
            activePrompts.remove("trust")
            chatState.dismissPrompt("trust")
        }

        // Dangerous permissions / skip permissions warning
        if ("dangerously-skip-permissions" in lower || "skip all permission" in lower) {
            if ("dangerous" !in activePrompts && "dangerous" !in completedPromptIds) {
                activePrompts.add("dangerous")
                chatState.showInteractivePrompt("dangerous", "Skip permissions warning", listOf(
                    PromptButton("Yes, I understand", "\r"),
                    PromptButton("No", "\u001b"),
                ))
            }
        } else if ("dangerous" in activePrompts) {
            activePrompts.remove("dangerous")
            chatState.dismissPrompt("dangerous")
        }

        // Login method selection
        if ("select login method" in lower) {
            if ("auth" !in activePrompts && "auth" !in completedPromptIds) {
                activePrompts.add("auth")
                val down = "\u001b[B"
                chatState.showInteractivePrompt("auth", "Select Login Method", listOf(
                    PromptButton("Claude account (Pro/Max/Team)", "\r"),
                    PromptButton("Anthropic Console (API)", "$down\r"),
                    PromptButton("3rd-party platform", "$down$down\r"),
                ))
            }
        } else if ("auth" in activePrompts) {
            activePrompts.remove("auth")
            chatState.dismissPrompt("auth")
        }

        // Browser auth / paste code prompt
        if (("paste code" in lower || "paste the code" in lower || "browser" in lower) &&
            ("sign" in lower || "code" in lower || "authorize" in lower)) {
            if ("paste_code" !in activePrompts && "paste_code" !in completedPromptIds) {
                activePrompts.add("paste_code")
                chatState.showInteractivePrompt("paste_code", "Complete sign-in in your browser", listOf(
                    PromptButton("Browser opened — waiting for code...", ""),
                ))
            }
        } else if ("paste_code" in activePrompts) {
            activePrompts.remove("paste_code")
            chatState.dismissPrompt("paste_code")
        }

        // "Press Enter to continue" / login successful
        if ("press enter to continue" in lower || "login successful" in lower) {
            // Auto-collapse the browser sign-in card if still active
            if ("paste_code" in activePrompts) {
                activePrompts.remove("paste_code")
                completedPromptIds.add("paste_code")
                chatState.completePrompt("paste_code", "Signed in")
            }
            if ("continue" !in activePrompts && "continue" !in completedPromptIds) {
                activePrompts.add("continue")
                chatState.showInteractivePrompt("continue", "Login successful!", listOf(
                    PromptButton("Continue", "\r"),
                ))
            }
        } else if ("continue" in activePrompts) {
            activePrompts.remove("continue")
            chatState.dismissPrompt("continue")
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
