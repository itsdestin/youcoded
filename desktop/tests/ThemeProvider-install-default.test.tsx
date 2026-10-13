// @vitest-environment jsdom
// Pins final review F1 (blocker), the screen's half: a long-time user who never picked a theme stays on
// Midnight (and the old Midnight/Dark cycle) after the update; only a new install opens on the YouCoded pair.
// The host's recorded answer arrives through appearance:get as `defaultTheme`.
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from '../src/renderer/state/theme-context';

let storage: Map<string, string>;
let prefs: Record<string, unknown> | null;
let dark: boolean;
let persist: ReturnType<typeof vi.fn>;
const wrapper = ({ children }: { children: React.ReactNode }) => <ThemeProvider>{children}</ThemeProvider>;
const mount = () => renderHook(() => useTheme(), { wrapper });
const flush = async () => { await act(async () => {}); };

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k), key: (i: number) => [...storage.keys()][i] ?? null,
    get length() { return storage.size; },
  });
  dark = false;
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('dark') ? dark : false, addEventListener() {}, removeEventListener() {} }));
  (window as any).matchMedia = (globalThis as any).matchMedia;
  prefs = null;
  persist = vi.fn();
  (window as any).claude = {
    theme: { list: vi.fn(async () => []), readFile: vi.fn(async () => { throw new Error('none'); }), onReload: () => () => {} },
    appearance: { get: vi.fn(async () => prefs), set: persist, broadcast: vi.fn(), onSync: () => () => {} },
  };
});

it('an existing install that never picked a theme stays on Midnight with the old cycle', async () => {
  storage.set('youcoded-show-timestamps', '1'); // an install that has run before
  prefs = { defaultTheme: 'midnight', reducedEffects: false };
  const { result } = mount(); await flush();
  await waitFor(() => expect(result.current.theme).toBe('midnight'));
  expect(result.current.cycleList).toEqual(['midnight', 'dark']);
  // Showing the default is not a choice: nothing is saved for every screen.
  expect(persist).not.toHaveBeenCalled();
});

it('even when its storage is empty (a phone browser seeing this computer for the first time), the host answer wins', async () => {
  prefs = { defaultTheme: 'midnight' };
  dark = false;
  const { result } = mount(); await flush();
  await waitFor(() => expect(result.current.theme).toBe('midnight'));
  expect(result.current.cycleList).toEqual(['midnight', 'dark']);
});

it.each([[false, 'youcoded'], [true, 'youcoded-night']])('a new install opens on the YouCoded pair (dark computer: %s)', async (isDark, slug) => {
  dark = isDark;
  prefs = { defaultTheme: 'youcoded' };
  const { result } = mount(); await flush();
  await waitFor(() => expect(result.current.theme).toBe(slug));
  expect(result.current.cycleList).toEqual(['youcoded', 'youcoded-night']);
});

it('a theme already chosen is kept whichever default the install is on', async () => {
  storage.set('youcoded-theme', 'creme');
  prefs = { defaultTheme: 'youcoded', theme: 'creme' };
  const { result } = mount(); await flush();
  expect(result.current.theme).toBe('creme');
});

it('an existing install whose theme was uninstalled falls back to Midnight, not the new default', async () => {
  storage.set('youcoded-theme', 'gone-theme');
  storage.set('youcoded-theme-default', 'midnight');
  prefs = { defaultTheme: 'midnight' };
  const { result } = mount(); await flush();
  await waitFor(() => expect(result.current.theme).toBe('midnight'));
});
