import { protocol } from 'electron';
import path from 'path';
import os from 'os';
import { readFile } from 'fs/promises';

const THEMES_DIR = path.join(os.homedir(), '.claude', 'wecoded-themes');

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
    const assetPath = decodeURIComponent(url.pathname.replace(/^\//, ''));

    // Security: resolve and verify path is within the theme's directory
    const themePath = path.join(THEMES_DIR, slug);
    const resolvedPath = path.resolve(themePath, assetPath);

    if (!resolvedPath.startsWith(themePath + path.sep) && resolvedPath !== themePath) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const data = await readFile(resolvedPath);
      const ext = path.extname(resolvedPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      return new Response(data, {
        status: 200,
        headers: { 'Content-Type': contentType },
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}
