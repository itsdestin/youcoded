import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Perf cycle 3 — stop DRAWING conversation entries that are far off screen,
 * without removing anything from the reducer.
 *
 * WHY THIS SHAPE, and not the two obvious alternatives:
 *
 *  * `content-visibility: auto` is closed. globals.css records it being reverted
 *    because its implicit `contain: paint` clips the box-shadow glows community
 *    themes draw. `.timeline-entry` keeps `contain: layout style` for that reason.
 *
 *  * EVICTING the entries from the reducer was specced and rejected on review
 *    (2026-08-28). Deleting a turn leaves its uuids in `seenUuids`, so scrolling
 *    back replays a page in which every event is dropped as already-seen — the
 *    messages are gone for the session — and clearing those uuids instead makes
 *    `mergeTotals` re-add the page's tokens on every re-fetch. Beyond that,
 *    ~15 readers fold the whole session-lifetime `toolCalls` / `toolGroups` /
 *    `assistantTurns` maps (the specialists ledger, `/copy`, `/usage`, task
 *    counts, an assistant turn whose record is missing renders as a silent hole).
 *
 * Folding touches NONE of that. The timeline entry, its reducer records and its
 * uuids all stay; only the rendered body goes, replaced by a spacer of exactly
 * the height it last occupied. So the scroll height never changes, there is
 * nothing to re-fetch, and unfolding is a render rather than a disk read.
 * Measured cost of not doing this: a conversation read to its beginning holds
 * ~1.44M DOM nodes and ~1.9 GB of non-JS memory.
 *
 * Guard: use-entry-folding.test.ts.
 */

/**
 * How far outside the viewport an entry must be before it is a fold candidate.
 *
 * Deliberately much wider than the `.in-view` observer's 200px: that one gates a
 * backdrop-filter and wants to be tight, while this one governs whether content
 * EXISTS. Folding something 200px away would unfold it again on the next flick
 * of the wheel, and the render churn would be worse than the memory it saved.
 * At ~1.5 screens either side this keeps roughly 3-4 screens of real content
 * mounted, which for the 7,000-entry fixture is ~100 entries instead of 7,000.
 */
const FOLD_MARGIN_PX = 1500;
export const FOLD_ROOT_MARGIN = `${FOLD_MARGIN_PX}px 0px`;

/**
 * Folding waits for scrolling to STOP; unfolding does not.
 *
 * Asymmetric on purpose. Unfolding late shows the user a blank gap, so it runs
 * on a short debounce — and FOLD_ROOT_MARGIN means it fires ~1.5 screens before
 * the entry could be seen. Folding late costs nothing but memory, so it waits
 * for an idle moment: folding mid-scroll re-renders the list under a moving
 * viewport, and scroll judder is the one regression in this area the user has
 * already reported by feel (2026-08-28, cycle 2).
 */
export const UNFOLD_DEBOUNCE_MS = 100;
export const FOLD_IDLE_MS = 800;

/**
 * How long a BACKGROUND conversation keeps the few screens it had built.
 *
 * WHY not FOLD_IDLE_MS: a background pane is `content-visibility: hidden`, so the
 * observer reports every one of its entries out of view, and 0.8s after you left
 * a tab the whole conversation was blank spacers. Switching back then played the
 * arrival animation on an empty column and the messages appeared after it had
 * finished (Destin, 2026-09-18: "messages often appear to pop-in instead of
 * animating in smoothly"). Flipping between tabs is the common case, and it
 * should find the messages still built.
 *
 * What this costs: only what the pane was ALREADY holding while it was on screen
 * (~3-4 screens, ~100 entries), and only as memory — a hidden pane is not laid
 * out or painted. Everything further away was folded before the pane left and
 * stays folded. After this long untouched, the rest folds too, so an app left
 * open for hours with many tabs is bounded exactly as before.
 */
export const INACTIVE_FOLD_MS = 5 * 60 * 1000;

interface FoldState {
  folded: ReadonlySet<string>;
  heights: ReadonlyMap<string, number>;
}

const EMPTY: FoldState = { folded: new Set(), heights: new Map() };

export interface EntryFolding {
  /** Callback ref for a timeline entry wrapper. Stable across renders. */
  registerEntry: (el: HTMLElement | null) => () => void;
  isFolded: (key: string) => boolean;
  heightOf: (key: string) => number | undefined;
  /**
   * Rebuild every folded entry within FOLD_MARGIN_PX of the scroller, NOW.
   *
   * For the caller's layout effect on a session switch: the observer reports a
   * frame late and unfolding is debounced on top of that, which is correct while
   * scrolling and is exactly the pop-in on a switch. Called before the first
   * paint, the state update is flushed by React in the same frame, so the pane's
   * first visible frame already has its messages. Spacers hold real heights, so
   * the rects read here are where the entries will actually be.
   */
  unfoldNearViewport: () => void;
}

/**
 * @param enabled  false suspends folding AND unfolds everything — used while the
 *   find bar is open, because `ContentFindBar` finds text by walking the DOM
 *   (`document.createTreeWalker`), so a folded entry is unfindable. Find is a
 *   deliberate user action on a bounded conversation, so paying the full DOM back
 *   for its duration is the right trade; the alternative is telling the user
 *   "0 results" for text that is in their conversation.
 * @param active  false while this conversation's pane is in the background —
 *   see INACTIVE_FOLD_MS.
 */
export function useEntryFolding(
  enabled: boolean,
  rootRef: React.RefObject<HTMLElement | null>,
  active = true,
): EntryFolding {
  const [state, setState] = useState<FoldState>(EMPTY);

  // Everything the observer writes lives in refs. A setState per intersection
  // would be one render per entry per scroll — the observer fires for hundreds
  // of elements at a time, and this hook exists to make rendering cheaper.
  const heights = useRef(new Map<string, number>());
  const folded = useRef(new Set<string>());
  // MEMBERSHIP, not a queue — and that distinction is the whole correctness
  // argument. The first version drained a `pendingFold` queue and cleared it,
  // skipping any entry with no measured height yet. An entry prepended above the
  // viewport is observed while ALREADY outside the band, so its one and only
  // out-of-view report arrives before it has ever been seen or measured: it was
  // skipped, cleared, and — because IntersectionObserver reports TRANSITIONS and
  // it never transitions again — could never be folded for the rest of the
  // session. Measured: 741 of 12,100 entries folded, 6%. Holding membership
  // instead means every flush re-evaluates every out-of-view entry, so one that
  // becomes measurable later is picked up by the next flush.
  const outOfView = useRef(new Set<string>());
  // The live element per key, so a fold can MEASURE rather than remember.
  //
  // This is the difference between folding 6% of a conversation and folding all
  // of it. Heights used to be recorded only when an entry reported *visible*,
  // which quietly required every entry to have passed within FOLD_ROOT_MARGIN of
  // the viewport at some point. A page prepends ~60 entries at once and only the
  // top few of them fall inside that band, so the other ~56 were never measured
  // and therefore never foldable — measured at 433/7000, 294/5000 and 1/100
  // across three conversations, uniformly ~6%, in three different builds.
  // At fold time the element is in the DOM and has a real height; just read it.
  const elements = useRef(new Map<string, HTMLElement>());
  const observer = useRef<IntersectionObserver | null>(null);
  const unfoldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const foldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const activeRef = useRef(active);
  activeRef.current = active;

  const publish = useCallback(() => {
    setState({ folded: new Set(folded.current), heights: new Map(heights.current) });
  }, []);

  const flushUnfold = useCallback(() => {
    unfoldTimer.current = null;
    let changed = false;
    for (const key of folded.current) {
      if (!outOfView.current.has(key)) { folded.current.delete(key); changed = true; }
    }
    if (changed) publish();
  }, [publish]);

  const flushFold = useCallback(() => {
    foldTimer.current = null;
    if (!enabledRef.current) return;
    let changed = false;
    for (const key of outOfView.current) {
      if (folded.current.has(key)) continue;
      // Measure NOW, from the element itself. Falls back to a height captured
      // while the entry was visible, which is what makes an inactive session
      // foldable: its pane is `content-visibility: hidden`, so its children lay
      // out to 0 and only the remembered height is usable.
      const live = elements.current.get(key)?.offsetHeight ?? 0;
      const h = live > 0 ? live : heights.current.get(key);
      // Still nothing: never fold. A 0px spacer would collapse the scroll height
      // under the reader. It stays in outOfView, so a later flush reconsiders it.
      if (!h) continue;
      heights.current.set(key, h);
      folded.current.add(key);
      changed = true;
    }
    if (changed) publish();
  }, [publish]);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    // ROOT IS THE SCROLLER, NOT THE VIEWPORT — and this is the whole difference
    // between a 1500px lead and none at all.
    //
    // With `root: null` the root is the document viewport, and `rootMargin`
    // expands only THAT rect. Per spec the intermediate clipping ancestors are
    // still applied at their true bounds, and `.chat-scroll` is exactly such an
    // ancestor — so the margin bought nothing and an entry unfolded at the
    // moment it entered the visible area. Destin saw the result immediately:
    // "even when I scroll SUPER slowly, I can watch the newest message pop in
    // instead of smoothly scrolling in" (2026-09-03).
    //
    // The history-sentinel observer in ChatView already does this correctly
    // (`{ root, rootMargin: '400px 0px' }`), which is what identified it.
    const root = rootRef.current ?? null;
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.entryKey;
        if (!key) continue;
        if (entry.isIntersecting) {
          // Measure ONLY while unfolded — a folded entry's offsetHeight is the
          // spacer we set, so measuring then would freeze it forever at whatever
          // it happened to be, and re-measuring a stale value is how a list
          // slowly drifts out of alignment with its own scroll height.
          if (!folded.current.has(key)) {
            const h = (entry.target as HTMLElement).offsetHeight;
            if (h > 0) heights.current.set(key, h);
          }
          outOfView.current.delete(key);
          if (unfoldTimer.current == null) unfoldTimer.current = setTimeout(flushUnfold, UNFOLD_DEBOUNCE_MS);
        } else {
          outOfView.current.add(key);
          // Restarted on every out-of-view report, so this only fires once the
          // scroll has actually settled.
          if (foldTimer.current != null) clearTimeout(foldTimer.current);
          foldTimer.current = setTimeout(flushFold, activeRef.current ? FOLD_IDLE_MS : INACTIVE_FOLD_MS);
        }
      }
    }, { root, rootMargin: FOLD_ROOT_MARGIN });
    observer.current = io;
    // Ref callbacks run in the commit/layout phase, BEFORE this effect runs —
    // so every entry present on the FIRST commit already called registerEntry()
    // while observer.current was still null. Pre-fix those elements sat in
    // elements.current forever unobserved: entries already on screen when
    // ChatView / PreviewTimeline / BubbleFeed mounted could never fold. The
    // same gap reopens whenever this effect's deps change and it builds a new
    // observer, so sweep elements.current unconditionally rather than only on
    // first mount. registerEntry's own io.observe() still covers entries
    // registered AFTER the observer exists.
    for (const el of elements.current.values()) io.observe(el);
    return () => {
      io.disconnect();
      observer.current = null;
      if (unfoldTimer.current != null) clearTimeout(unfoldTimer.current);
      if (foldTimer.current != null) clearTimeout(foldTimer.current);
      unfoldTimer.current = null;
      foldTimer.current = null;
    };
  }, [flushFold, flushUnfold, rootRef]);

  // The pane changed sides. Either way the pending fold is re-timed for the side
  // it is now on, and membership is untouched:
  //  • to the background — a fold armed moments before the switch would
  //    otherwise fire at 0.8s against a pane whose every entry now reads as out
  //    of view, which is the blanking this file's INACTIVE_FOLD_MS exists to stop;
  //  • back to the front — the return scrolls to the bottom, so what was on
  //    screen when the pane left may now be far away. The observer reports
  //    TRANSITIONS and those entries will not transition again, so without a
  //    flush they would stay built until scrolled past. By the time it fires the
  //    observer has long since removed what IS on screen from `outOfView`.
  useEffect(() => {
    if (outOfView.current.size === 0 && foldTimer.current == null) return;
    if (foldTimer.current != null) clearTimeout(foldTimer.current);
    foldTimer.current = setTimeout(flushFold, active ? FOLD_IDLE_MS : INACTIVE_FOLD_MS);
  }, [active, flushFold]);

  const unfoldNearViewport = useCallback(() => {
    const root = rootRef.current;
    if (!root || folded.current.size === 0) return;
    const r = root.getBoundingClientRect();
    const top = r.top - FOLD_MARGIN_PX;
    const bottom = r.bottom + FOLD_MARGIN_PX;
    let changed = false;
    // Walked in DOCUMENT order from the END, and abandoned at the first entry
    // above the band. WHY not `for (key of folded)`: a long conversation read to
    // its top has thousands of folded entries, nearly all of them far above, and
    // the first version measured every one of them on every switch — inside the
    // click, ahead of the first frame (Destin, 2026-09-18: "the switch still lags
    // a second behind me clicking"). A switch lands at the bottom, so this reads
    // a band's worth however long the conversation is. Nothing is written between
    // reads, so it is still one layout.
    const entries = root.querySelectorAll<HTMLElement>('[data-entry-key]');
    for (let i = entries.length - 1; i >= 0; i--) {
      const el = entries[i];
      const b = el.getBoundingClientRect();
      if (b.top > bottom) continue;
      if (b.bottom < top) break;
      const key = el.dataset.entryKey;
      if (!key || !folded.current.has(key)) continue;
      folded.current.delete(key);
      // Also out of `outOfView`, or the next fold flush would fold it straight
      // back. The observer still believes it is out of view, so its own
      // "now visible" report follows within a frame and agrees.
      outOfView.current.delete(key);
      changed = true;
    }
    if (changed) publish();
  }, [publish, rootRef]);

  // Suspending folding must unfold what is already folded, synchronously enough
  // that the find bar never walks a DOM with holes in it.
  useEffect(() => {
    if (enabled) return;
    if (foldTimer.current != null) { clearTimeout(foldTimer.current); foldTimer.current = null; }
    if (folded.current.size === 0) return;
    folded.current.clear();
    publish();
  }, [enabled, publish]);

  // Same contract as useObservedRef: ALWAYS return a cleanup, so React never
  // falls back to calling the ref with null (see that hook for the regression).
  const registerEntry = useCallback((el: HTMLElement | null) => {
    if (!el) return NOOP;
    const key = el.dataset.entryKey;
    if (key) elements.current.set(key, el);
    const io = observer.current;
    if (!io) return () => { if (key) elements.current.delete(key); };
    io.observe(el);
    return () => {
      io.unobserve(el);
      // Only drop the mapping if it still points at THIS element: a re-render
      // that swaps the node registers the new one before releasing the old.
      if (key && elements.current.get(key) === el) elements.current.delete(key);
    };
  }, []);

  const isFolded = useCallback((key: string) => state.folded.has(key), [state]);
  const heightOf = useCallback((key: string) => state.heights.get(key), [state]);

  return { registerEntry, isFolded, heightOf, unfoldNearViewport };
}

const NOOP = () => {};
