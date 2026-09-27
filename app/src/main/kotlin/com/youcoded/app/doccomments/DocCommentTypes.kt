// Document comments — shared types. Android half of T1
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §1.1,
// "Web Annotation-flavored" record shape), ported for T16 (§3.2a).
//
// WHY this is a byte-for-byte port of desktop/src/shared/doc-comments-types.ts
// rather than a Kotlin-idiomatic redesign: three runtimes (Electron main, the
// React renderer, and now this Kotlin one) must agree on the SAME
// `PersistedComment` shape — the design's own §1.1 header comment on the TS
// file says this explicitly for the first two; T16 adds this one as the
// third. `toJson()` below produces the exact field names/nesting the TS
// `PersistedComment` serializes to (confirmed against
// `desktop/tests/fixtures/doc-comments/golden/*.json`, generated straight
// from the TS reader — see `generate-docx-golden.mjs`'s own header for why),
// so a future IPC wire-up (T4, out of this task's scope) can reuse this
// mapping unchanged rather than inventing a second one.
package com.youcoded.app.doccomments

import org.json.JSONArray
import org.json.JSONObject

/** `'user' | 'assistant' | 'person:<name>'` — a plain String rather than a
 *  Kotlin sealed class, since nothing in this task needs to pattern-match on
 *  it beyond formatting for JSON (T16 is read-only; the write path (T17) is
 *  the one that constructs a 'user'/'assistant' value from scratch). */
typealias CommentAuthor = String

data class TextQuoteSelector(
    val exact: String,
    /** ~32 chars before, whitespace-collapsed. */
    val prefix: String,
    /** ~32 chars after, whitespace-collapsed. */
    val suffix: String,
    /** 0-indexed: which match of `exact` this was, at creation time. */
    val occurrence: Int,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("type", "TextQuoteSelector")
        .put("exact", exact)
        .put("prefix", prefix)
        .put("suffix", suffix)
        .put("occurrence", occurrence)
}

data class CellSelector(val cell: String, val sheet: String? = null) {
    fun toJson(): JSONObject {
        val o = JSONObject().put("type", "CellSelector").put("cell", cell)
        if (sheet != null) o.put("sheet", sheet)
        return o
    }
}

sealed class CommentSelector {
    data class Text(val selector: TextQuoteSelector, val lineHint: Pair<Int, Int>? = null) : CommentSelector()
    data class Cell(val selector: CellSelector) : CommentSelector()

    fun toJson(): JSONObject = when (this) {
        is Text -> {
            val o = JSONObject().put("kind", "text").put("selector", selector.toJson())
            if (lineHint != null) o.put("lineHint", JSONArray().put(lineHint.first).put(lineHint.second))
            o
        }
        is Cell -> JSONObject().put("kind", "cell").put("selector", selector.toJson())
    }
}

data class CommentReply(
    val id: String,
    val author: CommentAuthor,
    val text: String,
    val createdAt: Long,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("author", author)
        .put("text", text)
        .put("createdAt", createdAt)
}

/** `'resolved' | 'reopened'`. */
data class ResolveEvent(val by: CommentAuthor, val at: Long, val action: String) {
    fun toJson(): JSONObject = JSONObject().put("by", by).put("at", at).put("action", action)
}

data class PersistedComment(
    val id: String,
    /** Project-relative (or absolute, for the fallback store — §1.4). */
    val path: String,
    val selector: CommentSelector,
    val text: String,
    val author: CommentAuthor,
    val createdAt: Long,
    val replies: List<CommentReply>,
    val resolved: Boolean,
    /** Full resolve/reopen audit trail — always empty for a freshly-read
     *  native comment (§3.2: "Word's own OOXML has no separate resolve/reopen
     *  AUDIT TRAIL... history starts empty for a freshly-read native
     *  comment"). */
    val history: List<ResolveEvent> = emptyList(),
    /** Set by the anchoring pass at READ time, never persisted. T16 never
     *  sets or reads this — anchoring runs downstream in the WebView
     *  (§3.2a: "needs no Kotlin port at all"). */
    val status: String? = null,
) {
    fun toJson(): JSONObject {
        val o = JSONObject()
            .put("id", id)
            .put("path", path)
            .put("selector", selector.toJson())
            .put("text", text)
            .put("author", author)
            .put("createdAt", createdAt)
            .put("replies", JSONArray(replies.map { it.toJson() }))
            .put("resolved", resolved)
            .put("history", JSONArray(history.map { it.toJson() }))
        if (status != null) o.put("status", status)
        return o
    }
}
