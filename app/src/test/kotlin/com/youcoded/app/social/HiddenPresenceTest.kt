package com.youcoded.app.social

import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

// Incognito's hidden presence connection must never expose the user to an older server
// (PresenceClient.kt HIDDEN MODE): connect hidden only after the server promises it, and only stay
// connected if the first frame confirms it.
class HiddenPresenceTest {
    private lateinit var server: MockWebServer

    @Before fun start() { server = MockWebServer(); server.start() }
    @After fun stop() { server.shutdown() }

    private fun probe(): HiddenPresence.Support {
        val latch = CountDownLatch(1)
        var answer = HiddenPresence.Support.YES
        HiddenPresence.probe(OkHttpClient(), server.url("/social/presence/capabilities").toString()) { answer = it; latch.countDown() }
        assertTrue(latch.await(5, TimeUnit.SECONDS))
        return answer
    }

    @Test fun `a server that supports hidden mode says yes`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"hidden":true}"""))
        assertEquals(HiddenPresence.Support.YES, probe())
    }

    @Test fun `an older server (404) is a no, so the device never connects hidden`() {
        server.enqueue(MockResponse().setResponseCode(404).setBody("not found"))
        assertEquals(HiddenPresence.Support.NO, probe())
    }

    @Test fun `an answer without hidden true is a no`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"hidden":false}"""))
        assertEquals(HiddenPresence.Support.NO, probe())
    }

    // Final review F4: a check that could not be made is not "the server can't" — it is retried.
    @Test fun `a server error, a rate limit or an unreadable answer is unknown, never yes`() {
        server.enqueue(MockResponse().setResponseCode(503).setBody("down"))
        assertEquals(HiddenPresence.Support.UNKNOWN, probe())
        server.enqueue(MockResponse().setResponseCode(429).setBody("slow down"))
        assertEquals(HiddenPresence.Support.UNKNOWN, probe())
        server.enqueue(MockResponse().setResponseCode(200).setBody("garbage"))
        assertEquals(HiddenPresence.Support.UNKNOWN, probe())
    }

    @Test fun `no network at all is unknown`() {
        val url = server.url("/social/presence/capabilities").toString()
        server.shutdown()
        val latch = CountDownLatch(1)
        var answer = HiddenPresence.Support.YES
        HiddenPresence.probe(OkHttpClient(), url) { answer = it; latch.countDown() }
        assertTrue(latch.await(10, TimeUnit.SECONDS))
        assertEquals(HiddenPresence.Support.UNKNOWN, answer)
        server = MockWebServer().also { it.start() } // @After shuts this one down
    }

    @Test fun `the re-check backoff grows and then repeats its last step`() {
        assertEquals(5_000L, HiddenPresence.retryDelay(0))
        assertEquals(15_000L, HiddenPresence.retryDelay(1))
        assertEquals(60_000L, HiddenPresence.retryDelay(3))
        assertEquals(60_000L, HiddenPresence.retryDelay(40))
    }

    @Test fun `only the hello frame confirms hidden mode`() {
        assertTrue(HiddenPresence.confirmsHidden("""{"type":"hello","hidden":true}"""))
        // An older server sends the snapshot first: that is NOT a confirmation — disconnect.
        assertFalse(HiddenPresence.confirmsHidden("""{"type":"presence","users":[]}"""))
        assertFalse(HiddenPresence.confirmsHidden("""{"type":"hello","hidden":false}"""))
        assertFalse(HiddenPresence.confirmsHidden("not json"))
    }

    @Test fun `a hidden device never sends a status change or a challenge`() {
        assertTrue(HiddenPresence.blockedWhileHidden(JSONObject().put("type", "status")))
        assertTrue(HiddenPresence.blockedWhileHidden(JSONObject().put("type", "challenge")))
        assertTrue(HiddenPresence.blockedWhileHidden(JSONObject().put("type", "challenge-response")))
        assertFalse(HiddenPresence.blockedWhileHidden(JSONObject().put("type", "ping")))
        assertFalse(HiddenPresence.blockedWhileHidden(JSONObject().put("type", "game-result")))
    }

    @Test fun `hidden mode is asked for in the connection address`() {
        assertEquals("wss://api.youcoded.ai/social/presence?hidden=1", HiddenPresence.url(true))
        assertEquals("wss://api.youcoded.ai/social/presence", HiddenPresence.url(false))
    }
}
