// Pins T18 (read) and T19 (write) of the doc-comments build — REWRITTEN
// 2026-09-27 for Destin's threaded-comments-only decision (docs/active/specs/
// 2026-09-26-doc-comments-build-design.md §4.2/§4.3/§4.3a). Mirrors desktop's
// own `desktop/tests/xlsx-comments.test.ts` (T12/T13), a plain `./gradlew
// test` JVM unit test — no Android framework classes, no instrumented test.
//
// Fixtures: app/src/test/resources/doc-comments/{docling-xlsx-comments,
// elden-ring-completionist-checklist,synthetic-worksheet-with-extlst}.xlsx —
// the SAME two real, license-checked reference files (plus the shared
// synthetic extLst fixture) desktop's own T12/T13 tests read, copied verbatim
// from `shared-fixtures/doc-comments/{xlsx-threaded-reference/,
// synthetic-worksheet-with-extlst.xlsx}` — a fixture drift here would
// silently make the cross-platform parity claim (T21) compare two different
// inputs. `q3-sales-by-rep.xlsx` (already present, legacy-Notes-only) is kept
// for the "Notes are never shown" regression case §4.1 names by name.
//
// The shared id-parse test vectors (design review round 2, F2) are read
// directly off `shared-fixtures/doc-comments/id-parse-test-vectors.json`
// (never copied into test resources) — the same file desktop's own
// `xlsx-comments.test.ts` reads, so a fix to one runtime's parser that the
// other doesn't share fails immediately on this shared contract.
package com.youcoded.app.doccomments

import org.json.JSONObject
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.Collections
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream
import kotlinx.coroutines.test.runTest
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

private fun fixtureFile(name: String): File {
    val resourceStream = object {}.javaClass.getResourceAsStream("/doc-comments/$name")
        ?: fail("missing test resource doc-comments/$name")
    val tmp = Files.createTempFile("ycd-xlsx-", "-$name").toFile()
    tmp.deleteOnExit()
    resourceStream.use { input -> tmp.outputStream().use { output -> input.copyTo(output) } }
    return tmp
}

/** Walks upward from the current working directory looking for a shared,
 *  cross-runtime fixture under `shared-fixtures/` at the repo root — never
 *  copied into `app/src/test/resources/`, so a fix to this Kotlin module's
 *  parser and desktop's own TS parser both read the identical file (design
 *  review round 2, F2's own "one shared fixture, not two independently
 *  hand-built ones" discipline). Gradle's own working directory for `test`
 *  varies by invocation, so this searches rather than assumes one. */
private fun findSharedFixture(relative: String): File {
    var dir: File? = File(".").canonicalFile
    while (dir != null) {
        val candidate = File(dir, relative)
        if (candidate.exists()) return candidate
        dir = dir.parentFile
    }
    fail("could not locate shared fixture $relative from ${File(".").canonicalPath}")
}

private fun tempHome(): File = Files.createTempDirectory("ycd-xlsx-home-").toFile().apply { deleteOnExit() }

/** Copies `source`, replacing exactly one named zip entry's content — used to
 *  hand-craft the malformed/adversarial shapes (a duplicate-GUID pair, a
 *  record count past the ceiling) neither real fixture has, the same
 *  "hand-crafted, since neither real file has one" precedent desktop's own
 *  T13 pinning tests use for these exact cases. */
private fun withReplacedZipEntry(source: File, entryName: String, newContent: ByteArray): File {
    val out = Files.createTempFile("ycd-xlsx-mod-", ".xlsx").toFile()
    out.deleteOnExit()
    ZipFile(source).use { zin ->
        ZipOutputStream(out.outputStream()).use { zout ->
            for (entry in Collections.list(zin.entries())) {
                if (entry.isDirectory) continue
                val bytes = if (entry.name == entryName) newContent else zin.getInputStream(entry).use { it.readBytes() }
                zout.putNextEntry(ZipEntry(entry.name))
                zout.write(bytes)
                zout.closeEntry()
            }
        }
    }
    return out
}

private fun readZipEntryText(file: File, name: String): String? =
    ZipFile(file).use { zip -> zip.getEntry(name)?.let { zip.getInputStream(it).use { s -> s.readBytes() } }.let { it?.toString(Charsets.UTF_8) } }

private fun cellSelector(cell: String, sheet: String? = null): CommentSelector = CommentSelector.Cell(CellSelector(cell, sheet))

private fun commentAt(comments: List<PersistedComment>, cell: String): List<PersistedComment> =
    comments.filter { it.selector is CommentSelector.Cell && (it.selector as CommentSelector.Cell).selector.cell == cell }

class XlsxCommentsTest {

    // ── Read: the real Excel-authored (docling) fixture ────────────────────

    @Test
    fun `reads an unresolved root+reply thread on F7 and a root-only thread on G12, from real Excel`() {
        val result = readXlsxComments(fixtureFile("docling-xlsx-comments.xlsx"), "reports/docling.xlsx")
        assertTrue(result is XlsxReadResult.Ok, "expected Ok, got $result")
        val comments = (result as XlsxReadResult.Ok).comments

        val f7 = commentAt(comments, "F7")
        assertEquals(1, f7.size)
        assertEquals("Minimum number of saltwater ducks", f7[0].text)
        assertEquals("person:Jane Smith (JS)", f7[0].author)
        assertFalse(f7[0].resolved)
        assertEquals(1, f7[0].replies.size)
        assertEquals("I never thought it would be so low", f7[0].replies[0].text)
        assertEquals("person:Marcus Sterling (MS)", f7[0].replies[0].author)
        assertEquals("${f7[0].id}-r1", f7[0].replies[0].id)

        val g12 = commentAt(comments, "G12")
        assertEquals(1, g12.size)
        assertEquals("Maximum number of ducks", g12[0].text)
        assertFalse(g12[0].resolved)
        assertTrue(g12[0].replies.isEmpty())
    }

    @Test
    fun `never surfaces the genuine Notes on A1 or B2, from the SAME xl comments1 xml`() {
        val result = readXlsxComments(fixtureFile("docling-xlsx-comments.xlsx"), "reports/docling.xlsx")
        val comments = (result as XlsxReadResult.Ok).comments
        assertTrue(commentAt(comments, "A1").isEmpty())
        assertTrue(commentAt(comments, "B2").isEmpty())
        assertEquals(2, comments.size, "only F7 and G12 are threaded comments in this fixture")
    }

    @Test
    fun `stamps the single-sheet docling workbook with no sheet field on the selector`() {
        val result = readXlsxComments(fixtureFile("docling-xlsx-comments.xlsx"), "reports/docling.xlsx")
        val comments = (result as XlsxReadResult.Ok).comments
        for (c in comments) {
            val sel = c.selector
            assertTrue(sel is CommentSelector.Cell)
            assertNull((sel as CommentSelector.Cell).selector.sheet)
        }
    }

    // ── Read: the real Google-Sheets-exported (x18tc:-prefixed) fixture ────

    @Test
    fun `reads the SAME shape from an x18tc-prefixed Google Sheets file (namespace-agnostic parsing)`() {
        val result = readXlsxComments(fixtureFile("elden-ring-completionist-checklist.xlsx"), "reports/elden.xlsx")
        assertTrue(result is XlsxReadResult.Ok, "expected Ok, got $result")
        val comments = (result as XlsxReadResult.Ok).comments
        assertTrue(comments.isNotEmpty(), "a Google-Sheets x18tc:-prefixed file must not read as zero comments")
        // Multi-sheet workbook (10 sheets) — every comment's selector stamps
        // a `sheet` name, unlike the single-sheet docling fixture above.
        for (c in comments) {
            val sel = c.selector as CommentSelector.Cell
            assertNotNull(sel.selector.sheet, "a multi-sheet workbook must stamp `sheet` on every selector")
        }
    }

    @Test
    fun `groups cell B19 into FIVE separate, independent threads, none dropped or merged`() {
        val result = readXlsxComments(fixtureFile("elden-ring-completionist-checklist.xlsx"), "reports/elden.xlsx")
        val comments = (result as XlsxReadResult.Ok).comments
        val b19 = commentAt(comments, "B19")
        assertEquals(5, b19.size, "elden's real B19 cell carries 5 independent threads")
        // Reply counts per root, confirmed directly against the real fixture
        // excerpt (elden-threadedComment1-B19-excerpt.xml): 3, 0, 1, 0, 0 —
        // in SOME order (root document order, not sorted).
        val replyCounts = b19.map { it.replies.size }.sorted()
        assertEquals(listOf(0, 0, 0, 1, 3), replyCounts)
        // No two of the five share an app-level id.
        assertEquals(5, b19.map { it.id }.toSet().size)
    }

    // ── Read: a workbook with ONLY genuine Notes (no threaded comments) ────

    @Test
    fun `returns ZERO comments for a legacy-Notes-only workbook, never the retired reader's garbled output`() {
        val result = readXlsxComments(fixtureFile("q3-sales-by-rep.xlsx"), "reports/q3-sales-by-rep.xlsx")
        assertTrue(result is XlsxReadResult.Ok, "expected Ok, got $result")
        assertEquals(emptyList<PersistedComment>(), (result as XlsxReadResult.Ok).comments)
    }

    // ── The id parser: shared contract with desktop's TS port ──────────────

    @Test
    fun `parses every entry in the shared id-parse-test-vectors json identically to the pre-written regex`() {
        val fixture = findSharedFixture("shared-fixtures/doc-comments/id-parse-test-vectors.json")
        val json = JSONObject(fixture.readText())
        val vectors = json.getJSONArray("vectors")
        assertTrue(vectors.length() > 0)
        for (i in 0 until vectors.length()) {
            val v = vectors.getJSONObject(i)
            val input = v.getString("input")
            val parsed = parseXlsxThreadId(input)
            assertNotNull(parsed, "expected ${v.getString("case")} to parse: $input")
            assertEquals(v.getInt("sheetId"), parsed!!.sheetId, "sheetId for ${v.getString("case")}")
            assertEquals(v.getString("cell"), parsed.cell, "cell for ${v.getString("case")}")
            assertEquals(v.getString("guid"), parsed.guid, "guid for ${v.getString("case")}")
        }
    }

    // ── Write: add ───────────────────────────────────────────────────────

    @Test
    fun `add creates a new thread on a fresh cell and wires all four new parts`() = runTest {
        val xlsx = fixtureFile("docling-xlsx-comments.xlsx")
        val home = tempHome()
        val result = addXlsxComment(xlsx.absolutePath, "reports/docling.xlsx", cellSelector("C1"), "New thread here", "user", home)
        assertTrue(result is XlsxWriteResult.Ok, "expected Ok, got $result")
        val newId = (result as XlsxWriteResult.Ok).value

        val read = readXlsxComments(xlsx, "reports/docling.xlsx") as XlsxReadResult.Ok
        val added = read.comments.find { it.id == newId }
        assertNotNull(added)
        assertEquals("New thread here", added!!.text)
        // A round trip through persons.xml only ever preserves the DISPLAY
        // NAME ("You" for 'user' — commentAuthorToDisplayName), never the
        // original 'user'/'assistant'/'person:X' tag itself — the xlsx OOXML
        // format has no field for that distinction. Desktop's own T13
        // pinning test asserts the identical `person:You` shape after this
        // exact round trip (xlsx-comments.test.ts).
        assertEquals("person:You", added.author)
        assertFalse(added.resolved)
        assertTrue(added.replies.isEmpty())

        // The pre-existing F7/G12 threads (and the genuine Notes on A1/B2)
        // must survive this write untouched.
        assertEquals(1, commentAt(read.comments, "F7").size)
        assertEquals(1, commentAt(read.comments, "G12").size)
    }

    @Test
    fun `refuses cell-has-note when the target already carries a genuine Note`() = runTest {
        val xlsx = fixtureFile("docling-xlsx-comments.xlsx")
        val result = addXlsxComment(xlsx.absolutePath, "reports/docling.xlsx", cellSelector("A1"), "x", "user", tempHome())
        assertEquals(XlsxWriteResult.Err(XlsxWriteError.CELL_HAS_NOTE), result)
    }

    @Test
    fun `refuses cell-already-has-comment when the target already carries ANY thread`() = runTest {
        val xlsx = fixtureFile("docling-xlsx-comments.xlsx")
        val result = addXlsxComment(xlsx.absolutePath, "reports/docling.xlsx", cellSelector("F7"), "x", "user", tempHome())
        assertEquals(XlsxWriteResult.Err(XlsxWriteError.CELL_ALREADY_HAS_COMMENT), result)
    }

    @Test
    fun `reuses, never duplicates, this app's own person entry across two writes by the same identity`() = runTest {
        val xlsx = fixtureFile("docling-xlsx-comments.xlsx")
        val home = tempHome()
        assertTrue(addXlsxComment(xlsx.absolutePath, "reports/docling.xlsx", cellSelector("C1"), "one", "user", home) is XlsxWriteResult.Ok)
        assertTrue(addXlsxComment(xlsx.absolutePath, "reports/docling.xlsx", cellSelector("D1"), "two", "user", home) is XlsxWriteResult.Ok)

        val personsXml = readZipEntryText(xlsx, "xl/persons/person.xml") ?: fail("expected a persons.xml part after two writes")
        val count = Regex("providerId=\"YouCoded\"").findAll(personsXml).count()
        assertEquals(1, count, "two writes by the SAME identity must reuse one person entry, not mint two")
    }

    @Test
    fun `mints a fresh person entry per distinct display name`() = runTest {
        val xlsx = fixtureFile("docling-xlsx-comments.xlsx")
        val home = tempHome()
        assertTrue(addXlsxComment(xlsx.absolutePath, "reports/docling.xlsx", cellSelector("C1"), "one", "user", home) is XlsxWriteResult.Ok)
        assertTrue(addXlsxComment(xlsx.absolutePath, "reports/docling.xlsx", cellSelector("D1"), "two", "assistant", home) is XlsxWriteResult.Ok)
        val personsXml = readZipEntryText(xlsx, "xl/persons/person.xml")!!
        assertEquals(2, Regex("providerId=\"YouCoded\"").findAll(personsXml).count())
    }

    // ── Write: reply ────────────────────────────────────────────────────

    @Test
    fun `reply appends to the ROOT and rebuilds the legacy placeholder body`() = runTest {
        val xlsx = fixtureFile("docling-xlsx-comments.xlsx")
        val home = tempHome()
        val before = (readXlsxComments(xlsx, "reports/docling.xlsx") as XlsxReadResult.Ok).comments
        val g12Id = commentAt(before, "G12").single().id

        val result = replyToXlsxComment(xlsx.absolutePath, "reports/docling.xlsx", g12Id, "a fresh reply", "user", home)
        assertTrue(result is XlsxWriteResult.Ok, "expected Ok, got $result")
        val reply = (result as XlsxWriteResult.Ok).value
        assertEquals("a fresh reply", reply.text)
        assertEquals("$g12Id-r1", reply.id)

        val after = (readXlsxComments(xlsx, "reports/docling.xlsx") as XlsxReadResult.Ok).comments
        val g12 = commentAt(after, "G12").single()
        assertEquals(1, g12.replies.size)
        assertEquals("a fresh reply", g12.replies[0].text)

        // Legacy placeholder body was rebuilt to include the new reply, in
        // real-Excel layout — §4.2's own exact shape.
        val commentsXml = readZipEntryText(xlsx, "xl/comments1.xml")!!
        assertTrue(commentsXml.contains("Reply:\n    a fresh reply"))
    }

    @Test
    fun `reply refuses comment-not-found for an id with a well-formed shape but no matching thread`() = runTest {
        val xlsx = fixtureFile("docling-xlsx-comments.xlsx")
        val result = replyToXlsxComment(
            xlsx.absolutePath, "reports/docling.xlsx",
            "xt-1-Z99-00000000-0000-0000-0000-000000000000", "x", "user", tempHome(),
        )
        assertEquals(XlsxWriteError.COMMENT_NOT_FOUND, (result as XlsxWriteResult.Err).error)
    }

    // ── Write: resolve / reopen ─────────────────────────────────────────

    @Test
    fun `resolve sets done on the root only, and NEVER touches the legacy placeholder text`() = runTest {
        val xlsx = fixtureFile("docling-xlsx-comments.xlsx")
        val home = tempHome()
        val before = (readXlsxComments(xlsx, "reports/docling.xlsx") as XlsxReadResult.Ok).comments
        val g12Id = commentAt(before, "G12").single().id
        val placeholderBefore = readZipEntryText(xlsx, "xl/comments1.xml")!!

        val result = resolveXlsxComment(xlsx.absolutePath, "reports/docling.xlsx", g12Id, home)
        assertTrue(result is XlsxWriteResult.Ok, "expected Ok, got $result")

        val after = (readXlsxComments(xlsx, "reports/docling.xlsx") as XlsxReadResult.Ok).comments
        assertTrue(commentAt(after, "G12").single().resolved)
        val placeholderAfter = readZipEntryText(xlsx, "xl/comments1.xml")!!
        assertEquals(placeholderBefore, placeholderAfter, "resolve must never touch the legacy placeholder text")
    }

    @Test
    fun `reopen REMOVES the done attribute entirely, never writes done equals 0`() = runTest {
        val xlsx = fixtureFile("docling-xlsx-comments.xlsx")
        val home = tempHome()
        val before = (readXlsxComments(xlsx, "reports/docling.xlsx") as XlsxReadResult.Ok).comments
        val g12Id = commentAt(before, "G12").single().id

        assertTrue(resolveXlsxComment(xlsx.absolutePath, "reports/docling.xlsx", g12Id, home) is XlsxWriteResult.Ok)
        val reopenResult = reopenXlsxComment(xlsx.absolutePath, "reports/docling.xlsx", g12Id, home)
        assertTrue(reopenResult is XlsxWriteResult.Ok, "expected Ok, got $reopenResult")

        val threadedXml = readZipEntryText(xlsx, "xl/threadedComments/threadedComment1.xml")!!
        assertFalse(threadedXml.contains("done=\"0\""), "reopen must remove `done` entirely, never write done=\"0\"")
        val after = (readXlsxComments(xlsx, "reports/docling.xlsx") as XlsxReadResult.Ok).comments
        assertFalse(commentAt(after, "G12").single().resolved)
    }

    @Test
    fun `resolving one of FIVE independent threads on the same cell never disturbs its siblings`() = runTest {
        val xlsx = fixtureFile("elden-ring-completionist-checklist.xlsx")
        val home = tempHome()
        val before = (readXlsxComments(xlsx, "reports/elden.xlsx") as XlsxReadResult.Ok).comments
        val b19Before = commentAt(before, "B19")
        assertEquals(5, b19Before.size)
        // The real elden fixture's own B19 excerpt has all 5 roots done="1"
        // at the time this fixture was captured — pick an unresolved one if
        // any exist (exercising reopen->resolve wouldn't be as interesting),
        // otherwise fall back to the first root and reopen it instead.
        val target = b19Before.firstOrNull { !it.resolved } ?: b19Before.first()
        val targetId = target.id
        val wasResolved = target.resolved

        val result = if (wasResolved) reopenXlsxComment(xlsx.absolutePath, "reports/elden.xlsx", targetId, home)
        else resolveXlsxComment(xlsx.absolutePath, "reports/elden.xlsx", targetId, home)
        assertTrue(result is XlsxWriteResult.Ok, "expected Ok, got $result")

        val after = (readXlsxComments(xlsx, "reports/elden.xlsx") as XlsxReadResult.Ok).comments
        val b19After = commentAt(after, "B19")
        assertEquals(5, b19After.size, "no sibling thread on B19 was created or dropped")
        val changed = b19After.find { it.id == targetId }!!
        assertEquals(!wasResolved, changed.resolved)
        // Every OTHER root's own resolved state and reply count is untouched.
        for (before2 in b19Before.filter { it.id != targetId }) {
            val after2 = b19After.find { it.id == before2.id }!!
            assertEquals(before2.resolved, after2.resolved)
            assertEquals(before2.replies.size, after2.replies.size)
        }
    }

    // ── Write: move ─────────────────────────────────────────────────────

    @Test
    fun `move relocates a thread to a new cell, keeping the same id-chain and text`() = runTest {
        val xlsx = fixtureFile("docling-xlsx-comments.xlsx")
        val home = tempHome()
        val before = (readXlsxComments(xlsx, "reports/docling.xlsx") as XlsxReadResult.Ok).comments
        val g12Id = commentAt(before, "G12").single().id

        val result = moveXlsxComment(xlsx.absolutePath, "reports/docling.xlsx", g12Id, cellSelector("H20"), home)
        assertTrue(result is XlsxWriteResult.Ok, "expected Ok, got $result")
        val freshId = (result as XlsxWriteResult.Ok).value
        assertTrue(freshId.contains("-H20-"), "a moved thread's fresh id embeds the NEW cell, got $freshId")

        val after = (readXlsxComments(xlsx, "reports/docling.xlsx") as XlsxReadResult.Ok).comments
        assertTrue(commentAt(after, "G12").isEmpty(), "the OLD cell must no longer carry this thread")
        val moved = commentAt(after, "H20").single()
        assertEquals("Maximum number of ducks", moved.text)
        assertFalse(moved.resolved)
    }

    @Test
    fun `refuses destination-cell-occupied when the destination already carries a DIFFERENT thread`() = runTest {
        val xlsx = fixtureFile("docling-xlsx-comments.xlsx")
        val before = (readXlsxComments(xlsx, "reports/docling.xlsx") as XlsxReadResult.Ok).comments
        val g12Id = commentAt(before, "G12").single().id
        val result = moveXlsxComment(xlsx.absolutePath, "reports/docling.xlsx", g12Id, cellSelector("F7"), tempHome())
        assertEquals(XlsxWriteError.DESTINATION_CELL_OCCUPIED, (result as XlsxWriteResult.Err).error)
    }

    @Test
    fun `refuses cell-has-note when move's destination already carries a genuine Note`() = runTest {
        val xlsx = fixtureFile("docling-xlsx-comments.xlsx")
        val before = (readXlsxComments(xlsx, "reports/docling.xlsx") as XlsxReadResult.Ok).comments
        val g12Id = commentAt(before, "G12").single().id
        val result = moveXlsxComment(xlsx.absolutePath, "reports/docling.xlsx", g12Id, cellSelector("A1"), tempHome())
        assertEquals(XlsxWriteError.CELL_HAS_NOTE, (result as XlsxWriteResult.Err).error)
    }

    @Test
    fun `move never mints fresh GUIDs — reply history and resolve state survive exactly`() = runTest {
        val xlsx = fixtureFile("docling-xlsx-comments.xlsx")
        val home = tempHome()
        val before = (readXlsxComments(xlsx, "reports/docling.xlsx") as XlsxReadResult.Ok).comments
        val f7Before = commentAt(before, "F7").single()

        val result = moveXlsxComment(xlsx.absolutePath, "reports/docling.xlsx", f7Before.id, cellSelector("K1"), home)
        assertTrue(result is XlsxWriteResult.Ok, "expected Ok, got $result")

        val after = (readXlsxComments(xlsx, "reports/docling.xlsx") as XlsxReadResult.Ok).comments
        val moved = commentAt(after, "K1").single()
        assertEquals(f7Before.replies.size, moved.replies.size)
        assertEquals(f7Before.replies[0].text, moved.replies[0].text)
        assertEquals(f7Before.replies[0].author, moved.replies[0].author)
        assertEquals(f7Before.text, moved.text)
    }

    // ── Illegal XML control characters: STRIPPED, not refused ────────────

    @Test
    fun `strips XML-illegal control characters from comment text instead of refusing`() = runTest {
        val xlsx = fixtureFile("docling-xlsx-comments.xlsx")
        val home = tempHome()
        val dirty = "before\u0001\u0002\u001Fafter"
        val result = addXlsxComment(xlsx.absolutePath, "reports/docling.xlsx", cellSelector("C1"), dirty, "user", home)
        assertTrue(result is XlsxWriteResult.Ok, "expected Ok (stripped, not refused), got $result")
        val newId = (result as XlsxWriteResult.Ok).value
        val added = (readXlsxComments(xlsx, "reports/docling.xlsx") as XlsxReadResult.Ok).comments.find { it.id == newId }!!
        assertEquals("beforeafter", added.text)
    }

    @Test
    fun `still allows tab, newline and carriage return in comment text`() = runTest {
        val xlsx = fixtureFile("docling-xlsx-comments.xlsx")
        val home = tempHome()
        val text = "a\tb\nc\rd"
        val result = addXlsxComment(xlsx.absolutePath, "reports/docling.xlsx", cellSelector("C1"), text, "user", home)
        assertTrue(result is XlsxWriteResult.Ok, "expected Ok, got $result")
        val newId = (result as XlsxWriteResult.Ok).value
        val added = (readXlsxComments(xlsx, "reports/docling.xlsx") as XlsxReadResult.Ok).comments.find { it.id == newId }!!
        assertEquals(text, added.text)
    }

    // ── legacyDrawing-after-extLst ordering (synthetic fixture) ──────────

    @Test
    fun `lands legacyDrawing AFTER a pre-existing worksheet-level extLst, never before it`() = runTest {
        val xlsx = fixtureFile("synthetic-worksheet-with-extlst.xlsx")
        val home = tempHome()
        // Discover the single real sheet's own part path so this test doesn't
        // need to hardcode the synthetic fixture's own worksheet numbering.
        val before = readXlsxComments(xlsx, "reports/synthetic.xlsx")
        assertTrue(before is XlsxReadResult.Ok, "expected Ok, got $before")

        val result = addXlsxComment(xlsx.absolutePath, "reports/synthetic.xlsx", cellSelector("A1"), "first comment", "user", home)
        assertTrue(result is XlsxWriteResult.Ok, "expected Ok, got $result")

        val worksheetXml = readZipEntryText(xlsx, "xl/worksheets/sheet1.xml") ?: fail("expected xl/worksheets/sheet1.xml")
        val extLstIdx = worksheetXml.indexOf("<extLst")
        val legacyDrawingIdx = worksheetXml.indexOf("<legacyDrawing")
        assertTrue(extLstIdx >= 0, "the synthetic fixture must already have an extLst — the whole point of this test")
        assertTrue(legacyDrawingIdx > extLstIdx, "legacyDrawing must land AFTER extLst, never before it")
    }

    // ── The record-count ceiling (design review 1, F3) ───────────────────

    @Test
    fun `refuses a read past the record-count ceiling with a distinct, typed error`() {
        val base = fixtureFile("docling-xlsx-comments.xlsx")
        // MAX_COMMENT_RECORDS (private in XlsxComments.kt) mirrors desktop's
        // own 20000 — hardcoded here the same way desktop's own test hardcodes
        // its ceiling-plus-one fixture, rather than exporting an
        // implementation constant purely for a test to read.
        val many = buildString {
            append("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>")
            append("<ThreadedComments xmlns=\"http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments\" xmlns:x=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">")
            repeat(20001) { i -> append("<threadedComment ref=\"A1\" id=\"{00000000-0000-0000-0000-${i.toString().padStart(12, '0')}}\"><text>x</text></threadedComment>") }
            append("</ThreadedComments>")
        }
        val modified = withReplacedZipEntry(base, "xl/threadedComments/threadedComment1.xml", many.toByteArray(Charsets.UTF_8))
        val result = readXlsxComments(modified, "reports/many.xlsx")
        assertEquals(XlsxReadResult.Err(XlsxReadError.TOO_MANY_COMMENTS), result)
    }

    // ── Ambiguous-id refusal (design review round 2, F3) ─────────────────

    @Test
    fun `refuses ambiguous-comment-id when the fallback scan finds TWO roots sharing one GUID`() = runTest {
        val base = fixtureFile("docling-xlsx-comments.xlsx")
        val dupGuid = "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}"
        val threaded = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
            "<ThreadedComments xmlns=\"http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments\" xmlns:x=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">" +
            "<threadedComment ref=\"A1\" dT=\"2020-01-01T00:00:00.00\" personId=\"{ED88F4F5-A552-4A41-970D-6B23DC2319F4}\" id=\"$dupGuid\"><text>one</text></threadedComment>" +
            "<threadedComment ref=\"B2\" dT=\"2020-01-01T00:00:00.00\" personId=\"{ED88F4F5-A552-4A41-970D-6B23DC2319F4}\" id=\"$dupGuid\"><text>two</text></threadedComment>" +
            "</ThreadedComments>"
        val modified = withReplacedZipEntry(base, "xl/threadedComments/threadedComment1.xml", threaded.toByteArray(Charsets.UTF_8))
        // sheetId 999 never resolves, forcing straight past the hinted lookup
        // into the fallback scan, which must find BOTH roots and refuse
        // rather than silently acting on whichever the scan order hits first.
        val id = "xt-999-Z1-${dupGuid.replace("{", "").replace("}", "")}"
        val result = resolveXlsxComment(modified.absolutePath, "reports/dup.xlsx", id, tempHome())
        assertEquals(XlsxWriteError.AMBIGUOUS_COMMENT_ID, (result as XlsxWriteResult.Err).error)
    }

    // ── Verify-after-write, with rollback semantics (verify-BEFORE-replace) ──

    @Test
    fun `a forced verify failure never touches the real target file`() = runTest {
        // Mirrors DocxCommentsWriteTest.kt's own "a failed verification never
        // touches the target and never creates a backup" — the `mutate`
        // closure here is a trivial pass-through (a real archive mutation
        // isn't the point of this test; the pipeline's OWN ordering is), the
        // same simplification that test uses.
        val xlsx = fixtureFile("docling-xlsx-comments.xlsx")
        val originalBytes = xlsx.readBytes()
        val home = tempHome()
        val backupPath = xlsxBackupPathFor(home, xlsx.absolutePath)
        assertFalse(backupPath.exists())

        val result = writeXlsxMutation<Unit>(
            xlsx.absolutePath,
            home,
            mutate = { workCopy, outFile -> workCopy.copyTo(outFile, overwrite = true); XlsxWriteResult.Ok(Unit) },
            verify = { _, _, _ -> false }, // the injected fault: verification always fails
        )
        assertEquals(XlsxWriteError.VERIFY_FAILED, (result as XlsxWriteResult.Err).error)
        assertTrue(originalBytes.contentEquals(xlsx.readBytes()), "a failed verify must leave the target byte-identical to the original")
        assertFalse(backupPath.exists(), "no backup should be written when verify never lets the pipeline get that far")
    }

    @Test
    fun `leaves a rolling backup at the documented, hashed path after a successful write`() = runTest {
        val xlsx = fixtureFile("docling-xlsx-comments.xlsx")
        val originalBytes = xlsx.readBytes()
        val home = tempHome()
        assertTrue(addXlsxComment(xlsx.absolutePath, "reports/docling.xlsx", cellSelector("C1"), "x", "user", home) is XlsxWriteResult.Ok)
        val backup = xlsxBackupPathFor(home, xlsx.absolutePath)
        assertTrue(backup.exists(), "expected a backup at $backup")
        assertTrue(originalBytes.contentEquals(backup.readBytes()), "the backup must hold the PRE-write bytes")
    }

    @Test
    fun `a fresh mutation against a comment never previously listed in this process still succeeds`() = runTest {
        // Review 3, F1's own cold-start case, ported: no prior list()/read
        // call in this test at all before the mutation — the id is looked up
        // fresh, straight off the file.
        val xlsx = fixtureFile("docling-xlsx-comments.xlsx")
        val home = tempHome()
        val knownG12Id = buildXlsxThreadIdForTest(1, "G12", "{3A26E9AE-8B38-864D-BAF4-BA5D9C6E1DA4}")
        val result = resolveXlsxComment(xlsx.absolutePath, "reports/docling.xlsx", knownG12Id, home)
        assertTrue(result is XlsxWriteResult.Ok, "expected Ok, got $result")
    }
}

// Test-only helper mirroring `buildXlsxThreadId`'s own (private) shape —
// duplicated rather than exposed, since only this one cold-start test needs
// to construct an id from raw parts rather than reading one off a prior
// `readXlsxComments`/write call.
private fun buildXlsxThreadIdForTest(sheetId: Int, cell: String, guidBraced: String): String =
    "xt-$sheetId-$cell-${guidBraced.replace("{", "").replace("}", "")}"
