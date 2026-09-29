// Android half of desktop's permission-auto-approve.ts `shouldAutoApproveDocComment`
// — §5.2a of the doc-comments build design (decided option 1, Destin "fine w
// A"), T20's own "same permission behaviour in Android's auto-approve path"
// requirement. Ported field-for-field from the TS function; see that file's
// own header for the full reasoning this comment only summarizes.
//
// Native tools (a phone has none of those here — Android's assistant surface
// is Claude Code CLI only) get a real per-call permissionSubject because they
// run through this app's own decidePermission(), which knows the session's
// live permission mode. Claude Code's CLI has no equivalent per-argument
// gate: `--allowedTools` pre-approves a TOOL NAME outright, with no way to
// condition that on an argument value — so a bare allow-list of
// ReplyToComment would ALSO pre-approve it for a Word/Excel target, and not
// allow-listing it makes even a plain-text/markdown reply ask every time,
// contradicting §5.2a's "sparingly... frictionless" intent for the common
// case.
//
// The mechanism (identical to desktop's): ReadFileComments alone is allow-
// listed at spawn time (ClaudeCodeDocCommentsMcp.kt) — a read never mutates
// anything. The five mutation tools are deliberately NOT allow-listed;
// instead, ManagedSession.kt's own PermissionRequest handling (the SAME path
// that already auto-approves a handful of other categories, see that file's
// classifyPermission/shouldAutoApprove) recognizes a call to one of them
// (DocCommentsMcpNames.mutatorTools) and reads its OWN `path` argument
// straight out of the hook payload's tool_input: when nativeFormatFor(path)
// is null (plain-text/markdown/code), it auto-approves unconditionally;
// otherwise only when Claude Code's own live permission mode is one that
// already auto-accepts a native file edit.
package com.youcoded.app.doccomments

import org.json.JSONObject
import java.io.File
import java.nio.file.Files

/**
 * Modes that behave like Edit/Write already does for a real file write
 * (Claude Code auto-accepts a native file edit with no ask) — identical set
 * to desktop's FRICTIONLESS_DOC_COMMENT_MODES. `dontAsk`/`auto` are
 * deliberately excluded (see that file's own reasoning: neither is documented
 * as an unconditional file-edit auto-accept the way `acceptEdits` is).
 */
private val FRICTIONLESS_DOC_COMMENT_MODES = setOf("acceptEdits", "bypassPermissions")

/**
 * Review finding #5 (docs/active/reviews/2026-09-27-doc-comments-t9ab-review.md):
 * an ABSOLUTE path that is ITSELF a symlink never gets a free ride through
 * either branch below — it falls through to the ordinary ask rather than
 * guessing what it disguises. `Files.isSymbolicLink` (not a canonicalizing
 * resolve) is the right call here: it inspects ONLY `path` itself, never
 * follows anything, mirroring desktop's own `lstatSync(path).isSymbolicLink()`.
 * A relative path has no cwd to resolve one against here either, matching
 * desktop's own `isAbsolute` short-circuit.
 */
private fun isPathItselfASymlink(path: String): Boolean {
    val file = File(path)
    if (!file.isAbsolute) return false
    return try {
        Files.isSymbolicLink(file.toPath())
    } catch (_: Exception) {
        false // doesn't exist (a brand-new file) or unreadable — nothing to disguise
    }
}

/**
 * `serverId` is THIS session's own randomly-generated doc-comments MCP server
 * id (ClaudeCodeDocCommentsMcp.deploy) — never a fixed, guessable string.
 * `null` (a session whose deploy failed, or a hook arriving before the
 * deployment result is known) fails CLOSED: nothing is matched, and the call
 * falls through to the ordinary ask, same as any other unrecognized tool.
 *
 * `permissionMode` is Claude Code's OWN live permission mode string
 * ('default'|'acceptEdits'|'bypassPermissions'|'plan'|'dontAsk'|'auto'), read
 * from the SAME PermissionRequest hook payload `toolName`/`toolInput` already
 * come from (HookEvent.PermissionRequest.permissionMode) — never this app's
 * own `ManagedSession.permissionMode` vocabulary, which uses different
 * strings ("normal"/"auto-accept"/"plan"/"bypass").
 */
fun shouldAutoApproveDocComment(
    toolName: String,
    toolInput: JSONObject,
    permissionMode: String?,
    serverId: String?,
): Boolean {
    if (serverId == null) return false
    if (toolName !in DocCommentsMcpNames.mutatorTools(serverId)) return false
    val path = toolInput.opt("path")
    if (path !is String) return false
    if (isPathItselfASymlink(path)) return false
    if (nativeFormatFor(path) == null) return true
    return permissionMode != null && FRICTIONLESS_DOC_COMMENT_MODES.contains(permissionMode)
}
