// @vitest-environment jsdom
// Guard for perf cycle 3's folding controller.
//
// THE POINT OF THIS FILE: folding replaces a distant entry's body with a spacer
// of the height it last occupied. Every way that can go wrong is a way to move
// the scroll position under a reader, which is the one regression in this area
// the user has already reported by feel. So the cases here are the ones where a
// naive implementation silently produces a WRONG HEIGHT or folds at the wrong
// moment — not the happy path.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { renderHook, render, act } from '@testing-library/react';
import { useEntryFolding, FOLD_IDLE_MS, UNFOLD_DEBOUNCE_MS, FOLD_ROOT_MARGIN, type EntryFolding } from './use-entry-folding';

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

describe('useEntryFolding', () => {
  it('folds an entry that scrolled away, at the height it last occupied', () => {
    const { result } = renderHook(() => useEntryFolding(true, rootRef));
    const el = entry('a', 240);
    act(() => { result.current.registerEntry(el); });

    act(() => { fire([{ target: el, isIntersecting: true }]); vi.advanceTimersByTime(UNFOLD_DEBOUNCE_MS); });
    expect(result.current.isFolded('a')).toBe(false);

    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS); });
    expect(result.current.isFolded('a')).toBe(true);
    expect(result.current.heightOf('a')).toBe(240);
  });

  it('folds an entry that was NEVER on screen, by measuring it at fold time', () => {
    // THE 6% BUG. Requiring a prior visible report quietly required every entry
    // to have passed within FOLD_ROOT_MARGIN of the viewport. A page prepends
    // ~60 entries at once and only the top few land inside that band, so ~56 of
    // every 60 were never measured and never foldable: measured at 433/7000,
    // 294/5000 and 1/100 in three separate builds. At fold time the element is
    // in the DOM with a real height, so measure it then.
    const { result } = renderHook(() => useEntryFolding(true, rootRef));
    const el = entry('never-seen', 500);
    act(() => { result.current.registerEntry(el); });
    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS); });
    expect(result.current.isFolded('never-seen')).toBe(true);
    expect(result.current.heightOf('never-seen')).toBe(500);
  });

  it('still refuses to fold when the element measures 0 and nothing was remembered', () => {
    // The scroll-destroying case that remains real: a 0px spacer would collapse
    // the scroll height under the reader.
    const { result } = renderHook(() => useEntryFolding(true, rootRef));
    const el = entry('zero', 0);
    act(() => { result.current.registerEntry(el); });
    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS); });
    expect(result.current.isFolded('zero')).toBe(false);
  });

  it('falls back to a remembered height when the element now measures 0', () => {
    // An inactive session's pane is content-visibility:hidden, so its entries lay
    // out to 0. Without the fallback a background conversation — where most of
    // the win is — could never fold.
    const { result } = renderHook(() => useEntryFolding(true, rootRef));
    const el = entry('bg', 260);
    act(() => { result.current.registerEntry(el); });
    act(() => { fire([{ target: el, isIntersecting: true }]); vi.advanceTimersByTime(UNFOLD_DEBOUNCE_MS); });
    Object.defineProperty(el, 'offsetHeight', { get: () => 0, configurable: true });
    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS); });
    expect(result.current.isFolded('bg')).toBe(true);
    expect(result.current.heightOf('bg')).toBe(260);
  });

  it('does not re-measure while folded, so the spacer height cannot drift', () => {
    // A folded entry's offsetHeight IS the spacer. Measuring then would overwrite
    // the true height with itself once, and with a stale value forever after.
    const { result } = renderHook(() => useEntryFolding(true, rootRef));
    const el = entry('b', 300);
    act(() => { result.current.registerEntry(el); });
    act(() => { fire([{ target: el, isIntersecting: true }]); vi.advanceTimersByTime(UNFOLD_DEBOUNCE_MS); });
    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS); });
    expect(result.current.heightOf('b')).toBe(300);

    // Now the element reports the spacer height, as the real DOM would.
    Object.defineProperty(el, 'offsetHeight', { get: () => 300, configurable: true });
    // A brief re-intersect that does not survive the debounce must not re-measure.
    act(() => { fire([{ target: el, isIntersecting: true }]); });
    expect(result.current.heightOf('b')).toBe(300);
  });

  it('waits for scrolling to settle before folding, but unfolds promptly', () => {
    // Folding mid-scroll re-renders the list under a moving viewport. Unfolding
    // late shows a blank gap. The asymmetry is the whole point.
    const { result } = renderHook(() => useEntryFolding(true, rootRef));
    const el = entry('c', 120);
    act(() => { result.current.registerEntry(el); });
    act(() => { fire([{ target: el, isIntersecting: true }]); vi.advanceTimersByTime(UNFOLD_DEBOUNCE_MS); });

    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS - 50); });
    expect(result.current.isFolded('c')).toBe(false);
    // Still scrolling: another out-of-view report restarts the idle timer.
    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS - 50); });
    expect(result.current.isFolded('c')).toBe(false);
    act(() => { vi.advanceTimersByTime(60); });
    expect(result.current.isFolded('c')).toBe(true);

    act(() => { fire([{ target: el, isIntersecting: true }]); vi.advanceTimersByTime(UNFOLD_DEBOUNCE_MS); });
    expect(result.current.isFolded('c')).toBe(false);
  });

  it('unfolds everything and stops folding when disabled (the find bar is open)', () => {
    // ContentFindBar walks the DOM with a TreeWalker. A folded entry is
    // unfindable, so find would report "0 results" for text the user can see in
    // their own conversation.
    const { result, rerender } = renderHook(({ on }) => useEntryFolding(on, rootRef), { initialProps: { on: true } });
    const el = entry('d', 90);
    act(() => { result.current.registerEntry(el); });
    act(() => { fire([{ target: el, isIntersecting: true }]); vi.advanceTimersByTime(UNFOLD_DEBOUNCE_MS); });
    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS); });
    expect(result.current.isFolded('d')).toBe(true);

    rerender({ on: false });
    expect(result.current.isFolded('d')).toBe(false);

    // And nothing folds again while it stays disabled.
    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS * 2); });
    expect(result.current.isFolded('d')).toBe(false);
  });

  it('observes with a margin far wider than the blur observer, and releases on detach', () => {
    // 1500px, not the .in-view observer's 200px: folding something just off
    // screen unfolds it again on the next flick of the wheel, and the render
    // churn costs more than the memory it saves.
    expect(FOLD_ROOT_MARGIN).toBe('1500px 0px');
    const { result } = renderHook(() => useEntryFolding(true, rootRef));
    const el = entry('e', 10);
    let release!: () => void;
    act(() => { release = result.current.registerEntry(el); });
    expect(lastOptions?.rootMargin).toBe(FOLD_ROOT_MARGIN);
    // ROOT MUST BE THE SCROLLER. With root:null the margin expands the document
    // viewport only — the .chat-scroll clip still applies at its true bounds, so
    // the 1500px lead evaporates and entries unfold as they enter view. That is
    // the pop-in Destin saw scrolling slowly (2026-09-03).
    expect(lastOptions?.root).toBe(rootRef.current);
    expect(observed).toContain(el);
    act(() => { release(); });
    expect(observed).not.toContain(el);
  });

  it('keeps registerEntry stable across renders and across fold-state changes', () => {
    // A ref callback whose identity changes is detached and re-attached by React
    // on EVERY entry, EVERY render. At 7,000 entries that is 7,000
    // unobserve+observe pairs per render, and because observe() delivers a fresh
    // intersection report each time, it also restarted the fold idle timer — so
    // folding could never fire and the change measured WORSE than doing nothing.
    const { result, rerender } = renderHook(() => useEntryFolding(true, rootRef));
    const first = result.current.registerEntry;
    rerender();
    expect(result.current.registerEntry).toBe(first);

    const el = entry('f', 50);
    act(() => { result.current.registerEntry(el); });
    act(() => { fire([{ target: el, isIntersecting: true }]); vi.advanceTimersByTime(UNFOLD_DEBOUNCE_MS); });
    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS); });
    expect(result.current.isFolded('f')).toBe(true);   // state really did change
    expect(result.current.registerEntry).toBe(first);  // and the ref did not
  });

  it('folds an entry that was off-screen BEFORE it was ever measured, once it has been seen', () => {
    // THE 6% BUG, pinned. An entry prepended above the viewport is observed while
    // already outside the band, so its one and only out-of-view report arrives
    // before it has ever been measured. The first version drained a queue and
    // cleared it, so that entry was skipped and — since IntersectionObserver
    // reports TRANSITIONS, and it never transitions again — could never be folded
    // for the rest of the session. Measured: 741 of 12,100 entries folded.
    const { result } = renderHook(() => useEntryFolding(true, rootRef));
    const el = entry('late', 180);
    act(() => { result.current.registerEntry(el); });

    // Off-screen from the start and never seen: folds anyway, at its real height.
    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS); });
    expect(result.current.isFolded('late')).toBe(true);
    expect(result.current.heightOf('late')).toBe(180);

    // And it unfolds again when it comes back into view.
    act(() => { fire([{ target: el, isIntersecting: true }]); vi.advanceTimersByTime(UNFOLD_DEBOUNCE_MS); });
    expect(result.current.isFolded('late')).toBe(false);
  });

  it('folds entries still out of view from an EARLIER report, not only newly-reported ones', () => {
    // The flush must re-evaluate membership rather than drain a queue: two
    // entries leave the viewport, only one triggers the flush window, and both
    // must end up folded.
    const { result } = renderHook(() => useEntryFolding(true, rootRef));
    const a = entry('m1', 100);
    const b = entry('m2', 100);
    act(() => { result.current.registerEntry(a); result.current.registerEntry(b); });
    act(() => {
      fire([{ target: a, isIntersecting: true }, { target: b, isIntersecting: true }]);
      vi.advanceTimersByTime(UNFOLD_DEBOUNCE_MS);
    });
    act(() => { fire([{ target: a, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS); });
    expect(result.current.isFolded('m1')).toBe(true);
    // b leaves later; the flush it triggers must fold BOTH, and must not have
    // forgotten a.
    act(() => { fire([{ target: b, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS); });
    expect(result.current.isFolded('m1')).toBe(true);
    expect(result.current.isFolded('m2')).toBe(true);
  });

  it('returns a cleanup even with no element or no observer', () => {
    // Same contract as useObservedRef: returning undefined puts the ref on
    // React's null-call convention and the next detach re-enters with null.
    const { result } = renderHook(() => useEntryFolding(true, rootRef));
    expect(typeof result.current.registerEntry(null)).toBe('function');
    expect(() => (result.current.registerEntry(null))()).not.toThrow();
  });

  it('folds an entry that was already present when the list mounted', () => {
    // Ref callbacks run in React's commit phase, BEFORE this hook's own
    // useEffect creates the IntersectionObserver — so an entry rendered as
    // part of the very first commit calls registerEntry() while
    // observer.current is still null. Every other test in this file calls
    // registerEntry manually via `act()` after renderHook has already flushed
    // effects, which hides exactly this ordering. Mount through `render` with
    // a real ref prop so React itself drives the timing, the way ChatView /
    // PreviewTimeline / BubbleFeed actually mount their first screen of
    // entries.
    let api!: EntryFolding;
    function List() {
      api = useEntryFolding(true, rootRef);
      return React.createElement('div', { 'data-entry-key': 'pre', ref: api.registerEntry });
    }
    const { container } = render(React.createElement(List));
    const el = container.querySelector('[data-entry-key="pre"]') as HTMLElement;
    expect(el).toBeTruthy();

    // The fix: the observer effect must sweep elements.current for anything
    // already registered before the observer existed.
    expect(observed).toContain(el);

    Object.defineProperty(el, 'offsetHeight', { get: () => 200, configurable: true });
    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS); });
    expect(api.isFolded('pre')).toBe(true);
  });
});
