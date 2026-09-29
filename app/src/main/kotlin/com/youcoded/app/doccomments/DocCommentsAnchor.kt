// Document comments — re-anchoring after edits, Kotlin port of
// desktop/src/shared/doc-comments-anchor.ts's `resolveSelector` for T17 of the
// doc-comments build (docs/active/specs/2026-09-26-doc-comments-build-
// design.md §2.2, §3.3, §8 T17).
//
// WHY this exists even though §3.2a says the ANCHORING PASS "needs no Kotlin
// port at all... it runs downstream, in the WebView, over the same shared
// doc-comments-anchor.ts": that sentence is about computing a comment's
// `status` (`anchored`/`detached`) against the WebView's own rendered DOM
// text at LIST time (§2.3, T14's scope) — a genuinely different use of the
// same algorithm from what T17's WRITE path needs. Add/Move must find WHERE
// in `word/document.xml`'s OWN text (not mammoth's rendered HTML — this
// module has no access to it and doesn't need it, same reasoning as T10/T16's
// read path) a selector currently matches, so a fresh `w:commentRangeStart`/
// `End` pair can be inserted there — headlessly, with no WebView involved at
// all (§3.2a's own F1 reasoning: the MCP script and a backgrounded PTY
// session must be able to mutate a comment with no WebView attached). Ported
// field-for-field from doc-comments-anchor.ts so both the WebView's status
// pass and this write path score candidates identically, per §2.2's own
// "this single function exists to prevent [disagreement]" rule.
package com.youcoded.app.doccomments

/** A resolved text-quote anchor: character offsets into the `fullText` that
 *  was searched. `end` is exclusive, matching `String.substring`. */
data class ResolvedRange(val start: Int, val end: Int)

private val WHITESPACE = Regex("\\s+")

/** Strips all whitespace from `text`, returning the compact string plus a
 *  same-length array mapping each compact-string index back to its index in
 *  the ORIGINAL `text`. Mirrors the TS `compact()`. */
private fun compact(text: String): Pair<String, IntArray> {
    val out = StringBuilder(text.length)
    val toOriginal = ArrayList<Int>(text.length)
    for (i in text.indices) {
        if (text[i].isWhitespace()) continue
        out.append(text[i])
        toOriginal.add(i)
    }
    return Pair(out.toString(), toOriginal.toIntArray())
}

/** Every non-overlapping occurrence of `exact` in `fullText`, whitespace
 *  differences ignored on both sides, as `[start, end)` offsets into the
 *  ORIGINAL `fullText`. Returns an empty list when `exact` (once whitespace
 *  is stripped) is empty or genuinely absent — the zero-occurrences case that
 *  becomes `null` (detached), never a thrown error. Mirrors the TS
 *  `findAllOccurrences`. */
private fun findAllOccurrences(fullText: String, exact: String): List<ResolvedRange> {
    val needle = WHITESPACE.replace(exact, "")
    if (needle.isEmpty()) return emptyList()
    val (hay, toOriginal) = compact(fullText)
    val results = mutableListOf<ResolvedRange>()
    var searchFrom = 0
    while (true) {
        val idx = hay.indexOf(needle, searchFrom)
        if (idx == -1) break
        val start = toOriginal[idx]
        // toOriginal[idx + needle.length - 1] is the ORIGINAL index of the
        // match's last non-whitespace character; +1 makes `end` exclusive.
        val end = toOriginal[idx + needle.length - 1] + 1
        results.add(ResolvedRange(start, end))
        searchFrom = idx + needle.length // non-overlapping
    }
    return results
}

/** Levenshtein edit distance — the single scoring metric §2.2/review 2 (F14)
 *  specifies. Plain O(n·m) DP with a rolling pair of rows. Mirrors the TS
 *  `levenshtein`. */
private fun levenshtein(a: String, b: String): Int {
    if (a == b) return 0
    val m = a.length
    val n = b.length
    if (m == 0) return n
    if (n == 0) return m
    var prev = IntArray(n + 1) { it }
    var curr = IntArray(n + 1)
    for (i in 1..m) {
        curr[0] = i
        for (j in 1..n) {
            val cost = if (a[i - 1] == b[j - 1]) 0 else 1
            curr[j] = minOf(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
        }
        val swap = prev
        prev = curr
        curr = swap
    }
    return prev[n]
}

// F1 (perf, TS implementation review of T2) — ported unchanged: bounds how
// many candidates get scored at all (in document order) and how much of each
// comparison string is actually compared, so a pathological document (a huge
// repeated quote, or hundreds of matches of a short common phrase) doesn't
// make one anchoring lookup quadratic in either dimension. See
// doc-comments-anchor.ts's own doc comment on `resolveSelector` for the full
// reasoning; this Kotlin port keeps the identical constants so both runtimes'
// scoring agrees on which occurrences even get compared.
private const val MAX_SCORED_OCCURRENCES = 64
private const val EXACT_SAMPLE_CHARS = 32

/** The first and last `n` characters of `text`, with the (possibly huge)
 *  middle dropped. Mirrors the TS `sampleEdges`. */
private fun sampleEdges(text: String, n: Int): String {
    if (text.length <= n * 2) return text
    return text.substring(0, n) + text.substring(text.length - n)
}

/**
 * Finds where `sel` currently anchors in `fullText`, or reports that it no
 * longer does (`null`, standing in for the TS `'detached'` sentinel — Kotlin
 * has no string-literal union type to mirror it with). Mirrors
 * doc-comments-anchor.ts's `resolveSelector` field-for-field: zero occurrences
 * of `sel.exact` (whitespace-collapsed) -> `null`; exactly one -> that's the
 * anchor, `sel.occurrence` never consulted; multiple -> score every
 * (bounded) candidate by Levenshtein distance between
 * (`sel.prefix` + sampled `sel.exact` + `sel.suffix`) and the document text
 * surrounding that candidate (similarly sampled), take the lowest-distance
 * one, first-in-document-order wins a genuine tie.
 */
fun resolveSelector(fullText: String, sel: TextQuoteSelector): ResolvedRange? {
    val occurrences = findAllOccurrences(fullText, sel.exact)
    if (occurrences.isEmpty()) return null
    if (occurrences.size == 1) return occurrences[0]

    val wanted = sel.prefix + sampleEdges(sel.exact, EXACT_SAMPLE_CHARS) + sel.suffix
    val candidates = if (occurrences.size > MAX_SCORED_OCCURRENCES) {
        occurrences.subList(0, MAX_SCORED_OCCURRENCES)
    } else {
        occurrences
    }
    var best = candidates[0]
    var bestScore = Int.MAX_VALUE
    for (occ in candidates) {
        val windowStart = maxOf(0, occ.start - sel.prefix.length)
        val windowEnd = minOf(fullText.length, occ.end + sel.suffix.length)
        val candidate = fullText.substring(windowStart, occ.start) +
            sampleEdges(fullText.substring(occ.start, occ.end), EXACT_SAMPLE_CHARS) +
            fullText.substring(occ.end, windowEnd)
        val score = levenshtein(wanted, candidate)
        if (score < bestScore) {
            bestScore = score
            best = occ
        }
    }
    return best
}
