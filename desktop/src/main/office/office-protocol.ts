import { net, protocol } from 'electron';
import { lookup as dnsLookup } from 'node:dns/promises';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { copyToMedia, downloadToMedia, pictureRequestVia, uploadToMedia, type PictureRequest, type ResolveHost } from './office-pictures';
import type { createSessions } from './office-sessions';
import { createThemeFonts, currentThemeFontLinks, type ThemeFonts } from './theme-fonts';

// WHY not exported: nothing outside this file needs the literal today — main.ts's scheme
// registration, the frame guard (office-frame-guard.ts) and the pin test that checks them all
// spell 'office' themselves, deliberately, so a change here can't silently drift them apart.
const OFFICE_SCHEME = 'office';
// WHY no network at all: a compromised or confused editor must not be able to send a document
// anywhere (design §3, R2-6). Everything the editor needs is served from its own origin, and
// 'self' — not the office: scheme — keeps that origin sealed to exactly THIS document's own
// office://<token>, not every other open document's origin too (two open documents are two
// different origins under the same scheme). data:/blob: stay allowed because the editor loads
// generated blobs and inline data URIs for its own content; 'unsafe-inline'/'unsafe-eval' stay
// because sdkjs needs them. CSP cannot stop a script from navigating the frame itself
// (`location = 'https://...'`) — office-frame-guard.ts cancels that from main, on every app
// window's will-frame-navigate.
export const OFFICE_CSP =
  "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'self' data: blob:; img-src 'self' data: blob:; font-src 'self' data:; form-action 'none'; base-uri 'none'";

export const MEDIA_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";

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
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
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

type HandlerDeps = {
  root: string;
  sessions: ReturnType<typeof createSessions>;
  fonts?: ThemeFonts;
  /** Fetches a picture by web address for download-to-media, one checked hop at a time (Task 1).
   *  Production: pictureRequestVia(net.request); tests pass a fake. */
  download?: PictureRequest;
  /** A host's addresses, checked before connecting. Production: dns.lookup; tests pass a fake. */
  resolveHost?: ResolveHost;
  /** Test seam: a short cap, so the time limit is testable. */
  downloadTimeoutMs?: number;
};

/** The answer to copy-to-media / download-to-media (Task 1): the bare media name as text, which
 *  is what bridge.js's LocalFileGetImageUrl writes into the document. WHY no-store: the same
 *  request must copy again after a reopen cleared media/, never be answered from a cache. */
const mediaName = (name: string | null) =>
  name === null ? notFound() : new Response(name, { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });

export function officeRequestHandler(deps: HandlerDeps) {
  return async (req: Request): Promise<Response> => {
    const u = new URL(req.url);
    // WHY the token is the hostname, not a path segment: it makes the token part of the
    // origin itself, so the browser's own same-origin checks (storage, fetch, workers) already
    // keep two documents apart — nothing here has to re-implement that.
    const s = deps.sessions.get(u.hostname);
    // WHY decided by the route actually taken, not the raw pathname (fix round 1): routing reads
    // the DECODED path, so `asc%2Fdocmedia/…` reaches the pictures folder too — deciding on the
    // raw text served such a picture under the editor's own policy. A malformed escape never
    // gets this far: it is a 404 (the catch below).
    let docMedia = false;
    let res: Response;
    if (!s) res = notFound();
    else {
      try {
        // WHY try/catch: decodeURIComponent throws URIError on a malformed percent escape
        // (an incomplete sequence like "%E0%A4%A"). A malformed request is refused the same
        // way an absent file is, not turned into an uncaught exception in the main process.
        const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
        if (rel === 'yc-fonts/css' || rel === 'yc-fonts/file') res = await serveFont(deps.fonts, rel.slice('yc-fonts/'.length), u.searchParams.get('u'));
        // Drag and drop (Task 1): the add-on's yc-bridge.js posts a dropped picture's bytes to
        // upload/drop and reads {"media/<name>": "<address>"} back — the shape a document server's
        // upload answers, so sdkjs's own web upload path gets the same answer.
        else if (rel.startsWith('upload/')) {
          const name = await uploadToMedia(s, req);
          res = name === null ? notFound() : Response.json({ [`media/${name}`]: `${u.protocol}//${u.host}/asc/docmedia/media/${name}` }, { headers: { 'cache-control': 'no-store' } });
        } else if (rel.startsWith('asc/copy-to-media/')) res = mediaName(await copyToMedia(s, rel.slice('asc/copy-to-media/'.length)));
        else if (rel.startsWith('asc/download-to-media/'))
          res = mediaName(deps.download && deps.resolveHost ? await downloadToMedia(s, rel.slice('asc/download-to-media/'.length), { request: deps.download, resolve: deps.resolveHost, timeoutMs: deps.downloadTimeoutMs }) : null);
        else if (rel.startsWith('asc/docmedia/')) {
          docMedia = true;
          res = await serveConfined(s.temp, rel.slice('asc/docmedia/'.length));
        }
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
    // WHY a sandboxing policy for the document's own pictures (finish plan Task 1): media/ now
    // also holds pictures fetched from any web address, and an SVG is a document that can carry
    // script. Shown as a picture (<img>, canvas) this changes nothing; opened as a page on this
    // origin it runs nothing and reaches nothing, instead of acting as the editor.
    h.set('Content-Security-Policy', docMedia ? MEDIA_CSP : OFFICE_CSP);
    // WHY nosniff: without it, a response served with a generic/incorrect content-type (the
    // `application/octet-stream` fallback above, or a mismatched extension) can still be
    // executed as script or rendered as HTML by MIME-sniffing — nosniff makes the declared
    // content-type binding.
    h.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: res.status, headers: h });
  };
}

/** The theme-font service main.ts hands the protocol (Task 9). WHY net.fetch: the system proxy
 *  applies; WHY under userData: a later open works offline and each profile keeps its own; WHY
 *  claudeDir: the applied theme's own files say which web font it uses. */
export function officeThemeFonts(userData: string, claudeDir: string): ThemeFonts {
  return createThemeFonts({
    cacheDir: path.join(userData, 'office-font-cache'),
    fetch: (u, init) => net.fetch(u, init),
    themeFontLinks: () => currentThemeFontLinks(claudeDir),
  });
}

export function registerOfficeProtocol(deps: HandlerDeps): void {
  // WHY Electron's net for pictures by address: the system proxy applies, as for theme fonts. The
  // editor itself can reach no network (OFFICE_CSP); main fetches, with the checks in
  // office-pictures.ts (http(s) only, public addresses only, every redirect checked, pictures
  // only, 25 MB, 20 s).
  protocol.handle(OFFICE_SCHEME, officeRequestHandler({
    download: pictureRequestVia((o) => net.request(o as unknown as Electron.ClientRequestConstructorOptions)),
    resolveHost: async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address),
    ...deps,
  }));
}
