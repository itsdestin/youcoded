package com.destin.code.bridge

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MessageRouterTest {

    // ── parseMessage ──────────────────────────────────────────────────────────

    @Test
    fun `parseMessage extracts type from valid JSON`() {
        val raw = """{"type":"session:list","id":"req-1","payload":{}}"""
        val result = MessageRouter.parseMessage(raw)
        assertNotNull(result)
        assertEquals("session:list", result!!.type)
    }

    @Test
    fun `parseMessage extracts id from valid JSON`() {
        val raw = """{"type":"session:list","id":"req-1","payload":{}}"""
        val result = MessageRouter.parseMessage(raw)
        assertNotNull(result)
        assertEquals("req-1", result!!.id)
    }

    @Test
    fun `parseMessage extracts payload from valid JSON`() {
        val raw = """{"type":"session:create","id":"req-2","payload":{"name":"MySession"}}"""
        val result = MessageRouter.parseMessage(raw)
        assertNotNull(result)
        assertEquals("MySession", result!!.payload.getString("name"))
    }

    @Test
    fun `parseMessage handles fire-and-forget messages with no id field`() {
        val raw = """{"type":"ping","payload":{}}"""
        val result = MessageRouter.parseMessage(raw)
        assertNotNull(result)
        assertEquals("ping", result!!.type)
        assertNull(result.id)
    }

    @Test
    fun `parseMessage returns null for invalid JSON`() {
        val result = MessageRouter.parseMessage("not-json-at-all{{{")
        assertNull(result)
    }

    @Test
    fun `parseMessage returns null for empty string`() {
        val result = MessageRouter.parseMessage("")
        assertNull(result)
    }

    @Test
    fun `parseMessage handles auth messages`() {
        val raw = """{"type":"auth","id":"auth-1","payload":{"token":"abc123"}}"""
        val result = MessageRouter.parseMessage(raw)
        assertNotNull(result)
        assertEquals("auth", result!!.type)
        assertEquals("auth-1", result.id)
        assertEquals("abc123", result.payload.getString("token"))
    }

    @Test
    fun `parseMessage uses empty JSONObject when payload is absent`() {
        val raw = """{"type":"ping"}"""
        val result = MessageRouter.parseMessage(raw)
        assertNotNull(result)
        assertEquals(0, result!!.payload.length())
    }

    // ── buildAuthOkResponse ───────────────────────────────────────────────────

    @Test
    fun `buildAuthOkResponse includes type auth-ok`() {
        val result = MessageRouter.buildAuthOkResponse("android")
        assertEquals("auth:ok", result.getString("type"))
    }

    @Test
    fun `buildAuthOkResponse includes a token`() {
        val result = MessageRouter.buildAuthOkResponse("android")
        val token = result.getString("token")
        assertNotNull(token)
        assertTrue(token.isNotBlank())
    }

    @Test
    fun `buildAuthOkResponse includes the platform field`() {
        val result = MessageRouter.buildAuthOkResponse("android")
        assertEquals("android", result.getString("platform"))
    }

    @Test
    fun `buildAuthOkResponse reflects different platform values`() {
        val result = MessageRouter.buildAuthOkResponse("desktop")
        assertEquals("desktop", result.getString("platform"))
    }

    // ── buildSessionInfo ──────────────────────────────────────────────────────

    @Test
    fun `buildSessionInfo includes id field`() {
        val result = MessageRouter.buildSessionInfo(
            id = "sess-1", name = "Test", cwd = "/home",
            status = "active", permissionMode = "default", skipPermissions = false
        )
        assertEquals("sess-1", result.getString("id"))
    }

    @Test
    fun `buildSessionInfo includes name field`() {
        val result = MessageRouter.buildSessionInfo(
            id = "sess-1", name = "MySession", cwd = "/home",
            status = "active", permissionMode = "default", skipPermissions = false
        )
        assertEquals("MySession", result.getString("name"))
    }

    @Test
    fun `buildSessionInfo includes cwd field`() {
        val result = MessageRouter.buildSessionInfo(
            id = "sess-1", name = "Test", cwd = "/data/user/0",
            status = "active", permissionMode = "default", skipPermissions = false
        )
        assertEquals("/data/user/0", result.getString("cwd"))
    }

    @Test
    fun `buildSessionInfo includes status field`() {
        val result = MessageRouter.buildSessionInfo(
            id = "sess-1", name = "Test", cwd = "/home",
            status = "dead", permissionMode = "default", skipPermissions = false
        )
        assertEquals("dead", result.getString("status"))
    }

    @Test
    fun `buildSessionInfo includes permissionMode field`() {
        val result = MessageRouter.buildSessionInfo(
            id = "sess-1", name = "Test", cwd = "/home",
            status = "active", permissionMode = "bypassPermissions", skipPermissions = true
        )
        assertEquals("bypassPermissions", result.getString("permissionMode"))
    }

    @Test
    fun `buildSessionInfo includes skipPermissions field as true`() {
        val result = MessageRouter.buildSessionInfo(
            id = "sess-1", name = "Test", cwd = "/home",
            status = "active", permissionMode = "bypassPermissions", skipPermissions = true
        )
        assertTrue(result.getBoolean("skipPermissions"))
    }

    @Test
    fun `buildSessionInfo includes skipPermissions field as false`() {
        val result = MessageRouter.buildSessionInfo(
            id = "sess-1", name = "Test", cwd = "/home",
            status = "active", permissionMode = "default", skipPermissions = false
        )
        assertFalse(result.getBoolean("skipPermissions"))
    }

    @Test
    fun `buildSessionInfo includes createdAt field`() {
        val result = MessageRouter.buildSessionInfo(
            id = "sess-1", name = "Test", cwd = "/home",
            status = "active", permissionMode = "default", skipPermissions = false,
            createdAt = 123456789L
        )
        assertEquals(123456789L, result.getLong("createdAt"))
    }

    // ── buildSessionListResponse ──────────────────────────────────────────────

    @Test
    fun `buildSessionListResponse wraps sessions in a sessions JSONArray`() {
        val session1 = MessageRouter.buildSessionInfo(
            "s1", "First", "/home", "active", "default", false
        )
        val session2 = MessageRouter.buildSessionInfo(
            "s2", "Second", "/tmp", "dead", "default", false
        )
        val result = MessageRouter.buildSessionListResponse(listOf(session1, session2))
        val sessions = result.getJSONArray("sessions")
        assertEquals(2, sessions.length())
    }

    @Test
    fun `buildSessionListResponse preserves session data`() {
        val session = MessageRouter.buildSessionInfo(
            "s1", "Alpha", "/root", "active", "default", false
        )
        val result = MessageRouter.buildSessionListResponse(listOf(session))
        val first = result.getJSONArray("sessions").getJSONObject(0)
        assertEquals("s1", first.getString("id"))
        assertEquals("Alpha", first.getString("name"))
    }

    @Test
    fun `buildSessionListResponse handles empty list`() {
        val result = MessageRouter.buildSessionListResponse(emptyList())
        val sessions = result.getJSONArray("sessions")
        assertEquals(0, sessions.length())
    }

    // ── buildErrorResponse ────────────────────────────────────────────────────

    @Test
    fun `buildErrorResponse includes error field`() {
        val result = MessageRouter.buildErrorResponse("Something went wrong")
        assertEquals("Something went wrong", result.getString("error"))
    }

    @Test
    fun `buildErrorResponse reflects different error messages`() {
        val result = MessageRouter.buildErrorResponse("Session not found")
        assertEquals("Session not found", result.getString("error"))
    }
}
