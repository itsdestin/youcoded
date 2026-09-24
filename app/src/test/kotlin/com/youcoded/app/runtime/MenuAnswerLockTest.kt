package com.youcoded.app.runtime

import org.junit.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MenuAnswerLockTest {
    @Test
    fun `a second device is refused while the first answers, and admitted after`() {
        var t = 0L
        val lock = MenuAnswerLock { t }
        assertTrue(lock.handle("s", "desktop", "acquire"))
        assertFalse(lock.handle("s", "phone", "acquire"))
        assertTrue(lock.handle("other-session", "phone", "acquire"))
        lock.handle("s", "phone", "release") // not the holder: no effect
        assertFalse(lock.handle("s", "phone", "acquire"))
        lock.handle("s", "desktop", "release")
        assertTrue(lock.handle("s", "phone", "acquire"))
    }

    @Test
    fun `a holder that vanished loses the lock when its lease runs out`() {
        var t = 0L
        val lock = MenuAnswerLock { t }
        assertTrue(lock.acquire("s", "desktop"))
        t = MenuAnswerLock.LEASE_MS + 1
        assertTrue(lock.acquire("s", "phone"))
    }
}
