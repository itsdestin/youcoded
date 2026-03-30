package com.destin.code.bridge

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/**
 * Tests for TranscriptSerializer.
 *
 * New format: each method returns the inner payload directly:
 *   { type, sessionId, uuid, timestamp, data: { ... } }
 *
 * The outer `{ type: "transcript:event", payload: ... }` wrapper is added
 * by ManagedSession's broadcast call, not by the serializer.
 *
 * Exception: streamingText is a custom event and stays flat (no data wrapper).
 */
class TranscriptSerializerTest {

    // ── userMessage ──────────────────────────────────────────────────────────

    @Test
    fun `userMessage has correct type`() {
        val result = TranscriptSerializer.userMessage("s1", "u1", 1000L, "Hello")
        assertEquals("user-message", result.getString("type"))
    }

    @Test
    fun `userMessage has top-level sessionId uuid timestamp`() {
        val result = TranscriptSerializer.userMessage("sess-abc", "uuid-123", 9999L, "Hi there")
        assertEquals("sess-abc", result.getString("sessionId"))
        assertEquals("uuid-123", result.getString("uuid"))
        assertEquals(9999L, result.getLong("timestamp"))
    }

    @Test
    fun `userMessage text is nested inside data`() {
        val result = TranscriptSerializer.userMessage("sess-abc", "uuid-123", 9999L, "Hi there")
        val data = result.getJSONObject("data")
        assertEquals("Hi there", data.getString("text"))
    }

    @Test
    fun `userMessage has no direct payload wrapper`() {
        val result = TranscriptSerializer.userMessage("s", "u", 0L, "msg")
        assertFalse("Should not have a 'payload' key", result.has("payload"))
    }

    @Test
    fun `userMessage data has no extra fields beyond text`() {
        val result = TranscriptSerializer.userMessage("s", "u", 0L, "msg")
        val data = result.getJSONObject("data")
        assertTrue(data.has("text"))
        assertEquals(1, data.length())
    }

    // ── assistantText ────────────────────────────────────────────────────────

    @Test
    fun `assistantText has correct type`() {
        val result = TranscriptSerializer.assistantText("s1", "u1", 1000L, "Response")
        assertEquals("assistant-text", result.getString("type"))
    }

    @Test
    fun `assistantText has top-level sessionId uuid timestamp`() {
        val result = TranscriptSerializer.assistantText("sess-x", "uuid-y", 12345L, "Some text")
        assertEquals("sess-x", result.getString("sessionId"))
        assertEquals("uuid-y", result.getString("uuid"))
        assertEquals(12345L, result.getLong("timestamp"))
    }

    @Test
    fun `assistantText text is nested inside data`() {
        val result = TranscriptSerializer.assistantText("sess-x", "uuid-y", 12345L, "Some text")
        assertEquals("Some text", result.getJSONObject("data").getString("text"))
    }

    // ── toolUse ──────────────────────────────────────────────────────────────

    @Test
    fun `toolUse has correct type`() {
        val input = JSONObject().put("command", "ls")
        val result = TranscriptSerializer.toolUse("s", "u", 0L, "tu-1", "Bash", input)
        assertEquals("tool-use", result.getString("type"))
    }

    @Test
    fun `toolUse has top-level sessionId uuid timestamp`() {
        val input = JSONObject().put("file_path", "/tmp/test.kt")
        val result = TranscriptSerializer.toolUse(
            "sess-1", "uuid-2", 55000L, "tool-use-id-3", "Read", input
        )
        assertEquals("sess-1", result.getString("sessionId"))
        assertEquals("uuid-2", result.getString("uuid"))
        assertEquals(55000L, result.getLong("timestamp"))
    }

    @Test
    fun `toolUse tool fields are nested inside data`() {
        val input = JSONObject().put("file_path", "/tmp/test.kt")
        val result = TranscriptSerializer.toolUse(
            "sess-1", "uuid-2", 55000L, "tool-use-id-3", "Read", input
        )
        val data = result.getJSONObject("data")
        assertEquals("tool-use-id-3", data.getString("toolUseId"))
        assertEquals("Read", data.getString("toolName"))
        assertEquals("/tmp/test.kt", data.getJSONObject("toolInput").getString("file_path"))
    }

    @Test
    fun `toolUse toolInput is a JSONObject inside data`() {
        val input = JSONObject().put("key", "value")
        val result = TranscriptSerializer.toolUse("s", "u", 0L, "tu", "Tool", input)
        val data = result.getJSONObject("data")
        assertNotNull(data.getJSONObject("toolInput"))
        assertEquals("value", data.getJSONObject("toolInput").getString("key"))
    }

    // ── toolResult ───────────────────────────────────────────────────────────

    @Test
    fun `toolResult has correct type`() {
        val result = TranscriptSerializer.toolResult("s", "u", 0L, "tu-1", "output", false)
        assertEquals("tool-result", result.getString("type"))
    }

    @Test
    fun `toolResult has top-level sessionId uuid timestamp`() {
        val result = TranscriptSerializer.toolResult(
            "sess-1", "uuid-2", 77000L, "tu-id-9", "The result text", false
        )
        assertEquals("sess-1", result.getString("sessionId"))
        assertEquals("uuid-2", result.getString("uuid"))
        assertEquals(77000L, result.getLong("timestamp"))
    }

    @Test
    fun `toolResult fields are nested inside data with toolResult key`() {
        val result = TranscriptSerializer.toolResult(
            "sess-1", "uuid-2", 77000L, "tu-id-9", "The result text", false
        )
        val data = result.getJSONObject("data")
        assertEquals("tu-id-9", data.getString("toolUseId"))
        // field is named toolResult (not result)
        assertEquals("The result text", data.getString("toolResult"))
        assertFalse(data.getBoolean("isError"))
    }

    @Test
    fun `toolResult uses toolResult key not result`() {
        val result = TranscriptSerializer.toolResult("s", "u", 0L, "tu", "output", false)
        val data = result.getJSONObject("data")
        assertTrue("Should have 'toolResult' key", data.has("toolResult"))
        assertFalse("Should NOT have 'result' key", data.has("result"))
    }

    @Test
    fun `toolResult isError true propagates correctly`() {
        val result = TranscriptSerializer.toolResult("s", "u", 0L, "tu", "err msg", true)
        val data = result.getJSONObject("data")
        assertTrue(data.getBoolean("isError"))
        assertEquals("err msg", data.getString("toolResult"))
    }

    @Test
    fun `toolResult isError false propagates correctly`() {
        val result = TranscriptSerializer.toolResult("s", "u", 0L, "tu", "ok", false)
        assertFalse(result.getJSONObject("data").getBoolean("isError"))
    }

    // ── turnComplete ─────────────────────────────────────────────────────────

    @Test
    fun `turnComplete has correct type`() {
        val result = TranscriptSerializer.turnComplete("s", "u", 0L)
        assertEquals("turn-complete", result.getString("type"))
    }

    @Test
    fun `turnComplete has top-level sessionId uuid timestamp`() {
        val result = TranscriptSerializer.turnComplete("sess-z", "uuid-z", 999L)
        assertEquals("sess-z", result.getString("sessionId"))
        assertEquals("uuid-z", result.getString("uuid"))
        assertEquals(999L, result.getLong("timestamp"))
    }

    @Test
    fun `turnComplete data is empty object`() {
        val result = TranscriptSerializer.turnComplete("s", "u", 0L)
        val data = result.getJSONObject("data")
        assertEquals(0, data.length())
    }

    // ── streamingText ────────────────────────────────────────────────────────

    @Test
    fun `streamingText has correct type`() {
        val result = TranscriptSerializer.streamingText("s", "partial text")
        assertEquals("streaming-text", result.getString("type"))
    }

    @Test
    fun `streamingText contains sessionId and text at top level`() {
        val result = TranscriptSerializer.streamingText("sess-stream", "partial response...")
        assertEquals("sess-stream", result.getString("sessionId"))
        assertEquals("partial response...", result.getString("text"))
    }

    @Test
    fun `streamingText has no data wrapper`() {
        val result = TranscriptSerializer.streamingText("s", "t")
        assertFalse("streamingText should not have 'data' key", result.has("data"))
    }

    // ── top-level structure ──────────────────────────────────────────────────

    @Test
    fun `non-streaming methods return JSONObject with type sessionId uuid timestamp data`() {
        val input = JSONObject()
        val cases = listOf(
            TranscriptSerializer.userMessage("s", "u", 0L, "t"),
            TranscriptSerializer.assistantText("s", "u", 0L, "t"),
            TranscriptSerializer.toolUse("s", "u", 0L, "ti", "T", input),
            TranscriptSerializer.toolResult("s", "u", 0L, "ti", "r", false),
            TranscriptSerializer.turnComplete("s", "u", 0L),
        )
        for (obj in cases) {
            assertTrue("Missing 'type': $obj", obj.has("type"))
            assertTrue("Missing 'sessionId': $obj", obj.has("sessionId"))
            assertTrue("Missing 'uuid': $obj", obj.has("uuid"))
            assertTrue("Missing 'timestamp': $obj", obj.has("timestamp"))
            assertTrue("Missing 'data': $obj", obj.has("data"))
            assertFalse("Should not have 'payload': $obj", obj.has("payload"))
        }
    }

    @Test
    fun `empty strings are preserved`() {
        val result = TranscriptSerializer.userMessage("", "", 0L, "")
        assertEquals("", result.getString("sessionId"))
        assertEquals("", result.getString("uuid"))
        assertEquals("", result.getJSONObject("data").getString("text"))
    }

    @Test
    fun `large timestamp values are preserved`() {
        val ts = Long.MAX_VALUE
        val result = TranscriptSerializer.assistantText("s", "u", ts, "t")
        assertEquals(ts, result.getLong("timestamp"))
    }
}
