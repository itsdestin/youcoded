package com.youcoded.app.runtime

import com.youcoded.app.bridge.LocalBridgeServer
import com.youcoded.app.parser.TranscriptWatcher
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
        model: String? = null,
    ): ManagedSession {
        val sessionId = java.util.UUID.randomUUID().toString()
        val socketName = "parser-$sessionId"
        val titleFile = File(titlesDir, sessionId)

        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

        val bridge = PtyBridge(
            context = bootstrap.context,
            bootstrap = bootstrap,
            apiKey = apiKey,
            socketName = socketName,
            cwd = cwd,
            dangerousMode = dangerousMode,
            mobileSessionId = sessionId,
            resumeSessionId = resumeSessionId,
            model = model,
        )

        val transcriptWatcher = TranscriptWatcher(scope)

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
        // T20: start this session's docx/xlsx pending-mutation queue AFTER
        // start() — that's when docCommentsServerId/token are known (a
        // failed doc-comments MCP deploy makes this a no-op).
        bridge.startDocCommentsQueue(scope)
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

    val sessionCount: Int get() = _sessions.value.size
}
