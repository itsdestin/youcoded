// Shared decompression-bomb guard for the docx (T10) and xlsx (T12) comment
// readers (docs/active/specs/2026-09-26-doc-comments-build-design.md §3.2,
// §4.3; implementation-review finding F2 — major).
//
// WHY: both readers hand a caller-supplied byte buffer straight to JSZip
// (xlsx moved off exceljs's own bundled JSZip entirely in the 2026-09-27
// threaded-comments rewrite — §4.1/§4.3) with no check on what that archive
// CLAIMS its contents will decompress to. A
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

// `checkTotalWithinCeiling` (a whole-archive pre-scan) used to live here for
// the old exceljs-based xlsx reader, which handed a black-box loader the
// WHOLE archive with no hook to bound it itself. Removed 2026-09-27 (the
// threaded-comments-only rewrite, §4.3's own "the guard narrows to match"
// finding): exceljs is gone from xlsx-comments.ts entirely, and the new
// hand-rolled reader/writer only ever opens NAMED parts by path — the exact
// shape `checkNamedEntriesWithinCeiling` above already covers, matching
// docx-comments.ts's own model. Kept only in git history, not as a second,
// now-unused code path (knip's own "delete the unused export" rule).

// =============================================================================
// F3 (implementation review, both docx/xlsx READ paths): a decompression-time
// backstop UNDERNEATH the declared-size check above.
//
// WHY the check above is not enough on its own: it only ever reads
// `declaredUncompressedSize`, a value this module's own header already
// documents as coming from JSZip's internal-but-stable `_data.uncompressedSize`
// field — itself sourced from the archive's own CENTRAL DIRECTORY metadata,
// never verified against what an entry ACTUALLY decompresses to (and falling
// back to `0` when absent — see `declaredUncompressedSize` above). A crafted
// entry can declare a small (or absent) uncompressed size while its real
// DEFLATE stream expands far past it; the declared-size check would wave it
// straight through, and `.async('string')` would then decompress the FULL
// real size into memory regardless. `decompressBounded` below is the check
// that doesn't trust anything the archive DECLARES: it consumes the entry's
// own internal stream (`nodeStream` — real bytes, not the reported metadata),
// counting them AS THEY ARRIVE and aborting the stream the moment the running
// total crosses the ceiling, so at most one chunk's worth of bytes beyond the
// ceiling is ever held in memory — never the full oversized output.
// =============================================================================

export type DecompressionGuardResult = { ok: true; text: string } | { ok: false; error: 'archive-too-large' };

/**
 * Decompresses `file` (a JSZip entry already resolved via `zip.file(name)`)
 * to a UTF-8 string, counting REAL decompressed bytes as they come off its own
 * `nodeStream` and resolving `{ ok: false, error: 'archive-too-large' }` the
 * MOMENT the running total exceeds `ceilingBytes` — never `.async('string')`,
 * which buffers the FULL decompressed output before this function would ever
 * get a chance to look at it. See this section's own header for why this
 * exists as a backstop UNDERNEATH `checkNamedEntriesWithinCeiling`, which
 * only ever looks at the archive's own declared metadata.
 *
 * `ceilingBytes` defaults to the same `MAX_DECLARED_UNCOMPRESSED_BYTES`
 * ceiling the declared-size check uses above. A caller only ever overrides it
 * in a test — proving the abort fires correctly, well under the real 200MB
 * production ceiling, without a test having to actually inflate anywhere near
 * that much data itself.
 */
export function decompressBounded(
  file: JSZip.JSZipObject,
  ceilingBytes = MAX_DECLARED_UNCOMPRESSED_BYTES
): Promise<DecompressionGuardResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const stream = file.nodeStream('nodebuffer');
    const finish = (result: DecompressionGuardResult) => {
      if (settled) return;
      settled = true;
      // `destroy()` (Node 8+) stops the underlying decompression work rather
      // than letting it run to completion after we've already stopped
      // listening — the whole point of aborting EARLY rather than just
      // ignoring further `data` events.
      (stream as unknown as { destroy?: () => void }).destroy?.();
      resolve(result);
    };
    stream.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > ceilingBytes) {
        finish({ ok: false, error: 'archive-too-large' });
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    stream.on('error', () => finish({ ok: false, error: 'archive-too-large' }));
  });
}
