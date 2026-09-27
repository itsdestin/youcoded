// The docComments:* IPC dispatch logic, extracted out of
// SessionService.handleBridgeMessage's `when` block — F6 (T4 doc-comments
// implementation review): that block needed a running Android Service
// (bootstrap, sessionRegistry, bridgeServer) just to construct, which made it
// reachable only through the private `when` branches themselves — exercised
// end-to-end at best, never pinned by a direct assertion on the actual
// response JSON shape. This function takes exactly what those branches
// actually read off the Service — `homeDir` and the caller's own live
// session cwds — as plain parameters, so a JVM unit test
// (DocCommentsBridgeTest.kt) can drive every docComments:* message type and
// assert the REAL response object's keys/types/values, not a regex over a
// serialized string.
//
// SessionService.kt's own docComments branches now just compute `homeDir`/
// `sessionRoots` from the running Service and call this function — see that
// file's own comment at the call site.
package com.youcoded.app.doccomments

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Handles one `docComments:*` bridge message and returns its response, or
 * `null` for a `type` this function doesn't own (SessionService.kt's own
 * `when` never reaches that case in practice — every docComments:* label it
 * dispatches here is also matched below). Every returned response mirrors
 * the exact envelope SessionService.kt's IPC branches produced before this
 * extraction — same field names, same error codes — so this is a pure
 * refactor, not a behavior change.
 */
suspend fun handleDocCommentsMessage(
    type: String,
    payload: JSONObject,
    homeDir: File,
    sessionRoots: List<String>,
): JSONObject? {
    val claudeDir = File(homeDir, ".claude")

    fun missingField(field: String) = JSONObject().put("ok", false).put("error", "missing-field").put("field", field)
    fun unknownRoot() = JSONObject().put("ok", false).put("error", "unknown-project-root")
    fun notYetSupported() = JSONObject().put("ok", false).put("error", "not-yet-supported")
    // A live session's own cwd counts as a known root too (§1.4's synthetic-
    // project fallback) — mirrors remote-server.ts's own sessionRoots(), so a
    // file opened from an unregistered session's drawer doesn't start
    // refusing.
    fun gateRefused(projectRoot: String?) = refuseUnknownProjectRoot(projectRoot, homeDir, claudeDir, sessionRoots)

    return when (type) {
        "docComments:list" -> {
            val filePath = payload.optString("path", "")
            if (filePath.isEmpty()) return missingField("path")
            val projectRoot = payload.optString("projectRoot", "").ifEmpty { null }
            if (gateRefused(projectRoot)) return unknownRoot()
            val format = nativeFormatFor(filePath)
            if (format != null) {
                when (val r = listNativeComments(format, filePath, projectRoot, homeDir)) {
                    is NativeListResult.Ok -> JSONObject().put("ok", true).put("comments", JSONArray(r.comments.map { it.toJson() }))
                    is NativeListResult.Err -> JSONObject().put("ok", false).put("error", r.error)
                }
            } else {
                when (val r = listComments(filePath, projectRoot, homeDir)) {
                    is StoreResult.Ok -> JSONObject().put("ok", true).put("comments", JSONArray(r.value.map { it.toJson() }))
                    is StoreResult.Err -> JSONObject().put("ok", false).put("error", r.error.wire)
                }
            }
        }

        "docComments:add" -> {
            val filePath = payload.optString("path", "")
            if (filePath.isEmpty()) return missingField("path")
            val projectRoot = payload.optString("projectRoot", "").ifEmpty { null }
            if (gateRefused(projectRoot)) return unknownRoot()
            val text = payload.optString("text", "")
            if (text.isEmpty()) return missingField("text")
            val selector = CommentSelector.fromJson(payload.optJSONObject("selector")) ?: return missingField("selector")
            val author = payload.optString("author", "user")
            // T17: a `.docx` target now writes for real, dispatched through
            // DocCommentsDispatch.kt's own containment/allowlist gate — never
            // the sidecar store, which has no row for a native comment (§1.1).
            when (nativeFormatFor(filePath)) {
                NativeFormat.DOCX -> when (val r = addNativeDocxComment(filePath, projectRoot, selector, text, author, homeDir)) {
                    is NativeMutateResult.Ok -> JSONObject().put("ok", true).put("id", r.value)
                    is NativeMutateResult.Err -> JSONObject().put("ok", false).put("error", r.error)
                }
                NativeFormat.XLSX -> notYetSupported()
                null -> {
                    // F4 (T5 review): the renderer mints and sends this now.
                    val callerId = payload.optString("id", "").ifEmpty { null }
                    when (val r = addComment(filePath, projectRoot, selector, text, author, homeDir, callerId)) {
                        is StoreResult.Ok -> JSONObject().put("ok", true).put("id", r.value)
                        is StoreResult.Err -> JSONObject().put("ok", false).put("error", r.error.wire)
                    }
                }
            }
        }

        // reply/resolve/reopen/move ALL require `path` — the sidecar holding
        // a given comment id can only be found by knowing the file (design
        // review 3, F1), same as desktop's own IPC handlers.
        "docComments:reply" -> {
            val filePath = payload.optString("path", "")
            if (filePath.isEmpty()) return missingField("path")
            val projectRoot = payload.optString("projectRoot", "").ifEmpty { null }
            if (gateRefused(projectRoot)) return unknownRoot()
            val commentId = payload.optString("id", "")
            if (commentId.isEmpty()) return missingField("id")
            val text = payload.optString("text", "")
            if (text.isEmpty()) return missingField("text")
            val author = payload.optString("author", "user")
            when (nativeFormatFor(filePath)) {
                NativeFormat.DOCX -> when (val r = replyToNativeDocxComment(filePath, projectRoot, commentId, text, author, homeDir)) {
                    is NativeMutateResult.Ok -> JSONObject().put("ok", true)
                    is NativeMutateResult.Err -> JSONObject().put("ok", false).put("error", r.error)
                }
                NativeFormat.XLSX -> notYetSupported()
                null -> when (val r = replyToComment(filePath, projectRoot, commentId, text, author, homeDir)) {
                    is StoreResult.Ok -> JSONObject().put("ok", true)
                    is StoreResult.Err -> JSONObject().put("ok", false).put("error", r.error.wire)
                }
            }
        }

        "docComments:resolve" -> {
            val filePath = payload.optString("path", "")
            if (filePath.isEmpty()) return missingField("path")
            val projectRoot = payload.optString("projectRoot", "").ifEmpty { null }
            if (gateRefused(projectRoot)) return unknownRoot()
            val commentId = payload.optString("id", "")
            if (commentId.isEmpty()) return missingField("id")
            val by = payload.optString("by", "user")
            when (nativeFormatFor(filePath)) {
                NativeFormat.DOCX -> when (val r = resolveNativeDocxComment(filePath, projectRoot, commentId, homeDir)) {
                    is NativeMutateResult.Ok -> JSONObject().put("ok", true)
                    is NativeMutateResult.Err -> JSONObject().put("ok", false).put("error", r.error)
                }
                NativeFormat.XLSX -> notYetSupported()
                null -> when (val r = resolveComment(filePath, projectRoot, commentId, by, homeDir)) {
                    is StoreResult.Ok -> JSONObject().put("ok", true)
                    is StoreResult.Err -> JSONObject().put("ok", false).put("error", r.error.wire)
                }
            }
        }

        "docComments:reopen" -> {
            val filePath = payload.optString("path", "")
            if (filePath.isEmpty()) return missingField("path")
            val projectRoot = payload.optString("projectRoot", "").ifEmpty { null }
            if (gateRefused(projectRoot)) return unknownRoot()
            val commentId = payload.optString("id", "")
            if (commentId.isEmpty()) return missingField("id")
            val by = payload.optString("by", "user")
            when (nativeFormatFor(filePath)) {
                NativeFormat.DOCX -> when (val r = reopenNativeDocxComment(filePath, projectRoot, commentId, homeDir)) {
                    is NativeMutateResult.Ok -> JSONObject().put("ok", true)
                    is NativeMutateResult.Err -> JSONObject().put("ok", false).put("error", r.error)
                }
                NativeFormat.XLSX -> notYetSupported()
                null -> when (val r = reopenComment(filePath, projectRoot, commentId, by, homeDir)) {
                    is StoreResult.Ok -> JSONObject().put("ok", true)
                    is StoreResult.Err -> JSONObject().put("ok", false).put("error", r.error.wire)
                }
            }
        }

        "docComments:move" -> {
            val filePath = payload.optString("path", "")
            if (filePath.isEmpty()) return missingField("path")
            val projectRoot = payload.optString("projectRoot", "").ifEmpty { null }
            if (gateRefused(projectRoot)) return unknownRoot()
            val commentId = payload.optString("id", "")
            if (commentId.isEmpty()) return missingField("id")
            val newSelector = CommentSelector.fromJson(payload.optJSONObject("newSelector")) ?: return missingField("newSelector")
            when (nativeFormatFor(filePath)) {
                NativeFormat.DOCX -> when (val r = moveNativeDocxComment(filePath, projectRoot, commentId, newSelector, homeDir)) {
                    is NativeMutateResult.Ok -> JSONObject().put("ok", true)
                    is NativeMutateResult.Err -> JSONObject().put("ok", false).put("error", r.error)
                }
                NativeFormat.XLSX -> notYetSupported()
                null -> when (val r = moveComment(filePath, projectRoot, commentId, newSelector, homeDir)) {
                    is StoreResult.Ok -> JSONObject().put("ok", true)
                    is StoreResult.Err -> JSONObject().put("ok", false).put("error", r.error.wire)
                }
            }
        }

        // Watching is the one piece that still follows Git's "absent, not
        // reimplemented" precedent, for EVERY file type (§1.6): Android has
        // no FileObserver-based watch today — a general no-push gap unrelated
        // to reopen-1's promise about read/add/reply/resolve.
        "docComments:watch", "docComments:unwatch" -> JSONObject().put("ok", false).put("error", "not-implemented-on-mobile")

        else -> null
    }
}
