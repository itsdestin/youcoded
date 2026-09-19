import React from 'react';

/**
 * A progress bar made of PARTS — one segment per thing that has to finish,
 * each as wide as the work it stands for.
 *
 * WHY IT IS A PRIMITIVE AND NOT A CLASS STRING (G-1): `ProgressBar` draws ONE
 * fill across one track, so a plan whose steps are three specialists, then one,
 * then one can only be a percentage there — the shape of the work is lost. The
 * plan card's proposed state needs exactly that shape, and the running card
 * needs the SAME object filling in as steps finish, so the two cannot be two
 * different drawings. Anything else that has countable parts with a size (an
 * install with four packages, a sync with N conversations) gets this too.
 *
 * WHY THE RADIUS IS `full`: the app's progress bar is `rounded-full` track and
 * fill (`ProgressBar.tsx`). G-3 forbids a *role* appearing at two radii, and
 * this is that role, so it carries that radius rather than a second one.
 *
 * WHY ACCENT ONLY ON `done`/`running` (G-8): the accent paints STATE, never
 * decoration. A segment that has not started is not a state worth colouring —
 * it is an empty outline, the same `inset` + `edge-dim` any resting inset
 * container wears (§2.4).
 */

/** Not exported yet, and deliberately: `npm run knip` counts an exported type
 *  nobody imports as dead weight, and the only caller today writes its states
 *  as literals. Export it when the running plan card needs to name one. */
type SegmentState = 'done' | 'running' | 'pending';

export interface ProgressSegment {
  /** Stable key. */
  id: string;
  /**
   * Relative width — how much work this segment stands for (a plan step's
   * fan-out: three specialists is three times the width of one). Anything
   * under 1, and anything that is not a finite number, counts as 1: a segment
   * that stands for something must still be visible.
   */
  weight?: number;
  /** Defaults to `pending`. */
  state?: SegmentState;
  /** What this segment is — the pointer tooltip and the accessible name. */
  label: string;
}

/** Same reason as `SegmentState`: internal until a caller has to name it. */
interface SegmentedProgressProps {
  segments: ProgressSegment[];
  /** Names the whole bar: "Plan shape — 3 steps, none finished". Required,
   *  because a bar with no words is unreadable to a screen reader. */
  'aria-label': string;
  className?: string;
}

const FILL: Record<SegmentState, string> = {
  done: 'bg-accent',
  // In motion, so it is filled but not finished — the same accent at a quarter
  // strength rather than a second colour.
  running: 'bg-accent/25',
  pending: 'bg-inset border border-edge-dim',
};

export function SegmentedProgress({ segments, 'aria-label': ariaLabel, className = '' }: SegmentedProgressProps) {
  const done = segments.filter((s) => (s.state ?? 'pending') === 'done').length;
  return (
    <div
      className={`flex items-stretch gap-1 h-2 ${className}`.trim()}
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={segments.length}
      aria-valuenow={done}
    >
      {segments.map((s) => (
        <span
          key={s.id}
          title={s.label}
          className={`rounded-full ${FILL[s.state ?? 'pending']}`}
          // flexBasis 0 so the weights alone decide the widths — with the
          // default `auto` basis an empty span's content size (0) still leaves
          // borders and gaps out of the ratio, and the segments drift off the
          // shape they are supposed to be showing.
          style={{ flexGrow: weightOf(s.weight), flexBasis: 0 }}
        />
      ))}
    </div>
  );
}

function weightOf(weight: number | undefined): number {
  return Number.isFinite(weight) && (weight as number) > 1 ? (weight as number) : 1;
}
