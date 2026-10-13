// Drives the real PresenceClient against a local server (final review F3, F4, F29). The state machine
// runs on a queue this test drains by hand, so OkHttp's thread and "the looper" interleave the way a
// busy phone makes them: frames arrive BEFORE the looper has run the work the socket's open posted.
package com.youcoded.app.social

import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private class ManualPoster : PresencePoster {
    val queue = ConcurrentLinkedQueue<() -> Unit>()
    val delayed = ConcurrentLinkedQueue<Pair<Long, () -> Unit>>()
    override fun post(r: () -> Unit) { queue.add(r) }
    override fun postDelayed(r: () -> Unit, delayMs: Long) { delayed.add(delayMs to r) }
    fun drain() { while (true) { val r = queue.poll() ?: return; r() } }
    /** Runs the delayed work whose delay matches (the re-check timer), not the 30 s ping loop. */
    fun runDelayed(delayMs: Long) {
        val due = delayed.filter { it.first == delayMs }
        delayed.removeAll(due.toSet())
        due.forEach { it.second() }
    }
}

class PresenceClientHiddenTest {
    private lateinit var server: MockWebServer
    @Volatile private var capabilities = MockResponse().setResponseCode(200).setBody("""{"hidden":true}""")
    @Volatile private var serverSocket: WebSocket? = null
    @Volatile private var upgrades = 0
    private val events = CopyOnWriteArrayList<JSONObject>()
    private val poster = ManualPoster()
    private lateinit var client: PresenceClient

    @Before fun start() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                if (request.path!!.startsWith("/cap")) capabilities
                else {
                    upgrades++
                    MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                        override fun onOpen(webSocket: WebSocket, response: Response) {
                            serverSocket = webSocket
                            // The server's first frames, sent before the phone's looper gets a turn.
                            webSocket.send("""{"type":"hello","hidden":true}""")
                            webSocket.send("""{"type":"presence","users":[{"id":"jake"}]}""")
                        }
                        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
                    })
                }
        }
        server.start()
        client = PresenceClient(
            getToken = { "tok" },
            onEvent = { events.add(it) },
            handler = poster,
            presenceUrl = server.url("/presence").toString().replaceFirst("http", "ws"),
            capabilitiesUrl = server.url("/cap").toString(),
        )
    }
    @After fun stop() {
        client.setDesired(false); poster.drain()
        // The server end closes too, so its socket queue is empty when the server shuts down.
        serverSocket?.close(1000, null)
        server.shutdown()
    }

    private fun types() = events.map { it.optString("type") }
    private fun waitFor(what: String, cond: () -> Boolean) {
        val until = System.currentTimeMillis() + 5_000
        while (!cond()) {
            if (System.currentTimeMillis() > until) throw AssertionError("timed out waiting for $what; events=${types()}")
            Thread.sleep(10)
        }
    }

    @Test fun `a busy looper never turns a confirmed hidden connection into a disconnect`() {
        client.setDesired(true, hiddenMode = true)
        poster.drain()                                   // runs setDesired → starts the capability check
        waitFor("the capability answer") { poster.queue.isNotEmpty() }
        poster.drain()                                   // check said yes → connect()
        waitFor("the friends snapshot") { "presence" in types() }
        // Only now does the looper run what the socket's open posted — after the hello was handled.
        poster.drain()
        assertTrue(client.isConnected())
        serverSocket!!.send("""{"type":"user-joined","user":{"id":"amy"}}""")
        waitFor("the next frame") { "user-joined" in types() || poster.queue.isNotEmpty() }
        poster.drain()
        assertTrue("user-joined" in types(), "events=${types()}")
        assertFalse("hidden-unsupported" in types(), "events=${types()}")
        assertTrue(client.isConnected())
    }

    @Test fun `a check that cannot be made stays disconnected, says so, and connects once a re-check says yes`() {
        capabilities = MockResponse().setResponseCode(503).setBody("down")
        client.setDesired(true, hiddenMode = true)
        poster.drain()
        waitFor("the capability answer") { poster.queue.isNotEmpty() }
        poster.drain()
        assertEquals(listOf("hidden-check-failed"), types())
        assertEquals(0, upgrades)
        capabilities = MockResponse().setResponseCode(200).setBody("""{"hidden":true}""")
        poster.runDelayed(HiddenPresence.retryDelay(0))
        waitFor("the re-check answer") { poster.queue.isNotEmpty() }
        poster.drain()
        waitFor("the hidden connection") { "presence" in types() }
        assertEquals(1, upgrades)
    }

    @Test fun `an older server is final - no connection and no re-check`() {
        capabilities = MockResponse().setResponseCode(404).setBody("not found")
        client.setDesired(true, hiddenMode = true)
        poster.drain()
        waitFor("the capability answer") { poster.queue.isNotEmpty() }
        poster.drain()
        assertEquals(listOf("hidden-unsupported"), types())
        assertTrue(poster.delayed.isEmpty())
        assertEquals(0, upgrades)
    }

    @Test fun `a check answered after a disconnect connects nothing`() {
        client.setDesired(true, hiddenMode = true)
        poster.drain()
        client.setDesired(false)
        poster.drain()
        waitFor("the capability answer") { poster.queue.isNotEmpty() }
        poster.drain()
        Thread.sleep(100)
        assertEquals(0, upgrades)
    }

    @Test fun `a hidden device reports a status change as not sent`() {
        client.setDesired(true, hiddenMode = true)
        poster.drain()
        assertFalse(client.send(JSONObject().put("type", "status").put("status", "in-game")))
        assertTrue(client.send(JSONObject().put("type", "game-result")))
    }
}
