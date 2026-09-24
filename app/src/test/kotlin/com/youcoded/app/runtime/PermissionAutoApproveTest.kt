package com.youcoded.app.runtime

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Which Claude Code permission asks Android answers "allow" without a card.
// Mirrors desktop/tests/permission-auto-approve.test.ts case for case.
class PermissionAutoApproveTest {
    private val none = JSONObject()
    private val allOn = JSONObject().put("approveAll", true)
    private fun input(vararg kv: Pair<String, Any>) = JSONObject().apply { kv.forEach { (k, v) -> put(k, v) } }

    @Test
    fun `never auto-allows a plan approval or a question, even with approve-all on`() {
        // WHY: Claude Code ignores a hook allow for these, so an allow only hid the
        // card while the menu was still waiting in the terminal (2026-09-24).
        assertFalse(shouldAutoApprove("ExitPlanMode", input("plan" to "x"), allOn))
        assertFalse(shouldAutoApprove("AskUserQuestion", input("questions" to "[]"), allOn))
    }

    @Test
    fun `the never-allow list is exactly the desktop one`() {
        assertEquals(setOf("AskUserQuestion", "ExitPlanMode"), NEEDS_THE_USERS_OWN_ANSWER)
    }

    @Test
    fun `approve-all still covers ordinary tools`() {
        assertTrue(shouldAutoApprove("Bash", input("command" to "ls"), allOn))
        assertTrue(shouldAutoApprove("Write", input("file_path" to "/tmp/x"), allOn))
    }

    @Test
    fun `with nothing enabled only the title hook is auto-allowed`() {
        assertTrue(shouldAutoApprove("Bash", input("command" to "echo t > ~/.claude/topics/topic-1"), none))
        assertFalse(shouldAutoApprove("Bash", input("command" to "ls"), none))
    }

    @Test
    fun `a per-category override allows only its category`() {
        val git = JSONObject().put("compoundCdGit", true)
        assertTrue(shouldAutoApprove("Bash", input("command" to "cd repo && git status"), git))
        assertFalse(shouldAutoApprove("Write", input("file_path" to "/home/u/.bashrc"), git))
    }
}
