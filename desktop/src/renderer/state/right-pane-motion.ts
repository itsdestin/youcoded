// What the right-hand pane (Session Files, or Games) SHOWS and what room it
// RESERVES, across an open, a close, and a switch between the two — which are
// different widths (--drawer-width, user-resizable, vs --game-pane-width).
//
// Destin, 2026-09-18: "i want the animation to smoothly handle open/close and
// switching between differently sized game/file panels", and of all motion:
// "interruptible and smooth ... aware of performance".
//
// THE ONE IDEA. The pane's visible EDGE animates; the room reserved for it in the
// layout does not. The chat column is a flex sibling of the pane, so every change
// to the reserved width re-wraps the whole transcript — and doing that per frame
// is the stutter this app has measured before (globals.css, the 1,487 ms open).
// So the reservation changes exactly ONCE per gesture, at the end it cannot be
// seen from:
//     growing   (open, or switch to the wider pane)    reserve FIRST, glide into it
//     shrinking (close, or switch to the narrower one) glide away, release LAST
// which is simply: while anything is in flight, reserve the WIDER of where the
// pane was and where it is going. `reserve` below is that, as the pair of kinds
// whose widths CSS takes the max() of — no pixel is measured here.
//
// WHY A PURE REDUCER: App owns this (the frosted frame's cut-out, the chat view's
// slot and terminal view's clone must all agree on the same frame), and the
// transitions are exactly the part that goes wrong silently — a pane that stays
// reserved forever, or a second click mid-close that leaves nothing on screen.
// Every row of the table is a test in right-pane-motion.test.ts.

export type PaneKind = 'drawer' | 'game';

export interface PaneMotion {
  /** What is RENDERED. Stays set while the pane animates out. */
  shown: PaneKind | null;
  /** True from the close request until the view reports the exit finished. */
  closing: boolean;
  /** The kind being switched AWAY from, until the view reports the glide
   *  finished. The layout reserves max(width(from), width(shown)) meanwhile. */
  from: PaneKind | null;
}

export const PANE_IDLE: PaneMotion = { shown: null, closing: false, from: null };

export type PaneMotionEvent =
  /** The app's real state changed: which pane is wanted now, if any. */
  | { type: 'want'; kind: PaneKind | null }
  /** The view finished animating the pane out (or a safety timer stood in). */
  | { type: 'exited' }
  /** The view finished gliding between two widths (or a safety timer did). */
  | { type: 'settled' };

export function paneMotionReducer(m: PaneMotion, e: PaneMotionEvent): PaneMotion {
  switch (e.type) {
    case 'want': {
      const kind = e.kind;
      if (kind === null) {
        // Nothing shown, or already leaving: nothing new to do.
        if (m.shown === null || m.closing) return m;
        // A close mid-switch abandons the switch: it leaves from where it is.
        return { shown: m.shown, closing: true, from: null };
      }
      // Nothing on screen: it simply opens.
      if (m.shown === null) return { shown: kind, closing: false, from: null };
      if (m.shown === kind) {
        // REOPENED MID-CLOSE — the interruption case. Same pane, still mounted,
        // so the view reverses the glide from wherever it is.
        return m.closing ? { shown: kind, closing: false, from: m.from } : m;
      }
      // A different pane. `from` is what is on screen NOW — also when this
      // interrupts an earlier switch, because that is the width being left.
      return { shown: kind, closing: false, from: m.shown };
    }
    case 'exited':
      // Only a pane that is still closing may be removed: a late 'exited' from a
      // close that was since interrupted must not take a reopened pane away.
      return m.closing ? PANE_IDLE : m;
    case 'settled':
      return m.from === null ? m : { ...m, from: null };
  }
}

/** Does the layout still hold room for a pane? True while one animates OUT. */
export function paneIsPresent(m: PaneMotion): boolean {
  return m.shown !== null;
}

const WIDTH_VAR: Record<PaneKind, string> = {
  drawer: 'var(--drawer-width, 480px)',
  game: 'var(--game-pane-width, 420px)',
};

/** The pane's own width — what its CONTENT is laid out at. */
export function paneContentWidth(kind: PaneKind): string {
  return WIDTH_VAR[kind];
}

/** `--right-pane-width`: the room the layout reserves, which is also what the
 *  frosted frame's cut-out reads. The wider of the two while a switch is in
 *  flight; CSS resolves the max(), so a user-resized drawer needs no measuring. */
export function paneReserveWidth(m: PaneMotion): string {
  if (m.shown === null) return WIDTH_VAR.drawer;   // unused while closed; today's default
  if (m.from === null || m.from === m.shown) return WIDTH_VAR[m.shown];
  return `max(${WIDTH_VAR[m.from]}, ${WIDTH_VAR[m.shown]})`;
}
