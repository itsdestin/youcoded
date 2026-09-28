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
// Write-path (T17) imports — kept plain JDK/kotlinx.coroutines, no Android
// framework classes (mirrors the read path's own "runs in a plain JVM" pin,
// DocxCommentsTest.kt's `runsInAPlainJvmEnvironmentNoAndroidFrameworkClassInvolved`).
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.ConcurrentHashMap
import java.security.SecureRandom
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import javax.xml.transform.OutputKeys
import javax.xml.transform.TransformerFactory
import javax.xml.transform.dom.DOMSource
import javax.xml.transform.stream.StreamResult

/** Mirrors desktop's `DocxReadError` union (docx-comments.ts). `UNSAFE_XML`
 *  has no desktop counterpart yet (F1, implementation review, Android-only
 *  so far) — see `rejectDoctype`'s own doc comment for why this platform
 *  needs a check desktop's `linkedom`-based parser doesn't. */
enum class DocxReadError {
    INVALID_DOCX,
    MISSING_DOCUMENT_PART,
    ARCHIVE_TOO_LARGE,
    UNSAFE_XML,
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

/** T17's write-path addition to T16's `walkDocument` — a leaf is one
 *  contiguous span of `fullText` that came from a single DOM unit (a `<w:t>`
 *  run's text, a single-character `w:tab`/`w:br`/`w:cr`, or the synthetic
 *  paragraph-break `\n` a `</w:p>` contributes), gap-free by construction.
 *  Mirrors docx-comments.ts's `WriteLeaf` union — see that file's own doc
 *  comment for why this lets `resolveSelector`'s character OFFSETS be
 *  translated back into an exact DOM insertion point for add/move, something
 *  the read path's `ranges` map never needed (it only looks up an id Word
 *  ALREADY marked, never inserts one). `open` because it's a base class three
 *  concrete leaf kinds extend rather than a Kotlin `sealed` hierarchy, purely
 *  so `start`/`end` can live once in the base rather than being repeated in
 *  every subclass constructor. */
private open class WriteLeaf(val start: Int, val end: Int) {
    class Text(start: Int, end: Int, val run: Element, val textEl: Element) : WriteLeaf(start, end)
    class Atom(start: Int, end: Int, val run: Element) : WriteLeaf(start, end)
    class ParaBreak(start: Int, end: Int, val paragraph: Element) : WriteLeaf(start, end)
}

private class WalkResult(val fullText: String, val ranges: Map<String, RangeInfo>, val leaves: List<WriteLeaf>?)

/** Walks up from `el` (inclusive) for the nearest ancestor with `tagName`, or
 *  `null` if none exists before the document root. Used to find a `<w:t>`'s
 *  owning `<w:r>` — comment range markers are always inserted as RUN
 *  siblings, never inside a run's own children. Mirrors docx-comments.ts's
 *  `nearestAncestor`. */
private fun nearestAncestor(el: Element, tagName: String): Element? {
    var cur: Node? = el
    while (cur != null) {
        if (cur is Element && cur.tagName == tagName) return cur
        cur = cur.parentNode
    }
    return null
}

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
/**
 * `collectLeaves` (T17, write path only): also builds the `WriteLeaf[]` list
 * above, in the SAME single pass that builds `fullText` — never a second,
 * separately-maintained walk that could disagree with this one about what
 * `fullText` actually contains. Defaults to `false`, unchanged behaviour for
 * every existing (read-path) call site — mirrors docx-comments.ts's own
 * `walkDocument(doc, { collectLeaves })` option.
 */
private fun walkDocument(doc: Document, collectLeaves: Boolean = false): WalkResult {
    val ranges = LinkedHashMap<String, RangeInfo>()
    val fullText = StringBuilder()
    val leaves: MutableList<WriteLeaf>? = if (collectLeaves) mutableListOf() else null
    val bodies = doc.getElementsByTagName("w:body")
    if (bodies.length == 0) return WalkResult("", ranges, leaves)
    val body = bodies.item(0) as Element

    val stack = ArrayDeque<WalkFrame>()
    stack.addLast(WalkFrame(body, elementChildren(body), 0))

    while (stack.isNotEmpty()) {
        val frame = stack.last()
        if (frame.idx >= frame.children.size) {
            // Post-order step: append the paragraph-break newline after every
            // child of a `<w:p>` has been visited — mirrors the old recursive
            // shape's "append \n after the recursive call returns".
            if (frame.el.tagName == "w:p") {
                if (leaves != null) leaves.add(WriteLeaf.ParaBreak(fullText.length, fullText.length + 1, frame.el))
                fullText.append('\n')
            }
            stack.removeLast()
            continue
        }
        val el = frame.children[frame.idx]
        frame.idx++
        when (el.tagName) {
            "w:t" -> {
                val text = el.textContent ?: ""
                // An empty <w:t> contributes zero characters — no leaf needed
                // (and none would be addressable by any offset anyway).
                if (leaves != null && text.isNotEmpty()) {
                    val run = nearestAncestor(el, "w:r") ?: el
                    leaves.add(WriteLeaf.Text(fullText.length, fullText.length + text.length, run, el))
                }
                fullText.append(text)
            }
            "w:tab" -> {
                if (leaves != null) leaves.add(WriteLeaf.Atom(fullText.length, fullText.length + 1, nearestAncestor(el, "w:r") ?: el))
                fullText.append('\t')
            }
            "w:br", "w:cr" -> {
                if (leaves != null) leaves.add(WriteLeaf.Atom(fullText.length, fullText.length + 1, nearestAncestor(el, "w:r") ?: el))
                fullText.append('\n')
            }
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
    return WalkResult(fullText.toString(), ranges, leaves)
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

/** Thrown by `parseXml` when a part's raw XML text contains a `<!DOCTYPE`
 *  declaration — refused BEFORE any parser sees it (F1, implementation
 *  review — high, security). WHY the factory's own `disallow-doctype-decl`
 *  feature (above) isn't trustworthy enough on its own: this module's JVM
 *  unit tests run against the JVM's bundled Xerces implementation, which DOES
 *  honor that feature name and throws its own `SAXParseException` on a
 *  DOCTYPE — so a real bug here would never surface in `./gradlew test` at
 *  all. Android's actual on-device `javax.xml.parsers` implementation is
 *  Expat-backed, not Xerces, and may not recognize the
 *  `"http://apache.org/xml/features/disallow-doctype-decl"` feature URI —
 *  `newSecureDocumentBuilder`'s own `setFeature` loop silently swallows an
 *  unrecognized feature (catching `ParserConfigurationException` on the
 *  `setFeature` CALL itself, with no log), which would leave DOCTYPE
 *  processing — and by extension internal-entity expansion, a "billion
 *  laughs" attack — reachable on a real device despite every JVM test here
 *  passing. A plain case-insensitive substring scan is platform-independent
 *  by CONSTRUCTION: it never depends on which parser implementation, or
 *  which of its features, actually got applied, so it refuses identically on
 *  the JVM and on a real device. No anchoring to the start of the string is
 *  needed to "allow leading BOM/whitespace/declaration" — a literal `<!DOCTYPE`
 *  can never legitimately appear anywhere in well-formed XML text content
 *  either (a literal `<` in text must be escaped as `&lt;`), so a match
 *  ANYWHERE in the string is already an unambiguous real markup declaration,
 *  never a false positive off ordinary document prose. The factory's own
 *  security features stay configured too, as defense in depth for whatever
 *  parser DOES honor them — this check is the layer that doesn't need to
 *  trust that at all. */
private class DocxUnsafeXmlDoctypeException : Exception()

private val DOCTYPE_DECLARATION = Regex("(?i)<!DOCTYPE")

private fun rejectDoctype(xml: String) {
    if (DOCTYPE_DECLARATION.containsMatchIn(xml)) throw DocxUnsafeXmlDoctypeException()
}

private fun parseXml(xml: String): Document {
    rejectDoctype(xml)
    return newSecureDocumentBuilder().parse(InputSource(StringReader(xml)))
}

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
    // F1/F3 (implementation review): `rejectDoctype` (thrown from `parseXml`,
    // reached indirectly through `parseCommentsXml`/`parseCommentsExtendedXml`/
    // `walkDocument`) and `readEntryBounded` (DocCommentsZipSizeGuard.kt, F3's
    // decompression-time backstop) both signal by throwing rather than by a
    // sealed result, since they're reached several calls deep inside
    // `readDocxCommentsFromZip`'s own pipeline — catching both here, in the
    // ONE place this function actually returns a `DocxReadResult`, is what
    // stays honest about the exception rather than a swallow-and-guess
    // (`newSecureDocumentBuilder`'s own `setFeature` catch is the failure mode
    // F1 exists to compensate for — this catch is never that: it's a REAL,
    // logged-by-being-a-typed-result outcome, not a silently-ignored one).
    return try {
        zip.use { z -> readDocxCommentsFromZip(z, path) }
    } catch (_: DocxUnsafeXmlDoctypeException) {
        DocxReadResult.Err(DocxReadError.UNSAFE_XML)
    } catch (_: ZipBombDetectedException) {
        DocxReadResult.Err(DocxReadError.ARCHIVE_TOO_LARGE)
    }
}

private fun readDocxCommentsFromZip(z: ZipFile, path: String): DocxReadResult {
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
    // decompressed bytes. Kept as the fast first line of defense; F3's
    // `readEntryBounded` call just below is the backstop that doesn't
    // trust this declared metadata at all.
    val sizeCheck = checkNamedEntriesWithinCeiling(
        z,
        listOf("word/comments.xml", "word/document.xml", "word/commentsExtended.xml"),
    )
    if (sizeCheck is ZipSizeGuardResult.ArchiveTooLarge) {
        return DocxReadResult.Err(DocxReadError.ARCHIVE_TOO_LARGE)
    }

    // F3: bounded, byte-counting decompression (DocCommentsZipSizeGuard.kt)
    // — counts REAL decompressed bytes as they arrive and throws
    // `ZipBombDetectedException` (caught by `readDocxComments` above) the
    // moment they exceed the ceiling, regardless of what the archive's own
    // metadata declared.
    val commentsXml = readEntryBounded(z, commentsEntry).toString(Charsets.UTF_8)
    val documentXml = readEntryBounded(z, documentEntry).toString(Charsets.UTF_8)
    val extendedXml = extendedEntry?.let { readEntryBounded(z, it).toString(Charsets.UTF_8) }

    val rawComments = parseCommentsXml(commentsXml)
    val extended = extendedXml?.let { parseCommentsExtendedXml(it) } ?: emptyMap()
    val walked = walkDocument(parseXml(documentXml))
    val fullText = walked.fullText
    val ranges = walked.ranges

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

// =============================================================================
// Word (.docx) comment WRITING on Android — T17 of the doc-comments build
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §3.2a/§3.3, §8
// T17). add / reply / resolve / reopen / move, mirroring desktop's own
// docx-comments.ts write section (T11, post-review-fixes commit c496576bd and
// later) field-for-field: id/paraId uniqueness scanned fresh from the file
// (never assumed monotonic), the Word 2016+ commentsIds.xml/
// commentsExtensible.xml entries when (and only when) already present, the
// move/repoint algorithm (review 3, F2), byte-identical pass-through of every
// part this operation didn't touch, verify-by-reread with THIS file's own
// `readDocxComments`, and a rolling backup outside any project.
//
// WHY the write pipeline below (`writeDocxMutation`) verifies BEFORE ever
// touching the real target file, rather than desktop's write-then-verify-
// then-restore-from-backup shape: Kotlin builds the mutated archive fully
// in-memory/on-a-scratch-file first, so "verify by reread" can run against
// that SCRATCH file (never the live target) before any real replace happens.
// This gives the identical outward guarantee §3.3 step 6 requires — a failed
// write leaves the target byte-for-byte what it was before, never a
// half-written third state — through a simpler mechanism than an actual
// disk-level rollback: there is nothing to roll back, because the target was
// never written to in the first place. The backup file (step 1) is still
// written unconditionally before the real replace, as the same STANDING
// safety net the design requires (kept after success, not just for this
// write's own failure path) — it is not what makes verify-failure safe here,
// that's simply "don't do the replace."
//
// WHY cross-process locking (com.youcoded.app.artifacts.CasWrite.kt's
// `mutateFileUnderLock`) is deliberately NOT used for the real `.docx` target
// file itself, only an in-process kotlinx.coroutines Mutex per absolute path:
// design §1.5 ("Kotlin's own file-locking") works through this exact question
// and its answer is explicit — "unlike the JSON sidecar, the MCP script never
// touches a .docx/.xlsx file directly — it goes through the pending-mutation
// queue (§9.2, T20), whose applier is SessionService's own polling loop
// running in the SAME process as every Kotlin-originated write... Android
// never needs the desktop main process's cross-process mkdir-lock for THIS
// path, only ordinary in-process exclusion." An in-process Mutex keyed by
// absolute path is therefore already the CORRECT and SUFFICIENT primitive per
// the design's own reasoning — reaching for the mkdir-based cross-process
// lock here would add real overhead (extra syscalls, a `.lock` directory
// racing on every write) to guard against a process that structurally cannot
// reach this file directly. The ATOMIC-REPLACE mechanics below (write to a
// sibling `.tmp` path, then `Files.move` with `ATOMIC_MOVE`, falling back to
// `REPLACE_EXISTING`) still mirror `CasWrite.kt`'s own shape exactly, so this
// module follows that file's PATTERN even where it doesn't call its lock.
// =============================================================================

private const val W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
private const val W14_NS = "http://schemas.microsoft.com/office/word/2010/wordml"
private const val W15_NS = "http://schemas.microsoft.com/office/word/2012/wordml"
private const val RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
private const val COMMENTS_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"
private const val COMMENTS_EXT_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml"
private const val COMMENTS_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments"
private const val COMMENTS_EXT_REL_TYPE = "http://schemas.microsoft.com/office/2011/relationships/commentsExtended"

private val EMPTY_COMMENTS_XML =
    """<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="$W_NS" xmlns:w14="$W14_NS"></w:comments>"""
private val EMPTY_EXTENDED_XML =
    """<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:commentsEx xmlns:w15="$W15_NS"></w15:commentsEx>"""
private val EMPTY_RELS_XML =
    """<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="$RELS_NS"></Relationships>"""

/** Mirrors desktop's `DocxWriteError` union (docx-comments.ts) — every value
 *  carries its own wire string so a dispatch layer never re-derives one from
 *  the enum name (avoiding the read path's `.name.lowercase().replace(...)`
 *  trick drifting from desktop's own literal strings for a NEW error). */
enum class DocxWriteError(val wire: String) {
    INVALID_DOCX("invalid-docx"),
    MISSING_DOCUMENT_PART("missing-document-part"),
    ARCHIVE_TOO_LARGE("archive-too-large"),
    UNSAFE_XML("unsafe-xml"),
    COMMENT_NOT_FOUND("comment-not-found"),
    SELECTOR_NOT_FOUND("selector-not-found"),
    INVALID_SELECTOR("invalid-selector"),
    READ_FAILED("read-failed"),
    BACKUP_FAILED("backup-failed"),
    WRITE_FAILED("write-failed"),
    VERIFY_FAILED("verify-failed"),
    // T17 follow-up (design §3.3's new step 0, review round 3 F4): the SAME
    // pre-write lock-file check desktop's write-pipeline.ts now does — a
    // plain sibling-file check via Kotlin's own file APIs, refused BEFORE
    // step 1 (backup) even runs. See `isFileOpenElsewhere` below.
    FILE_OPEN_ELSEWHERE("file-open-elsewhere"),
}

/** Kotlin port of desktop's `xml-text-safety.ts` — see that file's own
 *  header for the full XML 1.0 well-formedness citation (control characters
 *  U+0000-U+0008, U+000B-U+000C, U+000E-U+001F are illegal EVERYWHERE in a
 *  well-formed document, even as a numeric character reference; tab/LF/CR
 *  are the only C0 codepoints excluded).
 *
 *  Originally (commit ffda4b654) this REFUSED text containing one of these
 *  characters — a standalone JDK 21 probe (`javax.xml.parsers`/
 *  `javax.xml.transform`, the exact APIs this module uses) confirmed
 *  Kotlin's failure mode without the check is a crash, not silent
 *  corruption: `Document.createElement`/`.setTextContent()` accept an
 *  illegal control character with no complaint, but
 *  `TransformerFactory.newTransformer().transform(...)` — the SAME call
 *  `serializePart` below uses — THROWS `TransformerException` the moment it
 *  tries to SERIALIZE that text, uncaught, out of a suspend function with no
 *  try/catch around it.
 *
 *  Changed 2026-09-27 to STRIP those characters instead (matching desktop's
 *  own xml-text-safety.ts change, same reasoning): a user has no way to see
 *  or remove one of these characters themselves (they arrive via paste), so
 *  a refusal they can't act on is worse than silently dropping a handful of
 *  invisible bytes — the visible text is unaffected either way. Stripping
 *  BEFORE ever constructing a text node still avoids the crash above; it
 *  just no longer needs a typed refusal to do it. */
private val ILLEGAL_XML_CHAR_REGEX = Regex("[\u0000-\u0008\u000B\u000C\u000E-\u001F]")

private fun stripIllegalXmlChars(text: String): String = text.replace(ILLEGAL_XML_CHAR_REGEX, "")

sealed class DocxWriteResult<out T> {
    data class Ok<T>(val value: T) : DocxWriteResult<T>()
    data class Err(val error: DocxWriteError) : DocxWriteResult<Nothing>()
}

/** Copies every ATTRIBUTE (not child element) from `from` onto `to` — used by
 *  `splitRunAtOffsets` so a run's own `<w:r w:rsidR="..." w:rsidRPr="...">`
 *  attributes survive a split, not just its `w:rPr` CHILD (a real Word 365
 *  file always carries rsid attributes on its runs). Mirrors docx-comments.ts's
 *  `copyAttributes` (T11 review, F3). */
private fun copyAttributes(from: Element, to: Element) {
    val attrs = from.attributes ?: return
    for (i in 0 until attrs.length) {
        val attr = attrs.item(i)
        to.setAttribute(attr.nodeName, attr.nodeValue ?: "")
    }
}

private fun elementsByTag(doc: Document, tag: String): List<Element> {
    val nodes = doc.getElementsByTagName(tag)
    return (0 until nodes.length).map { nodes.item(it) as Element }
}

private fun elementsByTag(el: Element, tag: String): List<Element> {
    val nodes = el.getElementsByTagName(tag)
    return (0 until nodes.length).map { nodes.item(it) as Element }
}

private fun findByAttr(doc: Document, tag: String, attr: String, value: String): Element? =
    elementsByTag(doc, tag).find { it.hasAttribute(attr) && it.getAttribute(attr) == value }

/** `"w-3"` -> `"3"`; `null` for anything not shaped like a Word-native id
 *  this reader's own `readDocxComments` mints (`id: "w-${c.id}"`). A reply id
 *  (`w-3-r1`) is never a valid target for reply/resolve/reopen/move — those
 *  always act on a whole THREAD, never a single reply within it. */
private fun stripWPrefix(id: String): String? = Regex("^w-([^-]+)$").find(id)?.groupValues?.get(1)

/** §3.4: a reply/add made from this app must round-trip back into `w:author`
 *  naming "the account's display name or 'You'" — NEVER overwriting a
 *  colleague's own original `w:author` (only ever called to author a
 *  BRAND-NEW `<w:comment>`). No accounts exist yet (§1.2), so `'user'` is
 *  literally "You"; `'assistant'` is a plain, honest label. */
private fun commentAuthorToDisplayName(author: CommentAuthor): String = when {
    author == "user" -> "You"
    author == "assistant" -> "Assistant"
    author.startsWith("person:") -> author.removePrefix("person:").ifEmpty { "Unknown" }
    else -> "Unknown"
}

private fun maxExistingCommentId(commentsDoc: Document): Int {
    var max = -1
    for (el in elementsByTag(commentsDoc, "w:comment")) {
        val n = el.getAttribute("w:id").toIntOrNull()
        if (n != null && n > max) max = n
    }
    return max
}

private fun findCommentParaId(commentsDoc: Document, rawId: String): String? {
    val el = findByAttr(commentsDoc, "w:comment", "w:id", rawId) ?: return null
    val p = elementsByTag(el, "w:p").firstOrNull() ?: return null
    return if (p.hasAttribute("w14:paraId")) p.getAttribute("w14:paraId") else null
}

/** Loaded, mutable in-memory representation of every part a write might
 *  touch. Mirrors desktop's `LoadedArchive` (docx-comments.ts) field-for-
 *  field, including its `*Touched`/`*Changed`/`*Original` bookkeeping —
 *  see that type's own doc comment for why each exists (an untouched part
 *  must be written back byte-identical; a part that started absent and stays
 *  untouched by THIS operation must stay absent from the output, never gain
 *  an orphan empty shell). Every OTHER part in the archive (images,
 *  styles.xml, numbering.xml, ...) is never parsed or touched — `zip` (the
 *  source archive, kept OPEN by the caller across load+mutate+serialize, see
 *  `loadMutateSerialize`) is consulted directly at serialize time so those
 *  parts can be streamed straight through instead of ever being decompressed
 *  into memory here (review F1, android-xlsx-review — the same "decompresses
 *  and re-compresses EVERY part, not just the ones a mutation touches" bug
 *  confirmed present in this module too, not just `XlsxComments.kt`; this
 *  REPLACES the prior `entries: LinkedHashMap<String, ByteArray>` field,
 *  which used to `readEntryBounded` — fully decompress — every non-tracked
 *  entry unconditionally). */
private class LoadedArchive(
    val zip: ZipFile,
    val documentDoc: Document,
    val documentXmlOriginal: String,
    var documentChanged: Boolean = false,
    val commentsDoc: Document,
    val commentsIsNew: Boolean,
    var commentsTouched: Boolean,
    val commentsXmlOriginal: String?,
    var commentsChanged: Boolean = false,
    val extendedDoc: Document,
    val extendedIsNew: Boolean,
    var extendedTouched: Boolean,
    val extendedXmlOriginal: String?,
    var extendedChanged: Boolean = false,
    val contentTypesDoc: Document,
    val contentTypesXmlOriginal: String,
    var contentTypesChanged: Boolean = false,
    val relsDoc: Document,
    val relsXmlOriginal: String?,
    var relsTouched: Boolean,
    var relsChanged: Boolean = false,
    val commentsIdsDoc: Document?,
    val commentsIdsXmlOriginal: String?,
    var commentsIdsChanged: Boolean = false,
    val commentsExtensibleDoc: Document?,
    val commentsExtensibleXmlOriginal: String?,
    var commentsExtensibleChanged: Boolean = false,
)

/** Union of every `w14:paraId`/`w15:paraId` already in use anywhere in the
 *  archive — document.xml's own paragraphs, comments.xml's comment
 *  paragraphs, AND commentsExtended.xml's own entries — so a freshly
 *  generated one can never collide with ANY of them. Mirrors
 *  `collectAllParaIds` (docx-comments.ts). */
private fun collectAllParaIds(archive: LoadedArchive): Set<String> {
    val set = mutableSetOf<String>()
    for (doc in listOf(archive.documentDoc, archive.commentsDoc)) {
        for (el in elementsByTag(doc, "w:p")) {
            if (el.hasAttribute("w14:paraId")) set.add(el.getAttribute("w14:paraId"))
        }
    }
    for (el in elementsByTag(archive.extendedDoc, "w15:commentEx")) {
        if (el.hasAttribute("w15:paraId")) set.add(el.getAttribute("w15:paraId"))
    }
    return set
}

private val secureRandom = SecureRandom()

private fun randomHex8(): String {
    val bytes = ByteArray(4)
    secureRandom.nextBytes(bytes)
    return bytes.joinToString("") { "%02X".format(it) }
}

/** An 8-hex-digit value "the way Word itself does" — never sequential,
 *  re-rolled on the rare collision against every paraId already in the
 *  archive. Mirrors `generateParaId` (docx-comments.ts, F6). */
private fun generateParaId(existing: Set<String>): String {
    repeat(100) {
        val candidate = randomHex8()
        if (!existing.contains(candidate)) return candidate
    }
    throw IllegalStateException("docx-comments: could not generate a unique paraId")
}

/** Union of every `w16cid:durableId`/`w16cex:durableId` already in use.
 *  Mirrors `collectAllDurableIds` (docx-comments.ts, F4). */
private fun collectAllDurableIds(archive: LoadedArchive): Set<String> {
    val set = mutableSetOf<String>()
    archive.commentsIdsDoc?.let { doc ->
        for (el in elementsByTag(doc, "w16cid:commentId")) {
            if (el.hasAttribute("w16cid:durableId")) set.add(el.getAttribute("w16cid:durableId"))
        }
    }
    archive.commentsExtensibleDoc?.let { doc ->
        for (el in elementsByTag(doc, "w16cex:commentExtensible")) {
            if (el.hasAttribute("w16cex:durableId")) set.add(el.getAttribute("w16cex:durableId"))
        }
    }
    return set
}

private fun generateDurableId(existing: Set<String>): String {
    repeat(100) {
        val candidate = randomHex8()
        if (!existing.contains(candidate)) return candidate
    }
    throw IllegalStateException("docx-comments: could not generate a unique durableId")
}

private fun appendCommentIdsEntry(doc: Document, paraId: String, durableId: String) {
    val el = doc.createElement("w16cid:commentId")
    el.setAttribute("w16cid:paraId", paraId)
    el.setAttribute("w16cid:durableId", durableId)
    doc.documentElement.appendChild(el)
}

private fun appendCommentExtensibleEntry(doc: Document, durableId: String, dateUtc: String) {
    val el = doc.createElement("w16cex:commentExtensible")
    el.setAttribute("w16cex:durableId", durableId)
    el.setAttribute("w16cex:dateUtc", dateUtc)
    doc.documentElement.appendChild(el)
}

/** F4: adds matching entries to whichever of commentsIds.xml/
 *  commentsExtensible.xml is actually present for a BRAND-NEW `<w:comment>`
 *  this operation just created (add or reply). Does nothing if NEITHER part
 *  exists — this module never CREATES them. Mirrors
 *  `recordCommentExtensionParts` (docx-comments.ts). */
private fun recordCommentExtensionParts(archive: LoadedArchive, paraId: String) {
    if (archive.commentsIdsDoc == null && archive.commentsExtensibleDoc == null) return
    val durableId = generateDurableId(collectAllDurableIds(archive))
    archive.commentsIdsDoc?.let {
        appendCommentIdsEntry(it, paraId, durableId)
        archive.commentsIdsChanged = true
    }
    archive.commentsExtensibleDoc?.let {
        appendCommentExtensibleEntry(it, durableId, isoNow())
        archive.commentsExtensibleChanged = true
    }
}

private fun nextRelId(relsDoc: Document): String {
    var max = 0
    for (el in elementsByTag(relsDoc, "Relationship")) {
        val m = Regex("^rId(\\d+)$").find(el.getAttribute("Id"))
        if (m != null) max = maxOf(max, m.groupValues[1].toInt())
    }
    return "rId${max + 1}"
}

private fun addContentTypeOverride(contentTypesDoc: Document, partName: String, contentType: String) {
    val exists = elementsByTag(contentTypesDoc, "Override").any { it.getAttribute("PartName") == partName }
    if (exists) return
    val el = contentTypesDoc.createElement("Override")
    el.setAttribute("PartName", partName)
    el.setAttribute("ContentType", contentType)
    contentTypesDoc.documentElement.appendChild(el)
}

private fun addRelationship(relsDoc: Document, type: String, target: String) {
    val exists = elementsByTag(relsDoc, "Relationship").any { it.getAttribute("Target") == target }
    if (exists) return
    val el = relsDoc.createElement("Relationship")
    el.setAttribute("Id", nextRelId(relsDoc))
    el.setAttribute("Type", type)
    el.setAttribute("Target", target)
    relsDoc.documentElement.appendChild(el)
}

/** §3.3 step 2 — called only when `archive.commentsIsNew`. Mirrors
 *  `ensureCommentsPart` (docx-comments.ts) EXACTLY, including its own
 *  narrow scope: it does not set `relsTouched` — see that function's own doc
 *  comment above `LoadedArchive.relsTouched` in the TS source for why (a file
 *  with literally no pre-existing rels part at all is a structurally unusual
 *  shape no real fixture exercises; porting the identical behaviour here
 *  keeps this module's parity claim honest rather than "fixing" an edge case
 *  the reference implementation itself doesn't handle). */
private fun ensureCommentsPart(archive: LoadedArchive) {
    addContentTypeOverride(archive.contentTypesDoc, "/word/comments.xml", COMMENTS_CONTENT_TYPE)
    addRelationship(archive.relsDoc, COMMENTS_REL_TYPE, "comments.xml")
    archive.commentsTouched = true
    archive.contentTypesChanged = true
    archive.relsChanged = true
}

private fun ensureExtendedPart(archive: LoadedArchive) {
    addContentTypeOverride(archive.contentTypesDoc, "/word/commentsExtended.xml", COMMENTS_EXT_CONTENT_TYPE)
    addRelationship(archive.relsDoc, COMMENTS_EXT_REL_TYPE, "commentsExtended.xml")
    archive.extendedTouched = true
    archive.contentTypesChanged = true
    archive.relsChanged = true
}

private fun appendCommentEntry(commentsDoc: Document, id: Int, author: String, date: String, paraId: String, text: String) {
    val commentEl = commentsDoc.createElement("w:comment")
    commentEl.setAttribute("w:id", id.toString())
    commentEl.setAttribute("w:author", author)
    commentEl.setAttribute("w:date", date)
    val pEl = commentsDoc.createElement("w:p")
    pEl.setAttribute("w14:paraId", paraId)
    val rEl = commentsDoc.createElement("w:r")
    val tEl = commentsDoc.createElement("w:t")
    tEl.setAttribute("xml:space", "preserve")
    tEl.textContent = text
    rEl.appendChild(tEl)
    pEl.appendChild(rEl)
    commentEl.appendChild(pEl)
    commentsDoc.documentElement.appendChild(commentEl)
}

/** §3.3 step 4 (and step 3's `w15:paraIdParent`): update an EXISTING
 *  `w15:commentEx` entry in place when one already exists for `paraId`
 *  (never duplicated), or create a fresh one when it doesn't. Mirrors
 *  `upsertExtendedEntry` (docx-comments.ts). */
private fun upsertExtendedEntry(extendedDoc: Document, paraId: String, done: Boolean, paraIdParent: String?) {
    val existing = findByAttr(extendedDoc, "w15:commentEx", "w15:paraId", paraId)
    val el = existing ?: extendedDoc.createElement("w15:commentEx")
    el.setAttribute("w15:paraId", paraId)
    el.setAttribute("w15:done", if (done) "1" else "0")
    if (paraIdParent != null) el.setAttribute("w15:paraIdParent", paraIdParent)
    if (existing == null) extendedDoc.documentElement.appendChild(el)
}

/**
 * Splits `run` (whose text lives in its child `textEl`) at every offset in
 * `offsetsInRun`, replacing `run` in the tree with the resulting pieces —
 * clones of `run`'s own `w:rPr` (so formatting survives) PLUS every
 * ATTRIBUTE `run` itself carries (rsids etc. — `copyAttributes`), each
 * holding one slice of the original text. Returns the pieces AND the full
 * cut-point list so the caller can look up "the piece that starts/ends at
 * exactly offset X". A no-op (`offsetsInRun` has nothing strictly interior)
 * returns `[run]` unchanged. Mirrors `splitRunAtOffsets` (docx-comments.ts).
 */
private fun splitRunAtOffsets(doc: Document, run: Element, textEl: Element, offsetsInRun: List<Int>): Pair<List<Element>, List<Int>> {
    val text = textEl.textContent ?: ""
    val cutsSet = sortedSetOf(0, text.length)
    for (o in offsetsInRun) if (o > 0 && o < text.length) cutsSet.add(o)
    val cuts = cutsSet.toList()
    if (cuts.size <= 2) return Pair(listOf(run), listOf(0, text.length))

    val rPr = elementsByTag(run, "w:rPr").firstOrNull()
    val pieces = mutableListOf<Element>()
    for (i in 0 until cuts.size - 1) {
        val newRun = doc.createElement("w:r")
        copyAttributes(run, newRun)
        if (rPr != null) newRun.appendChild(rPr.cloneNode(true))
        val newT = doc.createElement("w:t")
        newT.setAttribute("xml:space", "preserve")
        newT.textContent = text.substring(cuts[i], cuts[i + 1])
        newRun.appendChild(newT)
        pieces.add(newRun)
    }
    val parent = run.parentNode as Element
    for (piece in pieces) parent.insertBefore(piece, run)
    parent.removeChild(run)
    return Pair(pieces, cuts)
}

private class InsertionAnchor(val parent: Element, val before: Node?)

/** Resolves WHERE (a DOM `parent`/`before` pair — `parent.insertBefore(new,
 *  before)`, `before === null` meaning "append") to place a marker for
 *  character offset `offset`, splitting a run when the offset falls strictly
 *  inside one. Mirrors `anchorForOffset` (docx-comments.ts). */
private fun anchorForOffset(doc: Document, leaves: List<WriteLeaf>, offset: Int, edge: String): InsertionAnchor {
    val idx = leaves.indexOfFirst { offset >= it.start && offset < it.end }
    if (idx == -1) {
        // offset === fullText.length (or the document has no leaves at all,
        // which resolveSelector already ruled out by finding a match).
        val last = leaves.lastOrNull() ?: throw IllegalStateException("docx-comments: no leaves to anchor an insertion against")
        return when (last) {
            is WriteLeaf.ParaBreak -> InsertionAnchor(last.paragraph, null)
            is WriteLeaf.Text -> InsertionAnchor(last.run.parentNode as Element, last.run.nextSibling)
            is WriteLeaf.Atom -> InsertionAnchor(last.run.parentNode as Element, last.run.nextSibling)
            else -> throw IllegalStateException("docx-comments: unreachable leaf kind")
        }
    }
    val leaf = leaves[idx]
    if (leaf is WriteLeaf.ParaBreak) {
        // The only reachable offset here is leaf.start — "immediately after
        // the last real content of the paragraph that just closed, before
        // the implicit paragraph break".
        return InsertionAnchor(leaf.paragraph, null)
    }
    val run = when (leaf) {
        is WriteLeaf.Text -> leaf.run
        is WriteLeaf.Atom -> leaf.run
        else -> throw IllegalStateException("docx-comments: unreachable leaf kind")
    }
    val offsetInRun = offset - leaf.start
    val runLen = leaf.end - leaf.start
    // A BOUNDARY position never needs a split — see docx-comments.ts's own
    // doc comment for why this is checked FIRST, before ever splitting.
    if (leaf is WriteLeaf.Atom || offsetInRun == 0) {
        return InsertionAnchor(run.parentNode as Element, run)
    }
    if (offsetInRun == runLen) {
        return InsertionAnchor(run.parentNode as Element, run.nextSibling)
    }
    val textEl = (leaf as WriteLeaf.Text).textEl
    val (pieces, cuts) = splitRunAtOffsets(doc, run, textEl, listOf(offsetInRun))
    return if (edge == "start") {
        val piece = pieces[cuts.indexOf(offsetInRun)]
        InsertionAnchor(piece.parentNode as Element, piece)
    } else {
        val piece = pieces[cuts.indexOf(offsetInRun) - 1]
        InsertionAnchor(piece.parentNode as Element, piece.nextSibling)
    }
}

private fun buildCommentReferenceRun(doc: Document, id: String): Element {
    val refRun = doc.createElement("w:r")
    val rPr = doc.createElement("w:rPr")
    val rStyle = doc.createElement("w:rStyle")
    rStyle.setAttribute("w:val", "CommentReference")
    rPr.appendChild(rStyle)
    refRun.appendChild(rPr)
    val ref = doc.createElement("w:commentReference")
    ref.setAttribute("w:id", id)
    refRun.appendChild(ref)
    return refRun
}

/**
 * Inserts a `w:commentRangeStart`/`w:commentRangeEnd` pair for `id` at
 * `[start, end)`, plus the `w:commentReference` run immediately after the end
 * marker. When `start` and `end` fall in the SAME original text leaf, both
 * cuts are made in ONE `splitRunAtOffsets` call; when they fall in different
 * leaves, the two ends are resolved independently. Mirrors
 * `insertCommentRangeMarkers` (docx-comments.ts).
 */
private fun insertCommentRangeMarkers(doc: Document, leaves: List<WriteLeaf>, start: Int, end: Int, id: String) {
    val startMarker = doc.createElement("w:commentRangeStart")
    startMarker.setAttribute("w:id", id)
    val endMarker = doc.createElement("w:commentRangeEnd")
    endMarker.setAttribute("w:id", id)
    val refRun = buildCommentReferenceRun(doc, id)

    val startIdx = leaves.indexOfFirst { start >= it.start && start < it.end }
    val endIdx = leaves.indexOfFirst { end >= it.start && end < it.end }

    if (startIdx != -1 && startIdx == endIdx && leaves[startIdx] is WriteLeaf.Text) {
        val leaf = leaves[startIdx] as WriteLeaf.Text
        val so = start - leaf.start
        val eo = end - leaf.start
        val (pieces, cuts) = splitRunAtOffsets(doc, leaf.run, leaf.textEl, listOf(so, eo))
        val startPiece = pieces[cuts.indexOf(so)]
        val endPiece = pieces[cuts.indexOf(eo) - 1]
        (startPiece.parentNode as Element).insertBefore(startMarker, startPiece)
        (endPiece.parentNode as Element).insertBefore(endMarker, endPiece.nextSibling)
        (endMarker.parentNode as Element).insertBefore(refRun, endMarker.nextSibling)
        return
    }

    val startAnchor = anchorForOffset(doc, leaves, start, "start")
    startAnchor.parent.insertBefore(startMarker, startAnchor.before)
    val endAnchor = anchorForOffset(doc, leaves, end, "end")
    endAnchor.parent.insertBefore(endMarker, endAnchor.before)
    (endMarker.parentNode as Element).insertBefore(refRun, endMarker.nextSibling)
}

/** §3.3 step 5 (Move, review 3 F2): removes the CURRENT
 *  `w:commentRangeStart`/`End` pair and its paired `w:commentReference` run,
 *  all matched by `id`. Returns `false` when any of the three pieces can't be
 *  found. Mirrors `removeCommentRangeAndReference` (docx-comments.ts). */
private fun removeCommentRangeAndReference(doc: Document, id: String): Boolean {
    val start = findByAttr(doc, "w:commentRangeStart", "w:id", id)
    val end = findByAttr(doc, "w:commentRangeEnd", "w:id", id)
    val ref = findByAttr(doc, "w:commentReference", "w:id", id)
    if (start == null || end == null || ref == null) return false
    (start.parentNode as? Element)?.removeChild(start)
    (end.parentNode as? Element)?.removeChild(end)
    val refRun = nearestAncestor(ref, "w:r") ?: ref
    (refRun.parentNode as? Element)?.removeChild(refRun)
    return true
}

private fun countAttrOccurrences(xml: String, tag: String, attr: String, value: String): Int {
    val escaped = Regex.escape(value)
    val re = Regex("<$tag\\b[^>]*\\b$attr=\"$escaped\"")
    return re.findAll(xml).count()
}

private fun isoNow(): String = java.time.Instant.now().toString()

/** Every entry name this module parses/mutates as a DOM part — every OTHER
 *  entry in the archive is copied through verbatim, untouched. */
private val TRACKED_PART_NAMES = setOf(
    "word/document.xml",
    "word/comments.xml",
    "word/commentsExtended.xml",
    "[Content_Types].xml",
    "word/_rels/document.xml.rels",
    "word/commentsIds.xml",
    "word/commentsExtensible.xml",
)

/**
 * Loads the SIX tracked parts (`TRACKED_PART_NAMES`) off an ALREADY-OPEN
 * `zip` (owned and closed by the caller, `loadMutateSerialize` — kept open
 * across load+mutate+serialize so `serializeArchiveToFile` can stream every
 * OTHER entry directly from it, see that function's own header), mirroring
 * T16's own size-guard-before-decompress discipline. F16 (review 2): unlike
 * the read path's fixed three-named-part check, a WRITE must copy through
 * EVERY other part unchanged too, so the WHOLE archive is size-guarded up
 * front (`checkAllEntriesWithinCeiling`, metadata-only, the same guard
 * T18/§4.3a's xlsx reader uses for its own variable part set) before
 * anything is decompressed — an over-size file routes to `ARCHIVE_TOO_LARGE`,
 * never an OOM. Review F1 (android-xlsx-review): this no longer eagerly
 * decompresses every non-tracked entry into a byte map — only these six.
 */
private fun loadArchiveForWrite(zip: ZipFile): DocxWriteResult<LoadedArchive> {
    return try {
        val totalCheck = checkAllEntriesWithinCeiling(zip)
        if (totalCheck is ZipSizeGuardResult.ArchiveTooLarge) {
            return DocxWriteResult.Err(DocxWriteError.ARCHIVE_TOO_LARGE)
        }

        val documentEntry = zip.getEntry("word/document.xml") ?: return DocxWriteResult.Err(DocxWriteError.MISSING_DOCUMENT_PART)
        val contentTypesEntry = zip.getEntry("[Content_Types].xml") ?: return DocxWriteResult.Err(DocxWriteError.MISSING_DOCUMENT_PART)

        val documentXml = readEntryBounded(zip, documentEntry).toString(Charsets.UTF_8)
        val contentTypesXml = readEntryBounded(zip, contentTypesEntry).toString(Charsets.UTF_8)
        val commentsEntry = zip.getEntry("word/comments.xml")
        val extendedEntry = zip.getEntry("word/commentsExtended.xml")
        val relsEntry = zip.getEntry("word/_rels/document.xml.rels")
        val commentsIdsEntry = zip.getEntry("word/commentsIds.xml")
        val commentsExtensibleEntry = zip.getEntry("word/commentsExtensible.xml")

        val commentsXml = commentsEntry?.let { readEntryBounded(zip, it).toString(Charsets.UTF_8) }
        val extendedXml = extendedEntry?.let { readEntryBounded(zip, it).toString(Charsets.UTF_8) }
        val relsXml = relsEntry?.let { readEntryBounded(zip, it).toString(Charsets.UTF_8) }
        val commentsIdsXml = commentsIdsEntry?.let { readEntryBounded(zip, it).toString(Charsets.UTF_8) }
        val commentsExtensibleXml = commentsExtensibleEntry?.let { readEntryBounded(zip, it).toString(Charsets.UTF_8) }

        val archive = LoadedArchive(
            zip = zip,
            documentDoc = parseXml(documentXml),
            documentXmlOriginal = documentXml,
            commentsDoc = parseXml(commentsXml ?: EMPTY_COMMENTS_XML),
            commentsIsNew = commentsXml == null,
            commentsTouched = commentsXml != null,
            commentsXmlOriginal = commentsXml,
            extendedDoc = parseXml(extendedXml ?: EMPTY_EXTENDED_XML),
            extendedIsNew = extendedXml == null,
            extendedTouched = extendedXml != null,
            extendedXmlOriginal = extendedXml,
            contentTypesDoc = parseXml(contentTypesXml),
            contentTypesXmlOriginal = contentTypesXml,
            relsDoc = parseXml(relsXml ?: EMPTY_RELS_XML),
            relsXmlOriginal = relsXml,
            relsTouched = relsXml != null,
            commentsIdsDoc = commentsIdsXml?.let { parseXml(it) },
            commentsIdsXmlOriginal = commentsIdsXml,
            commentsExtensibleDoc = commentsExtensibleXml?.let { parseXml(it) },
            commentsExtensibleXmlOriginal = commentsExtensibleXml,
        )
        DocxWriteResult.Ok(archive)
    } catch (_: DocxUnsafeXmlDoctypeException) {
        DocxWriteResult.Err(DocxWriteError.UNSAFE_XML)
    } catch (_: ZipBombDetectedException) {
        DocxWriteResult.Err(DocxWriteError.ARCHIVE_TOO_LARGE)
    }
}

private val XML_DECL_RE = Regex("^<\\?xml[^>]*\\?>")

private fun serializeDocument(doc: Document): String {
    val transformer = TransformerFactory.newInstance().newTransformer()
    transformer.setOutputProperty(OutputKeys.OMIT_XML_DECLARATION, "yes")
    transformer.setOutputProperty(OutputKeys.METHOD, "xml")
    transformer.setOutputProperty(OutputKeys.ENCODING, "UTF-8")
    val writer = java.io.StringWriter()
    transformer.transform(DOMSource(doc), StreamResult(writer))
    return writer.toString()
}

/**
 * Mirrors desktop's `serializePart` (docx-comments.ts, F2): a CHANGED part is
 * re-serialized fresh, with its XML declaration forced back to the ORIGINAL
 * part's own declaration (verbatim) when one exists, or a sensible default
 * when this operation created the part from nothing. Unlike desktop's
 * linkedom-based serializer, `javax.xml.transform`'s own serializer does not
 * add a space before a self-closing tag's `/>` — confirmed empirically while
 * building this module — so no post-processing-away of that specific
 * linkedom quirk is needed here (F2's OTHER half, "an untouched part is
 * written back byte-for-byte verbatim", is handled by `writePart` below,
 * never routing an unchanged part through this function at all).
 */
private fun serializePart(doc: Document, originalXml: String?): String {
    val body = serializeDocument(doc)
    val decl = originalXml?.let { XML_DECL_RE.find(it)?.value }
        ?: """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"""
    return decl + body
}

private fun ZipOutputStream.writeEntry(name: String, bytes: ByteArray) {
    putNextEntry(ZipEntry(name))
    write(bytes)
    closeEntry()
}

// Same ceiling `DocCommentsZipSizeGuard.kt`'s own `readEntryBounded` uses,
// duplicated here (not exported from that file — `XlsxComments.kt` keeps its
// own identical copy for the same reason, "two write modules are
// deliberately independent") so a STREAMED copy of an untouched, still-
// compressed entry gets the identical real-byte-counted zip-bomb backstop a
// fully-buffered `readEntryBounded` call already gives every part this
// module actually parses.
private const val MAX_STREAMED_ENTRY_BYTES = 200L * 1024 * 1024
private const val STREAM_COPY_BUFFER_BYTES = 8192

/** Review F1 (High, android-xlsx-review) fix, ported from `XlsxComments.kt`'s
 *  own identical helper: streams ONE untouched zip entry straight from
 *  `sourceZip` to `zos`, in bounded chunks, NEVER buffering its whole
 *  decompressed content in one array. A `STORED` entry (already
 *  uncompressed — no expansion possible) is passed through as RAW bytes with
 *  its OWN size/crc preserved exactly. Anything else (`DEFLATED`) is
 *  decompressed and re-compressed at the output stream's own default level,
 *  STREAMED through one small fixed buffer, with the same real-byte-counted
 *  zip-bomb backstop `readEntryBounded` gives every part this module
 *  actually parses. See that file's own copy for the full "no public
 *  java.util.zip API for a raw DEFLATE passthrough" citation. */
private fun streamCopyUntouchedEntry(sourceZip: ZipFile, entry: ZipEntry, zos: ZipOutputStream) {
    val isStored = entry.method == ZipEntry.STORED
    val outEntry = ZipEntry(entry.name)
    if (isStored) {
        outEntry.method = ZipEntry.STORED
        outEntry.size = entry.size
        outEntry.compressedSize = entry.size
        outEntry.crc = entry.crc
    }
    zos.putNextEntry(outEntry)
    sourceZip.getInputStream(entry).use { input ->
        val buffer = ByteArray(STREAM_COPY_BUFFER_BYTES)
        var total = 0L
        while (true) {
            val n = input.read(buffer)
            if (n == -1) break
            total += n
            if (!isStored && total > MAX_STREAMED_ENTRY_BYTES) throw ZipBombDetectedException()
            zos.write(buffer, 0, n)
        }
    }
    zos.closeEntry()
}

/** Writes the mutated archive to `outFile` (a scratch path — never the live
 *  target, see `writeDocxMutation`). Every tracked part is written back
 *  byte-for-byte verbatim when this operation left it unchanged (`writePart`'s
 *  `!changed` branch), or freshly serialized when it didn't. Every OTHER
 *  entry — genuinely untouched by this write — is streamed straight through
 *  from `archive.zip` via `streamCopyUntouchedEntry`, never decompressed into
 *  a `ByteArray` here (review F1: this REPLACES the old unconditional
 *  `for ((name, bytes) in archive.entries)` loop, which iterated a map that
 *  had ALREADY fully decompressed every one of those entries at load time).
 *  Mirrors `serializeArchive` (docx-comments.ts). */
private fun serializeArchiveToFile(archive: LoadedArchive, outFile: File) {
    ZipOutputStream(java.io.BufferedOutputStream(java.io.FileOutputStream(outFile))).use { zos ->
        fun writePart(name: String, changed: Boolean, doc: Document, originalXml: String?) {
            val bytes = if (!changed && originalXml != null) {
                originalXml.toByteArray(Charsets.UTF_8)
            } else {
                serializePart(doc, originalXml).toByteArray(Charsets.UTF_8)
            }
            zos.writeEntry(name, bytes)
        }
        writePart("word/document.xml", archive.documentChanged, archive.documentDoc, archive.documentXmlOriginal)
        if (archive.commentsTouched) {
            writePart("word/comments.xml", archive.commentsChanged, archive.commentsDoc, archive.commentsXmlOriginal)
        }
        if (archive.extendedTouched) {
            writePart("word/commentsExtended.xml", archive.extendedChanged, archive.extendedDoc, archive.extendedXmlOriginal)
        }
        writePart("[Content_Types].xml", archive.contentTypesChanged, archive.contentTypesDoc, archive.contentTypesXmlOriginal)
        if (archive.relsTouched) {
            writePart("word/_rels/document.xml.rels", archive.relsChanged, archive.relsDoc, archive.relsXmlOriginal)
        }
        archive.commentsIdsDoc?.let {
            writePart("word/commentsIds.xml", archive.commentsIdsChanged, it, archive.commentsIdsXmlOriginal)
        }
        archive.commentsExtensibleDoc?.let {
            writePart("word/commentsExtensible.xml", archive.commentsExtensibleChanged, it, archive.commentsExtensibleXmlOriginal)
        }
        for (entry in java.util.Collections.list(archive.zip.entries())) {
            if (entry.isDirectory) continue
            if (TRACKED_PART_NAMES.contains(entry.name)) continue
            streamCopyUntouchedEntry(archive.zip, entry, zos)
        }
    }
}

// -----------------------------------------------------------------------
// Pure, in-memory mutations against an already-loaded archive.
// -----------------------------------------------------------------------

private fun mutateAddComment(archive: LoadedArchive, selector: CommentSelector, rawText: String, author: CommentAuthor): DocxWriteResult<String> {
    if (selector !is CommentSelector.Text) return DocxWriteResult.Err(DocxWriteError.INVALID_SELECTOR)
    // WHY strip rather than refuse — see `stripIllegalXmlChars`'s own doc
    // comment. Still done BEFORE ever constructing a text node (the
    // Transformer would otherwise throw uncaught when this archive is
    // serialized), just no longer a refusal.
    val text = stripIllegalXmlChars(rawText)
    val walked = walkDocument(archive.documentDoc, collectLeaves = true)
    val resolved = resolveSelector(walked.fullText, selector.selector) ?: return DocxWriteResult.Err(DocxWriteError.SELECTOR_NOT_FOUND)

    val newId = maxExistingCommentId(archive.commentsDoc) + 1
    val paraId = generateParaId(collectAllParaIds(archive))

    if (archive.commentsIsNew) ensureCommentsPart(archive)
    insertCommentRangeMarkers(archive.documentDoc, walked.leaves!!, resolved.start, resolved.end, newId.toString())
    archive.documentChanged = true
    appendCommentEntry(archive.commentsDoc, newId, commentAuthorToDisplayName(author), isoNow(), paraId, text)
    archive.commentsChanged = true
    recordCommentExtensionParts(archive, paraId)

    return DocxWriteResult.Ok("w-$newId")
}

/**
 * Ordinal position (1-based) a NEW reply to `targetParaId` would get once
 * written — mirrors `readDocxComments`'s own `w-${root.id}-r${list.size+1}`
 * numbering (this file's read path, above) exactly, computed from the
 * archive's CURRENT state (before this write's own `appendCommentEntry`/
 * `upsertExtendedEntry` calls add the new entry). T5 review parity (design
 * §1.6, F2): the SAME id `replyToDocxComment`'s desktop counterpart
 * (docx-comments.ts) mints for its own enriched response.
 */
private fun nextReplyOrdinal(archive: LoadedArchive, targetParaId: String): Int {
    val extended = HashMap<String, ExtendedInfo>()
    for (el in elementsByTag(archive.extendedDoc, "w15:commentEx")) {
        val paraId = el.getAttribute("w15:paraId")
        if (paraId.isNotEmpty()) {
            extended[paraId] = ExtendedInfo(el.getAttribute("w15:done") == "1", el.getAttribute("w15:paraIdParent").ifEmpty { null })
        }
    }
    var count = 0
    for (el in elementsByTag(archive.commentsDoc, "w:comment")) {
        val paraId = elementsByTag(el, "w:p").firstOrNull()?.getAttribute("w14:paraId")
        if (paraId.isNullOrEmpty() || paraId == targetParaId) continue
        if (resolveRootParaId(paraId, extended) == targetParaId) count++
    }
    return count + 1
}

/** T5 review parity (design §1.6, F2): returns the real persisted
 *  `CommentReply` alongside the mutated archive, mirroring desktop's own
 *  `mutateReplyToComment` (docx-comments.ts) — so `replyToDocxComment` below
 *  can enrich its response the SAME way, keeping desktop/Android response
 *  shapes in parity. */
private fun mutateReplyToComment(archive: LoadedArchive, id: String, rawText: String, author: CommentAuthor): DocxWriteResult<CommentReply> {
    // WHY strip rather than refuse: same as Add — see its own comment there.
    val text = stripIllegalXmlChars(rawText)
    val rawId = stripWPrefix(id) ?: return DocxWriteResult.Err(DocxWriteError.COMMENT_NOT_FOUND)
    val targetParaId = findCommentParaId(archive.commentsDoc, rawId) ?: return DocxWriteResult.Err(DocxWriteError.COMMENT_NOT_FOUND)

    // Computed BEFORE this reply's own entry is appended below — the id
    // depends on the file's CURRENT state at write time, not something the
    // caller could have pre-minted.
    val ordinal = nextReplyOrdinal(archive, targetParaId)
    val createdAtIso = isoNow()

    val newId = maxExistingCommentId(archive.commentsDoc) + 1
    val paraId = generateParaId(collectAllParaIds(archive))
    appendCommentEntry(archive.commentsDoc, newId, commentAuthorToDisplayName(author), createdAtIso, paraId, text)
    archive.commentsChanged = true

    if (archive.extendedIsNew) ensureExtendedPart(archive)
    upsertExtendedEntry(archive.extendedDoc, paraId, false, targetParaId)
    archive.extendedChanged = true
    recordCommentExtensionParts(archive, paraId) // a reply is its own new comment

    return DocxWriteResult.Ok(CommentReply(id = "w-$rawId-r$ordinal", author = author, text = text, createdAt = parseDate(createdAtIso)))
}

private fun mutateSetResolved(archive: LoadedArchive, id: String, done: Boolean): DocxWriteResult<Unit> {
    val rawId = stripWPrefix(id) ?: return DocxWriteResult.Err(DocxWriteError.COMMENT_NOT_FOUND)
    val targetParaId = findCommentParaId(archive.commentsDoc, rawId) ?: return DocxWriteResult.Err(DocxWriteError.COMMENT_NOT_FOUND)

    if (archive.extendedIsNew) ensureExtendedPart(archive)
    upsertExtendedEntry(archive.extendedDoc, targetParaId, done, null)
    archive.extendedChanged = true

    return DocxWriteResult.Ok(Unit)
}

private fun mutateMoveComment(archive: LoadedArchive, id: String, newSelector: CommentSelector): DocxWriteResult<Unit> {
    if (newSelector !is CommentSelector.Text) return DocxWriteResult.Err(DocxWriteError.INVALID_SELECTOR)
    val rawId = stripWPrefix(id) ?: return DocxWriteResult.Err(DocxWriteError.COMMENT_NOT_FOUND)
    if (findCommentParaId(archive.commentsDoc, rawId) == null) return DocxWriteResult.Err(DocxWriteError.COMMENT_NOT_FOUND)
    if (!removeCommentRangeAndReference(archive.documentDoc, rawId)) return DocxWriteResult.Err(DocxWriteError.COMMENT_NOT_FOUND)
    archive.documentChanged = true

    // Re-resolve against the CURRENT text (the old range is already gone from
    // this in-memory copy, but nothing has been written to the real target
    // yet — a SELECTOR_NOT_FOUND return below discards this whole in-memory
    // archive, leaving the on-disk original untouched).
    val walked = walkDocument(archive.documentDoc, collectLeaves = true)
    val resolved = resolveSelector(walked.fullText, newSelector.selector) ?: return DocxWriteResult.Err(DocxWriteError.SELECTOR_NOT_FOUND)

    insertCommentRangeMarkers(archive.documentDoc, walked.leaves!!, resolved.start, resolved.end, rawId)

    return DocxWriteResult.Ok(Unit)
}

// -----------------------------------------------------------------------
// F17: a minimal OOXML relationship/content-types sanity check — every r:id
// referenced anywhere in document.xml resolves in word/_rels/document.xml.rels,
// and every comments/commentsExtended part actually present has a matching
// [Content_Types].xml Override. F1 (T11 review): scoped to a before/after
// DIFF of dangling ids — a reference that was ALREADY dangling before this
// write touched the file is left unblamed. Mirrors `collectDanglingRIds`/
// `verifyOoxmlWiring` (docx-comments.ts).
// -----------------------------------------------------------------------

private val RID_REF_RE = Regex("r:id=\"([^\"]*)\"")

private fun collectDanglingRIds(file: File): Set<String> {
    val zip = try { ZipFile(file) } catch (_: Exception) { return emptySet() }
    return try {
        zip.use { z ->
            val documentEntry = z.getEntry("word/document.xml") ?: return emptySet()
            val relsEntry = z.getEntry("word/_rels/document.xml.rels")
            val documentXml = readEntryBounded(z, documentEntry).toString(Charsets.UTF_8)
            val relsXml = relsEntry?.let { readEntryBounded(z, it).toString(Charsets.UTF_8) }
            val relIds = mutableSetOf<String>()
            if (relsXml != null) {
                for (el in elementsByTag(parseXml(relsXml), "Relationship")) {
                    val id = el.getAttribute("Id")
                    if (id.isNotEmpty()) relIds.add(id)
                }
            }
            val dangling = mutableSetOf<String>()
            for (m in RID_REF_RE.findAll(documentXml)) {
                val id = m.groupValues[1]
                if (!relIds.contains(id)) dangling.add(id)
            }
            dangling
        }
    } catch (_: Exception) {
        emptySet()
    }
}

private fun verifyOoxmlWiring(outFile: File, originalDangling: Set<String>): Boolean {
    val zip = try { ZipFile(outFile) } catch (_: Exception) { return false }
    return try {
        zip.use { z ->
            val documentEntry = z.getEntry("word/document.xml") ?: return false
            val contentTypesEntry = z.getEntry("[Content_Types].xml") ?: return false
            val relsEntry = z.getEntry("word/_rels/document.xml.rels")
            val documentXml = readEntryBounded(z, documentEntry).toString(Charsets.UTF_8)
            val contentTypesXml = readEntryBounded(z, contentTypesEntry).toString(Charsets.UTF_8)
            val relsXml = relsEntry?.let { readEntryBounded(z, it).toString(Charsets.UTF_8) }

            val relIds = mutableSetOf<String>()
            if (relsXml != null) {
                for (el in elementsByTag(parseXml(relsXml), "Relationship")) {
                    val id = el.getAttribute("Id")
                    if (id.isNotEmpty()) relIds.add(id)
                }
            }
            for (m in RID_REF_RE.findAll(documentXml)) {
                val id = m.groupValues[1]
                if (!relIds.contains(id) && !originalDangling.contains(id)) return false
            }

            val contentTypesDoc = parseXml(contentTypesXml)
            val overrides = elementsByTag(contentTypesDoc, "Override").map { it.getAttribute("PartName") }.toSet()
            if (z.getEntry("word/comments.xml") != null && !overrides.contains("/word/comments.xml")) return false
            if (z.getEntry("word/commentsExtended.xml") != null && !overrides.contains("/word/commentsExtended.xml")) return false
            true
        }
    } catch (_: Exception) {
        false
    }
}

// -----------------------------------------------------------------------
// The write pipeline: backup, atomic replace, verify-before-replace.
// See this section's own top-of-file header for why verify runs against a
// scratch file BEFORE the real target is ever touched, and why only an
// in-process Mutex (not CasWrite.kt's cross-process mkdir lock) guards it.
// -----------------------------------------------------------------------

private val docxWriteLocks = ConcurrentHashMap<String, Mutex>()
private fun docxLockFor(absolutePath: String): Mutex = docxWriteLocks.computeIfAbsent(absolutePath) { Mutex() }

/** Exported so a test can locate a specific write's backup file directly. */
const val DOCX_BACKUP_SUFFIX = ".docx.bak"

/** F1 (T17 implementation review, major/durability): the REAL fsync
 *  `writeDocxMutation` defaults to — `FileChannel.force(true)` against an
 *  already-closed-for-writing file, the SAME idiom `artifacts/CasWrite.kt`'s
 *  own `casWrite`/`mutateFileUnderLock` already use for exactly this reason
 *  (see that file's own header comment). A plain rename only reorders a
 *  directory entry; without this, the bytes the new name points at may still
 *  be sitting in a page-cache buffer the kernel hasn't flushed yet, so a
 *  crash right after the rename can leave the real target file truncated. */
private fun defaultFsyncFile(file: File) {
    FileChannel.open(file.toPath(), StandardOpenOption.READ, StandardOpenOption.WRITE).use { it.force(true) }
}

/** F1: best-effort fsync of a DIRECTORY, run AFTER the atomic replace —
 *  durability of the rename's own directory-entry update, not the file's
 *  bytes (those are already covered by `defaultFsyncFile` above, which runs
 *  BEFORE the rename). "Where supported" per the finding: opening a
 *  directory as a read-only `FileChannel` and forcing it is a POSIX-only
 *  operation. Android's filesystem is always POSIX (ext4/f2fs), so this
 *  normally succeeds, but it is wrapped in its own try/catch regardless —
 *  this is defense in depth on top of an already-successful write, never a
 *  gate a real failure here should be allowed to fail the whole operation
 *  over. */
private fun bestEffortFsyncDir(dir: File) {
    try {
        FileChannel.open(dir.toPath(), StandardOpenOption.READ).use { it.force(true) }
    } catch (_: Exception) {
        // Not fatal — see this function's own doc comment. The file-level
        // fsync in `defaultFsyncFile` already guarantees the CONTENT survives
        // a crash; this is one further layer for the rename itself.
    }
}

/** One rolling backup per file — never one per write. The filename is a hash
 *  of the SOURCE file's own absolute path, never a timestamp, so the next
 *  write to the same file overwrites the previous backup rather than
 *  accumulating one forever. Same directory NAME desktop's write-pipeline.ts
 *  uses under `~/.claude` (`youcoded-doc-backups`), rooted at THIS device's
 *  own `homeDir` — "the app's own storage" the task brief asks this be
 *  documented as. */
fun docxBackupPathFor(homeDir: File, absolutePath: String): File {
    val hash = sha256Hex(absolutePath)
    val dir = File(File(homeDir, ".claude"), "youcoded-doc-backups")
    return File(dir, "$hash$DOCX_BACKUP_SUFFIX")
}

/**
 * T17 follow-up (design §3.3's new step 0, design review round 3 F4 — the
 * SAME check desktop's write-pipeline.ts now does, mirrored here): refuses a
 * write when a real Word/Excel `~$<name>` owner file or a LibreOffice
 * `.~lock.<name>#` lock file sits beside the target. `false` does NOT prove
 * the file is currently held open — only that one of the two conventions'
 * sibling file exists (a stale lock after a crash, or a program that holds
 * the file open without either convention, are both accepted, named
 * limitations, same as desktop's — §3.3's own residual-limitation text).
 */
internal fun isFileOpenElsewhere(target: File): Boolean {
    val dir = target.parentFile ?: return false
    val name = target.name
    val ownerFile = File(dir, "~\$$name")
    val lockFile = File(dir, ".~lock.$name#")
    return ownerFile.exists() || lockFile.exists()
}

/**
 * The generic half of the pipeline: lock, scratch-copy, hand `workCopy`/
 * `outFile` to `mutate` (format-specific logic lives entirely in the
 * caller's closure — this function never parses OOXML itself), verify,
 * backup, atomic replace. `mutate`/`verify` operate on FILES (never a
 * pre-parsed archive) so this shares the exact same bytes-in/file-out shape
 * as desktop's `writeFileMutation` (write-pipeline.ts) and, not coincidentally,
 * so a test can inject a fault the same simple way desktop's own T11 pinning
 * test does (read `workCopy`, write deliberately-corrupted bytes to `outFile`,
 * return `true` from `mutate`, `false` from `verify`) without needing to
 * fabricate a `LoadedArchive` by hand. `internal` (not `private`): the T17
 * pinning test for "failed verification leaves the target byte-identical"
 * calls this directly, the same way docx-comments.test.ts calls the exported
 * `writeDocxMutation` on the TS side.
 */
internal suspend fun <T> writeDocxMutation(
    absolutePath: String,
    homeDir: File,
    mutate: (workCopy: File, outFile: File) -> DocxWriteResult<T>,
    verify: (outFile: File, value: T, originalFile: File) -> Boolean,
    // F1 (T17 implementation review, major/durability): a seam, not a
    // hardcoded call — defaults to the REAL fsync (`defaultFsyncFile` below,
    // same `FileChannel.force(true)` idiom as artifacts/CasWrite.kt's own
    // atomic write). A test proves "the sync call happens before the rename"
    // by injecting a FAILING fsync here and checking the target/backup were
    // never touched — a JVM unit test has no other way to observe fsync
    // ordering, since fsync's only real effect is durability across a crash
    // this process never experiences.
    syncFile: (File) -> Unit = ::defaultFsyncFile,
): DocxWriteResult<T> {
    return docxLockFor(absolutePath).withLock {
        val target = File(absolutePath)
        // Step 0 (design §3.3, review round 3 F4) — the VERY FIRST thing this
        // pipeline does, before backup (step 1) or even the read below.
        if (isFileOpenElsewhere(target)) return@withLock DocxWriteResult.Err(DocxWriteError.FILE_OPEN_ELSEWHERE)
        if (!target.exists()) return@withLock DocxWriteResult.Err(DocxWriteError.READ_FAILED)
        val parentDir = target.parentFile ?: return@withLock DocxWriteResult.Err(DocxWriteError.READ_FAILED)
        // Sibling scratch paths (never the system temp dir) — maximizes the
        // chance `Files.move` below is a true same-filesystem ATOMIC_MOVE,
        // mirroring desktop's own `${absolutePath}.${pid}.${now}.tmp` sibling
        // convention (write-pipeline.ts) and CasWrite.kt's `<target>.tmp`.
        // A fixed name (no pid/timestamp) is safe here because the
        // per-absolute-path Mutex above already excludes every other
        // in-process writer of THIS same file.
        val workCopy = File(parentDir, "${target.name}.ycdread.tmp")
        val outFile = File(parentDir, "${target.name}.ycdwrite.tmp")
        try {
            try {
                target.copyTo(workCopy, overwrite = true)
            } catch (_: Exception) {
                return@withLock DocxWriteResult.Err(DocxWriteError.READ_FAILED)
            }

            val mutated = mutate(workCopy, outFile)
            if (mutated is DocxWriteResult.Err) return@withLock mutated
            val value = (mutated as DocxWriteResult.Ok).value

            // Verify-by-reread BEFORE the real target is ever touched — see
            // this section's own header for why a failure here needs no
            // separate "restore the backup" step: `target` was never written.
            val verified = try { verify(outFile, value, target) } catch (_: Exception) { false }
            if (!verified) return@withLock DocxWriteResult.Err(DocxWriteError.VERIFY_FAILED)

            // F1 (T17 implementation review, major/durability): fsync the
            // ALREADY-VERIFIED output's bytes BEFORE it ever replaces the
            // real target, or even before the backup is taken. A bare
            // `Files.move` only reorders a directory entry — it says nothing
            // about whether the bytes the new name will point at are durable
            // yet, so a crash between the rename returning and the OS's own
            // lazy flush could leave the REAL document truncated (the
            // failure mode this finding names). Ordered before the backup
            // copy too, on purpose: a fsync fault must leave the target
            // exactly as untouched as a verify fault does, never a state
            // where a backup was written but the sync it depended on never
            // happened.
            try {
                syncFile(outFile)
            } catch (_: Exception) {
                return@withLock DocxWriteResult.Err(DocxWriteError.WRITE_FAILED)
            }

            // Step 1 (backup, §3.3): capture the pre-mutation bytes at a
            // stable, rolling, per-file path OUTSIDE any project, kept as a
            // standing safety net after success (never deleted).
            val backupFile = docxBackupPathFor(homeDir, absolutePath)
            try {
                backupFile.parentFile?.mkdirs()
                target.copyTo(backupFile, overwrite = true)
            } catch (_: Exception) {
                return@withLock DocxWriteResult.Err(DocxWriteError.BACKUP_FAILED)
            }

            // Atomic replace: the ALREADY-VERIFIED, ALREADY-FSYNCED output
            // takes the target's place — never a direct overwrite. Mirrors
            // CasWrite.kt's own ATOMIC_MOVE-with-REPLACE_EXISTING-fallback
            // shape.
            try {
                try {
                    Files.move(
                        outFile.toPath(),
                        target.toPath(),
                        StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING,
                    )
                } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
                    Files.move(outFile.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
                }
            } catch (_: Exception) {
                return@withLock DocxWriteResult.Err(DocxWriteError.WRITE_FAILED)
            }
            // F1: best-effort fsync of the PARENT DIRECTORY too, so the
            // rename's own directory-entry update is itself durable, not
            // just the file's bytes — "where supported" per the finding:
            // opening a directory as a FileChannel is a POSIX operation
            // (always available on Android's ext4/f2fs), wrapped in its own
            // try/catch so a filesystem/JVM that refuses it never fails a
            // write that has already fully succeeded.
            bestEffortFsyncDir(parentDir)
            DocxWriteResult.Ok(value)
        } finally {
            workCopy.delete()
            outFile.delete() // no-op once already moved onto `target`
        }
    }
}

/** Glues the generic file-in/file-out pipeline above to the archive-based
 *  mutations below: opens `workCopy` as a `ZipFile` ONCE and keeps it open
 *  across load, mutate, AND serialize (`finally { zip.close() }`) — the
 *  structural change review F1 needed, since `serializeArchiveToFile` must be
 *  able to stream-copy an untouched entry straight from the SAME open source
 *  archive `loadArchiveForWrite` read the six tracked parts from. Every real
 *  operation's own `mutate` closure is just this plus its own archive
 *  mutation function. A `ZipBombDetectedException` thrown during serialize
 *  (the streamed backstop firing on an untouched entry) is mapped directly to
 *  `ARCHIVE_TOO_LARGE` here rather than falling into the generic
 *  `WRITE_FAILED` catch below it — the same "never swallow a typed signal
 *  into a wrong wire code" discipline `XlsxComments.kt`'s own equivalent fix
 *  uses (there via re-throw past an extra layer this file doesn't have). */
private fun <T> loadMutateSerialize(workCopy: File, outFile: File, mutateArchive: (LoadedArchive) -> DocxWriteResult<T>): DocxWriteResult<T> {
    val zip = try {
        ZipFile(workCopy)
    } catch (_: Exception) {
        return DocxWriteResult.Err(DocxWriteError.INVALID_DOCX)
    }
    return try {
        val loaded = loadArchiveForWrite(zip)
        if (loaded is DocxWriteResult.Err) return loaded
        val archive = (loaded as DocxWriteResult.Ok).value
        val mutated = mutateArchive(archive)
        if (mutated is DocxWriteResult.Err) return mutated
        val value = (mutated as DocxWriteResult.Ok).value
        try {
            serializeArchiveToFile(archive, outFile)
            DocxWriteResult.Ok(value)
        } catch (_: ZipBombDetectedException) {
            DocxWriteResult.Err(DocxWriteError.ARCHIVE_TOO_LARGE)
        } catch (_: Exception) {
            DocxWriteResult.Err(DocxWriteError.WRITE_FAILED)
        }
    } finally {
        zip.close()
    }
}

// -----------------------------------------------------------------------
// Public orchestration — one per operation, each wiring its own mutate +
// verify into `writeDocxMutation`. `absolutePath` is the already-
// containment-verified real file path (DocCommentsDispatch.kt resolves it,
// the same way it already does for `listNativeComments`); `path` is the
// caller's project-relative (or fallback-absolute) path, stamped onto
// `PersistedComment.path` — needed here only to re-run this file's own
// reader during verification.
// -----------------------------------------------------------------------

suspend fun addDocxComment(
    absolutePath: String,
    path: String,
    selector: CommentSelector,
    text: String,
    author: CommentAuthor,
    homeDir: File,
): DocxWriteResult<String> = writeDocxMutation(
    absolutePath,
    homeDir,
    mutate = { workCopy, outFile -> loadMutateSerialize(workCopy, outFile) { archive -> mutateAddComment(archive, selector, text, author) } },
    verify = { outFile, newId, originalFile ->
        verifyOoxmlWiring(outFile, collectDanglingRIds(originalFile)) &&
            run {
                val r = readDocxComments(outFile, path)
                // WHY `stripIllegalXmlChars(text)`, not the raw `text`
                // argument: `mutateAddComment` strips before writing, so
                // comparing against the raw value would fail this check (and
                // roll back a perfectly good write) for any text that
                // legitimately had something stripped from it.
                r is DocxReadResult.Ok && r.comments.any { it.id == newId && it.text == stripIllegalXmlChars(text) }
            }
    },
)

/** T5 review parity (design §1.6, F2): returns the real persisted
 *  `CommentReply` — the SAME enrichment desktop's own `replyToDocxComment`
 *  (docx-comments.ts) now returns, keeping desktop/remote/Android response
 *  shapes in parity. */
suspend fun replyToDocxComment(
    absolutePath: String,
    path: String,
    id: String,
    text: String,
    author: CommentAuthor,
    homeDir: File,
): DocxWriteResult<CommentReply> = writeDocxMutation(
    absolutePath,
    homeDir,
    mutate = { workCopy, outFile -> loadMutateSerialize(workCopy, outFile) { archive -> mutateReplyToComment(archive, id, text, author) } },
    verify = { outFile, reply, originalFile ->
        verifyOoxmlWiring(outFile, collectDanglingRIds(originalFile)) &&
            run {
                val r = readDocxComments(outFile, path)
                // WHY `stripIllegalXmlChars(text)` — see `addDocxComment`'s
                // own comment on the same swap.
                (r as? DocxReadResult.Ok)?.comments?.find { it.id == id }?.replies?.any { it.id == reply.id && it.text == stripIllegalXmlChars(text) } == true
            }
    },
)

/** `by` is accepted for call-site symmetry with the generic `{path, id, by}`
 *  payload but deliberately UNUSED — a native Word comment has nowhere to
 *  record it (§3.2: history starts empty for a freshly-read native comment;
 *  only the CURRENT `w15:done` bit exists in the file). Mirrors
 *  `resolveDocxComment` (docx-comments.ts). */
suspend fun resolveDocxComment(absolutePath: String, path: String, id: String, homeDir: File): DocxWriteResult<Unit> = writeDocxMutation(
    absolutePath,
    homeDir,
    mutate = { workCopy, outFile -> loadMutateSerialize(workCopy, outFile) { archive -> mutateSetResolved(archive, id, true) } },
    verify = { outFile, _, originalFile ->
        verifyOoxmlWiring(outFile, collectDanglingRIds(originalFile)) &&
            run {
                val r = readDocxComments(outFile, path)
                (r as? DocxReadResult.Ok)?.comments?.find { it.id == id }?.resolved == true
            }
    },
)

suspend fun reopenDocxComment(absolutePath: String, path: String, id: String, homeDir: File): DocxWriteResult<Unit> = writeDocxMutation(
    absolutePath,
    homeDir,
    mutate = { workCopy, outFile -> loadMutateSerialize(workCopy, outFile) { archive -> mutateSetResolved(archive, id, false) } },
    verify = { outFile, _, originalFile ->
        verifyOoxmlWiring(outFile, collectDanglingRIds(originalFile)) &&
            run {
                val r = readDocxComments(outFile, path)
                (r as? DocxReadResult.Ok)?.comments?.find { it.id == id }?.resolved == false
            }
    },
)

suspend fun moveDocxComment(
    absolutePath: String,
    path: String,
    id: String,
    newSelector: CommentSelector,
    homeDir: File,
): DocxWriteResult<Unit> {
    if (newSelector !is CommentSelector.Text) return DocxWriteResult.Err(DocxWriteError.INVALID_SELECTOR)
    val rawId = stripWPrefix(id) ?: return DocxWriteResult.Err(DocxWriteError.COMMENT_NOT_FOUND)
    return writeDocxMutation(
        absolutePath,
        homeDir,
        mutate = { workCopy, outFile -> loadMutateSerialize(workCopy, outFile) { archive -> mutateMoveComment(archive, id, newSelector) } },
        verify = { outFile, _, originalFile ->
            val wiringOk = verifyOoxmlWiring(outFile, collectDanglingRIds(originalFile))
            // "The OLD range is gone, a NEW one exists" (review 3, F2) — a
            // low-level marker COUNT, since PersistedComment (one record per
            // comments.xml id) can't itself distinguish "exactly one range"
            // from "two ranges silently collapsed by a map".
            val marksOk = wiringOk && run {
                val zip = try { ZipFile(outFile) } catch (_: Exception) { null }
                if (zip == null) {
                    false
                } else {
                    zip.use { z ->
                        val documentEntry = z.getEntry("word/document.xml")
                        if (documentEntry == null) {
                            false
                        } else {
                            val documentXml = readEntryBounded(z, documentEntry).toString(Charsets.UTF_8)
                            countAttrOccurrences(documentXml, "w:commentRangeStart", "w:id", rawId) == 1 &&
                                countAttrOccurrences(documentXml, "w:commentRangeEnd", "w:id", rawId) == 1 &&
                                countAttrOccurrences(documentXml, "w:commentReference", "w:id", rawId) == 1
                        }
                    }
                }
            }
            marksOk && run {
                val r = readDocxComments(outFile, path)
                val target = (r as? DocxReadResult.Ok)?.comments?.find { it.id == id }
                val sel = target?.selector
                sel is CommentSelector.Text && sel.selector.exact == newSelector.selector.exact
            }
        },
    )
}
