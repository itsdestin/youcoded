package com.youcoded.app.parser

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirror of desktop tests/hook-relay.test.ts → HookOwnerGate. */
class HookOwnerGateTest {
    @Test
    fun `the first SessionStart owns the session and another pid is refused`() {
        val g = HookOwnerGate()
        assertTrue(g.accept("mobile-1", "1000", true))
        assertTrue(g.accept("mobile-1", "1000", false))
        assertFalse(g.accept("mobile-1", "2000", false))
        assertFalse(g.accept("mobile-1", "2000", true))
        assertTrue(g.accept("mobile-2", "2000", true))
    }

    // Review F2: a nested claude reporting before any SessionStart must not
    // become the owner and lock the real session out.
    @Test
    fun `a non-SessionStart hook arriving first does not claim`() {
        val g = HookOwnerGate()
        assertTrue(g.accept("mobile-1", "2000", false))
        assertTrue(g.accept("mobile-1", "1000", true))
        assertTrue(g.accept("mobile-1", "1000", false))
        assertFalse(g.accept("mobile-1", "2000", false))
    }

    @Test
    fun `fails open with no pid or no session`() {
        val g = HookOwnerGate()
        assertTrue(g.accept("mobile-1", "1000", true))
        assertTrue(g.accept("mobile-1", "", false))
        assertTrue(g.accept("", "2000", false))
    }
}
