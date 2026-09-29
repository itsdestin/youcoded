// Android port of the strict namespace check in desktop's
// xml-text-safety.ts (`undeclaredPrefixes`/`introducesUndeclaredPrefix`) and
// write-pipeline.ts (`xmlPartsStayWellFormed`).
//
// WHY (2026-09-28 PR review): both write modules parse with namespace
// awareness OFF, so the DOM happily serializes an element or attribute whose
// prefix was never declared (`<w:p w14:paraId="…">` in a comments.xml with no
// `xmlns:w14`). That is not well-formed XML — Word and Excel refuse or
// "repair" the file — and the verify step re-reads with the same lenient
// parser, so it could not notice. This is the missing strict check, run by
// both pipelines before a new file replaces the original.
package com.youcoded.app.doccomments

import java.io.File
import java.util.zip.ZipFile

// Only markup is scanned (text between tags is skipped), so comment text such
// as "ratio:1=2" can never look like an attribute.
private val TAG_RE = Regex("<[^!?][^>]*>")
private val TAG_NAME_PREFIX_RE = Regex("^</?([A-Za-z_][\\w.-]*):")
private val ATTR_PREFIX_RE = Regex("\\s([A-Za-z_][\\w.-]*):[\\w.-]+\\s*=")
private val DECLARED_PREFIX_RE = Regex("\\sxmlns:([A-Za-z_][\\w.-]*)\\s*=")
private val XML_PART_RE = Regex("\\.(xml|rels|vml)$", RegexOption.IGNORE_CASE)

/** Prefixes `xml` uses on an element or attribute but never declares
 *  (`xml`/`xmlns` excepted). A declaration anywhere in the part counts. */
internal fun undeclaredPrefixes(xml: String): Set<String> {
    val declared = mutableSetOf("xml", "xmlns")
    val used = mutableSetOf<String>()
    for (tag in TAG_RE.findAll(xml)) {
        val t = tag.value
        DECLARED_PREFIX_RE.findAll(t).forEach { declared.add(it.groupValues[1]) }
        TAG_NAME_PREFIX_RE.find(t)?.let { used.add(it.groupValues[1]) }
        ATTR_PREFIX_RE.findAll(t).forEach { used.add(it.groupValues[1]) }
    }
    return used - declared
}

/** True when `after` leaves a prefix undeclared that `before` (the same part
 *  before this write, or `null` for a new part) did not. */
internal fun introducesUndeclaredPrefix(before: String?, after: String): Boolean {
    val already = if (before == null) emptySet() else undeclaredPrefixes(before)
    return undeclaredPrefixes(after).any { it !in already }
}

/** Every XML part `outFile` changed relative to `originalFile` (judged by
 *  checksum and size, so untouched parts are never read) must not newly use
 *  an undeclared prefix. Unreadable archives return `true`: each format's own
 *  verify already refuses those. */
internal fun xmlPartsStayWellFormed(outFile: File, originalFile: File): Boolean {
    return try {
        ZipFile(outFile).use { after ->
            val before = try { ZipFile(originalFile) } catch (_: Exception) { null }
            try {
                val entries = after.entries()
                while (entries.hasMoreElements()) {
                    val entry = entries.nextElement()
                    if (entry.isDirectory || !XML_PART_RE.containsMatchIn(entry.name)) continue
                    val original = before?.getEntry(entry.name)
                    if (original != null && original.crc == entry.crc && original.size == entry.size) continue
                    val afterXml = readEntryBounded(after, entry).toString(Charsets.UTF_8)
                    val beforeXml = original?.let { readEntryBounded(before, it).toString(Charsets.UTF_8) }
                    if (introducesUndeclaredPrefix(beforeXml, afterXml)) return false
                }
                true
            } finally {
                before?.close()
            }
        }
    } catch (_: java.util.zip.ZipException) {
        true
    }
}
