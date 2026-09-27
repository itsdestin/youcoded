// Test-only helper for pinning the decompression-bomb guard
// (DocCommentsZipSizeGuard.kt), Kotlin port of desktop's own test helper
// `desktop/tests/fixtures/doc-comments/oversized-zip.ts` — see that file's
// header for the full reasoning; ported here rather than shared, since the
// two runtimes have no shared test-support module.
//
// Builds a REAL, tiny, valid zip archive and then patches one entry's
// CENTRAL DIRECTORY record to declare a huge uncompressed size — a
// "decompression bomb" shape — without changing its actual (tiny) compressed
// bytes. This never allocates or compresses anything close to the fake
// declared size: only a 4-byte integer field in the archive's own metadata
// is overwritten. `java.util.zip.ZipFile` (like JSZip's `loadAsync`) reads an
// entry's declared uncompressed size from exactly this central-directory
// field, never the local file header's own copy of it, so patching only the
// central directory is sufficient to fool the same central-directory-based
// check `DocCommentsZipSizeGuard` performs.
package com.youcoded.app.doccomments

import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

private const val CENTRAL_DIR_SIGNATURE = 0x02014b50L

private fun readUInt32LE(b: ByteArray, off: Int): Long =
    (b[off].toLong() and 0xFF) or
        ((b[off + 1].toLong() and 0xFF) shl 8) or
        ((b[off + 2].toLong() and 0xFF) shl 16) or
        ((b[off + 3].toLong() and 0xFF) shl 24)

private fun readUInt16LE(b: ByteArray, off: Int): Int =
    (b[off].toInt() and 0xFF) or ((b[off + 1].toInt() and 0xFF) shl 8)

private fun writeUInt32LE(b: ByteArray, off: Int, value: Long) {
    b[off] = (value and 0xFF).toByte()
    b[off + 1] = ((value shr 8) and 0xFF).toByte()
    b[off + 2] = ((value shr 16) and 0xFF).toByte()
    b[off + 3] = ((value shr 24) and 0xFF).toByte()
}

/**
 * Builds a zip containing `files` (name -> text content), then rewrites
 * `targetEntryName`'s declared uncompressed size (in the zip's central
 * directory only) to `fakeUncompressedSize` — a number far larger than the
 * entry's real, tiny content.
 */
fun buildDeclaredOversizeZip(files: Map<String, String>, targetEntryName: String, fakeUncompressedSize: Long): ByteArray {
    val baos = ByteArrayOutputStream()
    ZipOutputStream(baos).use { zos ->
        for ((name, content) in files) {
            zos.putNextEntry(ZipEntry(name))
            zos.write(content.toByteArray(StandardCharsets.UTF_8))
            zos.closeEntry()
        }
    }
    return patchCentralDirectoryUncompressedSize(baos.toByteArray(), targetEntryName, fakeUncompressedSize)
}

private fun patchCentralDirectoryUncompressedSize(buf: ByteArray, targetEntryName: String, fakeSize: Long): ByteArray {
    val patched = buf.copyOf()
    val targetNameBytes = targetEntryName.toByteArray(StandardCharsets.UTF_8)
    var offset = 0
    var found = false

    // Central directory file header layout (APPNOTE.TXT §4.3.12):
    // 0 sig(4) 4 versionMadeBy(2) 6 versionNeeded(2) 8 bitFlag(2)
    // 10 compressionMethod(2) 12 modTime(2) 14 modDate(2) 16 crc32(4)
    // 20 compressedSize(4) 24 uncompressedSize(4) 28 fileNameLength(2)
    // 30 extraFieldLength(2) 32 fileCommentLength(2) ... 46 fileName
    while (offset <= patched.size - 46) {
        if (readUInt32LE(patched, offset) != CENTRAL_DIR_SIGNATURE) {
            offset++
            continue
        }
        val fileNameLength = readUInt16LE(patched, offset + 28)
        val extraFieldLength = readUInt16LE(patched, offset + 30)
        val fileCommentLength = readUInt16LE(patched, offset + 32)
        val nameStart = offset + 46
        val name = patched.copyOfRange(nameStart, nameStart + fileNameLength)
        if (name.contentEquals(targetNameBytes)) {
            writeUInt32LE(patched, offset + 24, fakeSize)
            found = true
        }
        offset = nameStart + fileNameLength + extraFieldLength + fileCommentLength
    }

    check(found) { "buildDeclaredOversizeZip: no central directory entry found for \"$targetEntryName\"" }
    return patched
}
