package com.youcoded.app.parser

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * WHY (combined branch): integrations' admit() (nested-process gate plus the
 * SessionStart early stop) and plan-approval's route() (foreign-ask
 * pass-through) were built on separate branches and meet only here, in
 * handleClient's order: admit, then route, then the hold. This walks the same
 * sequence on one bridge without a LocalSocket.
 */
class EventBridgeAdmitThenRouteTest {
    private fun line(event: String, mobile: String, pid: String) =
        """{"hook_event_name":"$event","session_id":"cc","mobileSessionId":"$mobile","claudePid":"$pid"}"""

    /** handleClient's first two steps; null = the socket is closed with no reply. */
    private fun decide(bridge: EventBridge, raw: String): EventBridge.Companion.Route? {
        val json: JSONObject = bridge.admit(raw) ?: return null
        return EventBridge.route(json.optString("hook_event_name", ""), json.optString("mobileSessionId", ""), "mine")
    }

    @Test
    fun `nested ask ignored, unowned ask passed through, owned ask held`() {
        val bridge = EventBridge("test-socket-name", "mine")
        assertNull(decide(bridge, line("SessionStart", "mine", "1000")))            // claims the owner, then stops
        assertNull(decide(bridge, line("PermissionRequest", "mine", "2000")))       // nested claude: ignored
        assertEquals(EventBridge.Companion.Route.PASS_THROUGH, decide(bridge, line("PermissionRequest", "other", "3000")))
        assertEquals(EventBridge.Companion.Route.HOLD_FOR_CARD, decide(bridge, line("PermissionRequest", "mine", "1000")))
        assertEquals(EventBridge.Companion.Route.FIRE_AND_FORGET, decide(bridge, line("PostToolUse", "mine", "1000")))
    }
}
