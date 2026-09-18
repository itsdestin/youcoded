// Raises the DEFAULT timeout of `vi.waitFor` / `vi.waitUntil` suite-wide.
//
// WHY THIS FILE EXISTS: vitest hardcodes both defaults to 1,000ms
// (`node_modules/vitest/dist/chunks/test.*.js` — `const { interval = 50,
// timeout = 1e3 }`) and exposes NO config option for them, unlike `testTimeout`
// and `hookTimeout`. So raising the suite budget to 30s in vitest.config.ts did
// nothing for the ~60 bare `vi.waitFor(...)` calls across 13 test files: each
// still gave up after one second.
//
// That is not a theoretical gap. On 2026-08-28, with the suite otherwise green,
// `specialist-run.test.ts` failed on Windows CI with `expected 'running' to be
// 'completed'` inside a `vi.waitFor` — a background specialist streaming ~69,000
// characters had simply not finished within the 1s default on a loaded runner.
// It reads as a logic bug (the run "didn't complete"), which is the same
// misattribution that made the timeout family expensive to diagnose in the first
// place.
//
// WHY A WRAPPER AND NOT ~60 EDITS: the number is a property of the machine's
// load, not of any individual assertion, so it belongs in one place — this is
// the config option vitest does not offer. An explicit per-call timeout still
// wins (it is spread AFTER the default below), so a test that deliberately
// asserts "this settles fast" keeps its tight budget, and a numeric-shorthand
// call (`vi.waitFor(cb, 250)`) passes through untouched.
//
// The cost: a condition that never becomes true now takes 15s to report instead
// of 1s. It still fails well inside the 30s testTimeout, and still fails with
// the callback's own last assertion error rather than a bare timeout, so the
// diagnostic quality is unchanged.
import { vi } from 'vitest';

/** Deliberately below vitest.config.ts's 30s testTimeout: a waitFor that gives
 *  up must lose to its own condition's error message, not to the test timeout,
 *  which reports nothing about what was being waited for. */
const DEFAULT_WAIT_FOR_MS = 15_000;

type WaitOptions = { timeout?: number; interval?: number };

function withDefaultTimeout<F extends (cb: never, options?: number | WaitOptions) => unknown>(original: F): F {
  return ((callback: never, options?: number | WaitOptions) =>
    original(
      callback,
      // A number is vitest's timeout shorthand — already explicit, leave it be.
      typeof options === 'number' ? options : { timeout: DEFAULT_WAIT_FOR_MS, ...options },
    )) as F;
}

vi.waitFor = withDefaultTimeout(vi.waitFor);
vi.waitUntil = withDefaultTimeout(vi.waitUntil);

// The same budget for @testing-library's `waitFor` / `findBy*`, which keep their
// OWN 1,000ms default (`asyncUtilTimeout`) that the wrapper above never touches.
// WHY (2026-09-16): the ResumeBrowser native-resume tests failed twice in full
// local runs at load average 56 — `waitFor(… toHaveTextContent('GPT-5'))` gave
// up after one second while the file took 7.7s, and passed 3/3 alone. 206 test
// files use the library; one setting covers them all. Explicit `{ timeout }`
// still wins. Only in jsdom files, so node-environment files never load React DOM.
if (typeof globalThis.window !== 'undefined') {
  const { configure } = await import('@testing-library/react');
  configure({ asyncUtilTimeout: DEFAULT_WAIT_FOR_MS });
}
