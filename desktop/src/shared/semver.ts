// compareSemver — used across main-process changelog parsing and renderer
// changelog-panel version comparison. Pure; no Electron dependency.
// Returns -1 / 0 / 1 for major/minor/patch ordering. Non-numeric components default to 0.

export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10));
  const pb = b.split('.').map(n => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    // Guards against NaN — parseInt('abc') returns NaN and NaN comparisons are arbitrary.
    const da = Number.isFinite(pa[i]) ? pa[i] : 0;
    const db = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}
