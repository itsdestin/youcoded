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
import GuideTipHost from '../src/renderer/components/guide/GuideTipHost';
import { EscCloseProvider, useEscClose } from '../src/renderer/hooks/use-esc-close';
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

describe('GuideTipHost', () => {
  it('keeps an already visible resume tip readable across queued turn boundaries until dismissed', () => {
    setTipsArmed(true);
    expect(triggerTip('resume')).toBe(true);
    const text = TIPS.find(t => t.id === 'resume')!.text;
    const { rerender } = render(<GuideTipHost busy={false} />);
    const bubble = screen.getByText(text);
    // Each transition is a separate commit, as live turn-complete/thinking events are.
    for (const busy of [true, false, true, false, true, false]) {
      rerender(<GuideTipHost busy={busy} />);
      expect(screen.queryByText(text)).toBe(bubble);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByText(text)).toBeNull();
    rerender(<GuideTipHost busy={true} />);
    rerender(<GuideTipHost busy={false} />);
    expect(screen.queryByText(text)).toBeNull();
    expect(tipSeen('resume')).toBe(true);
  });

  it('defers an unseen tip while busy and still lets the person stop all tips', () => {
    setTipsArmed(true);
    expect(triggerTip('resume')).toBe(true);
    const text = TIPS.find(t => t.id === 'resume')!.text;
    const { rerender } = render(<GuideTipHost busy />);
    expect(screen.queryByText(text)).toBeNull();
    rerender(<GuideTipHost busy={false} />);
    expect(screen.getByText(text)).toBeTruthy();
    rerender(<GuideTipHost busy />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop showing tips' }));
    expect(screen.queryByText(text)).toBeNull();
    expect(tipsArmed()).toBe(false);
  });
});

const STOPS: GuideStop[] = [
  { id: 'a', text: 'First stop.', screen: 'welcome', pose: 'welcome' },
  { id: 'b', text: 'Second stop.', screen: 'projects', anchor: 'nothing-here', pose: 'inquisitive' },
];

describe('the nine stops', () => {
  it('walk forward through the app in the order Destin approved, the backup warning right after Files', async () => {
    const { GUIDE_STOPS } = await import('../src/renderer/components/guide/guide-stops');
    expect(GUIDE_STOPS.map((s) => s.id)).toEqual(['buddy', 'sessions', 'tags', 'projects', 'files', 'backups', 'models', 'themes', 'help']);
    expect(GUIDE_STOPS.map((s) => s.screen)).toEqual([
      'welcome', 'welcome-form', 'welcome-form', 'projects', 'projects', 'projects', 'settings:cloud', 'settings:appearance', 'settings:help',
    ]);
    for (const s of GUIDE_STOPS) expect(s.text.split(' ').length).toBeLessThan(45);
  });

  it('the backup stop and Settings → Permissions say the same words, Destin\'s own', async () => {
    const { GUIDE_STOPS } = await import('../src/renderer/components/guide/guide-stops');
    const { BACKUP_WARNING } = await import('../src/renderer/components/backup-warning-copy');
    expect(BACKUP_WARNING).toBe('With your permission, the assistant may create, change, or delete files on your device. Create backups for anything you cannot replace.');
    expect(GUIDE_STOPS.find((s) => s.id === 'backups')?.text).toBe(BACKUP_WARNING);
  });
});

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

  it('Escape ends the tour over the screen its stop opened, leaving that screen open', () => {
    // The stop's screen registers its own Escape when the tour opens it — after the tour
    // mounted. Escape must still go to the tour, and only close its bubble (`stay`).
    const screenClosed = vi.fn();
    function StopScreen({ open }: { open: boolean }) { useEscClose(open, screenClosed); return null; }
    function Harness() {
      const [open, setOpen] = React.useState(false);
      const onOpenScreen = React.useCallback(() => setOpen(true), []);
      return <><StopScreen open={open} /><GuideTour stops={STOPS} onOpenScreen={onOpenScreen} onExit={onExit} /></>;
    }
    const onExit = vi.fn();
    render(<EscCloseProvider><Harness /></EscCloseProvider>);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onExit).toHaveBeenCalledWith(false, true);
    expect(screenClosed).not.toHaveBeenCalled();
  });

  it('the ✕ closes only the bubble, the same as Escape', () => {
    const onExit = vi.fn();
    render(<GuideTour stops={STOPS} onOpenScreen={() => {}} onExit={onExit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close tour' }));
    expect(onExit).toHaveBeenCalledWith(false, true);
  });

  it('draws no ring for an anchor that is not on screen', () => {
    render(<GuideTour stops={STOPS.slice(1)} onOpenScreen={() => {}} onExit={() => {}} />);
    expect(document.querySelector('[data-guide-ring]')).toBeNull();
  });
});
