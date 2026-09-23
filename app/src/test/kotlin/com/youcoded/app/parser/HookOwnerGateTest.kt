package com.youcoded.app.parser

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirror of desktop tests/hook-relay.test.ts → HookOwnerGate. */
class HookOwnerGateTest {
    @Test
    fun `the first process owns the session and another pid is refused`() {
        val g = HookOwnerGate()
        assertTrue(g.accept("mobile-1", "1000"))
        assertTrue(g.accept("mobile-1", "1000"))
        assertFalse(g.accept("mobile-1", "2000"))
        assertTrue(g.accept("mobile-2", "2000"))
    }

    @Test
    fun `fails open with no pid or no session`() {
        val g = HookOwnerGate()
        assertTrue(g.accept("mobile-1", "1000"))
        assertTrue(g.accept("mobile-1", ""))
        assertTrue(g.accept("", "2000"))
    }
}
