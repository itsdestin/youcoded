// Android port of desktop/src/main/doc-comments/zip-size-guard.ts — the
// decompression-bomb guard T10's own implementation review added (F2 —
// major). §3.2a/§4.3a's own "documented, watched file-size guard for
// Android's load-whole-archive approach" instruction names this file's
// desktop counterpart directly; this is that guard's Kotlin equivalent.
//
// WHY the check is possible cheaply, and BEFORE any entry is decompressed:
// `java.util.zip.ZipFile` parses only the archive's LOCAL and CENTRAL
// DIRECTORY headers when opened — `ZipEntry.getSize()` (the entry's declared
// UNCOMPRESSED size) comes straight from that metadata and is available
// immediately, with no call to `getInputStream()` on that entry (which is
// what actually triggers decompression). This is the exact same trust
// relationship desktop's own comment documents for JSZip's
// `_data.uncompressedSize` — a crafted archive can declare an enormous
// uncompressed size for an entry whose actual compressed bytes are tiny (a
// "zip bomb"), and decompressing it blind would try to allocate however many
// bytes the archive CLAIMS, which is exactly the unbounded-cost class
// `.claude/rules/performance.md` rule 1 (ported to Android via
// `docs/android-runtime.md`'s own main-thread-never-blocks framing) exists to
// keep out.
package com.youcoded.app.doccomments

import java.util.zip.ZipEntry
import java.util.zip.ZipFile

/** Same ceiling as desktop's `MAX_DECLARED_UNCOMPRESSED_BYTES` — a real Word
 *  comments part or document body is kilobytes even for a large document;
 *  200MB is generously above any legitimate file this feature will ever see.
 *  A task-time starting number, not a benchmarked one (§4.3a's own framing) —
 *  lower it if a real-world report calls for it. Kept in sync with desktop's
 *  own constant by convention, not by a shared build artifact (the two
 *  runtimes have no shared code path to enforce this at compile time). */
private const val MAX_DECLARED_UNCOMPRESSED_BYTES: Long = 200L * 1024 * 1024

sealed class ZipSizeGuardResult {
    object Ok : ZipSizeGuardResult()
    /** Mirrors desktop's `'archive-too-large'` error. */
    object ArchiveTooLarge : ZipSizeGuardResult()
}

/**
 * Refuses if any NAMED entry (the specific parts a caller is about to
 * decompress) declares an uncompressed size over the ceiling. A missing
 * entry is skipped — an absent part (e.g. no `commentsExtended.xml`) is a
 * normal shape (§3.2), not a size concern. An entry whose declared size is
 * unknown (`ZipEntry.getSize() == -1`, possible for a STREAMED zip written
 * without a size in its local header — `ZipFile` normally has it from the
 * central directory, but this is defensive) is treated as within-ceiling
 * rather than refused, matching desktop's own `declaredUncompressedSize`
 * falling back to `0` when the internal field is absent.
 */
fun checkNamedEntriesWithinCeiling(zip: ZipFile, names: List<String>): ZipSizeGuardResult {
    for (name in names) {
        val entry: ZipEntry = zip.getEntry(name) ?: continue
        val size = entry.size
        if (size > MAX_DECLARED_UNCOMPRESSED_BYTES) {
            return ZipSizeGuardResult.ArchiveTooLarge
        }
    }
    return ZipSizeGuardResult.Ok
}
