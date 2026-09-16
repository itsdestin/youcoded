import { protocol } from 'electron';
import path from 'path';
import os from 'os';
import { readFile, realpath } from 'fs/promises';

const THEMES_DIR = path.join(os.homedir(), '.claude', 'wecoded-themes');
// WHY: rigs are fetched as text across origins (localhost in dev, file: when
// packaged). These credential-free theme assets need CORS response permission
// as well as the scheme's corsEnabled privilege; confinement below still applies.
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' };
const SAFE_SLUG = /^[a-z0-9_]+(?:-[a-z0-9_]+)*$/;

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.css': 'text/css',
  '.json': 'application/json',
};

/**
 * Registers the theme-asset:// custom protocol.
 * Resolves theme-asset://<slug>/<relative-path> to the file on disk.
 * Must be called before any BrowserWindow is created (in app.whenReady).
 */
export function registerThemeProtocol(): void {
  protocol.handle('theme-asset', async (request) => {
    const url = new URL(request.url);
    const slug = url.hostname;
    // WHY: URL hostnames can be '..'; checking only against that derived
    // theme directory would expose ~/.claude instead of a theme.
    if (!SAFE_SLUG.test(slug)) {
      return new Response('Forbidden', { status: 403, headers: CORS_HEADERS });
    }
    const assetPath = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const themePath = path.resolve(THEMES_DIR, slug);
    const resolvedPath = path.resolve(themePath, assetPath);

    if (!isWithin(THEMES_DIR, themePath) || !isWithin(themePath, resolvedPath)) {
      return new Response('Forbidden', { status: 403, headers: CORS_HEADERS });
    }

    try {
      // WHY: lexical confinement alone allows a theme/asset symlink to expose
      // unrelated private files through this intentionally public asset scheme.
      const [rootReal, themeReal, assetReal] = await Promise.all([
        realpath(THEMES_DIR), realpath(themePath), realpath(resolvedPath),
      ]);
      if (!isWithin(rootReal, themeReal) || !isWithin(themeReal, assetReal)) {
        return new Response('Forbidden', { status: 403, headers: CORS_HEADERS });
      }
      const data = await readFile(assetReal);
      const ext = path.extname(resolvedPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      return new Response(data, {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': contentType },
      });
    } catch {
      return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
    }
  });
}
