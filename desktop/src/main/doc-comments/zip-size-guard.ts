// Shared decompression-bomb guard for the docx (T10) and xlsx (T12) comment
// readers (docs/active/specs/2026-09-26-doc-comments-build-design.md §3.2,
// §4.3; implementation-review finding F2 — major).
//
// WHY: both readers hand a caller-supplied byte buffer straight to a zip
// library (JSZip for docx, exceljs's own bundled JSZip for xlsx) with no
// check on what that archive CLAIMS its contents will decompress to. A
// crafted archive can declare an enormous uncompressed size for an entry
// while its actual compressed bytes are tiny — the classic "zip bomb" shape
// — and decompressing it would try to allocate however many bytes the
// archive claims, which is exactly the kind of unbounded synchronous/memory
// cost `.claude/rules/performance.md` rule 1 exists to keep out of the main
// process.
//
// HOW: `JSZip.loadAsync()` only parses the zip's LOCAL and CENTRAL DIRECTORY
// headers — it does not decompress any entry's content (that happens lazily,
// only when `.async()` is called on that specific entry). Every entry's
// declared uncompressed size is available immediately after `loadAsync`,
// before any decompression work happens, on JSZipObject's `_data.uncompressedSize`
// field. This field is not part of JSZip's PUBLIC TypeScript surface (its own
// `index.d.ts` comments the `CompressedObject` interface out, "If/when it is
// made public this should be uncommented") but it is real, stable, shipped
// code (`node_modules/jszip/lib/zipEntry.js`'s `readCentralPart` sets exactly
// this field from the zip's central directory, which is what `loadAsync`
// trusts for size — confirmed empirically and by reading that source before
// writing this module). Using a library's own internal-but-stable field where
// its public API has no equivalent is already an accepted pattern in this
// codebase (§4.3, review 3: exceljs's own `cDst._comment = undefined`).
import type JSZip from 'jszip';

/** Conservative ceiling for a single zip entry's DECLARED uncompressed size,
 *  and for the sum across an entire archive. A real Word/Excel comments part
 *  or worksheet XML is measured in kilobytes even for a large document; 200MB
 *  is generously far above any legitimate file this feature will ever see and
 *  comfortably below memory-pressure territory for the main process. This is
 *  a task-time starting number, not a benchmarked one (matching how §4.3a
 *  already describes its own Android size guard: "a starting point to
 *  benchmark against, not a frozen constant") — lower it if a real-world
 *  report calls for it. */
// Not exported: nothing outside this module needs it by name (`knip` flags
// an exported constant nothing imports as dead code — same convention as
// docx-comments.ts's/xlsx-comments.ts's own not-exported error unions).
const MAX_DECLARED_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

export type ZipSizeGuardResult = { ok: true } | { ok: false; error: 'archive-too-large' };

interface JSZipObjectWithInternalSize {
  _data?: { uncompressedSize?: number };
}

function declaredUncompressedSize(file: JSZip.JSZipObject): number {
  const data = (file as unknown as JSZipObjectWithInternalSize)._data;
  return typeof data?.uncompressedSize === 'number' ? data.uncompressedSize : 0;
}

/**
 * Refuses if any NAMED entry (the specific parts a caller is about to
 * `.async()`) declares an uncompressed size over the ceiling. Missing entries
 * are skipped — an absent part (e.g. no `commentsExtended.xml`) is a normal
 * shape (§3.2), not a size concern. Used by docx-comments.ts, which only ever
 * needs three specific parts, never the whole archive.
 */
export function checkNamedEntriesWithinCeiling(zip: JSZip, names: string[]): ZipSizeGuardResult {
  for (const name of names) {
    const file = zip.file(name);
    if (!file) continue;
    if (declaredUncompressedSize(file) > MAX_DECLARED_UNCOMPRESSED_BYTES) {
      return { ok: false, error: 'archive-too-large' };
    }
  }
  return { ok: true };
}

/**
 * Refuses if the SUM of every entry's declared uncompressed size (or any
 * single entry alone) is over the ceiling. Used by xlsx-comments.ts, which
 * pre-scans the whole archive with JSZip before handing the same bytes to
 * exceljs's own loader (§4.3's own instruction: "pre-scan the archive... sum/
 * individual uncompressed sizes... before exceljs load") — exceljs has no
 * hook to check this itself before it starts unzipping.
 */
export function checkTotalWithinCeiling(zip: JSZip): ZipSizeGuardResult {
  let total = 0;
  let oversizedEntry = false;
  zip.forEach((_relativePath, file) => {
    if (file.dir) return;
    const size = declaredUncompressedSize(file);
    if (size > MAX_DECLARED_UNCOMPRESSED_BYTES) oversizedEntry = true;
    total += size;
  });
  if (oversizedEntry || total > MAX_DECLARED_UNCOMPRESSED_BYTES) {
    return { ok: false, error: 'archive-too-large' };
  }
  return { ok: true };
}
