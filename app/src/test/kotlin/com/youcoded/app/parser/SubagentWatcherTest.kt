package com.youcoded.app.parser

import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.File

class SubagentWatcherTest {
    private lateinit var tmpRoot: File
    private lateinit var subagentsDir: File
    private lateinit var index: SubagentIndex
    private lateinit var emitted: MutableList<TranscriptEvent>
    private lateinit var watcher: SubagentWatcher

    @Before
    fun setUp() {
        tmpRoot = File.createTempFile("subagent-watcher", "").apply { delete(); mkdirs() }
        subagentsDir = File(tmpRoot, "subagents").apply { mkdirs() }
        index = SubagentIndex()
        emitted = mutableListOf()
        watcher = SubagentWatcher(
            sessionId = "sess-1",
            subagentsDir = subagentsDir,
            index = index,
            emit = { emitted.add(it) },
        )
    }

    @After
    fun tearDown() {
        watcher.stop()
        tmpRoot.deleteRecursively()
    }

    private fun writeMeta(agentId: String, description: String, agentType: String) {
        File(subagentsDir, "agent-$agentId.meta.json").writeText(
            JSONObject().apply {
                put("description", description); put("agentType", agentType)
            }.toString()
        )
    }

    private fun appendToolUse(agentId: String, uuid: String, toolUseId: String, toolName: String) {
        val line = JSONObject().apply {
            put("type", "assistant")
            put("uuid", uuid)
            put("isSidechain", true)
            put("message", JSONObject().apply {
                put("role", "assistant")
                put("content", org.json.JSONArray().apply {
                    put(JSONObject().apply {
                        put("type", "tool_use")
                        put("id", toolUseId)
                        put("name", toolName)
                        put("input", JSONObject())
                    })
                })
            })
        }
        File(subagentsDir, "agent-$agentId.jsonl").appendText(line.toString() + "\n")
    }

    @Test
    fun replays_existing_subagent_on_start() = runTest {
        writeMeta("abc", "Find bug", "Explore")
        appendToolUse("abc", "u1", "toolu_X", "Read")
        index.recordParentAgentToolUse("toolu_parent", "Find bug", "Explore")

        watcher.scanDirectoryForTest()

        val ev = emitted.single()
        assertTrue(ev is TranscriptEvent.ToolUse)
        val toolUse = ev as TranscriptEvent.ToolUse
        assertEquals("toolu_parent", toolUse.parentAgentToolUseId)
        assertEquals("abc", toolUse.agentId)
        assertEquals("toolu_X", toolUse.toolUseId)
    }

    @Test
    fun buffers_events_when_parent_not_yet_recorded_then_flushes() = runTest {
        writeMeta("abc", "Find bug", "Explore")
        appendToolUse("abc", "u1", "toolu_X", "Read")

        watcher.scanDirectoryForTest()
        assertEquals(0, emitted.size)

        index.recordParentAgentToolUse("toolu_parent", "Find bug", "Explore")
        watcher.flushAllPending()

        val ev = emitted.single() as TranscriptEvent.ToolUse
        assertEquals("toolu_parent", ev.parentAgentToolUseId)
    }

    @Test
    fun appends_are_picked_up_on_rescan() = runTest {
        writeMeta("abc", "Find bug", "Explore")
        appendToolUse("abc", "u1", "toolu_X", "Read")
        index.recordParentAgentToolUse("toolu_parent", "Find bug", "Explore")

        watcher.scanDirectoryForTest()
        assertEquals(1, emitted.size)

        appendToolUse("abc", "u2", "toolu_Y", "Grep")
        watcher.readNewLinesForTest("abc")
        assertEquals(2, emitted.size)
    }

    @Test
    fun dedups_reads_using_seen_uuids() = runTest {
        writeMeta("abc", "Find bug", "Explore")
        appendToolUse("abc", "u1", "toolu_X", "Read")
        index.recordParentAgentToolUse("toolu_parent", "Find bug", "Explore")

        watcher.scanDirectoryForTest()
        assertEquals(1, emitted.size)

        watcher.forceRereadForTest("abc")
        assertEquals(1, emitted.size) // no duplicate
    }

    @Test
    fun getHistory_returns_events_for_all_subagents() = runTest {
        writeMeta("abc", "Find bug", "Explore")
        appendToolUse("abc", "u1", "toolu_X", "Read")
        writeMeta("def", "Other", "Plan")
        appendToolUse("def", "u2", "toolu_Y", "Grep")
        // Use a fresh replayIndex (not the live `index`) to mirror TranscriptWatcher's
        // replay path — avoids consuming unmatchedParents from the shared live index.
        val replayIndex = SubagentIndex()
        replayIndex.recordParentAgentToolUse("toolu_P1", "Find bug", "Explore")
        replayIndex.recordParentAgentToolUse("toolu_P2", "Other", "Plan")

        val events = watcher.getHistory(replayIndex)
        assertEquals(2, events.size)
    }
}
