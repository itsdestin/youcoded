import { afterEach, beforeEach, expect } from 'vitest';

// CPU-bound tests: budget the CPU they use, not the wall-clock time they take.
//
// WHY (2026-10-07): the streaming-markdown property tests (every prefix of a message rendered
// and compared with the whole) are pure CPU — no timers, no I/O, no lazy imports. Alone they
// take 1-3 s. In `verify.sh --full` on a loaded machine (load 40-70 on 32 threads: a second
// verify in the same worktree plus other sessions, and verify itself `nice`d so every
// un-niced process outranked it) the same tests took over 30 s and 90 s of WALL time and
// failed the suite's timeout, with nothing regressed. Wall time there measures the machine,
// not the code (test-suite-hygiene.md: "budget assertions measure CPU time"). These tests
// now assert a CPU-time budget — which still catches the real regression a timeout was for (a
// per-character cost turning per-message) — and keep only a wide wall limit against a hang.

/** Wall-clock limit for a group budgeted with `budgetCpuPerTest`. Only a hang should reach
 *  it: a starved run of the slowest such test (≈3 s of CPU) took ~90 s of wall time, so this
 *  leaves room for a machine several times busier than that. */
export const CPU_BOUND_WALL_LIMIT_MS = 600_000;


/** CPU each test in a CPU-bound group may use: the 30 s the suite allows in wall time, now
 *  charged in CPU. Alone the heaviest of these use ~1.5-3 s (measured 2026-10-07, quiet
 *  machine); contention inflates a process's own CPU time 2-4× (tests/helpers/render-cost.ts),
 *  so a correct test stays far under it, while a cost turning per-message (n² → n³) overshoots. */
export const CPU_BOUND_CPU_BUDGET_MS = 30_000;

/** Call inside a `describe` whose tests are pure CPU work: every test in it fails if it used
 *  more than `budgetMs` of CPU. Give the describe `{ timeout: CPU_BOUND_WALL_LIMIT_MS }` so the
 *  wall clock only catches a hang. */
export function budgetCpuPerTest(budgetMs = CPU_BOUND_CPU_BUDGET_MS): void {
  let start: NodeJS.CpuUsage | null = null;
  beforeEach(() => { start = process.cpuUsage(); });
  afterEach((ctx) => {
    if (!start) return;
    const used = process.cpuUsage(start);
    start = null;
    const ms = (used.user + used.system) / 1000;
    expect(ms, `"${ctx.task.name}" used ${Math.round(ms)} ms of CPU (budget ${budgetMs} ms)`).toBeLessThanOrEqual(budgetMs);
  });
}
