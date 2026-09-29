import { protocol } from 'electron';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { createSessions } from './office-sessions';
import type { ThemeFonts } from './theme-fonts';

// WHY not exported: nothing outside this file needs the literal today — main.ts's scheme
// registration and the pin test that checks it both spell 'office' themselves, deliberately,
// so a change here can't silently drift the two apart. Task 5 exports it if/when its IPC
// allow-list needs to name the scheme.
const OFFICE_SCHEME = 'office';
// WHY no network at all: a compromised or confused editor must not be able to send a document
// anywhere (design §3, R2-6). Everything the editor needs is served from its own origin, and
// 'self' — not the office: scheme — keeps that origin sealed to exactly THIS document's own
// office://<token>, not every other open document's origin too (two open documents are two
// different origins under the same scheme). data:/blob: stay allowed because the editor loads
// generated blobs and inline data URIs for its own content; 'unsafe-inline'/'unsafe-eval' stay
// because sdkjs needs them. CSP cannot stop a script from navigating the frame itself
// (`location = 'https://...'`) — that needs its own guard on the editor frame's navigation,
// which is a later task's job, not this header's.
export const OFFICE_CSP =
  "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'self' data: blob:; img-src 'self' data: blob:; font-src 'self' data:; form-action 'none'; base-uri 'none'";

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.emf': 'image/emf',
  '.wmf': 'image/wmf',
  '.dic': 'text/plain',
  '.aff': 'text/plain',
};

const notFound = () => new Response('not found', { status: 404 });

// WHY realpath on both sides: a symlink inside the add-on (or a session temp dir) must not
// let a request read anything outside its confining folder (design §3a; R2-1/R2-2 apply the
// same confinement to per-document media as to the shared editor bundle). This is also the
// ONLY thing standing between a request and a `../` traversal: `new URL()` normalises a
// LITERAL ".." or "%2e%2e" path segment before the handler ever sees it, but an encoded slash
// (`%2f`) is not a segment separator to the URL parser, so a segment like `..%2f<name>` (or a
// literal `\` from `%5c`, which `path` only treats as a separator on win32) survives URL
// parsing untouched and only becomes `../` once THIS module's own decodeURIComponent below
// runs — so the realpath check here, not URL normalisation, is what refuses it.
async function serveConfined(base: string, rel: string): Promise<Response> {
  const root = await realpath(base).catch(() => null);
  if (!root) return notFound();
  const full = await realpath(path.resolve(root, '.' + path.sep + rel)).catch(() => null);
  if (!full || (full !== root && !full.startsWith(root + path.sep))) return notFound();
  const data = await readFile(full).catch(() => null);
  if (!data) return notFound();
  return new Response(data, {
    headers: { 'content-type': MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream' },
  });
}

/** The theme-font route (Task 9): office://<token>/yc-fonts/css?u=<Google css2 url> and
 *  …/yc-fonts/file?u=<fonts.gstatic.com url>. WHY here, on the editor's own origin: its CSP
 *  allows fonts from 'self' only, so the theme font must arrive as if it were the editor's own
 *  file. Main fetches (theme-fonts.ts, Google's two font hosts only); the editor never does. */
async function serveFont(fonts: ThemeFonts | undefined, kind: string, u: string | null): Promise<Response> {
  if (!fonts || !u) return notFound();
  if (kind === 'css') {
    const css = await fonts.fetchFontCss(u);
    return css === null ? notFound() : new Response(css, { headers: { 'content-type': 'text/css' } });
  }
  const file = kind === 'file' ? await fonts.fetchFontFile(u) : null;
  return file ? new Response(file.data, { headers: { 'content-type': file.type } }) : notFound();
}

type HandlerDeps = { root: string; sessions: ReturnType<typeof createSessions>; fonts?: ThemeFonts };

export function officeRequestHandler(deps: HandlerDeps) {
  return async (req: Request): Promise<Response> => {
    const u = new URL(req.url);
    // WHY the token is the hostname, not a path segment: it makes the token part of the
    // origin itself, so the browser's own same-origin checks (storage, fetch, workers) already
    // keep two documents apart — nothing here has to re-implement that.
    const s = deps.sessions.get(u.hostname);
    let res: Response;
    if (!s) res = notFound();
    else {
      try {
        // WHY try/catch: decodeURIComponent throws URIError on a malformed percent escape
        // (an incomplete sequence like "%E0%A4%A"). A malformed request is refused the same
        // way an absent file is, not turned into an uncaught exception in the main process.
        const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
        if (rel === 'yc-fonts/css' || rel === 'yc-fonts/file') res = await serveFont(deps.fonts, rel.slice('yc-fonts/'.length), u.searchParams.get('u'));
        else if (rel.startsWith('asc/docmedia/')) res = await serveConfined(s.temp, rel.slice('asc/docmedia/'.length));
        else if (rel.startsWith('asc/dictionaries/'))
          res = await serveConfined(path.join(deps.root, 'editors', 'dictionaries'), rel.slice('asc/dictionaries/'.length));
        else res = await serveConfined(path.join(deps.root, 'editors'), rel);
      } catch {
        res = notFound();
      }
    }
    // WHY set these headers even on a 404: the editor page itself must always carry them, and
    // an attacker probing for a missing-header path should not learn anything from its absence.
    const h = new Headers(res.headers);
    h.set('Content-Security-Policy', OFFICE_CSP);
    // WHY nosniff: without it, a response served with a generic/incorrect content-type (the
    // `application/octet-stream` fallback above, or a mismatched extension) can still be
    // executed as script or rendered as HTML by MIME-sniffing — nosniff makes the declared
    // content-type binding.
    h.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: res.status, headers: h });
  };
}

export function registerOfficeProtocol(deps: HandlerDeps): void {
  protocol.handle(OFFICE_SCHEME, officeRequestHandler(deps));
}
