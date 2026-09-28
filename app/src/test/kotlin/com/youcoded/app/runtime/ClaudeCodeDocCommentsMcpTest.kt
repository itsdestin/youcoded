package com.youcoded.app.runtime

import com.youcoded.app.doccomments.DocCommentsMcpNames
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * The Android half of attaching YouCoded's document-comment tools (T9c) to a
 * Claude Code session — mirrors ClaudeCodeMcpTest.kt's own shape for the
 * SendUserLink precedent this task was scoped against.
 */
class ClaudeCodeDocCommentsMcpTest {

    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun `config runs the server through linker64, not bare node, with the per-session env`() {
        val json = JSONObject(
            ClaudeCodeDocCommentsMcp.configJson(
                "/system/bin/linker64", "/data/usr/bin/node", "/data/x/doc-comments-mcp.js",
                "youcoded-doc-comments-deadbeef", "/sdcard/project", "secret-token",
            ),
        )
        val server = json.getJSONObject("mcpServers").getJSONObject("youcoded-doc-comments-deadbeef")
        assertEquals("stdio", server.getString("type"))
        assertEquals("/system/bin/linker64", server.getString("command"))
        assertEquals("/data/usr/bin/node", server.getJSONArray("args").getString(0))
        assertEquals("/data/x/doc-comments-mcp.js", server.getJSONArray("args").getString(1))
        val env = server.getJSONObject("env")
        assertEquals("/sdcard/project", env.getString(ClaudeCodeDocCommentsMcp.PROJECT_ROOT_ENV))
        assertEquals("secret-token", env.getString(ClaudeCodeDocCommentsMcp.TOKEN_ENV))
    }

    @Test
    fun `deploy writes both files and returns only the read tool as allowed`() {
        val dir = File(tmp.root, ".claude-mobile")
        val deployment = ClaudeCodeDocCommentsMcp.deploy(
            dir, "// server source\n", "/system/bin/linker64", "/data/usr/bin/node",
            "/sdcard/project", "mobile-session-1",
        )
        assertNotNull(deployment)
        deployment!!

        val serverFile = File(deployment.configPath).parentFile!!.resolve(ClaudeCodeDocCommentsMcp.SERVER_FILE)
        assertTrue(serverFile.exists())
        assertEquals("// server source\n", serverFile.readText())
        assertTrue(File(deployment.configPath).exists())

        assertEquals(listOf(DocCommentsMcpNames.readTool(deployment.serverId)), deployment.allowedTools)
        // Never one of the five mutation tools — see this object's own header.
        for (mutator in DocCommentsMcpNames.mutatorTools(deployment.serverId)) {
            assertTrue(mutator !in deployment.allowedTools)
        }
    }

    @Test
    fun `two deployments for two sessions get different server ids and tokens, and land in different directories`() {
        val dir = File(tmp.root, ".claude-mobile")
        val a = ClaudeCodeDocCommentsMcp.deploy(dir, "// src\n", "/system/bin/linker64", "/node", "/proj", "session-A")!!
        val b = ClaudeCodeDocCommentsMcp.deploy(dir, "// src\n", "/system/bin/linker64", "/node", "/proj", "session-B")!!
        assertNotEquals(a.serverId, b.serverId)
        assertNotEquals(a.token, b.token)
        assertNotEquals(a.configPath, b.configPath)
    }

    @Test
    fun `redeploy for the SAME session refreshes the server in place`() {
        val dir = File(tmp.root, ".claude-mobile")
        val first = ClaudeCodeDocCommentsMcp.deploy(dir, "// old\n", "/system/bin/linker64", "/node", "/proj", "session-1")!!
        ClaudeCodeDocCommentsMcp.deploy(dir, "// new\n", "/system/bin/linker64", "/node", "/proj", "session-1")
        val serverFile = File(first.configPath).parentFile!!.resolve(ClaudeCodeDocCommentsMcp.SERVER_FILE)
        assertEquals("// new\n", serverFile.readText())
    }
}
