package com.youcoded.app.analytics

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertFalse
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

    private fun newService() = AnalyticsService(
        apiBase = server.url("/").toString().trimEnd('/'),
        homeDir = homeDir,
        appVersion = "1.2.1",
    )

    @Test
    fun `first launch generates UUID, posts install + heartbeat, saves state`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        val svc = newService()
        svc.runOnLaunch()

        val reqs = listOf(server.takeRequest().path, server.takeRequest().path)
        assertTrue(reqs.contains("/app/install"))
        assertTrue(reqs.contains("/app/heartbeat"))
        val state = svc.debugReadState()
        assertTrue(state.installId.matches(Regex("^[0-9a-f-]{36}$")))
        assertTrue(state.installReported)
        assertEquals(AnalyticsService.todayUtc(), state.lastPingedDate)
    }

    @Test
    fun `opt-out short-circuits`() {
        val stateFile = File(homeDir, ".claude/youcoded-analytics.json")
        stateFile.parentFile!!.mkdirs()
        stateFile.writeText("""{"installId":"c4b2a8f0-0000-4000-8000-000000000000","optIn":false,"lastPingedDate":"","installReported":false}""")
        val svc = newService()
        svc.runOnLaunch()
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `same-day relaunch does nothing`() {
        val stateFile = File(homeDir, ".claude/youcoded-analytics.json")
        stateFile.parentFile!!.mkdirs()
        stateFile.writeText(
            """{"installId":"c4b2a8f0-0000-4000-8000-000000000000","optIn":true,"lastPingedDate":"${AnalyticsService.todayUtc()}","installReported":true}"""
        )
        val svc = newService()
        svc.runOnLaunch()
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `network failure does not mutate state`() {
        server.enqueue(MockResponse().setResponseCode(500))
        val svc = newService()
        svc.runOnLaunch()
        val state = svc.debugReadState()
        assertFalse(state.installReported)
        assertEquals("", state.lastPingedDate)
    }
}
