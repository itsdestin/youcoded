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

    // Review C2: the real SessionStart can be lost; its tool hooks arrive
    // first, and a nested SessionStart must not claim the session.
    @Test
    fun `order A - real tool hooks then a nested SessionStart claims the real pid`() {
        val g = HookOwnerGate()
        assertTrue(g.accept("mobile-1", "1000", false))
        assertFalse(g.accept("mobile-1", "2000", true))
        assertTrue(g.accept("mobile-1", "1000", false))
        assertFalse(g.accept("mobile-1", "2000", false))
    }

    @Test
    fun `order B - real SessionStart then a nested one keeps the real pid`() {
        val g = HookOwnerGate()
        assertTrue(g.accept("mobile-1", "1000", true))
        assertFalse(g.accept("mobile-1", "2000", true))
        assertTrue(g.accept("mobile-1", "1000", false))
    }

    @Test
    fun `fails open with no pid or no session`() {
        val g = HookOwnerGate()
        assertTrue(g.accept("mobile-1", "1000", true))
        assertTrue(g.accept("mobile-1", "", false))
        assertTrue(g.accept("", "2000", false))
    }
}
