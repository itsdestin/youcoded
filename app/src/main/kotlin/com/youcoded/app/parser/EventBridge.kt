package com.youcoded.app.parser

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
    companion object {
        /** Tier-1 app hold (2h) — the app owns the permission-ask clock, like
         *  desktop hook-relay.ts APP_HOLD_MS. Must stay UNDER the relay asset's
         *  2h30m and Bootstrap's 3h Claude Code hook timeout: if Claude Code's
         *  timeout fires first it kills the hook with NO decision and
         *  AskUserQuestion waits forever. Pinned by
         *  desktop/tests/permission-timeout-margins.test.ts. */
        const val PERMISSION_HOLD_MS = 7_200_000L
    }

    private val _events = MutableSharedFlow<HookEvent>(extraBufferCapacity = 1000)
    val events: SharedFlow<HookEvent> = _events

    /** Sockets held open for blocking PermissionRequest responses. */
    private val pendingSockets = ConcurrentHashMap<String, LocalSocket>()

    /** Tier-1 hold timers by requestId. Cancelled on every path that ends a
     *  request (respond, closure monitor, stop) so a 2h coroutine never
     *  outlives the socket it guards or emits a second expiry. */
    private val holdJobs = ConcurrentHashMap<String, Job>()

    /** Maps mobile session IDs to Claude Code session IDs. */
    private val sessionIdMap = ConcurrentHashMap<String, String>()

    /** Maps mobile session IDs to transcript file paths (extracted from hook events). */
    private val transcriptPathMap = ConcurrentHashMap<String, String>()

    /** First Claude Code process heard per session (desktop hook-relay.ts mirror). */
    private val owners = HookOwnerGate()

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
                    if (com.youcoded.app.BuildConfig.DEBUG) android.util.Log.d("EventBridge", "Listening on abstract socket: $socketName")
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
            if (com.youcoded.app.BuildConfig.DEBUG) android.util.Log.d("EventBridge", "Received: ${line.take(300)}")

            // Peek at event type to decide whether to hold the socket
            val json = try { JSONObject(line) } catch (_: Exception) { client.close(); return }
            val eventName = json.optString("hook_event_name", "")

            // A hook from a `claude` nested inside this session (Bash tool,
            // script) — see HookOwnerGate. Dropped before it can remap the
            // session or show a card; closing with no reply lets a blocking
            // relay exit so the nested process uses its own prompt.
            val ownerSessionId = json.optString("mobileSessionId", "")
            if (!owners.accept(ownerSessionId, json.optString("claudePid", ""))) {
                client.close()
                return
            }

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
                    armHold(requestId, sessionId)
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
     * Tier-1 hold: after PERMISSION_HOLD_MS the app answers the ask itself with
     * a labelled deny, so Claude Code moves on and the card can say what
     * happened. No routability cap here (desktop has a 60s one): EventBridge is
     * per-session, so an ask on this socket always belongs to a live session.
     * Must emit explicitly — respond() removes the pending entry BEFORE closing,
     * so the closure monitor stays silent for app-initiated endings.
     */
    private fun armHold(requestId: String, sessionId: String) {
        monitorScope?.launch(Dispatchers.IO) {
            delay(PERMISSION_HOLD_MS)
            holdJobs.remove(requestId)
            if (!pendingSockets.containsKey(requestId)) return@launch
            val hours = PERMISSION_HOLD_MS / 3_600_000L
            // Nested decision shape is load-bearing: the relay reads
            // appDecision.decision. The message lands in the tool result the
            // model reads. Same wording as desktop hook-relay.ts.
            val deny = JSONObject().put("decision", JSONObject()
                .put("behavior", "deny")
                .put("message", "YouCoded auto-denied this request after $hours hour${if (hours == 1L) "" else "s"} with no response — ask again if it is still needed."))
            // Only claim an auto-deny if it was written; a failed write has
            // already emitted its own "delivery-failed" expiry (at most one per ask).
            if (respond(requestId, deny)) {
                _events.tryEmit(HookEvent.PermissionExpired(
                    sessionId = sessionId,
                    hookEventName = "PermissionExpired",
                    requestId = requestId,
                    reason = "app-timeout",
                ))
            }
        }?.also { holdJobs[requestId] = it }
    }

    /**
     * Monitor a held PermissionRequest socket for remote closure.
     * When hook-relay-blocking.js times out (its 2h30m backstop) or Claude Code kills the hook
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
                // The far end went away first — not our hold firing. Cancel the
                // hold so it cannot emit too; "hook-closed" tells React that
                // Claude Code's own menu may still be up, so the card stays.
                holdJobs.remove(requestId)?.cancel()
                if (!_events.tryEmit(HookEvent.PermissionExpired(
                        sessionId = sessionId,
                        hookEventName = "PermissionExpired",
                        requestId = requestId,
                        reason = "hook-closed",
                    ))) {
                    android.util.Log.e("EventBridge", "Event buffer full, dropped PermissionExpired")
                }
            }
        }
    }

    /**
     * Send a decision back through a held PermissionRequest socket.
     * Returns true when the write succeeded; false when there was no such
     * request or the write failed (the failure path has ALREADY emitted a
     * "delivery-failed" expiry — callers must not emit another).
     */
    fun respond(requestId: String, decision: JSONObject): Boolean {
        // A decision is going out (or being attempted): the hold is done.
        holdJobs.remove(requestId)?.cancel()
        val socket = pendingSockets.remove(requestId)
        if (socket == null) {
            android.util.Log.e("EventBridge", "No pending socket for requestId=$requestId")
            return false
        }
        try {
            val payload = decision.toString() + "\n"
            socket.outputStream.write(payload.toByteArray())
            socket.outputStream.flush()
            socket.close()
            return true
        } catch (e: Exception) {
            // Response couldn't be delivered — permission effectively expired.
            // Emit PermissionExpired so React UI clears the stale approval card.
            android.util.Log.e("EventBridge", "respond() write failed — emitting PermissionExpired", e)
            try { socket.close() } catch (_: Exception) {}
            _events.tryEmit(HookEvent.PermissionExpired(
                sessionId = "",  // ManagedSession uses its own ID for broadcast
                hookEventName = "PermissionExpired",
                requestId = requestId,
                reason = "delivery-failed",
            ))
            return false
        }
    }

    /**
     * True while any PermissionRequest socket is held open. In that window
     * Claude Code's TUI is showing a live Ink select menu (permission prompt /
     * AskUserQuestion / plan approval) — automated PTY writers must not send
     * bytes to this session or they act as menu keystrokes (a trailing `\r`
     * selects the highlighted option, silently answering the prompt).
     * EventBridge is per-session (one per PtyBridge), so no session filter is
     * needed. Desktop equivalent: HookRelay.hasPendingPermission (youcoded#110).
     */
    fun hasPendingPermission(): Boolean = pendingSockets.isNotEmpty()

    fun stop() {
        // Cancel the hold timers first so none fires into a socket being closed.
        holdJobs.values.forEach { it.cancel() }
        holdJobs.clear()
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

/**
 * Which Claude Code process owns a session's hooks — mirror of desktop
 * `HookOwnerGate` in hook-relay.ts.
 *
 * WHY (2026-09-23, security): CLAUDE_MOBILE_SESSION_ID is inherited by every
 * process the session starts, so a `claude` launched from inside it reported
 * its hooks as this session's, overwriting the session-id map (which, unlike
 * desktop, has no remap guard) and able to raise a permission card. Claude
 * Code puts its own pid in every hook's env (CLAUDE_PID) and the relay
 * forwards it as `claudePid`; a session runs one Claude Code process, which
 * reports first, so the first pid is the owner. A missing pid fails open.
 */
class HookOwnerGate {
    private val owners = ConcurrentHashMap<String, String>()

    fun accept(sessionId: String, claudePid: String): Boolean {
        if (sessionId.isBlank() || claudePid.isBlank()) return true
        val owner = owners.putIfAbsent(sessionId, claudePid) ?: return true
        return owner == claudePid
    }
}
