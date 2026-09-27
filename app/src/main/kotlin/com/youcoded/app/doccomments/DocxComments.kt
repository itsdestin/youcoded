// Word (.docx) comment READING on Android — T16 of the doc-comments build
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §3.2a, §8 T16).
// Kotlin port of desktop/src/main/doc-comments/docx-comments.ts's own
// `readDocxComments` (T10) — read-only; add/reply/resolve/reopen/move are
// T17's scope, not this file's.
//
// WHY this exists as real Kotlin rather than a WebView/JS reuse (§3.2a,
// mirroring §3.2's own F1 reasoning for desktop): Android's assistant path
// (the MCP script, §9) and a backgrounded PTY session must be able to read a
// Word comment with no WebView attached or foregrounded at all — routing a
// same-process Kotlin call out to a WebView instance that might not exist
// right now and back is not workable, the same conclusion §3.2's F1 reached
// for the desktop renderer.
//
// WHY `java.util.zip` + `javax.xml.parsers` need no new Gradle dependency
// (§3.2a): both are part of the JDK class library every Android device
// ships — `ZipFile` for random-access named-entry reads (`comments.xml`,
// `commentsExtended.xml`, `document.xml` — the .docx is loaded from its own
// file on disk, never as an in-memory byte array over IPC, since this Kotlin
// code already has direct filesystem access, unlike a renderer that needs
// `artifacts:read-binary` to get bytes at all), and
// `DocumentBuilderFactory`/`DocumentBuilder` for XML, producing the same
// `org.w3c.dom.Document` shape desktop's `@xmldom/xmldom`-compatible
// `linkedom` gives its own algorithm (§3.2a's own note: "the same DOM shape
// ... barely changes shape from an originally renderer-shaped design").
//
// SECURITY: the design (task prompt for T16) requires a secure XML parser
// configuration — no DTDs, no external entities — since `path` (and by
// extension the bytes this reads) can originate from model-controlled input
// at a native-tool or MCP surface (§1.5's own "a new tool surface must
// implement its own containment check, it inherits none" reasoning applies
// equally to what a parser will fetch/expand on a malicious document).
// `newSecureDocumentBuilderFactory()` below disables DOCTYPE declarations
// entirely (which also rules out entity expansion, external or internal) and
// external general/parameter entities and XInclude as defense in depth.
//
// PARSING ALGORITHM: pre-written from §3.2 (the design's own instruction —
// "same fields... same TextQuoteSelector construction... no mammoth/rendered-
// HTML dependency needed at read time") and ported field-for-field from
// docx-comments.ts's `readDocxComments`/`walkDocument`/`parseCommentsXml`/
// `parseCommentsExtendedXml`/`resolveRootParaId` — see each function's own
// comment for where it diverges from a literal line-for-line port (mostly:
// Kotlin's `Element.getAttribute` returns `""` for an absent attribute where
// the TS/DOM `getAttribute` returns `null`, so every attribute read here
// checks `hasAttribute` first wherever the TS code checked `!== null`).
package com.youcoded.app.doccomments

import org.w3c.dom.Document
import org.w3c.dom.Element
import org.w3c.dom.Node
import java.io.File
import java.io.StringReader
import java.util.zip.ZipFile
import javax.xml.parsers.DocumentBuilder
import javax.xml.parsers.DocumentBuilderFactory
import javax.xml.parsers.ParserConfigurationException
import org.xml.sax.InputSource

/** Mirrors desktop's `DocxReadError` union (docx-comments.ts). */
enum class DocxReadError {
    INVALID_DOCX,
    MISSING_DOCUMENT_PART,
    ARCHIVE_TOO_LARGE,
}

sealed class DocxReadResult {
    data class Ok(val comments: List<PersistedComment>) : DocxReadResult()
    data class Err(val error: DocxReadError) : DocxReadResult()
}

// §1.1's TextQuoteSelector doc comment: "~32 chars before/after,
// whitespace-collapsed" — same constants as docx-comments.ts.
private const val CONTEXT_CHARS = 32
private const val RAW_WINDOW_MULTIPLIER = 4

private val WHITESPACE_RUN = Regex("\\s+")

private fun collapseWhitespace(s: String): String = WHITESPACE_RUN.replace(s, " ")

private fun buildPrefix(fullText: String, start: Int): String {
    val rawStart = maxOf(0, start - CONTEXT_CHARS * RAW_WINDOW_MULTIPLIER)
    val raw = fullText.substring(rawStart, start)
    val collapsed = collapseWhitespace(raw)
    return collapsed.substring(maxOf(0, collapsed.length - CONTEXT_CHARS))
}

private fun buildSuffix(fullText: String, end: Int): String {
    val rawEnd = minOf(fullText.length, end + CONTEXT_CHARS * RAW_WINDOW_MULTIPLIER)
    val raw = fullText.substring(end, rawEnd)
    val collapsed = collapseWhitespace(raw)
    return collapsed.substring(0, minOf(CONTEXT_CHARS, collapsed.length))
}

/** How many times `exact` (verbatim) appears in `fullText` strictly before
 *  `start` — informational/for-display only, exactly like desktop's own
 *  `countOccurrencesBefore` doc comment explains (`resolveSelector` scores
 *  every remaining occurrence itself rather than trusting this field). */
private fun countOccurrencesBefore(fullText: String, exact: String, start: Int): Int {
    if (exact.isEmpty()) return 0
    var count = 0
    var from = 0
    while (true) {
        val idx = fullText.indexOf(exact, from)
        if (idx == -1 || idx >= start) break
        count++
        from = idx + 1
    }
    return count
}

/** One stack frame in `walkDocument`'s iterative walk — mirrors
 *  docx-comments.ts's `WalkFrame`. F3 (T10 implementation review, ported
 *  here even though it was never independently hit on the JVM's default
 *  stack size against the shared `deeply-nested.docx` fixture — see this
 *  file's own test for a stack-size-independent confirmation): a RECURSIVE
 *  visit()-per-element walk's call-stack depth grows with the DOM's NESTING
 *  depth, not its byte size, so an explicit heap-backed stack is used here
 *  for the same reason desktop's own walk was rewritten iterative, not
 *  because this specific fixture was observed to overflow a JVM thread's
 *  default stack (it doesn't — confirmed empirically while building this
 *  module — but Android's ART runtime is a different VM with its own
 *  stack-size defaults, and this walk has no reason to depend on either
 *  implementation's specific limit when an unbounded-depth version costs
 *  nothing extra to write). */
private class WalkFrame(val el: Element, val children: List<Element>, var idx: Int)

private class RangeInfo(var start: Int, var end: Int)

private fun elementChildren(el: Element): List<Element> {
    val out = mutableListOf<Element>()
    val nodes = el.childNodes
    for (i in 0 until nodes.length) {
        val n = nodes.item(i)
        if (n.nodeType == Node.ELEMENT_NODE) out.add(n as Element)
    }
    return out
}

/**
 * Walks `<w:body>` in document order building the same flat text a
 * text-only viewer would render, straight off `document.xml`'s own markup —
 * never mammoth's rendered HTML (this Kotlin module has no access to it and
 * doesn't need it: `w:commentRangeStart`/`End` already mark exactly which run
 * text a comment covers). Mirrors docx-comments.ts's `walkDocument`
 * (read-path fields only — `leaves`/write-path collection is T17's scope).
 *
 * `w:commentRangeStart`/`End` are recorded by their `w:id` (never
 * `w15:paraId` — that identifier only exists on `<w:p>` elements, and only
 * commentsExtended.xml's own entries key off it).
 */
private fun walkDocument(doc: Document): Pair<String, Map<String, RangeInfo>> {
    val ranges = LinkedHashMap<String, RangeInfo>()
    val fullText = StringBuilder()
    val bodies = doc.getElementsByTagName("w:body")
    if (bodies.length == 0) return Pair("", ranges)
    val body = bodies.item(0) as Element

    val stack = ArrayDeque<WalkFrame>()
    stack.addLast(WalkFrame(body, elementChildren(body), 0))

    while (stack.isNotEmpty()) {
        val frame = stack.last()
        if (frame.idx >= frame.children.size) {
            // Post-order step: append the paragraph-break newline after every
            // child of a `<w:p>` has been visited — mirrors the old recursive
            // shape's "append \n after the recursive call returns".
            if (frame.el.tagName == "w:p") fullText.append('\n')
            stack.removeLast()
            continue
        }
        val el = frame.children[frame.idx]
        frame.idx++
        when (el.tagName) {
            "w:t" -> fullText.append(el.textContent ?: "")
            "w:tab" -> fullText.append('\t')
            "w:br", "w:cr" -> fullText.append('\n')
            "w:commentRangeStart" -> {
                if (el.hasAttribute("w:id")) {
                    val id = el.getAttribute("w:id")
                    ranges[id] = RangeInfo(fullText.length, fullText.length)
                }
            }
            "w:commentRangeEnd" -> {
                if (el.hasAttribute("w:id")) {
                    ranges[el.getAttribute("w:id")]?.let { it.end = fullText.length }
                }
            }
        }
        // Descend into this element's own children next (pre-order for this
        // element's own tag handling above, matching the old `visit(el)` call).
        stack.addLast(WalkFrame(el, elementChildren(el), 0))
    }
    return Pair(fullText.toString(), ranges)
}

private class RawComment(
    val id: String,
    val author: String,
    val date: String,
    val text: String,
    val paraId: String?,
)

private class ExtendedInfo(val done: Boolean, val paraIdParent: String?)

/** A secure `DocumentBuilderFactory`: no DOCTYPE declarations (which also
 *  rules out entity expansion entirely, internal or external), no external
 *  general/parameter entities, no XInclude. Namespace-UNAWARE on purpose
 *  (the JDK default): every OOXML tag/attribute this module reads is
 *  addressed by its literal prefixed name (`"w:comment"`, `"w:id"`,
 *  `"w15:paraIdParent"`, ...), matching the way desktop's own `linkedom`
 *  `DOMParser` treats them (§3.2a: "the same DOM shape ... barely changes
 *  shape") — turning namespace-awareness ON would make `getTagName()` return
 *  only the local part and require namespace-URI-based lookups instead,
 *  which is not what this port's field-for-field mapping from
 *  docx-comments.ts assumes. */
private fun newSecureDocumentBuilder(): DocumentBuilder {
    val factory = DocumentBuilderFactory.newInstance()
    factory.isNamespaceAware = false
    factory.isXIncludeAware = false
    factory.isExpandEntityReferences = false
    // Disabling DOCTYPE declarations outright is OWASP's own recommended
    // single strongest defense (it also implies no internal/external entity
    // expansion and no external DTD fetch) — applied first; the two
    // external-entity features below are defense in depth for a factory
    // implementation that doesn't honor the DOCTYPE-disallow feature.
    val secureFeatures = listOf(
        "http://apache.org/xml/features/disallow-doctype-decl" to true,
        "http://xml.org/sax/features/external-general-entities" to false,
        "http://xml.org/sax/features/external-parameter-entities" to false,
        "http://apache.org/xml/features/nonvalidating/load-external-dtd" to false,
    )
    for ((feature, value) in secureFeatures) {
        try {
            factory.setFeature(feature, value)
        } catch (_: ParserConfigurationException) {
            // A given feature name not being recognized by whatever parser
            // implementation is on the classpath is not fatal — the other
            // features (and XIncludeAware/expandEntityReferences above) still
            // apply. Never silently swallow a REAL parse failure though:
            // this only catches the `setFeature` call itself.
        }
    }
    // NOTE: the JDK's own `javax.xml.XMLConstants.ACCESS_EXTERNAL_DTD`/
    // `ACCESS_EXTERNAL_SCHEMA` attribute constants (a common extra layer of
    // XXE defense on desktop JVMs) do not exist on Android's `javax.xml`
    // surface (`android.jar` has no such fields — confirmed by a compile
    // failure against `compileSdk 35` while building this module). They are
    // deliberately NOT used here. This is not a weaker posture: disabling
    // DOCTYPE declarations outright (`disallow-doctype-decl`, set above) is
    // OWASP's own recommended STRONGEST single defense against XXE, and
    // already rules out every entity-expansion and external-DTD-fetch attack
    // this attribute pair would otherwise guard against — the two features
    // below it are redundant defense in depth for a parser that doesn't
    // honor the DOCTYPE-disallow feature, not a substitute for it.
    return factory.newDocumentBuilder()
}

private fun parseXml(xml: String): Document =
    newSecureDocumentBuilder().parse(InputSource(StringReader(xml)))

private fun parseCommentsXml(xml: String): List<RawComment> {
    val doc = parseXml(xml)
    val nodes = doc.getElementsByTagName("w:comment")
    val out = mutableListOf<RawComment>()
    for (i in 0 until nodes.length) {
        val el = nodes.item(i) as Element
        val id = if (el.hasAttribute("w:id")) el.getAttribute("w:id") else ""
        val author = if (el.hasAttribute("w:author")) el.getAttribute("w:author") else ""
        val date = if (el.hasAttribute("w:date")) el.getAttribute("w:date") else ""
        val texts = el.getElementsByTagName("w:t")
        val text = StringBuilder()
        for (j in 0 until texts.length) text.append((texts.item(j) as Element).textContent ?: "")
        val paras = el.getElementsByTagName("w:p")
        // Real Word writes this as `w14:paraId` on the comment's own first
        // paragraph — the same identifier commentsExtended.xml's
        // `w15:paraId` refers back to.
        val paraId = if (paras.length > 0) {
            val p = paras.item(0) as Element
            if (p.hasAttribute("w14:paraId")) p.getAttribute("w14:paraId") else null
        } else null
        out.add(RawComment(id, author, date, text.toString(), paraId))
    }
    return out
}

private fun parseCommentsExtendedXml(xml: String): Map<String, ExtendedInfo> {
    val doc = parseXml(xml)
    val nodes = doc.getElementsByTagName("w15:commentEx")
    val map = LinkedHashMap<String, ExtendedInfo>()
    for (i in 0 until nodes.length) {
        val el = nodes.item(i) as Element
        if (!el.hasAttribute("w15:paraId")) continue
        val paraId = el.getAttribute("w15:paraId")
        val done = el.hasAttribute("w15:done") && el.getAttribute("w15:done") == "1"
        val paraIdParent = if (el.hasAttribute("w15:paraIdParent")) el.getAttribute("w15:paraIdParent") else null
        map[paraId] = ExtendedInfo(done, paraIdParent)
    }
    return map
}

/** Every Word comment author is a real, named colleague from THIS reader's
 *  point of view (§3.4) — reading never has grounds to claim `'user'`/
 *  `'assistant'`, which only apply to comments this app itself created (a
 *  write-path concern, T17). */
private fun toCommentAuthor(name: String): CommentAuthor = "person:" + name.ifEmpty { "Unknown" }

private fun parseDate(iso: String): Long = try {
    java.time.Instant.parse(iso).toEpochMilli()
} catch (_: Exception) {
    System.currentTimeMillis()
}

/** Follows a `w15:paraIdParent` chain up to its root — a reply-to-a-reply
 *  collapses into the SAME flat `replies[]` array as a direct reply, since
 *  `PersistedComment` has no nested-thread shape. A cycle (malformed input)
 *  stops the walk rather than looping forever. */
private fun resolveRootParaId(paraId: String, extended: Map<String, ExtendedInfo>): String {
    var current = paraId
    val seen = mutableSetOf<String>()
    while (true) {
        if (!seen.add(current)) return current
        val parent = extended[current]?.paraIdParent ?: return current
        current = parent
    }
}

/**
 * Reads every Word comment out of a `.docx` file on disk. `path` is the
 * file's own (project-relative) path, stamped onto each returned record —
 * these are never stored in a JSON sidecar (§1.1: Word/Excel comments live
 * inside the file itself), but the field still lets a caller identify which
 * file a record came from, the same as any other `PersistedComment`.
 *
 * Never throws on ordinary "nothing to read" shapes: a docx with no
 * `word/comments.xml` part at all (§3.2: "a .docx may simply not have this
 * part") returns an EMPTY list, not an error — same as desktop.
 */
fun readDocxComments(file: File, path: String): DocxReadResult {
    val zip: ZipFile
    try {
        zip = ZipFile(file)
    } catch (_: Exception) {
        return DocxReadResult.Err(DocxReadError.INVALID_DOCX)
    }
    zip.use { z ->
        val commentsEntry = z.getEntry("word/comments.xml")
            ?: return DocxReadResult.Ok(emptyList())
        val documentEntry = z.getEntry("word/document.xml")
            // A comments.xml part with no document.xml at all is not a real
            // Word file (every .docx has one) — refuse rather than silently
            // reporting no comments for what is actually a corrupt archive.
            ?: return DocxReadResult.Err(DocxReadError.MISSING_DOCUMENT_PART)
        val extendedEntry = z.getEntry("word/commentsExtended.xml")

        // F2-equivalent (zip-size-guard): refuse a decompression-bomb-shaped
        // archive BEFORE any entry is decompressed, checked against the
        // CENTRAL DIRECTORY's declared size, never against actually-
        // decompressed bytes.
        val sizeCheck = checkNamedEntriesWithinCeiling(
            z,
            listOf("word/comments.xml", "word/document.xml", "word/commentsExtended.xml"),
        )
        if (sizeCheck is ZipSizeGuardResult.ArchiveTooLarge) {
            return DocxReadResult.Err(DocxReadError.ARCHIVE_TOO_LARGE)
        }

        val commentsXml = z.getInputStream(commentsEntry).use { it.readBytes() }.toString(Charsets.UTF_8)
        val documentXml = z.getInputStream(documentEntry).use { it.readBytes() }.toString(Charsets.UTF_8)
        val extendedXml = extendedEntry?.let { z.getInputStream(it).use { s -> s.readBytes() }.toString(Charsets.UTF_8) }

        val rawComments = parseCommentsXml(commentsXml)
        val extended = extendedXml?.let { parseCommentsExtendedXml(it) } ?: emptyMap()
        val (fullText, ranges) = walkDocument(parseXml(documentXml))

        val byParaId = HashMap<String, RawComment>()
        for (c in rawComments) if (c.paraId != null) byParaId[c.paraId] = c

        // Group every raw comment.xml entry into its root's replies[] (if
        // it's a reply, however deeply nested) or the top-level list (if
        // it's a root).
        val repliesByRootParaId = HashMap<String, MutableList<CommentReply>>()
        val topLevel = mutableListOf<RawComment>()
        for (c in rawComments) {
            val rootParaId = c.paraId?.let { resolveRootParaId(it, extended) }
            val isReply = rootParaId != null && rootParaId != c.paraId && byParaId.containsKey(rootParaId)
            if (isReply) {
                val root = byParaId.getValue(rootParaId!!)
                val list = repliesByRootParaId.getOrPut(rootParaId) { mutableListOf() }
                list.add(
                    CommentReply(
                        id = "w-${root.id}-r${list.size + 1}",
                        author = toCommentAuthor(c.author),
                        text = c.text,
                        createdAt = parseDate(c.date),
                    ),
                )
            } else {
                topLevel.add(c)
            }
        }

        val comments = topLevel.map { c ->
            val range = ranges[c.id]
            val ext = c.paraId?.let { extended[it] }
            val exact = if (range != null) fullText.substring(range.start, range.end) else ""
            val selector = CommentSelector.Text(
                TextQuoteSelector(
                    exact = exact,
                    prefix = if (range != null) buildPrefix(fullText, range.start) else "",
                    suffix = if (range != null) buildSuffix(fullText, range.end) else "",
                    occurrence = if (range != null) countOccurrencesBefore(fullText, exact, range.start) else 0,
                ),
            )
            PersistedComment(
                id = "w-${c.id}",
                path = path,
                selector = selector,
                text = c.text,
                author = toCommentAuthor(c.author),
                createdAt = parseDate(c.date),
                replies = c.paraId?.let { repliesByRootParaId[it] } ?: emptyList(),
                resolved = ext?.done ?: false,
                // Word's own OOXML has no separate resolve/reopen AUDIT
                // TRAIL — only the CURRENT w15:done bit. `history` starts
                // empty for a freshly-read native comment (write path, T17,
                // is what would append to it).
                history = emptyList(),
            )
        }

        return DocxReadResult.Ok(comments)
    }
}
