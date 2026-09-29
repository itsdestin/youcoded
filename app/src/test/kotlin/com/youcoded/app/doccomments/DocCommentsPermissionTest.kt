// Pins T20's "same permission behaviour in Android's auto-approve path"
// requirement (docs/active/specs/2026-09-26-doc-comments-build-design.md
// §5.2a, decided option 1) — the Kotlin port of desktop's permission-auto-
// approve.ts `shouldAutoApproveDocComment`, mirroring
// desktop/tests/permission-auto-approve.test.ts's own `shouldAutoApproveDocComment`
// describe block scenario for scenario.
package com.youcoded.app.doccomments

import org.json.JSONObject
import org.junit.Test
import java.nio.file.Files
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private const val SERVER_ID = "youcoded-doc-comments-deadbeef"
private val MUTATOR_TOOL = DocCommentsMcpNames.toolName(SERVER_ID, "ReplyToComment")
private val READ_TOOL = DocCommentsMcpNames.readTool(SERVER_ID)

private fun input(path: String): JSONObject = JSONObject().put("path", path)

class DocCommentsPermissionTest {

    @Test
    fun `auto-approves a plain-text markdown code target unconditionally, no override needed`() {
        assertTrue(shouldAutoApproveDocComment(MUTATOR_TOOL, input("notes/plan.md"), null, SERVER_ID))
        // Every recognized mode, AND a completely unrecognized/missing one —
        // this branch never even reads permissionMode.
        for (mode in listOf(null, "default", "plan", "acceptEdits", "bypassPermissions", "dontAsk", "auto", "some-future-mode")) {
            assertTrue(shouldAutoApproveDocComment(MUTATOR_TOOL, input("notes/plan.md"), mode, SERVER_ID))
        }
    }

    @Test
    fun `never auto-approves a Word or Excel target without a frictionless permission mode`() {
        assertFalse(shouldAutoApproveDocComment(MUTATOR_TOOL, input("report.docx"), null, SERVER_ID))
        assertFalse(shouldAutoApproveDocComment(MUTATOR_TOOL, input("report.docx"), "default", SERVER_ID))
        assertFalse(shouldAutoApproveDocComment(MUTATOR_TOOL, input("sheet.xlsx"), "plan", SERVER_ID))
    }

    @Test
    fun `auto-approves a Word or Excel target in acceptEdits or bypassPermissions mode`() {
        assertTrue(shouldAutoApproveDocComment(MUTATOR_TOOL, input("report.docx"), "acceptEdits", SERVER_ID))
        assertTrue(shouldAutoApproveDocComment(MUTATOR_TOOL, input("sheet.xlsx"), "bypassPermissions", SERVER_ID))
    }

    @Test
    fun `never auto-approves a Word or Excel target for dontAsk or auto — neither is a documented unconditional accept`() {
        assertFalse(shouldAutoApproveDocComment(MUTATOR_TOOL, input("report.docx"), "dontAsk", SERVER_ID))
        assertFalse(shouldAutoApproveDocComment(MUTATOR_TOOL, input("report.docx"), "auto", SERVER_ID))
    }

    @Test
    fun `never auto-approves a Word or Excel target for an unrecognized mode string`() {
        assertFalse(shouldAutoApproveDocComment(MUTATOR_TOOL, input("report.docx"), "some-future-mode", SERVER_ID))
    }

    @Test
    fun `ignores a tool name it does not recognize, including the read-only tool`() {
        assertFalse(shouldAutoApproveDocComment("Bash", input("notes/plan.md"), null, SERVER_ID))
        assertFalse(shouldAutoApproveDocComment(READ_TOOL, input("notes/plan.md"), null, SERVER_ID))
    }

    @Test
    fun `never approves when path is missing or not a string`() {
        assertFalse(shouldAutoApproveDocComment(MUTATOR_TOOL, JSONObject(), null, SERVER_ID))
        assertFalse(shouldAutoApproveDocComment(MUTATOR_TOOL, JSONObject().put("path", 42), null, SERVER_ID))
    }

    @Test
    fun `a tool name composed under a DIFFERENT session's server id never matches`() {
        val otherServerId = "youcoded-doc-comments-c0ffee00"
        val toolUnderOther = DocCommentsMcpNames.toolName(otherServerId, "ReplyToComment")
        assertFalse(shouldAutoApproveDocComment(toolUnderOther, input("notes/plan.md"), null, SERVER_ID))
    }

    @Test
    fun `fails closed when no server id is known for this session at all`() {
        assertFalse(shouldAutoApproveDocComment(MUTATOR_TOOL, input("notes/plan.md"), null, null))
    }

    @Test
    fun `an absolute txt path that is a symlink to a real docx is never auto-approved, even unconditionally`() {
        val dir = Files.createTempDirectory("ycd-doccomments-permission-").toFile().apply { deleteOnExit() }
        val realDocx = java.io.File(dir, "real.docx").apply { writeText("pk-stub") }
        val disguise = java.io.File(dir, "looks-like-notes.txt")
        Files.createSymbolicLink(disguise.toPath(), realDocx.toPath())
        // Would otherwise hit the unconditional "plain text" branch, since
        // nativeFormatFor(".txt") is null — the fail-safe must intercept
        // BEFORE that check.
        assertFalse(shouldAutoApproveDocComment(MUTATOR_TOOL, input(disguise.absolutePath), null, SERVER_ID))
        // acceptEdits doesn't rescue it either — the symlink check is
        // unconditional, not mode-gated.
        assertFalse(shouldAutoApproveDocComment(MUTATOR_TOOL, input(disguise.absolutePath), "acceptEdits", SERVER_ID))
    }

    @Test
    fun `an ordinary absolute plain-text path that is NOT a symlink is unaffected`() {
        val dir = Files.createTempDirectory("ycd-doccomments-permission-plain-").toFile().apply { deleteOnExit() }
        val plain = java.io.File(dir, "notes.md").apply { writeText("hello") }
        assertTrue(shouldAutoApproveDocComment(MUTATOR_TOOL, input(plain.absolutePath), null, SERVER_ID))
    }

    @Test
    fun `a relative txt path is never treated as a symlink here — no cwd to resolve it against`() {
        // Documented, pre-existing limitation mirrored from desktop's own
        // isPathItselfASymlink (isAbsolute short-circuit) — a relative path
        // still gets the ordinary plain-text unconditional approval.
        assertTrue(shouldAutoApproveDocComment(MUTATOR_TOOL, input("looks-like-notes.txt"), null, SERVER_ID))
    }

    @Test
    fun `a realistic full PermissionRequest-shaped payload is read the same way`() {
        val payload = JSONObject()
            .put("tool_name", MUTATOR_TOOL)
            .put("tool_input", JSONObject().put("path", "report.docx").put("commentId", "w-1").put("text", "hi"))
            .put("permission_mode", "acceptEdits")
        val mode = if (payload.has("permission_mode")) payload.getString("permission_mode") else null
        assertTrue(
            shouldAutoApproveDocComment(
                payload.getString("tool_name"),
                payload.getJSONObject("tool_input"),
                mode,
                SERVER_ID,
            ),
        )
    }
}
