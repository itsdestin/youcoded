package com.youcoded.app.artifacts

import org.junit.Test
import java.io.File
import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// Mirror of desktop tests/artifacts/write-authorization.test.ts
// "judgeRelativeRecord": a `../` record is trusted only inside a project folder
// strictly below home and outside the deny lists — a planted record pointing at
// a secret stays refused, and a saved HOME folder vouches for nothing.
class RelativeRecordTest {
    private class World(val home: File) {
        val proj = File(home, "proj").apply { mkdirs() }
        val notes = File(home, "notes").apply { mkdirs() }
        fun put(rel: String, text: String = "x"): File = File(home, rel).apply { parentFile.mkdirs(); writeText(text) }
        fun relFromProj(f: File): String = proj.toPath().relativize(f.toPath()).toString()
    }

    private fun <T> world(block: World.() -> T): T {
        val home = Files.createTempDirectory("rr-home-").toFile().canonicalFile
        try { return World(home).block() } finally { home.deleteRecursively() }
    }

    @Test
    fun trustsAFileInsideASavedFolderBelowHome() = world {
        val plan = put("notes/plan.md")
        val v = judgeRelativeRecord(proj.path, relFromProj(plan), listOf(notes.path), home.path)
        assertTrue(v is RelativeRecordVerdict.Trusted)
        assertEquals(plan.canonicalPath, v.file.path)
        put("proj/here.md")
        assertTrue(judgeRelativeRecord(proj.path, "sub/../here.md".also { File(proj, "sub").mkdirs() }, emptyList(), home.path) is RelativeRecordVerdict.Trusted)
    }

    @Test
    fun refusesAFileOutsideEveryProjectWithoutSayingWhere() = world {
        val f = put("elsewhere/plan.md")
        assertEquals(RelativeRecordVerdict.OutsideProjects, judgeRelativeRecord(proj.path, relFromProj(f), listOf(notes.path), home.path))
    }

    @Test
    fun aSavedHomeFolderOrAnAncestorOrRootVouchesForNothingAndSaysSoTruthfully() = world {
        // Refused by design; the file IS inside a saved folder, so the answer is
        // the rule, not "outside your project folders" (re-review C1).
        val f = put("Documents/todo.md")
        for (saved in listOf(home.path, home.parentFile.path, "/")) {
            assertEquals(RelativeRecordVerdict.NotInHomeProject, judgeRelativeRecord(proj.path, relFromProj(f), listOf(saved), home.path), saved)
        }
    }

    @Test
    fun aProjectOutsideHomeIsRefusedWithTheRule() {
        val drive = Files.createTempDirectory("rr-drive-").toFile().canonicalFile
        try {
            world {
                val f = File(drive, "work/notes.md").apply { parentFile.mkdirs(); writeText("x") }
                assertEquals(RelativeRecordVerdict.NotInHomeProject,
                    judgeRelativeRecord(proj.path, proj.toPath().relativize(f.toPath()).toString(), listOf(drive.path), home.path))
            }
        } finally { drive.deleteRecursively() }
    }

    @Test
    fun aSavedFolderNeverAdmitsASiblingSharingItsNameAsAPrefix() = world {
        val sib = put("proj2/x.md")
        val other = File(home, "other").apply { mkdirs() }
        assertEquals(RelativeRecordVerdict.OutsideProjects,
            judgeRelativeRecord(other.path, other.toPath().relativize(sib.toPath()).toString(), listOf(proj.path), home.path))
    }

    @Test
    fun aSymlinkLoopIsUnreadableWithACodeLikeDesktop() = world {
        val a = File(notes, "a").toPath(); val b = File(notes, "b").toPath()
        try { Files.createSymbolicLink(a, b); Files.createSymbolicLink(b, a) } catch (_: Exception) { return@world }
        assertEquals(RelativeRecordVerdict.Unreadable("ELOOP"), judgeRelativeRecord(proj.path, "../notes/a", listOf(notes.path), home.path))
    }

    @Test
    fun keepsEveryPlantedCredentialRecordRefusedWithHomeSaved() = world {
        val secrets = listOf(
            ".git-credentials", ".claude.json", ".npmrc", ".pypirc", ".docker/config.json", ".pgpass",
            ".bash_history", ".zsh_history", ".local/share/fish/fish_history",
            ".config/gcloud/application_default_credentials.json", ".local/share/keyrings/login.keyring",
            ".ssh/id_rsa", ".aws/credentials", ".netrc", ".config/gh/hosts.yml", "notes/.env", "notes/.npmrc",
        )
        for (s in secrets) {
            val f = put(s, "PRIVATE")
            assertEquals(RelativeRecordVerdict.Protected,
                judgeRelativeRecord(proj.path, relFromProj(f), listOf(home.path, notes.path), home.path), s)
        }
    }

    @Test
    fun saysMissingOnlyWhenNothingIsThere() = world {
        assertEquals(RelativeRecordVerdict.Missing, judgeRelativeRecord(proj.path, "../notes/never.md", listOf(notes.path), home.path))
    }
}
