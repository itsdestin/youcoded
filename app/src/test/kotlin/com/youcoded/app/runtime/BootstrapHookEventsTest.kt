package com.youcoded.app.runtime

import android.content.Context
import android.content.res.AssetManager
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Test
import org.mockito.ArgumentMatchers.anyString
import org.mockito.Mockito.mock
import org.mockito.Mockito.`when`
import java.io.ByteArrayInputStream
import java.io.File
import kotlin.io.path.createTempDirectory

/**
 * Review B1 (2026-09-23): EventBridge's HookOwnerGate only works if Claude
 * Code actually sends SessionStart to the relay. Runs the real installHooks()
 * against a temp home (mocked assets) and checks settings.json — never the
 * device's real files.
 */
class BootstrapHookEventsTest {
    private val filesDir = createTempDirectory(prefix = "youcoded-bootstrap-").toFile()

    @After fun tearDown() { filesDir.deleteRecursively() }

    @Test
    fun `installHooks registers SessionStart on the fire-and-forget relay`() {
        val assets = mock(AssetManager::class.java)
        `when`(assets.open(anyString())).thenAnswer { ByteArrayInputStream("// stub\n".toByteArray()) }
        val context = mock(Context::class.java)
        `when`(context.filesDir).thenReturn(filesDir)
        `when`(context.assets).thenReturn(assets)

        Bootstrap(context).installHooks()

        val settings = JSONObject(File(filesDir, "home/.claude/settings.json").readText())
        val entries = settings.getJSONObject("hooks").getJSONArray("SessionStart")
        val commands = (0 until entries.length()).flatMap { i ->
            val hooks = entries.getJSONObject(i).getJSONArray("hooks")
            (0 until hooks.length()).map { hooks.getJSONObject(it).getString("command") }
        }
        assertTrue("SessionStart must run hook-relay.js, got $commands", commands.any { it.endsWith("hook-relay.js") })
    }
}
