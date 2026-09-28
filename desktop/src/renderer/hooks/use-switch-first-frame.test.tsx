// @vitest-environment jsdom
// Guard for the session-switch pop-in fix (2026-09-18).
//
// THE POINT OF THIS FILE: everything a returning conversation needs must be done
// by the time React's layout effects have run — the last moment before the
// browser paints — and in an order where each step measures the result of the
// one before. A requestAnimationFrame, an observer or a timer in this path is the
// bug coming back, and none of them run in these tests, so reintroducing one
// turns the assertions below red.
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSwitchFirstFrame } from './use-switch-first-frame';

function rect(top: number, bottom: number): DOMRect { return { top, bottom } as DOMRect; }

/** A scroller showing 0–800px, with entries at the given [top, bottom] spans,
 *  all stripped of `.in-view` the way a hidden pane's are. */
function pane(spans: Array<[number, number]>) {
  const scroller = document.createElement('div');
  scroller.getBoundingClientRect = () => rect(0, 800);
  const entries = spans.map(([t, b]) => {
    const el = document.createElement('div');
    el.className = 'timeline-entry';
    el.getBoundingClientRect = () => rect(t, b);
    scroller.appendChild(el);
    return el;
  });
  return { scroller, entries };
}

describe('useSwitchFirstFrame', () => {
  it('scrolls, then unfolds, then re-frosts — all before the hook returns to the browser', () => {
    const { scroller, entries } = pane([[-5000, -4000], [300, 500], [600, 790]]);
    const order: string[] = [];
    renderHook(() => useSwitchFirstFrame(
      true, { current: scroller },
      () => { order.push('scroll'); },
      () => { order.push('unfold'); },
    ));
    // No timers advanced, no frame awaited: it has all already happened.
    expect(order).toEqual(['scroll', 'unfold']);
    expect(entries[1].classList.contains('in-view')).toBe(true);
    expect(entries[2].classList.contains('in-view')).toBe(true);
    // Far above the screen: left for the observer, which gates a backdrop-filter
    // per bubble and exists to keep that count small.
    expect(entries[0].classList.contains('in-view')).toBe(false);
  });

  it('does nothing for a pane that is not the one on screen', () => {
    const { scroller, entries } = pane([[300, 500]]);
    const order: string[] = [];
    renderHook(() => useSwitchFirstFrame(false, { current: scroller }, () => order.push('scroll'), () => order.push('unfold')));
    expect(order).toEqual([]);
    expect(entries[0].classList.contains('in-view')).toBe(false);
  });

  it('runs again each time the pane comes back', () => {
    const { scroller } = pane([[300, 500]]);
    let scrolls = 0;
    const stick = () => { scrolls++; };
    const unfold = () => {};
    const ref = { current: scroller };
    const { rerender } = renderHook(({ v }) => useSwitchFirstFrame(v, ref, stick, unfold), { initialProps: { v: true } });
    rerender({ v: false });
    rerender({ v: true });
    expect(scrolls).toBe(2);
  });

  it('stops measuring at the first entry above the screen, however long the conversation', () => {
    // Walked from the end. 5,000 entries above the band must cost one read, not 5,000.
    const spans: Array<[number, number]> = [];
    for (let i = 0; i < 5000; i++) spans.push([-100000 + i, -99999 + i]);
    spans.push([700, 790]);
    const { scroller, entries } = pane(spans);
    let reads = 0;
    for (const el of entries) {
      const real = el.getBoundingClientRect;
      el.getBoundingClientRect = () => { reads++; return real(); };
    }
    renderHook(() => useSwitchFirstFrame(true, { current: scroller }, () => {}, () => {}));
    expect(reads).toBe(2);   // the one on screen, and the first one above it
  });

  it('does not collect every entry in the conversation to find the last ones', () => {
    // querySelectorAll visits the whole conversation's markup to build its list,
    // inside the click, even though the walk over it stops after a screenful.
    const spans: Array<[number, number]> = [];
    for (let i = 0; i < 1000; i++) spans.push([-100000 + i, -99999 + i]);
    spans.push([600, 700]);
    const { scroller, entries } = pane(spans);
    // Chat rows after the entries that are not entries (the thinking line).
    const thinking = document.createElement('div');
    thinking.getBoundingClientRect = () => rect(710, 790);
    scroller.appendChild(thinking);
    const all = vi.spyOn(scroller, 'querySelectorAll');
    renderHook(() => useSwitchFirstFrame(true, { current: scroller }, () => {}, () => {}));
    expect(all).not.toHaveBeenCalled();
    expect(entries[entries.length - 1].classList.contains('in-view')).toBe(true);
    expect(thinking.classList.contains('in-view')).toBe(false);
  });
});
