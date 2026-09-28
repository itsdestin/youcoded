import { protocol } from 'electron';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { createSessions } from './office-sessions';

export const OFFICE_SCHEME = 'office';
// WHY no network at all: a compromised or confused editor must not be able to send a document
// anywhere (design §3, R2-6). Everything the editor needs is served from its own origin.
export const OFFICE_CSP =
  "default-src office: data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src office: data: blob:; img-src office: data: blob:; font-src office: data:";

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
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
// same confinement to per-document media as to the shared editor bundle).
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

export function officeRequestHandler(deps: { root: string; sessions: ReturnType<typeof createSessions> }) {
  return async (req: Request): Promise<Response> => {
    const u = new URL(req.url);
    // WHY the token is the hostname, not a path segment: it makes the token part of the
    // origin itself, so the browser's own same-origin checks (storage, fetch, workers) already
    // keep two documents apart — nothing here has to re-implement that.
    const s = deps.sessions.get(u.hostname);
    let res: Response;
    if (!s) res = notFound();
    else {
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
      if (rel.startsWith('asc/docmedia/')) res = await serveConfined(s.temp, rel.slice('asc/docmedia/'.length));
      else if (rel.startsWith('asc/dictionaries/'))
        res = await serveConfined(path.join(deps.root, 'editors', 'dictionaries'), rel.slice('asc/dictionaries/'.length));
      else res = await serveConfined(path.join(deps.root, 'editors'), rel);
    }
    // WHY set the CSP even on a 404: the editor page itself must always carry it, and an
    // attacker probing for a missing-header path should not learn anything from its absence.
    const h = new Headers(res.headers);
    h.set('Content-Security-Policy', OFFICE_CSP);
    return new Response(res.body, { status: res.status, headers: h });
  };
}

export function registerOfficeProtocol(deps: { root: string; sessions: ReturnType<typeof createSessions> }): void {
  protocol.handle(OFFICE_SCHEME, officeRequestHandler(deps));
}
