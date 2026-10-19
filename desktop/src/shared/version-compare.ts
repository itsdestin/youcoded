/**
 * Semver-ish comparison uses numeric components so 1.10 sorts above 1.9.
 * Returns true if `latest` is greater than `installed`.
 * Falls back to strict inequality for non-numeric
 * version strings (different = update available).
 */
export function isNewerVersion(installed: string | undefined, latest: string | undefined): boolean {
  if (!installed || !latest) return false;
  const stripV = (v: string) => v.replace(/^v/i, '').trim();
  const a = stripV(installed);
  const b = stripV(latest);
  if (a === b) return false;
  const parse = (v: string) => v.split(/[.\-+]/).map(p => /^\d+$/.test(p) ? parseInt(p, 10) : NaN);
  const pa = parse(a);
  const pb = parse(b);
  // If any segment is NaN, fall back to string inequality (different = update)
  if (pa.some(isNaN) || pb.some(isNaN)) return a !== b;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (bi > ai) return true;
    if (bi < ai) return false;
  }
  return false;
}
