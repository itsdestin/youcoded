// Static-asset serving policy for remote access (compression + caching).
//
// Why this is a separate, dependency-free module: RemoteServer.handleHttpRequest
// is private and `http` is mocked wholesale in tests/remote-server.test.ts, so
// the rules below could not be pinned by a test if they lived inline. Same
// reasoning as remote-static-policy's sibling, remote-unsupported.ts.
//
// Measured 2026-07-20 on a real `vite build`: the entry chunk is 2,016 kB and
// the stylesheet 128 kB — ~2.14 MB on the critical path, previously served
// uncompressed with no caching headers on EVERY page load. gzip takes that to
// ~590 kB (3.6x), and immutable caching takes a repeat connect to ~0.

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// Only text-ish payloads benefit. png/ico/woff/woff2 are already compressed —
// re-compressing them burns CPU to make the bytes marginally larger.
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg']);

// Below this, framing + CPU cost outweighs the savings.
const MIN_COMPRESS_BYTES = 1024;

export type ContentEncoding = 'br' | 'gzip' | null;

export interface StaticAssetPolicy {
  contentType: string;
  cacheControl: string;
  /** Null when the client accepts nothing we support, or the type isn't worth compressing. */
  encoding: ContentEncoding;
}

export function mimeTypeFor(ext: string): string {
  return MIME_TYPES[ext.toLowerCase()] || 'application/octet-stream';
}

/**
 * Vite emits every hashed bundle into `assets/` with a content hash in the
 * filename (index-CuRzLGx0.js), so the contents can never change under a given
 * URL — those are safe to pin forever.
 *
 * index.html deliberately is NOT immutable: it is the one unhashed entry point, and
 * marking it immutable would strand a client on a stale build permanently with
 * no way to recover short of clearing site data.
 *
 * WHY it is kept a week (2026-10-22 phone speed): asking for it again on every open
 * cost a phone a round trip (~0.5 s) before any code ran. The page itself checks,
 * after loading from that copy, that the computer still serves the same version and
 * reloads once if not (the inline script in index.html), so an update still arrives
 * on the first open after it. A reload asks the computer again regardless.
 */
export function cacheControlFor(urlPath: string): string {
  const normalized = urlPath.replace(/\\/g, '/');
  if (/(^|\/)assets\//.test(normalized)) return 'public, max-age=31536000, immutable';
  return normalized === '/' || normalized === '/index.html' ? 'private, max-age=604800' : 'no-cache';
}

/**
 * Picks an encoding from the client's Accept-Encoding.
 *
 * Brotli is preferred (meaningfully smaller than gzip on JS), and its cost is
 * acceptable only because callers cache the compressed bytes — assets are
 * immutable, so each file is compressed at most once per encoding per process.
 * Compressing a 2 MB chunk at brotli's default quality (11) on every request
 * would be far slower than the transfer it saves.
 */
export function negotiateEncoding(acceptEncoding: string | undefined): ContentEncoding {
  const accepted = (acceptEncoding || '').toLowerCase();
  if (accepted.includes('br')) return 'br';
  if (accepted.includes('gzip')) return 'gzip';
  return null;
}

export function staticAssetPolicy(
  urlPath: string,
  ext: string,
  acceptEncoding: string | undefined,
  byteLength: number,
): StaticAssetPolicy {
  const normalizedExt = ext.toLowerCase();
  const compressible = COMPRESSIBLE.has(normalizedExt) && byteLength >= MIN_COMPRESS_BYTES;
  return {
    contentType: mimeTypeFor(normalizedExt),
    cacheControl: cacheControlFor(urlPath),
    encoding: compressible ? negotiateEncoding(acceptEncoding) : null,
  };
}
