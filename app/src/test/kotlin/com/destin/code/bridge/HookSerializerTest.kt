package com.destin.code.bridge

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/**
 * Tests for HookSerializer.
 *
 * New format:
 *   {
 *     type: "hook:event",
 *     payload: {
 *       type: "PermissionRequest" | "PermissionExpired" | "Notification",
 *       sessionId: "...",
 *       payload: { ... snake_case fields ... }
 *     }
 *   }
 */
class HookSerializerTest {

    // ── permissionRequest ────────────────────────────────────────────────────

    @Test
    fun `permissionRequest outer type is hook-event`() {
        val result = HookSerializer.permissionRequest("s", "r", "Bash", JSONObject(), emptyList())
        assertEquals("hook:event", result.getString("type"))
    }

    @Test
    fun `permissionRequest inner payload type is PermissionRequest`() {
        val result = HookSerializer.permissionRequest("s", "r", "Bash", JSONObject(), emptyList())
        val payload = result.getJSONObject("payload")
        assertEquals("PermissionRequest", payload.getString("type"))
    }

    @Test
    fun `permissionRequest payload has no hook_event_name`() {
        val result = HookSerializer.permissionRequest("s", "r", "Bash", JSONObject(), emptyList())
        val payload = result.getJSONObject("payload")
        assertFalse("Should not have 'hook_event_name'", payload.has("hook_event_name"))
    }

    @Test
    fun `permissionRequest outer payload contains sessionId`() {
        val result = HookSerializer.permissionRequest(
            "sess-1", "req-42", "Read", JSONObject().put("file_path", "/tmp/x"), listOf("allow", "deny")
        )
        val payload = result.getJSONObject("payload")
        assertEquals("sess-1", payload.getString("sessionId"))
    }

    @Test
    fun `permissionRequest inner payload uses snake_case fields`() {
        val input = JSONObject().put("file_path", "/tmp/x")
        val result = HookSerializer.permissionRequest(
            "sess-1", "req-42", "Read", input, listOf("allow", "deny")
        )
        val inner = result.getJSONObject("payload").getJSONObject("payload")
        assertEquals("Read", inner.getString("tool_name"))
        assertEquals("/tmp/x", inner.getJSONObject("tool_input").getString("file_path"))
        assertEquals("req-42", inner.getString("_requestId"))
    }

    @Test
    fun `permissionRequest inner payload does not have camelCase toolName`() {
        val result = HookSerializer.permissionRequest("s", "r", "Bash", JSONObject(), emptyList())
        val inner = result.getJSONObject("payload").getJSONObject("payload")
        assertFalse("Should not have 'toolName'", inner.has("toolName"))
        assertFalse("Should not have 'requestId'", inner.has("requestId"))
    }

    @Test
    fun `permissionRequest suggestions in inner payload`() {
        val result = HookSerializer.permissionRequest(
            "s", "r", "T", JSONObject(), listOf("allow", "deny", "ask")
        )
        val inner = result.getJSONObject("payload").getJSONObject("payload")
        val suggestions = inner.getJSONArray("permission_suggestions")
        assertEquals(3, suggestions.length())
        assertEquals("allow", suggestions.getString(0))
        assertEquals("deny", suggestions.getString(1))
        assertEquals("ask", suggestions.getString(2))
    }

    @Test
    fun `permissionRequest with empty suggestions list produces empty JSONArray`() {
        val result = HookSerializer.permissionRequest("s", "r", "T", JSONObject(), emptyList())
        val inner = result.getJSONObject("payload").getJSONObject("payload")
        val suggestions = inner.getJSONArray("permission_suggestions")
        assertEquals(0, suggestions.length())
    }

    @Test
    fun `permissionRequest toolInput is JSONObject in inner payload`() {
        val input = JSONObject().put("nested", JSONObject().put("k", "v"))
        val result = HookSerializer.permissionRequest("s", "r", "T", input, emptyList())
        val toolInput = result.getJSONObject("payload").getJSONObject("payload").getJSONObject("tool_input")
        assertEquals("v", toolInput.getJSONObject("nested").getString("k"))
    }

    // ── permissionExpired ────────────────────────────────────────────────────

    @Test
    fun `permissionExpired outer type is hook-event`() {
        val result = HookSerializer.permissionExpired("s", "r")
        assertEquals("hook:event", result.getString("type"))
    }

    @Test
    fun `permissionExpired inner payload type is PermissionExpired`() {
        val result = HookSerializer.permissionExpired("s", "r")
        assertEquals("PermissionExpired", result.getJSONObject("payload").getString("type"))
    }

    @Test
    fun `permissionExpired payload has no hook_event_name`() {
        val result = HookSerializer.permissionExpired("s", "r")
        assertFalse(result.getJSONObject("payload").has("hook_event_name"))
    }

    @Test
    fun `permissionExpired outer payload contains sessionId`() {
        val result = HookSerializer.permissionExpired("sess-exp", "req-exp")
        assertEquals("sess-exp", result.getJSONObject("payload").getString("sessionId"))
    }

    @Test
    fun `permissionExpired inner payload contains _requestId`() {
        val result = HookSerializer.permissionExpired("sess-exp", "req-exp")
        val inner = result.getJSONObject("payload").getJSONObject("payload")
        assertEquals("req-exp", inner.getString("_requestId"))
    }

    @Test
    fun `permissionExpired inner payload does not have requestId (camelCase)`() {
        val result = HookSerializer.permissionExpired("s", "r")
        val inner = result.getJSONObject("payload").getJSONObject("payload")
        assertFalse("Should not have 'requestId'", inner.has("requestId"))
    }

    // ── notification ─────────────────────────────────────────────────────────

    @Test
    fun `notification outer type is hook-event`() {
        val result = HookSerializer.notification("s", "msg")
        assertEquals("hook:event", result.getString("type"))
    }

    @Test
    fun `notification inner payload type is Notification`() {
        val result = HookSerializer.notification("s", "msg")
        assertEquals("Notification", result.getJSONObject("payload").getString("type"))
    }

    @Test
    fun `notification payload has no hook_event_name`() {
        val result = HookSerializer.notification("s", "msg")
        assertFalse(result.getJSONObject("payload").has("hook_event_name"))
    }

    @Test
    fun `notification outer payload contains sessionId`() {
        val result = HookSerializer.notification("sess-notif", "Tool completed successfully")
        assertEquals("sess-notif", result.getJSONObject("payload").getString("sessionId"))
    }

    @Test
    fun `notification inner payload contains message`() {
        val result = HookSerializer.notification("sess-notif", "Tool completed successfully")
        val inner = result.getJSONObject("payload").getJSONObject("payload")
        assertEquals("Tool completed successfully", inner.getString("message"))
    }

    @Test
    fun `notification with empty message`() {
        val result = HookSerializer.notification("s", "")
        val inner = result.getJSONObject("payload").getJSONObject("payload")
        assertEquals("", inner.getString("message"))
    }

    // ── top-level structure ──────────────────────────────────────────────────

    @Test
    fun `all hook methods return JSONObject with type and payload`() {
        val cases = listOf(
            HookSerializer.permissionRequest("s", "r", "T", JSONObject(), emptyList()),
            HookSerializer.permissionExpired("s", "r"),
            HookSerializer.notification("s", "m"),
        )
        for (obj in cases) {
            assertTrue("Missing 'type': $obj", obj.has("type"))
            assertTrue("Missing 'payload': $obj", obj.has("payload"))
        }
    }

    @Test
    fun `all hook methods emit type hook-event`() {
        val cases = listOf(
            HookSerializer.permissionRequest("s", "r", "T", JSONObject(), emptyList()),
            HookSerializer.permissionExpired("s", "r"),
            HookSerializer.notification("s", "m"),
        )
        for (obj in cases) {
            assertEquals("hook:event", obj.getString("type"))
        }
    }

    @Test
    fun `all hook inner payloads have type field (not hook_event_name)`() {
        val cases = listOf(
            HookSerializer.permissionRequest("s", "r", "T", JSONObject(), emptyList()),
            HookSerializer.permissionExpired("s", "r"),
            HookSerializer.notification("s", "m"),
        )
        for (obj in cases) {
            val payload = obj.getJSONObject("payload")
            assertTrue("Missing 'type' in payload: $payload", payload.has("type"))
            assertFalse("Should not have 'hook_event_name': $payload", payload.has("hook_event_name"))
        }
    }

    @Test
    fun `all hook inner payloads have sessionId`() {
        val cases = listOf(
            HookSerializer.permissionRequest("sess-x", "r", "T", JSONObject(), emptyList()),
            HookSerializer.permissionExpired("sess-x", "r"),
            HookSerializer.notification("sess-x", "m"),
        )
        for (obj in cases) {
            val payload = obj.getJSONObject("payload")
            assertEquals("sess-x", payload.getString("sessionId"))
        }
    }

    @Test
    fun `all hook inner payloads have nested payload object`() {
        val cases = listOf(
            HookSerializer.permissionRequest("s", "r", "T", JSONObject(), emptyList()),
            HookSerializer.permissionExpired("s", "r"),
            HookSerializer.notification("s", "m"),
        )
        for (obj in cases) {
            val payload = obj.getJSONObject("payload")
            assertTrue("Missing 'payload' in inner payload: $payload", payload.has("payload"))
            assertNotNull(payload.getJSONObject("payload"))
        }
    }

    @Test
    fun `empty strings are preserved in hook payloads`() {
        val result = HookSerializer.permissionExpired("", "")
        val payload = result.getJSONObject("payload")
        assertEquals("", payload.getString("sessionId"))
        val inner = payload.getJSONObject("payload")
        assertEquals("", inner.getString("_requestId"))
    }
}
