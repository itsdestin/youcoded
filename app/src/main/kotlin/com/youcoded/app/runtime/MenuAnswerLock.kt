package com.youcoded.app.runtime

/**
 * One device at a time may answer a session's Claude Code menu by verified
 * navigation (arrows, then Enter). Port of desktop's src/main/menu-answer-lock.ts
 * (review F4, 2026-09-24): two devices clicking together could otherwise mix one
 * device's arrows with the other's Enter. A lease, so a device that dies
 * mid-answer cannot lock the session forever.
 */
class MenuAnswerLock(private val now: () -> Long = System::currentTimeMillis) {
    private data class Held(val holder: String, val until: Long)
    private val held = HashMap<String, Held>()

    @Synchronized
    fun acquire(sessionId: String, holder: String): Boolean {
        val cur = held[sessionId]
        if (cur != null && cur.holder != holder && cur.until > now()) return false
        held[sessionId] = Held(holder, now() + LEASE_MS)
        return true
    }

    @Synchronized
    fun release(sessionId: String, holder: String) {
        if (held[sessionId]?.holder == holder) held.remove(sessionId)
    }

    /** The bridge entry point: "acquire" → granted?, anything else releases → true. */
    fun handle(sessionId: String, holder: String, action: String): Boolean {
        if (holder.isEmpty()) return false
        if (action == "acquire") return acquire(sessionId, holder)
        release(sessionId, holder)
        return true
    }

    companion object { const val LEASE_MS = 20_000L }
}
