#!/usr/bin/env node
// The Office editor for the WORKBENCH (Task 6) — never part of the app.
//
// Serves the installed add-on's editor page (office-addon/editors/) on 127.0.0.1:4717 with the
// app's own editor CSP, and plays main's part for the fake host in dev/workbench/mock-shim.ts:
//   GET /fixtures/<name>  the fixture translated into the editor's form by the REAL x2t,
//                         base64 (what office:invoke open_file answers in the app)
//   GET /samples/<name>   the fixture's own bytes (the file panel's quick preview reads them)
// Fixtures: src/renderer/dev/workbench/fixtures/office/. Translations are cached in memory.
//
// WHY main's own convert() and CSP, imported from the compiled main process (dist/), and not a
// copy: a second copy of x2t's task file would drift from the app's (review P1-7), and then the
// workbench would show documents the app could not open, or the other way round.
//
// Run from desktop/:  npx tsc -p tsconfig.json && node scripts/office-workbench-server.mjs
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const ROOT = path.join(DESKTOP, 'office-addon');
const EDITORS = path.join(ROOT, 'editors');
const FIXTURES = path.join(DESKTOP, 'src/renderer/dev/workbench/fixtures/office');
const PORT = 4717;

const require = createRequire(import.meta.url);
let x2t, protocolModule, themeFonts;
try {
  x2t = require(path.join(DESKTOP, 'dist/main/office/x2t.js'));
  // office-protocol.js imports electron's `protocol` at load; outside Electron that import is
  // only the binary's path, and nothing here calls it — OFFICE_CSP is a plain string.
  protocolModule = require(path.join(DESKTOP, 'dist/main/office/office-protocol.js'));
  themeFonts = require(path.join(DESKTOP, 'dist/main/office/theme-fonts.js'));
} catch (e) {
  console.error(`Build the main process first (npx tsc -p tsconfig.json in desktop/): ${e.message}`);
  process.exit(1);
}
const { convert, FORMAT } = x2t;
const { OFFICE_CSP } = protocolModule;
// WHY (Task 9): main serves the theme's web font on the editor's own origin (/yc-fonts/…, fetched
// from Google's font hosts only); the workbench plays main's part with main's own module, so a
// picture of a theme with a web font shows that font in the editor's menus, as the app does.
// The practice app's themes are its fixtures, so the stylesheets they link are the only ones
// allowed (main allows only the applied theme's — see theme-fonts.ts).
const THEMES = path.join(DESKTOP, 'src/renderer/dev/workbench/fixtures/themes');
async function fixtureFontLinks() {
  const links = [];
  for (const slug of await readdir(THEMES).catch(() => [])) {
    try {
      const url = JSON.parse(await readFile(path.join(THEMES, slug, 'manifest.json'), 'utf8'))?.font?.['google-font-url'];
      if (typeof url === 'string') links.push(url);
    } catch { /* not a theme folder */ }
  }
  return links;
}
const fonts = themeFonts.createThemeFonts({ cacheDir: path.join(tmpdir(), 'yc-office-wb-font-cache'), fetch: (u, init) => fetch(u, init), themeFontLinks: fixtureFontLinks });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.dic': 'text/plain', '.aff': 'text/plain',
};

/** A file under `base`, or null — the same realpath confinement as main's office:// handler. */
async function confined(base, rel) {
  const root = await realpath(base).catch(() => null);
  if (!root) return null;
  const full = await realpath(path.resolve(root, '.' + path.sep + rel)).catch(() => null);
  if (!full || (full !== root && !full.startsWith(root + path.sep))) return null;
  return full;
}

const translated = new Map(); // fixture name → Promise<base64>
function translate(file) {
  let p = translated.get(file);
  if (!p) {
    p = (async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'yc-office-wb-'));
      try {
        const out = path.join(dir, 'Editor.bin');
        await convert(ROOT, file, out, FORMAT.bin, dir);
        return (await readFile(out)).toString('base64');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    })();
    // A failed translation is not cached, so a retry tries again.
    p.catch(() => translated.delete(file));
    translated.set(file, p);
  }
  return p;
}

const server = createServer(async (req, res) => {
  const send = (status, body, type = 'text/plain') => {
    res.writeHead(status, {
      'content-type': type,
      'Content-Security-Policy': OFFICE_CSP,
      'X-Content-Type-Options': 'nosniff',
      // The fake host (the workbench page, another origin) fetches /fixtures and /samples.
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
  };
  try {
    const u = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    // Which checkout this server belongs to — shoot (scripts/shoot/office-editor.mjs) reuses a
    // server only when it serves the same checkout it is photographing.
    if (rel === 'yc-workbench-info') return send(200, JSON.stringify({ desktop: DESKTOP }), 'application/json');
    if (rel === 'yc-fonts/css') {
      const css = await fonts.fetchFontCss(u.searchParams.get('u') ?? '');
      return css === null ? send(404, 'not found') : send(200, css, 'text/css');
    }
    if (rel === 'yc-fonts/file') {
      const f = await fonts.fetchFontFile(u.searchParams.get('u') ?? '');
      return f ? send(200, Buffer.from(f.data), f.type) : send(404, 'not found');
    }
    if (rel.startsWith('fixtures/') || rel.startsWith('samples/')) {
      const file = await confined(FIXTURES, rel.slice(rel.indexOf('/') + 1));
      if (!file) return send(404, 'not found');
      if (rel.startsWith('samples/')) return send(200, await readFile(file), 'application/octet-stream');
      return send(200, await translate(file));
    }
    const file = await confined(EDITORS, rel);
    if (!file) return send(404, 'not found');
    return send(200, await readFile(file), MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
  } catch (e) {
    console.error(`office-workbench-server: ${req.url}: ${e?.message ?? e}`);
    return send(500, 'failed');
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`Office editor for the workbench: http://127.0.0.1:${PORT}/`));
