// Pins F3 (implementation review, both docx/xlsx read paths):
// `decompressBounded`'s own byte-counting decompression-time backstop,
// underneath the declared-size-only `checkNamedEntriesWithinCeiling` checks
// pinned by docx-comments.test.ts's/xlsx-comments.test.ts's own
// "decompression-bomb-shaped archive" describe blocks (both readers now open
// only NAMED parts — §4.3's 2026-09-27 threaded-comments rewrite retired the
// old whole-archive `checkTotalWithinCeiling` scan along with exceljs). See
// zip-size-guard.ts's own header for why the declared-size checks alone are
// not a sufficient guard: they only ever read central-directory METADATA,
// which a crafted entry can simply lie about.
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { Readable } from 'stream';
import { EventEmitter } from 'events';
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

  // Code review 2026-09-27, desktop F2: a genuinely broken/truncated stream
  // (a corrupted DEFLATE entry — nothing to do with size) used to come out
  // of the SAME `'archive-too-large'` branch as a real overflow. This
  // exercises the stream's own 'error' event directly (a fake JSZipObject,
  // rather than hand-crafting corrupted DEFLATE bytes real zlib would choke
  // on — the exact shape being pinned is "what code does a stream `error`
  // event map to", independent of what real-world byte corruption looks
  // like) — see docx-comments.test.ts's/xlsx-comments.test.ts's own tests
  // for the format-level mapping this backs (`'invalid-docx'`/`'invalid-
  // xlsx'`, never `'archive-too-large'`).
  it("a genuine stream error reports 'decompress-failed', never 'archive-too-large'", async () => {
    const stream = new EventEmitter() as EventEmitter & { destroy?: () => void };
    stream.destroy = () => {};
    const fakeFile = {
      nodeStream: () => stream,
    } as unknown as JSZip.JSZipObject;

    const resultPromise = decompressBounded(fakeFile);
    // Some real bytes arrive fine before the stream breaks — proves this
    // isn't just "no data ever arrived", but a genuine mid-stream failure.
    stream.emit('data', Buffer.from('partial'));
    stream.emit('error', new Error('invalid distance too far back'));

    const result = await resultPromise;
    expect(result).toEqual({ ok: false, error: 'decompress-failed' });
  });
});
