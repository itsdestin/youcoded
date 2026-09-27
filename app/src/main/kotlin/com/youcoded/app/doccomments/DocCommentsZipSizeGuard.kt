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

/**
 * Refuses if the SUM of every entry's declared uncompressed size (or any
 * single entry alone) is over the ceiling. Mirrors desktop's
 * `checkTotalWithinCeiling` (zip-size-guard.ts) — used by `XlsxComments.kt`
 * (T18/§4.3a), which — unlike Word's fixed three-named-part read
 * (`checkNamedEntriesWithinCeiling`, above) — has no small fixed set of part
 * names to check ahead of time: an xlsx's worksheet/comments part names and
 * count vary per workbook (§4.3a's own "sheetN.xml"/"commentsN.xml"
 * numbering follows worksheet position, not a fixed count), so the whole
 * archive is pre-scanned before ANY part is parsed. An entry with an unknown
 * declared size (`ZipEntry.getSize() == -1`) contributes `0` to the running
 * total rather than being refused outright, matching desktop's own
 * `declaredUncompressedSize` fallback.
 */
fun checkAllEntriesWithinCeiling(zip: ZipFile): ZipSizeGuardResult {
    var total = 0L
    val entries = zip.entries()
    while (entries.hasMoreElements()) {
        val entry = entries.nextElement()
        if (entry.isDirectory) continue
        val size = if (entry.size >= 0) entry.size else 0L
        if (size > MAX_DECLARED_UNCOMPRESSED_BYTES) return ZipSizeGuardResult.ArchiveTooLarge
        total += size
        if (total > MAX_DECLARED_UNCOMPRESSED_BYTES) return ZipSizeGuardResult.ArchiveTooLarge
    }
    return ZipSizeGuardResult.Ok
}

// =============================================================================
// F3 (implementation review, both docx/xlsx read paths): a decompression-time
// backstop UNDERNEATH the two declared-size checks above.
//
// WHY the checks above are not enough on their own: `checkNamedEntriesWithinCeiling`/
// `checkAllEntriesWithinCeiling` only ever read `ZipEntry.getSize()` — a value
// that comes straight from the archive's own CENTRAL DIRECTORY metadata and is
// never verified against what the entry ACTUALLY decompresses to. A crafted
// entry can declare a small (or, per the `-1` fallback above, effectively
// zero-contributing) uncompressed size while its real DEFLATE stream expands
// far past it — the declared-size checks would wave it straight through, and
// the two readers would then decompress the FULL real size into memory
// regardless. `readEntryBounded` below is the check that doesn't trust
// anything the archive DECLARES: it counts REAL bytes as they come off the
// decompression stream and aborts the moment the running total crosses the
// ceiling, so at most one chunk's worth of bytes beyond the ceiling is ever
// held in memory — never the full oversized output.
// =============================================================================

/** Thrown by `readEntryBounded` when an entry's REAL decompressed byte count
 *  exceeds `ceilingBytes` — a distinct signal from `ZipSizeGuardResult
 *  .ArchiveTooLarge` above (which is a plain return value, not an exception)
 *  only because `readEntryBounded` is called from deep inside each reader's
 *  own parsing pipeline, several stack frames below where the equivalent
 *  `DocxReadResult.Err`/`XlsxReadResult.Err` is actually constructed and
 *  returned — an exception lets it unwind cleanly back to that one place
 *  (each reader's own top-level `try`/`catch`) without every intermediate
 *  call needing its own sealed-result plumbing for a case that should never
 *  happen against a legitimate file. */
class ZipBombDetectedException : Exception()

/** Read-loop chunk size for `readEntryBounded` — large enough to keep the
 *  per-chunk overhead low, small enough that a refusal fires promptly once
 *  the running total crosses the ceiling rather than after one more huge
 *  buffer's worth of needless decompression. */
private const val BOUNDED_READ_CHUNK_BYTES = 8192

/**
 * Reads `entry`'s decompressed bytes from `zip`, counting REAL bytes as they
 * come off the DEFLATE stream and throwing `ZipBombDetectedException` the
 * MOMENT the running total exceeds `ceilingBytes` — see this section's own
 * header for why this exists as a backstop UNDERNEATH
 * `checkNamedEntriesWithinCeiling`/`checkAllEntriesWithinCeiling`, which only
 * ever look at the archive's own declared metadata.
 *
 * `ceilingBytes` defaults to the same `MAX_DECLARED_UNCOMPRESSED_BYTES`
 * ceiling the declared-size checks use above. A caller only ever overrides it
 * in a test — proving the abort fires correctly, well under the real 200MB
 * production ceiling, without a test having to actually allocate/inflate
 * anywhere near that much data itself.
 */
fun readEntryBounded(zip: ZipFile, entry: ZipEntry, ceilingBytes: Long = MAX_DECLARED_UNCOMPRESSED_BYTES): ByteArray {
    zip.getInputStream(entry).use { input ->
        val out = java.io.ByteArrayOutputStream()
        val chunk = ByteArray(BOUNDED_READ_CHUNK_BYTES)
        var total = 0L
        while (true) {
            val n = input.read(chunk)
            if (n == -1) break
            total += n
            if (total > ceilingBytes) throw ZipBombDetectedException()
            out.write(chunk, 0, n)
        }
        return out.toByteArray()
    }
}
