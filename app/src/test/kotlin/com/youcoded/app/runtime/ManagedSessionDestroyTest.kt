package com.youcoded.app.runtime

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import org.junit.Test
import java.io.File
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Second review F10: a session destroyed before its first hook must not leave
 *  its collectors (e.g. "wait for sessionStarted") running forever. */
class ManagedSessionDestroyTest {
    @Test
    fun `destroy cancels everything the session's scope started`() {
        val scope = CoroutineScope(Dispatchers.Unconfined + SupervisorJob())
        val dir = kotlin.io.path.createTempDirectory("ms-destroy").toFile()
        val session = ManagedSession(
            cwd = dir, homeDir = dir, dangerousMode = false,
            titleFile = File(dir, "title"), scope = scope,
        )
        val waiting = scope.launch { awaitCancellation() } // stands in for sessionStarted.first { it }
        assertTrue(waiting.isActive)
        session.destroy()
        assertFalse(waiting.isActive)
        dir.deleteRecursively()
    }
}
