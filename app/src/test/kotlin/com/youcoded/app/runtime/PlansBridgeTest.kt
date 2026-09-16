package com.youcoded.app.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Specialists plans (Task 6): the phone has no native runtime, so every plan
 * request is answered with a typed `unsupported` refusal. The shared React UI
 * reads that answer as a value (the shim resolves it for plan channels) and
 * disables the plan card's controls / hides Settings → Plans.
 */
class PlansBridgeTest {

    @Test
    fun `names exactly the seven plan request channels`() {
        assertEquals(
            setOf(
                "plans:approve", "plans:comment", "plans:add-budget", "plans:resume",
                "plans:stop", "plans:get-auto-approve", "plans:set-auto-approve",
            ),
            PlansBridge.CHANNELS,
        )
        // The push is outbound-only and never a request.
        assertFalse(PlansBridge.CHANNELS.contains("plans:event"))
    }

    @Test
    fun `answers ok false, unsupported true and a readable reason`() {
        val r = PlansBridge.unsupportedResponse()
        assertEquals(false, r.getBoolean("ok"))
        assertEquals(true, r.getBoolean("unsupported"))
        val error = r.getString("error")
        assertTrue(error.isNotBlank())
        // Shown on the card as-is, so no developer wording.
        assertFalse(error.contains("not-implemented"))
    }

    @Test
    fun `hands out a fresh object each time`() {
        // bridgeServer.respond wraps the payload; a shared instance could be
        // mutated by one reply and leak into the next.
        assertNotSame(PlansBridge.unsupportedResponse(), PlansBridge.unsupportedResponse())
    }
}
