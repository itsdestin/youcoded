// @vitest-environment jsdom
// desktop/tests/drawer-width.test.ts
//
// jsdom because this module now writes CSS vars on <html> and reads
// localStorage — the two independent right-pane widths (artifact drawer vs
// games pane) are only meaningfully testable against a real document.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import {
  clampDrawerWidth, DEFAULT_DRAWER_WIDTH, MIN_DRAWER_WIDTH,
  applyPaneWidthVar, applyDrawerWidthVar, applyGameWidthVar,
  DRAWER_WIDTH_KEY, DRAWER_WIDTH_VAR,
  GAME_WIDTH_KEY, GAME_WIDTH_VAR, DEFAULT_GAME_WIDTH,
  hasStoredGameWidth, gameWidthForOpen,
} from '../src/renderer/state/drawer-width';

// Pins the resize guardrails from the 2026-07-16 spec: min 320px, max 60% of
// the window, non-finite input falls back to the 480px default, and the
// result is always an integer (CSS px).
describe('clampDrawerWidth', () => {
  it('passes through an in-range width, rounded to an integer', () => {
    expect(clampDrawerWidth(600.4, 1920)).toBe(600);
  });

  it('clamps below the 320px minimum up to the minimum', () => {
    expect(clampDrawerWidth(100, 1920)).toBe(MIN_DRAWER_WIDTH);
    expect(MIN_DRAWER_WIDTH).toBe(320);
  });

  it('clamps above 60% of the window width down to that ceiling', () => {
    expect(clampDrawerWidth(2000, 1920)).toBe(Math.floor(1920 * 0.6));
  });

  it('never lets the ceiling drop below the minimum on tiny windows', () => {
    // 60% of 400px = 240 < 320 — the min wins so the drawer stays usable.
    expect(clampDrawerWidth(999, 400)).toBe(MIN_DRAWER_WIDTH);
  });

  it('falls back to the 480px default for non-finite input (corrupt localStorage)', () => {
    expect(clampDrawerWidth(NaN, 1920)).toBe(DEFAULT_DRAWER_WIDTH);
    expect(clampDrawerWidth(Infinity, 1920)).toBe(DEFAULT_DRAWER_WIDTH); // Infinity is non-finite too
  });
});

// The whole point of the games-arcade §4.3 change: TWO widths that cannot
// touch each other. A regression here means resizing a chess board silently
// resizes the user's document drawer.
// Node 24 defines a global `localStorage` that is undefined unless the process
// was started with --localstorage-file, and it shadows jsdom's — measured here:
// both `globalThis.localStorage` and `window.localStorage` come back undefined
// under this suite's jsdom environment. The module under test reads the bare
// global (as all renderer code does), so stand up a Map-backed stand-in.
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

describe('the two right-pane widths are independent', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('style');
  });

  it('uses distinct storage keys and distinct CSS vars', () => {
    expect(DRAWER_WIDTH_KEY).toBe('youcoded-drawer-width');
    expect(GAME_WIDTH_KEY).toBe('youcoded-game-pane-width');
    expect(DRAWER_WIDTH_VAR).toBe('--drawer-width');
    expect(GAME_WIDTH_VAR).toBe('--game-pane-width');
    expect(DEFAULT_GAME_WIDTH).toBe(420);
  });

  it('writing one pane width leaves the other var untouched', () => {
    applyDrawerWidthVar(480);
    applyGameWidthVar(520);
    const style = document.documentElement.style;
    expect(style.getPropertyValue(DRAWER_WIDTH_VAR)).toBe('480px');
    expect(style.getPropertyValue(GAME_WIDTH_VAR)).toBe('520px');

    applyGameWidthVar(600);
    expect(style.getPropertyValue(DRAWER_WIDTH_VAR)).toBe('480px'); // unmoved
    expect(style.getPropertyValue(GAME_WIDTH_VAR)).toBe('600px');
  });

  it('applyPaneWidthVar is the one writer both flavours go through', () => {
    applyPaneWidthVar('--made-up-width', 333);
    expect(document.documentElement.style.getPropertyValue('--made-up-width')).toBe('333px');
  });

  it('skips a write that would not change the width var', () => {
    // Each write to a var on <html> restyles the whole page; a drag that pins at
    // the min/max keeps producing the same width, so only real changes may write.
    const spy = vi.spyOn(document.documentElement.style, 'setProperty');
    applyDrawerWidthVar(500);
    applyDrawerWidthVar(500);
    applyDrawerWidthVar(501);
    expect(spy.mock.calls.filter(([name]) => name === DRAWER_WIDTH_VAR).map(([, v]) => v))
      .toEqual(['500px', '501px']);
    spy.mockRestore();
    // A var removed from under it is written again, not wrongly skipped.
    document.documentElement.style.removeProperty(DRAWER_WIDTH_VAR);
    applyDrawerWidthVar(501);
    expect(document.documentElement.style.getPropertyValue(DRAWER_WIDTH_VAR)).toBe('501px');
  });

  it('shares one clamp, so neither pane can be thinner or wider than the other allows', () => {
    expect(clampDrawerWidth(100, 1920)).toBe(MIN_DRAWER_WIDTH);
    expect(clampDrawerWidth(2000, 1920)).toBe(Math.floor(1920 * 0.6));
  });
});

// "Never resized" is stored as the ABSENCE of the key — never inferred from the
// value, so a user who deliberately drags to exactly 420 keeps that choice.
describe('per-game default width', () => {
  beforeEach(() => { localStorage.clear(); });

  it('reports never-resized while the key is absent', () => {
    expect(hasStoredGameWidth()).toBe(false);
    expect(gameWidthForOpen(520, DEFAULT_GAME_WIDTH)).toBe(520); // chess opens wide
    expect(gameWidthForOpen(420, DEFAULT_GAME_WIDTH)).toBe(420); // flappy opens narrow
  });

  it("once the key exists the user's width wins, even at the default value", () => {
    localStorage.setItem(GAME_WIDTH_KEY, String(DEFAULT_GAME_WIDTH));
    expect(hasStoredGameWidth()).toBe(true);
    // Chess would prefer 520, but the user chose 420 by hand — respect it.
    expect(gameWidthForOpen(520, DEFAULT_GAME_WIDTH)).toBe(DEFAULT_GAME_WIDTH);
  });

  it('removing the key hands control back to the per-game defaults', () => {
    localStorage.setItem(GAME_WIDTH_KEY, '700');
    expect(gameWidthForOpen(520, 700)).toBe(700);
    localStorage.removeItem(GAME_WIDTH_KEY);
    expect(gameWidthForOpen(520, 700)).toBe(520);
  });
});
