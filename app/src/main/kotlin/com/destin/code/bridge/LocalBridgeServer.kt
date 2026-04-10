package com.destin.code.bridge

import android.util.Log
import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import org.json.JSONObject
import java.net.InetSocketAddress
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * WebSocket server on localhost:9901 that speaks the same protocol
 * as the desktop's remote-server.ts. The React UI connects via
 * remote-shim.ts and sees the same API regardless of platform.
 *
 * Security: Clients must send an auth message with the correct token
 * before any other messages are processed. The token is generated at
 * server start and injected into the WebView by WebViewHost.
 */
class LocalBridgeServer(
    private val port: Int = 9901
) {
    companion object {
        private const val TAG = "LocalBridgeServer"
        // Security: max time (ms) a client can stay connected without authenticating
        private const val AUTH_TIMEOUT_MS = 5000L
    }

    private var server: WebSocketServer? = null
    private val clients = ConcurrentHashMap<String, WebSocket>()
    private val clientIdCounter = AtomicInteger(0)

    // Security: random auth token generated on each server start — WebView must
    // present this token before messages are routed to the handler
    val authToken: String = java.util.UUID.randomUUID().toString()

    // Security: track which connections have authenticated
    private val authenticatedClients = ConcurrentHashMap.newKeySet<WebSocket>()

    /**
     * Start the WebSocket server. The [handleMessage] callback is invoked
     * for every parsed message from an authenticated client.
     */
    fun start(
        handleMessage: (ws: WebSocket, msg: MessageRouter.ParsedMessage) -> Unit
    ) {
        server = object : WebSocketServer(InetSocketAddress("127.0.0.1", port)) {
            override fun onOpen(conn: WebSocket, handshake: ClientHandshake) {
                val clientId = "client-${clientIdCounter.incrementAndGet()}"
                conn.setAttachment(clientId)
                Log.i(TAG, "Client connected: $clientId (awaiting auth)")

                // Security: validate Origin header — only allow local/bundled origins
                val origin = handshake.getFieldValue("Origin")
                if (origin != null && origin.isNotEmpty()) {
                    val allowed = origin == "null" ||           // file:// pages report "null"
                            origin == "file://" ||
                            origin.startsWith("http://localhost") ||
                            origin.startsWith("http://127.0.0.1") ||
                            origin.startsWith("http://10.0.2.2")  // Android emulator gateway
                    if (!allowed) {
                        Log.w(TAG, "Rejecting client $clientId: bad Origin '$origin'")
                        conn.close(4003, "Forbidden origin")
                        return
                    }
                }

                // Security: schedule disconnect if client doesn't authenticate in time
                java.util.Timer().schedule(object : java.util.TimerTask() {
                    override fun run() {
                        if (!authenticatedClients.contains(conn) && conn.isOpen) {
                            Log.w(TAG, "Auth timeout for $clientId — disconnecting")
                            conn.close(4001, "Auth timeout")
                        }
                    }
                }, AUTH_TIMEOUT_MS)
            }

            override fun onClose(conn: WebSocket, code: Int, reason: String, remote: Boolean) {
                val clientId = conn.getAttachment<String>()
                if (clientId != null) clients.remove(clientId)
                authenticatedClients.remove(conn)
                Log.i(TAG, "Client disconnected: $clientId")
            }

            override fun onMessage(conn: WebSocket, message: String) {
                val parsed = MessageRouter.parseMessage(message)
                if (parsed == null) {
                    Log.w(TAG, "Unparseable message: ${message.take(200)}")
                    return
                }

                // Security: handle auth messages — validate token before granting access
                if (parsed.type == "auth") {
                    val token = parsed.payload.optString("token", "")
                    if (token == authToken) {
                        val clientId = conn.getAttachment<String>() ?: "unknown"
                        authenticatedClients.add(conn)
                        clients[clientId] = conn
                        Log.i(TAG, "Client authenticated: $clientId")
                        val authOk = MessageRouter.buildAuthOkResponse("android")
                        conn.send(authOk.toString())
                    } else {
                        Log.w(TAG, "Bad auth token from ${conn.getAttachment<String>()}")
                        conn.close(4002, "Invalid token")
                    }
                    return
                }

                // Security: reject messages from unauthenticated clients
                if (!authenticatedClients.contains(conn)) {
                    Log.w(TAG, "Message from unauthenticated client — ignoring")
                    return
                }

                handleMessage(conn, parsed)
            }

            override fun onError(conn: WebSocket?, ex: Exception) {
                Log.e(TAG, "WebSocket error: ${ex.message}", ex)
            }

            override fun onStart() {
                Log.i(TAG, "LocalBridgeServer listening on 127.0.0.1:$port")
            }
        }

        server?.isReuseAddr = true
        server?.start()
    }

    fun stop() {
        try {
            server?.stop(1000)
        } catch (e: Exception) {
            Log.w(TAG, "Error stopping server: ${e.message}")
        }
        clients.clear()
        authenticatedClients.clear()
        Log.i(TAG, "LocalBridgeServer stopped")
    }

    /** Send a push event to all connected (authenticated) clients */
    fun broadcast(message: JSONObject) {
        val msg = message.toString()
        authenticatedClients.forEach { ws ->
            try {
                ws.send(msg)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to broadcast: ${e.message}")
            }
        }
    }

    /** Send a response to a specific request */
    fun respond(ws: WebSocket, type: String, id: String, payload: Any?) {
        val msg = JSONObject().apply {
            put("type", "${type}:response")
            put("id", id)
            put("payload", payload ?: JSONObject.NULL)
        }.toString()
        ws.send(msg)
    }

    val isRunning: Boolean get() = server != null
}
