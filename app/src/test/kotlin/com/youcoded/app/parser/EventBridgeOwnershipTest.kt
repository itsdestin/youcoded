package com.youcoded.app.parser

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** An ask for another session is handed back to Claude Code undecided; an ask
 *  for this session (or with no id — it came in on this session's own socket)
 *  is held for the card. */
class EventBridgeOwnershipTest {
    @Test
    fun `another session's ask is foreign`() {
        assertTrue(EventBridge.isForeignAsk("other", "mine"))
    }

    @Test
    fun `this session's ask is held`() {
        assertFalse(EventBridge.isForeignAsk("mine", "mine"))
    }

    @Test
    fun `an ask with no session id is this session's`() {
        assertFalse(EventBridge.isForeignAsk("", "mine"))
        assertFalse(EventBridge.isForeignAsk(null, "mine"))
    }

    @Test
    fun `a bridge that does not know its own id holds everything, as before`() {
        assertFalse(EventBridge.isForeignAsk("other", null))
    }
}
