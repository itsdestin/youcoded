package com.youcoded.app.parser

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The Android mirror of the desktop's 2026-09-11 order fix (desktop tests/transcript-watcher.test.ts):
 * a message typed while Claude is working is recorded only as a queued_command attachment, and a
 * slash command only inside command tags. Both used to be dropped.
 */
class TranscriptWatcherLineTest {
    private fun queued(prompt: String, commandMode: String, origin: JSONObject?) = JSONObject().apply {
        put("type", "attachment")
        put("uuid", "q1")
        put("attachment", JSONObject().apply {
            put("type", "queued_command")
            put("prompt", prompt)
            put("commandMode", commandMode)
            if (origin != null) put("origin", origin)
        })
    }

    @Test
    fun `a message typed while Claude is working is read`() {
        assertEquals("second", TranscriptWatcher.queuedPromptText(queued("second", "prompt", JSONObject().put("kind", "human"))))
    }

    @Test
    fun `a background task notice is not a typed message`() {
        assertNull(TranscriptWatcher.queuedPromptText(queued("<task-notification>x</task-notification>", "task-notification", null)))
    }

    @Test
    fun `a message another Claude Code session sent in stays hidden`() {
        assertEquals("", TranscriptWatcher.queuedPromptText(queued("Heads-up", "prompt", JSONObject().put("kind", "peer"))))
    }

    @Test
    fun `a slash command is read with its arguments`() {
        assertEquals(
            "/reload-plugins",
            TranscriptWatcher.slashCommandText("<command-name>/reload-plugins</command-name>\n<command-message>reload-plugins</command-message>\n<command-args></command-args>"),
        )
        assertEquals("/compact keep going", TranscriptWatcher.slashCommandText("<command-name>/compact</command-name><command-args>keep going</command-args>"))
    }

    @Test
    fun `ordinary lines are neither`() {
        assertNull(TranscriptWatcher.queuedPromptText(JSONObject().put("type", "user")))
        assertNull(TranscriptWatcher.slashCommandText("hello"))
    }
}
