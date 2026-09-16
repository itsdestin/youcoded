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
  // Reject a NUL byte (2026-09-11 review): decodeURIComponent('%00') does NOT
  // throw, but fs.readFile throws SYNCHRONOUSLY on any path containing '\0'
  // (ERR_INVALID_ARG_VALUE) — inside the createServer callback, which has no
  // try/catch and a process with no uncaughtException handler. That is the same
  // unauthenticated one-request crash `GET /%` used to cause. Any control char is
  // refused for good measure; none belongs in a static asset path.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(decoded)) return null;
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
