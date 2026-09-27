// Pins T4 of the doc-comments build (docs/active/specs/2026-09-26-doc-
// comments-build-design.md §1.1, §3.2a, §4.3a): the by-extension dispatch
// point between the plain-text sidecar store and T16/T18's native docx/xlsx
// readers, plus the honest "not yet supported" refusal for native writes
// until T17/T19 land (see DocCommentsDispatch.kt's own header for why that
// split is correct here, not a gap in this task).
package com.youcoded.app.doccomments

import com.youcoded.app.config.WorkingDir
import com.youcoded.app.config.WorkingDirStore
import org.junit.Test
import java.io.File
import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

private fun fixtureFile(name: String): File {
    val resourceStream = object {}.javaClass.getResourceAsStream("/doc-comments/$name")
        ?: fail("missing test resource doc-comments/$name")
    val tmp = Files.createTempFile("ycd-dispatch-", "-$name").toFile()
    tmp.deleteOnExit()
    resourceStream.use { input -> tmp.outputStream().use { output -> input.copyTo(output) } }
    return tmp
}

class DocCommentsDispatchTest {

    @Test
    fun `nativeFormatFor recognizes docx and xlsx by extension only`() {
        assertEquals(NativeFormat.DOCX, nativeFormatFor("docs/plan.docx"))
        assertEquals(NativeFormat.XLSX, nativeFormatFor("reports/q3.xlsx"))
        assertNull(nativeFormatFor("docs/plan.md"))
        assertNull(nativeFormatFor("docs/plan"))
        // Case-insensitive, matching path.extname().toLowerCase() on desktop.
        assertEquals(NativeFormat.DOCX, nativeFormatFor("DOCS/PLAN.DOCX"))
    }

    @Test
    fun `refuseNativeMutation refuses every docx and xlsx target, never a plain-text one`() {
        assertTrue(refuseNativeMutation("docs/plan.docx"))
        assertTrue(refuseNativeMutation("reports/q3.xlsx"))
        assertTrue(!refuseNativeMutation("docs/plan.md"))
    }

    @Test
    fun `listNativeComments dispatches a docx target to T16's real Kotlin reader`() {
        val docx = fixtureFile("launch-brief.docx")
        val home = Files.createTempDirectory("ycd-dispatch-home-").toFile().apply { deleteOnExit() }
        // No projectRoot — the absolute-path fallback branch. F4
        // (implementation review) switched this branch from a denylist to an
        // allowlist, so the fixture's own directory must now be registered
        // as a known root for this to reach T16's reader at all — otherwise
        // this test would exercise the access-control gate, not the reader.
        WorkingDirStore(home).add(WorkingDir(label = "T16 fixture", path = docx.parentFile!!.canonicalPath))
        val result = listNativeComments(NativeFormat.DOCX, docx.absolutePath, null, home)
        assertTrue(result is NativeListResult.Ok, "expected Ok, got $result")
        assertTrue((result as NativeListResult.Ok).comments.isNotEmpty())
    }

    @Test
    fun `listNativeComments dispatches an xlsx target to T18's real Kotlin reader`() {
        val xlsx = fixtureFile("q3-sales-by-rep.xlsx")
        val home = Files.createTempDirectory("ycd-dispatch-home-").toFile().apply { deleteOnExit() }
        WorkingDirStore(home).add(WorkingDir(label = "T18 fixture", path = xlsx.parentFile!!.canonicalPath))
        val result = listNativeComments(NativeFormat.XLSX, xlsx.absolutePath, null, home)
        assertTrue(result is NativeListResult.Ok, "expected Ok, got $result")
        assertTrue((result as NativeListResult.Ok).comments.isNotEmpty())
    }

    @Test
    fun `a sensitive no-projectRoot path is refused before ever reaching the native reader`() {
        val home = Files.createTempDirectory("ycd-dispatch-home2-").toFile().apply { deleteOnExit() }
        val sshDir = File(home, ".ssh").apply { mkdirs() }
        val fakeKey = File(sshDir, "id_rsa.docx").apply { writeText("not a real docx") }
        val result = listNativeComments(NativeFormat.DOCX, fakeKey.absolutePath, null, home)
        assertEquals(NativeListResult.Err("path-not-tracked"), result)
    }

    // ── F4 (implementation review, major/security) — allowlist, not a denylist ──
    @Test
    fun `an untracked path outside every known root is refused even though it is not on the sensitive denylist`() {
        val home = Files.createTempDirectory("ycd-dispatch-untracked-").toFile().apply { deleteOnExit() }
        // Registered nowhere as a root and not a tracked artifact — before F4
        // this would have been allowed straight through (it matches nothing
        // on the old denylist), which was the vulnerability the fix closes.
        val docx = fixtureFile("launch-brief.docx")
        val result = listNativeComments(NativeFormat.DOCX, docx.absolutePath, null, home)
        assertEquals(NativeListResult.Err("path-not-tracked"), result)
    }

    @Test
    fun `a tracked external artifact dispatches to the reader even though it lives outside every known root`() {
        val home = Files.createTempDirectory("ycd-dispatch-tracked-home-").toFile().apply { deleteOnExit() }
        val project = Files.createTempDirectory("ycd-dispatch-tracked-project-").toFile().apply { deleteOnExit() }
        WorkingDirStore(home).add(WorkingDir(label = "P", path = project.path))
        val docx = fixtureFile("launch-brief.docx")
        com.youcoded.app.artifacts.appendVersion(
            projectRoot = project.path,
            projectId = "proj-tracked",
            projectName = "P",
            input = com.youcoded.app.artifacts.AppendVersionInput(
                path = com.youcoded.app.artifacts.canonicalize(docx.absolutePath, null),
                kind = "external",
                absolutePath = com.youcoded.app.artifacts.canonicalize(docx.absolutePath, null),
                sessionId = "s1",
                type = "read",
                author = "user",
            ),
        )
        val result = listNativeComments(NativeFormat.DOCX, docx.absolutePath, null, home)
        assertTrue(result is NativeListResult.Ok, "expected Ok, got $result")
    }

    // ── F3 (implementation review, major) — exception boundary ─────────────
    @Test
    fun `a corrupt-but-openable docx archive refuses invalid-docx instead of throwing past this function`() {
        val home = Files.createTempDirectory("ycd-dispatch-corrupt-").toFile().apply { deleteOnExit() }
        val docxDir = Files.createTempDirectory("ycd-dispatch-corrupt-docx-").toFile().apply { deleteOnExit() }
        WorkingDirStore(home).add(WorkingDir(label = "corrupt", path = docxDir.path))
        val fakeDocx = File(docxDir, "broken.docx")
        // A REAL, openable zip (a valid central directory) whose
        // word/comments.xml entry is not valid XML at all — the "corrupt-
        // but-openable archive" shape F3 exists for: ZipFile opens fine,
        // parsing the entry inside is what throws.
        java.util.zip.ZipOutputStream(fakeDocx.outputStream()).use { zip ->
            zip.putNextEntry(java.util.zip.ZipEntry("word/document.xml"))
            zip.write("<w:document xmlns:w=\"ns\"><w:body/></w:document>".toByteArray())
            zip.closeEntry()
            zip.putNextEntry(java.util.zip.ZipEntry("word/comments.xml"))
            zip.write("this is not xml at all <<<".toByteArray())
            zip.closeEntry()
        }
        val result = listNativeComments(NativeFormat.DOCX, fakeDocx.absolutePath, null, home)
        assertEquals(NativeListResult.Err("invalid-docx"), result)
    }

    @Test
    fun `a missing file after containment passes refuses read-failed`() {
        val home = Files.createTempDirectory("ycd-dispatch-missing-").toFile().apply { deleteOnExit() }
        val project = Files.createTempDirectory("ycd-dispatch-missing-project-").toFile().apply { deleteOnExit() }
        WorkingDirStore(home).add(WorkingDir(label = "P", path = project.path))
        val neverCreated = File(project, "gone.docx")
        val result = listNativeComments(NativeFormat.DOCX, neverCreated.absolutePath, null, home)
        assertEquals(NativeListResult.Err("read-failed"), result)
    }
}
