package com.youcoded.app.runtime

import android.net.LocalServerSocket
import android.net.LocalSocket
import android.util.Log
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * The backend's line to the phone: an abstract local socket, one JSON object per line.
 * {id, method, params} → {id, result} | {id, error}. The other end is desktop/src/main/headless/host-bridge.ts.
 *
 * WHY an abstract socket (2026-10-14, Android clean rebuild): it lives only in memory, and Android's
 * sandbox lets only this app's own processes (the backend runs as the app's user) reach a socket the app
 * created. The handler runs on the connection's thread; it must not touch views.
 */
class HostSocketServer(
    private val name: String,
    private val handler: (method: String, params: JSONObject) -> Any?,
) {
    private var server: LocalServerSocket? = null
    @Volatile private var closed = false

    fun start() {
        val s = LocalServerSocket(name)
        server = s
        thread(name = "host-socket", isDaemon = true) {
            while (!closed) {
                val client = try { s.accept() } catch (e: Exception) { if (!closed) Log.w(TAG, "accept failed: ${e.message}"); break }
                thread(name = "host-socket-client", isDaemon = true) { serve(client) }
            }
        }
    }

    private fun serve(client: LocalSocket) {
        // Only this app's own processes may talk to it: the peer must run as our uid.
        if (client.peerCredentials.uid != android.os.Process.myUid()) { client.close(); return }
        client.use { sock ->
            val reader = BufferedReader(InputStreamReader(sock.inputStream, Charsets.UTF_8))
            val writer = OutputStreamWriter(sock.outputStream, Charsets.UTF_8)
            writers.add(writer)
            try { while (true) {
                val line = reader.readLine() ?: break
                if (line.isBlank()) continue
                val reply = JSONObject()
                try {
                    val msg = JSONObject(line)
                    reply.put("id", msg.opt("id"))
                    val result = handler(msg.optString("method"), msg.optJSONObject("params") ?: JSONObject())
                    reply.put("result", result ?: JSONObject.NULL)
                } catch (e: Exception) {
                    reply.put("error", e.message ?: "The phone could not do that.")
                }
                synchronized(writer) { writer.write(reply.toString()); writer.write("\n"); writer.flush() }
            } } finally { writers.remove(writer) }
        }
    }

    // WHY (background notifications, 2026-11-01): the phone must tell the backend when the app comes on or off screen
    // (host-bridge.ts onHostEvent), so "done" clears only when the person actually looks. One JSON line, no id.
    private val writers = java.util.concurrent.CopyOnWriteArrayList<OutputStreamWriter>()
    fun emit(event: String, params: JSONObject) {
        val line = JSONObject().put("event", event).put("params", params).toString()
        for (w in writers) runCatching { synchronized(w) { w.write(line); w.write("\n"); w.flush() } }
    }

    fun close() {
        closed = true
        runCatching { server?.close() }
    }

    companion object { private const val TAG = "HostSocketServer" }
}
