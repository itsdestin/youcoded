package com.youcoded.app.runtime

import com.youcoded.app.doccomments.DocCommentsMcpNames
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermission

/**
 * The Android half of attaching YouCoded's document-comment tools (T9c) to a
 * Claude Code session — mirrors ClaudeCodeMcpTest.kt's own shape for the
 * SendUserLink precedent this task was scoped against. Also pins the T9c/T20
 * adversarial review's findings #1 (owner-only permissions), #2 (no fixed
 * fallback directory) and #3 (leftover-deploy sweep).
 */
class ClaudeCodeDocCommentsMcpTest {

    @get:Rule
    val tmp = TemporaryFolder()

    @After
    fun tearDown() {
        // Never let one test's sweep-triggering leak into another's
        // expectations about which call swept what.
        ClaudeCodeDocCommentsMcp.resetSweepForTest()
    }

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
            dir, "// server source\n", "/system/bin/linker64", "/data/usr/bin/node", "/sdcard/project",
        )
        assertNotNull(deployment)
        deployment!!

        val serverFile = File(deployment.configPath).parentFile!!.resolve(ClaudeCodeDocCommentsMcp.SERVER_FILE)
        assertTrue(serverFile.exists())
        assertEquals("// server source\n", serverFile.readText())
        assertTrue(File(deployment.configPath).exists())
        assertEquals(File(deployment.configPath).parentFile!!.absolutePath, deployment.deployDir)

        assertEquals(listOf(DocCommentsMcpNames.readTool(deployment.serverId)), deployment.allowedTools)
        // Never one of the five mutation tools — see this object's own header.
        for (mutator in DocCommentsMcpNames.mutatorTools(deployment.serverId)) {
            assertTrue(mutator !in deployment.allowedTools)
        }
    }

    @Test
    fun `two deployments from the same call site get different server ids, tokens and directories`() {
        val dir = File(tmp.root, ".claude-mobile")
        val a = ClaudeCodeDocCommentsMcp.deploy(dir, "// src\n", "/system/bin/linker64", "/node", "/proj")!!
        val b = ClaudeCodeDocCommentsMcp.deploy(dir, "// src\n", "/system/bin/linker64", "/node", "/proj")!!
        assertNotEquals(a.serverId, b.serverId)
        assertNotEquals(a.token, b.token)
        assertNotEquals(a.configPath, b.configPath)
        assertNotEquals(a.deployDir, b.deployDir)
        // Both directories genuinely exist side by side — a second deploy
        // never overwrites or displaces the first's still-live directory.
        assertTrue(File(a.deployDir).exists())
        assertTrue(File(b.deployDir).exists())
    }

    @Test
    fun `no fixed fallback directory exists to reintroduce a collision (finding #2)`() {
        // deploy() takes no session-id-shaped parameter at all any more — the
        // ONLY thing that can name a deployment's directory is the serverId
        // this function mints internally, which is always fresh. Confirmed
        // structurally: ten deployments to the same baseDir land in ten
        // distinct, simultaneously-existing directories, never a shared one.
        val dir = File(tmp.root, ".claude-mobile")
        val deployments = (1..10).map {
            ClaudeCodeDocCommentsMcp.deploy(dir, "// src\n", "/system/bin/linker64", "/node", "/proj")!!
        }
        assertEquals(10, deployments.map { it.deployDir }.toSet().size)
        for (d in deployments) assertTrue(File(d.deployDir).exists())
    }

    @Test
    fun `the deploy directory and config file are owner-only, finding #1 cheap hardening`() {
        val dir = File(tmp.root, ".claude-mobile")
        val deployment = ClaudeCodeDocCommentsMcp.deploy(dir, "// src\n", "/system/bin/linker64", "/node", "/proj")!!

        val dirPerms = Files.getPosixFilePermissions(File(deployment.deployDir).toPath())
        val configPerms = Files.getPosixFilePermissions(File(deployment.configPath).toPath())

        val ownerOnly = setOf(
            PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE,
        )
        val groupOrOther = PosixFilePermission.entries.filter { it !in setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE) }

        assertTrue("deploy dir must not be readable/writable/executable by group or other, got $dirPerms", groupOrOther.none { it in dirPerms })
        assertTrue("config file must not be readable/writable/executable by group or other, got $configPerms", groupOrOther.none { it in configPerms })
        // And the owner itself can still read/write both, obviously.
        assertTrue(PosixFilePermission.OWNER_READ in dirPerms && PosixFilePermission.OWNER_WRITE in dirPerms)
        assertTrue(PosixFilePermission.OWNER_READ in configPerms && PosixFilePermission.OWNER_WRITE in configPerms)
        assertFalse(ownerOnly.isEmpty()) // sanity: the constant above is non-trivial
    }

    @Test
    fun `a leftover directory from a previous process run is swept on the first deploy of a fresh process`() {
        val dir = File(tmp.root, ".claude-mobile")
        // Simulate litter left behind by a crashed/killed earlier process —
        // never cleaned up because PtyBridge.stop() never ran for it.
        val leftover = File(dir, "claude-code-doc-comments-mcp/youcoded-doc-comments-oldstale")
        leftover.mkdirs()
        File(leftover, "mcp-config.json").writeText("""{"mcpServers":{}}""")
        assertTrue(leftover.exists())

        ClaudeCodeDocCommentsMcp.resetSweepForTest() // pretend this is a fresh process
        val deployment = ClaudeCodeDocCommentsMcp.deploy(dir, "// src\n", "/system/bin/linker64", "/node", "/proj")!!

        assertFalse("a leftover directory from a previous process must be swept", leftover.exists())
        // The CURRENT deployment's own directory survives the same sweep.
        assertTrue(File(deployment.deployDir).exists())
    }

    @Test
    fun `the sweep never touches a sibling deployment still live in the SAME process`() {
        val dir = File(tmp.root, ".claude-mobile")
        ClaudeCodeDocCommentsMcp.resetSweepForTest()
        val first = ClaudeCodeDocCommentsMcp.deploy(dir, "// src\n", "/system/bin/linker64", "/node", "/proj")!!
        // A second deploy in the SAME process must never re-sweep (the flag
        // is now set) — it must not delete the first deployment's directory.
        val second = ClaudeCodeDocCommentsMcp.deploy(dir, "// src\n", "/system/bin/linker64", "/node", "/proj")!!
        assertTrue(File(first.deployDir).exists())
        assertTrue(File(second.deployDir).exists())
    }
}
