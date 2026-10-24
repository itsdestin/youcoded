// The phone page's compressed files: answered at once with a quick copy, replaced by a tighter one made in the background,
// and the page's own files made ahead (warm) so the first phone after an update gets them. src/main/remote-asset-compression.ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { CompressedAssets } from '../src/main/remote-asset-compression';

// Text that compresses better at the top quality than at 5 (varied, repetitive at long range).
const code = Buffer.from(Array.from({ length: 4000 }, (_, i) => `export function f${i % 700}(a){return a*${i % 13}+"${'x'.repeat(i % 40)}";}\n`).join(''));

describe('the phone page\'s compressed files', () => {
  let dir: string | null = null;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); dir = null; });

  it('answers at once, then serves a smaller copy of a hashed file once the background one is done', async () => {
    const assets = new CompressedAssets();
    const quick = assets.get('/assets/index-abc.js', 'br', code);
    expect(zlib.brotliDecompressSync(quick).equals(code)).toBe(true);
    await assets.idle();
    const tight = assets.get('/assets/index-abc.js', 'br', code);
    expect(tight.length).toBeLessThan(quick.length);
    expect(zlib.brotliDecompressSync(tight).equals(code)).toBe(true);
  });

  it('never makes a background copy of a file that may change, or of gzip', async () => {
    const assets = new CompressedAssets();
    const page = assets.get('/index.html', 'br', code);
    const gz = assets.get('/assets/x.js', 'gzip', code);
    await assets.idle();
    expect(assets.get('/index.html', 'br', code)).toBe(page);
    expect(assets.get('/assets/x.js', 'gzip', code)).toBe(gz);
  });

  it('makes the tight copies of the files the page names before any phone asks', async () => {
    dir = mkdtempSync(join(tmpdir(), 'yc-assets-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<script type="module" src="./assets/index-abc.js"></script>');
    writeFileSync(join(dir, 'assets', 'index-abc.js'), code);
    const assets = new CompressedAssets();
    await assets.warm(dir);
    await assets.idle();
    const first = assets.get('/assets/index-abc.js', 'br', code);
    const quick = zlib.brotliCompressSync(code, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
    expect(first.length).toBeLessThan(quick.length);
  });
});
