// Shared measuring for tests/render-cost/ — CPU-time RATIO pins ("1,000
// comments cost about N times what 100 do") that catch a per-item cost turning
// into a per-PAIR cost.
//
// WHY these pins live in their own vitest project (vitest.config.ts →
// 'render-cost'): inside the full parallel suite, process.cpuUsage() itself
// inflates while ~30 sibling workers fight for cores and cache — measured
// 2026-09-29, the 1,000-comment mount's CPU time rose 4x and the 100-comment
// mount's only 2.4x, so the RATIO moved with nothing regressed. That project
// runs after every other file has finished, one file at a time.

/** Sample count per size. The MINIMUM is kept: contention and GC can only
 *  ADD cost to a mount, never remove it, so the smallest sample is the one
 *  closest to the component's own cost. */
export const RENDER_COST_TRIALS = 5;

/** Wall-clock budget for one stress test (test-suite-hygiene.md: "budgets are
 *  measured, not guessed" — a named constant, not the 30s suite default). Each
 *  test mounts at least 11 times (more for the small size: see
 *  MIN_TRIAL_CPU_MS); alone that takes 5-10s. The CPU ratio is what the test
 *  asserts; this only stops a genuinely hung mount from waiting forever. */
export const RENDER_COST_BUDGET_MS = 90_000;

/** CPU milliseconds `run` takes, after a full garbage collection.
 *
 *  WHY collect first: without it, a trial pays to collect the PREVIOUS trial's
 *  garbage (a 1,000-comment mount leaves a lot), so what a sample measures
 *  depends on what ran before it rather than only on the mount itself.
 *
 *  WHY throw without gc(): its absence means this file is running outside the
 *  'render-cost' project (that project passes --expose-gc) — i.e. inside the
 *  parallel suite, where these ratios are known to flake. Failing loudly here
 *  is better than a pin that flakes a month later. */
export function cpuMsOf(run: () => void): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') {
    throw new Error(
      'tests/render-cost/ must run in vitest\'s "render-cost" project (vitest.config.ts), which passes --expose-gc and runs it after the parallel suite. Is the file outside tests/render-cost/?',
    );
  }
  gc();
  const started = process.cpuUsage();
  run();
  const used = process.cpuUsage(started);
  return (used.user + used.system) / 1000;
}

/** CPU ms accumulated per trial before it is averaged into one sample.
 *  WHY (master f7a9b4bba, 2026-10-01): Windows counts process CPU time in
 *  ~15.6 ms ticks, so a small mount measured once read as 0, 15.6 or 31.2 ms
 *  and a ratio could swing 2x with nothing changed (the 315-comment pin hit
 *  12.3x on a Windows runner). Mounting repeatedly until ~10 ticks have
 *  accumulated, then averaging per mount, keeps that rounding under ~10%. */
export const MIN_TRIAL_CPU_MS = 150;

/** One sample: the AVERAGE CPU ms per mount over as many mounts as it takes
 *  to reach MIN_TRIAL_CPU_MS. */
function trialMs(mount: (id: string) => number, trial: number): number {
  let total = 0;
  let n = 0;
  do { total += mount(`${trial}-${n}`); n++; } while (total < MIN_TRIAL_CPU_MS);
  return total / n;
}

/** How many times `large` costs `small`: the smallest of RENDER_COST_TRIALS
 *  samples of each, then large / small. `mount(id)` must use its own fresh
 *  document path per id (ids are unique per size) so no mount inherits
 *  another's comments.
 *
 *  WHY the two sizes' trials alternate (small, large, small, large…) rather
 *  than all-small-then-all-large: the machine's speed drifts during a run
 *  (clock boost, JIT tiers, heap growth), and alternating puts both sizes in
 *  the same stretch of it, so the drift cancels in the ratio. */
export function costRatio(small: (id: string) => number, large: (id: string) => number): { small: number; large: number; ratio: number } {
  const smalls: number[] = [];
  const larges: number[] = [];
  for (let t = 0; t < RENDER_COST_TRIALS; t++) {
    smalls.push(trialMs(small, t));
    larges.push(trialMs(large, t));
  }
  const s = Math.min(...smalls);
  const l = Math.min(...larges);
  // Math.max(…, 1): a sub-millisecond small size cannot divide by ~0.
  return { small: s, large: l, ratio: l / Math.max(s, 1) };
}
