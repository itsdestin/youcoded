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
//
// F2 (T4 implementation review, major): `fromJson`/`toJson` used to rebuild
// every record field by field, silently dropping any key this Kotlin build
// doesn't know about (a newer schema field, or one written by another of the
// three-way JSON sidecar's implementations, design §9.1) — desktop avoids
// this by spreading (`{ ...comment, replies: [...] }`), which keeps every
// OTHER key untouched. `overlayJson` below is the same idea for org.json,
// which has no object-spread operator: clone the record's ORIGINAL
// `JSONObject` (kept as `raw`), then overlay only the fields this code
// actually knows about. Applied at every level the design calls out: the
// sidecar file itself, each `PersistedComment`, each `CommentReply`, and
// each `ResolveEvent` (a `history` entry) — NOT the selector, which stays a
// fully-typed, from-scratch shape (§2's anchoring pass owns its contents,
// unlike the passive pass-through fields around it).
package com.youcoded.app.doccomments

import org.json.JSONArray
import org.json.JSONObject

/** `'user' | 'assistant' | 'person:<name>'` — a plain String rather than a
 *  Kotlin sealed class, since nothing in this task needs to pattern-match on
 *  it beyond formatting for JSON (T16 is read-only; the write path (T17) is
 *  the one that constructs a 'user'/'assistant' value from scratch). */
typealias CommentAuthor = String

/**
 * Clone `base` (or start empty when null — a brand-new record has nothing to
 * preserve) and apply `block`'s overlay on top. F2 fix: mirrors desktop's own
 * `{ ...record, field: newValue }` spread, so a field this Kotlin code
 * doesn't know about survives a round trip through this reader/writer
 * untouched instead of the old field-by-field rebuild silently dropping it.
 * Goes through a string round trip rather than iterating `keys()` into a
 * fresh `JSONObject` — org.json's `JSONObject` has no public copy
 * constructor for "every key", and a string round trip is the simplest way
 * to get an independent clone that never aliases `base` (a caller may still
 * hold a reference to it elsewhere, e.g. `CommentsSidecarFile.raw`).
 */
private fun overlayJson(base: JSONObject?, block: JSONObject.() -> Unit): JSONObject {
    val out = if (base != null) JSONObject(base.toString()) else JSONObject()
    out.block()
    return out
}

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

    companion object {
        // T4 (docComments:* Android IPC parity, §1.6) — the read side of the
        // JSON sidecar (T1's own store round-trips these fields verbatim, so
        // the Kotlin store needs the SAME parse the TS side gets for free via
        // JSON.parse; org.json has no automatic mapping, hence fromJson pairs
        // with every toJson above).
        fun fromJson(o: JSONObject): TextQuoteSelector = TextQuoteSelector(
            exact = o.optString("exact", ""),
            prefix = o.optString("prefix", ""),
            suffix = o.optString("suffix", ""),
            occurrence = o.optInt("occurrence", 0),
        )
    }
}

data class CellSelector(val cell: String, val sheet: String? = null) {
    fun toJson(): JSONObject {
        val o = JSONObject().put("type", "CellSelector").put("cell", cell)
        if (sheet != null) o.put("sheet", sheet)
        return o
    }

    companion object {
        fun fromJson(o: JSONObject): CellSelector = CellSelector(
            cell = o.optString("cell", ""),
            sheet = if (o.has("sheet") && !o.isNull("sheet")) o.optString("sheet") else null,
        )
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

    companion object {
        /** Returns null for a shape this union doesn't recognize — every
         *  caller (T4's IPC dispatch) treats a null selector as a
         *  missing/invalid field, never a crash on model- or renderer-
         *  supplied JSON. */
        fun fromJson(o: JSONObject?): CommentSelector? {
            if (o == null) return null
            val sel = o.optJSONObject("selector") ?: return null
            return when (o.optString("kind", "")) {
                "text" -> {
                    val hintArr = o.optJSONArray("lineHint")
                    val hint = if (hintArr != null && hintArr.length() == 2) Pair(hintArr.optInt(0), hintArr.optInt(1)) else null
                    Text(TextQuoteSelector.fromJson(sel), hint)
                }
                "cell" -> Cell(CellSelector.fromJson(sel))
                else -> null
            }
        }
    }
}

data class CommentReply(
    val id: String,
    val author: CommentAuthor,
    val text: String,
    val createdAt: Long,
    // F2 (T4 implementation review, major): the reply's own original
    // JSONObject, if it was read from disk — preserved so a reply carrying a
    // field this Kotlin build predates (or one added by another of the
    // three-way JSON sidecar's implementations, design §9.1) survives a
    // round trip through THIS code untouched, mirroring desktop's own
    // `{ ...reply }` spread. Excluded from `equals`/`hashCode` below —
    // org.json's `JSONObject` has no structural `equals` of its own (it's
    // reference equality), so two replies parsed from identical JSON text
    // would otherwise compare UNEQUAL just because their `raw` objects are
    // different instances.
    val raw: JSONObject? = null,
) {
    fun toJson(): JSONObject = overlayJson(raw) {
        put("id", id)
        put("author", author)
        put("text", text)
        put("createdAt", createdAt)
    }

    override fun equals(other: Any?): Boolean = other is CommentReply &&
        id == other.id && author == other.author && text == other.text && createdAt == other.createdAt
    override fun hashCode(): Int = java.util.Objects.hash(id, author, text, createdAt)

    companion object {
        fun fromJson(o: JSONObject): CommentReply = CommentReply(
            id = o.optString("id", ""),
            author = o.optString("author", ""),
            text = o.optString("text", ""),
            createdAt = o.optLong("createdAt", 0L),
            raw = o,
        )
    }
}

/** `'resolved' | 'reopened'`. */
data class ResolveEvent(
    val by: CommentAuthor,
    val at: Long,
    val action: String,
    // F2 — see CommentReply's own doc comment for why this exists and is
    // excluded from equals/hashCode.
    val raw: JSONObject? = null,
) {
    fun toJson(): JSONObject = overlayJson(raw) {
        put("by", by)
        put("at", at)
        put("action", action)
    }

    override fun equals(other: Any?): Boolean = other is ResolveEvent && by == other.by && at == other.at && action == other.action
    override fun hashCode(): Int = java.util.Objects.hash(by, at, action)

    companion object {
        fun fromJson(o: JSONObject): ResolveEvent = ResolveEvent(
            by = o.optString("by", ""),
            at = o.optLong("at", 0L),
            action = o.optString("action", ""),
            raw = o,
        )
    }
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
    // F2 — see CommentReply's own doc comment for why this exists and is
    // excluded from equals/hashCode. A brand-new comment (addComment) has
    // none; a comment read off disk carries its own original object so an
    // unknown top-level field (e.g. one a newer schema adds) survives every
    // reply/resolve/reopen/move this Kotlin code performs on it.
    val raw: JSONObject? = null,
) {
    fun toJson(): JSONObject = overlayJson(raw) {
        put("id", id)
        put("path", path)
        put("selector", selector.toJson())
        put("text", text)
        put("author", author)
        put("createdAt", createdAt)
        put("replies", JSONArray(replies.map { it.toJson() }))
        put("resolved", resolved)
        put("history", JSONArray(history.map { it.toJson() }))
        if (status != null) put("status", status) else remove("status")
    }

    override fun equals(other: Any?): Boolean = other is PersistedComment &&
        id == other.id && path == other.path && selector == other.selector && text == other.text &&
        author == other.author && createdAt == other.createdAt && replies == other.replies &&
        resolved == other.resolved && history == other.history && status == other.status
    override fun hashCode(): Int =
        java.util.Objects.hash(id, path, selector, text, author, createdAt, replies, resolved, history, status)

    companion object {
        /** Returns null for a record this reader can't make sense of (a
         *  missing/wrong-typed required field) — T4's sidecar reader treats
         *  that the same way desktop's `parseSidecar` treats a whole corrupt
         *  file: an honest refusal, never a thrown exception into the bridge
         *  or a silently-dropped comment. */
        fun fromJson(o: JSONObject): PersistedComment? {
            val id = o.optString("id", "")
            val path = o.optString("path", "")
            val selector = CommentSelector.fromJson(o.optJSONObject("selector")) ?: return null
            if (id.isEmpty() || path.isEmpty()) return null
            val repliesArr = o.optJSONArray("replies") ?: JSONArray()
            val replies = (0 until repliesArr.length()).map { CommentReply.fromJson(repliesArr.getJSONObject(it)) }
            val historyArr = o.optJSONArray("history") ?: JSONArray()
            val history = (0 until historyArr.length()).map { ResolveEvent.fromJson(historyArr.getJSONObject(it)) }
            return PersistedComment(
                id = id,
                path = path,
                selector = selector,
                text = o.optString("text", ""),
                author = o.optString("author", ""),
                createdAt = o.optLong("createdAt", 0L),
                replies = replies,
                resolved = o.optBoolean("resolved", false),
                history = history,
                status = if (o.has("status") && !o.isNull("status")) o.optString("status") else null,
                raw = o,
            )
        }
    }
}

/** §1.3's sidecar file shape, `{ version: 1, comments: PersistedComment[] }` —
 *  Android's half of T1/T4's on-disk contract. `version` exists from day one
 *  (matching desktop's own comment on `CommentsSidecarFile`) so a future
 *  schema change can migrate on read instead of needing a flag day. */
data class CommentsSidecarFile(
    val version: Int = 1,
    val comments: List<PersistedComment>,
    // F2 — the sidecar's own original JSONObject, if read from disk, so a
    // TOP-LEVEL unknown field (beside `version`/`comments`) survives every
    // mutation. See CommentReply's own doc comment for why excluded below.
    val raw: JSONObject? = null,
) {
    fun toJson(): JSONObject = overlayJson(raw) {
        put("version", version)
        put("comments", JSONArray(comments.map { it.toJson() }))
    }

    override fun equals(other: Any?): Boolean = other is CommentsSidecarFile && version == other.version && comments == other.comments
    override fun hashCode(): Int = java.util.Objects.hash(version, comments)

    companion object {
        fun empty(): CommentsSidecarFile = CommentsSidecarFile(1, emptyList())

        /** Mirrors desktop's `parseSidecar` (doc-comments-store.ts): a
         *  missing file is `null` in, handled by the caller as "empty
         *  sidecar" — never confused with a PRESENT-but-corrupt one, which
         *  this returns null for instead (a hand-edited or half-written
         *  file is refused, not silently treated as empty, so a mutation
         *  never discards history it couldn't parse). */
        fun parse(onDisk: String): CommentsSidecarFile? {
            val obj = try { JSONObject(onDisk) } catch (_: Exception) { return null }
            if (obj.optInt("version", -1) != 1) return null
            val arr = obj.optJSONArray("comments") ?: return null
            val comments = mutableListOf<PersistedComment>()
            for (i in 0 until arr.length()) {
                val c = arr.optJSONObject(i) ?: return null
                comments.add(PersistedComment.fromJson(c) ?: return null)
            }
            return CommentsSidecarFile(1, comments, raw = obj)
        }
    }
}
