import { describe, it, expect } from 'vitest';
import {
  staticAssetPolicy,
  cacheControlFor,
  negotiateEncoding,
  mimeTypeFor,
} from '../src/main/remote-static-policy';

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
  it('prefers brotli when offered', () => {
    expect(negotiateEncoding('gzip, deflate, br')).toBe('br');
  });

  it('falls back to gzip', () => {
    expect(negotiateEncoding('gzip, deflate')).toBe('gzip');
  });

  it('returns null when the client supports neither', () => {
    expect(negotiateEncoding('deflate')).toBeNull();
    expect(negotiateEncoding('')).toBeNull();
    expect(negotiateEncoding(undefined)).toBeNull();
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
