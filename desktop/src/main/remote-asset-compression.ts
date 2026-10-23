// remote-asset-compression.ts — the compressed copies of the phone page's files (moved out of remote-server.ts, 2026-10-22).
//
// A request is answered at once with a quick compression (brotli quality 5, or gzip), cached per file and encoding: the
// files under assets/ are content-hashed, so their bytes never change under a URL and a cached copy never goes stale.
//
// WHY a second, tighter copy (2026-10-22 phone speed, Destin chose it): brotli's best quality (11) makes the app's code
// ~12% smaller (measured: main code file 815 → 720 KB) — ~0.15 s less on a first open over mobile data — but costs
// ~5–9 s of CPU on the 3 MB main file. So it is never done while a phone waits: it runs off the main thread (zlib's
// thread pool), one file at a time, and replaces the quick copy when done. The page's own files are done ahead, a
// little after remote access starts (warm), so the first phone to open the page after an app update already gets them.

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

/** Bound on cached copies. A build has a few hundred files, but this is keyed by request URLs, so it must not grow without limit. */
const MAX_ENTRIES = 64;
/** Only content-hashed files get the tight copy: anything else may change and would be recompressed for nothing. */
const HASHED = /(^|\/)assets\//;

export class CompressedAssets {
  private copies = new Map<string, { body: Buffer; best: boolean }>();
  private queued = new Set<string>();
  private chain: Promise<void> = Promise.resolve();

  /** The compressed bytes for a file, now. Schedules the tight copy of a hashed file the first time it is asked for. */
  get(urlPath: string, encoding: 'br' | 'gzip', data: Buffer): Buffer {
    const key = `${encoding}:${urlPath}`;
    const cached = this.copies.get(key);
    if (cached) return cached.body;
    // Quality 5 rather than 11 for the answer itself: near-gzip CPU cost for meaningfully better ratios. Measured on the
    // real 1,969 kB entry chunk (2026-07-20): q5 = 38 ms, q11 = 4,719 ms — a first request would stall ~5 s.
    const body = encoding === 'br'
      ? zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
      : zlib.gzipSync(data);
    this.put(key, { body, best: false });
    if (encoding === 'br' && HASHED.test(urlPath)) this.tighten(key, data);
    return body;
  }

  /** Makes the tight copies of the files the page loads first (named in its index.html), in the background. Resolves once
   *  they are all queued (idle() then says when they are done). */
  async warm(staticDir: string): Promise<void> {
    try {
      const html = await fs.promises.readFile(path.join(staticDir, 'index.html'), 'utf8');
      const files = [...new Set([...html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+)"/g)].map((m) => m[1]))];
      for (const file of files) this.tighten(`br:/${file}`, await fs.promises.readFile(path.join(staticDir, file)));
    } catch { /* no build, or a file gone: phones still get the quick copies */ }
  }

  /** Settles once every tight copy asked for so far is done (tests, and nothing else). */
  idle(): Promise<void> {
    return this.chain;
  }

  private tighten(key: string, data: Buffer): void {
    if (this.copies.get(key)?.best || this.queued.has(key)) return;
    this.queued.add(key);
    this.chain = this.chain.then(() => new Promise<void>((resolve) => {
      zlib.brotliCompress(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } }, (err, body) => {
        this.queued.delete(key);
        if (!err) this.put(key, { body, best: true });
        resolve();
      });
    }));
  }

  private put(key: string, copy: { body: Buffer; best: boolean }): void {
    if (!this.copies.has(key) && this.copies.size >= MAX_ENTRIES) this.copies.clear();
    this.copies.set(key, copy);
  }
}
