package com.youcoded.app.parser

import org.junit.Assert.*
import org.junit.Test

class SubagentIndexTest {

    @Test
    fun `binds subagent to matching parent`() {
        val idx = SubagentIndex(nowMs = { 1000L })
        idx.recordParentAgentToolUse("toolu_A", "Find bug", "Explore")
        val bound = idx.bindSubagent("agent1", description = "Find bug", agentType = "Explore")
        assertEquals("toolu_A", bound)
        assertEquals("toolu_A", idx.lookup("agent1"))
    }

    @Test
    fun `returns null when no parent matches`() {
        val idx = SubagentIndex()
        val bound = idx.bindSubagent("agent1", description = "Find bug", agentType = "Explore")
        assertNull(bound)
    }

    @Test
    fun `FIFO pairing for parallel parents with identical description`() {
        val idx = SubagentIndex()
        idx.recordParentAgentToolUse("toolu_A", "Review", "general-purpose")
        idx.recordParentAgentToolUse("toolu_B", "Review", "general-purpose")
        assertEquals("toolu_A", idx.bindSubagent("a1", "Review", "general-purpose"))
        assertEquals("toolu_B", idx.bindSubagent("a2", "Review", "general-purpose"))
    }

    @Test
    fun `subagent_type mismatch means no binding`() {
        val idx = SubagentIndex()
        idx.recordParentAgentToolUse("toolu_A", "Do stuff", "Explore")
        assertNull(idx.bindSubagent("agent1", "Do stuff", "Plan"))
    }

    @Test
    fun `binding consumes the parent so it is not reused`() {
        val idx = SubagentIndex()
        idx.recordParentAgentToolUse("toolu_A", "Find bug", "Explore")
        idx.bindSubagent("agent1", "Find bug", "Explore")
        val second = idx.bindSubagent("agent2", "Find bug", "Explore")
        assertNull(second)
    }

    @Test
    fun `unbind clears binding`() {
        val idx = SubagentIndex()
        idx.recordParentAgentToolUse("toolu_A", "Find bug", "Explore")
        idx.bindSubagent("agent1", "Find bug", "Explore")
        idx.unbind("agent1")
        assertNull(idx.lookup("agent1"))
    }

    @Test
    fun `pending events flush when parent arrives`() {
        val idx = SubagentIndex()
        idx.bufferPendingEvent("agent1", "Find bug", "Explore", "event1")
        idx.bufferPendingEvent("agent1", "Find bug", "Explore", "event2")
        idx.recordParentAgentToolUse("toolu_A", "Find bug", "Explore")
        val flushed = idx.tryFlushPending("agent1")
        assertNotNull(flushed)
        assertEquals("toolu_A", flushed!!.parentToolUseId)
        assertEquals(listOf<Any>("event1", "event2"), flushed.events)
    }

    @Test
    fun `pending events age out after 30s`() {
        var clock = 1000L
        val idx = SubagentIndex(nowMs = { clock })
        idx.bufferPendingEvent("agent1", "Find bug", "Explore", "event1")
        clock += 30_001L
        idx.pruneExpired()
        assertNull(idx.tryFlushPending("agent1"))
    }
}
