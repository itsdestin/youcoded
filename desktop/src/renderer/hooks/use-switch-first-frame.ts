// A SESSION SWITCH SHOWS ITS MESSAGES ON ITS FIRST FRAME (2026-09-18).
//
// Destin: "when i switch tabs, messages often appear to pop-in instead of
// animating in smoothly". The arrival animation was fine; it was playing on a
// pane whose content turned up afterwards, three ways, all fixed HERE because a
// layout effect is the last moment before the browser paints:
//  1. the scroll-to-bottom ran in a requestAnimationFrame, i.e. one painted
//     frame AFTER the pane appeared at its old position — a visible jump;
//  2. entries folded while the pane was away were unfolded by an observer report
//     (a frame late) plus a 100ms debounce, so the animation rose on blank
//     spacers and the messages landed once it was over;
//  3. `.in-view` — which ChatView's blur observer strips from every entry of a
//     hidden pane, and which React never puts back because the className string
//     it renders has not changed — returned a frame late, so on glass themes the
//     bubbles painted flat and frosted over afterwards.
//
// The work this moves in front of the first paint is the same work that used to
// happen just behind it; the previous conversation stays on screen for that
// moment instead of a blank one.
//
// Guard: use-switch-first-frame.test.tsx.
import { useLayoutEffect } from 'react';

/** The blur observer's band (`rootMargin: '200px 0px'` in ChatView), which takes
 *  over from here on the next frame. */
const IN_VIEW_MARGIN_PX = 200;

export function useSwitchFirstFrame(
  visible: boolean,
  scrollerRef: React.RefObject<HTMLElement | null>,
  stickToBottom: () => void,
  unfoldNearViewport: () => void,
): void {
  useLayoutEffect(() => {
    if (!visible) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    // Order matters: scroll first, so the other two measure where the reader
    // will actually be.
    stickToBottom();
    unfoldNearViewport();
    const box = scroller.getBoundingClientRect();
    // Walked from the END and abandoned at the first entry above the band: the
    // pane was just scrolled to its bottom, so this touches a screenful however
    // long the conversation is.
    // Read everything, THEN write: a class change between two rect reads makes
    // the browser redo its layout for each one.
    const entries = scroller.querySelectorAll<HTMLElement>('.timeline-entry');
    const nowInView: HTMLElement[] = [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const b = entries[i].getBoundingClientRect();
      if (b.bottom < box.top - IN_VIEW_MARGIN_PX) break;
      if (b.top <= box.bottom + IN_VIEW_MARGIN_PX) nowInView.push(entries[i]);
    }
    for (const el of nowInView) el.classList.add('in-view');
  }, [visible, scrollerRef, stickToBottom, unfoldNearViewport]);
}
