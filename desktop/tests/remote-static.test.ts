// What the phone page's file server sends: which file a URL names (and never one outside the folder), how it is
// cached and compressed, and the compressed copies made ahead of time. src/main/remote-static-{path,policy}.ts, remote-asset-compression.ts
import { describe, it, expect, afterEach } from 'vitest';
import path, { join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import zlib from 'node:zlib';
import { resolveStaticFile, isWithinDir } from '../src/main/remote-static-path';
import { staticAssetPolicy, cacheControlFor, negotiateEncoding, mimeTypeFor } from '../src/main/remote-static-policy';
import { CompressedAssets } from '../src/main/remote-asset-compression';

const DIR = path.resolve('/opt/app/renderer');

describe('resolveStaticFile — the unauthenticated static handler', () => {
  it('resolves an ordinary asset inside the directory', () => {
    expect(resolveStaticFile('/assets/main.js', DIR)).toBe(path.join(DIR, 'assets/main.js'));
  });

  it('strips a query string before decoding', () => {
    expect(resolveStaticFile('/assets/main.js?v=2', DIR)).toBe(path.join(DIR, 'assets/main.js'));
  });

  it('returns null for a malformed percent-encoding instead of throwing (the /% crash)', () => {
    // decodeURIComponent('%') throws "URI malformed"; the old handler did this in
    // the main process, which has no uncaughtException handler.
    expect(() => resolveStaticFile('/%', DIR)).not.toThrow();
    expect(resolveStaticFile('/%', DIR)).toBeNull();
    expect(resolveStaticFile('/%zz', DIR)).toBeNull();
  });

  it('rejects a NUL byte / control chars (fs.readFile crashes synchronously on \\0)', () => {
    // decodeURIComponent('%00') does NOT throw, but the resulting path crashes
    // fs.readFile in the unguarded server callback — the same crash class as /%.
    expect(resolveStaticFile('/%00', DIR)).toBeNull();
    expect(resolveStaticFile('/assets/%00.js', DIR)).toBeNull();
    expect(resolveStaticFile('/a%01b', DIR)).toBeNull();
  });

  it('a traversal attempt is contained inside the directory, never above it', () => {
    // normalize + strip leading `..` clamps every escape back under staticDir,
    // so these resolve to a (usually missing) file INSIDE the dir — never /etc/passwd.
    for (const p of [
      resolveStaticFile('/../secret.txt', DIR),
      resolveStaticFile('/..%2f..%2fetc%2fpasswd', DIR),
      resolveStaticFile('/%2e%2e/%2e%2e/%2e%2e/etc/passwd', DIR),
    ]) {
      expect(p).not.toBeNull();
      expect(isWithinDir(p!, DIR)).toBe(true);
    }
  });
});

describe('isWithinDir', () => {
  it('a sibling directory sharing a name prefix is NOT inside', () => {
    // The old `startsWith(staticDir)` check passed `/opt/app/renderer-x`.
    expect(isWithinDir('/opt/app/renderer-x/main.js', DIR)).toBe(false);
    expect(isWithinDir(path.join(DIR, 'main.js'), DIR)).toBe(true);
    expect(isWithinDir(DIR, DIR)).toBe(true);
  });
});

describe('cacheControlFor', () => {
  it('pins content-hashed assets forever', () => {
    expect(cacheControlFor('/assets/index-CuRzLGx0.js')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(cacheControlFor('/assets/index-BQcWDdsc.css')).toContain('immutable');
  });

  // The bug this prevents: index.html is the ONE unhashed URL. Marking it
  // immutable strands every client on a stale build with no recovery path.
  // It is kept a week instead (no round trip per open); the page checks its
  // own version after loading (index-html-version-check.test.ts).
  it('never marks index.html immutable, and keeps it a week', () => {
    for (const url of ['/index.html', '/']) {
      expect(cacheControlFor(url)).not.toContain('immutable');
      expect(cacheControlFor(url)).toBe('private, max-age=604800');
    }
  });

  it('does not treat a path merely containing the word assets as hashed', () => {
    expect(cacheControlFor('/data/my-assets.json')).toBe('no-cache');
  });
});

describe('negotiateEncoding', () => {
  it.each([
    ['gzip, deflate, br', 'br'],
    ['gzip, deflate', 'gzip'],
    ['deflate', null],
    ['', null],
    [undefined, null],
  ])('%s -> %s (brotli preferred, then gzip, else none)', (header, expected) => {
    expect(negotiateEncoding(header)).toBe(expected);
  });
});

describe('staticAssetPolicy', () => {
  const big = 2_000_000;

  it('compresses the entry chunk — the whole point of the change', () => {
    const p = staticAssetPolicy('/assets/index-CuRzLGx0.js', '.js', 'gzip, br', big);
    expect(p.encoding).toBe('br');
    expect(p.contentType).toBe('application/javascript');
    expect(p.cacheControl).toContain('immutable');
  });

  // Re-compressing already-compressed formats spends CPU to grow the payload.
  it('does not compress already-compressed media', () => {
    for (const ext of ['.png', '.woff2', '.woff', '.ico']) {
      expect(staticAssetPolicy(`/assets/x${ext}`, ext, 'gzip, br', big).encoding).toBeNull();
    }
  });

  it('skips compression for tiny payloads', () => {
    expect(staticAssetPolicy('/assets/tiny.js', '.js', 'gzip, br', 200).encoding).toBeNull();
  });

  it('serves uncompressed when the client accepts no encoding we support', () => {
    const p = staticAssetPolicy('/assets/index-CuRzLGx0.js', '.js', 'identity', big);
    expect(p.encoding).toBeNull();
    // …but the caching decision is independent of compression.
    expect(p.cacheControl).toContain('immutable');
  });

  it('falls back to octet-stream for unknown types', () => {
    expect(mimeTypeFor('.wat')).toBe('application/octet-stream');
  });

  it('handles uppercase extensions', () => {
    expect(staticAssetPolicy('/assets/A.JS', '.JS', 'gzip', big).contentType).toBe(
      'application/javascript',
    );
  });
});

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
