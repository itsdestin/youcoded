// Per-test-file DOM setup (vitest `setupFiles`).
import { afterEach } from 'vitest';
import { __resetTagRegistryForTests } from '../src/renderer/hooks/useTagRegistry';

//
// jsdom ships no ResizeObserver. Several components observe their own size --
// most notably useScrollFade, which every <Dialog> now runs because Dialog owns
// its scroll region. Before this, each test that happened to render such a
// component hand-rolled the same three-method stub; four of them already did,
// and D1's dialog migration would have required it in a dozen more.
//
// Stubbing it here instead means a test fails for a reason about the component,
// not about a missing browser API. The stub is inert on purpose: no test in this
// suite asserts on resize-driven behaviour, and a fake that fired callbacks
// would invent layout events jsdom cannot actually produce.
if (typeof globalThis.window !== 'undefined' && typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as any).ResizeObserver = ResizeObserverStub;
  (globalThis.window as any).ResizeObserver = ResizeObserverStub;
}

// Unmount every React tree at the end of each test.
//
// WHY this is here and not in each test file: without it, a component left
// mounted when the file finishes can still have work queued in React's
// scheduler (which defers via setImmediate). Vitest then tears the jsdom
// environment down — deleting `window` — and the queued render lands in a dead
// environment as `ReferenceError: window is not defined`, thrown from inside
// react-dom with no reference to any test. Vitest reports it as an "Unhandled
// Error", which fails the RUN while every test in the file shows as passed, so
// the red gives you nothing to go on. It only fires when the machine is loaded
// enough for teardown to overtake the queued work, which is why it looked like
// random flake (ROADMAP 2026-08-27: three .tsx files, always a different set).
//
// 18 of the 113 .tsx test files never unmounted anything. Doing it centrally
// fixes the whole class instead of the three files that happened to be caught,
// and matches what `globals: true` would have given us via testing-library's
// own auto-cleanup (this suite deliberately does not enable globals).
//
// Inert under the 'node' environment: the guard returns before the import, so
// node-environment files never load React DOM. The dynamic import is resolved
// once and cached by the module registry.
afterEach(async () => {
  if (typeof globalThis.window === 'undefined') return;
  const { cleanup } = await import('@testing-library/react');
  cleanup();
  // WHY here, not per file: useTagRegistry is one module-level store now (render-cost
  // consolidation 2026-09-18) — a registry loaded by test A in a file is still there for
  // test B in the same file otherwise, and a forgotten per-file reset leaks one test's
  // tags into the next with a failure that names neither. One line here cannot be
  // forgotten.
  __resetTagRegistryForTests();
});
