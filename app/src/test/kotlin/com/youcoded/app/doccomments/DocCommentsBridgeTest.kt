// F6 (T4 doc-comments implementation review): drives handleDocCommentsMessage
// — the pure function DocCommentsBridge.kt extracted out of SessionService.
// handleBridgeMessage's docComments:* `when` block (see that file's own
// header for why) — and asserts the REAL response JSON shape for every
// message type: exact key sets, `ok`/`error` codes, and value types, never a
// regex over a serialized string. Complements DocCommentsStoreTest.kt (which
// drives the store functions directly) by pinning the IPC-facing envelope.
package com.youcoded.app.doccomments

import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Test
import java.io.File
import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private fun tempRoot(): File = Files.createTempDirectory("ycd-doccomments-bridge-").toFile().apply { deleteOnExit() }

private val TEXT_SELECTOR_JSON = JSONObject()
    .put("kind", "text")
    .put(
        "selector",
        JSONObject().put("type", "TextQuoteSelector").put("exact", "hello").put("prefix", "").put("suffix", " world").put("occurrence", 0),
    )

private fun cellSelectorJson(cell: String): JSONObject =
    JSONObject().put("kind", "cell").put("selector", JSONObject().put("type", "CellSelector").put("cell", cell))

/** Copies a real test-resource fixture (`/doc-comments/<name>`) to
 *  `<root>/<relativePath>` — used by F3 (android-xlsx-review)'s bridge-level
 *  end-to-end test so `docComments:*` messages can be driven against a REAL
 *  `.xlsx` file on disk, not a nonexistent-target routing check. */
private fun copyFixtureInto(root: File, name: String, relativePath: String): File {
    val dest = File(root, relativePath)
    dest.parentFile?.mkdirs()
    val resourceStream = object {}.javaClass.getResourceAsStream("/doc-comments/$name")
        ?: error("missing test resource doc-comments/$name")
    resourceStream.use { input -> dest.outputStream().use { output -> input.copyTo(output) } }
    return dest
}

class DocCommentsBridgeTest {

    @Test
    fun `an unrecognized message type is not owned by this handler`() = runTest {
        val response = handleDocCommentsMessage("something:else", JSONObject(), tempRoot(), emptyList())
        assertNull(response)
    }

    @Test
    fun `list with no path refuses missing-field for path`() = runTest {
        val response = handleDocCommentsMessage("docComments:list", JSONObject(), tempRoot(), emptyList())!!
        assertEquals(false, response.getBoolean("ok"))
        assertEquals("missing-field", response.getString("error"))
        assertEquals("path", response.getString("field"))
    }

    @Test
    fun `list against a file with no sidecar returns ok true and an empty comments array, exactly those two keys`() = runTest {
        val root = tempRoot()
        val payload = JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path)
        val response = handleDocCommentsMessage("docComments:list", payload, root, listOf(root.path))!!
        assertEquals(true, response.getBoolean("ok"))
        assertEquals(0, response.getJSONArray("comments").length())
        assertEquals(setOf("ok", "comments"), response.keys().asSequence().toSet())
    }

    @Test
    fun `an unrecognized projectRoot refuses unknown-project-root before ever touching the store`() = runTest {
        val root = tempRoot()
        val unknown = tempRoot()
        val payload = JSONObject().put("path", "docs/plan.md").put("projectRoot", unknown.path)
        val response = handleDocCommentsMessage("docComments:list", payload, root, listOf(root.path))!!
        assertEquals(JSONObject().put("ok", false).put("error", "unknown-project-root").toString(), response.toString())
    }

    @Test
    fun `add returns ok true and a real generated comment id, and list then reflects it`() = runTest {
        val root = tempRoot()
        val addPayload = JSONObject()
            .put("path", "docs/plan.md")
            .put("projectRoot", root.path)
            .put("text", "Can we cut this?")
            .put("selector", TEXT_SELECTOR_JSON)
        val addResponse = handleDocCommentsMessage("docComments:add", addPayload, root, listOf(root.path))!!
        assertEquals(true, addResponse.getBoolean("ok"))
        val id = addResponse.getString("id")
        assertTrue(id.startsWith("c-"), "expected a c-<uuid> id, got $id")
        assertEquals(setOf("ok", "id"), addResponse.keys().asSequence().toSet())

        val listResponse = handleDocCommentsMessage(
            "docComments:list",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path),
            root, listOf(root.path),
        )!!
        assertEquals(1, listResponse.getJSONArray("comments").length())
        assertEquals(id, listResponse.getJSONArray("comments").getJSONObject(0).getString("id"))
    }

    // F4 (T5 implementation review): the shared React UI's renderer store
    // mints the comment id and sends it on the payload — forwarded straight
    // through to the store here, mirroring desktop's own ipc-handlers.ts.
    @Test
    fun `forwards a caller-supplied id straight through to the store`() = runTest {
        val root = tempRoot()
        val callerId = "c-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        val addPayload = JSONObject()
            .put("path", "docs/plan.md")
            .put("projectRoot", root.path)
            .put("text", "hello")
            .put("selector", TEXT_SELECTOR_JSON)
            .put("id", callerId)
        val addResponse = handleDocCommentsMessage("docComments:add", addPayload, root, listOf(root.path))!!
        assertEquals(true, addResponse.getBoolean("ok"))
        assertEquals(callerId, addResponse.getString("id"))

        val listResponse = handleDocCommentsMessage(
            "docComments:list",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path),
            root, listOf(root.path),
        )!!
        assertEquals(callerId, listResponse.getJSONArray("comments").getJSONObject(0).getString("id"))
    }

    @Test
    fun `add with no selector refuses missing-field for selector`() = runTest {
        val root = tempRoot()
        val payload = JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path).put("text", "x")
        val response = handleDocCommentsMessage("docComments:add", payload, root, listOf(root.path))!!
        assertEquals("missing-field", response.getString("error"))
        assertEquals("selector", response.getString("field"))
    }

    // T17: docx add is now real, dispatched to DocxComments.kt's write
    // pipeline instead of refusing — a target that doesn't actually exist on
    // disk gets the write pipeline's own honest `read-failed` refusal (it
    // never fabricates a fresh .docx from nothing), never the OLD
    // `not-yet-supported` answer or a silent sidecar-store write (§1.1: Word
    // comments never get a PersistedComment sidecar row).
    @Test
    fun `add against a docx target dispatches to the real T17 write pipeline, never the sidecar store`() = runTest {
        val root = tempRoot()
        val payload = JSONObject()
            .put("path", "docs/plan.docx")
            .put("projectRoot", root.path)
            .put("text", "x")
            .put("selector", TEXT_SELECTOR_JSON)
        val response = handleDocCommentsMessage("docComments:add", payload, root, listOf(root.path))!!
        assertEquals(false, response.getBoolean("ok"))
        assertEquals("read-failed", response.getString("error"))

        // Confirms this never silently fell through to the sidecar store: a
        // sidecar-backed add would have created `.youcoded/comments/docs/
        // plan.docx.json` — Word/Excel comments never get one (§1.1).
        assertTrue(!File(root, ".youcoded/comments/docs/plan.docx.json").exists())
    }

    // T19: xlsx add is now real too, dispatched to XlsxComments.kt's write
    // pipeline instead of refusing — mirrors the docx test immediately above,
    // field-for-field. A `.xlsx` add uses a CellSelector, never a
    // TextQuoteSelector.
    @Test
    fun `add against an xlsx target dispatches to the real T19 write pipeline, never the sidecar store`() = runTest {
        val root = tempRoot()
        val cellSelectorJson = JSONObject().put("kind", "cell").put("selector", JSONObject().put("type", "CellSelector").put("cell", "A1"))
        val payload = JSONObject()
            .put("path", "reports/q3.xlsx")
            .put("projectRoot", root.path)
            .put("text", "x")
            .put("selector", cellSelectorJson)
        val response = handleDocCommentsMessage("docComments:add", payload, root, listOf(root.path))!!
        assertEquals(false, response.getBoolean("ok"))
        assertEquals("read-failed", response.getString("error"))

        // Confirms this never silently fell through to the sidecar store: a
        // sidecar-backed add would have created `.youcoded/comments/reports/
        // q3.xlsx.json` — Word/Excel comments never get one (§1.1).
        assertTrue(!File(root, ".youcoded/comments/reports/q3.xlsx.json").exists())
    }

    // Review finding #5 (docs/active/reviews/2026-09-27-doc-comments-t9ab-
    // review.md): `nativeFormatFor(filePath)` used to decide format from the
    // caller's RAW path string, so a `.txt`-named symlink pointing at a real
    // `.docx` was dispatched as plain text — its comment would have landed in
    // the inert JSON sidecar instead of the real document. Fixed by deciding
    // from `resolveNativeFormat` (the resolved, realpath'd target). A
    // sidecar-backed add always succeeds regardless of the target's actual
    // bytes; dispatching to the REAL docx write pipeline instead means this
    // fails on the file's genuinely invalid (not a real zip/docx) content —
    // `ok: false` plus no sidecar file is what proves it took the native
    // path, not the sidecar one.
    @Test
    fun `a txt symlink pointing at a real docx dispatches to the native write pipeline, not the sidecar store`() = runTest {
        val root = tempRoot()
        val docsDir = File(root, "docs").apply { mkdirs() }
        val realDocx = File(docsDir, "report.docx")
        realDocx.writeText("not a real docx, just bytes for this test")
        val link = File(docsDir, "notes.txt")
        try {
            Files.createSymbolicLink(link.toPath(), realDocx.toPath())
        } catch (_: Exception) {
            return@runTest // no symlink rights on this platform — skip, same precedent as DocCommentsStoreTest.kt
        }
        val payload = JSONObject()
            .put("path", "docs/notes.txt")
            .put("projectRoot", root.path)
            .put("text", "x")
            .put("selector", TEXT_SELECTOR_JSON)
        val response = handleDocCommentsMessage("docComments:add", payload, root, listOf(root.path))!!
        assertEquals(false, response.getBoolean("ok"))
        assertEquals("invalid-docx", response.getString("error"))
        assertTrue(!File(root, ".youcoded/comments/docs/notes.txt.json").exists())
    }

    @Test
    fun `reply carries the persisted CommentReply, resolve and reopen answer with exactly ok true, and all three persist`() = runTest {
        val root = tempRoot()
        val id = handleDocCommentsMessage(
            "docComments:add",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path).put("text", "x").put("selector", TEXT_SELECTOR_JSON),
            root, listOf(root.path),
        )!!.getString("id")

        // T5 review parity (design §1.6, F2): `reply`'s response is enriched
        // to carry the real persisted `CommentReply` — the SAME shape
        // desktop's own `docComments:reply` response now returns.
        val replyResponse = handleDocCommentsMessage(
            "docComments:reply",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path).put("id", id).put("text", "reply text"),
            root, listOf(root.path),
        )!!
        assertEquals(setOf("ok", "reply"), replyResponse.keys().asSequence().toSet())
        assertEquals(true, replyResponse.getBoolean("ok"))
        val replyJson = replyResponse.getJSONObject("reply")
        assertEquals("reply text", replyJson.getString("text"))
        assertEquals("user", replyJson.getString("author"))
        assertEquals("$id-r1", replyJson.getString("id"))

        val resolveResponse = handleDocCommentsMessage(
            "docComments:resolve",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path).put("id", id),
            root, listOf(root.path),
        )!!
        assertEquals(setOf("ok"), resolveResponse.keys().asSequence().toSet())
        assertEquals(true, resolveResponse.getBoolean("ok"))

        val reopenResponse = handleDocCommentsMessage(
            "docComments:reopen",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path).put("id", id),
            root, listOf(root.path),
        )!!
        assertEquals(setOf("ok"), reopenResponse.keys().asSequence().toSet())
        assertEquals(true, reopenResponse.getBoolean("ok"))

        val listResponse = handleDocCommentsMessage(
            "docComments:list",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path),
            root, listOf(root.path),
        )!!
        val comment = listResponse.getJSONArray("comments").getJSONObject(0)
        assertEquals(false, comment.getBoolean("resolved"))
        assertEquals(1, comment.getJSONArray("replies").length())
        assertEquals(2, comment.getJSONArray("history").length())
    }

    @Test
    fun `reply against an unknown comment id refuses comment-not-found`() = runTest {
        val root = tempRoot()
        val response = handleDocCommentsMessage(
            "docComments:reply",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path).put("id", "c-nope").put("text", "x"),
            root, listOf(root.path),
        )!!
        assertEquals("comment-not-found", response.getString("error"))
    }

    // F3 (android-xlsx-review, Low): xlsx reply/resolve/reopen/move were
    // exercised at the module level (XlsxCommentsTest.kt) but never at the
    // bridge/JSON level — this drives add->reply->resolve->reopen->move
    // through `handleDocCommentsMessage` against a REAL `.xlsx` fixture,
    // asserting the exact JSON envelope at every step, mirroring the
    // plain-sidecar round trip test above (line ~230) field-for-field.
    @Test
    fun `xlsx add-reply-resolve-reopen-move round trips through the real T19 write pipeline end to end, matching desktop's own response shapes`() = runTest {
        val root = tempRoot()
        copyFixtureInto(root, "docling-xlsx-comments.xlsx", "reports/docling.xlsx")

        val addResponse = handleDocCommentsMessage(
            "docComments:add",
            JSONObject().put("path", "reports/docling.xlsx").put("projectRoot", root.path).put("text", "bridge e2e").put("selector", cellSelectorJson("C1")),
            root, listOf(root.path),
        )!!
        assertEquals(setOf("ok", "id"), addResponse.keys().asSequence().toSet())
        assertEquals(true, addResponse.getBoolean("ok"))
        val id = addResponse.getString("id")
        assertTrue(id.startsWith("xt-"), "expected an xt-<...> xlsx thread id, got $id")

        val replyResponse = handleDocCommentsMessage(
            "docComments:reply",
            JSONObject().put("path", "reports/docling.xlsx").put("projectRoot", root.path).put("id", id).put("text", "a reply"),
            root, listOf(root.path),
        )!!
        assertEquals(setOf("ok", "reply"), replyResponse.keys().asSequence().toSet())
        assertEquals(true, replyResponse.getBoolean("ok"))
        val replyJson = replyResponse.getJSONObject("reply")
        assertEquals("a reply", replyJson.getString("text"))
        assertEquals("$id-r1", replyJson.getString("id"))

        val resolveResponse = handleDocCommentsMessage(
            "docComments:resolve",
            JSONObject().put("path", "reports/docling.xlsx").put("projectRoot", root.path).put("id", id),
            root, listOf(root.path),
        )!!
        assertEquals(setOf("ok"), resolveResponse.keys().asSequence().toSet())
        assertEquals(true, resolveResponse.getBoolean("ok"))

        val reopenResponse = handleDocCommentsMessage(
            "docComments:reopen",
            JSONObject().put("path", "reports/docling.xlsx").put("projectRoot", root.path).put("id", id),
            root, listOf(root.path),
        )!!
        assertEquals(setOf("ok"), reopenResponse.keys().asSequence().toSet())
        assertEquals(true, reopenResponse.getBoolean("ok"))

        val moveResponse = handleDocCommentsMessage(
            "docComments:move",
            JSONObject().put("path", "reports/docling.xlsx").put("projectRoot", root.path).put("id", id).put("newSelector", cellSelectorJson("D1")),
            root, listOf(root.path),
        )!!
        // Coordinator review fix: desktop's own `docComments:move` response
        // for an xlsx target carries the moved thread's FRESH id
        // (`{ok:true, id}`) — unlike docx's bare `{ok:true}` — confirmed
        // directly against `doc-comments-dispatch.ts`'s own
        // `moveNativeXlsxComment` return type. This is the one assertion in
        // this test that would have caught the bridge silently discarding it.
        assertEquals(setOf("ok", "id"), moveResponse.keys().asSequence().toSet())
        assertEquals(true, moveResponse.getBoolean("ok"))
        val movedId = moveResponse.getString("id")
        assertTrue(movedId.contains("-D1-"), "the fresh id must embed the NEW cell, got $movedId")

        val listResponse = handleDocCommentsMessage(
            "docComments:list",
            JSONObject().put("path", "reports/docling.xlsx").put("projectRoot", root.path),
            root, listOf(root.path),
        )!!
        assertEquals(true, listResponse.getBoolean("ok"))
        val comments = listResponse.getJSONArray("comments")
        var found: JSONObject? = null
        for (i in 0 until comments.length()) {
            val c = comments.getJSONObject(i)
            if (c.getString("id") == movedId) found = c
        }
        assertTrue(found != null, "expected the moved comment at its fresh id in the final list")
        assertEquals(false, found!!.getBoolean("resolved"))
        assertEquals(1, found.getJSONArray("replies").length())
        assertEquals("D1", found.getJSONObject("selector").getJSONObject("selector").getString("cell"))
    }

    @Test
    fun `move requires newSelector and refuses missing-field when absent`() = runTest {
        val root = tempRoot()
        val id = handleDocCommentsMessage(
            "docComments:add",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path).put("text", "x").put("selector", TEXT_SELECTOR_JSON),
            root, listOf(root.path),
        )!!.getString("id")
        val response = handleDocCommentsMessage(
            "docComments:move",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path).put("id", id),
            root, listOf(root.path),
        )!!
        assertEquals("missing-field", response.getString("error"))
        assertEquals("newSelector", response.getString("field"))
    }

    // ── Edit/delete build (2026-09-28, design doc §"Edit and delete") ───────

    @Test
    fun `edit edit-reply delete-reply and delete round trip through the sidecar, matching desktop's own response shapes`() = runTest {
        val root = tempRoot()
        val id = handleDocCommentsMessage(
            "docComments:add",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path).put("text", "original").put("selector", TEXT_SELECTOR_JSON),
            root, listOf(root.path),
        )!!.getString("id")
        val replyId = handleDocCommentsMessage(
            "docComments:reply",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path).put("id", id).put("text", "a reply"),
            root, listOf(root.path),
        )!!.getJSONObject("reply").getString("id")

        val editResponse = handleDocCommentsMessage(
            "docComments:edit",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path).put("id", id).put("text", "edited text"),
            root, listOf(root.path),
        )!!
        assertEquals(setOf("ok"), editResponse.keys().asSequence().toSet())
        assertEquals(true, editResponse.getBoolean("ok"))

        val editReplyResponse = handleDocCommentsMessage(
            "docComments:edit-reply",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path).put("id", id).put("replyId", replyId).put("text", "edited reply"),
            root, listOf(root.path),
        )!!
        assertEquals(setOf("ok", "reply"), editReplyResponse.keys().asSequence().toSet())
        assertEquals(true, editReplyResponse.getBoolean("ok"))
        assertEquals("edited reply", editReplyResponse.getJSONObject("reply").getString("text"))
        assertEquals(replyId, editReplyResponse.getJSONObject("reply").getString("id"))

        val listAfterEdits = handleDocCommentsMessage(
            "docComments:list",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path),
            root, listOf(root.path),
        )!!
        val comment = listAfterEdits.getJSONArray("comments").getJSONObject(0)
        assertEquals("edited text", comment.getString("text"))
        assertEquals("edited reply", comment.getJSONArray("replies").getJSONObject(0).getString("text"))
        assertEquals(0, comment.getJSONArray("history").length()) // no "edited" marker is ever stored

        val deleteReplyResponse = handleDocCommentsMessage(
            "docComments:delete-reply",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path).put("id", id).put("replyId", replyId),
            root, listOf(root.path),
        )!!
        assertEquals(setOf("ok"), deleteReplyResponse.keys().asSequence().toSet())
        assertEquals(true, deleteReplyResponse.getBoolean("ok"))

        val listAfterDeleteReply = handleDocCommentsMessage(
            "docComments:list",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path),
            root, listOf(root.path),
        )!!
        assertEquals(0, listAfterDeleteReply.getJSONArray("comments").getJSONObject(0).getJSONArray("replies").length())

        val deleteResponse = handleDocCommentsMessage(
            "docComments:delete",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path).put("id", id),
            root, listOf(root.path),
        )!!
        assertEquals(setOf("ok"), deleteResponse.keys().asSequence().toSet())
        assertEquals(true, deleteResponse.getBoolean("ok"))

        val listAfterDelete = handleDocCommentsMessage(
            "docComments:list",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path),
            root, listOf(root.path),
        )!!
        assertEquals(0, listAfterDelete.getJSONArray("comments").length())
    }

    @Test
    fun `edit against an unknown comment id refuses comment-not-found`() = runTest {
        val root = tempRoot()
        val response = handleDocCommentsMessage(
            "docComments:edit",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path).put("id", "c-nope").put("text", "x"),
            root, listOf(root.path),
        )!!
        assertEquals("comment-not-found", response.getString("error"))
    }

    @Test
    fun `edit edit-reply delete and delete-reply refuse missing-field for their own required fields`() = runTest {
        val root = tempRoot()
        val id = handleDocCommentsMessage(
            "docComments:add",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path).put("text", "x").put("selector", TEXT_SELECTOR_JSON),
            root, listOf(root.path),
        )!!.getString("id")

        val editNoText = handleDocCommentsMessage(
            "docComments:edit",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path).put("id", id),
            root, listOf(root.path),
        )!!
        assertEquals("missing-field", editNoText.getString("error"))
        assertEquals("text", editNoText.getString("field"))

        val editReplyNoReplyId = handleDocCommentsMessage(
            "docComments:edit-reply",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path).put("id", id).put("text", "x"),
            root, listOf(root.path),
        )!!
        assertEquals("missing-field", editReplyNoReplyId.getString("error"))
        assertEquals("replyId", editReplyNoReplyId.getString("field"))

        val deleteNoId = handleDocCommentsMessage(
            "docComments:delete",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path),
            root, listOf(root.path),
        )!!
        assertEquals("missing-field", deleteNoId.getString("error"))
        assertEquals("id", deleteNoId.getString("field"))

        val deleteReplyNoReplyId = handleDocCommentsMessage(
            "docComments:delete-reply",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path).put("id", id),
            root, listOf(root.path),
        )!!
        assertEquals("missing-field", deleteReplyNoReplyId.getString("error"))
        assertEquals("replyId", deleteReplyNoReplyId.getString("field"))
    }

    @Test
    fun `edit against a docx target dispatches to the real native write pipeline, never the sidecar store`() = runTest {
        val root = tempRoot()
        val docsDir = File(root, "docs").apply { mkdirs() }
        File(docsDir, "report.docx").writeText("not a real docx, just bytes for this test")
        val response = handleDocCommentsMessage(
            "docComments:edit",
            JSONObject().put("path", "docs/report.docx").put("projectRoot", root.path).put("id", "w-1").put("text", "x"),
            root, listOf(root.path),
        )!!
        assertEquals(false, response.getBoolean("ok"))
        assertEquals("invalid-docx", response.getString("error"))
        assertTrue(!File(root, ".youcoded/comments/docs/report.docx.json").exists())
    }

    @Test
    fun `watch and unwatch both answer not-implemented-on-mobile`() = runTest {
        for (type in listOf("docComments:watch", "docComments:unwatch")) {
            val response = handleDocCommentsMessage(type, JSONObject(), tempRoot(), emptyList())!!
            assertEquals(JSONObject().put("ok", false).put("error", "not-implemented-on-mobile").toString(), response.toString())
        }
    }

    @Test
    fun `a live session cwd is accepted as projectRoot even when never saved or indexed`() = runTest {
        val sessionCwd = tempRoot()
        val payload = JSONObject().put("path", "docs/plan.md").put("projectRoot", sessionCwd.path)
        val response = handleDocCommentsMessage("docComments:list", payload, tempRoot(), listOf(sessionCwd.path))!!
        assertEquals(true, response.getBoolean("ok"))
    }
}
