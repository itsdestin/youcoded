package com.destin.code.runtime

import com.destin.code.bridge.LocalBridgeServer
import com.destin.code.parser.TranscriptWatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import java.io.File

class SessionRegistry {
    var bridgeServer: LocalBridgeServer? = null
    private val _sessions = MutableStateFlow<Map<String, ManagedSession>>(emptyMap())
    val sessions: StateFlow<Map<String, ManagedSession>> = _sessions

    private val _currentSessionId = MutableStateFlow<String?>(null)
    val currentSessionId: StateFlow<String?> = _currentSessionId

    fun getCurrentSession(): ManagedSession? {
        val id = _currentSessionId.value ?: return null
        return _sessions.value[id]
    }

    fun createSession(
        bootstrap: Bootstrap,
        cwd: File,
        dangerousMode: Boolean,
        apiKey: String?,
        titlesDir: File,
        resumeSessionId: String? = null,
    ): ManagedSession {
        val sessionId = java.util.UUID.randomUUID().toString()
        val socketName = "parser-$sessionId"
        val titleFile = File(titlesDir, sessionId)

        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

        val bridge = PtyBridge(
            bootstrap = bootstrap,
            apiKey = apiKey,
            socketName = socketName,
            cwd = cwd,
            dangerousMode = dangerousMode,
            mobileSessionId = sessionId,
            resumeSessionId = resumeSessionId,
        )

        val projectsDir = File(bootstrap.homeDir, ".claude/projects")
        val transcriptWatcher = TranscriptWatcher(projectsDir, scope)

        val session = ManagedSession(
            id = sessionId,
            cwd = cwd,
            homeDir = bootstrap.homeDir,
            dangerousMode = dangerousMode,
            ptyBridge = bridge,
            transcriptWatcher = transcriptWatcher,
            titleFile = titleFile,
            scope = scope,
        )

        // Wire bridge server for React UI forwarding
        session.bridgeServer = bridgeServer

        // Start EventBridge BEFORE Claude Code — hooks fire immediately on launch
        bridge.startEventBridge(scope)
        bridge.start()
        session.startTitleObserver()

        // Wire up the current-session check for blue dot logic
        session.isCurrentSession = { _currentSessionId.value == sessionId }

        // Start background collectors (hook events, status polling, approval observer)
        session.startBackgroundCollectors()

        _sessions.update { it + (sessionId to session) }
        _currentSessionId.value = sessionId

        return session
    }

    fun switchTo(sessionId: String) {
        if (_sessions.value.containsKey(sessionId)) {
            // Notify the old session so it can re-derive status (may turn blue)
            val oldId = _currentSessionId.value
            if (oldId != null && oldId != sessionId) {
                _sessions.value[oldId]?.notifyViewedStateChanged()
            }
            // Switch and mark viewed
            _currentSessionId.value = sessionId
            val session = _sessions.value[sessionId]
            session?.hasBeenViewed = true
            session?.notifyViewedStateChanged()
        }
    }

    fun destroySession(sessionId: String) {
        val session = _sessions.value[sessionId] ?: return
        session.destroy()
        _sessions.update { it - sessionId }
        // If we destroyed the current session, switch to another or null
        if (_currentSessionId.value == sessionId) {
            _currentSessionId.value = _sessions.value.keys.firstOrNull()
        }
    }

    fun destroyAll() {
        _sessions.value.values.forEach { it.destroy() }
        _sessions.value = emptyMap()
        _currentSessionId.value = null
    }

    fun relaunchSession(
        sessionId: String,
        bootstrap: Bootstrap,
        apiKey: String?,
        titlesDir: File,
    ): ManagedSession? {
        val old = _sessions.value[sessionId] ?: return null
        destroySession(sessionId)
        return if (old.shellMode) {
            createShellSession(bootstrap, titlesDir)
        } else {
            createSession(bootstrap, old.cwd, old.dangerousMode, apiKey, titlesDir)
        }
    }

    /** Create a managed shell session (appears in session switcher). */
    fun createShellSession(bootstrap: Bootstrap, titlesDir: File): ManagedSession {
        val sessionId = java.util.UUID.randomUUID().toString()
        val titleFile = File(titlesDir, sessionId)
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

        val shell = DirectShellBridge(bootstrap).also { it.start() }

        val session = ManagedSession(
            id = sessionId,
            cwd = bootstrap.homeDir,
            homeDir = bootstrap.homeDir,
            dangerousMode = false,
            directShellBridge = shell,
            shellMode = true,
            titleFile = titleFile,
            scope = scope,
        )

        session.startBackgroundCollectors()

        _sessions.update { it + (sessionId to session) }
        _currentSessionId.value = sessionId

        return session
    }

    /**
     * Resume a past session. Creates a new Claude Code PTY with --resume flag
     * in the session's original project directory, then loads history.
     * Mirrors the desktop's handleResumeSession() in App.tsx.
     */
    fun resumeSession(
        pastSession: SessionBrowser.PastSession,
        bootstrap: Bootstrap,
        apiKey: String?,
        titlesDir: File,
    ): ManagedSession {
        // Derive CWD from the project slug — fall back to homeDir if path doesn't exist
        val cwd = SessionBrowser.slugToCwd(pastSession.projectSlug, bootstrap.homeDir)

        // Create session with --resume CLI flag (NOT /resume stdin)
        val session = createSession(
            bootstrap = bootstrap,
            cwd = cwd,
            dangerousMode = false,
            apiKey = apiKey,
            titlesDir = titlesDir,
            resumeSessionId = pastSession.sessionId,
        )

        // Load history on IO thread to avoid ANR on large files
        val projectsDir = File(bootstrap.homeDir, ".claude/projects")
        CoroutineScope(Dispatchers.IO + SupervisorJob()).launch {
            val result = SessionBrowser.loadHistory(
                projectsDir, pastSession.projectSlug, pastSession.sessionId,
            )
            if (result.messages.isNotEmpty()) {
                val entries = result.messages.map { msg ->
                    com.destin.code.ui.state.HistoryEntry(msg.role, msg.content, msg.timestamp)
                }
                kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
                    session.chatReducer.dispatch(
                        com.destin.code.ui.state.ChatAction.HistoryLoaded(
                            messages = entries,
                            hasMore = result.hasMore,
                            claudeSessionId = pastSession.sessionId,
                            projectSlug = pastSession.projectSlug,
                        )
                    )
                }
            }
        }

        return session
    }

    val sessionCount: Int get() = _sessions.value.size
}
