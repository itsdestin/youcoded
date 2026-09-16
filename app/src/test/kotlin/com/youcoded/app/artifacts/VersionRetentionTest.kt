package com.youcoded.app.artifacts

import org.junit.Test
import java.nio.file.Files
import java.time.Instant
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// Kotlin mirror of desktop/tests/artifacts/version-retention.test.ts. The phone
// writes the SAME <project>/.youcoded/artifacts.json the desktop does, so the
// retention policy has to behave identically on both or the two platforms
// disagree about one file.
class VersionRetentionTest {

    private val nowMs = Instant.parse("2026-09-03T12:00:00Z").toEpochMilli()
    private val day = 24L * 60L * 60L * 1000L

    /** A version event `daysAgo` days before nowMs. */
    private fun v(daysAgo: Long, type: String = "edit"): VersionEvent = VersionEvent(
        id        = "v-$daysAgo-$type",
        ts        = Instant.ofEpochMilli(nowMs - daysAgo * day).toString(),
        sessionId = "s1",
        type      = type,
        author    = "agent",
    )

    @Test
    fun dropsEntriesOlderThanTheRetentionWindow() {
        val ancient = (0 until 12).map { v(VERSION_RETENTION_DAYS + 10 + it) }.reversed()
        val recent  = (0 until 12).map { v(11L - it) }
        val versions = (ancient + recent).toMutableList()
        val removed = pruneVersions(versions, nowMs)
        assertEquals(12, removed)
        assertEquals(recent.map { it.id }, versions.map { it.id })
    }

    @Test
    fun keepsEverythingInsideTheRetentionWindow() {
        val inside = (0 until 200).map { v((it % VERSION_RETENTION_DAYS.toInt()).toLong()) }.toMutableList()
        assertEquals(0, pruneVersions(inside, nowMs))
        assertEquals(200, inside.size)
    }

    @Test
    fun keepsTheFloorMostRecentRegardlessOfAge() {
        // Every entry is ancient. Without the floor a dormant project would
        // lose a file's whole history on its first edit back.
        val ancient = (0 until 60).map { v(365L - it) }.toMutableList()   // oldest first
        pruneVersions(ancient, nowMs)
        assertEquals(VERSION_RETENTION_FLOOR, ancient.size)
        assertEquals("v-306-edit", ancient.last().id)                     // the newest of them
        assertTrue(ancient.isNotEmpty(), "the floor must never empty a record")
    }

    @Test
    fun neverDropsTheVersionRepresentingTheCurrentState() {
        // `status` is derived from the latest version, so losing a trailing
        // 'delete' would flip a deleted file back to active.
        val versions = ((0 until 30).map { v(900L - it) } + v(500, "delete")).toMutableList()
        pruneVersions(versions, nowMs)
        assertEquals("delete", versions.last().type)
    }

    @Test
    fun pruningIsIdempotent() {
        val versions = ((0 until 40).map { v(300L - it) } + (0 until 5).map { v(it.toLong()) }).toMutableList()
        pruneVersions(versions, nowMs)
        val after = versions.map { it.id }
        assertEquals(0, pruneVersions(versions, nowMs), "a second pass must find nothing to drop")
        assertEquals(after, versions.map { it.id })
    }

    @Test
    fun keepsTheNewestNonReadEntrySoTheFileStaysVisible() {
        // The desktop's trackedArtifacts() rule 3 shows an in-project file only
        // while it has a non-'read' version, and that same renderer runs on the
        // phone. A file created long ago and merely opened since must not be
        // pruned into invisibility.
        val versions = (listOf(v(400, "create")) + (0 until 30).map { v(100L - it, "read") }).toMutableList()
        pruneVersions(versions, nowMs)
        assertTrue(versions.any { it.type != "read" }, "the record must keep a non-read version")
        assertTrue(versions.any { it.type == "create" })
    }

    @Test
    fun keepsEntriesWhoseTimestampCannotBeParsed() {
        // A retention rule must only remove what it can PROVE is old.
        val versions = ((0 until 20).map { v(500L + it) } +
            VersionEvent("bad", "not-a-date", "s1", "edit", "agent")).toMutableList()
        pruneVersions(versions, nowMs)
        assertTrue(versions.any { it.id == "bad" })
    }

    @Test
    fun anAlreadyOversizedFileHealsOnItsNextWrite() {
        // The whole reason there is no migration: pruning lives in the writer.
        val projectRoot = Files.createTempDirectory("kt-retain-").toFile()
        try {
            val stale = ProjectSidecar(
                projectId = "p1", name = "test",
                createdAt = "2026-01-01T00:00:00Z", updatedAt = "2026-01-01T00:00:00Z",
                artifacts = mutableListOf(
                    ArtifactRecord(
                        id = "a1", path = "notes.md", kind = "internal", absolutePath = null,
                        lastModified = "2026-01-01T00:00:00Z", status = "active",
                        versions = (0 until 60).map { v(700L - it) }.toMutableList(),
                    )
                ),
            )
            assertTrue(writeSidecar(projectRoot.absolutePath, null, stale))
            val bytesBefore = java.io.File(projectRoot, ".youcoded/artifacts.json").length()

            assertTrue(appendVersion(projectRoot.absolutePath, "p1", "test",
                AppendVersionInput("notes.md", "internal", null, "s2", "edit", "agent", "toolu_new")))

            val after = (readSidecar(projectRoot.absolutePath) as ReadResult.Ok).sidecar
            // The floor is a TOTAL, and the entry just appended is the newest of them.
            assertEquals(VERSION_RETENTION_FLOOR, after.artifacts[0].versions.size)
            assertEquals("toolu_new", after.artifacts[0].versions.last().toolUseId)
            assertTrue(java.io.File(projectRoot, ".youcoded/artifacts.json").length() < bytesBefore)
        } finally {
            projectRoot.deleteRecursively()
        }
    }

    @Test
    fun aNormalRecentHistoryIsNotTouchedByTheWritePath() {
        val projectRoot = Files.createTempDirectory("kt-retain-ok-").toFile()
        try {
            for (i in 0 until 25) {
                assertTrue(appendVersion(projectRoot.absolutePath, "p1", "test",
                    AppendVersionInput("notes.md", "internal", null, "s1", "edit", "agent", "toolu_$i")))
            }
            val after = (readSidecar(projectRoot.absolutePath) as ReadResult.Ok).sidecar
            assertEquals(25, after.artifacts[0].versions.size)
        } finally {
            projectRoot.deleteRecursively()
        }
    }
}
