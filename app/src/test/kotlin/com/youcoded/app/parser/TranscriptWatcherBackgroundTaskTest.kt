package com.youcoded.app.parser

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Android mirror of desktop tests/cc-background-tasks.test.ts (2026-09-24): Claude Code's
 * background launch receipts and their <task-notification> end notices.
 */
class TranscriptWatcherBackgroundTaskTest {
    private fun notice(body: String) = "<task-notification>\n$body\n</task-notification>"

    @Test
    fun `an Agent receipt and a background Bash receipt carry their task ids`() {
        val agent = JSONObject().put("toolUseResult", JSONObject().put("status", "async_launched").put("agentId", "a3ecf"))
        val bash = JSONObject().put("toolUseResult", JSONObject().put("backgroundTaskId", "bt1"))
        assertEquals("a3ecf", TranscriptWatcher.backgroundLaunchId(agent))
        assertEquals("bt1", TranscriptWatcher.backgroundLaunchId(bash))
        assertNull(TranscriptWatcher.backgroundLaunchId(JSONObject().put("toolUseResult", JSONObject().put("stdout", "ok"))))
    }

    @Test
    fun `a completed notice carries tool id, status, summary and report`() {
        val raw = notice("<task-id>a3ecf</task-id>\n<tool-use-id>toolu_A</tool-use-id>\n<status>completed</status>\n<summary>Agent \"X\" finished</summary>\n<result>Done <b>ok</b></result>")
        val ev = TranscriptWatcher.taskNotifications(raw, "s", "n1", 0L).single()
        assertEquals("toolu_A", ev.toolUseId)
        assertEquals(listOf("a3ecf"), ev.taskIds)
        assertEquals("completed", ev.status)
        assertEquals("Agent \"X\" finished", ev.summary)
        assertEquals("Done <b>ok</b>", ev.result)
    }

    @Test
    fun `killed reads stopped and scan markers are dropped`() {
        val ev = TranscriptWatcher.taskNotifications(
            notice("<task-id>b1</task-id>\n<task-id>__orphan_summary__:shell</task-id>\n<status>killed</status>"), "s", "n1", 0L,
        ).single()
        assertEquals("stopped", ev.status)
        assertEquals(listOf("b1"), ev.taskIds)
    }

    @Test
    fun `a Monitor event changes nothing and a queued notice is recognised`() {
        assertTrue(TranscriptWatcher.taskNotifications(notice("<task-id>m</task-id>\n<event>x</event>"), "s", "n1", 0L).isEmpty())
        val line = JSONObject().put("type", "attachment").put("attachment",
            JSONObject().put("type", "queued_command").put("commandMode", "task-notification").put("prompt", "<task-notification/>"))
        assertEquals("<task-notification/>", TranscriptWatcher.queuedTaskNotificationText(line))
    }
}
