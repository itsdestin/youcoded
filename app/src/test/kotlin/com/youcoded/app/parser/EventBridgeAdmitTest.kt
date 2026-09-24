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
}
