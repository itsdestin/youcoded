import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * "Stick to bottom" for the chat scroll container.
 *
 * Replaces the previous IntersectionObserver-on-a-sentinel approach, which had
 * two failure modes that combined into "I can't scroll up while the model is
 * streaming":
 *
 * 1. The sentinel sat at the end of the message list, but .chat-scroll has a
 *    padding-bottom of --bottom-chrome-height (+ queued strip + soft keyboard),
 *    so at rest the sentinel was already ~80-130px above the true bottom. The
 *    observer added another 150px of rootMargin on top. You had to travel
 *    ~250px upward before "at bottom" could even flip to false.
 * 2. Worse, it could never observe that travel. Within one frame the browser
 *    runs input handlers -> layout -> ResizeObserver callbacks -> *then*
 *    IntersectionObserver delivery. A streaming delta fires the content
 *    ResizeObserver, which re-pins scrollTop = scrollHeight using the still-true
 *    stick flag, so by the time intersections are computed the sentinel is back
 *    in view. Native sessions dispatch one reducer action per streaming delta
 *    (CC sessions append whole blocks from the JSONL transcript), so nearly
 *    every frame carried a re-pin and the user was never able to escape.
 *
 * The fix is to make unsticking *intent-driven and synchronous*: the wheel /
 * touch / scrollbar-drag / arrow-key handlers clear the flag inline, which
 * happens before layout and before any observer callback in that same frame.
 * Re-sticking is measured against the container's REAL bottom
 * (scrollHeight - scrollTop - clientHeight), which includes the padding, so
 * there is no sentinel geometry to get wrong.
 */

interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * How close to the true bottom re-arms auto-scroll. Deliberately small — the
 * user unsticks by intent, so this only has to absorb sub-pixel rounding and
 * the tail of a scroll-to-bottom, not act as a "close enough" dead zone.
 */
export const RESTICK_THRESHOLD_PX = 32;

/**
 * How long the scroll has to go quiet before we measure whether the user landed
 * at the bottom. Short enough to feel immediate, long enough that a gesture
 * costs one layout read rather than one per frame — see the PERF note below.
 */
export const REARM_IDLE_MS = 90;

export function distanceFromBottom(m: ScrollMetrics): number {
  return m.scrollHeight - m.scrollTop - m.clientHeight;
}

export function isAtBottom(m: ScrollMetrics, threshold = RESTICK_THRESHOLD_PX): boolean {
  return distanceFromBottom(m) <= threshold;
}

interface StickToBottom {
  /** True while pinned to the bottom. Drives the Jump-to-bottom button (inverted). */
  atBottom: boolean;
  /**
   * Live stick decision. Read this from observer/effect callbacks — the
   * `atBottom` state lags by a render, and the whole point of the fix is that
   * the growth path must see an unstick from the SAME frame it happened in.
   */
  stickRef: React.MutableRefObject<boolean>;
  /** Pin to the true bottom now (does not change the stick flag). */
  scrollToBottom: () => void;
  /** Re-arm sticking AND pin — for mount / tab-switch / a fresh user message. */
  stickToBottom: () => void;
  /** Smooth-scroll to the bottom and re-arm — the Jump-to-bottom button. */
  jumpToBottom: () => void;
  /** The user scrolled up: stop following new content. Safe to call repeatedly. */
  releaseStick: () => void;
}

export function useStickToBottom(
  containerRef: React.RefObject<HTMLElement | null>,
): StickToBottom {
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const setStick = useCallback((next: boolean) => {
    stickRef.current = next;
    // Only the button reads this; bail out when unchanged so a wheel burst
    // doesn't re-render the whole ChatView on every event.
    setAtBottom((prev) => (prev === next ? prev : next));
  }, []);

  // scrollTop = scrollHeight (over-scroll, clamped by the browser) rather than
  // sentinel.scrollIntoView: the sentinel sits ABOVE .chat-scroll's
  // padding-bottom, so scrollIntoView stops short by exactly the chrome height
  // and leaves the last message behind the input bar.
  const scrollToBottom = useCallback(() => {
    const c = containerRef.current;
    if (c) c.scrollTop = c.scrollHeight;
  }, [containerRef]);

  const stickToBottom = useCallback(() => {
    setStick(true);
    scrollToBottom();
  }, [setStick, scrollToBottom]);

  const releaseStick = useCallback(() => {
    if (stickRef.current) setStick(false);
  }, [setStick]);

  const jumpToBottom = useCallback(() => {
    setStick(true);
    const c = containerRef.current;
    if (c) c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' });
  }, [containerRef, setStick]);

  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;

    // Re-arm on arrival at the bottom. No "was this scroll ours?" bookkeeping is
    // needed: our own pins land at distance 0, where the flag is already true.
    //
    // PERF (this is load-bearing, don't inline the check back into onScroll):
    // isAtBottom() reads scrollTop/scrollHeight/clientHeight, and reading those
    // forces a synchronous layout flush. During a native turn the DOM is dirty
    // continuously — the in-flight turn re-renders on every streamed delta and
    // re-parses its markdown — so each read is a FULL forced reflow of a large
    // transcript, not a cached lookup. Doing that once per scroll event made
    // scrolling visibly janky while the model was generating (first dogfood
    // pass, 2026-07-28). Two guards keep it off the hot path:
    //   1. While pinned we return before reading anything at all.
    //   2. While unstuck we only measure once the scroll has gone quiet, so a
    //      gesture costs one reflow instead of one per frame.
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const checkRearm = () => {
      idleTimer = undefined;
      if (!stickRef.current && isAtBottom(c)) setStick(true);
    };
    const onScroll = () => {
      if (stickRef.current) return;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(checkRearm, REARM_IDLE_MS);
    };

    // Upward wheel intent. Passive on purpose — it only reads the delta; the
    // scrolling itself is the browser's own (ChatView has no wheel handler, see
    // its "left ENTIRELY to the browser engine" note). Downward wheel deliberately does NOT unstick: when already
    // pinned, scrolling down cannot move the container, so no scroll event would
    // fire to re-arm and we'd be left permanently unstuck at the bottom.
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) releaseStick();
    };

    // Touch (Android / phone over remote): a finger moving DOWN scrolls the
    // content UP. 2px of slack ignores the jitter of a stationary finger.
    let lastTouchY = 0;
    const onTouchStart = (e: TouchEvent) => {
      lastTouchY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0;
      if (y > lastTouchY + 2) releaseStick();
      lastTouchY = y;
    };

    // Scrollbar thumb drag produces neither wheel nor touch events, so it needs
    // its own signal. A click in the gutter targets the scroll container itself
    // (not a message), and its offsetX lands past the content box.
    const onPointerDown = (e: PointerEvent) => {
      if (e.target === c && e.offsetX >= c.clientWidth) releaseStick();
    };

    c.addEventListener('scroll', onScroll, { passive: true });
    c.addEventListener('wheel', onWheel, { passive: true });
    c.addEventListener('touchstart', onTouchStart, { passive: true });
    c.addEventListener('touchmove', onTouchMove, { passive: true });
    c.addEventListener('pointerdown', onPointerDown);
    return () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      c.removeEventListener('scroll', onScroll);
      c.removeEventListener('wheel', onWheel);
      c.removeEventListener('touchstart', onTouchStart);
      c.removeEventListener('touchmove', onTouchMove);
      c.removeEventListener('pointerdown', onPointerDown);
    };
  }, [containerRef, setStick, releaseStick]);

  return { atBottom, stickRef, scrollToBottom, stickToBottom, jumpToBottom, releaseStick };
}
