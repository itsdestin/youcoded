package com.destins.claudemobile.parser

import android.net.LocalServerSocket
import android.net.LocalSocket
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import java.io.BufferedReader
import java.io.InputStreamReader

/**
 * Listens on an Android abstract-namespace Unix socket for hook-relay.js connections.
 * Each connection delivers one JSON line (a Claude Code hook event).
 *
 * Uses Android's LocalServerSocket which creates abstract namespace sockets.
 * hook-relay.js connects via Node.js net.connect() with '\0' prefix for abstract namespace.
 */
class EventBridge(private val socketName: String) {
    private val _events = MutableSharedFlow<HookEvent>(extraBufferCapacity = 1000)
    val events: SharedFlow<HookEvent> = _events

    private var serverSocket: LocalServerSocket? = null
    private var listenJob: Job? = null

    fun startServer(scope: CoroutineScope) {
        listenJob = scope.launch(Dispatchers.IO) {
            try {
                serverSocket = LocalServerSocket(socketName)
                android.util.Log.d("EventBridge", "Listening on abstract socket: $socketName")

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

    private suspend fun handleClient(client: LocalSocket) {
        try {
            client.use { socket ->
                val reader = BufferedReader(InputStreamReader(socket.inputStream))
                val line = reader.readLine() ?: return
                android.util.Log.d("EventBridge", "Received: ${line.take(300)}")
                val event = HookEvent.fromJson(line)
                if (event != null) {
                    _events.emit(event)
                } else {
                    android.util.Log.w("EventBridge", "Failed to parse hook event: ${line.take(500)}")
                }
            }
        } catch (e: Exception) {
            android.util.Log.w("EventBridge", "Client error", e)
        }
    }

    fun stop() {
        listenJob?.cancel()
        try { serverSocket?.close() } catch (_: Exception) {}
        serverSocket = null
    }
}
