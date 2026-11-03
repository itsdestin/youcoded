// @vitest-environment jsdom
// Folding replaces a distant entry's body with a spacer of the height it last occupied. Every failure moves the scroll
// position under a reader, so these cases are the ones where a naive version produces a WRONG HEIGHT or folds at the wrong moment.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { renderHook, render, act } from '@testing-library/react';
import { useEntryFolding, FOLD_IDLE_MS, INACTIVE_FOLD_MS, UNFOLD_DEBOUNCE_MS, FOLD_ROOT_MARGIN, type EntryFolding } from './use-entry-folding';

type Cb = (entries: Array<{ target: Element; isIntersecting: boolean }>) => void;
let fire: Cb;
let observed: Element[];
let lastOptions: IntersectionObserverInit | undefined;
let rootRef: { current: HTMLElement | null };

beforeEach(() => {
  vi.useFakeTimers();
  observed = [];
  rootRef = { current: document.createElement('div') };
  (globalThis as any).IntersectionObserver = class {
    constructor(cb: Cb, options?: IntersectionObserverInit) { fire = cb; lastOptions = options; }
    observe(el: Element) { observed.push(el); }
    unobserve(el: Element) { observed = observed.filter((o) => o !== el); }
    disconnect() { observed = []; }
    takeRecords() { return []; }
  };
});
afterEach(() => { vi.useRealTimers(); });

/** An entry wrapper with a real offsetHeight, which jsdom does not compute. */
function entry(key: string, height: number) {
  const el = document.createElement('div');
  el.dataset.entryKey = key;
  Object.defineProperty(el, 'offsetHeight', { get: () => height, configurable: true });
  return el;
}

/** The observer reports `el` near the viewport and the unfold debounce passes. */
const near = (el: Element) => act(() => { fire([{ target: el, isIntersecting: true }]); vi.advanceTimersByTime(UNFOLD_DEBOUNCE_MS); });
/** The observer reports `el` out of view and the fold idle time passes. */
const away = (el: Element) => act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS); });

describe('useEntryFolding', () => {
  // A long conversation opens with its older entries already folded.
  it('starts seeded entries folded at their estimated height, and draws them when they come near', () => {
    const { result } = renderHook(() => useEntryFolding(true, rootRef, true, [['old-1', 300], ['old-2', 500]]));
    expect(result.current.isFolded('old-1')).toBe(true);
    expect(result.current.heightOf('old-2')).toBe(500);
    expect(result.current.isFolded('new-1')).toBe(false);
    const a = entry('old-1', 300), b = entry('old-2', 500);
    // The observer reports old-1 near the viewport and old-2 far away: only old-1 is drawn.
    act(() => { result.current.registerEntry(a); result.current.registerEntry(b); fire([
      { target: a, isIntersecting: true }, { target: b, isIntersecting: false },
    ]); vi.advanceTimersByTime(UNFOLD_DEBOUNCE_MS); });
    expect(result.current.isFolded('old-1')).toBe(false);
    expect(result.current.isFolded('old-2')).toBe(true);
  });

  // A guessed-height spacer above the reader turning into its real body must not move the view, even with no browser scroll anchoring.
  it('puts the entry the reader is looking at back in place when an unfolded body is taller than its spacer', () => {
    const root = document.createElement('div');
    rootRef = { current: root };
    let scrollTop = 500;
    Object.defineProperty(root, 'scrollTop', { get: () => scrollTop, set: (v) => { scrollTop = v; }, configurable: true });
    root.getBoundingClientRect = () => ({ top: 0, bottom: 800, height: 800, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
    let api!: EntryFolding;
    function Rows() {
      api = useEntryFolding(true, rootRef, true, [['a', 100]]);
      return React.createElement(React.Fragment, null,
        React.createElement('div', { 'data-entry-key': 'a', ref: api.registerEntry }, api.isFolded('a') ? null : React.createElement('span', null, 'body')),
        React.createElement('div', { 'data-entry-key': 'b', ref: api.registerEntry }, React.createElement('span', null, 'b')));
    }
    document.body.appendChild(root);
    const view = render(React.createElement(Rows), { container: root });
    const [a, b] = Array.from(root.children) as HTMLElement[];
    // 'a' is above the window (spacer 100 px); 'b' is on screen at 120. Drawing a's real body adds 80 px
    // above b, which the browser would otherwise show as b jumping down.
    a.getBoundingClientRect = () => ({ top: -100, bottom: 0, height: 100, toJSON() {} }) as DOMRect;
    b.getBoundingClientRect = () => { const t = 120 + (a.childElementCount > 0 ? 80 : 0); return ({ top: t, bottom: t + 200, height: 200, toJSON() {} }) as DOMRect; };
    Object.defineProperty(a, 'offsetHeight', { get: () => (a.childElementCount > 0 ? 180 : 100), configurable: true });
    act(() => { fire([{ target: a, isIntersecting: true }, { target: b, isIntersecting: true }]); vi.advanceTimersByTime(UNFOLD_DEBOUNCE_MS); });
    expect(a.childElementCount).toBe(1);
    // b is back at 120 on screen: the scroll position took up the 80 px.
    expect(scrollTop).toBe(580);
    // And the real height (180) replaced the guess (100) for any later fold.
    expect(api.heightOf('a')).toBe(100);
    away(a);
    expect(api.isFolded('a')).toBe(true);
    expect(api.heightOf('a')).toBe(180);
    view.unmount();
    root.remove();
  });

  it('ignores a later change of the seed (it is read once, on mount)', () => {
    const { result, rerender } = renderHook(({ seed }) => useEntryFolding(true, rootRef, true, seed), { initialProps: { seed: [['a', 100]] as Array<[string, number]> } });
    rerender({ seed: [['b', 100]] });
    expect(result.current.isFolded('a')).toBe(true);
    expect(result.current.isFolded('b')).toBe(false);
  });

  it('reveals just the requested row and pins it until release, then folds normally', () => {
    const { result } = renderHook(() => useEntryFolding(true, rootRef));
    const a = entry('a', 90), b = entry('b', 100);
    act(() => { result.current.registerEntry(a); result.current.registerEntry(b); fire([
      { target: a, isIntersecting: false }, { target: b, isIntersecting: false },
    ]); vi.advanceTimersByTime(FOLD_IDLE_MS); });
    expect(result.current.isFolded('a')).toBe(true);
    let release!: () => void;
    let secondRelease!: () => void;
    act(() => { release = result.current.revealAndPin('a'); secondRelease = result.current.revealAndPin('a'); });
    expect(result.current.isFolded('a')).toBe(false);
    expect(result.current.isFolded('b')).toBe(true);
    away(a);
    expect(result.current.isFolded('a')).toBe(false);
    act(() => { release(); vi.advanceTimersByTime(FOLD_IDLE_MS); });
    expect(result.current.isFolded('a')).toBe(false);
    act(() => { secondRelease(); vi.advanceTimersByTime(FOLD_IDLE_MS); });
    expect(result.current.isFolded('a')).toBe(true);
  });

  it('drops published spacer state before a removed row key is reused', async () => {
    const { result } = renderHook(() => useEntryFolding(true, rootRef));
    const old = entry('reuse', 240);
    let detach!: () => void;
    act(() => { detach = result.current.registerEntry(old); fire([{ target: old, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS); });
    expect(result.current.isFolded('reuse')).toBe(true);
    await act(async () => { detach(); await Promise.resolve(); });
    expect(result.current.isFolded('reuse')).toBe(false);
    expect(result.current.heightOf('reuse')).toBeUndefined();
    act(() => { result.current.registerEntry(entry('reuse', 50)); });
    expect(result.current.isFolded('reuse')).toBe(false);
  });

  it('keeps a revealed body and its Range mounted until the selection releases', () => {
    let api!: EntryFolding;
    function Row() {
      api = useEntryFolding(true, rootRef);
      return React.createElement('div', { 'data-entry-key': 'selected', ref: api.registerEntry },
        api.isFolded('selected') ? null : React.createElement('span', null, 'selected match'));
    }
    const view = render(React.createElement(Row));
    const el = view.container.firstElementChild as HTMLElement;
    Object.defineProperty(el, 'offsetHeight', { value: 120 });
    away(el);
    expect(el.childElementCount).toBe(0);
    let release!: () => void;
    act(() => { release = api.revealAndPin('selected'); });
    const text = el.querySelector('span')!.firstChild!;
    const range = document.createRange();
    range.selectNodeContents(text);
    away(el);
    expect(text.isConnected).toBe(true);
    expect(range.toString()).toBe('selected match');
    act(() => { release(); vi.advanceTimersByTime(FOLD_IDLE_MS); });
    expect(text.isConnected).toBe(false);
    expect(el.childElementCount).toBe(0);
  });

  it('releases registered records and pins at root unmount', () => {
    const { result, unmount } = renderHook(() => useEntryFolding(true, rootRef));
    const el = entry('a', 80);
    let detach!: () => void;
    act(() => { detach = result.current.registerEntry(el); result.current.revealAndPin('a'); });
    act(() => { detach(); });
    unmount();
    expect(observed).toEqual([]);
    // A stale selection cannot keep a removed key pinned on reuse.
    const { result: next } = renderHook(() => useEntryFolding(true, rootRef));
    act(() => { next.current.registerEntry(entry('a', 80)); });
    expect(next.current.isFolded('a')).toBe(false);
  });

  it('folds an entry that scrolled away, at the height it last occupied', () => {
    const { result } = renderHook(() => useEntryFolding(true, rootRef));
    const el = entry('a', 240);
    act(() => { result.current.registerEntry(el); });

    near(el);
    expect(result.current.isFolded('a')).toBe(false);

    away(el);
    expect(result.current.isFolded('a')).toBe(true);
    expect(result.current.heightOf('a')).toBe(240);
  });

  it('folds an entry that was NEVER on screen, by measuring it at fold time', () => {
    // WHY: requiring a prior visible report left ~56 of every 60 prepended entries never measured and never foldable; measure at fold time instead.
    const { result } = renderHook(() => useEntryFolding(true, rootRef));
    const el = entry('never-seen', 500);
    act(() => { result.current.registerEntry(el); });
    away(el);
    expect(result.current.isFolded('never-seen')).toBe(true);
    expect(result.current.heightOf('never-seen')).toBe(500);
  });

  it('still refuses to fold when the element measures 0 and nothing was remembered', () => {
    // A 0px spacer would collapse the scroll height under the reader.
    const { result } = renderHook(() => useEntryFolding(true, rootRef));
    const el = entry('zero', 0);
    act(() => { result.current.registerEntry(el); });
    away(el);
    expect(result.current.isFolded('zero')).toBe(false);
  });

  it('falls back to a remembered height when the element now measures 0', () => {
    // An inactive pane is content-visibility:hidden, so its entries lay out to 0; without the fallback a background conversation could never fold.
    const { result } = renderHook(() => useEntryFolding(true, rootRef));
    const el = entry('bg', 260);
    act(() => { result.current.registerEntry(el); });
    near(el);
    Object.defineProperty(el, 'offsetHeight', { get: () => 0, configurable: true });
    away(el);
    expect(result.current.isFolded('bg')).toBe(true);
    expect(result.current.heightOf('bg')).toBe(260);
  });

  it('does not re-measure while folded, so the spacer height cannot drift', () => {
    // A folded entry's offsetHeight IS the spacer; measuring then would overwrite the true height.
    const { result } = renderHook(() => useEntryFolding(true, rootRef));
    const el = entry('b', 300);
    act(() => { result.current.registerEntry(el); });
    near(el);
    away(el);
    expect(result.current.heightOf('b')).toBe(300);

    // Now the element reports the spacer height, as the real DOM would.
    Object.defineProperty(el, 'offsetHeight', { get: () => 300, configurable: true });
    // A brief re-intersect that does not survive the debounce must not re-measure.
    act(() => { fire([{ target: el, isIntersecting: true }]); });
    expect(result.current.heightOf('b')).toBe(300);
  });

  it('waits for scrolling to settle before folding, but unfolds promptly', () => {
    // Folding mid-scroll re-renders under a moving viewport; unfolding late shows a blank gap. The asymmetry is the point.
    const { result } = renderHook(() => useEntryFolding(true, rootRef));
    const el = entry('c', 120);
    act(() => { result.current.registerEntry(el); });
    near(el);

    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS - 50); });
    expect(result.current.isFolded('c')).toBe(false);
    // Still scrolling: another out-of-view report restarts the idle timer.
    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS - 50); });
    expect(result.current.isFolded('c')).toBe(false);
    act(() => { vi.advanceTimersByTime(60); });
    expect(result.current.isFolded('c')).toBe(true);

    near(el);
    expect(result.current.isFolded('c')).toBe(false);
  });

  it('unfolds everything and stops folding when disabled (the find bar is open)', () => {
    // A folded entry is unfindable by the find bar's DOM walk, which would report 0 results for visible conversation text.
    const { result, rerender } = renderHook(({ on }) => useEntryFolding(on, rootRef), { initialProps: { on: true } });
    const el = entry('d', 90);
    act(() => { result.current.registerEntry(el); });
    near(el);
    away(el);
    expect(result.current.isFolded('d')).toBe(true);

    rerender({ on: false });
    expect(result.current.isFolded('d')).toBe(false);

    // And nothing folds again while it stays disabled.
    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS * 2); });
    expect(result.current.isFolded('d')).toBe(false);
  });

  it('observes with a margin far wider than the blur observer, and releases on detach', () => {
    // 1500px, not the .in-view observer's 200px: folding just-off-screen entries churns more than it saves.
    expect(FOLD_ROOT_MARGIN).toBe('1500px 0px');
    const { result } = renderHook(() => useEntryFolding(true, rootRef));
    const el = entry('e', 10);
    let release!: () => void;
    act(() => { release = result.current.registerEntry(el); });
    expect(lastOptions?.rootMargin).toBe(FOLD_ROOT_MARGIN);
    // ROOT MUST BE THE SCROLLER: with root:null the .chat-scroll clip still applies, the lead evaporates and entries pop in.
    expect(lastOptions?.root).toBe(rootRef.current);
    expect(observed).toContain(el);
    act(() => { release(); });
    expect(observed).not.toContain(el);
  });

  it('keeps registerEntry stable across renders and across fold-state changes', () => {
    // WHY: a changing ref identity re-attaches every entry each render (7,000 unobserve+observe pairs) and restarts the fold idle timer, so folding never fired.
    const { result, rerender } = renderHook(() => useEntryFolding(true, rootRef));
    const first = result.current.registerEntry;
    rerender();
    expect(result.current.registerEntry).toBe(first);

    const el = entry('f', 50);
    act(() => { result.current.registerEntry(el); });
    near(el);
    away(el);
    expect(result.current.isFolded('f')).toBe(true);   // state really did change
    expect(result.current.registerEntry).toBe(first);  // and the ref did not
  });

  it('folds an entry that was off-screen BEFORE it was ever measured, once it has been seen', () => {
    // WHY: a prepended entry's one out-of-view report arrives before it is ever measured; a drain-and-clear queue skipped it for good (IntersectionObserver reports only transitions).
    const { result } = renderHook(() => useEntryFolding(true, rootRef));
    const el = entry('late', 180);
    act(() => { result.current.registerEntry(el); });

    // Off-screen from the start and never seen: folds anyway, at its real height.
    away(el);
    expect(result.current.isFolded('late')).toBe(true);
    expect(result.current.heightOf('late')).toBe(180);

    // And it unfolds again when it comes back into view.
    near(el);
    expect(result.current.isFolded('late')).toBe(false);
  });

  it('folds entries still out of view from an EARLIER report, not only newly-reported ones', () => {
    // The flush re-evaluates membership rather than draining a queue: both entries must end up folded.
    const { result } = renderHook(() => useEntryFolding(true, rootRef));
    const a = entry('m1', 100);
    const b = entry('m2', 100);
    act(() => { result.current.registerEntry(a); result.current.registerEntry(b); });
    act(() => {
      fire([{ target: a, isIntersecting: true }, { target: b, isIntersecting: true }]);
      vi.advanceTimersByTime(UNFOLD_DEBOUNCE_MS);
    });
    away(a);
    expect(result.current.isFolded('m1')).toBe(true);
    away(b);
    expect(result.current.isFolded('m1')).toBe(true);
    expect(result.current.isFolded('m2')).toBe(true);
  });

  // Session switch. WHY: a background pane is content-visibility:hidden, so every entry reported out of view and the conversation became blank spacers; switching back popped messages in.

  it('a pane that just went to the background keeps what was on screen', () => {
    const { result, rerender } = renderHook(({ active }) => useEntryFolding(true, rootRef, active), { initialProps: { active: true } });
    const el = entry('kept', 200);
    act(() => { result.current.registerEntry(el); });
    near(el);

    rerender({ active: false });
    Object.defineProperty(el, 'offsetHeight', { get: () => 0, configurable: true });
    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS * 5); });
    // A quick there-and-back must find the messages still built.
    expect(result.current.isFolded('kept')).toBe(false);
  });

  it('a pane left in the background long enough still folds, so memory stays bounded', () => {
    const { result, rerender } = renderHook(({ active }) => useEntryFolding(true, rootRef, active), { initialProps: { active: true } });
    const el = entry('old', 200);
    act(() => { result.current.registerEntry(el); });
    near(el);

    rerender({ active: false });
    Object.defineProperty(el, 'offsetHeight', { get: () => 0, configurable: true });
    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(INACTIVE_FOLD_MS); });
    expect(result.current.isFolded('old')).toBe(true);
    expect(result.current.heightOf('old')).toBe(200);
  });

  it('coming back re-arms the normal fold, so leftovers do not wait out the long timer', () => {
    // The return scrolls to the bottom, so entries on screen when the pane left may be far away and never transition again.
    const { result, rerender } = renderHook(({ active }) => useEntryFolding(true, rootRef, active), { initialProps: { active: true } });
    const el = entry('left-behind', 200);
    act(() => { result.current.registerEntry(el); });
    near(el);
    rerender({ active: false });
    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(1000); });
    expect(result.current.isFolded('left-behind')).toBe(false);

    rerender({ active: true });
    act(() => { vi.advanceTimersByTime(FOLD_IDLE_MS); });
    expect(result.current.isFolded('left-behind')).toBe(true);
  });

  it('unfoldNearViewport rebuilds folded entries near the screen at once, and only those', () => {
    // Switch-back for a pane that DID fold: no observer report or debounce; runs before first paint.
    const { result } = renderHook(() => useEntryFolding(true, rootRef));
    rootRef.current!.getBoundingClientRect = () => ({ top: 0, bottom: 800 } as DOMRect);
    const near = entry('near', 100);
    const far = entry('far', 100);
    near.getBoundingClientRect = () => ({ top: 700, bottom: 800 } as DOMRect);
    far.getBoundingClientRect = () => ({ top: -9000, bottom: -8900 } as DOMRect);
    // Document order: far (older) first, near (newer) last — it is walked from the end.
    rootRef.current!.append(far, near);
    act(() => { result.current.registerEntry(near); result.current.registerEntry(far); });
    act(() => {
      fire([{ target: near, isIntersecting: false }, { target: far, isIntersecting: false }]);
      vi.advanceTimersByTime(FOLD_IDLE_MS);
    });
    expect(result.current.isFolded('near')).toBe(true);

    act(() => { result.current.unfoldNearViewport(); });
    expect(result.current.isFolded('near')).toBe(false);
    expect(result.current.isFolded('far')).toBe(true);
  });

  // A fast flick on a loaded renderer showed a blank spacer because unfolding waited 100 ms; neither of these may wait for a timer.
  it('draws an entry the observer reports as near the moment it reports, with no timer wait', () => {
    const { result } = renderHook(() => useEntryFolding(true, rootRef, true, [['old', 300]]));
    const el = entry('old', 300);
    act(() => { result.current.registerEntry(el); fire([{ target: el, isIntersecting: true }]); });
    expect(result.current.isFolded('old')).toBe(false);
  });

  it('draws a spacer that a scroll has brought into the band on the scroll event itself', () => {
    const { result } = renderHook(() => useEntryFolding(true, rootRef, true, [['old', 300]]));
    rootRef.current!.getBoundingClientRect = () => ({ top: 0, bottom: 800 } as DOMRect);
    const el = entry('old', 300);
    el.getBoundingClientRect = () => ({ top: -900, bottom: -600 } as DOMRect); // inside the 1,500 px lead
    rootRef.current!.append(el);
    act(() => { result.current.registerEntry(el); });
    expect(result.current.isFolded('old')).toBe(true);
    act(() => { rootRef.current!.dispatchEvent(new Event('scroll')); });
    expect(result.current.isFolded('old')).toBe(false);
  });

  it('a search jump to the middle inspects a viewport band, not every newer spacer', () => {
    const { result } = renderHook(() => useEntryFolding(true, rootRef));
    rootRef.current!.getBoundingClientRect = () => ({ top: 0, bottom: 800 } as DOMRect);
    let reads = 0;
    const els = Array.from({ length: 3000 }, (_, i) => {
      const el = entry(`row-${i}`, 100);
      el.getBoundingClientRect = () => { reads++; const top = (i - 1500) * 120; return { top, bottom: top + 100 } as DOMRect; };
      return el;
    });
    rootRef.current!.append(...els);
    act(() => { for (const el of els) result.current.registerEntry(el); });
    act(() => { fire(els.map((target) => ({ target, isIntersecting: false }))); vi.advanceTimersByTime(FOLD_IDLE_MS); });
    reads = 0;
    act(() => { result.current.unfoldNearViewport(); });
    expect(result.current.isFolded('row-1500')).toBe(false);
    expect(result.current.isFolded('row-2900')).toBe(true);
    expect(reads).toBeLessThan(100); // not 1500 getBoundingClientRect calls
  });

  it('unfoldNearViewport stops measuring at the first entry above the band', () => {
    // Runs inside the click; measuring thousands of far-above folded entries on every switch was a visible delay.
    const { result } = renderHook(() => useEntryFolding(true, rootRef));
    rootRef.current!.getBoundingClientRect = () => ({ top: 0, bottom: 800 } as DOMRect);
    let reads = 0;
    const els: HTMLElement[] = [];
    for (let i = 0; i < 3000; i++) {
      const el = entry(`old-${i}`, 100);
      el.getBoundingClientRect = () => { reads++; return { top: -500000 + i, bottom: -499900 + i } as DOMRect; };
      els.push(el);
    }
    const near = entry('near', 100);
    near.getBoundingClientRect = () => { reads++; return { top: 700, bottom: 800 } as DOMRect; };
    els.push(near);
    rootRef.current!.append(...els);
    act(() => { for (const el of els) result.current.registerEntry(el); });
    act(() => { fire(els.map((target) => ({ target, isIntersecting: false }))); vi.advanceTimersByTime(FOLD_IDLE_MS); });
    expect(result.current.isFolded('near')).toBe(true);

    reads = 0;
    act(() => { result.current.unfoldNearViewport(); });
    expect(result.current.isFolded('near')).toBe(false);
    expect(reads).toBeLessThan(40); // two binary seeks (the unfold and the scroll anchor) + band, never every older entry
  });

  it('returns a cleanup even with no element or no observer', () => {
    // Returning undefined would put the ref on React's null-call convention (next detach re-enters with null).
    const { result } = renderHook(() => useEntryFolding(true, rootRef));
    expect(typeof result.current.registerEntry(null)).toBe('function');
    expect(() => (result.current.registerEntry(null))()).not.toThrow();
  });

  it('folds an entry that was already present when the list mounted', () => {
    // Ref callbacks run BEFORE the hook's useEffect creates the observer, so a first-commit entry registers while the observer is null; mount through `render` so React drives that timing.
    let api!: EntryFolding;
    function List() {
      api = useEntryFolding(true, rootRef);
      return React.createElement('div', { 'data-entry-key': 'pre', ref: api.registerEntry });
    }
    const { container } = render(React.createElement(List));
    const el = container.querySelector('[data-entry-key="pre"]') as HTMLElement;
    expect(el).toBeTruthy();

    // The observer effect must sweep entries registered before it existed.
    expect(observed).toContain(el);

    Object.defineProperty(el, 'offsetHeight', { get: () => 200, configurable: true });
    away(el);
    expect(api.isFolded('pre')).toBe(true);
  });
});
