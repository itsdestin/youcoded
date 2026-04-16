package com.youcoded.app.parser

import org.junit.Assert.*
import org.junit.Test

class HookEventTest {

    @Test
    fun `parses PreToolUse event`() {
        val json = """
            {
                "session_id": "sess-1",
                "hook_event_name": "PreToolUse",
                "tool_name": "Bash",
                "tool_input": {"command": "ls"},
                "tool_use_id": "tu-123"
            }
        """.trimIndent()

        val event = HookEvent.fromJson(json)
        assertNotNull(event)
        assertTrue(event is HookEvent.PreToolUse)
        val pre = event as HookEvent.PreToolUse
        assertEquals("sess-1", pre.sessionId)
        assertEquals("Bash", pre.toolName)
        assertEquals("tu-123", pre.toolUseId)
        assertEquals("ls", pre.toolInput.getString("command"))
    }

    @Test
    fun `parses PostToolUse event`() {
        val json = """
            {
                "session_id": "sess-2",
                "hook_event_name": "PostToolUse",
                "tool_name": "Read",
                "tool_input": {"file_path": "/tmp/test.kt"},
                "tool_response": {"content": "hello"},
                "tool_use_id": "tu-456"
            }
        """.trimIndent()

        val event = HookEvent.fromJson(json)
        assertTrue(event is HookEvent.PostToolUse)
        val post = event as HookEvent.PostToolUse
        assertEquals("Read", post.toolName)
        assertEquals("hello", post.toolResponse.getString("content"))
    }

    @Test
    fun `parses Stop event with last_assistant_message`() {
        val json = """
            {
                "session_id": "sess-3",
                "hook_event_name": "Stop",
                "last_assistant_message": "Done!"
            }
        """.trimIndent()

        val event = HookEvent.fromJson(json)
        assertTrue(event is HookEvent.Stop)
        assertEquals("Done!", (event as HookEvent.Stop).lastAssistantMessage)
    }

    @Test
    fun `parses Stop event with fallback field names`() {
        val json = """
            {
                "session_id": "sess-3",
                "hook_event_name": "Stop",
                "message": "Fallback message"
            }
        """.trimIndent()

        val event = HookEvent.fromJson(json)
        assertTrue(event is HookEvent.Stop)
        assertEquals("Fallback message", (event as HookEvent.Stop).lastAssistantMessage)
    }

    @Test
    fun `parses Notification event`() {
        val json = """
            {
                "session_id": "sess-4",
                "hook_event_name": "Notification",
                "message": "Tool completed",
                "title": "Bash",
                "notification_type": "tool_complete"
            }
        """.trimIndent()

        val event = HookEvent.fromJson(json)
        assertTrue(event is HookEvent.Notification)
        val notif = event as HookEvent.Notification
        assertEquals("Tool completed", notif.message)
        assertEquals("Bash", notif.title)
        assertEquals("tool_complete", notif.notificationType)
    }

    @Test
    fun `parses Notification without optional fields`() {
        val json = """
            {
                "session_id": "sess-5",
                "hook_event_name": "Notification",
                "message": "Something happened"
            }
        """.trimIndent()

        val event = HookEvent.fromJson(json)
        assertTrue(event is HookEvent.Notification)
        val notif = event as HookEvent.Notification
        assertNull(notif.title)
        assertNull(notif.notificationType)
    }

    @Test
    fun `parses PermissionRequest event`() {
        val json = """
            {
                "session_id": "sess-6",
                "hook_event_name": "PermissionRequest",
                "tool_name": "Bash",
                "tool_input": {"command": "rm -rf /"},
                "_requestId": "req-789"
            }
        """.trimIndent()

        val event = HookEvent.fromJson(json)
        assertTrue(event is HookEvent.PermissionRequest)
        val perm = event as HookEvent.PermissionRequest
        assertEquals("Bash", perm.toolName)
        assertEquals("req-789", perm.requestId)
        assertNull(perm.permissionSuggestions)
    }

    @Test
    fun `returns null for unknown event type`() {
        val json = """
            {
                "session_id": "sess-7",
                "hook_event_name": "SomeNewEvent"
            }
        """.trimIndent()

        assertNull(HookEvent.fromJson(json))
    }

    @Test
    fun `returns null for invalid JSON`() {
        assertNull(HookEvent.fromJson("not json at all"))
    }

    @Test
    fun `returns null for empty string`() {
        assertNull(HookEvent.fromJson(""))
    }

    @Test
    fun `handles missing fields gracefully`() {
        val json = """
            {
                "hook_event_name": "PreToolUse"
            }
        """.trimIndent()

        val event = HookEvent.fromJson(json)
        assertNotNull(event)
        val pre = event as HookEvent.PreToolUse
        assertEquals("", pre.sessionId)
        assertEquals("", pre.toolName)
        assertEquals("", pre.toolUseId)
    }
}
