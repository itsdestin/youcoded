package com.youcoded.app.artifacts

import org.junit.Test
import java.io.File
import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// Mirror of desktop tests/artifacts/write-authorization.test.ts
// "judgeRelativeRecord": a `../` record is trusted only inside a project folder
// and outside the deny list — a planted record pointing at a secret stays refused.
class RelativeRecordTest {
    private fun world(): Triple<File, File, File> {
        val parent = Files.createTempDirectory("rr-").toFile()
        val proj = File(parent, "proj").apply { mkdirs() }
        val other = File(parent, "notes").apply { mkdirs() }
        File(other, "plan.md").writeText("plan")
        File(other, ".ssh").mkdirs(); File(other, ".ssh/id_rsa").writeText("PRIVATE")
        File(proj, "sub").mkdirs(); File(proj, "here.md").writeText("here")
        return Triple(parent, proj, other)
    }

    @Test
    fun trustsAFileInsideASavedFolder() {
        val (parent, proj, other) = world()
        try {
            val v = judgeRelativeRecord(proj.path, "../notes/plan.md", listOf(other.path))
            assertTrue(v is RelativeRecordVerdict.Trusted)
            assertEquals(File(other, "plan.md").canonicalPath, v.file.path)
            assertTrue(judgeRelativeRecord(proj.path, "sub/../here.md", emptyList()) is RelativeRecordVerdict.Trusted)
        } finally { parent.deleteRecursively() }
    }

    @Test
    fun refusesAFileOutsideEveryProjectAsExactlyThat() {
        val (parent, proj, other) = world()
        try {
            val v = judgeRelativeRecord(proj.path, "../notes/plan.md", emptyList())
            assertEquals(RelativeRecordVerdict.OutsideProjects(File(other, "plan.md").canonicalPath), v)
        } finally { parent.deleteRecursively() }
    }

    @Test
    fun keepsAPlantedSecretRecordRefusedEvenInsideASavedFolder() {
        val (parent, proj, other) = world()
        try {
            assertEquals(RelativeRecordVerdict.Protected, judgeRelativeRecord(proj.path, "../notes/.ssh/id_rsa", listOf(other.path)))
        } finally { parent.deleteRecursively() }
    }

    @Test
    fun saysMissingOnlyWhenNothingIsThere() {
        val (parent, proj, other) = world()
        try {
            assertEquals(RelativeRecordVerdict.Missing, judgeRelativeRecord(proj.path, "../notes/never.md", listOf(other.path)))
        } finally { parent.deleteRecursively() }
    }
}
