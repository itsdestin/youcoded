package com.youcoded.app.analytics

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AnalyticsServiceTest {
    private lateinit var server: MockWebServer
    private lateinit var homeDir: File

    @Before
    fun setUp() {
        server = MockWebServer().apply { start() }
        homeDir = Files.createTempDirectory("analytics-test").toFile()
    }

    @After
    fun tearDown() {
        server.shutdown()
        homeDir.deleteRecursively()
    }

    private fun newService(machineId: String = "test-machine-id-stable") = AnalyticsService(
        apiBase = server.url("/").toString().trimEnd('/'),
        homeDir = homeDir,
        appVersion = "1.3.0",
        machineIdReader = { machineId },
    )

    private fun stateFile() = File(homeDir, ".claude/youcoded-analytics.json")

    @Test
    fun `first launch posts ONE heartbeat with deviceIdHash`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        val svc = newService()
        svc.runOnLaunch()

        assertEquals(1, server.requestCount)
        val req = server.takeRequest()
        assertEquals("/app/heartbeat", req.path)
        val body = JSONObject(req.body.readUtf8())
        assertTrue(body.getString("deviceIdHash").matches(Regex("^[a-f0-9]{64}$")))
        assertFalse(body.has("installId"))
        assertEquals("android", body.getString("platform"))
        assertEquals("1.3.0", body.getString("appVersion"))

        val state = svc.debugReadState()
        assertEquals(AnalyticsService.todayUtc(), state.lastPingedDate)
        assertNull(state.fallbackDeviceId)
    }

    @Test
    fun `no longer posts to app install`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        val svc = newService()
        svc.runOnLaunch()
        // Only one request — nothing went to /app/install.
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `same-day relaunch does nothing`() {
        stateFile().parentFile!!.mkdirs()
        stateFile().writeText(
            """{"optIn":true,"lastPingedDate":"${AnalyticsService.todayUtc()}"}"""
        )
        val svc = newService()
        svc.runOnLaunch()
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `opt-out short-circuits`() {
        stateFile().parentFile!!.mkdirs()
        stateFile().writeText("""{"optIn":false,"lastPingedDate":""}""")
        val svc = newService()
        svc.runOnLaunch()
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `network failure does not advance lastPingedDate`() {
        server.enqueue(MockResponse().setResponseCode(500))
        val svc = newService()
        svc.runOnLaunch()
        val state = svc.debugReadState()
        assertEquals("", state.lastPingedDate)
    }

    @Test
    fun `machine_id read failure persists fallbackDeviceId`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        val svc = newService(machineId = "")  // empty -> triggers fallback
        svc.runOnLaunch()
        val state = svc.debugReadState()
        assertTrue(state.fallbackDeviceId!!.matches(Regex("^[0-9a-f-]{36}$")))
        val body = JSONObject(server.takeRequest().body.readUtf8())
        assertTrue(body.getString("deviceIdHash").matches(Regex("^[a-f0-9]{64}$")))
    }

    @Test
    fun `legacy installId in state file is silently dropped`() {
        stateFile().parentFile!!.mkdirs()
        stateFile().writeText(
            """{"installId":"c4b2a8f0-0000-4000-8000-000000000000","installReported":true,"optIn":true,"lastPingedDate":"1970-01-01"}"""
        )
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        val svc = newService()
        svc.runOnLaunch()
        val state = svc.debugReadState()
        assertEquals(AnalyticsService.todayUtc(), state.lastPingedDate)
        // The state file no longer contains installId/installReported after this run.
        val rewritten = JSONObject(stateFile().readText())
        assertFalse(rewritten.has("installId"))
        assertFalse(rewritten.has("installReported"))
    }

    @Test
    fun `hash is stable across runs`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        val svc1 = newService()
        svc1.runOnLaunch()
        val firstHash = JSONObject(server.takeRequest().body.readUtf8()).getString("deviceIdHash")

        // Reset state to force a re-send tomorrow.
        stateFile().writeText("""{"optIn":true,"lastPingedDate":""}""")
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        val svc2 = newService()
        svc2.runOnLaunch()
        val secondHash = JSONObject(server.takeRequest().body.readUtf8()).getString("deviceIdHash")

        assertEquals(firstHash, secondHash)
    }

    // Same fixtures as desktop's analytics-service.test.ts msUntilNextCheck cases.
    @Test
    fun `next check lands just after UTC midnight when under 3h away`() {
        val now = java.time.Instant.parse("2026-09-16T23:00:00Z").toEpochMilli()
        assertEquals(60L * 60 * 1000 + 1000, AnalyticsService.msUntilNextCheck(now))
    }

    @Test
    fun `next check never waits longer than 3 hours`() {
        val now = java.time.Instant.parse("2026-09-16T01:00:00Z").toEpochMilli()
        assertEquals(3L * 60 * 60 * 1000, AnalyticsService.msUntilNextCheck(now))
    }

    @Test
    fun `hash parity with desktop`() {
        // Fixture: hashing "parity-fixture-id|android" with ANALYTICS_SALT must
        // produce this exact value on Android. The desktop parity test pins the
        // same value (computed once via Node's crypto.createHmac and committed
        // verbatim). If this assertion breaks, salt drifted between platforms;
        // update Salt.kt + analytics-salt.ts together.
        val mac = javax.crypto.Mac.getInstance("HmacSHA256")
        mac.init(javax.crypto.spec.SecretKeySpec(ANALYTICS_SALT.toByteArray(), "HmacSHA256"))
        val digest = mac.doFinal("parity-fixture-id|android".toByteArray())
        val actual = digest.joinToString("") { "%02x".format(it) }
        val expected = "5ce87197c2b6e0762a0d8f5e8f0fe2f8034538758fef2887614dea513f8eb141"
        assertEquals(expected, actual)
    }
}
