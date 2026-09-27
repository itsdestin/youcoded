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

    @Test
    fun `add with no selector refuses missing-field for selector`() = runTest {
        val root = tempRoot()
        val payload = JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path).put("text", "x")
        val response = handleDocCommentsMessage("docComments:add", payload, root, listOf(root.path))!!
        assertEquals("missing-field", response.getString("error"))
        assertEquals("selector", response.getString("field"))
    }

    @Test
    fun `add against a docx target refuses not-yet-supported without ever calling the store`() = runTest {
        val root = tempRoot()
        val payload = JSONObject()
            .put("path", "docs/plan.docx")
            .put("projectRoot", root.path)
            .put("text", "x")
            .put("selector", TEXT_SELECTOR_JSON)
        val response = handleDocCommentsMessage("docComments:add", payload, root, listOf(root.path))!!
        assertEquals(JSONObject().put("ok", false).put("error", "not-yet-supported").toString(), response.toString())
    }

    @Test
    fun `reply resolve and reopen each answer with exactly ok true and no extra keys, and persist`() = runTest {
        val root = tempRoot()
        val id = handleDocCommentsMessage(
            "docComments:add",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path).put("text", "x").put("selector", TEXT_SELECTOR_JSON),
            root, listOf(root.path),
        )!!.getString("id")

        val replyResponse = handleDocCommentsMessage(
            "docComments:reply",
            JSONObject().put("path", "docs/plan.md").put("projectRoot", root.path).put("id", id).put("text", "reply text"),
            root, listOf(root.path),
        )!!
        assertEquals(setOf("ok"), replyResponse.keys().asSequence().toSet())
        assertEquals(true, replyResponse.getBoolean("ok"))

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
