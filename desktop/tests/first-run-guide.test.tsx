// @vitest-environment jsdom
//
// Pins the first-run guide's three promises (design 2026-09-10, §4–5):
//   1. only the wizard's hand-off owes a tour — an existing install never sees
//      it uninvited (deck Q-11, fresh installs only);
//   2. tips fire once each, at most one per sitting, and only while armed;
//   3. the tour walks its stops with Next/Back, opens each stop's screen, and
//      Skip vs Done tell the app apart.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

// jsdom here ships NO localStorage (see first-time-warnings.test.ts); a real
// Map-backed one stands in, so the state module is tested, not mocked.
const store = new Map<string, string>();
const localStorageShim = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
for (const target of [globalThis, window]) {
  Object.defineProperty(target, 'localStorage', { value: localStorageShim, configurable: true, writable: true });
}

// The bubble renders the theme's mascot, which needs the theme context; the
// mascot is not what these tests pin.
vi.mock('../src/renderer/components/Icons', () => ({
  ThemeMascot: () => <span data-testid="mascot" />,
  WelcomeAppIcon: () => null,
}));

import {
  armGuideForFreshInstall, bumpCounter, guideDoneAt, isGuidePending, markGuideDone,
  resetGuideState, setTipsArmed, tipSeen, tipsArmed,
} from '../src/renderer/components/guide/guide-state';
import { dismissTip, resetTipsForSitting, stopAllTips, triggerTip, TIPS } from '../src/renderer/components/guide/tips';
import GuideTour from '../src/renderer/components/guide/GuideTour';
import type { GuideStop } from '../src/renderer/components/guide/guide-stops';

beforeEach(() => { resetGuideState(); resetTipsForSitting(); });
afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('guide state', () => {
  it('owes a tour only after the wizard hands off, and settles it on done', () => {
    expect(isGuidePending()).toBe(false);
    armGuideForFreshInstall();
    expect(isGuidePending()).toBe(true);
    expect(tipsArmed()).toBe(true);
    markGuideDone();
    expect(isGuidePending()).toBe(false);
    expect(guideDoneAt()).not.toBeNull();
  });

  it('counts launches and sessions separately', () => {
    expect(bumpCounter('launches')).toBe(1);
    expect(bumpCounter('launches')).toBe(2);
    expect(bumpCounter('sessions-started')).toBe(1);
  });
});

describe('tips', () => {
  it('refuse to fire until armed, then fire once each and one per sitting', () => {
    expect(triggerTip('tags')).toBe(false);
    setTipsArmed(true);
    expect(triggerTip('tags')).toBe(true);
    expect(triggerTip('notes')).toBe(false); // one bubble at a time
    dismissTip();
    expect(tipSeen('tags')).toBe(true);
    expect(triggerTip('notes')).toBe(false); // and one per sitting
    resetTipsForSitting();
    expect(triggerTip('tags')).toBe(false);  // never twice
    expect(triggerTip('notes')).toBe(true);
  });

  it('"Stop showing tips" disarms them for good', () => {
    setTipsArmed(true);
    expect(triggerTip('tags')).toBe(true);
    stopAllTips();
    expect(tipsArmed()).toBe(false);
    resetTipsForSitting();
    expect(triggerTip('notes')).toBe(false);
  });

  it('every tip has an id and a sentence a student can read', () => {
    for (const t of TIPS) {
      expect(t.id).toMatch(/^[a-z-]+$/);
      expect(t.text.length).toBeGreaterThan(20);
      expect(t.text.length).toBeLessThan(200);
    }
  });
});

const STOPS: GuideStop[] = [
  { id: 'a', text: 'First stop.', screen: 'welcome', pose: 'welcome' },
  { id: 'b', text: 'Second stop.', screen: 'projects', anchor: 'nothing-here', pose: 'inquisitive' },
];

describe('GuideTour', () => {
  it('opens each stop\'s screen, walks Next/Back, and tells Skip from Done', () => {
    const onOpenScreen = vi.fn();
    const onExit = vi.fn();
    render(<GuideTour stops={STOPS} onOpenScreen={onOpenScreen} onExit={onExit} />);
    expect(onOpenScreen).toHaveBeenLastCalledWith('welcome');
    expect(screen.getByText('1 of 2')).toBeTruthy();
    expect(screen.queryByText('Back')).toBeNull();

    fireEvent.click(screen.getByText('Next'));
    expect(onOpenScreen).toHaveBeenLastCalledWith('projects');
    expect(screen.getByText('Second stop.')).toBeTruthy();
    // The last stop offers Done, and no Skip — there is nothing left to skip.
    expect(screen.queryByText('Skip tour')).toBeNull();

    fireEvent.click(screen.getByText('Back'));
    expect(screen.getByText('First stop.')).toBeTruthy();
    fireEvent.click(screen.getByText('Skip tour'));
    expect(onExit).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Done'));
    expect(onExit).toHaveBeenCalledWith(true);
  });

  it('draws no ring for an anchor that is not on screen', () => {
    render(<GuideTour stops={STOPS.slice(1)} onOpenScreen={() => {}} onExit={() => {}} />);
    expect(document.querySelector('[data-guide-ring]')).toBeNull();
  });
});
