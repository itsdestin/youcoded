// @vitest-environment jsdom
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { GLASS_PERSIST_MS, ThemeProvider, useTheme } from '../src/renderer/state/theme-context';
import midnight from '../src/renderer/themes/builtin/midnight.json';

const slug = 'devils-garden';
const raw = JSON.stringify({ ...midnight, slug, name: 'Devils Garden' });
let installed: string[];
let sync: Array<(prefs: { theme: string }) => void>;
let reload: Array<(slug: string) => void>;
let read: ReturnType<typeof vi.fn>;
let persist: ReturnType<typeof vi.fn>;
let broadcast: ReturnType<typeof vi.fn>;
const wrapper = ({ children }: { children: React.ReactNode }) => <ThemeProvider>{children}</ThemeProvider>;
const mount = () => renderHook(() => useTheme(), { wrapper });
const flush = async () => { await act(async () => {}); };
beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  installed = []; sync = []; reload = [];
  read = vi.fn(async () => raw);
  persist = vi.fn();
  broadcast = vi.fn((prefs) => sync.forEach(cb => cb(prefs)));
  (window as any).claude = {
    theme: { list: vi.fn(async () => [...installed]), readFile: read,
      onReload: (cb: (slug: string) => void) => { reload.push(cb); return () => {}; } },
    appearance: { get: vi.fn(async () => null), set: persist, broadcast,
      onSync: (cb: (prefs: { theme: string }) => void) => { sync.push(cb); return () => {}; } },
  };
});
it.each(['before reload', 'during reload', 'after reload'])('two providers apply a newly installed theme: sync %s', async order => {
  const main = mount(); const buddy = mount(); await flush();
  installed = [slug];
  await act(async () => { await main.result.current.reloadUserThemes(); });
  let finish!: (raw: string) => void;
  if (order === 'during reload') {
    read.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
    act(() => reload[1](slug));
  }
  if (order === 'after reload') { act(() => reload[1](slug)); await flush(); }
  act(() => main.result.current.setTheme(slug));
  if (order === 'during reload') { read.mockResolvedValue(raw); await act(async () => finish(raw)); }
  await waitFor(() => expect(buddy.result.current.activeTheme.slug).toBe(slug));
  expect(main.result.current.theme).toBe(slug);
  expect(persist.mock.calls).toEqual([[{ theme: slug }]]);
});
it.each(['resolve', 'reject'])('late incoming read cannot override a user selection (%s)', async outcome => {
  const buddy = mount(); await flush();
  let resolve!: (raw: string) => void; let reject!: (e: Error) => void;
  read.mockImplementation(() => new Promise<string>((a, b) => { resolve = a; reject = b; }));
  act(() => sync[0]({ theme: slug }));
  act(() => buddy.result.current.setTheme('dark'));
  await act(async () => { if (outcome === 'resolve') resolve(raw); else reject(new Error('missing')); });
  expect(buddy.result.current.theme).toBe('dark');
  expect(persist.mock.calls).toEqual([[{ theme: 'dark' }]]);
});
it('unknown peer theme never persists a fallback, and a newer sync wins', async () => {
  const buddy = mount(); await flush();
  read.mockRejectedValue(new Error('missing'));
  act(() => sync[0]({ theme: slug })); await flush();
  expect(persist).not.toHaveBeenCalled();
  act(() => sync[0]({ theme: 'dark' })); await flush();
  expect(buddy.result.current.theme).toBe('dark');
});
it.each([false, true])('cycling cancels a delayed incoming theme (preview exit: %s)', async preview => {
  const buddy = mount(); await flush();
  if (preview) {
    read.mockResolvedValueOnce(JSON.stringify({ ...midnight, slug: '_preview' }));
    act(() => reload[0]('_preview')); await flush();
    expect(buddy.result.current.theme).toBe('_preview');
  }
  let finish!: (raw: string) => void;
  read.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
  act(() => sync[0]({ theme: slug }));
  // Real IPC excludes the originating window from its own broadcast.
  broadcast.mockImplementation(() => {});
  act(() => buddy.result.current.cycleTheme());
  const chosen = buddy.result.current.theme;
  await act(async () => finish(raw));
  expect(buddy.result.current.theme).toBe(chosen);
});
it('a newer unknown sync wins over an older delayed read', async () => {
  const buddy = mount(); await flush();
  let finish!: (raw: string) => void;
  read.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
  act(() => sync[0]({ theme: slug }));
  const newer = 'newer-theme';
  read.mockResolvedValue(JSON.stringify({ ...midnight, slug: newer }));
  act(() => sync[0]({ theme: newer })); await flush();
  await act(async () => finish(raw));
  expect(buddy.result.current.activeTheme.slug).toBe(newer);
  expect(persist).not.toHaveBeenCalled();
});
it('late startup preferences cannot override a user selection', async () => {
  let finish!: (prefs: { theme: string }) => void;
  (window as any).claude.appearance.get = () => new Promise(resolve => { finish = resolve; });
  const buddy = mount(); await flush();
  act(() => buddy.result.current.setTheme('dark'));
  await act(async () => finish({ theme: slug }));
  expect(buddy.result.current.theme).toBe('dark');
});
it('explicit refresh still resets an uninstalled active theme', async () => {
  installed = [slug]; const main = mount(); await flush();
  act(() => main.result.current.setTheme(slug)); await flush(); persist.mockClear();
  installed = [];
  await act(async () => { await main.result.current.reloadUserThemes(); });
  expect(main.result.current.theme).toBe('midnight');
  expect(persist).toHaveBeenCalledWith({ theme: 'midnight' });
});

// Perf B11 (2026-09-24): a glass-slider drag calls setGlassOverride every tick,
// and each disk write blocks the main process. The screen and peer windows
// update per tick; the disk write is a trailing throttle that never loses the
// final value.
const glassWrites = () => persist.mock.calls.filter(([p]) => 'glassOverrides' in p).map(([p]) => p.glassOverrides);
it('a glass-slider drag updates live per tick but writes to disk at most once per throttle window, ending on the last value', async () => {
  const main = mount(); await flush();
  vi.useFakeTimers();
  try {
    broadcast.mockImplementation(() => {}); // real IPC excludes the origin window
    for (let v = 1; v <= 10; v++) act(() => main.result.current.setGlassOverride('midnight', 'blur', v));
    // Live: every tick reached peers at once; nothing written yet.
    expect(broadcast).toHaveBeenCalledTimes(10);
    expect(broadcast).toHaveBeenLastCalledWith({ glassOverrides: { midnight: { blur: 10 } } });
    expect(glassWrites()).toEqual([]);
    act(() => { vi.advanceTimersByTime(GLASS_PERSIST_MS); });
    expect(glassWrites()).toEqual([{ midnight: { blur: 10 } }]);
    // A long drag keeps saving every window, not only once it stops.
    for (let v = 11; v <= 20; v++) {
      act(() => main.result.current.setGlassOverride('midnight', 'blur', v));
      act(() => { vi.advanceTimersByTime(GLASS_PERSIST_MS / 5); });
    }
    act(() => { vi.advanceTimersByTime(GLASS_PERSIST_MS); });
    const writes = glassWrites();
    // 10 ticks over 2 throttle windows: the first write plus at most 3 more, not 10.
    expect(writes.length).toBeLessThanOrEqual(4);
    expect(writes.length).toBeGreaterThan(1);
    expect(writes.at(-1)).toEqual({ midnight: { blur: 20 } });
    act(() => { vi.advanceTimersByTime(GLASS_PERSIST_MS * 5); });
    expect(glassWrites().length).toBe(writes.length); // idle after the last write
  } finally { vi.useRealTimers(); }
});
it.each(['unmount', 'beforeunload', 'pagehide'])('a pending glass write is flushed on %s', async how => {
  const main = mount(); await flush();
  vi.useFakeTimers();
  try {
    broadcast.mockImplementation(() => {});
    act(() => main.result.current.setGlassOverride('midnight', 'opacity', 0.4));
    act(() => main.result.current.setGlassOverride('midnight', 'opacity', 0.7));
    expect(glassWrites()).toEqual([]);
    if (how === 'unmount') main.unmount();
    else window.dispatchEvent(new Event(how));
    expect(glassWrites()).toEqual([{ midnight: { opacity: 0.7 } }]);
    act(() => { vi.advanceTimersByTime(GLASS_PERSIST_MS * 2); });
    expect(glassWrites()).toHaveLength(1); // the flush cancelled the timer
  } finally { vi.useRealTimers(); }
});
it('a newer glass edit from a peer window cancels our older pending write', async () => {
  const main = mount(); await flush();
  vi.useFakeTimers();
  try {
    broadcast.mockImplementation(() => {});
    act(() => main.result.current.setGlassOverride('midnight', 'blur', 3));
    act(() => sync[0]({ glassOverrides: { midnight: { blur: 3, opacity: 0.5 } } } as any));
    act(() => { vi.advanceTimersByTime(GLASS_PERSIST_MS * 2); });
    expect(glassWrites()).toEqual([]);
  } finally { vi.useRealTimers(); }
});
