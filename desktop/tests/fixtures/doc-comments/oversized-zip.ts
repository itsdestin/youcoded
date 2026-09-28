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
import { Readable } from 'stream';

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

/** A Node Readable of `totalBytes` zero bytes, generated on demand in small
 *  chunks — building `buildRealZipBomb`'s fixture below never holds the
 *  whole (multi-hundred-MB) uncompressed content in memory at once, only
 *  ever one chunk. */
function zerosStream(totalBytes: number): Readable {
  const CHUNK = 64 * 1024;
  let sent = 0;
  return new Readable({
    read() {
      if (sent >= totalBytes) {
        this.push(null);
        return;
      }
      const n = Math.min(CHUNK, totalBytes - sent);
      this.push(Buffer.alloc(n));
      sent += n;
    },
  });
}

/**
 * Builds a REAL zip bomb: `bombEntryName` genuinely decompresses to
 * `realUncompressedBytes` of zero bytes (DEFLATE compresses that to almost
 * nothing, and `zerosStream` never holds it all in memory at once either),
 * plus any other plain-text `otherFiles`. The bomb entry's DECLARED
 * uncompressed size (central directory only, same mechanism
 * `buildDeclaredOversizeZip` above relies on) is then patched DOWN to a
 * handful of bytes — far SMALLER than its real content — specifically so
 * `checkNamedEntriesWithinCeiling`/`checkTotalWithinCeiling`'s own
 * declared-size-only check would wave it straight through. Without this
 * patch, JSZip's own `generateAsync` would report the entry's TRUE (and
 * therefore already-over-ceiling) size in the declared metadata, and the
 * pre-existing declared-size check alone would already catch it — which
 * would make a test built from this fixture prove nothing new. Used to pin
 * F3 (implementation review): `decompressBounded`'s own byte-counting
 * decompression-time backstop, the ONLY check left standing once the
 * declared size is a lie.
 */
const LOCAL_FILE_SIGNATURE = 0x04034b50; // 'PK\x03\x04', little-endian

/**
 * Builds a real, valid zip containing `files`, then scrambles
 * `targetEntryName`'s own LOCAL FILE compressed data bytes (never the central
 * directory — that stays honest, so any declared-size check still passes) —
 * a genuinely corrupted DEFLATE stream, not a lie about size. Used to pin
 * code review 2026-09-27 (F2): `decompressBounded`'s stream `'error'` event
 * must map to the reading module's own "this archive doesn't look valid"
 * code, never `'archive-too-large'` (which zip-size-guard.test.ts's own fake-
 * stream test already pins at the lower level; this proves the SAME mapping
 * holds through a real JSZip-decompressed entry, not just a mocked stream).
 */
export async function buildCorruptedEntryZip(
  files: Record<string, string>,
  targetEntryName: string,
): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return corruptLocalFileData(buf, targetEntryName);
}

/**
 * Same corruption as `buildCorruptedEntryZip`, applied directly to an
 * already-built (or real, on-disk) archive's bytes — lets a test corrupt one
 * named part of a REAL fixture file (which already has realistic wiring: a
 * persons.xml, a matching workbook, real sheets) rather than hand-assembling
 * a synthetic one from scratch just to exercise this one failure mode.
 */
export function corruptLocalFileData(buf: Buffer, targetEntryName: string): Buffer {
  const patched = Buffer.from(buf);
  const targetNameUtf8 = Buffer.from(targetEntryName, 'utf8');
  let offset = 0;

  while (offset <= patched.length - 30) {
    if (patched.readUInt32LE(offset) !== LOCAL_FILE_SIGNATURE) {
      offset++;
      continue;
    }
    const compressedSize = patched.readUInt32LE(offset + 18);
    const fileNameLength = patched.readUInt16LE(offset + 26);
    const extraFieldLength = patched.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = patched.subarray(nameStart, nameStart + fileNameLength);
    const dataStart = nameStart + fileNameLength + extraFieldLength;
    if (name.equals(targetNameUtf8)) {
      // Flip every byte of the entry's own compressed data — garbage DEFLATE
      // input reliably fails zlib's inflate with a stream error, never a
      // silent wrong-but-parseable result.
      for (let i = 0; i < compressedSize; i++) {
        patched[dataStart + i] = patched[dataStart + i] ^ 0xff;
      }
      return patched;
    }
    offset = dataStart + compressedSize;
  }
  throw new Error(`buildCorruptedEntryZip: no local file entry found for "${targetEntryName}"`);
}

export async function buildRealZipBomb(
  otherFiles: Record<string, string>,
  bombEntryName: string,
  realUncompressedBytes: number,
): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(otherFiles)) zip.file(name, content);
  zip.file(bombEntryName, zerosStream(realUncompressedBytes), { compression: 'DEFLATE' });
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return patchCentralDirectoryUncompressedSize(buf, bombEntryName, 16);
}
