package com.destin.code.parser

import android.net.LocalServerSocket
import android.net.LocalSocket
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Listens on an Android abstract-namespace Unix socket for hook-relay connections.
 * Each connection delivers one JSON line (a Claude Code hook event).
 *
 * For PermissionRequest events, the socket is held open so we can send a
 * structured decision back through it (blocking relay protocol).
 */
class EventBridge(private val socketName: String) {
    private val _events = MutableSharedFlow<HookEvent>(extraBufferCapacity = 1000)
    val events: SharedFlow<HookEvent> = _events

    /** Sockets held open for blocking PermissionRequest responses. */
    private val pendingSockets = ConcurrentHashMap<String, LocalSocket>()

    /** Maps mobile session IDs to Claude Code session IDs. */
    private val sessionIdMap = ConcurrentHashMap<String, String>()

    /** Maps mobile session IDs to transcript file paths (extracted from hook events). */
    private val transcriptPathMap = ConcurrentHashMap<String, String>()

    /** Stored scope for launching socket-closure monitor coroutines. */
    private var monitorScope: CoroutineScope? = null

    fun getClaudeSessionId(mobileSessionId: String): String? = sessionIdMap[mobileSessionId]

    /** Get the transcript JSONL path for a session, as reported by Claude Code. */
    fun getTranscriptPath(mobileSessionId: String): String? = transcriptPathMap[mobileSessionId]

    @Volatile private var serverSocket: LocalServerSocket? = null
    private var listenJob: Job? = null

    fun startServer(scope: CoroutineScope) {
        monitorScope = scope
        listenJob = scope.launch(Dispatchers.IO) {
            // Retry binding — socket may linger briefly after a previous session
            var retries = 3
            while (retries > 0) {
                try {
                    serverSocket = LocalServerSocket(socketName)
                    if (com.destin.code.BuildConfig.DEBUG) android.util.Log.d("EventBridge", "Listening on abstract socket: $socketName")
                    break
                } catch (e: java.io.IOException) {
                    retries--
                    if (retries > 0) {
                        android.util.Log.w("EventBridge", "Socket bind failed, retrying in 500ms ($retries left)")
                        delay(500)
                    } else {
                        android.util.Log.e("EventBridge", "Socket bind failed after retries", e)
                        return@launch
                    }
                }
            }

            try {
                while (isActive) {
                    val client: LocalSocket = serverSocket!!.accept()
                    launch {
                        handleClient(client)
                    }
                }
            } catch (e: Exception) {
                if (isActive) {
                    android.util.Log.e("EventBridge", "Server error", e)
                }
            }
        }
    }

    // Non-suspend (master fix) — uses tryEmit to avoid blocking the coroutine.
    private fun handleClient(client: LocalSocket) {
        try {
            val reader = BufferedReader(InputStreamReader(client.inputStream))
            val line = reader.readLine() ?: run { client.close(); return }
            if (com.destin.code.BuildConfig.DEBUG) android.util.Log.d("EventBridge", "Received: ${line.take(300)}")

            // Peek at event type to decide whether to hold the socket
            val json = try { JSONObject(line) } catch (_: Exception) { client.close(); return }
            val eventName = json.optString("hook_event_name", "")

            // Extract session ID mapping if present
            val mobileSessionId = json.optString("mobileSessionId", "")
            val claudeSessionId = json.optString("session_id", "")
            if (mobileSessionId.isNotBlank() && claudeSessionId.isNotBlank()) {
                sessionIdMap[mobileSessionId] = claudeSessionId
            }

            // Extract transcript path if present (Claude Code includes this on every hook event)
            val transcriptPath = json.optString("transcript_path", "")
            if (mobileSessionId.isNotBlank() && transcriptPath.isNotBlank()) {
                transcriptPathMap[mobileSessionId] = transcriptPath
            }

            if (eventName == "PermissionRequest") {
                // Hold socket open for blocking response
                val requestId = UUID.randomUUID().toString()
                pendingSockets[requestId] = client
                // Inject requestId into the JSON so downstream can reference it
                json.put("_requestId", requestId)
                val sessionId = json.optString("session_id", "")
                val event = HookEvent.fromJson(json.toString())
                if (event != null) {
                    if (!_events.tryEmit(event)) {
                        android.util.Log.e("EventBridge", "Event buffer full, dropped: ${event::class.simpleName}")
                    }
                    // Monitor for remote closure — emits PermissionExpired when
                    // hook-relay-blocking.js times out or Claude Code kills the hook.
                    // Desktop equivalent: hook-relay.ts socket.on('close') handler.
                    monitorSocketClosure(requestId, sessionId, client)
                } else {
                    pendingSockets.remove(requestId)
                    client.close()
                }
            } else {
                // Fire-and-forget — parse, emit, close
                val event = HookEvent.fromJson(line)
                if (event != null) {
                    if (!_events.tryEmit(event)) {
                        android.util.Log.e("EventBridge", "Event buffer full, dropped: ${event::class.simpleName}")
                    }
                } else {
                    android.util.Log.w("EventBridge", "Failed to parse hook event")
                }
                client.close()
            }
        } catch (e: Exception) {
            android.util.Log.w("EventBridge", "Client error", e)
            try { client.close() } catch (_: Exception) {}
        }
    }

    /**
     * Monitor a held PermissionRequest socket for remote closure.
     * When hook-relay-blocking.js times out (120s) or Claude Code kills the hook
     * process, the socket closes. We detect this and emit PermissionExpired so
     * the React UI can clear the stale approval card.
     *
     * Race safety: if respond() successfully delivers a decision, it removes the
     * requestId from pendingSockets before closing the socket. The monitor detects
     * the closure but finds the requestId already gone — no false PermissionExpired.
     */
    private fun monitorSocketClosure(requestId: String, sessionId: String, client: LocalSocket) {
        monitorScope?.launch(Dispatchers.IO) {
            try {
                // After the initial JSON line, the relay waits for our response.
                // read() blocks until the relay process exits (returns -1) or errors.
                @Suppress("ControlFlowWithEmptyBody")
                while (client.inputStream.read() >= 0) { /* drain unexpected data */ }
            } catch (_: Exception) {
                // Socket error — relay process exited or was killed
            }
            // If socket is still in pendingSockets, the permission was never
            // responded to — emit PermissionExpired to clean up the React UI.
            if (pendingSockets.remove(requestId) != null) {
                try { client.close() } catch (_: Exception) {}
                if (!_events.tryEmit(HookEvent.PermissionExpired(
                        sessionId = sessionId,
                        hookEventName = "PermissionExpired",
                        requestId = requestId,
                    ))) {
                    android.util.Log.e("EventBridge", "Event buffer full, dropped PermissionExpired")
                }
            }
        }
    }

    /** Send a decision back through a held PermissionRequest socket. */
    fun respond(requestId: String, decision: JSONObject) {
        val socket = pendingSockets.remove(requestId)
        if (socket == null) {
            android.util.Log.e("EventBridge", "No pending socket for requestId=$requestId")
            return
        }
        try {
            val payload = decision.toString() + "\n"
            socket.outputStream.write(payload.toByteArray())
            socket.outputStream.flush()
            socket.close()
        } catch (e: Exception) {
            // Response couldn't be delivered — permission effectively expired.
            // Emit PermissionExpired so React UI clears the stale approval card.
            android.util.Log.e("EventBridge", "respond() write failed — emitting PermissionExpired", e)
            try { socket.close() } catch (_: Exception) {}
            _events.tryEmit(HookEvent.PermissionExpired(
                sessionId = "",  // ManagedSession uses its own ID for broadcast
                hookEventName = "PermissionExpired",
                requestId = requestId,
            ))
        }
    }

    /** Close a held socket without sending a response (cross-path cleanup). */
    fun closeSocket(requestId: String) {
        val socket = pendingSockets.remove(requestId) ?: return
        try { socket.close() } catch (_: Exception) {}
    }

    fun stop() {
        // Close all pending sockets
        for ((_, socket) in pendingSockets) {
            try { socket.close() } catch (_: Exception) {}
        }
        pendingSockets.clear()
        sessionIdMap.clear()
        transcriptPathMap.clear()
        listenJob?.cancel()
        try { serverSocket?.close() } catch (_: Exception) {}
        serverSocket = null
    }
}
