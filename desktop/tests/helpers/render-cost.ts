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
 *  test mounts 11 times; alone that takes 5-10s. The CPU ratio is what the test
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

/** The smallest of RENDER_COST_TRIALS samples; `sample(trial)` must use its
 *  own fresh document path per trial so no trial inherits another's comments. */
export function bestOf(sample: (trial: number) => number): number {
  const samples: number[] = [];
  for (let t = 0; t < RENDER_COST_TRIALS; t++) samples.push(sample(t));
  return Math.min(...samples);
}
