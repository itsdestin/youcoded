// Excel (.xlsx) comment reading + writing on Android — T18 (read) and T19
// (write) of the doc-comments build (docs/active/specs/2026-09-26-doc-
// comments-build-design.md §4.3a, §8 T18/T19). REWRITTEN 2026-09-27 for
// Destin's threaded-comments-only decision (chat, 2026-09-27: "Excel
// comments use ONLY modern threaded comments... never old-style notes as the
// product format") — this REPLACES the entire prior legacy-Notes reader this
// file used to hold (the `stripResolvedMarker`/`splitTurns`/
// `APP_AUTHOR_PREFIX_RE` transcript-convention heuristics), the same way
// desktop's own `xlsx-comments.ts` was rewritten in the same session
// (commit afebe3df5 onward). Old-style Notes already in a file are never
// read, created, or edited by this module — a genuine Note round-trips
// byte-for-byte untouched (writes never re-serialize a part they didn't
// touch) and is never surfaced in the comments pane (§4.1).
//
// This is a Kotlin PORT of desktop's `desktop/src/main/doc-comments/
// xlsx-comments.ts` (T12/T13), field-for-field and error-code-for-error-code
// — see that file's own comments for the full [MS-XLSX]/real-file research
// citation (§4.2) this algorithm is built from. Two real, redistributable
// reference files this redesign's own research captured —
// `shared-fixtures/doc-comments/xlsx-threaded-reference/{docling-xlsx-
// comments,elden-ring-completionist-checklist}.xlsx` — are what T18's own
// read tests check against, copied into `app/src/test/resources/doc-
// comments/` for this module's JVM unit tests.
//
// WHY Kotlin has no `exceljs`-equivalent to lean on, and why this hand-rolls
// the same JSZip-equivalent (`java.util.zip`) + DOM (`javax.xml.parsers`)
// approach desktop's own rewrite uses: `exceljs`'s `cell.note` getter cannot
// distinguish a genuine Note from a threaded comment's own legacy-
// compatibility placeholder (§4.1) — an independently-confirmed defect in
// the retired reader this file used to hold. Neither platform's library
// ecosystem has a threaded-comments API of any kind, so both hand-roll the
// OOXML from the same researched shape.
//
// KOTLIN-SPECIFIC DEVIATIONS FROM THE TS SOURCE, EACH NAMED (mirrors
// DocxComments.kt's own precedent for naming where a "field-for-field port"
// isn't literal):
//  - `Element.getAttribute()` returns `""` for an absent attribute where the
//    TS/DOM `getAttribute()` returns `null` — every attribute read here that
//    the TS source checks with `!== null` is instead checked with
//    `.isEmpty()` (or `.isNotEmpty()`), exactly the same adaptation
//    `DocxComments.kt`'s own header already documents.
//  - `javax.xml.parsers` (namespace-UNAWARE, matching `DocxComments.kt`'s own
//    configuration) decodes entities correctly on both `getAttribute()` and
//    `.textContent` — unlike `linkedom`'s own `getAttribute()`, which desktop's
//    `decodeXmlEntities` exists to work around (§4.2's own finding). No
//    equivalent helper is needed here.
//  - Whole-archive size guard: Kotlin's `DocCommentsZipSizeGuard.kt` already
//    documents (`checkAllEntriesWithinCeiling`'s own header) that THIS module
//    uses a whole-archive pre-scan rather than desktop's narrower named-parts
//    check, because an xlsx's part set/count varies per workbook — this
//    predates this rewrite and is unchanged by it.
//  - Illegal XML 1.0 control characters (comment/reply text): this build
//    STRIPS them (keeping tab/LF/CR), rather than refusing the write outright
//    — see `stripIllegalXmlChars`'s own doc comment for why this diverges
//    from the (superseded-in-this-same-session) refuse-based fix the T12/T13
//    adversarial review originally proposed.
//  - Attribute serialization order and exact XML-declaration bytes are NOT
//    pinned to match desktop's own linkedom output byte-for-byte — T21's own
//    cross-platform parity guard (§9.3) proves "Android reads desktop's
//    golden bytes, and desktop reads Android's own written bytes, producing
//    the identical `PersistedComment[]` shape," never literal byte identity
//    between the two writers' own output, so this is not a correctness gap.
package com.youcoded.app.doccomments

import org.w3c.dom.Document
import org.w3c.dom.Element
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.StringReader
import java.util.Collections
import java.util.Date
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream
import javax.xml.parsers.DocumentBuilder
import javax.xml.parsers.DocumentBuilderFactory
import javax.xml.parsers.ParserConfigurationException
import org.xml.sax.InputSource
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.ConcurrentHashMap
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import javax.xml.transform.OutputKeys
import javax.xml.transform.TransformerFactory
import javax.xml.transform.dom.DOMSource
import javax.xml.transform.stream.StreamResult

// =============================================================================
// Read errors/result — mirrors desktop's `XlsxReadError`/`XlsxReadResult`.
// =============================================================================

/** `UNSAFE_XML` has no desktop counterpart (Android-only — see
 *  `rejectDoctype`'s own doc comment, carried over unchanged from this file's
 *  prior legacy-Notes version, for why this platform needs a check desktop's
 *  `linkedom`-based parser doesn't). `TOO_MANY_COMMENTS` mirrors design
 *  review 1, F3's record-count ceiling. */
enum class XlsxReadError {
    INVALID_XLSX,
    ARCHIVE_TOO_LARGE,
    TOO_MANY_COMMENTS,
    UNSAFE_XML,
}

sealed class XlsxReadResult {
    data class Ok(val comments: List<PersistedComment>) : XlsxReadResult()
    data class Err(val error: XlsxReadError) : XlsxReadResult()
}

/** Task-time starting point, matching desktop's own `MAX_COMMENT_RECORDS`
 *  precedent (xlsx-comments.ts) — not a benchmarked constant. */
private const val MAX_COMMENT_RECORDS = 20000

/** Review F3 (Medium), ported: bounds the AGGREGATE bytes the full-workbook
 *  fallback id-resolution scan freshly parses across every sheet it visits
 *  within one write call — the routine path after any Move, since a moved
 *  thread's own embedded-cell hint goes stale the moment it moves. */
private const val MAX_FALLBACK_SCAN_BYTES = 50L * 1024 * 1024

// =============================================================================
// OOXML constants — §4.2.
// =============================================================================

private const val SML_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
private const val XR_NS = "http://schemas.microsoft.com/office/spreadsheetml/2014/revision"
private const val THREADED_COMMENTS_NS = "http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"
private const val OFFICE_DOCUMENT_R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

private const val COMMENTS_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"
// §4.2: NO `+xml` suffix, unlike every other XML part's content type here.
private const val VML_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.vmlDrawing"
private const val THREADED_COMMENT_CONTENT_TYPE = "application/vnd.ms-excel.threadedcomments+xml"
private const val PERSON_CONTENT_TYPE = "application/vnd.ms-excel.person+xml"

private const val COMMENTS_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments"
private const val VML_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing"
private const val THREADED_COMMENT_REL_TYPE = "http://schemas.microsoft.com/office/2017/10/relationships/threadedComment"
private const val PERSON_REL_TYPE = "http://schemas.microsoft.com/office/2017/10/relationships/person"

private val EMPTY_VML_XML =
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n" +
        "<xml xmlns:v=\"urn:schemas-microsoft-com:vml\" xmlns:o=\"urn:schemas-microsoft-com:office:office\" " +
        "xmlns:x=\"urn:schemas-microsoft-com:office:excel\"><o:shapelayout v:ext=\"edit\">" +
        "<o:idmap v:ext=\"edit\" data=\"1\"/></o:shapelayout><v:shapetype id=\"_x0000_t202\" coordsize=\"21600,21600\" " +
        "o:spt=\"202\" path=\"m,l,21600r21600,l21600,xe\"><v:stroke joinstyle=\"miter\"/>" +
        "<v:path gradientshapeok=\"t\" o:connecttype=\"rect\"/></v:shapetype></xml>"
private val EMPTY_RELS_XML = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n" +
    "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"></Relationships>"
private val EMPTY_COMMENTS_XML = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n" +
    "<comments xmlns=\"$SML_NS\" xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\" " +
    "mc:Ignorable=\"xr\" xmlns:xr=\"$XR_NS\"><authors></authors><commentList></commentList></comments>"
private val EMPTY_THREADED_COMMENTS_XML = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n" +
    "<ThreadedComments xmlns=\"$THREADED_COMMENTS_NS\" xmlns:x=\"$SML_NS\"></ThreadedComments>"
private val EMPTY_PERSON_XML = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n" +
    "<personList xmlns=\"$THREADED_COMMENTS_NS\" xmlns:x=\"$SML_NS\"></personList>"

/** §4.2, byte-for-byte from the real-Excel sample (matches the real-Excel
 *  layout, not Google Sheets' own tab-indented variant — the more common of
 *  the two observed shapes, corroborated a third time by an independent bug
 *  report). */
private val PLACEHOLDER_HEADER = "[Threaded comment]\n\n" +
    "Your version of Excel allows you to read this threaded comment; however, any edits to it will get removed if the file is opened in a newer version of Excel. Learn more: https://go.microsoft.com/fwlink/?linkid=870924\n\n" +
    "Comment:\n    "

private fun buildPlaceholderBody(commentText: String, replyTexts: List<String>): String {
    val sb = StringBuilder(PLACEHOLDER_HEADER).append(commentText)
    for (reply in replyTexts) sb.append("\nReply:\n    ").append(reply)
    return sb.toString()
}

private val TC_AUTHOR_RE = Regex("^tc=\\{[0-9A-Fa-f-]{36}\\}$")
private fun isTcAuthorText(text: String): Boolean = TC_AUTHOR_RE.matches(text)

/** §4.2: strips braces and lowercases, so an uppercase (Windows/Mac Excel)
 *  and a lowercase (Google Sheets) GUID compare equal. This app's own writer
 *  always MINTS uppercase; every COMPARISON goes through this function. */
private fun normalizeGuid(raw: String): String = raw.replace("{", "").replace("}", "").lowercase()

private fun mintGuid(): String = "{${UUID.randomUUID().toString().uppercase()}}"

/** §4.2's confirmed real-world format: `YYYY-MM-DDTHH:MM:SS.ff` — exactly two
 *  fractional-second digits, no timezone offset, never a trailing `Z`.
 *  Written in LOCAL time, matching every real writer sampled. */
private fun formatThreadedDate(d: Date): String {
    val cal = java.util.Calendar.getInstance()
    cal.time = d
    val y = cal.get(java.util.Calendar.YEAR)
    val mo = cal.get(java.util.Calendar.MONTH) + 1
    val day = cal.get(java.util.Calendar.DAY_OF_MONTH)
    val h = cal.get(java.util.Calendar.HOUR_OF_DAY)
    val mi = cal.get(java.util.Calendar.MINUTE)
    val s = cal.get(java.util.Calendar.SECOND)
    val cs = cal.get(java.util.Calendar.MILLISECOND) / 10
    return "%04d-%02d-%02dT%02d:%02d:%02d.%02d".format(y, mo, day, h, mi, s, cs)
}

private val THREADED_DATE_RE = Regex("^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})\\.(\\d+)$")

/** Mirrors desktop's `Date.parse(dT)` (which treats an offset-less ISO-shaped
 *  string as LOCAL time) — a small hand-rolled parser since Java has no
 *  single built-in formatter for a variable-length fractional-second, no-
 *  timezone timestamp. Falls back to "now" for a malformed value, same as
 *  desktop's own `Number.isNaN(t) ? Date.now() : t`. */
private fun parseThreadedDate(dT: String): Long {
    val m = THREADED_DATE_RE.find(dT) ?: return System.currentTimeMillis()
    return try {
        val (y, mo, day, h, mi, s, frac) = m.destructured
        val cal = java.util.Calendar.getInstance()
        cal.clear()
        cal.set(y.toInt(), mo.toInt() - 1, day.toInt(), h.toInt(), mi.toInt(), s.toInt())
        val fracDigits = frac.length
        val millis = (frac.toInt() * Math.pow(10.0, (3 - fracDigits).toDouble())).toInt().coerceIn(0, 999)
        cal.set(java.util.Calendar.MILLISECOND, millis)
        cal.timeInMillis
    } catch (_: Exception) {
        System.currentTimeMillis()
    }
}

private fun toCommentAuthor(name: String): CommentAuthor = "person:" + name.ifEmpty { "Unknown" }

/** §3.4/§4.1's rule, mirrored from `DocxComments.kt`'s own
 *  `commentAuthorToDisplayName` (duplicated rather than shared — the two
 *  write modules are deliberately independent, same convention desktop's own
 *  xlsx-comments.ts documents for its relationship to docx-comments.ts). */
private fun commentAuthorToDisplayName(author: CommentAuthor): String = when {
    author == "user" -> "You"
    author == "assistant" -> "Assistant"
    author.startsWith("person:") -> author.removePrefix("person:").ifEmpty { "Unknown" }
    else -> "Unknown"
}

// A1-style reference, 1-3 letters then 1-7 digits.
private val CELL_ADDRESS_RE = Regex("^[A-Z]{1,3}[1-9][0-9]{0,6}$")
private fun isValidCellAddress(addr: String): Boolean = CELL_ADDRESS_RE.matches(addr)

private fun colLettersToNumber(letters: String): Int {
    var col = 0
    for (ch in letters) col = col * 26 + (ch.code - 64)
    return col
}

/** `"B5"` -> `(col=2, row=5)`, both 1-based. `null` for a malformed address. */
private fun parseCellRef(addr: String): Pair<Int, Int>? {
    val m = Regex("^([A-Z]{1,3})([1-9][0-9]{0,6})$").find(addr) ?: return null
    return colLettersToNumber(m.groupValues[1]) to m.groupValues[2].toInt()
}

// -----------------------------------------------------------------------
// The app-level thread id — §4.2's GUID-embedding scheme (design review 1,
// F1; parse regex pre-written by design review round 2, F2). SAME regex as
// desktop's own `XLSX_THREAD_ID_RE`, checked against the SAME shared
// `shared-fixtures/doc-comments/id-parse-test-vectors.json`.
// -----------------------------------------------------------------------

// `internal`, not `private` — this class is the return type of the
// `internal` `parseXlsxThreadId` below; a pinning test (XlsxCommentsTest.kt)
// calls that function directly against the shared `id-parse-test-vectors.json`
// fixture (design review round 2, F2), so both need matching visibility.
internal class ParsedThreadId(val sheetId: Int, val cell: String, val guid: String)

private val XLSX_THREAD_ID_RE = Regex("^xt-(\\d+)-([^-]+)-(.+)$")

internal fun parseXlsxThreadId(id: String): ParsedThreadId? {
    val m = XLSX_THREAD_ID_RE.find(id) ?: return null
    val sheetId = m.groupValues[1].toIntOrNull() ?: return null
    val cell = m.groupValues[2]
    if (!isValidCellAddress(cell)) return null
    return ParsedThreadId(sheetId, cell, m.groupValues[3])
}

private fun buildXlsxThreadId(sheetId: Int, cell: String, guidBraced: String): String =
    "xt-$sheetId-$cell-${guidBraced.replace("{", "").replace("}", "")}"

// -----------------------------------------------------------------------
// Illegal XML 1.0 control characters — STRIPPED, not refused (2026-09-27+
// direction, coordinated with the desktop/DocxComments.kt fix landing in this
// same session). XML 1.0 forbids U+0000-U+0008, U+000B-U+000C, U+000E-U+001F
// anywhere in a well-formed document, even as a numeric character reference
// (tab/LF/CR are the only C0 codepoints allowed). A prior review
// (docs/active/reviews/2026-09-27-doc-comments-xlsx-t12-t13-review.md, F1)
// chose to REFUSE this outright; the coordinating session for this build
// moved the whole feature (desktop's xlsx-comments.ts/docx-comments.ts AND
// DocxComments.kt) to silently STRIP instead — an invisible control byte from
// a bad paste/clipboard/PDF-copy is never something a user consciously typed,
// so normalizing it costs less than a hard refusal on an otherwise-fine
// comment. Applied to every user/assistant-authored string this module writes
// into `<text>` or the legacy placeholder body.
// -----------------------------------------------------------------------
private val ILLEGAL_XML_CHAR_REGEX = Regex("[\u0000-\u0008\u000B\u000C\u000E-\u001F]")
private fun stripIllegalXmlChars(text: String): String = ILLEGAL_XML_CHAR_REGEX.replace(text, "")

// -----------------------------------------------------------------------
// Path helpers — OOXML relationship `Target`s are relative to the REFERRING
// part's own directory, never absolute.
// -----------------------------------------------------------------------

private fun dirnameOfPart(p: String): String {
    val i = p.lastIndexOf('/')
    return if (i == -1) "" else p.substring(0, i)
}

private fun basenameOfPart(p: String): String {
    val i = p.lastIndexOf('/')
    return if (i == -1) p else p.substring(i + 1)
}

private fun resolveRelTarget(baseDir: String, target: String): String {
    val segments = (baseDir.split("/") + target.split("/")).filter { it.isNotEmpty() }
    val out = mutableListOf<String>()
    for (seg in segments) {
        when (seg) {
            "." -> {}
            ".." -> if (out.isNotEmpty()) out.removeAt(out.size - 1)
            else -> out.add(seg)
        }
    }
    return out.joinToString("/")
}

private fun relativizeTarget(fromDir: String, toPath: String): String {
    val fromParts = fromDir.split("/").filter { it.isNotEmpty() }
    val toParts = toPath.split("/").filter { it.isNotEmpty() }
    var i = 0
    while (i < fromParts.size && i < toParts.size - 1 && fromParts[i] == toParts[i]) i++
    val ups = fromParts.size - i
    val downs = toParts.drop(i)
    return (List(ups) { ".." } + downs).joinToString("/")
}

private fun worksheetRelsPathFor(partPath: String): String =
    "${dirnameOfPart(partPath)}/_rels/${basenameOfPart(partPath)}.rels"

// -----------------------------------------------------------------------
// XML plumbing — namespace-UNAWARE `javax.xml.parsers` (same convention as
// `DocxComments.kt`), plus a `localName`-based walk for the ONE place
// namespace prefixes vary by writer (threadedComment/text/person — §4.2's
// own load-bearing finding: real Excel uses the DEFAULT namespace, real
// Google Sheets prefixes every element `x18tc:`).
// -----------------------------------------------------------------------

/** Same secure factory as `DocxComments.kt` — see that file's own header for
 *  the full OWASP/Android-`javax.xml`-surface reasoning. Duplicated rather
 *  than shared (independent-modules convention, this file's own header). */
private fun newSecureDocumentBuilder(): DocumentBuilder {
    val factory = DocumentBuilderFactory.newInstance()
    factory.isNamespaceAware = false
    factory.isXIncludeAware = false
    factory.isExpandEntityReferences = false
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
            // Not fatal — see DocxComments.kt's identical comment.
        }
    }
    return factory.newDocumentBuilder()
}

/** Thrown by `parseXml` when a part's raw XML text contains a `<!DOCTYPE`
 *  declaration — refused BEFORE any parser sees it. Carried over unchanged
 *  from this file's own prior (legacy-Notes) version — see that version's
 *  removed header, or `DocxComments.kt`'s identical class, for the full
 *  Expat-vs-Xerces reasoning. */
private class XlsxUnsafeXmlDoctypeException : Exception()

private val DOCTYPE_DECLARATION = Regex("(?i)<!DOCTYPE")

private fun rejectDoctype(xml: String) {
    if (DOCTYPE_DECLARATION.containsMatchIn(xml)) throw XlsxUnsafeXmlDoctypeException()
}

private fun parseXml(xml: String): Document {
    rejectDoctype(xml)
    return newSecureDocumentBuilder().parse(InputSource(StringReader(xml)))
}

private fun elementsByTag(doc: Document, tag: String): List<Element> {
    val nodes = doc.getElementsByTagName(tag)
    return (0 until nodes.length).map { nodes.item(it) as Element }
}

private fun elementsByTag(el: Element, tag: String): List<Element> {
    val nodes = el.getElementsByTagName(tag)
    return (0 until nodes.length).map { nodes.item(it) as Element }
}

private fun localName(tag: String): String {
    val i = tag.lastIndexOf(':')
    return if (i == -1) tag else tag.substring(i + 1)
}

private fun collectByLocalName(el: Element, name: String, out: MutableList<Element>) {
    val children = el.childNodes
    for (i in 0 until children.length) {
        val c = children.item(i)
        if (c is Element) {
            if (localName(c.tagName) == name) out.add(c)
            collectByLocalName(c, name, out)
        }
    }
}

/** §4.2's namespace-prefix finding: matches every element by LOCAL name
 *  (the substring after the last `:`), never a literal (possibly `x18tc:`-
 *  prefixed) tag string — the Kotlin equivalent of desktop's own
 *  `elementsByLocalName` (xlsx-comments.ts). Mirrors that function's own
 *  document-order guarantee (a plain recursive descendant walk, same order a
 *  `querySelectorAll('*')` scan produces). */
private fun elementsByLocalName(doc: Document, name: String): List<Element> {
    val out = mutableListOf<Element>()
    val root = doc.documentElement ?: return out
    if (localName(root.tagName) == name) out.add(root)
    collectByLocalName(root, name, out)
    return out
}

private fun elementsByLocalName(el: Element, name: String): List<Element> {
    val out = mutableListOf<Element>()
    if (localName(el.tagName) == name) out.add(el)
    collectByLocalName(el, name, out)
    return out
}

/** Detects whether an EXISTING `ThreadedComments`/`personList` document uses
 *  the default-namespace (Excel) convention or a prefixed (`x18tc:`, Google
 *  Sheets) one, by reading the root element's own tag name — so a NEW
 *  element appended into an existing part matches whatever convention that
 *  part already uses. `""` (no prefix) for a brand-new part this app mints
 *  itself. */
private fun detectPrefix(doc: Document): String {
    val rootTag = doc.documentElement.tagName
    val i = rootTag.indexOf(':')
    return if (i == -1) "" else rootTag.substring(0, i)
}

private fun tcTag(prefix: String, local: String): String = if (prefix.isNotEmpty()) "$prefix:$local" else local

private fun serializeXmlDocument(doc: Document): String {
    val transformer = TransformerFactory.newInstance().newTransformer()
    transformer.setOutputProperty(OutputKeys.OMIT_XML_DECLARATION, "yes")
    transformer.setOutputProperty(OutputKeys.METHOD, "xml")
    transformer.setOutputProperty(OutputKeys.ENCODING, "UTF-8")
    val writer = java.io.StringWriter()
    transformer.transform(DOMSource(doc), StreamResult(writer))
    return writer.toString()
}

private val XML_DECL_RE = Regex("^<\\?xml[^>]*\\?>")

/** Mirrors desktop's `serializeXlsxPart` (F2's own discipline): a CHANGED
 *  part is re-serialized fresh, with its XML declaration forced back to the
 *  ORIGINAL part's own declaration when one exists, or a sensible default for
 *  a brand-new part. An UNCHANGED part is never routed through this at
 *  all — see `serializeArchiveToFile` below. */
private fun serializeXlsxPart(doc: Document, originalXml: String?): String {
    val body = serializeXmlDocument(doc)
    val decl = originalXml?.let { XML_DECL_RE.find(it)?.value }
        ?: "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
    return decl + body
}

private fun ZipOutputStream.writeXlsxEntry(name: String, bytes: ByteArray) {
    putNextEntry(ZipEntry(name))
    write(bytes)
    closeEntry()
}

// -----------------------------------------------------------------------
// Exact OOXML shapes for brand-new parts — §4.2.
// -----------------------------------------------------------------------

/** Builds one `<v:shape>` element for a brand-new threaded-comment
 *  placeholder at 1-based `(col, row)`. §4.2's own confirmed difference from
 *  a genuine legacy Note's VML: every real threaded-placeholder sample
 *  (Mac Excel, Google Sheets, and a cross-checked-but-not-redistributed
 *  Windows Excel sample) OMITS `<x:Locked>`/`<x:LockText>` — present on a
 *  genuine Note's own VML, never on a threaded placeholder's. Anchor math is
 *  identical to the (retired) legacy-Notes VML builder's own formula. */
private fun buildThreadedVmlShape(doc: Document, idNumber: Int, col: Int, row: Int): Element {
    val shape = doc.createElement("v:shape")
    shape.setAttribute("id", "_x0000_s$idNumber")
    shape.setAttribute("type", "#_x0000_t202")
    shape.setAttribute(
        "style",
        "position:absolute; margin-left:105.3pt;margin-top:10.5pt;width:97.8pt;height:59.1pt;z-index:1;visibility:hidden",
    )
    shape.setAttribute("fillcolor", "infoBackground [80]")
    shape.setAttribute("strokecolor", "none [81]")
    shape.setAttribute("o:insetmode", "auto")

    val fill = doc.createElement("v:fill")
    fill.setAttribute("color2", "infoBackground [80]")
    shape.appendChild(fill)
    val shadow = doc.createElement("v:shadow")
    shadow.setAttribute("color", "none [81]")
    shadow.setAttribute("obscured", "t")
    shape.appendChild(shadow)
    val vpath = doc.createElement("v:path")
    vpath.setAttribute("o:connecttype", "none")
    shape.appendChild(vpath)

    val textbox = doc.createElement("v:textbox")
    textbox.setAttribute("style", "mso-direction-alt:auto")
    textbox.setAttribute("inset", "1.3mm,1.3mm,2.5mm,2.5mm")
    val div = doc.createElement("div")
    div.setAttribute("style", "text-align:left")
    textbox.appendChild(div)
    shape.appendChild(textbox)

    val clientData = doc.createElement("x:ClientData")
    clientData.setAttribute("ObjectType", "Note")
    clientData.appendChild(doc.createElement("x:MoveWithCells"))
    clientData.appendChild(doc.createElement("x:SizeWithCells"))
    // Default anchor rect (exceljs's own `getDefaultRect`, 1-based col/row):
    // l=col, t=max(row-2,0), r=col+2, b=t+4, fixed sub-cell fractions
    // 6/14/2/16 — carried forward unchanged from the retired legacy-Notes
    // builder (a positioning formula unrelated to note-vs-threaded).
    val l = col
    val t = maxOf(row - 2, 0)
    val r = col + 2
    val b = t + 4
    val anchor = doc.createElement("x:Anchor")
    anchor.textContent = listOf(l, 6, t, 14, r, 2, b, 16).joinToString(", ")
    clientData.appendChild(anchor)
    val autoFill = doc.createElement("x:AutoFill")
    autoFill.textContent = "False"
    clientData.appendChild(autoFill)
    val rowEl = doc.createElement("x:Row")
    rowEl.textContent = (row - 1).toString()
    clientData.appendChild(rowEl)
    val colEl = doc.createElement("x:Column")
    colEl.textContent = (col - 1).toString()
    clientData.appendChild(colEl)
    shape.appendChild(clientData)

    return shape
}

private fun nextVmlShapeId(vmlDoc: Document): Int {
    var max = 1024
    for (el in elementsByTag(vmlDoc, "v:shape")) {
        Regex("^_x0000_s(\\d+)$").find(el.getAttribute("id"))?.let { max = maxOf(max, it.groupValues[1].toInt()) }
    }
    return max + 1
}

private fun ensureXrNamespaceDeclared(doc: Document) {
    if (doc.documentElement.getAttribute("xmlns:xr").isEmpty()) {
        doc.documentElement.setAttribute("xmlns:xr", XR_NS)
    }
}

/** Review F2 (Medium-High), ported: reuse an EXISTING `tc={GUID}` author
 *  entry before minting a new one — the same "reused, never duplicated" rule
 *  `resolveOrCreatePerson` already applies to `persons.xml`. Closes the
 *  "grows by one leftover string per move, forever" defect the review found
 *  against the desktop reader. */
private fun resolveOrAppendTcAuthor(commentsDoc: Document, guidBraced: String): Int {
    var authorsEl = elementsByTag(commentsDoc, "authors").firstOrNull()
    if (authorsEl == null) {
        authorsEl = commentsDoc.createElement("authors")
        commentsDoc.documentElement.insertBefore(authorsEl, commentsDoc.documentElement.firstChild)
    }
    val authorEls = elementsByTag(authorsEl, "author")
    val target = normalizeGuid(guidBraced)
    val existingIdx = authorEls.indexOfFirst {
        val text = it.textContent ?: ""
        isTcAuthorText(text) && normalizeGuid(text.substring(3)) == target
    }
    if (existingIdx != -1) return existingIdx
    val newAuthor = commentsDoc.createElement("author")
    newAuthor.textContent = "tc=$guidBraced"
    authorsEl.appendChild(newAuthor)
    return authorEls.size
}

/** §4.1's rule: does the target cell already carry a GENUINE (non-`tc=`)
 *  Note in `commentsDoc`? Used to refuse `CELL_HAS_NOTE`. */
private fun findGenuineNoteAtCell(commentsDoc: Document, cell: String): Boolean {
    val authorsEl = elementsByTag(commentsDoc, "authors").firstOrNull()
    val authorEls = authorsEl?.let { elementsByTag(it, "author") } ?: emptyList()
    for (commentEl in elementsByTag(commentsDoc, "comment")) {
        if (commentEl.getAttribute("ref") != cell) continue
        val idx = commentEl.getAttribute("authorId").toIntOrNull() ?: continue
        val authorText = authorEls.getOrNull(idx)?.textContent ?: ""
        if (!isTcAuthorText(authorText)) return true
    }
    return false
}

/** Finds the ONE legacy `<comment>` fronting for the thread whose root GUID
 *  is `guidBraced`, by resolving each `<comment>`'s own `authorId` through
 *  `<authors>` and matching the `tc={GUID}` string case-insensitively. */
private fun findTcComment(commentsDoc: Document, guidBraced: String): Element? {
    val authorsEl = elementsByTag(commentsDoc, "authors").firstOrNull()
    val authorEls = authorsEl?.let { elementsByTag(it, "author") } ?: emptyList()
    val target = "tc=${normalizeGuid(guidBraced)}"
    for (commentEl in elementsByTag(commentsDoc, "comment")) {
        val idx = commentEl.getAttribute("authorId").toIntOrNull() ?: continue
        val authorText = authorEls.getOrNull(idx)?.textContent ?: ""
        if (isTcAuthorText(authorText) && "tc=${normalizeGuid(authorText.substring(3))}" == target) return commentEl
    }
    return null
}

private fun setXlsxCommentBody(doc: Document, commentEl: Element, bodyText: String) {
    for (existing in elementsByTag(commentEl, "text")) {
        existing.parentNode?.removeChild(existing)
    }
    val textEl = doc.createElement("text")
    val rEl = doc.createElement("r")
    val tEl = doc.createElement("t")
    if (Regex("^\\s|\\n|\\s$").containsMatchIn(bodyText)) tEl.setAttribute("xml:space", "preserve")
    tEl.textContent = bodyText
    rEl.appendChild(tEl)
    textEl.appendChild(rEl)
    commentEl.appendChild(textEl)
}

private fun appendPlaceholderComment(commentsDoc: Document, cellAddr: String, authorIdx: Int, guidBraced: String, bodyText: String) {
    ensureXrNamespaceDeclared(commentsDoc)
    val commentList = elementsByTag(commentsDoc, "commentList").first()
    val commentEl = commentsDoc.createElement("comment")
    commentEl.setAttribute("ref", cellAddr)
    commentEl.setAttribute("authorId", authorIdx.toString())
    commentEl.setAttribute("xr:uid", guidBraced)
    setXlsxCommentBody(commentsDoc, commentEl, bodyText)
    commentList.appendChild(commentEl)
}

// -----------------------------------------------------------------------
// Per-worksheet / per-workbook wiring.
// -----------------------------------------------------------------------

private class SheetMeta(val name: String, val sheetId: Int, val rId: String, val partPath: String, val isChartsheet: Boolean)

/** Parses `xl/workbook.xml`'s `<sheets>` against `xl/_rels/workbook.xml.rels`
 *  to resolve each `<sheet>`'s real worksheet PART path and whether it's a
 *  chartsheet — chartsheets are excluded from every cell-comment operation. */
private fun parseSheetsFromWorkbook(workbookXml: String, workbookRelsXml: String): List<SheetMeta> {
    val workbookDoc = parseXml(workbookXml)
    val relsDoc = parseXml(workbookRelsXml)
    val relMap = HashMap<String, Pair<String, String>>() // id -> (target, type)
    for (el in elementsByTag(relsDoc, "Relationship")) {
        val id = el.getAttribute("Id")
        if (id.isNotEmpty()) relMap[id] = el.getAttribute("Target") to el.getAttribute("Type")
    }
    val sheets = mutableListOf<SheetMeta>()
    for (el in elementsByTag(workbookDoc, "sheet")) {
        val name = el.getAttribute("name")
        val sheetId = el.getAttribute("sheetId").toIntOrNull()
        val rId = el.getAttribute("r:id")
        val rel = relMap[rId]
        if (rel == null || sheetId == null) continue // malformed wiring — not addressable
        sheets.add(SheetMeta(name, sheetId, rId, resolveRelTarget("xl", rel.first), rel.second.endsWith("/chartsheet")))
    }
    return sheets
}

private class WorksheetCtx(
    val partPath: String,
    val sheetId: Int,
    val sheetName: String,
    val worksheetDoc: Document,
    val worksheetXmlOriginal: String,
    var worksheetChanged: Boolean = false,
    val relsPartPath: String,
    val relsDoc: Document,
    val relsXmlOriginal: String?,
    var relsChanged: Boolean = false,
    var ambiguous: Boolean = false,
    var commentsPartPath: String? = null,
    var commentsDoc: Document? = null,
    var commentsXmlOriginal: String? = null,
    var commentsChanged: Boolean = false,
    var vmlPartPath: String? = null,
    var vmlDoc: Document? = null,
    var vmlXmlOriginal: String? = null,
    var vmlChanged: Boolean = false,
    var threadedPartPath: String? = null,
    var threadedDoc: Document? = null,
    var threadedXmlOriginal: String? = null,
    var threadedChanged: Boolean = false,
)

/** Review F1 (High, android-xlsx-review): every part this write TOUCHES —
 *  the fixed top-level trio (`[Content_Types].xml`, `xl/workbook.xml`,
 *  `xl/_rels/workbook.xml.rels`), `persons.xml` if present, and whatever
 *  `getWorksheetContext` lazily resolves for a specific worksheet — is
 *  decompressed ONCE and its original bytes kept in `originalBytesByName`,
 *  keyed by zip entry name. `zip` (the source archive, kept OPEN by the
 *  caller for this whole load-mutate-serialize call — see
 *  `loadMutateSerializeXlsx`) is consulted directly at serialize time for
 *  every OTHER entry, which is streamed straight through
 *  (`streamCopyUntouchedEntry`) rather than ever being fully decompressed
 *  into memory here. This REPLACES the prior design (`entries: LinkedHashMap
 *  <String, ByteArray>`, eagerly populated for the WHOLE archive regardless
 *  of what the mutation touched) the review's own F1 finding confirmed
 *  decompressed AND re-compressed every single part on every write,
 *  contradicting this module's own "never re-serialize an untouched part"
 *  claim and multiplying peak memory on a phone for any workbook carrying
 *  large unrelated parts (embedded images, many untouched worksheets). */
private class WriteArchive(
    val zip: ZipFile,
    val originalBytesByName: MutableMap<String, ByteArray> = mutableMapOf(),
    val sheets: List<SheetMeta>,
    val contentTypesDoc: Document,
    val contentTypesOriginal: String,
    var contentTypesChanged: Boolean = false,
    val workbookRelsDoc: Document,
    val workbookRelsOriginal: String,
    var workbookRelsChanged: Boolean = false,
    var personsPartPath: String,
    var personsDoc: Document?,
    var personsOriginal: String?,
    var personsChanged: Boolean = false,
    val worksheetContexts: MutableMap<String, WorksheetCtx> = mutableMapOf(),
    var parsedBytesTotal: Long = 0L,
    // Edit/delete build (2026-09-28): part names `cleanupEmptyCommentPartsIfNeeded`
    // has removed outright (`commentsN.xml`/`vmlDrawingN.vml`/`threadedCommentN.xml`,
    // once a worksheet's last comment of any kind is deleted). Desktop's JSZip
    // has a real `zip.remove(path)` that makes a part vanish from the archive
    // outright (xlsx-comments.ts's own `cleanupEmptyCommentPartsIfNeeded`);
    // Kotlin's `ZipFile` is read-only and `serializeArchiveToFile` streams
    // untouched entries straight from it, so this set is what tells that
    // function "never write this entry back, from either `overrides` or the
    // original archive" — the Kotlin-side equivalent of a genuine removal.
    val removedPartNames: MutableSet<String> = mutableSetOf(),
)

/** Reads (and, in `tracker`, REMEMBERS) one named part's raw bytes — the lazy
 *  replacement for the old eager `entries` map. Returns `null` (and tracks
 *  nothing) if the part doesn't exist. Every caller that wants a part's bytes
 *  available for a byte-identical write-back (never re-serialized unless
 *  actually changed) goes through this, never a direct `zip.getInputStream`
 *  call — that discipline is what lets `serializeArchiveToFile` tell "this
 *  operation touched it" (present in the map, even if unchanged) apart from
 *  "genuinely untouched" (stream-copy) by a single map lookup. Takes the
 *  tracking map directly, not a whole `WriteArchive`, so `loadArchiveForWrite`
 *  can populate it BEFORE the (immutable-by-`val`) `WriteArchive` itself
 *  exists. */
private fun readAndTrackPart(zip: ZipFile, name: String, tracker: MutableMap<String, ByteArray>): String? {
    val entry = zip.getEntry(name) ?: return null
    val bytes = readEntryBounded(zip, entry)
    tracker[name] = bytes
    return bytes.toString(Charsets.UTF_8)
}

/** `WriteArchive`-taking overload for every call site AFTER the archive
 *  itself exists (`getWorksheetContext` and friends) — just forwards to the
 *  map-taking version above using the archive's own tracker. */
private fun readAndTrackPart(archive: WriteArchive, name: String): String? =
    readAndTrackPart(archive.zip, name, archive.originalBytesByName)

/** Picks the smallest positive integer not already used by an
 *  `xl/comments<N>.xml`, `xl/drawings/vmlDrawing<N>.vml`, OR
 *  `xl/threadedComments/threadedComment<N>.xml` part ANYWHERE in the
 *  archive — "skip the gap, don't reserve it" (§4.2). Scans `archive.zip`'s
 *  own entry NAMES directly (central-directory metadata only, exactly like
 *  the read path's own size guard — no decompression), rather than the old
 *  `entries.keys` map, since that map no longer holds every part's name
 *  after the F1 fix (only the ones actually touched). */
private fun mintPartNumber(archive: WriteArchive): Int {
    var max = 0
    for (entry in Collections.list(archive.zip.entries())) {
        val p = entry.name
        Regex("^xl/comments(\\d+)\\.xml$").find(p)?.let { max = maxOf(max, it.groupValues[1].toInt()) }
        Regex("^xl/drawings/vmlDrawing(\\d+)\\.vml$").find(p)?.let { max = maxOf(max, it.groupValues[1].toInt()) }
        Regex("^xl/threadedComments/threadedComment(\\d+)\\.xml$").find(p)?.let { max = maxOf(max, it.groupValues[1].toInt()) }
    }
    return max + 1
}

private fun extractPartNumber(partPath: String): Int {
    val m = Regex("(\\d+)\\.[a-zA-Z]+$").find(partPath)
    return m?.groupValues?.get(1)?.toIntOrNull() ?: 1
}

private fun nextRelId(relsDoc: Document): String {
    var max = 0
    for (el in elementsByTag(relsDoc, "Relationship")) {
        Regex("^rId(\\d+)$").find(el.getAttribute("Id"))?.let { max = maxOf(max, it.groupValues[1].toInt()) }
    }
    return "rId${max + 1}"
}

private fun addXlsxRelationship(relsDoc: Document, id: String, type: String, target: String) {
    val el = relsDoc.createElement("Relationship")
    el.setAttribute("Id", id)
    el.setAttribute("Type", type)
    el.setAttribute("Target", target)
    relsDoc.documentElement.appendChild(el)
}

private fun addContentTypeOverride(contentTypesDoc: Document, partName: String, contentType: String) {
    val exists = elementsByTag(contentTypesDoc, "Override").any { it.getAttribute("PartName") == partName }
    if (exists) return
    val el = contentTypesDoc.createElement("Override")
    el.setAttribute("PartName", partName)
    el.setAttribute("ContentType", contentType)
    contentTypesDoc.documentElement.appendChild(el)
}

/** Creates a brand-new comments{N}.xml/vmlDrawing{N}.vml pair, wires the
 *  worksheet's own rels and `[Content_Types].xml`, and inserts
 *  `<legacyDrawing r:id="...">` as the worksheet's OWN LAST child element —
 *  design review round 2, F4 (High): this exact rule was found and fixed once
 *  already for the retired legacy-Notes design, and must land AFTER a
 *  pre-existing `<extLst>` if one exists, never before it. `appendChild`
 *  satisfies this unconditionally. Also review F5 (Low): declares `xmlns:r`
 *  on the worksheet root defensively before ever setting `r:id`. */
private fun createLegacyPair(archive: WriteArchive, ctx: WorksheetCtx, n: Int) {
    ctx.commentsPartPath = "xl/comments$n.xml"
    ctx.vmlPartPath = "xl/drawings/vmlDrawing$n.vml"
    ctx.commentsXmlOriginal = null
    ctx.vmlXmlOriginal = null
    ctx.commentsDoc = parseXml(EMPTY_COMMENTS_XML)
    ctx.vmlDoc = parseXml(EMPTY_VML_XML)

    var vmlDefaultEl = elementsByTag(archive.contentTypesDoc, "Default").find { it.getAttribute("Extension").lowercase() == "vml" }
    if (vmlDefaultEl == null) {
        vmlDefaultEl = archive.contentTypesDoc.createElement("Default")
        vmlDefaultEl.setAttribute("Extension", "vml")
        vmlDefaultEl.setAttribute("ContentType", VML_CONTENT_TYPE)
        archive.contentTypesDoc.documentElement.appendChild(vmlDefaultEl)
    }
    val override = archive.contentTypesDoc.createElement("Override")
    override.setAttribute("PartName", "/${ctx.commentsPartPath}")
    override.setAttribute("ContentType", COMMENTS_CONTENT_TYPE)
    vmlDefaultEl.parentNode?.insertBefore(override, vmlDefaultEl.nextSibling)
    archive.contentTypesChanged = true

    val worksheetDir = dirnameOfPart(ctx.partPath)
    val commentsRelId = nextRelId(ctx.relsDoc)
    addXlsxRelationship(ctx.relsDoc, commentsRelId, COMMENTS_REL_TYPE, relativizeTarget(worksheetDir, ctx.commentsPartPath!!))
    val vmlRelId = nextRelId(ctx.relsDoc)
    addXlsxRelationship(ctx.relsDoc, vmlRelId, VML_REL_TYPE, relativizeTarget(worksheetDir, ctx.vmlPartPath!!))
    ctx.relsChanged = true

    if (ctx.worksheetDoc.documentElement.getAttribute("xmlns:r").isEmpty()) {
        ctx.worksheetDoc.documentElement.setAttribute("xmlns:r", OFFICE_DOCUMENT_R_NS)
    }
    val legacyDrawing = ctx.worksheetDoc.createElement("legacyDrawing")
    legacyDrawing.setAttribute("r:id", vmlRelId)
    ctx.worksheetDoc.documentElement.appendChild(legacyDrawing)
    ctx.worksheetChanged = true
}

/** §4.2: both relationships are "implicit" — creating the threaded part needs
 *  only a rels entry + content-types Override, never any worksheet-content
 *  wiring beyond that. */
private fun createThreadedPart(archive: WriteArchive, ctx: WorksheetCtx, n: Int) {
    ctx.threadedPartPath = "xl/threadedComments/threadedComment$n.xml"
    ctx.threadedXmlOriginal = null
    ctx.threadedDoc = parseXml(EMPTY_THREADED_COMMENTS_XML)

    val worksheetDir = dirnameOfPart(ctx.partPath)
    val relId = nextRelId(ctx.relsDoc)
    addXlsxRelationship(ctx.relsDoc, relId, THREADED_COMMENT_REL_TYPE, relativizeTarget(worksheetDir, ctx.threadedPartPath!!))
    ctx.relsChanged = true

    addContentTypeOverride(archive.contentTypesDoc, "/${ctx.threadedPartPath}", THREADED_COMMENT_CONTENT_TYPE)
    archive.contentTypesChanged = true
}

private fun ensureThreadedWiring(archive: WriteArchive, ctx: WorksheetCtx) {
    if (ctx.commentsDoc == null) {
        val n = mintPartNumber(archive)
        createLegacyPair(archive, ctx, n)
        createThreadedPart(archive, ctx, n)
    } else if (ctx.threadedDoc == null) {
        val n = extractPartNumber(ctx.commentsPartPath!!)
        createThreadedPart(archive, ctx, n)
    }
}

private fun ensurePersonsPart(archive: WriteArchive) {
    if (archive.personsDoc != null) return
    archive.personsDoc = parseXml(EMPTY_PERSON_XML)
    archive.personsOriginal = null
    archive.personsChanged = true

    val alreadyWired = elementsByTag(archive.workbookRelsDoc, "Relationship").any { it.getAttribute("Type") == PERSON_REL_TYPE }
    if (!alreadyWired) {
        val relId = nextRelId(archive.workbookRelsDoc)
        addXlsxRelationship(archive.workbookRelsDoc, relId, PERSON_REL_TYPE, relativizeTarget("xl", archive.personsPartPath))
        archive.workbookRelsChanged = true
    }
    addContentTypeOverride(archive.contentTypesDoc, "/${archive.personsPartPath}", PERSON_CONTENT_TYPE)
    archive.contentTypesChanged = true
}

/** §4.2's reuse-not-duplicate rule: before minting a new `<person>`, look for
 *  an existing entry with `providerId="YouCoded"` AND a matching
 *  `displayName`. `userId` is omitted (matching Google Sheets' own
 *  precedent). */
private fun resolveOrCreatePerson(archive: WriteArchive, author: CommentAuthor): String {
    ensurePersonsPart(archive)
    val displayName = commentAuthorToDisplayName(author)
    val existing = elementsByLocalName(archive.personsDoc!!, "person").find {
        it.getAttribute("providerId") == "YouCoded" && it.getAttribute("displayName") == displayName
    }
    if (existing != null) {
        val id = existing.getAttribute("id")
        if (id.isNotEmpty()) return id
    }
    val id = mintGuid()
    val personEl = archive.personsDoc!!.createElement("person")
    personEl.setAttribute("displayName", displayName)
    personEl.setAttribute("id", id)
    personEl.setAttribute("providerId", "YouCoded")
    archive.personsDoc!!.documentElement.appendChild(personEl)
    archive.personsChanged = true
    return id
}

// -----------------------------------------------------------------------
// Thread lookup — root/reply element helpers, shared by read and write.
// -----------------------------------------------------------------------

private fun isRootThreadedComment(el: Element): Boolean = el.getAttribute("parentId").isEmpty()

private fun repliesOfRoot(threadedDoc: Document, rootIdBraced: String): List<Element> {
    val target = normalizeGuid(rootIdBraced)
    return elementsByLocalName(threadedDoc, "threadedComment").filter { normalizeGuid(it.getAttribute("parentId")) == target }
}

private fun textOfThreadedComment(el: Element): String = elementsByLocalName(el, "text").firstOrNull()?.textContent ?: ""

private fun findRootByRefAndGuid(threadedDoc: Document, ref: String, guidNorm: String): Element? =
    elementsByLocalName(threadedDoc, "threadedComment").find {
        isRootThreadedComment(it) && it.getAttribute("ref") == ref && normalizeGuid(it.getAttribute("id")) == guidNorm
    }

private fun findAnyRootAtRef(threadedDoc: Document, ref: String): Element? =
    elementsByLocalName(threadedDoc, "threadedComment").find { isRootThreadedComment(it) && it.getAttribute("ref") == ref }

private fun findRootsByGuid(threadedDoc: Document, guidNorm: String): List<Element> =
    elementsByLocalName(threadedDoc, "threadedComment").filter { isRootThreadedComment(it) && normalizeGuid(it.getAttribute("id")) == guidNorm }

private class ThreadTarget(val ctx: WorksheetCtx, val cell: String, val rootEl: Element)

// =============================================================================
// Write errors/result — mirrors desktop's `XlsxWriteError`/`XlsxWriteResult`
// (xlsx-comments.ts), used both for the internal archive-mutation helpers
// below AND the public API at the bottom of this file — same convention
// `DocxComments.kt`'s own `DocxWriteResult<T>` already establishes.
// -----------------------------------------------------------------------
//
// 'comment-not-found': a reply/resolve/reopen/move `id` that can't be
//   resolved to a real thread root (hinted lookup AND full-workbook fallback
//   both miss).
// 'ambiguous-comment-id' (design review round 2, F3): the fallback scan found
//   MORE than one root sharing the embedded GUID.
// 'invalid-selector': add's `selector` (or move's `newSelector`) isn't a
//   `Cell` selector, names a malformed cell reference, or omits `sheet` on a
//   workbook with more than one tab.
// 'sheet-not-found': a named `sheet` doesn't exist (or names a chartsheet).
// 'cell-has-note' (§4.1): the target cell already carries a GENUINE Note.
// 'cell-already-has-comment' (§4.2's one-thread-per-cell WRITE policy).
// 'destination-cell-occupied': move's destination already carries its OWN
//   thread.
// 'ambiguous-comment-wiring': the target worksheet's legacy/threaded wiring
//   is a partial or inconsistent combination no real writer produces.
// 'comment-scan-too-large' (review F3): the fallback scan's own aggregate
//   byte budget was exhausted before a match was found.
// =============================================================================

enum class XlsxWriteError(val wire: String) {
    INVALID_XLSX("invalid-xlsx"),
    ARCHIVE_TOO_LARGE("archive-too-large"),
    TOO_MANY_COMMENTS("too-many-comments"),
    UNSAFE_XML("unsafe-xml"),
    COMMENT_NOT_FOUND("comment-not-found"),
    AMBIGUOUS_COMMENT_ID("ambiguous-comment-id"),
    INVALID_SELECTOR("invalid-selector"),
    SHEET_NOT_FOUND("sheet-not-found"),
    CELL_HAS_NOTE("cell-has-note"),
    CELL_ALREADY_HAS_COMMENT("cell-already-has-comment"),
    DESTINATION_CELL_OCCUPIED("destination-cell-occupied"),
    AMBIGUOUS_COMMENT_WIRING("ambiguous-comment-wiring"),
    COMMENT_SCAN_TOO_LARGE("comment-scan-too-large"),
    READ_FAILED("read-failed"),
    BACKUP_FAILED("backup-failed"),
    WRITE_FAILED("write-failed"),
    VERIFY_FAILED("verify-failed"),
    FILE_OPEN_ELSEWHERE("file-open-elsewhere"),
}

sealed class XlsxWriteResult<out T> {
    data class Ok<T>(val value: T) : XlsxWriteResult<T>()
    data class Err(val error: XlsxWriteError) : XlsxWriteResult<Nothing>()
}

/** §4.2's corrected id-resolution algorithm (design review 1, F1; ambiguity
 *  refusal design review round 2, F3): (1) open the HINTED worksheet and
 *  match the embedded GUID against a root at the hinted `ref`; (2) on a miss,
 *  fall back to a full-workbook scan for a root whose `id` matches; (3)
 *  refuse `COMMENT_NOT_FOUND` only if NEITHER finds it, or
 *  `AMBIGUOUS_COMMENT_ID` if the fallback scan finds more than one. */
private fun resolveXlsxThreadTarget(archive: WriteArchive, id: String): XlsxWriteResult<ThreadTarget> {
    val parsed = parseXlsxThreadId(id) ?: return XlsxWriteResult.Err(XlsxWriteError.COMMENT_NOT_FOUND)
    val guidNorm = normalizeGuid(parsed.guid)

    val hintedSheet = archive.sheets.find { it.sheetId == parsed.sheetId && !it.isChartsheet }
    if (hintedSheet != null) {
        when (val r = getWorksheetContext(archive, hintedSheet)) {
            is XlsxWriteResult.Err -> {
                if (r.error == XlsxWriteError.ARCHIVE_TOO_LARGE) return r
                // A missing worksheet part falls through to the fallback
                // scan below — the hint is only ever a locate-first shortcut.
            }
            is XlsxWriteResult.Ok -> {
                val ctx = r.value
                if (ctx.ambiguous) return XlsxWriteResult.Err(XlsxWriteError.AMBIGUOUS_COMMENT_WIRING)
                val td = ctx.threadedDoc
                if (td != null) {
                    val hit = findRootByRefAndGuid(td, parsed.cell, guidNorm)
                    if (hit != null) return XlsxWriteResult.Ok(ThreadTarget(ctx, parsed.cell, hit))
                }
            }
        }
    }

    val matches = mutableListOf<ThreadTarget>()
    var sawAmbiguousSheet = false
    var scanBudgetExceeded = false
    for (sheetMeta in archive.sheets) {
        if (sheetMeta.isChartsheet) continue
        if (!archive.worksheetContexts.containsKey(sheetMeta.partPath) && archive.parsedBytesTotal > MAX_FALLBACK_SCAN_BYTES) {
            scanBudgetExceeded = true
            continue
        }
        val r = getWorksheetContext(archive, sheetMeta)
        if (r is XlsxWriteResult.Err) {
            if (r.error == XlsxWriteError.ARCHIVE_TOO_LARGE) return r
            continue
        }
        val ctx = (r as XlsxWriteResult.Ok).value
        if (ctx.ambiguous) {
            sawAmbiguousSheet = true
            continue
        }
        val td = ctx.threadedDoc ?: continue
        for (rootEl in findRootsByGuid(td, guidNorm)) {
            matches.add(ThreadTarget(ctx, rootEl.getAttribute("ref"), rootEl))
        }
    }
    if (matches.isEmpty()) {
        if (sawAmbiguousSheet) return XlsxWriteResult.Err(XlsxWriteError.AMBIGUOUS_COMMENT_WIRING)
        if (scanBudgetExceeded) return XlsxWriteResult.Err(XlsxWriteError.COMMENT_SCAN_TOO_LARGE)
        return XlsxWriteResult.Err(XlsxWriteError.COMMENT_NOT_FOUND)
    }
    if (matches.size > 1) return XlsxWriteResult.Err(XlsxWriteError.AMBIGUOUS_COMMENT_ID)
    return XlsxWriteResult.Ok(matches[0])
}

/** §4.2's rule: `sheet` is required only when the workbook has more than one
 *  (non-chartsheet) tab. Reused by both add's `selector` and move's
 *  `newSelector`. */
private fun resolveWorksheetForSelector(archive: WriteArchive, sel: CellSelector): XlsxWriteResult<WorksheetCtx> {
    if (!isValidCellAddress(sel.cell)) return XlsxWriteResult.Err(XlsxWriteError.INVALID_SELECTOR)
    val realSheets = archive.sheets.filter { !it.isChartsheet }
    val sheetMeta = if (sel.sheet != null) {
        realSheets.find { it.name == sel.sheet } ?: return XlsxWriteResult.Err(XlsxWriteError.SHEET_NOT_FOUND)
    } else {
        if (realSheets.size != 1) return XlsxWriteResult.Err(XlsxWriteError.INVALID_SELECTOR)
        realSheets[0]
    }
    return when (val r = getWorksheetContext(archive, sheetMeta)) {
        is XlsxWriteResult.Err -> r
        is XlsxWriteResult.Ok -> if (r.value.ambiguous) XlsxWriteResult.Err(XlsxWriteError.AMBIGUOUS_COMMENT_WIRING) else r
    }
}

/** Loads (or returns the already-loaded, cached-by-partPath) context for one
 *  worksheet: its own XML, its own rels, and — if wiring is unambiguous —
 *  the comments/VML/threadedComment parts it already points at. `ambiguous`
 *  is set when the legacy trio is a partial/inconsistent combination, OR a
 *  threadedComment relationship exists with no matching part, OR a threaded
 *  part exists without its accompanying legacy pair (a shape no real
 *  Excel/Google-Sheets writer produces) — refused rather than guessed at. */
private fun getWorksheetContext(archive: WriteArchive, sheetMeta: SheetMeta): XlsxWriteResult<WorksheetCtx> {
    archive.worksheetContexts[sheetMeta.partPath]?.let { return XlsxWriteResult.Ok(it) }

    // Review F1: lazy, per-part reads via `readAndTrackPart` — the ONLY
    // parts this call decompresses are the ones a mutation actually needs to
    // resolve THIS worksheet's own wiring, never the rest of the archive.
    val worksheetXmlOriginal = readAndTrackPart(archive, sheetMeta.partPath) ?: return XlsxWriteResult.Err(XlsxWriteError.INVALID_SELECTOR)
    val worksheetDoc = parseXml(worksheetXmlOriginal)

    val relsPartPath = worksheetRelsPathFor(sheetMeta.partPath)
    val relsXmlOriginal = readAndTrackPart(archive, relsPartPath)
    val relsDoc = parseXml(relsXmlOriginal ?: EMPTY_RELS_XML)

    val legacyDrawingEl = elementsByTag(worksheetDoc, "legacyDrawing").firstOrNull()
    val relationshipEls = elementsByTag(relsDoc, "Relationship")
    val commentsRel = relationshipEls.find { it.getAttribute("Type") == COMMENTS_REL_TYPE }
    val vmlRel = relationshipEls.find { it.getAttribute("Type") == VML_REL_TYPE }
    val threadedRel = relationshipEls.find { it.getAttribute("Type") == THREADED_COMMENT_REL_TYPE }

    var ambiguous = false
    var commentsPartPath: String? = null
    var vmlPartPath: String? = null
    var commentsDoc: Document? = null
    var vmlDoc: Document? = null
    var commentsXmlOriginal: String? = null
    var vmlXmlOriginal: String? = null
    var legacyExisting = false

    if (legacyDrawingEl != null || commentsRel != null || vmlRel != null) {
        if (legacyDrawingEl != null && commentsRel != null && vmlRel != null &&
            legacyDrawingEl.getAttribute("r:id") == vmlRel.getAttribute("Id")
        ) {
            val worksheetDir = dirnameOfPart(sheetMeta.partPath)
            val cPath = resolveRelTarget(worksheetDir, commentsRel.getAttribute("Target"))
            val vPath = resolveRelTarget(worksheetDir, vmlRel.getAttribute("Target"))
            val cXml = readAndTrackPart(archive, cPath)
            val vXml = readAndTrackPart(archive, vPath)
            if (cXml == null || vXml == null) {
                ambiguous = true
            } else {
                commentsPartPath = cPath
                vmlPartPath = vPath
                commentsXmlOriginal = cXml
                vmlXmlOriginal = vXml
                commentsDoc = parseXml(commentsXmlOriginal)
                vmlDoc = parseXml(vmlXmlOriginal)
                legacyExisting = true
            }
        } else {
            ambiguous = true
        }
    }

    var threadedPartPath: String? = null
    var threadedDoc: Document? = null
    var threadedXmlOriginal: String? = null
    var threadedExisting = false
    if (threadedRel != null) {
        val tPath = resolveRelTarget(dirnameOfPart(sheetMeta.partPath), threadedRel.getAttribute("Target"))
        val tXml = readAndTrackPart(archive, tPath)
        if (tXml == null) {
            ambiguous = true
        } else {
            threadedPartPath = tPath
            threadedXmlOriginal = tXml
            threadedDoc = parseXml(threadedXmlOriginal)
            threadedExisting = true
        }
    }
    // §4.2: a threaded part is never observed without its accompanying legacy
    // pair in any real sample — treat that as ambiguous rather than silently
    // reconstructing a legacy pair that never existed.
    if (threadedExisting && !legacyExisting) ambiguous = true

    val ctx = WorksheetCtx(
        partPath = sheetMeta.partPath,
        sheetId = sheetMeta.sheetId,
        sheetName = sheetMeta.name,
        worksheetDoc = worksheetDoc,
        worksheetXmlOriginal = worksheetXmlOriginal,
        relsPartPath = relsPartPath,
        relsDoc = relsDoc,
        relsXmlOriginal = relsXmlOriginal,
        ambiguous = ambiguous,
        commentsPartPath = commentsPartPath,
        commentsDoc = commentsDoc,
        commentsXmlOriginal = commentsXmlOriginal,
        vmlPartPath = vmlPartPath,
        vmlDoc = vmlDoc,
        vmlXmlOriginal = vmlXmlOriginal,
        threadedPartPath = threadedPartPath,
        threadedDoc = threadedDoc,
        threadedXmlOriginal = threadedXmlOriginal,
    )
    // Review F3: charge this FRESH parse's own byte cost against the
    // archive's running total, bounding the fallback scan's aggregate parse
    // cost (a cache hit above never reaches here).
    archive.parsedBytesTotal += worksheetXmlOriginal.length.toLong() + (relsXmlOriginal?.length?.toLong() ?: 0L) +
        (commentsXmlOriginal?.length?.toLong() ?: 0L) + (vmlXmlOriginal?.length?.toLong() ?: 0L) +
        (threadedXmlOriginal?.length?.toLong() ?: 0L)
    archive.worksheetContexts[sheetMeta.partPath] = ctx
    return XlsxWriteResult.Ok(ctx)
}

/** Removes a thread's root+replies from `ctx.threadedDoc`, its ONE legacy
 *  `<comment>` from `ctx.commentsDoc`, and its `<v:shape>` from `ctx.vmlDoc`
 *  (matched by `<x:Row>`/`<x:Column>`) — used only by Move, to vacate the OLD
 *  `[sheet, cell]` pair. */
private fun removeThreadFromWorksheet(ctx: WorksheetCtx, cell: String, rootEl: Element) {
    val rootId = rootEl.getAttribute("id")
    for (reply in repliesOfRoot(ctx.threadedDoc!!, rootId)) {
        reply.parentNode?.removeChild(reply)
    }
    rootEl.parentNode?.removeChild(rootEl)
    ctx.threadedChanged = true

    val commentEl = ctx.commentsDoc?.let { findTcComment(it, rootId) }
    if (commentEl != null) {
        commentEl.parentNode?.removeChild(commentEl)
        ctx.commentsChanged = true
    }
    val (col, row) = parseCellRef(cell) ?: return
    val zeroRow = (row - 1).toString()
    val zeroCol = (col - 1).toString()
    ctx.vmlDoc?.let { vmlDoc ->
        for (shape in elementsByTag(vmlDoc, "v:shape")) {
            val clientData = elementsByTag(shape, "x:ClientData").firstOrNull() ?: continue
            val rowEl = elementsByTag(clientData, "x:Row").firstOrNull()
            val colEl = elementsByTag(clientData, "x:Column").firstOrNull()
            if (rowEl?.textContent == zeroRow && colEl?.textContent == zeroCol) {
                shape.parentNode?.removeChild(shape)
                ctx.vmlChanged = true
                break
            }
        }
    }
}

// -----------------------------------------------------------------------
// Edit/delete build (2026-09-28, design doc §"Edit and delete"): anyone's
// comment/reply can be edited or deleted, no "edited" marker is ever stored
// or shown, and deleting a THREAD's first comment deletes the whole thread
// — decisions.json (doc-comments.edit-delete.questions.answers.json).
// Mirrors xlsx-comments.ts's own "Edit/delete build" section field-for-field.
// -----------------------------------------------------------------------

/** Shared across every reply-id convention this feature mints — see
 *  `DocxComments.kt`'s own copy of this helper for the full reasoning (kept
 *  as a small per-module, file-private duplicate rather than shared: neither
 *  module otherwise depends on the other, and the shape is one line).
 *  Mirrors `replyOrdinalFromId` (xlsx-comments.ts). */
private fun replyOrdinalFromId(replyId: String): Int? = Regex("-r(\\d+)$").find(replyId)?.groupValues?.get(1)?.toIntOrNull()

/** Overwrites a `<threadedComment>` element's OWN `<text>` child in place —
 *  `ref`/`dT`/`personId`/`id`/`parentId`/`done` all stay untouched, so "keep
 *  author/date" (equally true here: `personId`+`dT` are this format's
 *  author/date) holds simply by never touching them. Mirrors
 *  `setThreadedCommentText` (xlsx-comments.ts). */
private fun setThreadedCommentText(doc: Document, el: Element, text: String) {
    val existing = elementsByLocalName(el, "text").firstOrNull()
    if (existing != null) {
        existing.textContent = text
        return
    }
    val prefix = detectPrefix(doc)
    val textEl = doc.createElement(tcTag(prefix, "text"))
    textEl.textContent = text
    el.appendChild(textEl)
}

/** The legacy placeholder is REBUILT WHOLE from the thread's current full
 *  transcript after ANY edit or delete, never patched — the same rule
 *  `mutateReplyToXlsxComment` already follows for a new reply, reused here
 *  so edit/delete can never leave root/reply text out of sync with the
 *  placeholder a legacy Excel reader still shows. Mirrors
 *  `rebuildPlaceholderForRoot` (xlsx-comments.ts). */
private fun rebuildPlaceholderForRoot(ctx: WorksheetCtx, rootEl: Element) {
    val commentsDoc = ctx.commentsDoc ?: return
    val threadedDoc = ctx.threadedDoc ?: return
    val rootId = rootEl.getAttribute("id")
    val commentEl = findTcComment(commentsDoc, rootId) ?: return
    val repliesSorted = repliesOfRoot(threadedDoc, rootId).sortedBy { parseThreadedDate(it.getAttribute("dT")) }
    val body = buildPlaceholderBody(textOfThreadedComment(rootEl), repliesSorted.map { textOfThreadedComment(it) })
    setXlsxCommentBody(commentsDoc, commentEl, body)
    ctx.commentsChanged = true
}

/** §4.2's own `providerId="YouCoded"`/`displayName`-reuse person entries,
 *  looked up the same way `readXlsxCommentsFromZip` builds its own person
 *  map — duplicated narrowly here since edit-reply is the only write path
 *  that needs a reply's AUTHOR back out (every other write already knows the
 *  author it's writing; this one only ever changes text). Mirrors
 *  `personDisplayName` (xlsx-comments.ts). */
private fun personDisplayName(archive: WriteArchive, personIdBraced: String): String {
    val doc = archive.personsDoc ?: return "Unknown"
    val target = normalizeGuid(personIdBraced)
    for (el in elementsByLocalName(doc, "person")) {
        if (normalizeGuid(el.getAttribute("id")) == target) {
            return el.getAttribute("displayName").ifEmpty { "Unknown" }
        }
    }
    return "Unknown"
}

/** Task brief: "if that was the sheet's last comment, remove the now-empty
 *  parts, their rels, content-type overrides and the `<legacyDrawing>`,
 *  leaving the workbook exactly as if it never had comments on that sheet."
 *  Never built for Move (which always re-inserts the thread elsewhere, so a
 *  worksheet it vacates is never checked for this) — genuinely new for
 *  Delete. "No comments left" means neither a threaded comment NOR a legacy
 *  `<comment>` of ANY kind remains — a genuine Note on this same worksheet
 *  (§4.1, never touched by this module) keeps the parts alive. Mirrors
 *  `cleanupEmptyCommentPartsIfNeeded` (xlsx-comments.ts); see
 *  `WriteArchive.removedPartNames`'s own doc comment for how a genuine
 *  removal is represented on this read-only-`ZipFile` platform. */
private fun cleanupEmptyCommentPartsIfNeeded(archive: WriteArchive, ctx: WorksheetCtx) {
    val threadedDoc = ctx.threadedDoc ?: return
    val commentsDoc = ctx.commentsDoc ?: return
    if (ctx.vmlDoc == null) return
    val anyThreaded = elementsByLocalName(threadedDoc, "threadedComment").isNotEmpty()
    val anyLegacyComment = elementsByTag(commentsDoc, "comment").isNotEmpty()
    if (anyThreaded || anyLegacyComment) return

    ctx.commentsPartPath?.let { archive.removedPartNames.add(it) }
    ctx.vmlPartPath?.let { archive.removedPartNames.add(it) }
    ctx.threadedPartPath?.let { archive.removedPartNames.add(it) }

    for (el in elementsByTag(ctx.relsDoc, "Relationship")) {
        val type = el.getAttribute("Type")
        if (type == COMMENTS_REL_TYPE || type == VML_REL_TYPE || type == THREADED_COMMENT_REL_TYPE) {
            el.parentNode?.removeChild(el)
        }
    }
    ctx.relsChanged = true

    // The shared `vml` Default extension entry in [Content_Types].xml is left
    // alone — it may still be needed by another worksheet's own vmlDrawing
    // part; only the two per-worksheet Overrides this sheet minted are removed.
    for (el in elementsByTag(archive.contentTypesDoc, "Override")) {
        val name = el.getAttribute("PartName")
        if (name == "/${ctx.commentsPartPath}" || name == "/${ctx.threadedPartPath}") {
            el.parentNode?.removeChild(el)
        }
    }
    archive.contentTypesChanged = true

    val legacyDrawingEl = elementsByTag(ctx.worksheetDoc, "legacyDrawing").firstOrNull()
    legacyDrawingEl?.parentNode?.removeChild(legacyDrawingEl)
    ctx.worksheetChanged = true

    // Nulled so `serializeArchiveToFile`'s own `ctx.commentsDoc != null &&
    // commentsPath != null`-shaped gates never try to write a part this
    // function just removed outright.
    ctx.commentsPartPath = null
    ctx.vmlPartPath = null
    ctx.threadedPartPath = null
    ctx.commentsDoc = null
    ctx.vmlDoc = null
    ctx.threadedDoc = null
}

private class ThreadSnapshotReply(val id: String, val personId: String, val dT: String, val text: String)
private class ThreadSnapshot(val id: String, val personId: String, val dT: String, val done: Boolean, val text: String, val replies: List<ThreadSnapshotReply>)

private fun snapshotThread(ctx: WorksheetCtx, rootEl: Element): ThreadSnapshot {
    val rootId = rootEl.getAttribute("id")
    val replies = repliesOfRoot(ctx.threadedDoc!!, rootId)
        .sortedBy { parseThreadedDate(it.getAttribute("dT")) }
        .map { ThreadSnapshotReply(it.getAttribute("id"), it.getAttribute("personId"), it.getAttribute("dT"), textOfThreadedComment(it)) }
    return ThreadSnapshot(
        id = rootId,
        personId = rootEl.getAttribute("personId"),
        dT = rootEl.getAttribute("dT"),
        done = rootEl.getAttribute("done") == "1",
        text = textOfThreadedComment(rootEl),
        replies = replies,
    )
}

/** Appends a `<threadedComment>` element (root or reply) matching the target
 *  document's own namespace-prefix convention (§4.2's load-bearing finding —
 *  a brand-new part always uses the default-namespace convention). */
private fun appendThreadedElement(
    threadedDoc: Document,
    ref: String,
    dT: String,
    personId: String,
    id: String,
    text: String,
    parentId: String? = null,
    done: Boolean = false,
) {
    val prefix = detectPrefix(threadedDoc)
    val el = threadedDoc.createElement(tcTag(prefix, "threadedComment"))
    el.setAttribute("ref", ref)
    el.setAttribute("dT", dT)
    el.setAttribute("personId", personId)
    el.setAttribute("id", id)
    if (parentId != null) el.setAttribute("parentId", parentId)
    if (done) el.setAttribute("done", "1")
    val textEl = threadedDoc.createElement(tcTag(prefix, "text"))
    textEl.textContent = text
    el.appendChild(textEl)
    threadedDoc.documentElement.appendChild(el)
}

/** Re-runs `ensureThreadedWiring`, appends `snapshot`'s root+replies verbatim
 *  (SAME ids/personIds/timestamps/text/done state — "never minting fresh
 *  GUIDs on a move"), the matching legacy placeholder, and a fresh
 *  `<v:shape>`. Used by both Add (a snapshot with no replies) and Move. */
private fun insertThreadIntoWorksheet(archive: WriteArchive, ctx: WorksheetCtx, cell: String, snapshot: ThreadSnapshot) {
    ensureThreadedWiring(archive, ctx)

    appendThreadedElement(ctx.threadedDoc!!, cell, snapshot.dT, snapshot.personId, snapshot.id, snapshot.text, done = snapshot.done)
    ctx.threadedChanged = true
    for (reply in snapshot.replies) {
        appendThreadedElement(ctx.threadedDoc!!, cell, reply.dT, reply.personId, reply.id, reply.text, parentId = snapshot.id)
    }

    val authorIdx = resolveOrAppendTcAuthor(ctx.commentsDoc!!, snapshot.id)
    val body = buildPlaceholderBody(snapshot.text, snapshot.replies.map { it.text })
    appendPlaceholderComment(ctx.commentsDoc!!, cell, authorIdx, snapshot.id, body)
    ctx.commentsChanged = true

    val (col, row) = parseCellRef(cell)!!
    val shape = buildThreadedVmlShape(ctx.vmlDoc!!, nextVmlShapeId(ctx.vmlDoc!!), col, row)
    ctx.vmlDoc!!.documentElement.appendChild(shape)
    ctx.vmlChanged = true
}

// -----------------------------------------------------------------------
// Archive load/serialize for a WRITE.
// -----------------------------------------------------------------------

/** Loads the FIXED top-level trio plus `persons.xml` (if present) off an
 *  ALREADY-OPEN `zip` (owned and closed by the caller, `loadMutateSerializeXlsx`
 *  — kept open across load+mutate+serialize so `serializeArchiveToFile` can
 *  still reach every OTHER entry directly for streaming, see that function's
 *  own header). Whole-archive size-guarded before anything is read
 *  (`checkAllEntriesWithinCeiling`, metadata-only, matching this module's own
 *  read-path convention). Review F1 (High, android-xlsx-review): this no
 *  longer eagerly decompresses EVERY entry into a byte map — only these few
 *  named top-level parts, via `readAndTrackPart`. Worksheet-scoped parts stay
 *  exactly as lazy as they already were (`getWorksheetContext`, unchanged by
 *  this fix). */
private fun loadArchiveForWrite(zip: ZipFile): XlsxWriteResult<WriteArchive> {
    return try {
        if (checkAllEntriesWithinCeiling(zip) is ZipSizeGuardResult.ArchiveTooLarge) {
            return XlsxWriteResult.Err(XlsxWriteError.ARCHIVE_TOO_LARGE)
        }
        if (zip.getEntry("xl/workbook.xml") == null || zip.getEntry("[Content_Types].xml") == null) {
            return XlsxWriteResult.Err(XlsxWriteError.INVALID_XLSX)
        }

        val originalBytesByName = mutableMapOf<String, ByteArray>()
        val workbookXml = readAndTrackPart(zip, "xl/workbook.xml", originalBytesByName) ?: return XlsxWriteResult.Err(XlsxWriteError.INVALID_XLSX)
        val contentTypesXml = readAndTrackPart(zip, "[Content_Types].xml", originalBytesByName) ?: return XlsxWriteResult.Err(XlsxWriteError.INVALID_XLSX)
        val workbookRelsXml = readAndTrackPart(zip, "xl/_rels/workbook.xml.rels", originalBytesByName) ?: EMPTY_RELS_XML

        val sheets = parseSheetsFromWorkbook(workbookXml, workbookRelsXml)
        val workbookRelsDoc = parseXml(workbookRelsXml)
        val contentTypesDoc = parseXml(contentTypesXml)

        var personsPartPath = "xl/persons/person.xml"
        var personsDoc: Document? = null
        var personsOriginal: String? = null
        val personRel = elementsByTag(workbookRelsDoc, "Relationship").find { it.getAttribute("Type") == PERSON_REL_TYPE }
        if (personRel != null) {
            personsPartPath = resolveRelTarget("xl", personRel.getAttribute("Target"))
            personsOriginal = readAndTrackPart(zip, personsPartPath, originalBytesByName)
            if (personsOriginal != null) personsDoc = parseXml(personsOriginal)
        }

        XlsxWriteResult.Ok(
            WriteArchive(
                zip = zip,
                originalBytesByName = originalBytesByName,
                sheets = sheets,
                contentTypesDoc = contentTypesDoc,
                contentTypesOriginal = contentTypesXml,
                workbookRelsDoc = workbookRelsDoc,
                workbookRelsOriginal = workbookRelsXml,
                personsPartPath = personsPartPath,
                personsDoc = personsDoc,
                personsOriginal = personsOriginal,
            ),
        )
    } catch (_: XlsxUnsafeXmlDoctypeException) {
        XlsxWriteResult.Err(XlsxWriteError.UNSAFE_XML)
    } catch (_: ZipBombDetectedException) {
        XlsxWriteResult.Err(XlsxWriteError.ARCHIVE_TOO_LARGE)
    }
}

// Same ceiling `DocCommentsZipSizeGuard.kt`'s own `readEntryBounded` uses,
// duplicated here (not exported from that file) so a STREAMED copy of an
// untouched, still-compressed entry gets the identical real-byte-counted
// zip-bomb backstop a fully-buffered `readEntryBounded` call already gives
// every part this module actually parses — kept in sync by convention, the
// same "not enforced at compile time, but named" precedent that file's own
// header already accepts for the desktop/Android 200MB constant.
private const val MAX_STREAMED_ENTRY_BYTES = 200L * 1024 * 1024
private const val STREAM_COPY_BUFFER_BYTES = 8192

/** Review F1 (High, android-xlsx-review) fix: streams ONE untouched zip entry
 *  straight from `sourceZip` to `zos`, in bounded chunks, NEVER buffering its
 *  whole decompressed content in one array — the replacement for the old
 *  `WriteArchive.entries` map, which used to `readEntryBounded` (fully
 *  decompress into a `ByteArray`) EVERY entry in the archive regardless of
 *  whether the mutation ever touched it, then re-deflate every one of them
 *  again on the way out.
 *
 *  A `STORED` entry (already uncompressed — no expansion possible, and its
 *  declared size already passed `checkAllEntriesWithinCeiling`) is passed
 *  through as RAW bytes with its OWN size/crc preserved exactly — "raw
 *  compressed bytes where java.util.zip allows" (a `STORED` entry's
 *  "compressed" form IS its raw content, so no inflate/deflate work happens
 *  at all). Anything else (`DEFLATED`, the overwhelming majority of real
 *  entries) has no public `java.util.zip` API to copy its compressed byte
 *  range verbatim (confirmed against the JDK's own public surface — desktop's
 *  JSZip-based byte-for-byte passthrough has no Kotlin/JDK equivalent), so it
 *  is decompressed and re-compressed at the output stream's own default
 *  level — but STREAMED through one small fixed buffer, never held in memory
 *  as a whole `ByteArray`, with the SAME real-byte-counted zip-bomb backstop
 *  `readEntryBounded` gives every part this module actually parses. */
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
            // STORED can never expand past its own already-checked declared
            // size — only a DEFLATED-or-other entry needs this backstop.
            if (!isStored && total > MAX_STREAMED_ENTRY_BYTES) throw ZipBombDetectedException()
            zos.write(buffer, 0, n)
        }
    }
    zos.closeEntry()
}

/** Writes `archive` to `outFile` (a scratch path). Every part this operation
 *  actually CHANGED (or minted fresh) is (re-)serialized into a small local
 *  `overrides` map; every part it merely TOUCHED but left unchanged is
 *  re-emitted from `archive.originalBytesByName` verbatim; every OTHER entry
 *  in `archive.zip` — genuinely untouched by this call — is streamed straight
 *  through via `streamCopyUntouchedEntry`, never decompressed into a
 *  `ByteArray` here. Review F1 (High): this is the fix — the prior version of
 *  this function iterated a `LinkedHashMap` that ALREADY held every entry's
 *  full decompressed bytes, which is what actually did the "at most six parts
 *  touched" guarantee this file's own doc comments claimed but did not
 *  deliver at the compressed-byte level. */
private fun serializeArchiveToFile(archive: WriteArchive, outFile: File) {
    val overrides = mutableMapOf<String, ByteArray>()
    if (archive.contentTypesChanged) {
        overrides["[Content_Types].xml"] = serializeXlsxPart(archive.contentTypesDoc, archive.contentTypesOriginal).toByteArray(Charsets.UTF_8)
    }
    if (archive.workbookRelsChanged) {
        overrides["xl/_rels/workbook.xml.rels"] = serializeXlsxPart(archive.workbookRelsDoc, archive.workbookRelsOriginal).toByteArray(Charsets.UTF_8)
    }
    if (archive.personsChanged && archive.personsDoc != null) {
        overrides[archive.personsPartPath] = serializeXlsxPart(archive.personsDoc!!, archive.personsOriginal).toByteArray(Charsets.UTF_8)
    }
    for (ctx in archive.worksheetContexts.values) {
        if (ctx.worksheetChanged) {
            overrides[ctx.partPath] = serializeXlsxPart(ctx.worksheetDoc, ctx.worksheetXmlOriginal).toByteArray(Charsets.UTF_8)
        }
        if (ctx.relsChanged) {
            overrides[ctx.relsPartPath] = serializeXlsxPart(ctx.relsDoc, ctx.relsXmlOriginal).toByteArray(Charsets.UTF_8)
        }
        val commentsPath = ctx.commentsPartPath
        if (ctx.commentsChanged && ctx.commentsDoc != null && commentsPath != null) {
            overrides[commentsPath] = serializeXlsxPart(ctx.commentsDoc!!, ctx.commentsXmlOriginal).toByteArray(Charsets.UTF_8)
        }
        val vmlPath = ctx.vmlPartPath
        if (ctx.vmlChanged && ctx.vmlDoc != null && vmlPath != null) {
            overrides[vmlPath] = serializeXlsxPart(ctx.vmlDoc!!, ctx.vmlXmlOriginal).toByteArray(Charsets.UTF_8)
        }
        val threadedPath = ctx.threadedPartPath
        if (ctx.threadedChanged && ctx.threadedDoc != null && threadedPath != null) {
            overrides[threadedPath] = serializeXlsxPart(ctx.threadedDoc!!, ctx.threadedXmlOriginal).toByteArray(Charsets.UTF_8)
        }
    }

    ZipOutputStream(BufferedOutputStream(FileOutputStream(outFile))).use { zos ->
        val writtenNames = mutableSetOf<String>()
        for (entry in Collections.list(archive.zip.entries())) {
            if (entry.isDirectory) continue
            val name = entry.name
            // Edit/delete build: a part `cleanupEmptyCommentPartsIfNeeded`
            // removed outright is skipped here entirely — never re-emitted
            // from `overrides` or the original archive, the Kotlin-side
            // equivalent of desktop's `zip.remove(path)`.
            if (name in archive.removedPartNames) continue
            writtenNames.add(name)
            val overrideBytes = overrides[name]
            when {
                overrideBytes != null -> zos.writeXlsxEntry(name, overrideBytes)
                archive.originalBytesByName.containsKey(name) -> zos.writeXlsxEntry(name, archive.originalBytesByName.getValue(name))
                else -> streamCopyUntouchedEntry(archive.zip, entry, zos)
            }
        }
        for ((name, bytes) in overrides) {
            if (name !in writtenNames && name !in archive.removedPartNames) zos.writeXlsxEntry(name, bytes) // a brand-new part
        }
    }
}

/** Glues the generic file-in/file-out pipeline (`writeXlsxMutation`) to the
 *  archive-based mutations: opens `workCopy` as a `ZipFile` ONCE and keeps it
 *  open across load, mutate, AND serialize (`finally { zip.close() }`) — the
 *  structural change review F1 needed, since `serializeArchiveToFile` must be
 *  able to stream-copy an untouched entry straight from the SAME open source
 *  archive `loadArchiveForWrite`/`getWorksheetContext` read the touched parts
 *  from. A `ZipBombDetectedException`/`XlsxUnsafeXmlDoctypeException` thrown
 *  during serialize (the streamed backstop firing on an untouched entry, or a
 *  DOCTYPE surfacing in a part this call newly decompresses) is RE-THROWN
 *  past this function's own generic `WRITE_FAILED` catch, the same
 *  "never swallow a typed signal into a wrong wire code" idiom this file
 *  already uses elsewhere — `writeXlsxMutation`'s own outer catch is what
 *  turns those into the correctly-typed `UNSAFE_XML`/`ARCHIVE_TOO_LARGE`. */
private fun <T> loadMutateSerializeXlsx(workCopy: File, outFile: File, mutateArchive: (WriteArchive) -> XlsxWriteResult<T>): XlsxWriteResult<T> {
    val zip = try {
        ZipFile(workCopy)
    } catch (_: Exception) {
        return XlsxWriteResult.Err(XlsxWriteError.INVALID_XLSX)
    }
    return try {
        val loaded = loadArchiveForWrite(zip)
        if (loaded is XlsxWriteResult.Err) return loaded
        val archive = (loaded as XlsxWriteResult.Ok).value
        val mutated = mutateArchive(archive)
        if (mutated is XlsxWriteResult.Err) return mutated
        val value = (mutated as XlsxWriteResult.Ok).value
        try {
            serializeArchiveToFile(archive, outFile)
            XlsxWriteResult.Ok(value)
        } catch (e: XlsxUnsafeXmlDoctypeException) {
            throw e
        } catch (e: ZipBombDetectedException) {
            throw e
        } catch (_: Exception) {
            XlsxWriteResult.Err(XlsxWriteError.WRITE_FAILED)
        }
    } finally {
        zip.close()
    }
}

// -----------------------------------------------------------------------
// Pure, in-memory mutations against an already-loaded archive.
// -----------------------------------------------------------------------

private fun mutateAddXlsxComment(archive: WriteArchive, selector: CommentSelector, text: String, author: CommentAuthor): XlsxWriteResult<String> {
    if (selector !is CommentSelector.Cell) return XlsxWriteResult.Err(XlsxWriteError.INVALID_SELECTOR)
    val safeText = stripIllegalXmlChars(text)
    val wsResult = resolveWorksheetForSelector(archive, selector.selector)
    if (wsResult is XlsxWriteResult.Err) return wsResult
    val ctx = (wsResult as XlsxWriteResult.Ok).value
    val cellAddr = selector.selector.cell

    val threadedDoc = ctx.threadedDoc
    if (threadedDoc != null && findAnyRootAtRef(threadedDoc, cellAddr) != null) {
        return XlsxWriteResult.Err(XlsxWriteError.CELL_ALREADY_HAS_COMMENT)
    }
    val commentsDoc = ctx.commentsDoc
    if (commentsDoc != null && findGenuineNoteAtCell(commentsDoc, cellAddr)) {
        return XlsxWriteResult.Err(XlsxWriteError.CELL_HAS_NOTE)
    }

    val personId = resolveOrCreatePerson(archive, author)
    val snapshot = ThreadSnapshot(
        id = mintGuid(),
        personId = personId,
        dT = formatThreadedDate(Date()),
        done = false,
        text = safeText,
        replies = emptyList(),
    )
    insertThreadIntoWorksheet(archive, ctx, cellAddr, snapshot)
    return XlsxWriteResult.Ok(buildXlsxThreadId(ctx.sheetId, cellAddr, snapshot.id))
}

/** Enriches the response with the persisted `CommentReply` — a reply's own id
 *  can't be pre-computed by the caller the way a brand-new comment's can
 *  (§1.6), the same reasoning `DocxComments.kt`'s own `mutateReplyToComment`
 *  already acts on. */
private fun mutateReplyToXlsxComment(archive: WriteArchive, id: String, text: String, author: CommentAuthor): XlsxWriteResult<CommentReply> {
    val safeText = stripIllegalXmlChars(text)
    val found = resolveXlsxThreadTarget(archive, id)
    if (found is XlsxWriteResult.Err) return found
    val target = (found as XlsxWriteResult.Ok).value
    val ctx = target.ctx
    val rootEl = target.rootEl
    val rootId = rootEl.getAttribute("id")
    val ref = rootEl.getAttribute("ref").ifEmpty { target.cell }
    val personId = resolveOrCreatePerson(archive, author)
    val replyId = mintGuid()
    val createdAtIso = formatThreadedDate(Date())
    appendThreadedElement(ctx.threadedDoc!!, ref, createdAtIso, personId, replyId, safeText, parentId = rootId)
    ctx.threadedChanged = true

    val repliesSorted = repliesOfRoot(ctx.threadedDoc!!, rootId).sortedBy { parseThreadedDate(it.getAttribute("dT")) }
    val ordinal = repliesSorted.indexOfFirst { normalizeGuid(it.getAttribute("id")) == normalizeGuid(replyId) } + 1
    val replyTexts = repliesSorted.map { textOfThreadedComment(it) }

    val commentEl = ctx.commentsDoc?.let { findTcComment(it, rootId) }
    if (commentEl != null && ctx.commentsDoc != null) {
        setXlsxCommentBody(ctx.commentsDoc!!, commentEl, buildPlaceholderBody(textOfThreadedComment(rootEl), replyTexts))
        ctx.commentsChanged = true
    }

    val reply = CommentReply(
        id = "${buildXlsxThreadId(ctx.sheetId, ref, rootId)}-r$ordinal",
        author = author,
        text = safeText,
        createdAt = parseThreadedDate(createdAtIso),
    )
    return XlsxWriteResult.Ok(reply)
}

/** §4.2: `done` lives ONLY on the root element, and this app OMITS the
 *  attribute entirely on reopen (never writes `done="0"`) — never touching
 *  the legacy placeholder, which never reflects resolve state at all. */
private fun mutateSetResolvedXlsx(archive: WriteArchive, id: String, done: Boolean): XlsxWriteResult<Unit> {
    val found = resolveXlsxThreadTarget(archive, id)
    if (found is XlsxWriteResult.Err) return found
    val target = (found as XlsxWriteResult.Ok).value
    if (done) target.rootEl.setAttribute("done", "1") else target.rootEl.removeAttribute("done")
    target.ctx.threadedChanged = true
    return XlsxWriteResult.Ok(Unit)
}

private fun mutateMoveXlsxComment(archive: WriteArchive, id: String, newSelector: CommentSelector): XlsxWriteResult<String> {
    if (newSelector !is CommentSelector.Cell) return XlsxWriteResult.Err(XlsxWriteError.INVALID_SELECTOR)
    val found = resolveXlsxThreadTarget(archive, id)
    if (found is XlsxWriteResult.Err) return found
    val target = (found as XlsxWriteResult.Ok).value
    val oldCtx = target.ctx
    val oldCell = target.cell
    // §4.3a: read the OLD cell's thread data VERBATIM before touching
    // anything — reused, never re-minted, at the new location.
    val snapshot = snapshotThread(oldCtx, target.rootEl)

    val wsResult = resolveWorksheetForSelector(archive, newSelector.selector)
    if (wsResult is XlsxWriteResult.Err) return wsResult
    val newCtx = (wsResult as XlsxWriteResult.Ok).value
    val newCell = newSelector.selector.cell

    val isSameCell = newCtx.partPath == oldCtx.partPath && newCell == oldCell
    val newThreadedDoc = newCtx.threadedDoc
    if (!isSameCell && newThreadedDoc != null && findAnyRootAtRef(newThreadedDoc, newCell) != null) {
        return XlsxWriteResult.Err(XlsxWriteError.DESTINATION_CELL_OCCUPIED)
    }
    val newCommentsDoc = newCtx.commentsDoc
    if (!isSameCell && newCommentsDoc != null && findGenuineNoteAtCell(newCommentsDoc, newCell)) {
        return XlsxWriteResult.Err(XlsxWriteError.CELL_HAS_NOTE)
    }

    removeThreadFromWorksheet(oldCtx, oldCell, target.rootEl)
    insertThreadIntoWorksheet(archive, newCtx, newCell, snapshot)

    // Review F3 (Medium) partial fix, ported: a Move never changes the
    // thread's own GUID, but it DOES change the id's embedded cell hint —
    // returning the FRESH id lets a caller skip the fallback scan on its own
    // next call.
    return XlsxWriteResult.Ok(buildXlsxThreadId(newCtx.sheetId, newCell, snapshot.id))
}

/** Edit build (2026-09-28): overwrites the ROOT thread's own `<text>`, then
 *  rebuilds the legacy placeholder from the thread's current transcript
 *  (the placeholder is always rebuilt whole, never patched). Mirrors
 *  `mutateEditXlsxComment` (xlsx-comments.ts). */
private fun mutateEditXlsxComment(archive: WriteArchive, id: String, rawText: String): XlsxWriteResult<String> {
    val text = stripIllegalXmlChars(rawText)
    val found = resolveXlsxThreadTarget(archive, id)
    if (found is XlsxWriteResult.Err) return found
    val target = (found as XlsxWriteResult.Ok).value
    setThreadedCommentText(target.ctx.threadedDoc!!, target.rootEl, text)
    target.ctx.threadedChanged = true
    rebuildPlaceholderForRoot(target.ctx, target.rootEl)
    return XlsxWriteResult.Ok(text)
}

/** Edit build: `id` names the thread's root (matches every other
 *  reply/resolve/reopen/move call shape); `replyId`'s trailing `-r{n}`
 *  (`replyOrdinalFromId`) selects which reply within it, sorted by `dT` the
 *  SAME way the read path assigns ordinals. Mirrors `mutateEditXlsxReply`
 *  (xlsx-comments.ts). */
private fun mutateEditXlsxReply(archive: WriteArchive, id: String, replyId: String, rawText: String): XlsxWriteResult<CommentReply> {
    val text = stripIllegalXmlChars(rawText)
    val ordinal = replyOrdinalFromId(replyId) ?: return XlsxWriteResult.Err(XlsxWriteError.COMMENT_NOT_FOUND)
    val found = resolveXlsxThreadTarget(archive, id)
    if (found is XlsxWriteResult.Err) return found
    val target = (found as XlsxWriteResult.Ok).value
    val ctx = target.ctx
    val rootId = target.rootEl.getAttribute("id")
    val repliesSorted = repliesOfRoot(ctx.threadedDoc!!, rootId).sortedBy { parseThreadedDate(it.getAttribute("dT")) }
    val replyEl = repliesSorted.getOrNull(ordinal - 1) ?: return XlsxWriteResult.Err(XlsxWriteError.COMMENT_NOT_FOUND)
    setThreadedCommentText(ctx.threadedDoc!!, replyEl, text)
    ctx.threadedChanged = true
    rebuildPlaceholderForRoot(ctx, target.rootEl)
    val personId = replyEl.getAttribute("personId")
    val reply = CommentReply(
        id = replyId,
        author = toCommentAuthor(personDisplayName(archive, personId)),
        text = text,
        createdAt = parseThreadedDate(replyEl.getAttribute("dT")),
    )
    return XlsxWriteResult.Ok(reply)
}

/** Delete build: removes the root + every reply, its legacy placeholder and
 *  VML shape (`removeThreadFromWorksheet`, already built for Move), then —
 *  new here — cleans up the worksheet's own now-empty comment parts if this
 *  was its last comment of any kind. Mirrors `mutateDeleteXlsxComment`
 *  (xlsx-comments.ts). */
private fun mutateDeleteXlsxComment(archive: WriteArchive, id: String): XlsxWriteResult<Unit> {
    val found = resolveXlsxThreadTarget(archive, id)
    if (found is XlsxWriteResult.Err) return found
    val target = (found as XlsxWriteResult.Ok).value
    removeThreadFromWorksheet(target.ctx, target.cell, target.rootEl)
    cleanupEmptyCommentPartsIfNeeded(archive, target.ctx)
    return XlsxWriteResult.Ok(Unit)
}

/** Delete build: removes ONE reply and rebuilds the placeholder from what's
 *  left — never touches the root, other replies, or the VML shape/legacy
 *  `<comment>`'s own existence (the thread itself still has its root).
 *  Mirrors `mutateDeleteXlsxReply` (xlsx-comments.ts). */
private fun mutateDeleteXlsxReply(archive: WriteArchive, id: String, replyId: String): XlsxWriteResult<Unit> {
    val ordinal = replyOrdinalFromId(replyId) ?: return XlsxWriteResult.Err(XlsxWriteError.COMMENT_NOT_FOUND)
    val found = resolveXlsxThreadTarget(archive, id)
    if (found is XlsxWriteResult.Err) return found
    val target = (found as XlsxWriteResult.Ok).value
    val ctx = target.ctx
    val rootId = target.rootEl.getAttribute("id")
    val repliesSorted = repliesOfRoot(ctx.threadedDoc!!, rootId).sortedBy { parseThreadedDate(it.getAttribute("dT")) }
    val replyEl = repliesSorted.getOrNull(ordinal - 1) ?: return XlsxWriteResult.Err(XlsxWriteError.COMMENT_NOT_FOUND)
    replyEl.parentNode?.removeChild(replyEl)
    ctx.threadedChanged = true
    rebuildPlaceholderForRoot(ctx, target.rootEl)
    return XlsxWriteResult.Ok(Unit)
}

private fun findByThreadIdPrefix(comments: List<PersistedComment>, id: String): PersistedComment? {
    val parsed = parseXlsxThreadId(id) ?: return null
    val guidNorm = normalizeGuid(parsed.guid)
    return comments.find {
        val p = parseXlsxThreadId(it.id)
        p != null && normalizeGuid(p.guid) == guidNorm
    }
}

// -----------------------------------------------------------------------
// The write pipeline: lock, scratch-copy, mutate, verify-then-replace,
// backup, atomic move — mirrors `DocxComments.kt`'s own `writeDocxMutation`
// exactly (this module's own §4.3/§4.3a "mirror §3.3's steps" instruction).
// -----------------------------------------------------------------------

private val xlsxWriteLocks = ConcurrentHashMap<String, Mutex>()
private fun xlsxLockFor(absolutePath: String): Mutex = xlsxWriteLocks.computeIfAbsent(absolutePath) { Mutex() }

const val XLSX_BACKUP_SUFFIX = ".xlsx.bak"

/** Same rolling-backup-per-file convention as `DocxComments.kt`'s own
 *  `docxBackupPathFor` — a hash of the SOURCE file's absolute path, never a
 *  timestamp, so repeated writes to the same file overwrite the previous
 *  backup rather than accumulating one per write forever. */
fun xlsxBackupPathFor(homeDir: File, absolutePath: String): File {
    val hash = sha256Hex(absolutePath)
    val dir = File(File(homeDir, ".claude"), "youcoded-doc-backups")
    return File(dir, "$hash$XLSX_BACKUP_SUFFIX")
}

private fun defaultXlsxFsyncFile(file: File) {
    FileChannel.open(file.toPath(), StandardOpenOption.READ, StandardOpenOption.WRITE).use { it.force(true) }
}

private fun bestEffortFsyncXlsxDir(dir: File) {
    try {
        FileChannel.open(dir.toPath(), StandardOpenOption.READ).use { it.force(true) }
    } catch (_: Exception) {
        // Not fatal — see DocxComments.kt's identical comment.
    }
}

/**
 * The generic half of the pipeline — `mutate`/`verify` operate on FILES,
 * never a pre-parsed archive, the same shape `DocxComments.kt`'s own
 * `writeDocxMutation` uses (and, not coincidentally, so a test can inject a
 * fault the same simple way). `internal` (not `private`): a pinning test for
 * "failed verification leaves the target byte-identical" calls this
 * directly. Step 0 (design §3.3/§4.3, review round 3 F4) reuses
 * `DocxComments.kt`'s own `isFileOpenElsewhere` — the SAME plain
 * sibling-file check, `internal` in that file and therefore visible here
 * (same module/package) — rather than a second copy.
 */
internal suspend fun <T> writeXlsxMutation(
    absolutePath: String,
    homeDir: File,
    mutate: (workCopy: File, outFile: File) -> XlsxWriteResult<T>,
    verify: (outFile: File, value: T, originalFile: File) -> Boolean,
    syncFile: (File) -> Unit = ::defaultXlsxFsyncFile,
): XlsxWriteResult<T> {
    return xlsxLockFor(absolutePath).withLock {
        val target = File(absolutePath)
        // Step 0 — the VERY FIRST thing this pipeline does, before backup.
        if (isFileOpenElsewhere(target)) return@withLock XlsxWriteResult.Err(XlsxWriteError.FILE_OPEN_ELSEWHERE)
        if (!target.exists()) return@withLock XlsxWriteResult.Err(XlsxWriteError.READ_FAILED)
        val parentDir = target.parentFile ?: return@withLock XlsxWriteResult.Err(XlsxWriteError.READ_FAILED)
        val workCopy = File(parentDir, "${target.name}.ycdreadxlsx.tmp")
        val outFile = File(parentDir, "${target.name}.ycdwritexlsx.tmp")
        try {
            try {
                target.copyTo(workCopy, overwrite = true)
            } catch (_: Exception) {
                return@withLock XlsxWriteResult.Err(XlsxWriteError.READ_FAILED)
            }

            // A corrupt-but-openable part (an unexpected DOCTYPE, or a
            // zip-bomb caught only mid-parse rather than at the archive-wide
            // pre-scan) can throw past `mutate`'s own internal try/catch
            // boundaries — those exceptions are typed and specific to this
            // module (`XlsxUnsafeXmlDoctypeException`/`ZipBombDetectedException`),
            // so they're caught HERE, at the one place this pipeline actually
            // returns a typed `XlsxWriteResult`, mirroring the boundary
            // `DocCommentsDispatch.kt`'s own `nativeMutateExceptionBoundary`
            // already applies one layer further out for anything else.
            val mutated = try {
                mutate(workCopy, outFile)
            } catch (_: XlsxUnsafeXmlDoctypeException) {
                XlsxWriteResult.Err(XlsxWriteError.UNSAFE_XML)
            } catch (_: ZipBombDetectedException) {
                XlsxWriteResult.Err(XlsxWriteError.ARCHIVE_TOO_LARGE)
            }
            if (mutated is XlsxWriteResult.Err) return@withLock mutated
            val value = (mutated as XlsxWriteResult.Ok).value

            // Verify-by-reread BEFORE the real target is ever touched.
            val verified = try { verify(outFile, value, target) } catch (_: Exception) { false }
            if (!verified) return@withLock XlsxWriteResult.Err(XlsxWriteError.VERIFY_FAILED)

            try {
                syncFile(outFile)
            } catch (_: Exception) {
                return@withLock XlsxWriteResult.Err(XlsxWriteError.WRITE_FAILED)
            }

            val backupFile = xlsxBackupPathFor(homeDir, absolutePath)
            try {
                backupFile.parentFile?.mkdirs()
                target.copyTo(backupFile, overwrite = true)
            } catch (_: Exception) {
                return@withLock XlsxWriteResult.Err(XlsxWriteError.BACKUP_FAILED)
            }

            try {
                try {
                    Files.move(outFile.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
                } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
                    Files.move(outFile.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
                }
            } catch (_: Exception) {
                return@withLock XlsxWriteResult.Err(XlsxWriteError.WRITE_FAILED)
            }
            bestEffortFsyncXlsxDir(parentDir)
            XlsxWriteResult.Ok(value)
        } finally {
            workCopy.delete()
            outFile.delete()
        }
    }
}

// -----------------------------------------------------------------------
// Read (T18).
// -----------------------------------------------------------------------

private fun readZipEntryText(zip: ZipFile, name: String): String? {
    val entry = zip.getEntry(name) ?: return null
    return readEntryBounded(zip, entry).toString(Charsets.UTF_8)
}

/**
 * Reads every Excel THREADED comment out of an `.xlsx` file on disk into
 * `PersistedComment`-shaped thread records — the SAME shape desktop's
 * `readXlsxComments` (T12) produces, field-for-field, per this task's own
 * golden-fixture parity test. `path` is stamped onto every returned record.
 *
 * A workbook with ONLY genuine Notes (no threaded comments at all) returns
 * an EMPTY list — never the garbled pseudo-comment the retired reader
 * produced for this exact shape (§4.1). Never throws on "nothing to read."
 */
fun readXlsxComments(file: File, path: String): XlsxReadResult {
    val zip: ZipFile
    try {
        zip = ZipFile(file)
    } catch (_: Exception) {
        return XlsxReadResult.Err(XlsxReadError.INVALID_XLSX)
    }
    return try {
        zip.use { z -> readXlsxCommentsFromZip(z, path) }
    } catch (_: XlsxUnsafeXmlDoctypeException) {
        XlsxReadResult.Err(XlsxReadError.UNSAFE_XML)
    } catch (_: ZipBombDetectedException) {
        XlsxReadResult.Err(XlsxReadError.ARCHIVE_TOO_LARGE)
    }
}

private fun readXlsxCommentsFromZip(z: ZipFile, path: String): XlsxReadResult {
    // Checked FIRST, before any entry is decompressed — see
    // DocCommentsZipSizeGuard.kt's own header for why this module uses a
    // whole-archive pre-scan rather than desktop's narrower named-parts
    // check (an xlsx's part set/count varies per workbook).
    if (checkAllEntriesWithinCeiling(z) is ZipSizeGuardResult.ArchiveTooLarge) {
        return XlsxReadResult.Err(XlsxReadError.ARCHIVE_TOO_LARGE)
    }

    val workbookXml = readZipEntryText(z, "xl/workbook.xml") ?: return XlsxReadResult.Err(XlsxReadError.INVALID_XLSX)
    val workbookRelsXml = readZipEntryText(z, "xl/_rels/workbook.xml.rels") ?: EMPTY_RELS_XML

    val sheets = try {
        parseSheetsFromWorkbook(workbookXml, workbookRelsXml)
    } catch (e: XlsxUnsafeXmlDoctypeException) {
        throw e
    } catch (_: Exception) {
        return XlsxReadResult.Err(XlsxReadError.INVALID_XLSX)
    }
    val realSheets = sheets.filter { !it.isChartsheet }
    val singleSheet = realSheets.size <= 1

    // Person map, resolved once at workbook level (§4.2).
    val personMap = HashMap<String, String>()
    val workbookRelsDoc = try {
        parseXml(workbookRelsXml)
    } catch (e: XlsxUnsafeXmlDoctypeException) {
        throw e
    } catch (_: Exception) {
        null
    }
    val personRel = workbookRelsDoc?.let { doc -> elementsByTag(doc, "Relationship").find { it.getAttribute("Type") == PERSON_REL_TYPE } }
    if (personRel != null) {
        val personPath = resolveRelTarget("xl", personRel.getAttribute("Target"))
        val personXml = readZipEntryText(z, personPath)
        if (personXml != null) {
            val personDoc = try {
                parseXml(personXml)
            } catch (e: XlsxUnsafeXmlDoctypeException) {
                throw e
            } catch (_: Exception) {
                null
            }
            if (personDoc != null) {
                for (el in elementsByLocalName(personDoc, "person")) {
                    val id = el.getAttribute("id")
                    if (id.isNotEmpty()) personMap[normalizeGuid(id)] = el.getAttribute("displayName")
                }
            }
        }
    }

    var totalRecords = 0
    val comments = mutableListOf<PersistedComment>()

    for (sheetMeta in realSheets) {
        val relsPath = worksheetRelsPathFor(sheetMeta.partPath)
        val relsXml = readZipEntryText(z, relsPath) ?: continue
        val relsDoc = try {
            parseXml(relsXml)
        } catch (e: XlsxUnsafeXmlDoctypeException) {
            throw e
        } catch (_: Exception) {
            continue
        }
        val threadedRel = elementsByTag(relsDoc, "Relationship").find { it.getAttribute("Type") == THREADED_COMMENT_REL_TYPE } ?: continue
        val threadedPath = resolveRelTarget(dirnameOfPart(sheetMeta.partPath), threadedRel.getAttribute("Target"))
        val threadedXml = readZipEntryText(z, threadedPath) ?: continue // dangling relationship — skip this sheet

        val threadedDoc = try {
            parseXml(threadedXml)
        } catch (e: XlsxUnsafeXmlDoctypeException) {
            throw e
        } catch (_: Exception) {
            continue
        }
        val all = elementsByLocalName(threadedDoc, "threadedComment")
        totalRecords += all.size
        if (totalRecords > MAX_COMMENT_RECORDS) return XlsxReadResult.Err(XlsxReadError.TOO_MANY_COMMENTS)

        val repliesByRoot = HashMap<String, MutableList<Element>>()
        val roots = mutableListOf<Element>()
        for (el in all) {
            val parentId = el.getAttribute("parentId")
            if (parentId.isNotEmpty()) {
                repliesByRoot.getOrPut(normalizeGuid(parentId)) { mutableListOf() }.add(el)
            } else {
                roots.add(el)
            }
        }

        for (rootEl in roots) {
            val rootId = rootEl.getAttribute("id")
            val ref = rootEl.getAttribute("ref")
            val personId = rootEl.getAttribute("personId")
            val dT = rootEl.getAttribute("dT")
            val resolved = rootEl.getAttribute("done") == "1"
            val text = textOfThreadedComment(rootEl)
            val replyEls = (repliesByRoot[normalizeGuid(rootId)] ?: emptyList()).sortedBy { parseThreadedDate(it.getAttribute("dT")) }

            val appId = buildXlsxThreadId(sheetMeta.sheetId, ref, rootId)
            val replies = replyEls.mapIndexed { i, r ->
                CommentReply(
                    id = "$appId-r${i + 1}",
                    author = toCommentAuthor(personMap[normalizeGuid(r.getAttribute("personId"))] ?: "Unknown"),
                    text = textOfThreadedComment(r),
                    createdAt = parseThreadedDate(r.getAttribute("dT")),
                )
            }

            val cellSelector = CellSelector(cell = ref, sheet = if (singleSheet) null else sheetMeta.name)
            comments.add(
                PersistedComment(
                    id = appId,
                    path = path,
                    selector = CommentSelector.Cell(cellSelector),
                    text = text,
                    author = toCommentAuthor(personMap[normalizeGuid(personId)] ?: "Unknown"),
                    createdAt = parseThreadedDate(dT),
                    replies = replies,
                    resolved = resolved,
                    // A threaded comment's OOXML has no separate resolve/reopen
                    // AUDIT TRAIL — only the current `done` bit.
                    history = emptyList(),
                ),
            )
        }
    }

    return XlsxReadResult.Ok(comments)
}

// -----------------------------------------------------------------------
// Public write API (T19) — one per operation, each wiring its own mutate +
// verify into `writeXlsxMutation`. `absolutePath` is the already-
// containment-verified real file path (`DocCommentsDispatch.kt` resolves
// it); `path` is the caller's project-relative (or fallback-absolute) path,
// stamped onto `PersistedComment.path` — needed here only to re-run this
// file's own reader during verification.
// -----------------------------------------------------------------------

suspend fun addXlsxComment(
    absolutePath: String,
    path: String,
    selector: CommentSelector,
    text: String,
    author: CommentAuthor,
    homeDir: File,
): XlsxWriteResult<String> = writeXlsxMutation(
    absolutePath,
    homeDir,
    mutate = { workCopy, outFile -> loadMutateSerializeXlsx(workCopy, outFile) { archive -> mutateAddXlsxComment(archive, selector, text, author) } },
    verify = { outFile, newId, _ ->
        val r = readXlsxComments(outFile, path)
        (r as? XlsxReadResult.Ok)?.comments?.any { it.id == newId && it.text == stripIllegalXmlChars(text) && it.replies.isEmpty() } == true
    },
)

suspend fun replyToXlsxComment(
    absolutePath: String,
    path: String,
    id: String,
    text: String,
    author: CommentAuthor,
    homeDir: File,
): XlsxWriteResult<CommentReply> = writeXlsxMutation(
    absolutePath,
    homeDir,
    mutate = { workCopy, outFile -> loadMutateSerializeXlsx(workCopy, outFile) { archive -> mutateReplyToXlsxComment(archive, id, text, author) } },
    verify = { outFile, reply, _ ->
        val r = readXlsxComments(outFile, path)
        val target = (r as? XlsxReadResult.Ok)?.comments?.let { findByThreadIdPrefix(it, id) }
        target?.replies?.any { it.id == reply.id && it.text == reply.text } == true
    },
)

/** `by` accepted for call-site symmetry with the generic `{path, id, by}`
 *  payload but deliberately UNUSED — a threaded comment's resolve/reopen has
 *  no separate audit trail, only the current `done` bit. */
suspend fun resolveXlsxComment(absolutePath: String, path: String, id: String, homeDir: File): XlsxWriteResult<Unit> = writeXlsxMutation(
    absolutePath,
    homeDir,
    mutate = { workCopy, outFile -> loadMutateSerializeXlsx(workCopy, outFile) { archive -> mutateSetResolvedXlsx(archive, id, true) } },
    verify = { outFile, _, _ ->
        val r = readXlsxComments(outFile, path)
        (r as? XlsxReadResult.Ok)?.comments?.let { findByThreadIdPrefix(it, id) }?.resolved == true
    },
)

suspend fun reopenXlsxComment(absolutePath: String, path: String, id: String, homeDir: File): XlsxWriteResult<Unit> = writeXlsxMutation(
    absolutePath,
    homeDir,
    mutate = { workCopy, outFile -> loadMutateSerializeXlsx(workCopy, outFile) { archive -> mutateSetResolvedXlsx(archive, id, false) } },
    verify = { outFile, _, _ ->
        val r = readXlsxComments(outFile, path)
        (r as? XlsxReadResult.Ok)?.comments?.let { findByThreadIdPrefix(it, id) }?.resolved == false
    },
)

/** Returns the moved thread's FRESH id (embedding the new cell) so a caller
 *  that keeps it avoids paying for the full-workbook fallback scan on its
 *  very next call. */
suspend fun moveXlsxComment(
    absolutePath: String,
    path: String,
    id: String,
    newSelector: CommentSelector,
    homeDir: File,
): XlsxWriteResult<String> = writeXlsxMutation(
    absolutePath,
    homeDir,
    mutate = { workCopy, outFile -> loadMutateSerializeXlsx(workCopy, outFile) { archive -> mutateMoveXlsxComment(archive, id, newSelector) } },
    verify = { outFile, newId, _ ->
        if (newSelector !is CommentSelector.Cell) {
            false
        } else {
            val r = readXlsxComments(outFile, path)
            val list = (r as? XlsxReadResult.Ok)?.comments
            val target = list?.let { l -> l.find { it.id == newId } ?: findByThreadIdPrefix(l, id) }
            val sel = target?.selector
            if (sel is CommentSelector.Cell) {
                sel.selector.cell == newSelector.selector.cell && (sel.selector.sheet ?: "") == (newSelector.selector.sheet ?: "")
            } else {
                false
            }
        }
    },
)

// -----------------------------------------------------------------------
// Edit/delete build (2026-09-28, design doc §"Edit and delete"). Same
// write-pipeline/verify shape as every mutation above. Mirrors
// xlsx-comments.ts's own "Edit/delete build" public-orchestration section.
// -----------------------------------------------------------------------

suspend fun editXlsxComment(
    absolutePath: String,
    path: String,
    id: String,
    text: String,
    homeDir: File,
): XlsxWriteResult<String> = writeXlsxMutation(
    absolutePath,
    homeDir,
    mutate = { workCopy, outFile -> loadMutateSerializeXlsx(workCopy, outFile) { archive -> mutateEditXlsxComment(archive, id, text) } },
    verify = { outFile, extraText, _ ->
        val r = readXlsxComments(outFile, path)
        val target = (r as? XlsxReadResult.Ok)?.comments?.let { findByThreadIdPrefix(it, id) }
        target?.text == extraText
    },
)

suspend fun editXlsxReply(
    absolutePath: String,
    path: String,
    id: String,
    replyId: String,
    text: String,
    homeDir: File,
): XlsxWriteResult<CommentReply> = writeXlsxMutation(
    absolutePath,
    homeDir,
    mutate = { workCopy, outFile -> loadMutateSerializeXlsx(workCopy, outFile) { archive -> mutateEditXlsxReply(archive, id, replyId, text) } },
    verify = { outFile, reply, _ ->
        val r = readXlsxComments(outFile, path)
        val target = (r as? XlsxReadResult.Ok)?.comments?.let { findByThreadIdPrefix(it, id) }
        target?.replies?.any { it.id == reply.id && it.text == reply.text } == true
    },
)

suspend fun deleteXlsxComment(absolutePath: String, path: String, id: String, homeDir: File): XlsxWriteResult<Unit> = writeXlsxMutation(
    absolutePath,
    homeDir,
    mutate = { workCopy, outFile -> loadMutateSerializeXlsx(workCopy, outFile) { archive -> mutateDeleteXlsxComment(archive, id) } },
    verify = { outFile, _, _ ->
        val r = readXlsxComments(outFile, path)
        (r as? XlsxReadResult.Ok)?.comments?.let { findByThreadIdPrefix(it, id) } == null
    },
)

suspend fun deleteXlsxReply(
    absolutePath: String,
    path: String,
    id: String,
    replyId: String,
    homeDir: File,
): XlsxWriteResult<Unit> = writeXlsxMutation(
    absolutePath,
    homeDir,
    mutate = { workCopy, outFile -> loadMutateSerializeXlsx(workCopy, outFile) { archive -> mutateDeleteXlsxReply(archive, id, replyId) } },
    verify = { outFile, _, _ ->
        val r = readXlsxComments(outFile, path)
        val target = (r as? XlsxReadResult.Ok)?.comments?.let { findByThreadIdPrefix(it, id) }
        target != null && target.replies.none { it.id == replyId }
    },
)
