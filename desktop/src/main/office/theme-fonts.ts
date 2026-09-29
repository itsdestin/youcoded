// The theme's web font for the Office editors (build plan Task 9).
//
// WHY main fetches, never the editor: the editor's CSP keeps it offline (design §3 — a
// compromised or confused editor must not be able to send a document anywhere), so it cannot
// load a theme's Google font itself, and its menus fell back to monospace (Meadow Mist's Nunito,
// measured in Task 6). Main has network; it fetches from Google's two font hosts ONLY, keeps a
// copy under userData/office-font-cache/, and the editor reads it from its own
// office://<token>/yc-fonts/... route (same origin, so `font-src 'self'` allows it).
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
/** WHY ArrayBuffer-backed: Response bodies take only that kind of byte array. */
type Bytes = Uint8Array<ArrayBuffer>;

const CSS_HOST = 'fonts.googleapis.com';
const FILE_HOST = 'fonts.gstatic.com';
/** WHY caps: Google's stylesheets are a few KB and one font file well under 1 MB; anything far
 *  bigger is not a font and must not fill the disk or memory. */
const MAX_CSS_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** WHY a browser user agent: Google Fonts picks the file format by user agent; a modern Chrome
 *  gets woff2 (smallest, what Chromium renders natively). */
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const FONT_TYPES: Record<string, string> = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

function parse(u: string): URL | null {
  try { return new URL(u); } catch { return null; }
}

/** WHY exact hostname, not a prefix or suffix test: `fonts.googleapis.com.evil.com` and the
 *  userinfo trick `https://fonts.googleapis.com@evil.com/` both START with a Google host as
 *  text. The URL parser puts the real host in `hostname`, and userinfo in username/password —
 *  any userinfo at all is refused, as is a non-default port. */
function allowed(u: string, host: string): URL | null {
  const url = parse(u);
  if (!url || url.protocol !== 'https:' || url.hostname !== host) return null;
  if (url.username || url.password || url.port) return null;
  if (host === CSS_HOST && url.pathname !== '/css2') return null;
  if (host === FILE_HOST && url.pathname.length < 2) return null;
  return url;
}

/** Only Google's stylesheet endpoint (https fonts.googleapis.com/css2) and its font-file host
 *  (https fonts.gstatic.com/…). */
export function isAllowedFontUrl(u: string): boolean {
  return !!(allowed(u, CSS_HOST) || allowed(u, FILE_HOST));
}

/** Points every font file in a Google stylesheet at the editor's own font route. WHY a
 *  root-relative URL: it resolves against the stylesheet's own office://<token> origin, so one
 *  cached copy serves every document (each has its own token). Any other url() — another host,
 *  an @import — is blanked, so the stylesheet can never make the editor reach out. */
export function rewriteFontCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/g, '')
    .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/g, (_m, _q, u: string) =>
      allowed(u.trim(), FILE_HOST) ? `url("/yc-fonts/file?u=${encodeURIComponent(u.trim())}")` : 'url("data:,")');
}

export interface ThemeFonts {
  /** The rewritten stylesheet, or null when the url is not allowed or unreachable. */
  fetchFontCss(u: string): Promise<string | null>;
  /** The font file and its type, or null when the url is not allowed or unreachable. */
  fetchFontFile(u: string): Promise<{ data: Bytes; type: string } | null>;
}

export function createThemeFonts(deps: { cacheDir: string; fetch: FetchLike }): ThemeFonts {
  const inflight = new Map<string, Promise<Bytes | null>>();

  const cachePath = (u: string, ext: string) =>
    path.join(deps.cacheDir, createHash('sha256').update(u).digest('hex') + ext);

  async function download(u: string, max: number): Promise<Bytes | null> {
    try {
      // WHY redirect 'error': a redirect could lead anywhere, which would undo the host check.
      const res = await deps.fetch(u, { redirect: 'error', headers: { 'user-agent': USER_AGENT } });
      if (!res.ok) return null;
      if (Number(res.headers.get('content-length') ?? 0) > max) return null;
      const data = new Uint8Array(await res.arrayBuffer());
      return data.byteLength > max ? null : data;
    } catch {
      return null; // offline, blocked, or refused redirect: the editor keeps its fallback font
    }
  }

  /** Cache first; network only on a miss. WHY write-then-rename: a crash mid-write must not
   *  leave a half file that later reads as a valid cache hit. */
  function cached(u: string, file: string, max: number, transform?: (d: Bytes) => Bytes): Promise<Bytes | null> {
    const running = inflight.get(file);
    if (running) return running;
    const job = (async () => {
      const hit = await readFile(file).catch(() => null);
      if (hit) return Uint8Array.from(hit);
      const got = await download(u, max);
      if (!got) return null;
      const data = transform ? transform(got) : got;
      const part = `${file}.${randomBytes(6).toString('hex')}.part`;
      try {
        await mkdir(deps.cacheDir, { recursive: true });
        await writeFile(part, data);
        await rename(part, file);
      } catch {
        await rm(part, { force: true }).catch(() => {}); // a cache we cannot write is not an error
      }
      return data;
    })().finally(() => inflight.delete(file));
    inflight.set(file, job);
    return job;
  }

  return {
    async fetchFontCss(u) {
      if (!allowed(u, CSS_HOST)) return null;
      const data = await cached(u, cachePath(u, '.css'), MAX_CSS_BYTES, (d) =>
        new TextEncoder().encode(rewriteFontCss(new TextDecoder().decode(d))));
      return data ? new TextDecoder().decode(data) : null;
    },
    async fetchFontFile(u) {
      const url = allowed(u, FILE_HOST);
      const type = url && FONT_TYPES[path.posix.extname(url.pathname).toLowerCase()];
      if (!type) return null;
      const data = await cached(u, cachePath(u, path.posix.extname(url.pathname).toLowerCase()), MAX_FILE_BYTES);
      return data ? { data, type } : null;
    },
  };
}
