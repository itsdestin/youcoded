// @vitest-environment jsdom
// Guards the remembered runtime default for the two new-session forms
// (RuntimeBinding.defaultRuntime / persistRuntimeDefault).
//
// Why this matters: an install that was set up by signing in with ChatGPT has
// no Claude login. If either new-session form opened on "Claude Code", the
// user's next session would fail to start. Since 2026-09-07 the key is honoured
// unconditionally — no provider is the app's fallback (deck step P-3). The first-run completion path
// stores 'native' under `youcoded-runtime-default`; BOTH forms must read it for
// their initial runtime AND for the reset they do after every create (review
// R2-3: a reset to the literal 'claude' made the default last one session).
//
// WHY no source-scan cases here any more (Plan B, 2026-09-16): "one file owns the
// key" and "both forms open on, and reset to, defaultRuntime()" are the ast-grep
// rules runtime-default-key-single-owner (+ -tsx, -present) and
// new-session-forms-use-default-runtime in the workspace's scripts/ast-grep/rules/.
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { defaultRuntime, persistRuntimeDefault } from '../src/renderer/components/RuntimeBinding';

const KEY = 'youcoded-runtime-default';

// jsdom exposes no usable `localStorage` here (same as drawer-width.test.ts), and
// RuntimeBinding reads the bare global like all renderer code, so stand up a
// Map-backed stand-in once for the file.
beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, writable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
    },
  });
});

// isNativeSupported() = desktop platform (not Android) + local connection (the
// module default) + the main-process capability flag on window.claude.
function stubNative(supported: boolean) {
  (window as any).__PLATFORM__ = 'electron';
  (window as any).claude = { native: { supported } };
}

describe('defaultRuntime()', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => {
    localStorage.clear();
    delete (window as any).claude;
    delete (window as any).__PLATFORM__;
  });

  it('(a) no stored key → claude', () => {
    stubNative(true);
    expect(defaultRuntime()).toBe('claude');
  });

  it('(b) stored native + native supported → native', () => {
    stubNative(true);
    localStorage.setItem(KEY, 'native');
    expect(defaultRuntime()).toBe('native');
  });

  it('(c) stored native + native unsupported → STILL native (Destin, 2026-09-07: nothing falls back to Claude Code)', () => {
    // This pinned the opposite until 2026-09-07. The old rule (R3-6) sent an
    // install whose non-Claude side is switched off back to Claude Code so its
    // forms stayed usable; Destin overruled it on deck step P-3 — "i never want
    // to 'default' back to claude code when the chosen models are unavailable.
    // all providers should be equal/neutral". The user instead meets the model
    // menu's "You have not set up any model providers." and its Add provider
    // button, which is a way out that does not choose an engine for them.
    stubNative(false);
    localStorage.setItem(KEY, 'native');
    expect(defaultRuntime()).toBe('native');
    stubNative(true);
    (window as any).__PLATFORM__ = 'android';
    expect(defaultRuntime()).toBe('native');
  });

  it('(d) persistRuntimeDefault writes the key', () => {
    persistRuntimeDefault('native');
    expect(localStorage.getItem(KEY)).toBe('native');
    persistRuntimeDefault('claude');
    expect(localStorage.getItem(KEY)).toBe('claude');
  });
});
