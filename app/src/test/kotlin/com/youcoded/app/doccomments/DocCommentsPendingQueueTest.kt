// Pins T20 of the doc-comments build (docs/active/specs/2026-09-26-doc-
// comments-build-design.md §9.2): Android's half of the docx/xlsx pending-
// mutation queue — a Kotlin coroutine polling loop standing in for desktop's
// chokidar watcher (pending-mutation-queue.ts), applying a request through
// the SAME dispatch functions (DocCommentsDispatch.kt) the docComments:*
// bridge already uses. Mirrors desktop's own pending-mutation-queue.test.ts
// scenario for scenario: round-trip apply, a move request, token
// authorization (finding #1), an unrecognized `kind` (finding #3), a
// pre-planted/back-dated request never firing (finding #1, defense in
// depth), and orphaned .result.json sweeping (finding #4).
package com.youcoded.app.doccomments

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.json.JSONObject
import org.junit.After
import org.junit.Test
import java.io.File
import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private const val W_NS = """xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main""""
private const val W14_NS = """xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml""""

/** A minimal, valid, comments.xml-free .docx with two known sentences — one
 *  to add a comment on, one to move it to. No comments.xml part at all
 *  (mirrors T16/T17's own "a docx with no comments.xml part doesn't crash"
 *  coverage) — the queue's first "add" request is what creates it. */
private fun buildMinimalDocx(dir: File, name: String = "queue-fixture.docx"): File {
    val target = File(dir, name)
    java.util.zip.ZipOutputStream(target.outputStream()).use { zos ->
        fun entry(entryName: String, content: String) {
            zos.putNextEntry(java.util.zip.ZipEntry(entryName))
            zos.write(content.toByteArray(Charsets.UTF_8))
            zos.closeEntry()
        }
        entry(
            "[Content_Types].xml",
            """<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>""",
        )
        entry(
            "_rels/.rels",
            """<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>""",
        )
        entry(
            "word/_rels/document.xml.rels",
            """<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>""",
        )
        entry(
            "word/document.xml",
            """<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document $W_NS $W14_NS><w:body>""" +
                """<w:p w14:paraId="E0000001"><w:r><w:t xml:space="preserve">An uncommented sentence to add a NEW comment on.</w:t></w:r></w:p>""" +
                """<w:p w14:paraId="E0000002"><w:r><w:t xml:space="preserve">A destination sentence for a moved comment.</w:t></w:r></w:p>""" +
                """</w:body></w:document>""",
        )
    }
    return target
}

private fun tempDir(prefix: String): File = Files.createTempDirectory(prefix).toFile().apply { deleteOnExit() }

/** Waits on the thing itself (a file's existence) rather than a fixed sleep —
 *  test-suite-hygiene's own rule. Bounded so a genuine bug fails fast instead
 *  of hanging the suite. */
private fun waitFor(timeoutMs: Long = 5000, intervalMs: Long = 20, condition: () -> Boolean): Boolean {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline) {
        if (condition()) return true
        Thread.sleep(intervalMs)
    }
    return condition()
}

private fun addRequestJson(id: String, path: String, token: String, projectRootLie: String = "/nonsense"): JSONObject =
    JSONObject()
        .put("id", id)
        .put("kind", "add")
        .put("format", "docx")
        .put("path", path)
        .put("projectRoot", projectRootLie) // never trusted — see this file's own header
        .put("token", token)
        .put("createdAt", System.currentTimeMillis())
        .put("text", "a queued comment")
        .put("author", "assistant")
        .put(
            "selector",
            JSONObject().put("kind", "text").put(
                "selector",
                JSONObject().put("type", "TextQuoteSelector")
                    .put("exact", "An uncommented sentence to add a NEW comment on.")
                    .put("prefix", "").put("suffix", "").put("occurrence", 0),
            ),
        )

class DocCommentsPendingQueueTest {

    @After
    fun tearDown() {
        DocCommentsPendingQueue.resetForTest()
    }

    private fun startQueue(project: File, home: File, sessionId: String = "session-1", token: String = "tok-$sessionId"): CoroutineScope {
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        DocCommentsPendingQueue.start(scope, sessionId, project.absolutePath, home, File(home, ".claude"), token)
        return scope
    }

    private fun pendingDir(project: File): File = File(project, ".youcoded/comments/.pending").apply { mkdirs() }

    private fun writeRequest(pendingDir: File, id: String, json: JSONObject) {
        val f = File(pendingDir, "$id.json")
        val tmp = File(pendingDir, "$id.json.tmp")
        tmp.writeText(json.toString())
        tmp.renameTo(f) // atomic-ish rename, mirroring the real MCP script's own submit
    }

    @Test
    fun `an add request lands a real comment and the request file is removed after`() {
        val project = tempDir("ycd-queue-add-")
        val home = tempDir("ycd-queue-add-home-")
        buildMinimalDocx(project)
        val scope = startQueue(project, home)
        try {
            val pending = pendingDir(project)
            val token = "tok-session-1"
            writeRequest(pending, "req-1", addRequestJson("req-1", "queue-fixture.docx", token))

            val resultFile = File(pending, "req-1.result.json")
            assertTrue(waitFor { resultFile.exists() }, "result file never appeared")
            val result = JSONObject(resultFile.readText())
            assertTrue(result.optBoolean("ok"), "expected ok:true, got $result")
            assertTrue(result.has("id"))

            assertTrue(waitFor { !File(pending, "req-1.json").exists() }, "request file was never cleaned up")

            val comments = listNativeComments(NativeFormat.DOCX, File(project, "queue-fixture.docx").absolutePath, project.absolutePath, home)
            assertTrue(comments is NativeListResult.Ok)
            assertEquals(1, comments.comments.size)
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun `a move request round-trips through the queue against the shared fixture`() {
        val project = tempDir("ycd-queue-move-")
        val home = tempDir("ycd-queue-move-home-")
        val docx = buildMinimalDocx(project)
        val scope = startQueue(project, home)
        try {
            val pending = pendingDir(project)
            val token = "tok-session-1"

            // First, add — synchronously via the real dispatch (not the
            // queue) so we know the exact comment id to move.
            val added = kotlinx.coroutines.runBlocking {
                addNativeDocxComment(
                    docx.absolutePath, project.absolutePath,
                    CommentSelector.Text(TextQuoteSelector("An uncommented sentence to add a NEW comment on.", "", "", 0)),
                    "hello", "user", home,
                )
            }
            assertTrue(added is NativeMutateResult.Ok<String>)
            val commentId = added.value

            val moveReq = JSONObject()
                .put("id", "req-move")
                .put("kind", "move")
                .put("format", "docx")
                .put("path", "queue-fixture.docx")
                .put("projectRoot", "/nonsense")
                .put("token", token)
                .put("createdAt", System.currentTimeMillis())
                .put("commentId", commentId)
                .put(
                    "newSelector",
                    JSONObject().put("kind", "text").put(
                        "selector",
                        JSONObject().put("type", "TextQuoteSelector")
                            .put("exact", "A destination sentence for a moved comment.")
                            .put("prefix", "").put("suffix", "").put("occurrence", 0),
                    ),
                )
            writeRequest(pending, "req-move", moveReq)

            val resultFile = File(pending, "req-move.result.json")
            assertTrue(waitFor { resultFile.exists() }, "move result never appeared")
            val result = JSONObject(resultFile.readText())
            assertTrue(result.optBoolean("ok"), "expected ok:true, got $result")
            // Code review 2026-09-27, Android F2 (fixed alongside the stale
            // WHY comment on moveNativeXlsxComment): a docx move's id never
            // changes, so — unlike the xlsx case pinned below — this result
            // carries no `id` at all.
            assertFalse(result.has("id"))
        } finally {
            scope.cancel()
        }
    }

    /** `q3-sales-by-rep.xlsx`'s own genuine legacy Notes sit at B2/B18/B19/B20
     *  on this sheet (xl/comments1.xml) — D10 is deliberately NOT one of
     *  them, same caveat as desktop's matching test. */
    private fun xlsxFixtureFile(name: String): File {
        val resourceStream = object {}.javaClass.getResourceAsStream("/doc-comments/$name")
            ?: error("missing test resource doc-comments/$name")
        val tmp = Files.createTempFile("ycd-queue-xlsx-", "-$name").toFile()
        tmp.deleteOnExit()
        resourceStream.use { input -> tmp.outputStream().use { output -> input.copyTo(output) } }
        return tmp
    }

    // Code review 2026-09-27, Android F2 / desktop F1 parity: mirrors
    // desktop's pending-mutation-queue.test.ts's own "an xlsx move forwards
    // the fresh id in the result (F1 fix)" — pins that
    // DocCommentsPendingQueue.kt's `move` branch (fixed alongside the stale
    // WHY comment above `moveNativeXlsxComment`) now forwards the fresh id,
    // matching desktop's own queue and keeping the two platforms' MCP-facing
    // behavior in sync.
    @Test
    fun `an xlsx move forwards the fresh id in the result`() {
        val project = tempDir("ycd-queue-move-xlsx-")
        val home = tempDir("ycd-queue-move-xlsx-home-")
        val fixture = xlsxFixtureFile("q3-sales-by-rep.xlsx")
        val target = File(project, "q3.xlsx")
        fixture.copyTo(target, overwrite = true)
        val scope = startQueue(project, home)
        try {
            val pending = pendingDir(project)
            val token = "tok-session-1"

            val added = kotlinx.coroutines.runBlocking {
                addNativeXlsxComment(
                    target.absolutePath, project.absolutePath,
                    CommentSelector.Cell(CellSelector("A1", "Q3")),
                    "assistant note", "assistant", home,
                )
            }
            assertTrue(added is NativeMutateResult.Ok<String>)
            val oldId = added.value
            assertTrue(oldId.startsWith("xt-"))

            val moveReq = JSONObject()
                .put("id", "req-move-xlsx")
                .put("kind", "move")
                .put("format", "xlsx")
                .put("path", "q3.xlsx")
                .put("projectRoot", "/nonsense")
                .put("token", token)
                .put("createdAt", System.currentTimeMillis())
                .put("commentId", oldId)
                .put(
                    "newSelector",
                    JSONObject().put("kind", "cell").put(
                        "selector",
                        JSONObject().put("type", "CellSelector").put("cell", "D10").put("sheet", "Q3"),
                    ),
                )
            writeRequest(pending, "req-move-xlsx", moveReq)

            val resultFile = File(pending, "req-move-xlsx.result.json")
            assertTrue(waitFor { resultFile.exists() }, "move result never appeared")
            val result = JSONObject(resultFile.readText())
            assertTrue(result.optBoolean("ok"), "expected ok:true, got $result")
            assertTrue(result.has("id"), "expected the fresh id to be forwarded, got $result")
            assertTrue(result.getString("id").isNotEmpty())
            assertFalse(result.getString("id") == oldId, "the whole point of the fix: the id must be the FRESH one")
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun `a request with the WRONG token is refused, never applied`() {
        val project = tempDir("ycd-queue-badtoken-")
        val home = tempDir("ycd-queue-badtoken-home-")
        buildMinimalDocx(project)
        val scope = startQueue(project, home, token = "the-real-token")
        try {
            val pending = pendingDir(project)
            writeRequest(pending, "req-bad", addRequestJson("req-bad", "queue-fixture.docx", token = "forged-token"))

            val resultFile = File(pending, "req-bad.result.json")
            assertTrue(waitFor { resultFile.exists() })
            val result = JSONObject(resultFile.readText())
            assertFalse(result.optBoolean("ok"))
            assertEquals("invalid-request-token", result.optString("error"))

            val comments = listNativeComments(NativeFormat.DOCX, File(project, "queue-fixture.docx").absolutePath, project.absolutePath, home)
            assertTrue(comments is NativeListResult.Ok)
            assertEquals(0, comments.comments.size)
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun `a request with NO token field at all is refused`() {
        val project = tempDir("ycd-queue-notoken-")
        val home = tempDir("ycd-queue-notoken-home-")
        buildMinimalDocx(project)
        val scope = startQueue(project, home, token = "the-real-token")
        try {
            val pending = pendingDir(project)
            val req = addRequestJson("req-notoken", "queue-fixture.docx", token = "placeholder")
            req.remove("token")
            writeRequest(pending, "req-notoken", req)

            val resultFile = File(pending, "req-notoken.result.json")
            assertTrue(waitFor { resultFile.exists() })
            assertFalse(JSONObject(resultFile.readText()).optBoolean("ok"))
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun `a request carrying a DIFFERENT session's valid token, sharing the same project, is still accepted`() {
        val project = tempDir("ycd-queue-sharedproject-")
        val home = tempDir("ycd-queue-sharedproject-home-")
        buildMinimalDocx(project)
        val scopeA = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val scopeB = CoroutineScope(Dispatchers.IO + SupervisorJob())
        DocCommentsPendingQueue.start(scopeA, "session-A", project.absolutePath, home, File(home, ".claude"), "token-A")
        DocCommentsPendingQueue.start(scopeB, "session-B", project.absolutePath, home, File(home, ".claude"), "token-B")
        try {
            val pending = pendingDir(project)
            // Request carries session B's token — still valid, since both
            // sessions share this one project's queue entry.
            writeRequest(pending, "req-shared", addRequestJson("req-shared", "queue-fixture.docx", token = "token-B"))

            val resultFile = File(pending, "req-shared.result.json")
            assertTrue(waitFor { resultFile.exists() })
            assertTrue(JSONObject(resultFile.readText()).optBoolean("ok"))
        } finally {
            scopeA.cancel()
            scopeB.cancel()
        }
    }

    @Test
    fun `stopping only one of two refs still processes a request, stopping both stops processing`() {
        val project = tempDir("ycd-queue-refcount-")
        val home = tempDir("ycd-queue-refcount-home-")
        buildMinimalDocx(project)
        val scopeA = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val scopeB = CoroutineScope(Dispatchers.IO + SupervisorJob())
        DocCommentsPendingQueue.start(scopeA, "session-A", project.absolutePath, home, File(home, ".claude"), "token-A")
        DocCommentsPendingQueue.start(scopeB, "session-B", project.absolutePath, home, File(home, ".claude"), "token-B")
        try {
            DocCommentsPendingQueue.stop("session-A", project.absolutePath)

            val pending = pendingDir(project)
            writeRequest(pending, "req-after-stop-one", addRequestJson("req-after-stop-one", "queue-fixture.docx", token = "token-B"))
            val result1 = File(pending, "req-after-stop-one.result.json")
            assertTrue(waitFor { result1.exists() }, "queue stopped processing after only ONE of two refs was dropped")
            assertTrue(JSONObject(result1.readText()).optBoolean("ok"))

            DocCommentsPendingQueue.stop("session-B", project.absolutePath)
            writeRequest(pending, "req-after-stop-both", addRequestJson("req-after-stop-both", "queue-fixture.docx", token = "token-B"))
            val result2 = File(pending, "req-after-stop-both.result.json")
            // Negative assertion: bounded wait, then assert absence — the
            // suite's own "wait for the positive signal, then settle for the
            // negative" rule, not a longer positive wait re-labeled.
            assertFalse(waitFor(timeoutMs = 800) { result2.exists() }, "queue kept processing after BOTH refs were dropped")
        } finally {
            scopeA.cancel()
            scopeB.cancel()
        }
    }

    @Test
    fun `an unrecognized kind never mutates anything and reports unknown-mutation-kind`() {
        val project = tempDir("ycd-queue-badkind-")
        val home = tempDir("ycd-queue-badkind-home-")
        buildMinimalDocx(project)
        val scope = startQueue(project, home, token = "tok")
        try {
            val pending = pendingDir(project)
            val req = addRequestJson("req-badkind", "queue-fixture.docx", token = "tok")
            req.put("kind", "explode")
            writeRequest(pending, "req-badkind", req)

            val resultFile = File(pending, "req-badkind.result.json")
            assertTrue(waitFor { resultFile.exists() })
            val result = JSONObject(resultFile.readText())
            assertFalse(result.optBoolean("ok"))
            assertEquals("unknown-mutation-kind", result.optString("error"))

            val comments = listNativeComments(NativeFormat.DOCX, File(project, "queue-fixture.docx").absolutePath, project.absolutePath, home)
            assertEquals(0, (comments as NativeListResult.Ok).comments.size)
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun `a request missing kind entirely gets the same honest refusal`() {
        val project = tempDir("ycd-queue-nokind-")
        val home = tempDir("ycd-queue-nokind-home-")
        buildMinimalDocx(project)
        val scope = startQueue(project, home, token = "tok")
        try {
            val pending = pendingDir(project)
            val req = addRequestJson("req-nokind", "queue-fixture.docx", token = "tok")
            req.remove("kind")
            writeRequest(pending, "req-nokind", req)

            val resultFile = File(pending, "req-nokind.result.json")
            assertTrue(waitFor { resultFile.exists() })
            assertEquals("unknown-mutation-kind", JSONObject(resultFile.readText()).optString("error"))
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun `garbage JSON in the pending directory is ignored, and a real request afterward still works`() {
        val project = tempDir("ycd-queue-garbage-")
        val home = tempDir("ycd-queue-garbage-home-")
        buildMinimalDocx(project)
        val scope = startQueue(project, home, token = "tok")
        try {
            val pending = pendingDir(project)
            File(pending, "garbage.json").writeText("{ this is not json ][")

            // The garbage file is never touched (no matching id to build a
            // result path from) — assert it just sits there, then prove a
            // REAL request still gets processed afterward.
            assertFalse(waitFor(timeoutMs = 500) { !File(pending, "garbage.json").exists() })

            writeRequest(pending, "req-after-garbage", addRequestJson("req-after-garbage", "queue-fixture.docx", token = "tok"))
            val resultFile = File(pending, "req-after-garbage.result.json")
            assertTrue(waitFor { resultFile.exists() }, "a real request after garbage JSON was never processed")
            assertTrue(JSONObject(resultFile.readText()).optBoolean("ok"))
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun `a pre-planted, back-dated request is never applied, even with a valid token`() {
        val project = tempDir("ycd-queue-planted-")
        val home = tempDir("ycd-queue-planted-home-")
        buildMinimalDocx(project)
        val pending = pendingDir(project)
        // Plant the request BEFORE the queue starts, then back-date it well
        // past FRESHNESS_MARGIN_MS — mirrors a `git clone` stamping a
        // planted file's mtime as "now" at checkout time.
        val plantedId = "req-planted"
        writeRequest(pending, plantedId, addRequestJson(plantedId, "queue-fixture.docx", token = "tok"))
        val planted = File(pending, "$plantedId.json")
        assertTrue(planted.setLastModified(System.currentTimeMillis() - 60_000))

        val scope = startQueue(project, home, token = "tok")
        try {
            val resultFile = File(pending, "$plantedId.result.json")
            // Negative: bounded wait then assert absence.
            assertFalse(waitFor(timeoutMs = 1000) { resultFile.exists() }, "a back-dated, pre-planted request was applied")
            assertTrue(planted.exists(), "a refused request should be left in place, not silently deleted")
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun `a request written just as the queue starts is still processed (a genuine cold-start race)`() {
        val project = tempDir("ycd-queue-coldstart-")
        val home = tempDir("ycd-queue-coldstart-home-")
        buildMinimalDocx(project)
        val pending = pendingDir(project)
        val id = "req-coldstart"
        writeRequest(pending, id, addRequestJson(id, "queue-fixture.docx", token = "tok"))
        // No back-dating this time — its mtime is "now," within
        // FRESHNESS_MARGIN_MS of the queue's own startedAt.

        val scope = startQueue(project, home, token = "tok")
        try {
            val resultFile = File(pending, "$id.result.json")
            assertTrue(waitFor { resultFile.exists() }, "a genuine cold-start race request was never processed")
            assertTrue(JSONObject(resultFile.readText()).optBoolean("ok"))
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun `an orphaned result file older than the sweep threshold is removed on the next queue start`() {
        val project = tempDir("ycd-queue-sweep-")
        val home = tempDir("ycd-queue-sweep-home-")
        buildMinimalDocx(project)
        val pending = pendingDir(project)
        val orphan = File(pending, "ancient.result.json")
        orphan.writeText("""{"ok":true}""")
        assertTrue(orphan.setLastModified(System.currentTimeMillis() - (2 * 60 * 60 * 1000))) // 2h old

        val scope = startQueue(project, home, token = "tok")
        try {
            assertTrue(waitFor { !orphan.exists() }, "a stale orphaned result file was never swept")
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun `a path outside the project is refused honestly, never applied`() {
        val project = tempDir("ycd-queue-outside-")
        val home = tempDir("ycd-queue-outside-home-")
        val scope = startQueue(project, home, token = "tok")
        try {
            val pending = pendingDir(project)
            val req = addRequestJson("req-outside", "../../etc/passwd", token = "tok")
            writeRequest(pending, "req-outside", req)

            val resultFile = File(pending, "req-outside.result.json")
            assertTrue(waitFor { resultFile.exists() })
            assertFalse(JSONObject(resultFile.readText()).optBoolean("ok"))
        } finally {
            scope.cancel()
        }
    }
}
