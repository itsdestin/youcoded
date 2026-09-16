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
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, sep } from 'path';
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { stripComments } from './helpers/guard-scope';
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

// ── Source-scan guards ────────────────────────────────────────────────────
// Same house pattern as the *-authority suites: read the tree at runtime so the
// assertion cannot go stale when a file moves.

const SRC = join(__dirname, '..', 'src');
const RENDERER = join(SRC, 'renderer');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const read = (path: string) => stripComments(readFileSync(path, 'utf8'));

describe('runtime default — source guards', () => {
  it('(e) exactly one file under src mentions youcoded-runtime-default (RuntimeBinding.tsx)', () => {
    // Review T5b F1: match the KEY STRING, not one spelling of the write — a
    // `setItem(KEY, …)` through a const, double quotes, or `window.localStorage`
    // would all slip past a literal-call match. Any file that so much as names
    // the key is either the one reader/writer pair or a new direct access.
    const mentions = walk(SRC)
      .filter((path) => read(path).includes(KEY))
      // Fix (2026-09-05): the expected value below is written with forward
      // slashes, but `join()` builds these paths with the PLATFORM separator —
      // so on Windows this compared "\\renderer\\components\\…" against
      // "/renderer/components/…" and the guard failed for a reason that has
      // nothing to do with what it guards. Windows CI had been red on master
      // since a8062964 landed. Normalise to forward slashes before comparing.
      .map((path) => path.replace(SRC, '').split(sep).join('/'));
    expect(
      mentions,
      'The install-wide runtime default has ONE reader/writer pair: defaultRuntime() and '
        + 'persistRuntimeDefault() in RuntimeBinding.tsx. Call those; never touch the key directly.',
    ).toEqual(['/renderer/components/RuntimeBinding.tsx']);
  });

  it('(f) both forms initialise from defaultRuntime() and reset to it after a create', () => {
    const forms = [
      { name: 'SessionStrip.tsx', src: read(join(RENDERER, 'components', 'SessionStrip.tsx')), setter: 'setRuntime', close: 'setShowNewForm(false)' },
      { name: 'App.tsx', src: read(join(RENDERER, 'App.tsx')), setter: 'setWelcomeRuntime', close: 'setWelcomeFormOpen(false)' },
    ];
    for (const { name, src, setter, close } of forms) {
      // Initialiser: no literal 'claude' seed; the lazy defaultRuntime() one instead.
      expect(src, `${name} still seeds its runtime with the literal 'claude'`).not.toMatch(/useState<Runtime>\(\s*'claude'\s*\)/);
      expect(src, `${name} must initialise its runtime from defaultRuntime()`).toMatch(/useState<Runtime>\(\s*\(\)\s*=>\s*defaultRuntime\(\)\s*\)/);
      // Post-create reset: the block that closes the form must reset to the
      // default, never the literal (R2-3). The only literal `setter('claude')`
      // allowed anywhere is the user's own explicit pick in applyModelChoice.
      // The form closes in more than one place (cancel, escape, create), so check
      // the 600 chars after EVERY close: none may reset to the literal, and at
      // least one (the create path) must reset to the default.
      const tails: string[] = [];
      for (let i = src.indexOf(close); i !== -1; i = src.indexOf(close, i + 1)) tails.push(src.slice(i, i + 600));
      expect(tails.length, `${name}: form close ${close} not found`).toBeGreaterThan(0);
      for (const tail of tails) {
        expect(tail, `${name} resets to the literal 'claude' after a create (R2-3)`).not.toContain(`${setter}('claude')`);
      }
      expect(
        tails.some((tail) => tail.includes(`${setter}(defaultRuntime())`)),
        `${name} must reset to defaultRuntime() after a create`,
      ).toBe(true);
      const literals = src.split(`${setter}('claude')`).length - 1;
      expect(literals, `${name}: only applyModelChoice may set the literal 'claude' runtime`).toBeLessThanOrEqual(1);
    }
  });
});
