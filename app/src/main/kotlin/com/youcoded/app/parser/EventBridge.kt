package com.youcoded.app.parser

import android.net.LocalServerSocket
import android.net.LocalSocket
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
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
class EventBridge(private val socketName: String, private val ownSessionId: String? = null) {
    companion object {
        /** Tier-1 app hold (2h) — the app owns the permission-ask clock, like
         *  desktop hook-relay.ts APP_HOLD_MS. Must stay UNDER the relay asset's
         *  2h30m and Bootstrap's 3h Claude Code hook timeout: if Claude Code's
         *  timeout fires first it kills the hook with NO decision and
         *  AskUserQuestion waits forever. Pinned by
         *  desktop/tests/permission-timeout-margins.test.ts. */
        const val PERMISSION_HOLD_MS = 7_200_000L

        /** An ask that names a DIFFERENT YouCoded session than the one this
         *  bridge serves. Nothing here can show it a card, so it is handed back
         *  undecided (socket closed, nothing written → the relay exits 0,
         *  prints nothing, and Claude Code shows its own prompt) — never held
         *  and never denied. Same rule as desktop hook-relay.ts (review
         *  2026-09-23, F2). An ask with no session id arrived on this session's
         *  own socket, so it is this session's. */
        fun isForeignAsk(askSessionId: String?, ownSessionId: String?): Boolean =
            !askSessionId.isNullOrBlank() && !ownSessionId.isNullOrBlank() && askSessionId != ownSessionId

        /** What handleClient does with one incoming hook line. Pure, so the
         *  routing — including the foreign-ask hand-back — is unit-tested. */
        enum class Route { HOLD_FOR_CARD, PASS_THROUGH, FIRE_AND_FORGET }

        fun route(eventName: String, askSessionId: String?, ownSessionId: String?): Route = when {
            eventName != "PermissionRequest" -> Route.FIRE_AND_FORGET
            isForeignAsk(askSessionId, ownSessionId) -> Route.PASS_THROUGH
            else -> Route.HOLD_FOR_CARD
        }
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

    /** True once Claude Code has run its first hook for this session — which it does
     *  only after every startup dialog (trust, bypass, MCP approval) is answered.
     *  The ONLY signal that the session has started: the React UI keeps its input
     *  gated and its startup safety net on until then. Replaces "the screen showed
     *  anything" (review F1, 2026-09-24), which fired ~1 s after launch, BEFORE the
     *  dialogs, and let chat text be typed into a live multi-select MCP dialog.
     *  Desktop's equivalent: App.tsx marks a session started on its first hook event. */
    private val _sessionStarted = MutableStateFlow(false)
    val sessionStarted: StateFlow<Boolean> = _sessionStarted

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

    /**
     * The first half of handling one hook line, split out so a JVM test can
     * drive it without a LocalSocket (review B1). Returns the parsed event to
     * route, or null when the connection should just be closed: unparseable,
     * refused by HookOwnerGate (a `claude` nested inside this session — closing
     * with no reply lets a blocking relay exit so the nested process uses its
     * own prompt), or a SessionStart, which is registered only to claim the
     * owner and refresh the maps (there is no HookEvent for it).
     */
    internal fun admit(line: String): JSONObject? {
        val json = try { JSONObject(line) } catch (_: Exception) { return null }
        val eventName = json.optString("hook_event_name", "")
        val mobileSessionId = json.optString("mobileSessionId", "")
        if (!owners.accept(mobileSessionId, json.optString("claudePid", ""), eventName == "SessionStart")) return null
        // Any admitted hook (SessionStart, or a later one if SessionStart was lost)
        // proves the startup dialogs are behind us. A refused (nested) one does not.
        _sessionStarted.value = true

        val claudeSessionId = json.optString("session_id", "")
        if (mobileSessionId.isNotBlank() && claudeSessionId.isNotBlank()) {
            sessionIdMap[mobileSessionId] = claudeSessionId
        }
        // Claude Code includes transcript_path on every hook event.
        val transcriptPath = json.optString("transcript_path", "")
        if (mobileSessionId.isNotBlank() && transcriptPath.isNotBlank()) {
            transcriptPathMap[mobileSessionId] = transcriptPath
        }
        return if (eventName == "SessionStart") null else json
    }

    // Non-suspend (master fix) — uses tryEmit to avoid blocking the coroutine.
    private fun handleClient(client: LocalSocket) {
        try {
            val reader = BufferedReader(InputStreamReader(client.inputStream))
            val line = reader.readLine() ?: run { client.close(); return }
            if (com.youcoded.app.BuildConfig.DEBUG) android.util.Log.d("EventBridge", "Received: ${line.take(300)}")

            // Parse, gate, record the session maps; null = nothing more to do.
            val json = admit(line) ?: run { client.close(); return }
            val eventName = json.optString("hook_event_name", "")

            // WHY this order (combined branch: integrations' admit() meets
            // plan-approval's route()): admit() has already dropped a nested
            // `claude`'s hooks, recorded the session maps and stopped at
            // SessionStart; route() then passes an ask for another session
            // straight through, and anything left that is an ask is held.
            val route = route(eventName, json.optString("mobileSessionId", ""), ownSessionId)
            if (route == Route.PASS_THROUGH) {
                // Not this session's ask: hand it straight back, undecided.
                android.util.Log.i("EventBridge", "Passing through an ask for another session")
                client.close()
                return
            }

            if (route == Route.HOLD_FOR_CARD) {
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
 * forwards it as `claudePid`.
 *
 * WHY only a SessionStart claims (review F2): the real process fires
 * SessionStart at launch, before it can run anything that could start a nested
 * one, so its pid is the first to claim. Letting ANY first hook claim would let
 * a nested process that happened to report first lock the real session out.
 * Until a SessionStart claims, everything is accepted (fail open, the old
 * behaviour); a missing pid always fails open.
 */
class HookOwnerGate {
    private val owners = ConcurrentHashMap<String, String>()
    // First pid that sent a non-SessionStart hook before any owner was claimed.
    private val firstToolPid = ConcurrentHashMap<String, String>()

    /**
     * WHY a claim can go to an EARLIER pid (review C2): if the real process's
     * SessionStart is lost, its tool hooks arrive with no owner, and a nested
     * `claude`'s SessionStart would otherwise claim the session and drop every
     * real hook. A nested process exists only after the real one ran a tool,
     * and the real one fires SessionStart before any tool, so a pid that sent
     * tool hooks before any claim is the real one. Mirrors desktop.
     */
    @Synchronized
    fun accept(sessionId: String, claudePid: String, isSessionStart: Boolean): Boolean {
        if (sessionId.isBlank() || claudePid.isBlank()) return true
        owners[sessionId]?.let { return it == claudePid }
        if (!isSessionStart) {
            firstToolPid.putIfAbsent(sessionId, claudePid)
            return true
        }
        val claimed = firstToolPid.remove(sessionId) ?: claudePid
        owners[sessionId] = claimed
        return claimed == claudePid
    }
}
