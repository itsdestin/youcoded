// The session pill's name label: how wide it may get and how it gets there.
//
// Extracted from SessionStrip.tsx because the two causes of the 2026-08-31
// "active pill snaps open" bug both lived in this one expression and neither
// was reachable by a test while it sat in JSX.
//
// HOW THE LABEL ANIMATES (2026-09-01 rebuild). The label is a clipping box
// (`overflow: hidden`) around a name that is laid out ONCE at its full width
// (`width: max-content`, see .session-pill__name in globals.css). Only the
// box's `max-width` animates, between 0 and a NUMBER the strip already
// measured for the packer. Two things that follow from this are the point:
//   • The text never re-wraps or re-ellipsises while the box moves. The first
//     version animated the text's own width, so the browser re-fitted "theme
//     contrast pass" on every frame — "theme …", "theme cont…", "theme contra…"
//     — a shimmering ellipsis for a fifth of a second on every click.
//   • Both ends are plain pixel values, so there is always a pair for the
//     browser to interpolate. The original snap was `maxWidth: undefined` on
//     exactly the pill that had just become active.
// What is clipped is faded out by a mask, not cut with "…", the way Chrome
// fades a tab title — so a squeezed active pill and a mid-animation pill look
// like the same thing at two moments, not two different treatments.
import type React from 'react';

/** How wide a name may get when it is showing ONLY because you are pointing at
 *  it. A hover is a peek, and a very long name should not shove the row around
 *  under the cursor.
 *
 *  It is NOT a cap on pills the packer chose to expand: the packer measured the
 *  room a full name needs before expanding anything, so capping there clipped a
 *  name the strip had already made space for. The active pill is likewise
 *  uncapped — it shrinks only when the strip itself runs out of room. */
export const HOVER_CAP_PX = 120;

/** Trailing room inside the label box past the text, in px. It is what the
 *  fade mask fades over when the name fits, so the last letter is never the
 *  thing being faded. Must match `.session-pill__name`'s padding-right and the
 *  mask stop in globals.css — pinned by animation-frame-budget.test.ts.
 *  It doubles as the pill's right padding (the pill has none of its own), so
 *  it is the 7px that sits left of the visible dot: 12 left the right side of
 *  every named pill visibly wider (Destin, 2026-09-27). */
export const LABEL_TAIL_PX = 7;

/** Extra px the label box opens past text + tail. The text width comes from a
 *  canvas measurement of the same font; canvas and layout can still disagree by
 *  a fraction, and a box one px too narrow would fade the last letter. */
export const LABEL_SLACK_PX = 2;

export interface LabelStyleInput {
  /** The name is meant to be visible at all (hovered, pack-expanded, or active). */
  showName: boolean;
  isActive: boolean;
  /** `pack.expanded.has(id)` — the packer decided this pill shows its name. */
  packExpanded: boolean;
  /** True only inside the short window armed by a change of active session id. */
  animateExpand: boolean;
  /** The name's measured text width in px — the same canvas measurement the
   *  packer budgets with, so the box opens to exactly the room reserved. */
  nameWidth: number;
  /** For a HOVER PEEK only: the px the strip has free beside its packed row.
   *  A peek may not open wider than this. WHY (2026-09-03): the packer never
   *  reserved room for a peek, and in a full strip the peek pushed the row
   *  past its box — the active pill is the one flex item allowed to shrink,
   *  so hovering any dot squeezed the active NAME (191px → 78px measured),
   *  and it popped back whole the instant that dot was pressed. Chrome does
   *  not widen a tab on hover at all; here the peek opens as far as there is
   *  room, and not at all when there is none. Absent = unlimited (tests). */
  room?: number;
}

// WIDTH-LIKE PROPERTIES ARE NEVER ANIMATED ON AN OVERSHOOT CURVE. max-width is
// a layout property: every sibling in the strip re-lays-out on every frame of
// it, so an overshoot sends the whole row past its destination and back.
// Measured 2026-08-31 on one session switch: the pill went 202.5 → 261.9 →
// 251.3 and every pill to its right slid with it. Guard: pill-label-style.test.ts
// → "never animates width on an overshoot curve".
const REVEAL_TRANSITION =
  'max-width var(--dur-reveal) var(--ease-reveal), opacity var(--dur-hover) var(--ease-reveal)';

/** The pixel width the label box opens to for this pill. Exported so the
 *  badge can wait for exactly this reveal (SessionStrip) and tests can pin it. */
export function labelTargetWidth(input: Pick<LabelStyleInput, 'isActive' | 'packExpanded' | 'nameWidth' | 'room'>): number {
  const { isActive, packExpanded, nameWidth, room } = input;
  // Capped only when the name is a HOVER PEEK — neither the active pill nor
  // one the packer measured room for. See HOVER_CAP_PX, and `room`.
  const hoverPeek = !isActive && !packExpanded;
  const natural = Math.ceil(nameWidth) + LABEL_TAIL_PX + LABEL_SLACK_PX;
  return hoverPeek ? Math.max(0, Math.min(natural, HOVER_CAP_PX, room ?? Infinity)) : natural;
}

export function pillLabelStyle(input: LabelStyleInput): React.CSSProperties {
  const { showName, packExpanded, animateExpand } = input;

  // `none` suppresses repack churn — without it every pill would slide whenever
  // the packer reruns (a window resize, a session opening). But packSessions
  // guarantees the active pill is ALWAYS pack-expanded, so this same `none`
  // used to silence the one pill the user just clicked. The armed window is
  // the narrow exception.
  const transition = packExpanded && !animateExpand ? 'none' : REVEAL_TRANSITION;

  return {
    maxWidth: showName ? `${labelTargetWidth(input)}px` : '0px',
    opacity: showName ? 1 : 0,
    transition,
  };
}
