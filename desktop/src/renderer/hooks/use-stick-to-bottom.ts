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

/** Wheel events this soon after a quote-chip / Find jump are a trackpad's coast, not a new hand scroll. */
export const HOLD_COAST_MS = 300;

/** Length of the Jump-to-bottom glide. */
export const JUMP_GLIDE_MS = 260;

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
  /**
   * The APP is about to scroll somewhere on the reader's behalf (a quote chip,
   * Find): stop following AND do not re-arm on arrival near the bottom until the
   * user scrolls by hand again. Shows the Jump-to-bottom button at once.
   */
  holdPosition: () => void;
  /** A hand scroll the hook cannot see itself (ArrowDown): lets a held position re-arm. */
  noteUserScroll: () => void;
}

export function useStickToBottom(
  containerRef: React.RefObject<HTMLElement | null>,
): StickToBottom {
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  // WHY (Destin, 2026-11-12: "jump to bottom" flickered when dragging down in an
  // empty chat): an upward wheel / touch / ArrowUp un-pins at once — it has to,
  // see the header — but that alone used to show the button too. When the chat
  // cannot scroll (empty, or short) nothing moves, and the idle re-check hid the
  // button again 90 ms later: a flash. Now the button waits until the container
  // has REALLY moved away from the bottom (measured in the frame after a scroll
  // event, or by the idle re-check). Not moving = no button, ever.
  const revealPendingRef = useRef(false);
  const revealRafRef = useRef(0);
  // WHY (Destin, 2026-11-12: clicking a quote chip in a message just sent "gets
  // stuck to the bottom and pulls itself back down"): the chip scrolls to the
  // quoted words, which are usually the reply just above. That scroll often ends
  // within 32 px of the bottom (the browser cannot centre text that close to the
  // end), the idle re-check read that as "the user came back down" and re-pinned,
  // and the reply streaming in below then dragged the view away from the quote.
  // An app-made scroll is not the user returning: hold until a hand scroll.
  const holdRef = useRef(false);

  const cancelReveal = useCallback(() => {
    if (revealRafRef.current) cancelAnimationFrame(revealRafRef.current);
    revealRafRef.current = 0;
  }, []);

  const setStick = useCallback((next: boolean) => {
    stickRef.current = next;
    if (next) {
      holdRef.current = false;
      revealPendingRef.current = false;
      cancelReveal();
    }
    // Only the button reads this; bail out when unchanged so a wheel burst
    // doesn't re-render the whole ChatView on every event.
    setAtBottom((prev) => (prev === next ? prev : next));
  }, [cancelReveal]);

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

  // rAF id of an in-flight Jump-to-bottom glide (0 = none).
  const jumpRafRef = useRef(0);
  const cancelJump = useCallback(() => {
    if (jumpRafRef.current) cancelAnimationFrame(jumpRafRef.current);
    jumpRafRef.current = 0;
  }, []);

  // Set by the listener effect below: (re)starts the idle re-check.
  const scheduleCheckRef = useRef<() => void>(() => {});
  // When the last hold began — see the wheel handler's coast guard.
  const holdAtRef = useRef(0);

  const releaseStick = useCallback(() => {
    // The user took the wheel back: stop the glide so it can't fight their scroll.
    cancelJump();
    if (!stickRef.current) return;
    // Un-pin NOW (the growth pin must see it this frame) but leave the button to
    // the reveal check — see revealPendingRef.
    stickRef.current = false;
    revealPendingRef.current = true;
    // WHY always schedule the idle re-check here (review, 2026-11-12): an un-pin
    // that moves nothing (ArrowUp in an empty chat) fires no scroll event, so
    // without it nothing would ever re-arm OR show the button, and a reply
    // could then grow off-screen below with no way back but a send.
    scheduleCheckRef.current();
  }, [cancelJump]);

  const holdPosition = useCallback(() => {
    cancelJump();
    holdRef.current = true;
    holdAtRef.current = performance.now();
    revealPendingRef.current = false;
    cancelReveal();
    setStick(false);
  }, [cancelJump, cancelReveal, setStick]);

  // WHY a hand-rolled glide instead of scrollTo({behavior:'smooth'}): the native
  // smooth scroll aims at the scrollHeight read at click time. While a turn is
  // streaming (or an entry unfolds and re-measures) that target goes stale, and
  // the growth pin (scrollTop = scrollHeight) then cancels the animation mid-way
  // — a lurch — or the glide ends short with the button already hidden and no
  // way to retry. Here the target is re-read every frame, so it lands on the
  // bottom as it is NOW. Only ~15 frames, so the per-frame layout read is cheap.
  const jumpToBottom = useCallback(() => {
    setStick(true);
    cancelJump();
    const c = containerRef.current;
    if (!c) return;
    const reduce =
      document.documentElement.hasAttribute('data-reduced-effects') ||
      (typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (reduce || typeof requestAnimationFrame !== 'function') {
      c.scrollTop = c.scrollHeight;
      return;
    }
    const startTop = c.scrollTop;
    const startAt = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - startAt) / JUMP_GLIDE_MS);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const target = c.scrollHeight - c.clientHeight;
      c.scrollTop = startTop + (target - startTop) * eased;
      if (t < 1) {
        jumpRafRef.current = requestAnimationFrame(step);
      } else {
        jumpRafRef.current = 0;
        c.scrollTop = c.scrollHeight; // exact landing on the real bottom
      }
    };
    jumpRafRef.current = requestAnimationFrame(step);
  }, [containerRef, setStick, cancelJump]);

  useEffect(() => cancelJump, [cancelJump]);
  useEffect(() => cancelReveal, [cancelReveal]);

  // Set by the listener effect below; the hand-scroll signal for keys the hook
  // does not listen to itself (ChatView's ArrowDown).
  const userScrollRef = useRef<() => void>(() => {});
  const noteUserScroll = useCallback(() => userScrollRef.current(), []);

  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;

    // Re-arm on arrival at the bottom. No "was this scroll ours?" bookkeeping is
    // needed for our own PINS: they land at distance 0, where the flag is
    // already true. The one app-made scroll that is not a pin (a quote chip,
    // Find) sets holdRef, and only a hand scroll lifts it.
    //
    // PERF (this is load-bearing, don't inline the check back into onScroll):
    // isAtBottom() reads scrollTop/scrollHeight/clientHeight, and reading those
    // forces a synchronous layout flush. During a native turn the DOM is dirty
    // continuously — the in-flight turn re-renders on every streamed delta and
    // re-parses its markdown — so each read is a FULL forced reflow of a large
    // transcript, not a cached lookup. Doing that once per scroll event made
    // scrolling visibly janky while the model was generating (first dogfood
    // pass, 2026-07-28). Three guards keep it off the hot path:
    //   1. While pinned we return before reading anything at all.
    //   2. While unstuck we only measure once the scroll has gone quiet, so a
    //      gesture costs one reflow instead of one per frame.
    //   3. The button's reveal measures at most once per frame, and only until
    //      the button is up (normally the first frame: one wheel notch is >32px).
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const checkRearm = () => {
      idleTimer = undefined;
      if (stickRef.current) return;
      if (!holdRef.current && isAtBottom(c)) { setStick(true); return; }
      // Still away from the bottom (or held): the button belongs up. This also
      // covers content that grew below a reader whose own scroll never moved
      // the container (a wheel over a code block mid-reply).
      revealPendingRef.current = false;
      cancelReveal();
      setAtBottom(false);
    };
    const scheduleCheck = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(checkRearm, REARM_IDLE_MS);
    };
    const reveal = () => {
      revealRafRef.current = 0;
      if (stickRef.current || !revealPendingRef.current) return;
      if (distanceFromBottom(c) > RESTICK_THRESHOLD_PX) {
        revealPendingRef.current = false;
        setAtBottom(false);
      }
    };
    const onScroll = () => {
      if (stickRef.current) return;
      if (revealPendingRef.current && !revealRafRef.current) revealRafRef.current = requestAnimationFrame(reveal);
      scheduleCheck();
    };
    // A hand scroll in any direction: it lifts a hold, and re-checks once quiet.
    // Downward input still never UN-sticks (see onWheel).
    const userScroll = () => {
      holdRef.current = false;
      if (!stickRef.current) scheduleCheck();
    };
    userScrollRef.current = userScroll;
    scheduleCheckRef.current = scheduleCheck;

    // Upward wheel intent. Passive on purpose — it only reads the delta; the
    // scrolling itself is the browser's own (ChatView has no wheel handler, see
    // its "left ENTIRELY to the browser engine" note). Downward wheel deliberately does NOT unstick: when already
    // pinned, scrolling down cannot move the container, so no scroll event would
    // fire to re-arm and we'd be left permanently unstuck at the bottom.
    //
    // WHY it also schedules a re-check: an upward wheel over a short chat, or
    // over a code block / tool card that scrolls on its own, releases the stick
    // but never moves THIS container — so no scroll event follows. The idle
    // re-check re-arms in that case (and the button never showed, see
    // revealPendingRef); after a real scroll away it measures >32px and leaves
    // the button up.
    //
    // WHY the coast guard: a trackpad keeps delivering wheel events for a second
    // or more after the fingers lift. Those arriving just after a quote-chip
    // click are the old gesture, not a new one, and must not lift the hold.
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) releaseStick();
      if (e.deltaY === 0) return;
      if (holdRef.current && performance.now() - holdAtRef.current < HOLD_COAST_MS) return;
      userScroll();
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
      if (Math.abs(y - lastTouchY) > 2) userScroll();
      lastTouchY = y;
    };

    // Scrollbar thumb drag produces neither wheel nor touch events, so it needs
    // its own signal. A click in the gutter targets the scroll container itself
    // (not a message), and its offsetX lands past the content box.
    const onPointerDown = (e: PointerEvent) => {
      if (e.target === c && e.offsetX >= c.clientWidth) { releaseStick(); userScroll(); }
    };

    c.addEventListener('scroll', onScroll, { passive: true });
    c.addEventListener('wheel', onWheel, { passive: true });
    c.addEventListener('touchstart', onTouchStart, { passive: true });
    c.addEventListener('touchmove', onTouchMove, { passive: true });
    c.addEventListener('pointerdown', onPointerDown);
    return () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      cancelReveal();
      userScrollRef.current = () => {};
      scheduleCheckRef.current = () => {};
      c.removeEventListener('scroll', onScroll);
      c.removeEventListener('wheel', onWheel);
      c.removeEventListener('touchstart', onTouchStart);
      c.removeEventListener('touchmove', onTouchMove);
      c.removeEventListener('pointerdown', onPointerDown);
    };
  }, [containerRef, setStick, releaseStick, cancelReveal]);

  return {
    atBottom, stickRef, scrollToBottom, stickToBottom, jumpToBottom, releaseStick, holdPosition, noteUserScroll,
  };
}
