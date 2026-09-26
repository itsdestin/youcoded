package com.youcoded.app.parser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Review B1: pins EventBridge's call into HookOwnerGate (admit() is the
 * first half of handleClient, testable without a LocalSocket).
 */
class EventBridgeAdmitTest {
    private fun line(event: String, session: String, pid: String) =
        """{"hook_event_name":"$event","session_id":"$session","mobileSessionId":"m1","claudePid":"$pid"}"""

    @Test
    fun `a nested claude cannot remap the session or reach the event stream`() {
        val bridge = EventBridge("test-socket-name")
        assertNull(bridge.admit(line("SessionStart", "real", "1000")))       // claims; consumed
        assertEquals("real", bridge.getClaudeSessionId("m1"))
        assertNull(bridge.admit(line("SessionStart", "nested", "2000")))     // refused
        assertNull(bridge.admit(line("PermissionRequest", "nested", "2000")))
        assertEquals("real", bridge.getClaudeSessionId("m1"))                // map untouched
        assertNotNull(bridge.admit(line("PostToolUse", "real", "1000")))
    }

    @Test
    fun `order A - the real SessionStart was lost, a nested one is refused`() {
        val bridge = EventBridge("test-socket-name")
        assertNotNull(bridge.admit(line("PostToolUse", "real", "1000")))
        assertNull(bridge.admit(line("SessionStart", "nested", "2000")))
        assertEquals("real", bridge.getClaudeSessionId("m1"))
        assertNotNull(bridge.admit(line("PostToolUse", "real", "1000")))
        assertNull(bridge.admit(line("PostToolUse", "nested", "2000")))
    }

    // Review F1 (2026-09-24): the session counts as STARTED only when Claude Code
    // runs a hook — never because the screen showed something. Startup dialogs
    // (trust, bypass, the multi-server MCP checkbox list) come before any hook.
    @Test
    fun `the session is not started by anything but an admitted hook`() {
        val bridge = EventBridge("test-socket-name")
        assertEquals(false, bridge.sessionStarted.value)
        assertNotNull(bridge.admit(line("PostToolUse", "real", "1000"))) // SessionStart lost: still counts
        assertEquals(true, bridge.sessionStarted.value)
    }

    @Test
    fun `SessionStart starts the session, a refused nested one does not`() {
        val a = EventBridge("test-socket-name")
        assertNull(a.admit(line("SessionStart", "real", "1000")))
        assertEquals(true, a.sessionStarted.value)

        // A nested `claude` whose hooks are REFUSED never starts a session: the
        // real process sent a tool hook first (so it owns the session), then the
        // nested one's SessionStart and tool hook are refused — on a bridge whose
        // started flag we reset to observe them alone.
        val b = EventBridge("test-socket-name")
        assertNotNull(b.admit(line("PostToolUse", "real", "1000")))  // real process: owner
        b.resetStartedForTest()
        assertNull(b.admit(line("SessionStart", "nested", "2000")))   // refused
        assertNull(b.admit(line("PermissionRequest", "nested", "2000"))) // refused
        assertEquals(false, b.sessionStarted.value)

        val c = EventBridge("test-socket-name")
        assertNull(c.admit("not json"))
        assertEquals(false, c.sessionStarted.value)
    }

    @Test
    fun `ManagedSession no longer treats screen output as started`() {
        // Source pin (cross-language: the rule it guards is React's init gate).
        val src = java.io.File("src/main/kotlin/com/youcoded/app/runtime/ManagedSession.kt").readText()
        kotlin.test.assertFalse(src.contains("screen.isNotBlank()"), "readiness must not come from screen output")
        kotlin.test.assertTrue(src.contains("sessionStarted.first { it }"))
    }
}
