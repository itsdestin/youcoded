package com.destin.code.runtime

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import java.io.File

class SessionRegistry {
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
        )

        val session = ManagedSession(
            id = sessionId,
            cwd = cwd,
            dangerousMode = dangerousMode,
            ptyBridge = bridge,
            titleFile = titleFile,
            scope = scope,
        )

        // Start EventBridge BEFORE Claude Code — hooks fire immediately on launch
        bridge.startEventBridge(scope)
        bridge.start()
        session.startTitleObserver()

        // Start background collectors (hook events, status polling, approval observer)
        session.startBackgroundCollectors()

        _sessions.update { it + (sessionId to session) }
        _currentSessionId.value = sessionId

        return session
    }

    fun switchTo(sessionId: String) {
        if (_sessions.value.containsKey(sessionId)) {
            _currentSessionId.value = sessionId
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
        return createSession(bootstrap, old.cwd, old.dangerousMode, apiKey, titlesDir)
    }

    /** Create a standalone bash shell (global, not per-session). */
    fun createDirectShell(bootstrap: Bootstrap): DirectShellBridge {
        return DirectShellBridge(bootstrap).also { it.start() }
    }

    val sessionCount: Int get() = _sessions.value.size
}
