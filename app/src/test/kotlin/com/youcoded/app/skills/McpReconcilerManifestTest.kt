package com.youcoded.app.skills

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Mirror of desktop tests/mcp-reconciler.test.ts → "plugin manifest scan".
 * Two published marketplace manifests (spotify-services, youcoded-messaging —
 * entries copied verbatim) used `${PACKAGE_DIR}`, which nothing expanded, and
 * a `platforms` list, which nothing read. Pure: never touches a real
 * ~/.claude.json (applyManifestEntries only mutates the object passed in).
 */
class McpReconcilerManifestTest {
    private val reconciler = McpReconciler(File("/nonexistent-home"))
    private val root = "/data/home/.claude/plugins/marketplaces/youcoded/plugins/p"

    private val spotify = JSONObject(
        """{"name":"spotify-services","auto":true,"platforms":["darwin","win32"],"command":"bash",
           "args":["${'$'}{PACKAGE_DIR}/mcp-servers/spotify-services/launcher.sh"],"env":{}}"""
    )
    private val gmessages = JSONObject(
        """{"name":"gmessages","auto":true,"platforms":["darwin","linux","win32"],
           "command":"${'$'}{PACKAGE_DIR}/mcp-servers/gmessages/gmessages","args":[],"env":{}}"""
    )

    private fun manifests(vararg e: JSONObject) = listOf(JSONArray(e.toList()) to root)

    @Test
    fun `PACKAGE_DIR expands to the plugin directory`() {
        val servers = JSONObject()
        val r = reconciler.applyManifestEntries(servers, manifests(gmessages))
        assertEquals(1, r.added)
        assertEquals("$root/mcp-servers/gmessages/gmessages", servers.getJSONObject("gmessages").getString("command"))
    }

    @Test
    fun `a platforms list in Node names is honoured on Android (linux)`() {
        val servers = JSONObject()
        val r = reconciler.applyManifestEntries(servers, manifests(spotify))
        assertEquals(0, r.added)
        assertEquals(1, r.skippedPlatform)
        assertFalse(servers.has("spotify-services"))
    }

    @Test
    fun `single platform field still works`() {
        assertTrue(McpReconciler.platformMatches(JSONObject("""{"platform":"linux"}"""), "linux"))
        assertFalse(McpReconciler.platformMatches(JSONObject("""{"platform":"macos"}"""), "linux"))
        assertTrue(McpReconciler.platformMatches(JSONObject("{}"), "linux"))
        assertTrue(McpReconciler.platformMatches(JSONObject("""{"platforms":[],"platform":"linux"}"""), "linux"))
    }

    @Test
    fun `an untouched entry written with the literal placeholder is repaired`() {
        val servers = JSONObject().put(
            "gmessages",
            JSONObject("""{"type":"stdio","command":"${'$'}{PACKAGE_DIR}/mcp-servers/gmessages/gmessages","args":[],"env":{}}"""),
        )
        val r = reconciler.applyManifestEntries(servers, manifests(gmessages))
        assertEquals(1, r.repaired)
        assertTrue(r.changed)
        assertEquals("$root/mcp-servers/gmessages/gmessages", servers.getJSONObject("gmessages").getString("command"))
    }

    @Test
    fun `an entry the user changed is never overwritten`() {
        val custom = """{"type":"stdio","command":"${'$'}{PACKAGE_DIR}/mcp-servers/gmessages/gmessages","args":["--verbose"],"env":{}}"""
        val servers = JSONObject().put("gmessages", JSONObject(custom))
        val r = reconciler.applyManifestEntries(servers, manifests(gmessages))
        assertEquals(0, r.repaired)
        assertFalse(r.changed)
        assertEquals(JSONArray("""["--verbose"]""").toString(), servers.getJSONObject("gmessages").getJSONArray("args").toString())
    }
}
