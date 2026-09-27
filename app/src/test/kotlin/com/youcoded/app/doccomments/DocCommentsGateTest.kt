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
}
