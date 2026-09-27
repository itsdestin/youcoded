// Pins T4 of the doc-comments build (docs/active/specs/2026-09-26-doc-
// comments-build-design.md §1.5): Android's own "is this projectRoot a root
// the app recognizes" gate — the Kotlin port of desktop's doc-comments-
// gate.ts's `refuseUnknownProjectRoot`, built on Android's OWN known-root
// sources (WorkingDirStore's saved working directories + CentralIndex's
// indexed projects + the caller's own live session cwds) rather than
// desktop's Electron-only `isKnownRoot()`.
package com.youcoded.app.doccomments

import com.youcoded.app.artifacts.CentralIndexProject
import com.youcoded.app.artifacts.IndexStats
import com.youcoded.app.artifacts.upsertProject
import com.youcoded.app.config.WorkingDirStore
import com.youcoded.app.config.WorkingDir
import org.junit.Test
import java.nio.file.Files
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private fun tempHome(): java.io.File = Files.createTempDirectory("ycd-doccomments-gate-").toFile().apply { deleteOnExit() }

class DocCommentsGateTest {

    @Test
    fun `an unrecognized projectRoot is refused`() {
        val home = tempHome()
        val unknown = Files.createTempDirectory("ycd-doccomments-unknown-").toFile().apply { deleteOnExit() }
        assertTrue(refuseUnknownProjectRoot(unknown.path, home, java.io.File(home, ".claude")))
    }

    @Test
    fun `a caller-named root of the filesystem root does not become a no-op allow`() {
        val home = tempHome()
        // The exact forged-root shape the T3 build review's own blocker (F1)
        // called out for desktop: '/' (or a home directory) must not vouch
        // for itself just by being a real, existing directory.
        assertTrue(refuseUnknownProjectRoot("/", home, java.io.File(home, ".claude")))
    }

    @Test
    fun `no projectRoot at all is never refused — the fallback path is gated elsewhere`() {
        val home = tempHome()
        assertFalse(refuseUnknownProjectRoot(null, home, java.io.File(home, ".claude")))
        assertFalse(refuseUnknownProjectRoot("", home, java.io.File(home, ".claude")))
    }

    @Test
    fun `a saved working directory is a known root`() {
        val home = tempHome()
        val project = Files.createTempDirectory("ycd-doccomments-saved-").toFile().apply { deleteOnExit() }
        WorkingDirStore(home).add(WorkingDir(label = "My Project", path = project.path))
        assertFalse(refuseUnknownProjectRoot(project.path, home, java.io.File(home, ".claude")))
    }

    @Test
    fun `an indexed central-index project is a known root`() {
        val home = tempHome()
        val claudeDir = java.io.File(home, ".claude")
        val project = Files.createTempDirectory("ycd-doccomments-indexed-").toFile().apply { deleteOnExit() }
        upsertProject(
            claudeDir.path,
            CentralIndexProject(
                id = "proj-1",
                name = "Indexed Project",
                path = project.canonicalPath,
                lastIndexed = "2026-09-26T00:00:00.000Z",
                lastSession = null,
                contentTypes = listOf("artifacts"),
                stats = IndexStats(artifactCount = 0),
            ),
        )
        assertFalse(refuseUnknownProjectRoot(project.path, home, claudeDir))
    }

    @Test
    fun `a live session cwd counts as known even when never saved or indexed`() {
        val home = tempHome()
        val sessionCwd = Files.createTempDirectory("ycd-doccomments-session-").toFile().apply { deleteOnExit() }
        assertTrue(refuseUnknownProjectRoot(sessionCwd.path, home, java.io.File(home, ".claude")))
        assertFalse(refuseUnknownProjectRoot(sessionCwd.path, home, java.io.File(home, ".claude"), listOf(sessionCwd.path)))
    }

    // ── F4 (T4 implementation review, major/security) — allowUntrackedNativeRead ──

    @Test
    fun `a path outside every known root with nothing tracking it is refused, not silently allowed`() {
        val home = tempHome()
        val outside = Files.createTempDirectory("ycd-doccomments-untracked-").toFile().apply { deleteOnExit() }
        val file = java.io.File(outside, "f.docx").apply { writeText("x") }
        // Before F4 this path would have been ALLOWED — it matches nothing on
        // the old denylist. That was the vulnerability this fix closes.
        assertFalse(allowUntrackedNativeRead(file.path, home, java.io.File(home, ".claude")))
    }

    @Test
    fun `a path under a known project root is allowed`() {
        val home = tempHome()
        val project = Files.createTempDirectory("ycd-doccomments-root-").toFile().apply { deleteOnExit() }
        WorkingDirStore(home).add(WorkingDir(label = "P", path = project.path))
        val file = java.io.File(project, "f.docx").apply { writeText("x") }
        assertTrue(allowUntrackedNativeRead(file.path, home, java.io.File(home, ".claude")))
    }

    @Test
    fun `a sensitive path is refused even when it sits inside an otherwise-known root`() {
        val home = tempHome()
        val project = Files.createTempDirectory("ycd-doccomments-root2-").toFile().apply { deleteOnExit() }
        WorkingDirStore(home).add(WorkingDir(label = "P", path = project.path))
        val sshDir = java.io.File(project, ".ssh").apply { mkdirs() }
        val file = java.io.File(sshDir, "id_rsa.docx").apply { writeText("x") }
        assertFalse(allowUntrackedNativeRead(file.path, home, java.io.File(home, ".claude")))
    }

    @Test
    fun `a live session cwd is NOT enough on its own — allowUntrackedNativeRead excludes session roots`() {
        val home = tempHome()
        // allowUntrackedNativeRead never receives extraSessionRoots at all
        // (unlike refuseUnknownProjectRoot) — a live session's own cwd must
        // NOT vouch for a raw-bytes read the way it vouches for a
        // projectRoot, per the phone-can-start-a-session-anywhere reasoning
        // this function's own doc comment cites.
        val sessionCwd = Files.createTempDirectory("ycd-doccomments-session2-").toFile().apply { deleteOnExit() }
        val file = java.io.File(sessionCwd, "f.docx").apply { writeText("x") }
        assertFalse(allowUntrackedNativeRead(file.path, home, java.io.File(home, ".claude")))
    }

    @Test
    fun `a tracked external artifact is allowed even though it lives outside every known root`() {
        val home = tempHome()
        val claudeDir = java.io.File(home, ".claude")
        val project = Files.createTempDirectory("ycd-doccomments-tracked-project-").toFile().apply { deleteOnExit() }
        WorkingDirStore(home).add(WorkingDir(label = "P", path = project.path))
        val outside = Files.createTempDirectory("ycd-doccomments-tracked-outside-").toFile().apply { deleteOnExit() }
        val externalFile = java.io.File(outside, "report.xlsx").apply { writeText("x") }

        com.youcoded.app.artifacts.appendVersion(
            projectRoot = project.path,
            projectId = "proj-tracked",
            projectName = "P",
            input = com.youcoded.app.artifacts.AppendVersionInput(
                path = com.youcoded.app.artifacts.canonicalize(externalFile.path, null),
                kind = "external",
                absolutePath = com.youcoded.app.artifacts.canonicalize(externalFile.path, null),
                sessionId = "s1",
                type = "read",
                author = "user",
            ),
        )

        assertTrue(allowUntrackedNativeRead(externalFile.path, home, claudeDir))
    }
}
