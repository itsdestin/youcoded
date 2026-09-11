import path from 'path';

/**
 * Resolve a request URL path to a file inside `staticDir`, or null when it is
 * malformed or escapes the directory.
 *
 * WHY (2026-09-10 security review): the static handler called
 * `decodeURIComponent(url)` with no guard, so `GET /%` threw "URI malformed"
 * synchronously in the main process — which has no uncaughtException handler
 * (deliberately, main.ts). Any tailnet peer could crash the app with one
 * unauthenticated request. The containment check also used `startsWith(staticDir)`,
 * which a sibling directory (`<staticDir>-x`) satisfies; a path-segment check does not.
 */
export function resolveStaticFile(url: string, staticDir: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.split('?')[0]);
  } catch {
    return null; // malformed percent-encoding
  }
  const safe = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(staticDir, safe);
  return isWithinDir(filePath, staticDir) ? filePath : null;
}

/** True when `target` is `dir` itself or sits inside it, by path segments (not a
 *  string prefix, so `<dir>-x` is outside `<dir>`). */
export function isWithinDir(target: string, dir: string): boolean {
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
