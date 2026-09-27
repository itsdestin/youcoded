// Excel (.xlsx) comment READING on Android — T18 of the doc-comments build
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §4.3a, §8 T18).
// Kotlin port of desktop's `readXlsxComments`
// (desktop/src/main/doc-comments/xlsx-comments.ts, T12) — read-only; the
// Kotlin WRITER (`XlsxComments.kt`'s add/reply/resolve/reopen/move half) is
// T19's scope, not this file's.
//
// WHY this exists as real Kotlin rather than a WebView/JS reuse: identical
// reasoning to `DocxComments.kt` (§3.2a's own F1-derived conclusion) —
// Android's assistant path (the MCP script, §9) and a backgrounded PTY
// session must be able to read an Excel comment with no WebView attached or
// foregrounded at all.
//
// WHY Kotlin has NO `exceljs`-equivalent library to lean on, unlike docx:
// desktop's own xlsx-comments.ts never constructs or even SEES the legacy
// Note's underlying OOXML wiring itself — `exceljs`'s `cell.note` getter
// does. This module therefore hand-parses the same wiring exceljs's own
// source was read to document — see
// docs/active/investigations/2026-09-27-xlsx-note-format-spike.md (youcoded-
// dev workspace repo) for the full capture-and-cite writeup this parsing
// algorithm is built from, and
// `shared-fixtures/doc-comments/xlsx-note-reference/` for the checked-in
// literal OOXML this task's own spike captured. Read is the LOWER-risk half
// (§4.3a: "Read is the lower-risk half... parsing comments<N>.xml for text");
// this module never touches `vmlDrawing<N>.vml` at all, since a read needs
// only the note TEXT, never the shape's visible position (T19's writer is
// the one that must construct vmlDrawing/rels/content-types wiring from
// scratch).
//
// ALGORITHM (ported field-for-field from xlsx-comments.ts's `readXlsxComments`
// / `stripResolvedMarker` / `splitTurns` / `toCommentAuthor` — see each
// function's own comment for where this hand-rolled OOXML walk differs from
// exceljs's own object model):
//   1. `xl/workbook.xml`'s `<sheets>` list gives sheet order, NAME, and each
//      sheet's own `sheetId` attribute — desktop's `worksheet.id` (embedded in
//      every comment id, `x-${worksheet.id}-${cell}`) comes from EXACTLY this
//      attribute on load (confirmed against exceljs's own
//      `workbook-xform.js`'s `reconcile()` / `sheet-xform.js`'s `parseOpen` —
//      see the spike doc), never from the sheet's POSITION in the list.
//   2. Each `<sheet>`'s `r:id` resolves through `xl/_rels/workbook.xml.rels`
//      to its worksheet PART path (`worksheets/sheetN.xml` -> `xl/worksheets/
//      sheetN.xml`) — never assumed to be `sheetN.xml` by position.
//   3. That worksheet part's OWN rels file (`xl/worksheets/_rels/sheetN.xml
//      .rels`) is searched for the Relationship whose Type ends in
//      `.../relationships/comments` — its Target resolves (relative to
//      `xl/worksheets/`) to the sheet's comments part. A sheet with no notes
//      simply has no such rels file, or no matching relationship — a normal
//      shape, not an error.
//   4. Each `<comment ref="A1" ...>` in that part's `<commentList>` gives the
//      cell address directly; its body text is every `<r><t>` descendant of
//      its `<text>` element, concatenated in document order (a real note
//      CAN be multiple runs — different `<rPr>` per run — even though this
//      app's own writer only ever emits one; concatenating unconditionally
//      handles both).
//   5. §4.1's transcript convention (marker stripping, "Name: text" turn
//      splitting, neutral-author fallback) applies identically to the
//      extracted text — same regexes as desktop, ported verbatim below.
//
// SECURITY: same secure `DocumentBuilderFactory` configuration as
// `DocxComments.kt` (no DOCTYPE, no external entities) — this module is its
// own independent copy rather than a shared helper, the SAME "two write
// modules are deliberately independent" convention desktop's own
// xlsx-comments.ts documents for its relationship to docx-comments.ts.
package com.youcoded.app.doccomments

import org.w3c.dom.Document
import org.w3c.dom.Element
import java.io.File
import java.io.StringReader
import java.util.zip.ZipFile
import javax.xml.parsers.DocumentBuilder
import javax.xml.parsers.DocumentBuilderFactory
import javax.xml.parsers.ParserConfigurationException
import org.xml.sax.InputSource

/** Mirrors desktop's `XlsxReadError` union (xlsx-comments.ts). `UNSAFE_XML`
 *  has no desktop counterpart yet (F1, implementation review, Android-only so
 *  far — see `rejectDoctype`'s own doc comment for why this platform needs a
 *  check desktop's `linkedom`-based parser doesn't). */
enum class XlsxReadError {
    INVALID_XLSX,
    ARCHIVE_TOO_LARGE,
    UNSAFE_XML,
}

sealed class XlsxReadResult {
    data class Ok(val comments: List<PersistedComment>) : XlsxReadResult()
    data class Err(val error: XlsxReadError) : XlsxReadResult()
}

// §4.1's fixed, non-natural-language resolve marker — identical strings to
// `xlsx-comments.ts`'s own `RESOLVED_MARKER`/`LEGACY_RESOLVED_MARKER`. Kept
// as literal escape sequences (not raw Unicode source characters) so the
// zero-width space (U+200B) can never be silently dropped by an editor/tool
// that "cleans up" invisible characters in source files.
private const val RESOLVED_MARKER = "​✓ Resolved"
private const val LEGACY_RESOLVED_MARKER = "​[[yc:resolved]]"

/** Same precise, checkable rule as `xlsx-comments.ts`'s own
 *  `APP_AUTHOR_PREFIX_RE` (implementation-review F5): 1-4 space-separated
 *  Capitalized words followed by ": " is this app's OWN "Name: text"
 *  convention; anything else (no colon, or a colon whose prefix isn't shaped
 *  like a name — lowercase words following the first) keeps the WHOLE
 *  paragraph as the comment's text with a neutral author, never dropped. */
private val APP_AUTHOR_PREFIX_RE = Regex("^([A-Z][A-Za-z'’-]*(?: [A-Z][A-Za-z'’-]*){0,3}):\\s([\\s\\S]*)$")

private fun toCommentAuthor(name: String): CommentAuthor = "person:" + name.ifEmpty { "Unknown" }

/** Mirrors `stripResolvedMarker`: recognized only as the note body's exact
 *  LAST LINE, never a bare trailing-substring match — a real reply that
 *  happens to end with the marker's visible words but no leading ZWSP is
 *  never misread as the marker. Both the current and legacy marker are
 *  recognized (the legacy one is never written again by any writer, but a
 *  file an earlier build already resolved must not silently flip back open
 *  just because the token format changed). */
private fun stripResolvedMarker(rawBody: String): Pair<Boolean, String> {
    val lines = rawBody.split("\n")
    val last = lines.lastOrNull()
    return if (last == RESOLVED_MARKER || last == LEGACY_RESOLVED_MARKER) {
        true to lines.dropLast(1).joinToString("\n")
    } else {
        false to rawBody
    }
}

private class Turn(val author: String, val text: String)

/** Mirrors `splitTurns`: one turn per blank-line-separated paragraph, each
 *  shaped `"Author: text"` per this app's own write convention — a leading
 *  `"Name: "` is read as an author ONLY when it matches
 *  `APP_AUTHOR_PREFIX_RE`; anything else keeps the WHOLE paragraph as text
 *  with a neutral author, never dropped (implementation-review F5). */
private fun splitTurns(body: String): List<Turn> {
    val paragraphs = body.split(Regex("\\n{2,}"))
    return paragraphs
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .map { p ->
            val match = APP_AUTHOR_PREFIX_RE.find(p)
            if (match != null) {
                Turn(match.groupValues[1], match.groupValues[2])
            } else {
                Turn("", p)
            }
        }
}

/** Same secure factory as `DocxComments.kt` — see that file's own header for
 *  the full OWASP/Android-`javax.xml`-surface reasoning. Duplicated rather
 *  than shared: the read/write modules for docx and xlsx are deliberately
 *  independent on desktop too (xlsx-comments.ts's own header comment), and
 *  this Kotlin port follows the same convention. */
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
 *  declaration — refused BEFORE any parser sees it. Same reasoning as
 *  `DocxComments.kt`'s own identical class (F1, implementation review — high,
 *  security): Android's actual on-device `javax.xml.parsers` implementation
 *  is Expat-backed, not the Xerces implementation this module's JVM unit
 *  tests run against, and may not recognize the `disallow-doctype-decl`
 *  feature URI at all — `newSecureDocumentBuilder`'s own `setFeature` loop
 *  silently swallows an unrecognized feature, which would otherwise leave
 *  DOCTYPE-based internal-entity expansion ("billion laughs") reachable on a
 *  real device despite every JVM test passing. A plain case-insensitive
 *  substring scan is platform-independent by construction and never a false
 *  positive (a literal `<` in XML text must be escaped as `&lt;`, so a
 *  literal `<!DOCTYPE` anywhere in the string is always a real markup
 *  declaration). Duplicated rather than shared — same "two read/write modules
 *  are deliberately independent" convention this file's own header already
 *  documents for `newSecureDocumentBuilder`. */
private class XlsxUnsafeXmlDoctypeException : Exception()

private val DOCTYPE_DECLARATION = Regex("(?i)<!DOCTYPE")

private fun rejectDoctype(xml: String) {
    if (DOCTYPE_DECLARATION.containsMatchIn(xml)) throw XlsxUnsafeXmlDoctypeException()
}

private fun parseXml(xml: String): Document {
    rejectDoctype(xml)
    return newSecureDocumentBuilder().parse(InputSource(StringReader(xml)))
}

/** F3 (implementation review): reads via `readEntryBounded`
 *  (DocCommentsZipSizeGuard.kt) rather than a plain `getInputStream().
 *  readBytes()` — counts REAL decompressed bytes as they arrive and throws
 *  `ZipBombDetectedException` the moment they exceed the ceiling, regardless
 *  of what the archive's own declared metadata said. Every call site already
 *  runs inside `readXlsxComments`'s own top-level `try`/`catch` (see that
 *  function), so letting the exception propagate here — rather than catching
 *  it locally — is what turns it into the SAME typed `ARCHIVE_TOO_LARGE`
 *  refusal every other size-guard trip already produces. */
private fun readZipEntryText(zip: ZipFile, name: String): String? {
    val entry = zip.getEntry(name) ?: return null
    return readEntryBounded(zip, entry).toString(Charsets.UTF_8)
}

private fun elementChildrenNamed(el: Element, tagName: String): List<Element> {
    val out = mutableListOf<Element>()
    val nodes = el.childNodes
    for (i in 0 until nodes.length) {
        val n = nodes.item(i)
        if (n is Element && n.tagName == tagName) out.add(n)
    }
    return out
}

private class SheetRef(val sheetId: Int, val name: String, val rId: String)

/** Parses `xl/workbook.xml`'s `<sheets>` list — order, name and `sheetId`
 *  ATTRIBUTE (never list position — spike finding: on load, exceljs's own
 *  `worksheet.id` comes from this attribute, and a foreign file can have a
 *  gap or reordering that makes position and `sheetId` diverge). */
private fun parseWorkbookSheets(xml: String): List<SheetRef> {
    val doc = parseXml(xml)
    val nodes = doc.getElementsByTagName("sheet")
    val out = mutableListOf<SheetRef>()
    for (i in 0 until nodes.length) {
        val el = nodes.item(i) as? Element ?: continue
        if (!el.hasAttribute("sheetId") || !el.hasAttribute("r:id")) continue
        val sheetId = el.getAttribute("sheetId").toIntOrNull() ?: continue
        val name = el.getAttribute("name")
        val rId = el.getAttribute("r:id")
        out.add(SheetRef(sheetId, name, rId))
    }
    return out
}

/** Parses any OOXML `.rels` part into a `{Id -> Relationship}` map (Target +
 *  Type both kept — callers filter by Type where it matters, e.g. finding
 *  the "comments" relationship among a worksheet's several). */
private class RelInfo(val target: String, val type: String)

private fun parseRels(xml: String): Map<String, RelInfo> {
    val doc = parseXml(xml)
    val nodes = doc.getElementsByTagName("Relationship")
    val out = LinkedHashMap<String, RelInfo>()
    for (i in 0 until nodes.length) {
        val el = nodes.item(i) as? Element ?: continue
        val id = if (el.hasAttribute("Id")) el.getAttribute("Id") else continue
        val target = if (el.hasAttribute("Target")) el.getAttribute("Target") else continue
        val type = if (el.hasAttribute("Type")) el.getAttribute("Type") else ""
        out[id] = RelInfo(target, type)
    }
    return out
}

/** Resolves an OPC relative Target against the directory the RELS part's own
 *  subject part lives in (e.g. a worksheet rels file's targets are relative
 *  to `xl/worksheets/`, never to the rels file's own `_rels/` subdirectory) —
 *  handles `../` segments the same way any relative filesystem path would.
 *  Spike-confirmed: `workbook.xml.rels` targets are relative to `xl/`;
 *  `sheetN.xml.rels` targets are relative to `xl/worksheets/`. */
private fun resolveRelativeTarget(baseDir: String, target: String): String {
    if (target.startsWith("/")) return target.trimStart('/')
    val baseParts = if (baseDir.isEmpty()) mutableListOf() else baseDir.split("/").toMutableList()
    for (segment in target.split("/")) {
        when (segment) {
            "..", "." -> if (segment == "..") { if (baseParts.isNotEmpty()) baseParts.removeAt(baseParts.size - 1) }
            else -> baseParts.add(segment)
        }
    }
    return baseParts.joinToString("/")
}

private fun dirOf(path: String): String {
    val idx = path.lastIndexOf('/')
    return if (idx < 0) "" else path.substring(0, idx)
}

private fun baseNameOf(path: String): String {
    val idx = path.lastIndexOf('/')
    return if (idx < 0) path else path.substring(idx + 1)
}

/** Finds the worksheet part's own comments-relationship target, following
 *  its dedicated `_rels/<basename>.rels` sibling — never a `commentsN.xml`
 *  naming guess (spike finding: the numbering tracks worksheet position, and
 *  the ONLY OOXML-correct way to find the part is through the relationship).
 *  Returns `null` when the sheet has no comments at all (the common case). */
private fun findCommentsPartPath(zip: ZipFile, worksheetPartPath: String): String? {
    val worksheetDir = dirOf(worksheetPartPath)
    val relsPath = "$worksheetDir/_rels/${baseNameOf(worksheetPartPath)}.rels"
    val relsXml = readZipEntryText(zip, relsPath) ?: return null
    val rels = parseRels(relsXml)
    val commentsRel = rels.values.find { it.type.endsWith("/relationships/comments") } ?: return null
    return resolveRelativeTarget(worksheetDir, commentsRel.target)
}

private class RawCellComment(val cellRef: String, val row: Int, val col: Int, val rawText: String)

/** `"B18"` -> `(col=2, row=18)`, 1-based to match spreadsheet convention
 *  (matters only for SORTING comments into the same row-then-column order
 *  desktop's `eachRow`/`eachCell` traversal produces — §4.2/T12's own
 *  ordering, which this reader reconstructs by sorting rather than by
 *  simulating a full-sheet cell walk, since every comment's own `ref`
 *  attribute already names its exact address). Returns `null` for a
 *  malformed ref rather than throwing — a comment naming a ref this
 *  malformed is refused into "sorts last", never crashes the whole read. */
private fun parseCellRef(ref: String): Pair<Int, Int>? {
    val m = Regex("^([A-Z]+)([0-9]+)$").find(ref.uppercase()) ?: return null
    val letters = m.groupValues[1]
    val row = m.groupValues[2].toIntOrNull() ?: return null
    var col = 0
    for (ch in letters) col = col * 26 + (ch - 'A' + 1)
    return col to row
}

/** Parses a `comments<N>.xml` part's `<commentList>` into raw
 *  `{ref, text}` pairs, sorted into the SAME row-then-column-ascending order
 *  desktop's `eachRow({includeEmpty:true}).eachCell({includeEmpty:true})`
 *  traversal produces (§4.2) — body text is every `<r><t>` descendant of a
 *  `<comment>`'s own `<text>` element, concatenated in document order (a
 *  note CAN be multiple runs even though this app's own writer only ever
 *  emits one — concatenating unconditionally handles both, spike finding). */
private fun parseCommentsXml(xml: String): List<RawCellComment> {
    val doc = parseXml(xml)
    val commentNodes = doc.getElementsByTagName("comment")
    val out = mutableListOf<RawCellComment>()
    for (i in 0 until commentNodes.length) {
        val el = commentNodes.item(i) as? Element ?: continue
        if (!el.hasAttribute("ref")) continue
        val ref = el.getAttribute("ref")
        val rowCol = parseCellRef(ref) ?: (Int.MAX_VALUE to Int.MAX_VALUE)
        val textEl = elementChildrenNamed(el, "text").firstOrNull()
        val text = StringBuilder()
        if (textEl != null) {
            val tNodes = textEl.getElementsByTagName("t")
            for (j in 0 until tNodes.length) {
                text.append((tNodes.item(j) as Element).textContent ?: "")
            }
        }
        out.add(RawCellComment(ref, rowCol.second, rowCol.first, text.toString()))
    }
    return out.sortedWith(compareBy({ it.row }, { it.col }))
}

/**
 * Reads every legacy cell Note out of an `.xlsx` file on disk into
 * `PersistedComment`-shaped records — the SAME shape T12/desktop's
 * `readXlsxComments` produces (field-for-field, per this task's own golden-
 * fixture parity test). `path` is stamped onto every returned record, same
 * convention as `readDocxComments`.
 *
 * Never throws on "nothing to read" shapes: a workbook with no notes at all
 * returns an EMPTY list, not an error.
 */
fun readXlsxComments(file: File, path: String): XlsxReadResult {
    val zip: ZipFile
    try {
        zip = ZipFile(file)
    } catch (_: Exception) {
        return XlsxReadResult.Err(XlsxReadError.INVALID_XLSX)
    }
    // F1/F3 (implementation review): `rejectDoctype` and `readEntryBounded`
    // (DocCommentsZipSizeGuard.kt) both signal by throwing, since they're
    // reached several calls deep inside `readXlsxCommentsFromZip`'s own
    // pipeline (through `readZipEntryText`/`parseXml`/`parseWorkbookSheets`/
    // `parseRels`/`parseCommentsXml`) — catching both here, in the ONE place
    // this function actually returns an `XlsxReadResult`, keeps every
    // intermediate call from needing its own sealed-result plumbing for a
    // case that should never happen against a legitimate file. See
    // `readXlsxCommentsFromZip`'s own inner `try`/`catch` blocks for why a
    // `DOCTYPE`/zip-bomb signal is deliberately RE-THROWN past them rather
    // than being absorbed into the pre-existing generic `INVALID_XLSX`/
    // `continue` handling those blocks already had.
    return try {
        zip.use { z -> readXlsxCommentsFromZip(z, path) }
    } catch (_: XlsxUnsafeXmlDoctypeException) {
        XlsxReadResult.Err(XlsxReadError.UNSAFE_XML)
    } catch (_: ZipBombDetectedException) {
        XlsxReadResult.Err(XlsxReadError.ARCHIVE_TOO_LARGE)
    }
}

private fun readXlsxCommentsFromZip(z: ZipFile, path: String): XlsxReadResult {
    // F2-equivalent (decompression-bomb guard): checked FIRST, before any
    // entry (including `xl/workbook.xml` itself) is decompressed — unlike
    // docx's fixed three-named-part read, an xlsx's part set/count varies
    // per workbook (§4.3a), so the WHOLE archive is pre-scanned off
    // `ZipEntry.getSize()`'s CENTRAL DIRECTORY metadata (no decompression
    // needed to read it) before `readZipEntryText` ever calls
    // `getInputStream()` on anything, mirroring desktop's own order:
    // `JSZip.loadAsync` (metadata only) then `checkTotalWithinCeiling`
    // then only afterward `workbook.xlsx.load()` (which decompresses).
    // Kept as the fast first line of defense; F3's `readEntryBounded`
    // (used by `readZipEntryText` above) is the backstop underneath it
    // that doesn't trust this declared metadata at all.
    if (checkAllEntriesWithinCeiling(z) is ZipSizeGuardResult.ArchiveTooLarge) {
        return XlsxReadResult.Err(XlsxReadError.ARCHIVE_TOO_LARGE)
    }

    val workbookXml = readZipEntryText(z, "xl/workbook.xml")
        ?: return XlsxReadResult.Err(XlsxReadError.INVALID_XLSX)
    val workbookRelsXml = readZipEntryText(z, "xl/_rels/workbook.xml.rels")
        ?: return XlsxReadResult.Err(XlsxReadError.INVALID_XLSX)

    val sheets = try {
        parseWorkbookSheets(workbookXml)
    } catch (e: XlsxUnsafeXmlDoctypeException) {
        throw e
    } catch (_: Exception) {
        return XlsxReadResult.Err(XlsxReadError.INVALID_XLSX)
    }
    val workbookRels = try {
        parseRels(workbookRelsXml)
    } catch (e: XlsxUnsafeXmlDoctypeException) {
        throw e
    } catch (_: Exception) {
        return XlsxReadResult.Err(XlsxReadError.INVALID_XLSX)
    }

    // §4.2: `sheet` named on the selector only when the workbook has more
    // than one tab that actually resolves to a real WORKSHEET part — a
    // `<sheet>` entry with a dangling rId is skipped (existing behaviour),
    // and — F2, implementation review, parity — so is one whose
    // relationship Type is anything OTHER than
    // `.../relationships/worksheet` (a chartsheet's own Type ends in
    // `/relationships/chartsheet`). Before this Type check, a workbook
    // with exactly one real worksheet plus one chartsheet counted as
    // TWO resolved sheets here, so `singleSheet` came out `false` and the
    // selector stamped a `sheet` name desktop's own reader (exceljs's
    // `reconcile()` — xlsx-comments.ts's own header comment — never
    // surfaces a chartsheet as a worksheet at all) would never stamp for
    // the identical file. Filtering by Type is the OOXML-correct way to
    // tell a worksheet from a chartsheet — never by file extension or
    // target-path guessing, same precedent `findCommentsPartPath` already
    // set for finding the comments relationship itself.
    val resolvedSheets = sheets.mapNotNull { sheet ->
        val rel = workbookRels[sheet.rId] ?: return@mapNotNull null
        if (!rel.type.endsWith("/relationships/worksheet")) return@mapNotNull null
        val worksheetPath = resolveRelativeTarget("xl", rel.target)
        if (z.getEntry(worksheetPath) == null) return@mapNotNull null
        sheet to worksheetPath
    }
    val singleSheet = resolvedSheets.size <= 1

    val comments = mutableListOf<PersistedComment>()
    for ((sheet, worksheetPath) in resolvedSheets) {
        val sheetName = sheet.name
        val commentsPartPath = findCommentsPartPath(z, worksheetPath) ?: continue
        val commentsXml = readZipEntryText(z, commentsPartPath) ?: continue
        val rawComments = try {
            parseCommentsXml(commentsXml)
        } catch (e: XlsxUnsafeXmlDoctypeException) {
            throw e
        } catch (_: Exception) {
            continue
        }

        for (raw in rawComments) {
            val (resolved, body) = stripResolvedMarker(raw.rawText)
            val turns = splitTurns(body)
            if (turns.isEmpty()) continue
            val first = turns[0]
            val rest = turns.drop(1)

            val cellSelector = CellSelector(cell = raw.cellRef, sheet = if (singleSheet) null else sheetName)
            val selector = CommentSelector.Cell(cellSelector)

            val replies = rest.mapIndexed { i, turn ->
                CommentReply(
                    id = "x-${sheet.sheetId}-${raw.cellRef}-r${i + 1}",
                    author = toCommentAuthor(turn.author),
                    text = turn.text,
                    createdAt = System.currentTimeMillis(),
                )
            }

            comments.add(
                PersistedComment(
                    id = "x-${sheet.sheetId}-${raw.cellRef}",
                    path = path,
                    selector = selector,
                    text = first.text,
                    author = toCommentAuthor(first.author),
                    // exceljs's legacy Note carries no timestamp of its
                    // own — never invent one; the read time is the only
                    // honest value available (same reasoning as desktop's
                    // own reader).
                    createdAt = System.currentTimeMillis(),
                    replies = replies,
                    resolved = resolved,
                    history = emptyList(),
                ),
            )
        }
    }

    return XlsxReadResult.Ok(comments)
}
