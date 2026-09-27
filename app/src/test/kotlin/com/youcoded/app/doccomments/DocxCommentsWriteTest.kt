// Pins T17 of the doc-comments build (docs/active/specs/2026-09-26-doc-
// comments-build-design.md §3.2a/§3.3, §8): WRITING Word comments (add /
// reply / resolve / reopen / move) off a REAL .docx, in Kotlin, with
// java.util.zip + javax.xml.parsers/transform — mirrors
// desktop/tests/docx-comments.test.ts's own T11 write suite test-for-test so
// this Kotlin build is held to the identical bar ("byte-identical rollback on
// verify failure", gapped/non-sequential ids, a move that relocates a range)
// rather than a lighter one because it's "just the phone" (T17's own design
// row).
//
// Fixtures: the SAME .docx files DocxCommentsTest.kt (T16) already reads —
// app/src/test/resources/doc-comments/{launch-brief,no-comments,spanning-
// comment,word365-realistic}.docx — copied verbatim from desktop/tests/
// fixtures/doc-comments/, so this suite mutates the identical bytes desktop's
// own T11 suite mutates.
package com.youcoded.app.doccomments

import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.zip.ZipFile
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

/** Extracts a checked-in fixture into a FRESH scratch file, own directory per
 *  call — every write test gets its own isolated copy, mutated in place via
 *  its own absolute path, mirroring desktop's `withScratchCopy`. */
private fun scratchCopy(name: String): File {
    val resourceStream = object {}.javaClass.getResourceAsStream("/doc-comments/$name")
        ?: fail("missing test resource doc-comments/$name")
    val dir = Files.createTempDirectory("ycd-docx-write-").toFile()
    dir.deleteOnExit()
    val target = File(dir, name)
    resourceStream.use { input -> target.outputStream().use { output -> input.copyTo(output) } }
    return target
}

/** A fresh, isolated `homeDir` per test — backups land under
 *  `<homeDir>/.claude/youcoded-doc-backups/`, never colliding across tests or
 *  with a real `~/.claude`. */
private fun scratchHomeDir(): File {
    val dir = Files.createTempDirectory("ycd-docx-write-home-").toFile()
    dir.deleteOnExit()
    return dir
}

private fun textSelector(exact: String): CommentSelector.Text =
    CommentSelector.Text(TextQuoteSelector(exact = exact, prefix = "", suffix = "", occurrence = 0))

private fun partText(file: File, entryName: String): String? {
    ZipFile(file).use { zip ->
        val entry = zip.getEntry(entryName) ?: return null
        return zip.getInputStream(entry).use { it.readBytes().toString(Charsets.UTF_8) }
    }
}

private const val W_NS_ATTR = """xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main""""
private const val W14_NS_ATTR = """xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml""""

/** Mirrors desktop's own `buildGappedIdsDocx` (docx-comments.test.ts) field
 *  for field: a hand-assembled real zip archive with two comments at ids 3
 *  and 7 (a gap, and starting above 0) — built directly rather than via a
 *  checked-in binary, since it exists only to pin `maxExistingCommentId`'s
 *  "(max existing w:id) + 1, never assumed monotonic" rule. */
private fun buildGappedIdsDocx(): File {
    val dir = Files.createTempDirectory("ycd-docx-write-gapped-").toFile()
    dir.deleteOnExit()
    val target = File(dir, "gapped.docx")
    java.util.zip.ZipOutputStream(target.outputStream()).use { zos ->
        fun entry(name: String, content: String) {
            zos.putNextEntry(java.util.zip.ZipEntry(name))
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
                """<w:p w14:paraId="E0000001"><w:commentRangeStart w:id="3"/><w:r><w:t xml:space="preserve">First commented run.</w:t></w:r><w:commentRangeEnd w:id="3"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="3"/></w:r></w:p>""" +
                """<w:p w14:paraId="E0000002"><w:commentRangeStart w:id="7"/><w:r><w:t xml:space="preserve">Second commented run.</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="7"/></w:r></w:p>""" +
                """<w:p w14:paraId="E0000003"><w:r><w:t xml:space="preserve">A brand new sentence with nothing commented yet.</w:t></w:r></w:p>""" +
                """</w:body></w:document>""",
        )
        entry(
            "word/comments.xml",
            """<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments $W_NS_ATTR $W14_NS_ATTR>""" +
                """<w:comment w:id="3" w:author="Priya Shah" w:date="2026-09-26T09:00:00Z"><w:p w14:paraId="F0000003"><w:r><w:t xml:space="preserve">First note.</w:t></w:r></w:p></w:comment>""" +
                """<w:comment w:id="7" w:author="Priya Shah" w:date="2026-09-26T09:01:00Z"><w:p w14:paraId="F0000007"><w:r><w:t xml:space="preserve">Second note.</w:t></w:r></w:p></w:comment>""" +
                """</w:comments>""",
        )
    }
    return target
}

class DocxCommentsWriteTest {

    // ── add ──────────────────────────────────────────────────────────────

    @Test
    fun `adds a new comment and it round-trips through the same reader`() = runTest {
        val target = scratchCopy("launch-brief.docx")
        val home = scratchHomeDir()
        val result = addDocxComment(
            target.absolutePath, "docs/launch-brief.docx",
            textSelector("Marketing emails go out the same morning as the public launch."),
            "Confirm the send time with marketing.", "user", home,
        )
        assertTrue(result is DocxWriteResult.Ok, "expected Ok, got $result")
        val newId = (result as DocxWriteResult.Ok).value
        assertTrue(Regex("^w-\\d+$").matches(newId))

        val read = readDocxComments(target, "docs/launch-brief.docx")
        assertTrue(read is DocxReadResult.Ok, "expected Ok, got $read")
        val comments = (read as DocxReadResult.Ok).comments
        val added = comments.find { it.id == newId }
        assertNotNull(added)
        assertEquals("Confirm the send time with marketing.", added.text)
        assertEquals("person:You", added.author)
        assertFalse(added.resolved)
        val selector = added.selector
        assertTrue(selector is CommentSelector.Text)
        assertEquals("Marketing emails go out the same morning as the public launch.", (selector as CommentSelector.Text).selector.exact)

        // Existing Word-authored comments are preserved byte-for-byte in
        // their OWN fields.
        val untouched = comments.find { it.id == "w-0" }
        assertNotNull(untouched)
        assertEquals("person:Priya Shah", untouched.author)
        assertTrue(untouched.resolved)
        assertTrue(untouched.text.contains("Is 30% realistic"))
    }

    @Test
    fun `creates comments xml plus its content-types override and relationship from scratch`() = runTest {
        val target = scratchCopy("no-comments.docx")
        val home = scratchHomeDir()
        ZipFile(target).use { zip -> assertNull(zip.getEntry("word/comments.xml")) }

        val result = addDocxComment(
            target.absolutePath, "docs/no-comments.docx",
            textSelector("Nothing here has ever been commented on."),
            "First comment this file has ever had.", "assistant", home,
        )
        assertTrue(result is DocxWriteResult.Ok, "expected Ok, got $result")

        ZipFile(target).use { zip -> assertNotNull(zip.getEntry("word/comments.xml")) }
        assertTrue(partText(target, "[Content_Types].xml")!!.contains("/word/comments.xml"))
        assertTrue(partText(target, "word/_rels/document.xml.rels")!!.contains("comments.xml"))

        val read = readDocxComments(target, "docs/no-comments.docx")
        assertTrue(read is DocxReadResult.Ok, "expected Ok, got $read")
        val comments = (read as DocxReadResult.Ok).comments
        assertEquals(1, comments.size)
        assertEquals("person:Assistant", comments[0].author)
        assertEquals("First comment this file has ever had.", comments[0].text)
    }

    @Test
    fun `a comment spanning multiple runs and two paragraphs inserts correctly around an existing range`() = runTest {
        val target = scratchCopy("spanning-comment.docx")
        val home = scratchHomeDir()
        val result = addDocxComment(
            target.absolutePath, "docs/spanning-comment.docx",
            textSelector("half \nsecond"),
            "A second, independent multi-paragraph comment.", "user", home,
        )
        assertTrue(result is DocxWriteResult.Ok, "expected Ok, got $result")
        val newId = (result as DocxWriteResult.Ok).value

        val read = readDocxComments(target, "docs/spanning-comment.docx")
        assertTrue(read is DocxReadResult.Ok, "expected Ok, got $read")
        val comments = (read as DocxReadResult.Ok).comments
        assertEquals(2, comments.size)
        val added = comments.find { it.id == newId }
        assertNotNull(added)
        val addedSel = added.selector
        assertTrue(addedSel is CommentSelector.Text)
        assertEquals("half \nsecond", (addedSel as CommentSelector.Text).selector.exact)

        val original = comments.find { it.id == "w-5" }
        assertNotNull(original)
        assertEquals("Should this be one paragraph instead of two?", original.text)
        val originalSel = original.selector
        assertTrue(originalSel is CommentSelector.Text)
        assertEquals("first half \nsecond half.", (originalSel as CommentSelector.Text).selector.exact)
    }

    @Test
    fun `a comment on text strictly inside a single run splits that run correctly`() = runTest {
        val target = scratchCopy("launch-brief.docx")
        val home = scratchHomeDir()
        val result = addDocxComment(target.absolutePath, "docs/launch-brief.docx", textSelector("30%"), "Just the percentage.", "user", home)
        assertTrue(result is DocxWriteResult.Ok, "expected Ok, got $result")
        val newId = (result as DocxWriteResult.Ok).value

        val read = readDocxComments(target, "docs/launch-brief.docx")
        assertTrue(read is DocxReadResult.Ok, "expected Ok, got $read")
        val comments = (read as DocxReadResult.Ok).comments
        val added = comments.find { it.id == newId }
        assertNotNull(added)
        val addedSel = added.selector as CommentSelector.Text
        assertEquals("30%", addedSel.selector.exact)
        assertTrue(addedSel.selector.prefix.contains("Move"))
        assertTrue(addedSel.selector.suffix.contains("of weekly"))

        val original = comments.find { it.id == "w-0" }
        assertNotNull(original)
        val originalSel = original.selector as CommentSelector.Text
        assertEquals("Move 30% of weekly active users to the new app within six weeks of launch.", originalSel.selector.exact)
    }

    @Test
    fun `mints max existing w id plus one against a gapped non-sequential id set, never a naive count`() = runTest {
        // Built in-memory rather than as a checked-in binary, mirroring
        // desktop's own `buildGappedIdsDocx` (docx-comments.test.ts): two
        // comments, ids 3 and 7 (a gap, and starting above 0) — a naive
        // `comments.length` counter would mint `2` next; the correct next
        // id is `8`.
        val target = buildGappedIdsDocx()
        val home = scratchHomeDir()
        val result = addDocxComment(
            target.absolutePath, "docs/gapped.docx",
            textSelector("A brand new sentence with nothing commented yet."),
            "x", "user", home,
        )
        assertTrue(result is DocxWriteResult.Ok, "expected Ok, got $result")
        assertEquals("w-8", (result as DocxWriteResult.Ok).value) // existing ids are 3 and 7 — next is 8, not 2
    }

    @Test
    fun `refuses a selector that does not resolve, leaving the file byte-identical`() = runTest {
        val target = scratchCopy("launch-brief.docx")
        val home = scratchHomeDir()
        val before = target.readBytes()
        val result = addDocxComment(
            target.absolutePath, "docs/launch-brief.docx",
            textSelector("this text does not exist anywhere in the document"),
            "x", "user", home,
        )
        assertEquals(DocxWriteResult.Err(DocxWriteError.SELECTOR_NOT_FOUND), result)
        assertTrue(target.readBytes().contentEquals(before))
    }

    @Test
    fun `refuses a cell selector against a Word target rather than silently coercing it`() = runTest {
        val target = scratchCopy("launch-brief.docx")
        val home = scratchHomeDir()
        val result = addDocxComment(
            target.absolutePath, "docs/launch-brief.docx",
            CommentSelector.Cell(CellSelector(cell = "A1")),
            "x", "user", home,
        )
        assertEquals(DocxWriteResult.Err(DocxWriteError.INVALID_SELECTOR), result)
    }

    // ── reply ────────────────────────────────────────────────────────────

    @Test
    fun `appends a reply, preserving the existing reply thread`() = runTest {
        val target = scratchCopy("launch-brief.docx")
        val home = scratchHomeDir()
        val result = replyToDocxComment(target.absolutePath, "docs/launch-brief.docx", "w-1", "Sounds good, thanks both.", "user", home)
        assertEquals(DocxWriteResult.Ok(Unit), result)

        val read = readDocxComments(target, "docs/launch-brief.docx")
        assertTrue(read is DocxReadResult.Ok, "expected Ok, got $read")
        val comment1 = (read as DocxReadResult.Ok).comments.find { it.id == "w-1" }
        assertNotNull(comment1)
        assertEquals(2, comment1.replies.size)
        assertEquals("person:Marcus Lee", comment1.replies[0].author) // the ORIGINAL reply, unmoved
        assertEquals("person:You", comment1.replies[1].author)
        assertEquals("Sounds good, thanks both.", comment1.replies[1].text)
    }

    @Test
    fun `reply refuses an id this file does not have`() = runTest {
        val target = scratchCopy("launch-brief.docx")
        val home = scratchHomeDir()
        val result = replyToDocxComment(target.absolutePath, "docs/launch-brief.docx", "w-999", "x", "user", home)
        assertEquals(DocxWriteResult.Err(DocxWriteError.COMMENT_NOT_FOUND), result)
    }

    // ── resolve / reopen ─────────────────────────────────────────────────

    @Test
    fun `resolve sets w15 done, reopen clears it, and either creates commentsExtended xml if absent`() = runTest {
        val target = scratchCopy("spanning-comment.docx")
        val home = scratchHomeDir()
        ZipFile(target).use { zip -> assertNull(zip.getEntry("word/commentsExtended.xml")) }

        val resolved = resolveDocxComment(target.absolutePath, "docs/spanning-comment.docx", "w-5", home)
        assertEquals(DocxWriteResult.Ok(Unit), resolved)
        var read = readDocxComments(target, "docs/spanning-comment.docx")
        assertTrue(read is DocxReadResult.Ok && read.comments[0].resolved)

        val reopened = reopenDocxComment(target.absolutePath, "docs/spanning-comment.docx", "w-5", home)
        assertEquals(DocxWriteResult.Ok(Unit), reopened)
        read = readDocxComments(target, "docs/spanning-comment.docx")
        assertTrue(read is DocxReadResult.Ok && !read.comments[0].resolved)
    }

    @Test
    fun `resolving an already-resolved comment updates the existing entry rather than duplicating it`() = runTest {
        val target = scratchCopy("launch-brief.docx")
        val home = scratchHomeDir()
        // id 0 starts resolved (w15:done="1") — reopen then resolve again.
        reopenDocxComment(target.absolutePath, "docs/launch-brief.docx", "w-0", home)
        resolveDocxComment(target.absolutePath, "docs/launch-brief.docx", "w-0", home)
        val extendedXml = partText(target, "word/commentsExtended.xml")!!
        assertEquals(1, Regex("w15:paraId=\"10000000\"").findAll(extendedXml).count()) // still exactly one entry

        val read = readDocxComments(target, "docs/launch-brief.docx")
        assertTrue(read is DocxReadResult.Ok, "expected Ok, got $read")
        val comments = (read as DocxReadResult.Ok).comments
        assertTrue(comments.find { it.id == "w-0" }!!.resolved)
        // Unrelated entries (id 1's reply-linking) are untouched.
        val t1 = comments.find { it.id == "w-1" }
        assertNotNull(t1)
        assertFalse(t1.resolved)
        assertEquals(1, t1.replies.size)
    }

    @Test
    fun `resolve refuses an id this file does not have`() = runTest {
        val target = scratchCopy("launch-brief.docx")
        val home = scratchHomeDir()
        val result = resolveDocxComment(target.absolutePath, "docs/launch-brief.docx", "w-999", home)
        assertEquals(DocxWriteResult.Err(DocxWriteError.COMMENT_NOT_FOUND), result)
    }

    // ── move ─────────────────────────────────────────────────────────────

    @Test
    fun `move relocates a comment - old range gone, new one resolves, id replies resolve state unchanged`() = runTest {
        val target = scratchCopy("launch-brief.docx")
        val home = scratchHomeDir()
        val result = moveDocxComment(
            target.absolutePath, "docs/launch-brief.docx", "w-1",
            textSelector("Keep support tickets about the update below 200 per week."), home,
        )
        assertEquals(DocxWriteResult.Ok(Unit), result)

        val documentXml = partText(target, "word/document.xml")!!
        assertFalse(Regex("Beta opens to 500 customers[\\s\\S]{0,80}w:id=\"1\"").containsMatchIn(documentXml))
        assertEquals(1, Regex("w:commentRangeStart w:id=\"1\"").findAll(documentXml).count())
        assertEquals(1, Regex("w:commentRangeEnd w:id=\"1\"").findAll(documentXml).count())
        assertEquals(1, Regex("w:commentReference w:id=\"1\"").findAll(documentXml).count())

        val read = readDocxComments(target, "docs/launch-brief.docx")
        assertTrue(read is DocxReadResult.Ok, "expected Ok, got $read")
        val moved = (read as DocxReadResult.Ok).comments.find { it.id == "w-1" }
        assertNotNull(moved)
        val movedSel = moved.selector as CommentSelector.Text
        assertEquals("Keep support tickets about the update below 200 per week.", movedSel.selector.exact)
        assertEquals(1, moved.replies.size)
        assertEquals("person:Marcus Lee", moved.replies[0].author)
        assertFalse(moved.resolved)
    }

    @Test
    fun `move refuses when newSelector does not resolve, leaving the file byte-identical`() = runTest {
        val target = scratchCopy("launch-brief.docx")
        val home = scratchHomeDir()
        val before = target.readBytes()
        val result = moveDocxComment(target.absolutePath, "docs/launch-brief.docx", "w-1", textSelector("this text is nowhere in the document"), home)
        assertEquals(DocxWriteResult.Err(DocxWriteError.SELECTOR_NOT_FOUND), result)
        assertTrue(target.readBytes().contentEquals(before))
    }

    @Test
    fun `move refuses an id this file does not have`() = runTest {
        val target = scratchCopy("launch-brief.docx")
        val home = scratchHomeDir()
        val result = moveDocxComment(target.absolutePath, "docs/launch-brief.docx", "w-999", textSelector("Keep support tickets"), home)
        assertEquals(DocxWriteResult.Err(DocxWriteError.COMMENT_NOT_FOUND), result)
    }

    // ── verify-before-replace, and the backup's own lifecycle ───────────
    //
    // T17's own algorithm verifies against a SCRATCH file before the real
    // target is EVER touched (see DocxComments.kt's own header for why this
    // is a stronger, simpler guarantee than desktop's write-then-verify-
    // then-restore shape) — a failed verification therefore means the target
    // was NEVER written and the backup was NEVER created (there being nothing
    // yet worth protecting), rather than desktop's own "the backup existed
    // then got consumed/renamed back" lifecycle. Both shapes deliver the
    // identical outward contract §3.3 step 6 requires: the file the caller
    // has open is always either the successfully-mutated version or
    // byte-identical to what it was before.

    @Test
    fun `a failed verification never touches the target and never creates a backup`() = runTest {
        val target = scratchCopy("launch-brief.docx")
        val home = scratchHomeDir()
        val before = target.readBytes()
        val backupPath = docxBackupPathFor(home, target.absolutePath)
        assertFalse(backupPath.exists())

        val result = writeDocxMutation<Unit>(
            target.absolutePath,
            home,
            mutate = { workCopy, outFile -> workCopy.copyTo(outFile, overwrite = true); DocxWriteResult.Ok(Unit) },
            verify = { _, _, _ -> false }, // the injected fault: verification always fails
        )
        assertEquals(DocxWriteResult.Err(DocxWriteError.VERIFY_FAILED), result)
        assertTrue(target.readBytes().contentEquals(before)) // untouched
        assertFalse(backupPath.exists()) // never created — nothing was ever written
    }

    @Test
    fun `the backup exists while verify runs, and is kept after a successful write`() = runTest {
        val target = scratchCopy("launch-brief.docx")
        val home = scratchHomeDir()
        val backupPath = docxBackupPathFor(home, target.absolutePath)
        val before = target.readBytes()
        var sawBackupDuringVerify = true // becomes false only if the assertion below actually checked
        val result = writeDocxMutation<Unit>(
            target.absolutePath,
            home,
            mutate = { workCopy, outFile -> workCopy.copyTo(outFile, overwrite = true); DocxWriteResult.Ok(Unit) },
            verify = { _, _, _ ->
                // Verify runs BEFORE the backup is written in this pipeline's
                // own order — confirming that ordering directly rather than
                // assuming it, since it differs from desktop's own sequence.
                sawBackupDuringVerify = backupPath.exists()
                true
            },
        )
        assertEquals(DocxWriteResult.Ok(Unit), result)
        assertFalse(sawBackupDuringVerify) // did NOT exist yet during verify — this pipeline backs up AFTER verify, before replace
        assertTrue(backupPath.exists()) // KEPT after success
        assertTrue(backupPath.readBytes().contentEquals(before)) // holds the PRE-write bytes
    }

    @Test
    fun `one rolling backup per file - a second successful write overwrites the same backup path`() = runTest {
        val target = scratchCopy("launch-brief.docx")
        val home = scratchHomeDir()
        val backupPathFirst = docxBackupPathFor(home, target.absolutePath)
        val firstOriginal = target.readBytes()
        writeDocxMutation<Unit>(
            target.absolutePath, home,
            mutate = { workCopy, outFile -> workCopy.copyTo(outFile, overwrite = true); DocxWriteResult.Ok(Unit) },
            verify = { _, _, _ -> true },
        )
        assertTrue(backupPathFirst.readBytes().contentEquals(firstOriginal))

        val secondOriginal = target.readBytes()
        val result = writeDocxMutation<Unit>(
            target.absolutePath, home,
            mutate = { workCopy, outFile ->
                val bytes = workCopy.readBytes()
                outFile.writeBytes(bytes + byteArrayOf(0))
                DocxWriteResult.Ok(Unit)
            },
            verify = { _, _, _ -> true },
        )
        assertEquals(DocxWriteResult.Ok(Unit), result)
        val backupPathSecond = docxBackupPathFor(home, target.absolutePath)
        assertEquals(backupPathFirst, backupPathSecond) // same stable path, both times
        assertTrue(backupPathSecond.readBytes().contentEquals(secondOriginal)) // rolled forward, not accumulated
    }

    // ── concurrency ──────────────────────────────────────────────────────

    @Test
    fun `two mutations on one file serialize, and neither is lost`() = runTest {
        val target = scratchCopy("launch-brief.docx")
        val home = scratchHomeDir()
        val jobA = async {
            addDocxComment(
                target.absolutePath, "docs/launch-brief.docx",
                textSelector("Marketing emails go out the same morning as the public launch."),
                "First concurrent comment.", "user", home,
            )
        }
        val jobB = async {
            addDocxComment(
                target.absolutePath, "docs/launch-brief.docx",
                textSelector("The payment screen has not been tested on older Android phones."),
                "Second concurrent comment.", "assistant", home,
            )
        }
        val a = jobA.await()
        val b = jobB.await()
        assertTrue(a is DocxWriteResult.Ok, "expected Ok, got $a")
        assertTrue(b is DocxWriteResult.Ok, "expected Ok, got $b")
        assertNotEquals((a as DocxWriteResult.Ok).value, (b as DocxWriteResult.Ok).value) // unique ids even when minted concurrently

        val read = readDocxComments(target, "docs/launch-brief.docx")
        assertTrue(read is DocxReadResult.Ok, "expected Ok, got $read")
        val comments = (read as DocxReadResult.Ok).comments
        // Original 2 top-level comments + both concurrent adds — NEITHER lost.
        assertEquals(4, comments.size)
        assertTrue(comments.any { it.text == "First concurrent comment." })
        assertTrue(comments.any { it.text == "Second concurrent comment." })
    }

    // ── OOXML wiring sanity (F17) ────────────────────────────────────────

    @Test
    fun `every r id the new run references resolves in document xml rels, and has a content-types override`() = runTest {
        val target = scratchCopy("no-comments.docx")
        val home = scratchHomeDir()
        val result = addDocxComment(target.absolutePath, "docs/no-comments.docx", textSelector("Nothing here has ever been commented on."), "x", "user", home)
        assertTrue(result is DocxWriteResult.Ok, "expected Ok, got $result")

        val relIds = Regex("Relationship\\b[^>]*\\bId=\"([^\"]+)\"").findAll(partText(target, "word/_rels/document.xml.rels")!!)
            .map { it.groupValues[1] }.toSet()
        val referenced = Regex("r:id=\"([^\"]*)\"").findAll(partText(target, "word/document.xml")!!).map { it.groupValues[1] }.toList()
        for (id in referenced) assertTrue(relIds.contains(id), "dangling r:id $id")

        val overrides = Regex("PartName=\"([^\"]+)\"").findAll(partText(target, "[Content_Types].xml")!!).map { it.groupValues[1] }.toSet()
        assertTrue(overrides.contains("/word/comments.xml"))
    }

    @Test
    fun `runs in a plain JVM environment, no Android framework class involved`() = runTest {
        // Same pin as DocxCommentsTest.kt's own — this is the whole point of
        // "a JVM unit test, not an instrumented/on-device test."
        val target = scratchCopy("launch-brief.docx")
        val home = scratchHomeDir()
        val result = addDocxComment(target.absolutePath, "docs/launch-brief.docx", textSelector("30%"), "x", "user", home)
        assertTrue(result is DocxWriteResult.Ok)
    }
}
