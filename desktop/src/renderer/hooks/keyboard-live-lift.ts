// What moves on the page while the Android keyboard glides, and the hand-over when it stops (card #213).
// See state/keyboard-glide.ts for how the keyboard code is divided.

/** Fired on window each time the chat's keyboard offset changes (the keyboard opened, closed or resized). */
export const KEYBOARD_OFFSET_EVENT = 'youcoded:keyboard-offset';

// WHY the glide does not write the page-wide variable each step (Destin, 2026-11-02: "it still feels jumpy/stuttery"):
// measured on the Z Flip7, one change to a variable on <html> makes the page re-check every element's styles, 6-7 ms
// on a calm page (up to 75 ms when busy), close to the whole 8 ms frame. So while gliding, only the few things that
// visibly move are changed, directly and cheaply — the message box and the empty-chat hint by transform, the frame's
// two bottom-edge elements (.chrome-glass, .chrome-outline, which hold nothing inside), and the messages (ChatView,
// through the event's `lift`). When the glide ends, --vvp-offset takes the final value once and the direct changes
// are removed in the same frame, so nothing moves at the hand-over.
//
// WHY this stays ONE unit and was not split further: show, clear and settle share the settled value and the frame
// edge's measured starting value, and the hand-over must be a single frame.
export function createKeyboardLiveLift() {
  let settled = 0;                // what --vvp-offset on <html> says
  // Measured ONCE per glide: read again mid-glide it would already include the lift, and the lift would pile up.
  let edgeBase: Map<HTMLElement, string> | null = null;
  // Looked up each frame, so a screen that was rebuilt mid-glide is still found.
  const liveEls = () => ({
    bar: document.querySelector<HTMLElement>('.bottom-float:not(.buddy-chat-bottom)'),
    hint: document.querySelector<HTMLElement>('.empty-chat-hint'),
    // A touch terminal's grid, strips and arrows ride up with the bar instead of shrinking (globals.css, [data-term-lift]).
    lifts: document.querySelectorAll<HTMLElement>('[data-term-lift]'),
    edges: [...document.querySelectorAll<HTMLElement>('.chrome-glass, .chrome-outline')],
  });
  const clear = () => {
    const { bar, hint, lifts } = liveEls();
    if (bar) bar.style.transform = '';
    for (const el of lifts) el.style.transform = '';
    if (hint) hint.style.transform = '';
    if (edgeBase) for (const el of edgeBase.keys()) el.style.removeProperty('--bottom-chrome-total');
    edgeBase = null;
  };
  return {
    /** True from the first glide step until the hand-over. */
    gliding: () => edgeBase !== null,
    /** One glide step: the chat's offset is `c` px right now. */
    show(c: number) {
      const lift = c - settled;
      const { bar, hint, lifts, edges } = liveEls();
      if (bar) bar.style.transform = `translateY(${-c}px)`;
      // WHY the grid lift too: the terminal grid may already be slid up over a taller message box (keyboard.css,
      // --term-grid-lift); dropping it for the glide would make the grid jump down and back.
      for (const el of lifts) el.style.transform = `translateY(calc(${-c}px - var(--term-grid-lift, 0px)))`;
      if (hint) hint.style.transform = `translateY(${-c / 2}px)`;
      if (!edgeBase) edgeBase = new Map(edges.map((el) => [el, getComputedStyle(el).getPropertyValue('--bottom-chrome-total').trim()]));
      for (const [el, base] of edgeBase) if (base) el.style.setProperty('--bottom-chrome-total', `calc(${base} + ${lift}px)`);
      window.dispatchEvent(new CustomEvent(KEYBOARD_OFFSET_EVENT, { detail: { lift } }));
    },
    /** The hand-over, all in this one call: final value on the page, direct moves removed, messages told. */
    settle(c: number) {
      settled = c;
      document.documentElement.style.setProperty('--vvp-offset', `${c}px`);
      clear();
      // ChatView keeps the newest message in view above the keyboard (it no longer gets a smaller window to notice).
      window.dispatchEvent(new CustomEvent(KEYBOARD_OFFSET_EVENT, { detail: { lift: 0 } }));
    },
  };
}
