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
