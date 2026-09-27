// Pins T4 of the doc-comments build (docs/active/specs/2026-09-26-doc-
// comments-build-design.md §1.1, §3.2a, §4.3a): the by-extension dispatch
// point between the plain-text sidecar store and T16/T18's native docx/xlsx
// readers, plus the honest "not yet supported" refusal for native writes
// until T17/T19 land (see DocCommentsDispatch.kt's own header for why that
// split is correct here, not a gap in this task).
package com.youcoded.app.doccomments

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
        // No projectRoot — the absolute-path fallback branch; the fixture
        // copy isn't a sensitive path, so it passes the denylist check.
        val result = listNativeComments(NativeFormat.DOCX, docx.absolutePath, null, home)
        assertTrue(result is NativeListResult.Ok, "expected Ok, got $result")
        assertTrue((result as NativeListResult.Ok).comments.isNotEmpty())
    }

    @Test
    fun `listNativeComments dispatches an xlsx target to T18's real Kotlin reader`() {
        val xlsx = fixtureFile("q3-sales-by-rep.xlsx")
        val home = Files.createTempDirectory("ycd-dispatch-home-").toFile().apply { deleteOnExit() }
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
}
