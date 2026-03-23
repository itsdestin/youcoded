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

    @Volatile private var serverSocket: LocalServerSocket? = null
    private var listenJob: Job? = null

    fun startServer(scope: CoroutineScope) {
        listenJob = scope.launch(Dispatchers.IO) {
            // Retry binding — socket may linger briefly after a previous session
            var retries = 3
            while (retries > 0) {
                try {
                    serverSocket = LocalServerSocket(socketName)
                    android.util.Log.d("EventBridge", "Listening on abstract socket: $socketName")
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
            android.util.Log.d("EventBridge", "Received: ${line.take(300)}")

            // Peek at event type to decide whether to hold the socket
            val json = try { JSONObject(line) } catch (_: Exception) { client.close(); return }
            val eventName = json.optString("hook_event_name", "")

            if (eventName == "PermissionRequest") {
                // Hold socket open for blocking response
                val requestId = UUID.randomUUID().toString()
                pendingSockets[requestId] = client
                // Inject requestId into the JSON so downstream can reference it
                json.put("_requestId", requestId)
                val event = HookEvent.fromJson(json.toString())
                if (event != null) {
                    if (!_events.tryEmit(event)) {
                        android.util.Log.e("EventBridge", "Event buffer full, dropped: ${event::class.simpleName}")
                    }
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
                    android.util.Log.w("EventBridge", "Failed to parse hook event: ${line.take(500)}")
                }
                client.close()
            }
        } catch (e: Exception) {
            android.util.Log.w("EventBridge", "Client error", e)
            try { client.close() } catch (_: Exception) {}
        }
    }

    /** Send a decision back through a held PermissionRequest socket. */
    fun respond(requestId: String, decision: JSONObject) {
        val socket = pendingSockets.remove(requestId) ?: return
        try {
            socket.outputStream.write((decision.toString() + "\n").toByteArray())
            socket.outputStream.flush()
            socket.close()
        } catch (e: Exception) {
            android.util.Log.w("EventBridge", "respond() failed (relay timeout?)", e)
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
        listenJob?.cancel()
        try { serverSocket?.close() } catch (_: Exception) {}
        serverSocket = null
    }
}
