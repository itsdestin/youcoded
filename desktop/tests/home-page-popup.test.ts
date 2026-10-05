// @vitest-environment jsdom
// Redesign audit F8 (A-5 "draw it once, update the parts"): a device's pop-up is
// drawn once and only its parts change, so keyboard focus, scroll position and
// size stay put while its history arrives and while its device changes.
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, flush, frame, tick, flip, noCameraPicture } from './home-page-harness';

afterEach(() => { unmount(); vi.useRealTimers(); });

it('keeps the same pop-up, with focus inside it, when history arrives and its device changes', async () => {
  await mount({ fetchHook: noCameraPicture });
  q('[data-eid="light.living_room_lamp"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const dlg = document.querySelector<HTMLElement>('.dlg')!;
  expect(document.activeElement).toBe(dlg);
  await tick(1000); // its history arrives
  expect(document.querySelector('.dlg')).toBe(dlg);
  expect(document.activeElement).toBe(dlg);
  flip('light.living_room_lamp'); await frame();
  expect(document.querySelector('.dlg')).toBe(dlg);
  expect(document.activeElement).toBe(dlg);
  // Tab still stays inside: from the last control it wraps to the first.
  const last = Array.from(dlg.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input, select')).pop()!;
  last.focus();
  const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }); document.dispatchEvent(ev);
  expect(ev.defaultPrevented).toBe(true);
});

// Code review 9: the history area is sized for the lines it will hold (what this device showed last time), so a
// pop-up opened again does not change size when its history arrives.
it('reserves the history room it needed last time, so a second opening does not change size', async () => {
  await mount({ fetchHook: noCameraPicture });
  const open = () => q('[data-eid="light.living_room_lamp"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const room = () => document.querySelector<HTMLElement>('.dlg-hist')!.style.minHeight;
  open();
  expect(room()).not.toBe('');
  await tick(1000);
  const after = room();
  expect(parseFloat(after)).toBeGreaterThan(0);
  q('[data-dlg-close]').click();
  open();
  expect(room()).toBe(after); // reserved from the first moment, equal to what it turned out to need
});
