// Pins F3 (implementation review, both docx/xlsx read paths):
// `decompressBounded`'s own byte-counting decompression-time backstop,
// underneath the declared-size-only `checkNamedEntriesWithinCeiling`/
// `checkTotalWithinCeiling` checks pinned by docx-comments.test.ts/
// xlsx-comments.test.ts's own "decompression-bomb-shaped archive" describe
// blocks. See zip-size-guard.ts's own header for why the declared-size checks
// alone are not a sufficient guard: they only ever read central-directory
// METADATA, which a crafted entry can simply lie about.
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { Readable } from 'stream';
import { decompressBounded } from '../src/main/doc-comments/zip-size-guard';

/** A Node Readable of `totalBytes` zero bytes, generated on demand in small
 *  chunks — building the fixture below never holds the whole (multi-MB)
 *  uncompressed content in memory at once, only ever one chunk. */
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

describe('zip-size-guard — decompressBounded', () => {
  it('reads an ordinary small entry to completion', async () => {
    const zip = new JSZip();
    zip.file('small.txt', 'hello world');
    const file = zip.file('small.txt')!;
    const result = await decompressBounded(file);
    expect(result).toEqual({ ok: true, text: 'hello world' });
  });

  // A REAL zip bomb: genuinely `REAL_BYTES` of zero bytes (DEFLATE compresses
  // this to almost nothing), fed as a stream (`zerosStream`) so building this
  // fixture never holds the whole thing in memory at once either.
  // `decompressBounded` is given a MUCH smaller ceiling (64KB) than
  // production's real 200MB ceiling — this is what keeps the test itself
  // fast and lightweight while still proving the exact abort mechanism,
  // without a test having to actually inflate anywhere near 200MB itself.
  it('aborts a real zip bomb the moment its real decompressed bytes exceed the ceiling — never buffering the full output', async () => {
    const REAL_BYTES = 8 * 1024 * 1024;
    const zip = new JSZip();
    zip.file('bomb.xml', zerosStream(REAL_BYTES), { compression: 'DEFLATE' });
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    // The real compressed archive is tiny — proves DEFLATE actually
    // compressed the repetitive input, rather than this accidentally being a
    // large fixture on disk that happens to also be a large fixture inflated.
    expect(buf.length).toBeLessThan(REAL_BYTES / 100);

    const loaded = await JSZip.loadAsync(buf);
    const file = loaded.file('bomb.xml')!;
    const CEILING = 64 * 1024;

    const start = Date.now();
    const result = await decompressBounded(file, CEILING);
    const elapsedMs = Date.now() - start;

    expect(result).toEqual({ ok: false, error: 'archive-too-large' });
    // Fast — proves the abort fired well before the full 8MB was
    // decompressed, not after a decompress-then-check pass over everything.
    expect(elapsedMs).toBeLessThan(2000);
  });
});
