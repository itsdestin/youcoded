// Test-only helper for pinning implementation-review F2 (the decompression-
// bomb guard, docs/active/specs/2026-09-26-doc-comments-build-design.md
// §3.2/§4.3, `desktop/src/main/doc-comments/zip-size-guard.ts`).
//
// Builds a REAL, tiny, valid zip archive and then patches one entry's
// CENTRAL DIRECTORY record to declare a huge uncompressed size — a
// "decompression bomb" shape — without changing its actual (tiny) compressed
// bytes. This never allocates or compresses anything close to the fake
// declared size: only a 4-byte integer field in the archive's own metadata
// is overwritten. `zip-size-guard.ts`'s own comment confirms (and this file
// relies on) that JSZip's `loadAsync` reads an entry's `uncompressedSize`
// from exactly this central-directory field (`readCentralPart`,
// `node_modules/jszip/lib/zipEntry.js`) — the local file header's own copy
// of the field is never consulted for that value, so patching only the
// central directory is sufficient to fool a caller doing the same central-
// directory-based check this fixture is built to exercise.
import JSZip from 'jszip';

const CENTRAL_DIR_SIGNATURE = 0x02014b50; // 'PK\x01\x02', little-endian

/**
 * Builds a zip containing `files` (name -> text content), then rewrites
 * `targetEntryName`'s declared uncompressed size (in the zip's central
 * directory only) to `fakeUncompressedSize` — a number far larger than the
 * entry's real, tiny content.
 */
export async function buildDeclaredOversizeZip(
  files: Record<string, string>,
  targetEntryName: string,
  fakeUncompressedSize: number,
): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return patchCentralDirectoryUncompressedSize(buf, targetEntryName, fakeUncompressedSize);
}

function patchCentralDirectoryUncompressedSize(buf: Buffer, targetEntryName: string, fakeSize: number): Buffer {
  const patched = Buffer.from(buf);
  const targetNameUtf8 = Buffer.from(targetEntryName, 'utf8');
  let offset = 0;
  let found = false;

  while (offset <= patched.length - 46) {
    if (patched.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) {
      offset++;
      continue;
    }
    // Central directory file header layout (APPNOTE.TXT §4.3.12):
    // 0 sig(4) 4 versionMadeBy(2) 6 versionNeeded(2) 8 bitFlag(2)
    // 10 compressionMethod(2) 12 modTime(2) 14 modDate(2) 16 crc32(4)
    // 20 compressedSize(4) 24 uncompressedSize(4) 28 fileNameLength(2)
    // 30 extraFieldLength(2) 32 fileCommentLength(2) ... 46 fileName
    const fileNameLength = patched.readUInt16LE(offset + 28);
    const extraFieldLength = patched.readUInt16LE(offset + 30);
    const fileCommentLength = patched.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const name = patched.subarray(nameStart, nameStart + fileNameLength);
    if (name.equals(targetNameUtf8)) {
      patched.writeUInt32LE(fakeSize >>> 0, offset + 24);
      found = true;
    }
    offset = nameStart + fileNameLength + extraFieldLength + fileCommentLength;
  }

  if (!found) {
    throw new Error(`buildDeclaredOversizeZip: no central directory entry found for "${targetEntryName}"`);
  }
  return patched;
}
