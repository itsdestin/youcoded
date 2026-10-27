// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createRef } from 'react';
import {
  useStickToBottom, isAtBottom, distanceFromBottom, RESTICK_THRESHOLD_PX, REARM_IDLE_MS, JUMP_GLIDE_MS,
} from '../src/renderer/hooks/use-stick-to-bottom';

// jsdom doesn't lay out, so scrollHeight/clientHeight are always 0 and scrollTop
// never clamps. Define them ourselves to model a real scroll container: content
// CONTENT_H tall in a viewport VIEW_H tall, with scrollTop clamped like a
// browser's. That is enough to exercise every branch of the stick logic.
const CONTENT_H = 2000;
const VIEW_H = 500;
const MAX_SCROLL = CONTENT_H - VIEW_H; // 1500

// Counts reads of the layout-forcing properties. In a real browser each of
// these flushes pending layout, which during a streaming turn means a full
// forced reflow of the whole transcript — see the PERF note in the hook.
let layoutReads = 0;

function makeContainer(): HTMLDivElement {
  const el = document.createElement('div');
  let top = 0;
  Object.defineProperty(el, 'scrollHeight', { get: () => { layoutReads++; return CONTENT_H; } });
  Object.defineProperty(el, 'clientHeight', { get: () => { layoutReads++; return VIEW_H; } });
  Object.defineProperty(el, 'clientWidth', { get: () => 800 });
  Object.defineProperty(el, 'scrollTop', {
    get: () => top,
    set: (v: number) => {
      const next = Math.max(0, Math.min(v, MAX_SCROLL));
      if (next === top) return;
      top = next;
      el.dispatchEvent(new Event('scroll'));
    },
  });
  // jsdom has no scrollTo; route it through the same clamped setter.
  (el as any).scrollTo = (opts: { top: number }) => { el.scrollTop = opts.top; };
  document.body.appendChild(el);
  return el;
}

function wheel(el: HTMLElement, deltaY: number) {
  // Model what the real wheel handler does: our passive listener reads the
  // delta, then the container actually scrolls.
  el.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true }));
  el.scrollTop = el.scrollTop + deltaY;
}

describe('distanceFromBottom / isAtBottom', () => {
  it('measures from the true bottom, so padding-bottom is included', () => {
    // scrollHeight includes .chat-scroll's padding-bottom, which is exactly the
    // geometry the old sentinel-based observer got wrong.
    expect(distanceFromBottom({ scrollTop: 1500, scrollHeight: 2000, clientHeight: 500 })).toBe(0);
    expect(distanceFromBottom({ scrollTop: 1200, scrollHeight: 2000, clientHeight: 500 })).toBe(300);
  });

  it('treats only the last few px as at-bottom', () => {
    const m = (scrollTop: number) => ({ scrollTop, scrollHeight: 2000, clientHeight: 500 });
    expect(isAtBottom(m(1500))).toBe(true);
    expect(isAtBottom(m(1500 - RESTICK_THRESHOLD_PX))).toBe(true);
    expect(isAtBottom(m(1500 - RESTICK_THRESHOLD_PX - 1))).toBe(false);
  });
});

describe('useStickToBottom', () => {
  let el: HTMLDivElement;
  let ref: React.RefObject<HTMLDivElement | null>;

  // Re-arming is debounced, so every test drives timers explicitly.
  const settle = () => act(() => { vi.advanceTimersByTime(REARM_IDLE_MS + 1); });

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    el = makeContainer();
    ref = createRef<HTMLDivElement>();
    (ref as any).current = el;
    layoutReads = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts stuck and follows new content', () => {
    const { result } = renderHook(() => useStickToBottom(ref));
    expect(result.current.atBottom).toBe(true);
    expect(result.current.stickRef.current).toBe(true);

    act(() => { result.current.scrollToBottom(); });
    expect(el.scrollTop).toBe(MAX_SCROLL);
  });

  // The regression this whole hook exists for: during a native-runtime turn the
  // content grows every few ms, and the growth handler re-pins to the bottom. A
  // single upward wheel notch must unstick SYNCHRONOUSLY — before that frame's
  // layout and observer callbacks — or the re-pin swallows the user's scroll and
  // they can never leave the bottom.
  it('unsticks on the first upward wheel notch, before any re-pin can run', () => {
    const { result } = renderHook(() => useStickToBottom(ref));
    act(() => { result.current.scrollToBottom(); });

    act(() => { wheel(el, -120); });

    // Read the ref, not the state: a growth handler firing later in this same
    // frame is what has to see the unstick.
    expect(result.current.stickRef.current).toBe(false);
    expect(result.current.atBottom).toBe(false);

    // A streaming delta arriving now must NOT drag the user back down.
    act(() => { if (result.current.stickRef.current) result.current.scrollToBottom(); });
    settle();
    expect(el.scrollTop).toBe(MAX_SCROLL - 120);
    expect(result.current.stickRef.current).toBe(false);
  });

  it('does not unstick on a downward wheel (it would never re-arm)', () => {
    // At the bottom, a downward wheel cannot move the container, so no scroll
    // event fires — unsticking here would strand us permanently unstuck.
    const { result } = renderHook(() => useStickToBottom(ref));
    act(() => { result.current.scrollToBottom(); });

    act(() => { wheel(el, 120); });

    expect(result.current.stickRef.current).toBe(true);
  });

  it('re-arms when the user scrolls back to the bottom', () => {
    const { result } = renderHook(() => useStickToBottom(ref));
    act(() => { result.current.scrollToBottom(); });
    act(() => { wheel(el, -400); });
    expect(result.current.stickRef.current).toBe(false);

    act(() => { wheel(el, 400); });
    settle();

    expect(result.current.stickRef.current).toBe(true);
    expect(result.current.atBottom).toBe(true);
  });

  it('stays unstuck while the user is still short of the bottom', () => {
    const { result } = renderHook(() => useStickToBottom(ref));
    act(() => { result.current.scrollToBottom(); });
    act(() => { wheel(el, -400); });

    act(() => { wheel(el, 300); }); // 100px short — beyond the re-arm threshold
    settle();

    expect(result.current.stickRef.current).toBe(false);
    expect(result.current.atBottom).toBe(false);
  });

  // Perf regression guard. The first dogfood build measured the scroll position
  // inline in the scroll handler, which forces a synchronous layout flush. While
  // the model streams, the DOM is dirty every frame, so that turned each scroll
  // event into a full reflow of the transcript and made scrolling feel laggy.
  describe('does not force layout on the scroll hot path', () => {
    it('reads nothing at all while pinned to the bottom', () => {
      const { result } = renderHook(() => useStickToBottom(ref));
      act(() => { result.current.scrollToBottom(); });

      layoutReads = 0;
      // A streaming turn re-pins constantly; each pin fires a scroll event.
      act(() => {
        for (let i = 0; i < 50; i++) {
          el.dispatchEvent(new Event('scroll'));
        }
      });

      expect(layoutReads).toBe(0);
    });

    it('measures once per gesture, not once per event, while unstuck', () => {
      const { result } = renderHook(() => useStickToBottom(ref));
      act(() => { result.current.scrollToBottom(); });
      act(() => { wheel(el, -400); });

      layoutReads = 0;
      act(() => {
        // 50 scroll events inside one continuous gesture.
        for (let i = 0; i < 50; i++) {
          el.scrollTop = el.scrollTop + 1;
          vi.advanceTimersByTime(10); // still under the idle gap
        }
      });
      expect(layoutReads).toBe(0); // nothing measured mid-gesture

      settle();
      // One check once the gesture goes quiet: distanceFromBottom reads
      // scrollHeight + clientHeight.
      expect(layoutReads).toBe(2);
    });
  });

  it('unsticks on an upward touch drag', () => {
    const { result } = renderHook(() => useStickToBottom(ref));
    act(() => { result.current.scrollToBottom(); });

    act(() => {
      // A finger moving DOWN the screen scrolls the content UP.
      el.dispatchEvent(new TouchEvent('touchstart', {
        touches: [{ clientY: 100 } as Touch], bubbles: true,
      }));
      el.dispatchEvent(new TouchEvent('touchmove', {
        touches: [{ clientY: 180 } as Touch], bubbles: true,
      }));
    });

    expect(result.current.stickRef.current).toBe(false);
  });

  it('unsticks on a scrollbar-gutter press (no wheel or touch events)', () => {
    const { result } = renderHook(() => useStickToBottom(ref));
    act(() => { result.current.scrollToBottom(); });

    act(() => {
      const e = new MouseEvent('pointerdown', { bubbles: true });
      // offsetX is read-only on the synthetic event; jsdom lets us define it.
      Object.defineProperty(e, 'offsetX', { value: 795 }); // inside clientWidth (800)
      el.dispatchEvent(e);
    });
    expect(result.current.stickRef.current).toBe(true); // a click on the content

    act(() => {
      const e = new MouseEvent('pointerdown', { bubbles: true });
      Object.defineProperty(e, 'offsetX', { value: 806 }); // in the scrollbar gutter
      el.dispatchEvent(e);
    });
    expect(result.current.stickRef.current).toBe(false);
  });

  it('jumpToBottom re-arms sticking and glides to the real bottom', () => {
    const { result } = renderHook(() => useStickToBottom(ref));
    act(() => { result.current.scrollToBottom(); });
    act(() => { wheel(el, -400); });
    expect(result.current.stickRef.current).toBe(false);

    act(() => { result.current.jumpToBottom(); });
    expect(result.current.stickRef.current).toBe(true);

    act(() => { vi.advanceTimersByTime(JUMP_GLIDE_MS + 50); });
    expect(el.scrollTop).toBe(MAX_SCROLL);
  });

  it('the glide re-reads the bottom each frame, so content that grows mid-glide is still reached', () => {
    const { result } = renderHook(() => useStickToBottom(ref));
    act(() => { result.current.scrollToBottom(); });
    act(() => { wheel(el, -400); });
    act(() => { result.current.jumpToBottom(); });
    act(() => { vi.advanceTimersByTime(JUMP_GLIDE_MS / 2); });
    expect(el.scrollTop).toBeLessThan(MAX_SCROLL);
    expect(el.scrollTop).toBeGreaterThan(MAX_SCROLL - 400);
  });

  it('scrolling up mid-glide cancels it instead of fighting the user', () => {
    const { result } = renderHook(() => useStickToBottom(ref));
    act(() => { result.current.scrollToBottom(); });
    act(() => { wheel(el, -800); });
    act(() => { result.current.jumpToBottom(); });
    act(() => { vi.advanceTimersByTime(JUMP_GLIDE_MS / 3); });
    act(() => { wheel(el, -100); });
    const stoppedAt = el.scrollTop;
    act(() => { vi.advanceTimersByTime(JUMP_GLIDE_MS * 2); });
    expect(el.scrollTop).toBe(stoppedAt);
    expect(result.current.stickRef.current).toBe(false);
  });

  it('an upward wheel that moves nothing (already at the bottom) re-arms instead of leaving the button stuck', () => {
    const { result } = renderHook(() => useStickToBottom(ref));
    act(() => { result.current.scrollToBottom(); });
    // Wheel over a nested scroller: the event bubbles here, but THIS container
    // does not move, so no scroll event follows.
    act(() => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })); });
    expect(result.current.atBottom).toBe(false);
    settle();
    expect(result.current.atBottom).toBe(true);
    expect(result.current.stickRef.current).toBe(true);
  });
});
