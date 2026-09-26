package com.youcoded.app.runtime

import com.youcoded.app.bridge.MessageRouter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Test
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** A WebView that reloads while a session is on its startup dialogs must be
 *  told so (desktop SessionInfo.awaitingStart), not assume "already running". */
class SessionAwaitingStartTest {
    private fun session(shell: Boolean): ManagedSession {
        val dir = kotlin.io.path.createTempDirectory("await-start").toFile()
        return ManagedSession(
            cwd = dir, homeDir = dir, dangerousMode = false, shellMode = shell,
            titleFile = File(dir, "title"), scope = CoroutineScope(Dispatchers.Unconfined + SupervisorJob()),
        )
    }

    @Test
    fun `a Claude Code session with no hook yet is awaiting start, a shell never is`() {
        assertTrue(session(shell = false).awaitingStart)
        assertFalse(session(shell = true).awaitingStart)
    }

    @Test
    fun `session info carries awaitingStart only when true`() {
        val waiting = MessageRouter.buildSessionInfo("a", "n", "/", "active", "normal", false, awaitingStart = true)
        val running = MessageRouter.buildSessionInfo("b", "n", "/", "active", "normal", false)
        assertEquals(true, waiting.optBoolean("awaitingStart", false))
        assertFalse(running.has("awaitingStart"))
    }
}
