// Android mirror of desktop's presence-socket.ts: SessionService owns the
// socket + token; React only sees relayed social:presence-event pushes.
package com.youcoded.app.social

import okhttp3.*
import org.json.JSONObject
import java.util.concurrent.TimeUnit

// HIDDEN MODE (incognito, per device) — desktop parity with presence-socket.ts "HIDDEN MODE".
// Destin, 2026-10-05: "they shouldn't be able to see me in incognito, but i feel like i should still
// be able to see who else is online." The server (wecoded-marketplace PresenceRoom) keeps a
// `?hidden=1` socket out of every friend's view while it still RECEIVES their presence. An OLDER
// server ignores the flag and would announce the user, so two guards: (1) ask CAPABILITIES_URL first
// and never connect hidden without `{"hidden": true}`; (2) the first frame must be
// {"type":"hello","hidden":true}, or disconnect at once and report "hidden-unsupported". While hidden,
// status changes and challenges never leave the device.
object HiddenPresence {
    const val PRESENCE_URL = "wss://api.youcoded.ai/social/presence"
    const val CAPABILITIES_URL = "https://api.youcoded.ai/social/presence/capabilities"
    private val BLOCKED = setOf("status", "challenge", "challenge-response")

    fun url(hidden: Boolean, base: String = PRESENCE_URL): String = if (hidden) "$base?hidden=1" else base

    /** Guard 1's three answers (desktop parity: presence-socket.ts HiddenSupport). Only YES connects.
     *  WHY three (final review F4): a single "no" turned a flaky network at launch into presence OFF
     *  for the whole session. NO is an older server (404, or an answer without `hidden: true`);
     *  UNKNOWN is a check that could not be made (no network, timeout, 5xx, 429, unreadable) — retried. */
    enum class Support { YES, NO, UNKNOWN }

    fun supportsHidden(code: Int, body: String?): Support = when {
        code == 404 -> Support.NO
        code !in 200..299 -> Support.UNKNOWN
        else -> runCatching { if (JSONObject(body ?: "").optBoolean("hidden", false)) Support.YES else Support.NO }
            .getOrDefault(Support.UNKNOWN)
    }

    /** Re-check delays after UNKNOWN (desktop parity: social-handlers.ts HIDDEN_RETRY_MS); the last repeats. */
    val RETRY_MS = longArrayOf(5_000, 15_000, 30_000, 60_000)
    fun retryDelay(attempt: Int): Long = RETRY_MS[minOf(attempt, RETRY_MS.size - 1)]

    /** Guard 2: is this first frame the server's confirmation? */
    fun confirmsHidden(frame: String): Boolean = runCatching {
        val o = JSONObject(frame)
        o.optString("type") == "hello" && o.optBoolean("hidden", false)
    }.getOrDefault(false)

    /** Frames a hidden device must never send. */
    fun blockedWhileHidden(message: JSONObject): Boolean = message.optString("type") in BLOCKED

    /** Guard 1, asynchronously (never on the main looper). */
    fun probe(http: OkHttpClient, url: String = CAPABILITIES_URL, done: (Support) -> Unit) {
        http.newCall(Request.Builder().url(url).build()).enqueue(object : Callback {
            override fun onFailure(call: Call, e: java.io.IOException) = done(Support.UNKNOWN)
            override fun onResponse(call: Call, response: Response) {
                response.use { done(supportsHidden(it.code, it.body?.string())) }
            }
        })
    }
}

/** Where PresenceClient runs its state machine. The app uses the main looper; a unit test passes a
 *  queue it drains by hand, so it can make OkHttp's thread and the looper interleave the way a busy
 *  phone does (final review F3 — the timing bug no pure-helper test could reach). */
interface PresencePoster {
    fun post(r: () -> Unit)
    fun postDelayed(r: () -> Unit, delayMs: Long)
}

private object MainLooperPoster : PresencePoster {
    private val handler by lazy { android.os.Handler(android.os.Looper.getMainLooper()) }
    override fun post(r: () -> Unit) { handler.post { r() } }
    override fun postDelayed(r: () -> Unit, delayMs: Long) { handler.postDelayed({ r() }, delayMs) }
}

class PresenceClient(
    private val getToken: () -> String?,
    private val onEvent: (JSONObject) -> Unit,
    private val handler: PresencePoster = MainLooperPoster,
    private val presenceUrl: String = HiddenPresence.PRESENCE_URL,
    private val capabilitiesUrl: String = HiddenPresence.CAPABILITIES_URL,
) {
    // Dedicated client so pingInterval (WebSocket-protocol keepalive) is scoped
    // to presence and doesn't perturb the marketplace REST OkHttpClient.
    private val http = OkHttpClient.Builder().pingInterval(30, TimeUnit.SECONDS).build()

    // THREADING MODEL: all state mutation (desired / ws / attempts) is serialized
    // on the main-looper handler — setDesired() and send() marshal their bodies
    // onto it, retry's delayed connect() already posts to it, and every OkHttp
    // callback re-posts before touching state. One thread owns the state machine,
    // mirroring desktop's Node event loop, so no @Volatile is needed on these and
    // the check-then-act sequences (e.g. `if (ws != null) return; ws = ...`)
    // can't interleave.
    // @Volatile because onMessage (OkHttp's thread) compares against it to drop a replaced socket's frames.
    @Volatile private var ws: WebSocket? = null
    private var desired = false
    private var attempts = 0
    private val backoffMs = longArrayOf(1_000, 2_000, 5_000, 10_000, 30_000)
    // Desktop parity: reconnecting-ws.ts PING_INTERVAL_MS — the app-level ping
    // both platforms must send (see schedulePing below for why OkHttp's
    // protocol-level ping is not enough).
    private val pingIntervalMs = 30_000L

    // Read by isConnected() from the SessionService bridge thread (the honest
    // presence-send receipt check) while writes happen on the main looper — so
    // this one flag stays @Volatile even though the rest of the state doesn't.
    @Volatile private var connected = false
    // Hidden mode for this device. The "has THIS socket's server confirmed it" flag (guard 2) lives in
    // each socket's own listener — see connect(). Read by send() from the bridge thread — hence @Volatile.
    @Volatile private var hidden = false
    // True once the CURRENT socket's server sent the hidden hello. Written on the looper only.
    private var hiddenConfirmed = false
    // WHY a generation (final review F26 parity, F4): the capability check and its retries are async;
    // a newer setDesired (a quick incognito off/on, a sign-out) must make every older answer a no-op.
    private var intentGen = 0

    fun isConnected(): Boolean = connected

    fun setDesired(want: Boolean, hiddenMode: Boolean = false) {
        // Marshal onto the main looper: the caller runs on the bridge thread and
        // this compound check-then-act must not race a queued retry connect().
        handler.post {
            val gen = ++intentGen
            if (hiddenMode != hidden) {
                // The mode is part of the URL: close the current socket first, so a visible one is
                // gone (and announced as left) before a hidden one opens.
                closeCurrent()
                hidden = hiddenMode
            }
            desired = want
            if (!want) { closeCurrent(); return@post }
            // A hidden socket this server already confirmed needs no re-check (desktop parity).
            if (!hidden || (ws != null && hiddenConfirmed)) { connect(); return@post }
            checkHidden(gen, 0)
        }
    }

    // Guard 1: no hidden connection without the server's promise to hide it. Runs on the looper.
    // NO (an older server) is final and reported as "hidden-unsupported". UNKNOWN stays disconnected,
    // reports "hidden-check-failed" and checks again on a backoff — never a visible fallback.
    private fun checkHidden(gen: Int, attempt: Int) {
        HiddenPresence.probe(http, capabilitiesUrl) { answer ->
            handler.post {
                if (gen != intentGen || !desired || !hidden) return@post // superseded
                when (answer) {
                    HiddenPresence.Support.YES -> connect()
                    HiddenPresence.Support.NO -> {
                        // WHY closeCurrent too (final review F29): leaving an open socket behind while the
                        // UI says disconnected — desktop closes it.
                        desired = false
                        closeCurrent()
                        onEvent(JSONObject().put("type", "hidden-unsupported"))
                    }
                    HiddenPresence.Support.UNKNOWN -> {
                        closeCurrent()
                        onEvent(JSONObject().put("type", "hidden-check-failed"))
                        handler.postDelayed({
                            if (gen == intentGen && desired && hidden) checkHidden(gen, attempt + 1)
                        }, HiddenPresence.retryDelay(attempt))
                    }
                }
            }
        }
    }

    // Intentional local close (want-off or a mode switch). Runs on the looper.
    private fun closeCurrent() {
            val s = ws ?: return // want-off with no socket: any queued retry self-cancels via connect()'s desired guard
            // Capture-and-null FIRST so the socket's async onClosed/onFailure is
            // recognized as superseded (retry()'s `ws !== source` guard) and
            // doesn't double-emit or schedule a reconnect.
            ws = null
            connected = false
            hiddenConfirmed = false
            s.close(1000, "incognito or sign-out")
            // reason:'local' marks an INTENTIONAL disconnect (desktop parity) —
            // Task 7 uses it to suppress "reconnecting" UI. Emitted synchronously
            // here rather than waiting for OkHttp's async close callback.
            onEvent(JSONObject().put("type", "disconnected").put("code", 1000).put("reason", "local"))
    }

    /** False when the frame is dropped because this device is hidden; true when queued to the socket. */
    fun send(message: JSONObject): Boolean {
        // While hidden, nothing a friend could notice leaves this device (the server refuses these too).
        if (hidden && HiddenPresence.blockedWhileHidden(message)) return false
        // Same looper as all other socket-state access — see THREADING MODEL.
        handler.post { ws?.send(message.toString()) }
        return true
    }

    private fun connect() {
        // No token: stay quiet. The renderer re-invokes presence-connect when
        // sign-in completes; do NOT turn this bail into an error — no-token is
        // the normal pre-sign-in state.
        val token = getToken() ?: return
        // Guard covers both a duplicate connect and the retry runnable firing
        // after desired flipped to false while it was queued.
        if (!desired || ws != null) return
        val req = Request.Builder()
            // WHY: Moved to its own domain so Cloudflare's cache and rate limiter apply; the old workers.dev address still answers for older app versions.
            .url(HiddenPresence.url(hidden, presenceUrl))
            .header("Authorization", "Bearer $token")
            .build()
        // WHY per-socket state (final review F3): one shared `helloSeen` was reset by onOpen through a
        // looper post while onMessage set it on OkHttp's thread, so a busy phone could run the reset AFTER
        // the hello and read the next frame as "not confirmed" — disconnecting incognito on a good server.
        // OkHttp delivers one socket's callbacks in order on one thread, so this listener's own fields
        // need no locking, and each socket judges only its own first frame.
        val hiddenHere = hidden
        hiddenConfirmed = false
        ws = http.newWebSocket(req, object : WebSocketListener() {
            private var helloSeen = false
            override fun onOpen(webSocket: WebSocket, response: Response) {
                handler.post {
                    // Superseded before the handshake completed (disconnect during
                    // the connect window) — don't emit a spurious 'connected'.
                    if (ws !== webSocket) return@post
                    attempts = 0
                    schedulePing(webSocket)
                    // A hidden socket is not "connected" until the server confirms it (onMessage).
                    if (hiddenHere) return@post
                    connected = true
                    onEvent(JSONObject().put("type", "connected"))
                }
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (hiddenHere && !helloSeen) {
                    // Guard 2, decided on this thread so no later frame can slip past it.
                    if (HiddenPresence.confirmsHidden(text)) {
                        helloSeen = true
                        handler.post {
                            if (ws !== webSocket) return@post
                            hiddenConfirmed = true
                            connected = true
                            onEvent(JSONObject().put("type", "connected"))
                        }
                    } else {
                        // This server counted us VISIBLE: leave at once, relay nothing, say why.
                        helloSeen = true // stop judging later frames of this dying socket
                        handler.post {
                            if (ws !== webSocket) return@post
                            desired = false
                            closeCurrent()
                            onEvent(JSONObject().put("type", "hidden-unsupported"))
                        }
                    }
                    return
                }
                // A frame from a socket already replaced or closed is not relayed (desktop parity, F25).
                // `ws` is written on the looper; a stale read here can only drop a frame of a dying socket.
                if (ws !== webSocket) return
                // Server protocol frames + pong are all JSON; ignore non-JSON.
                // Relay directly (no state touched) — onEvent is thread-safe.
                runCatching { onEvent(JSONObject(text)) }
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                handler.post { retry(webSocket, code, reason) }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                // Desktop parity: emit {type:'error', message} BEFORE the
                // disconnected+retry so Task 7's error state also sets on Android.
                onEvent(JSONObject().put("type", "error").put("message", t.message ?: "failure"))
                handler.post { retry(webSocket, 1006, t.message ?: "failure") }
            }
        })
    }

    // App-level liveness ping — REQUIRED, not redundant with OkHttp's
    // pingInterval. OkHttp sends WebSocket *protocol* pings, which Cloudflare's
    // edge answers without the presence room ever observing them; the server's
    // liveness model (PresenceRoom stale-socket eviction, 2026-07-22) counts
    // only application frames and its auto-response JSON ping pair. Without
    // this loop, every Android socket looks permanently silent server-side and
    // gets evicted on the staleness timer. The string must stay byte-exact:
    // the server's WebSocketRequestResponsePair matches {"type":"ping"}
    // (identical to desktop's JSON.stringify({type:'ping'})).
    // OkHttp's protocol ping stays enabled too — it is what detects a dead
    // connection CLIENT-side and triggers the reconnect backoff.
    private fun schedulePing(socket: WebSocket) {
        handler.postDelayed({
            // Superseded or torn down — stop silently; a new socket's onOpen
            // starts its own loop. Same identity guard as retry().
            if (ws !== socket) return@postDelayed
            socket.send("""{"type":"ping"}""")
            schedulePing(socket)
        }, pingIntervalMs)
    }

    private fun retry(source: WebSocket, code: Int, reason: String) {
        // Superseded socket (intentional local disconnect already nulled ws and
        // emitted its own event) — its lifecycle no longer drives state.
        if (ws !== source) return
        ws = null
        connected = false
        hiddenConfirmed = false
        onEvent(JSONObject().put("type", "disconnected").put("code", code).put("reason", reason))
        if (desired) {
            // Capped backoff so a Worker deploy doesn't kill presence for the
            // session. A dead-token loop is bounded by the account revalidation
            // path: dead token → 401 on any account call → signOut → the
            // sign-out case calls setDesired(false).
            val delay = backoffMs[minOf(attempts, backoffMs.size - 1)]
            attempts += 1
            handler.postDelayed({ connect() }, delay)
        }
    }
}
