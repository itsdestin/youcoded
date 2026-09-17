// @vitest-environment jsdom
// The code-block colour sheet for the theme polarity NOT in use is never
// loaded (2026-09-16 audit W25). Both highlight.js stylesheets used to be
// static imports in the entry bundle; a module mock records when each one is
// actually evaluated.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

const loaded = vi.hoisted(() => ({ dark: 0, light: 0 }));
vi.mock('highlight.js/styles/github-dark.css?inline', () => { loaded.dark++; return { default: '.hljs{background:#0d1117}' }; });
vi.mock('highlight.js/styles/github.css?inline', () => { loaded.light++; return { default: '.hljs{background:#ffffff}' }; });

import { ThemeProvider } from '../src/renderer/state/theme-context';

beforeEach(() => {
  loaded.dark = 0;
  loaded.light = 0;
  document.getElementById('hljs-theme')?.remove();
  (window as any).localStorage = {
    _s: {} as Record<string, string>,
    getItem(k: string) { return this._s[k] ?? null; },
    setItem(k: string, v: string) { this._s[k] = v; },
    removeItem(k: string) { delete this._s[k]; },
  };
  (window as any).claude = {
    appearance: { get: async () => ({}), set: async () => {}, onSync: () => () => {}, getFavoriteThemes: async () => [] },
    theme: { list: async () => [], onReload: () => () => {} },
    on: {},
  };
});

afterEach(() => {
  cleanup();
  delete (window as any).claude;
});

describe('the highlight.js stylesheet and the inactive polarity', () => {
  it('importing the theme module loads neither sheet; applying the default theme loads only its own polarity, then the other on idle', async () => {
    // jsdom has no requestIdleCallback, so the preload rides the setTimeout
    // fallback; fake only that so the assertion order is under our control.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      expect(loaded).toEqual({ dark: 0, light: 0 });
      render(<ThemeProvider><div /></ThemeProvider>);
      // The dynamic import settles on microtasks, not timers.
      for (let i = 0; i < 10 && !document.getElementById('hljs-theme')?.textContent; i++) {
        await act(async () => { await Promise.resolve(); });
      }
      const applied = document.getElementById('hljs-theme')!.textContent!;
      expect(applied).toMatch(/#0d1117|#ffffff/);
      expect(loaded.dark + loaded.light).toBe(1);
      const activeDark = loaded.dark === 1;
      expect(applied).toContain(activeDark ? '#0d1117' : '#ffffff');

      // Idle preload: the OTHER sheet loads, and the applied one does not change.
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(loaded).toEqual({ dark: 1, light: 1 });
      expect(document.getElementById('hljs-theme')!.textContent).toBe(applied);
    } finally {
      vi.useRealTimers();
    }
  });
});
