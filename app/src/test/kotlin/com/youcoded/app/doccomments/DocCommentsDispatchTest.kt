// Pins T4 of the doc-comments build (docs/active/specs/2026-09-26-doc-
// comments-build-design.md §1.1, §3.2a, §4.3a): the by-extension dispatch
// point between the plain-text sidecar store and T16/T18's native docx/xlsx
// readers, plus the honest "not yet supported" refusal for native writes
// until T17/T19 land (see DocCommentsDispatch.kt's own header for why that
// split is correct here, not a gap in this task).
package com.youcoded.app.doccomments

import com.youcoded.app.config.WorkingDir
import com.youcoded.app.config.WorkingDirStore
import kotlinx.coroutines.test.runTest
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
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

// F2 (T17 implementation review) fixture-building constants — top-level
// `const val` (Kotlin only allows `const` outside a class body).
private const val W_NS_ATTR = """xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main""""
private const val W14_NS_ATTR = """xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml""""

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
    // T19: xlsx write is now real too (docx already was, T17) —
    // refuseNativeMutation no longer refuses ANY native format, mirroring
    // desktop's own `refuseNativeMutation` (permanently null there since both
    // its formats shipped).
    fun `refuseNativeMutation refuses nothing now that both native formats write for real`() {
        assertTrue(!refuseNativeMutation("docs/plan.docx"))
        assertTrue(!refuseNativeMutation("reports/q3.xlsx"))
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

    // T18 (redesigned 2026-09-27, threaded-only): `q3-sales-by-rep.xlsx` is a
    // LEGACY-NOTES-only fixture — the retired reader this file used to hold
    // would have found comments in it, but §4.1's own decision is that Notes
    // are never shown any more, so the real threaded-comments reader now
    // returns ZERO comments for it (a dedicated assertion of that, not just
    // silently switching fixtures, since it's exactly the regression a
    // careless "keep the old fixture" port could reintroduce).
    @Test
    fun `listNativeComments returns zero comments for a legacy-Notes-only xlsx (never the retired reader's output)`() {
        val xlsx = fixtureFile("q3-sales-by-rep.xlsx")
        val home = Files.createTempDirectory("ycd-dispatch-home-").toFile().apply { deleteOnExit() }
        WorkingDirStore(home).add(WorkingDir(label = "legacy-notes fixture", path = xlsx.parentFile!!.canonicalPath))
        val result = listNativeComments(NativeFormat.XLSX, xlsx.absolutePath, null, home)
        assertTrue(result is NativeListResult.Ok, "expected Ok, got $result")
        assertEquals(emptyList<PersistedComment>(), (result as NativeListResult.Ok).comments)
    }

    @Test
    fun `listNativeComments dispatches a real threaded-comments xlsx target to T18's real Kotlin reader`() {
        val xlsx = fixtureFile("docling-xlsx-comments.xlsx")
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

    // ── F2 (T17 implementation review, major/crash risk) — write-path
    // exception boundary. Mirrors F3's own read-path fixture shape above: a
    // REAL, openable zip (valid central directory) whose CONTENT is corrupt
    // in a way `loadArchiveForWrite`'s own two specific catches
    // (`DocxUnsafeXmlDoctypeException`/`ZipBombDetectedException`) don't
    // cover — before this fix, an exception here escaped every
    // addNativeDocxComment/replyToNativeDocxComment/etc. uncaught, which
    // would kill the coroutine `serviceScope.launch` runs it in with no
    // handler installed — a process crash on Android, not a typed refusal. ──

    private fun textSelector(exact: String): CommentSelector.Text =
        CommentSelector.Text(TextQuoteSelector(exact = exact, prefix = "", suffix = "", occurrence = 0))

    /** A real, openable zip whose `word/comments.xml` entry is present but is
     *  not valid XML at all (no DOCTYPE — that's `DocxUnsafeXmlDoctypeException`'s
     *  own, already-caught case) — `parseXml` throws a plain `SAXException`
     *  here, which `loadArchiveForWrite`'s own catch block does NOT list. */
    private fun buildDocxWithMalformedCommentsXml(): File {
        val dir = Files.createTempDirectory("ycd-dispatch-corrupt-write-").toFile().apply { deleteOnExit() }
        val target = File(dir, "malformed-comments.docx")
        ZipOutputStream(target.outputStream()).use { zos ->
            fun entry(name: String, content: String) {
                zos.putNextEntry(ZipEntry(name))
                zos.write(content.toByteArray(Charsets.UTF_8))
                zos.closeEntry()
            }
            entry(
                "[Content_Types].xml",
                """<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>""",
            )
            entry(
                "_rels/.rels",
                """<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>""",
            )
            entry(
                "word/_rels/document.xml.rels",
                """<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>""",
            )
            entry(
                "word/document.xml",
                """<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document $W_NS_ATTR $W14_NS_ATTR><w:body>""" +
                    """<w:p w14:paraId="E0000001"><w:commentRangeStart w:id="0"/><w:r><w:t xml:space="preserve">A commented sentence.</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r></w:p>""" +
                    """<w:p w14:paraId="E0000002"><w:r><w:t xml:space="preserve">An uncommented sentence to add a NEW comment on.</w:t></w:r></w:p>""" +
                    """</w:body></w:document>""",
            )
            // The corrupt part: real bytes, a real entry, but not XML at all
            // — never a truncated/absent entry (that's `MISSING_DOCUMENT_PART`,
            // an already-typed, already-tested case).
            entry("word/comments.xml", "this is not xml at all <<<")
        }
        return target
    }

    /** A real, openable zip whose `word/comments.xml` entry declares a CRC
     *  that does not match its own (otherwise well-formed) bytes — the
     *  "truncated/corrupted compressed entry" shape this finding names:
     *  `ZipFile.getInputStream(entry)` throws a plain `java.util.zip.ZipException`
     *  (CRC mismatch) while `readEntryBounded` reads it, well past
     *  `loadArchiveForWrite`'s own two specific catches. */
    private fun buildDocxWithCorruptCommentsPartCrc(): File {
        val dir = Files.createTempDirectory("ycd-dispatch-corrupt-crc-").toFile().apply { deleteOnExit() }
        val target = File(dir, "corrupt-crc.docx")
        val commentsBytes = (
            """<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments $W_NS_ATTR $W14_NS_ATTR>""" +
                """<w:comment w:id="0" w:author="Priya Shah" w:date="2026-09-26T09:00:00Z"><w:p w14:paraId="F0000000"><w:r><w:t xml:space="preserve">Note.</w:t></w:r></w:p></w:comment>""" +
                """</w:comments>"""
            ).toByteArray(Charsets.UTF_8)
        ZipOutputStream(target.outputStream()).use { zos ->
            fun entry(name: String, content: String) {
                zos.putNextEntry(ZipEntry(name))
                zos.write(content.toByteArray(Charsets.UTF_8))
                zos.closeEntry()
            }
            entry(
                "[Content_Types].xml",
                """<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>""",
            )
            entry(
                "_rels/.rels",
                """<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>""",
            )
            entry(
                "word/_rels/document.xml.rels",
                """<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>""",
            )
            entry(
                "word/document.xml",
                """<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document $W_NS_ATTR $W14_NS_ATTR><w:body>""" +
                    """<w:p w14:paraId="E0000001"><w:commentRangeStart w:id="0"/><w:r><w:t xml:space="preserve">A commented sentence.</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r></w:p>""" +
                    """</w:body></w:document>""",
            )
            // STORED (never DEFLATED) so the on-disk bytes ARE the plaintext
            // XML — corruptible in place below with no compression algorithm
            // involved. Size/CRC are declared against the ORIGINAL, correct
            // bytes; the corruption step below only mutates content bytes
            // in place (same length), so the zip's own structure (local
            // header, central directory, offsets) stays entirely valid —
            // only this one entry's CONTENT vs. its own declared CRC
            // disagrees, exactly "corrupt but openable."
            val commentsEntry = ZipEntry("word/comments.xml")
            commentsEntry.method = ZipEntry.STORED
            commentsEntry.size = commentsBytes.size.toLong()
            commentsEntry.compressedSize = commentsBytes.size.toLong()
            val crc32 = CRC32()
            crc32.update(commentsBytes)
            commentsEntry.crc = crc32.value
            zos.putNextEntry(commentsEntry)
            zos.write(commentsBytes)
            zos.closeEntry()
        }
        // Corrupt the STORED comments.xml payload IN PLACE (same byte count,
        // so no offset in the zip's own structure moves) — find its unique
        // marker text and flip it to something else the CRC no longer
        // matches. `document.xml` above carries no `w:comment` substring of
        // its own, so this search is unambiguous.
        val bytes = target.readBytes()
        val marker = "w:comment w:id".toByteArray(Charsets.UTF_8)
        var idx = -1
        outer@ for (i in 0..(bytes.size - marker.size)) {
            for (j in marker.indices) if (bytes[i + j] != marker[j]) continue@outer
            idx = i
            break
        }
        assertTrue(idx >= 0, "test fixture bug: marker not found in the STORED comments.xml payload")
        for (i in idx until idx + marker.size) bytes[i] = 'X'.code.toByte()
        target.writeBytes(bytes)
        return target
    }

    @Test
    fun `addNativeDocxComment refuses invalid-docx instead of crashing when comments xml is not well-formed XML`() = runTest {
        val home = Files.createTempDirectory("ycd-dispatch-corrupt-write-home-").toFile().apply { deleteOnExit() }
        val docx = buildDocxWithMalformedCommentsXml()
        WorkingDirStore(home).add(WorkingDir(label = "corrupt-write", path = docx.parentFile!!.canonicalPath))
        val before = docx.readBytes()
        val result = addNativeDocxComment(
            docx.absolutePath, null,
            textSelector("An uncommented sentence to add a NEW comment on."),
            "x", "user", home,
        )
        assertEquals(NativeMutateResult.Err(DocxWriteError.INVALID_DOCX.wire), result)
        assertTrue(docx.readBytes().contentEquals(before)) // target left byte-identical
    }

    @Test
    fun `resolveNativeDocxComment refuses invalid-docx instead of crashing when comments xml is not well-formed XML`() = runTest {
        // Same corrupt fixture, a DIFFERENT dispatch function — proves the
        // boundary is applied uniformly across every write entry point, not
        // just `add`.
        val home = Files.createTempDirectory("ycd-dispatch-corrupt-write-home2-").toFile().apply { deleteOnExit() }
        val docx = buildDocxWithMalformedCommentsXml()
        WorkingDirStore(home).add(WorkingDir(label = "corrupt-write", path = docx.parentFile!!.canonicalPath))
        val before = docx.readBytes()
        val result = resolveNativeDocxComment(docx.absolutePath, null, "w-0", home)
        assertEquals(NativeMutateResult.Err(DocxWriteError.INVALID_DOCX.wire), result)
        assertTrue(docx.readBytes().contentEquals(before))
    }

    @Test
    fun `moveNativeDocxComment refuses invalid-docx instead of crashing when comments xml is a corrupted (bad-CRC) entry`() = runTest {
        val home = Files.createTempDirectory("ycd-dispatch-corrupt-crc-home-").toFile().apply { deleteOnExit() }
        val docx = buildDocxWithCorruptCommentsPartCrc()
        WorkingDirStore(home).add(WorkingDir(label = "corrupt-crc", path = docx.parentFile!!.canonicalPath))
        val before = docx.readBytes()
        val result = moveNativeDocxComment(docx.absolutePath, null, "w-0", textSelector("A commented sentence."), home)
        assertEquals(NativeMutateResult.Err(DocxWriteError.INVALID_DOCX.wire), result)
        assertTrue(docx.readBytes().contentEquals(before))
    }

    // ── Edit/delete build (2026-09-28, design doc §"Edit and delete") ───────

    @Test
    fun `editNativeDocxComment and deleteNativeDocxComment dispatch to the real T17 write pipeline`() = runTest {
        val home = Files.createTempDirectory("ycd-dispatch-edit-").toFile().apply { deleteOnExit() }
        val docx = fixtureFile("launch-brief.docx")
        WorkingDirStore(home).add(WorkingDir(label = "edit-delete fixture", path = docx.parentFile!!.canonicalPath))

        val edited = editNativeDocxComment(docx.absolutePath, null, "w-1", "edited via dispatch", home)
        assertTrue(edited is NativeMutateResult.Ok, "expected Ok, got $edited")
        assertEquals("edited via dispatch", (edited as NativeMutateResult.Ok).value)

        val deleted = deleteNativeDocxComment(docx.absolutePath, null, "w-0", home)
        assertTrue(deleted is NativeMutateResult.Ok, "expected Ok, got $deleted")

        val relisted = listNativeComments(NativeFormat.DOCX, docx.absolutePath, null, home)
        assertTrue(relisted is NativeListResult.Ok, "expected Ok, got $relisted")
        val comments = (relisted as NativeListResult.Ok).comments
        assertTrue(comments.none { it.id == "w-0" })
        assertEquals("edited via dispatch", comments.find { it.id == "w-1" }?.text)
    }

    @Test
    fun `editNativeXlsxComment and deleteNativeXlsxComment dispatch to the real T19 write pipeline`() = runTest {
        val home = Files.createTempDirectory("ycd-dispatch-edit-xlsx-").toFile().apply { deleteOnExit() }
        val xlsx = fixtureFile("docling-xlsx-comments.xlsx")
        WorkingDirStore(home).add(WorkingDir(label = "edit-delete xlsx fixture", path = xlsx.parentFile!!.canonicalPath))
        val before = listNativeComments(NativeFormat.XLSX, xlsx.absolutePath, null, home)
        assertTrue(before is NativeListResult.Ok, "expected Ok, got $before")
        val f7 = (before as NativeListResult.Ok).comments.find {
            it.selector is CommentSelector.Cell && (it.selector as CommentSelector.Cell).selector.cell == "F7"
        }
        assertTrue(f7 != null, "expected the F7 fixture thread")

        val edited = editNativeXlsxComment(xlsx.absolutePath, null, f7!!.id, "edited via dispatch", home)
        assertTrue(edited is NativeMutateResult.Ok, "expected Ok, got $edited")

        val deleted = deleteNativeXlsxComment(xlsx.absolutePath, null, f7.id, home)
        assertTrue(deleted is NativeMutateResult.Ok, "expected Ok, got $deleted")

        val relisted = listNativeComments(NativeFormat.XLSX, xlsx.absolutePath, null, home)
        assertTrue(relisted is NativeListResult.Ok, "expected Ok, got $relisted")
        assertTrue((relisted as NativeListResult.Ok).comments.none { it.id == f7.id })
    }

    @Test
    fun `editNativeDocxComment refuses invalid-docx instead of crashing when comments xml is not well-formed XML`() = runTest {
        val home = Files.createTempDirectory("ycd-dispatch-corrupt-edit-").toFile().apply { deleteOnExit() }
        val docx = buildDocxWithMalformedCommentsXml()
        WorkingDirStore(home).add(WorkingDir(label = "corrupt-edit", path = docx.parentFile!!.canonicalPath))
        val before = docx.readBytes()
        val result = editNativeDocxComment(docx.absolutePath, null, "w-0", "x", home)
        assertEquals(NativeMutateResult.Err(DocxWriteError.INVALID_DOCX.wire), result)
        assertTrue(docx.readBytes().contentEquals(before))
    }

    @Test
    fun `deleteNativeDocxComment refuses invalid-docx instead of crashing when comments xml is a corrupted (bad-CRC) entry`() = runTest {
        val home = Files.createTempDirectory("ycd-dispatch-corrupt-delete-").toFile().apply { deleteOnExit() }
        val docx = buildDocxWithCorruptCommentsPartCrc()
        WorkingDirStore(home).add(WorkingDir(label = "corrupt-delete", path = docx.parentFile!!.canonicalPath))
        val before = docx.readBytes()
        val result = deleteNativeDocxComment(docx.absolutePath, null, "w-0", home)
        assertEquals(NativeMutateResult.Err(DocxWriteError.INVALID_DOCX.wire), result)
        assertTrue(docx.readBytes().contentEquals(before))
    }
}
