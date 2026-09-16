import { pathToFileURL } from 'url';

/**
 * Whether a window may navigate to `url`: the app's own index.html (any query or
 * hash), or the dev server.
 *
 * WHY (2026-09-10 security review): will-navigate used to allow ANY file:// URL,
 * so a link in a previewed document, or an HTML file dropped on the window, could
 * load some other local page into a window that carries the preload — and hand
 * that page window.claude. Nothing in the renderer navigates the page itself;
 * main loads index.html with loadFile, which does not raise will-navigate.
 */
export function isAppPageUrl(url: string, indexHtmlPath: string, devServerUrl: string): boolean {
  if (url === devServerUrl || url.startsWith(`${devServerUrl}/`) || url.startsWith(`${devServerUrl}?`)) return true;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol !== 'file:') return false;
  const own = pathToFileURL(indexHtmlPath);
  try {
    const norm = (u: URL): string => {
      const p = decodeURIComponent(u.pathname);
      // Windows paths are case-insensitive, and Chromium may spell the drive
      // letter differently from Node.
      return process.platform === 'win32' ? p.toLowerCase() : p;
    };
    return norm(target) === norm(own);
  } catch {
    return false;
  }
}
