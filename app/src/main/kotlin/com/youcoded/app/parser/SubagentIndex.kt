package com.youcoded.app.parser

/**
 * Correlates subagent JSONL files to their parent Agent tool_use.
 * Mirrors the desktop's subagent-index.ts. One instance per parent session.
 */
class SubagentIndex(
    private val nowMs: () -> Long = { System.currentTimeMillis() },
) {
    companion object {
        private const val PENDING_TTL_MS = 30_000L
    }

    data class FlushResult(val parentToolUseId: String, val events: List<Any>)

    private data class ParentRecord(
        val toolUseId: String,
        val description: String,
        val subagentType: String,
    )

    private data class PendingEntry(
        val description: String,
        val agentType: String,
        val events: MutableList<Any>,
        val firstSeenAt: Long,
    )

    private val unmatchedParents = mutableListOf<ParentRecord>()
    private val bindings = mutableMapOf<String, String>()
    private val pending = mutableMapOf<String, PendingEntry>()

    @Synchronized
    fun recordParentAgentToolUse(toolUseId: String, description: String, subagentType: String) {
        unmatchedParents.add(ParentRecord(toolUseId, description, subagentType))
    }

    @Synchronized
    fun bindSubagent(agentId: String, description: String, agentType: String): String? {
        val i = unmatchedParents.indexOfFirst {
            it.description == description && it.subagentType == agentType
        }
        if (i < 0) return null
        val parent = unmatchedParents.removeAt(i)
        bindings[agentId] = parent.toolUseId
        return parent.toolUseId
    }

    @Synchronized
    fun lookup(agentId: String): String? = bindings[agentId]

    @Synchronized
    fun unbind(agentId: String) {
        bindings.remove(agentId)
    }

    @Synchronized
    fun bufferPendingEvent(agentId: String, description: String, agentType: String, event: Any) {
        val existing = pending[agentId]
        if (existing != null) {
            existing.events.add(event)
            return
        }
        pending[agentId] = PendingEntry(description, agentType, mutableListOf(event), nowMs())
    }

    @Synchronized
    fun tryFlushPending(agentId: String): FlushResult? {
        val entry = pending[agentId] ?: return null
        val parentToolUseId = bindSubagent(agentId, entry.description, entry.agentType)
            ?: return null
        pending.remove(agentId)
        return FlushResult(parentToolUseId, entry.events.toList())
    }

    // Note: collects expired keys first, then removes — Kotlin MutableMap does NOT
    // allow deletion during iteration (unlike ECMAScript Map), so we must separate
    // the two steps to avoid ConcurrentModificationException.
    @Synchronized
    fun pruneExpired() {
        val cutoff = nowMs() - PENDING_TTL_MS
        val expired = pending.filterValues { it.firstSeenAt < cutoff }.keys
        for (k in expired) pending.remove(k)
    }
}
