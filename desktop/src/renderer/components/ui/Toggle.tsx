import React from 'react';
import { FOCUS_RING } from './Button';

/**
 * The one toggle (change 15, §1.2).
 *
 * ONE geometry — 36x20, which was SyncPanel's. It's the largest of the four that
 * existed (32x16, 32x18, 28x16, 36x20) and therefore the best touch target,
 * which matters because this renderer is also the Android UI.
 *
 * Also fixes a11y: only 2 of the ~14 switches in the app had any aria at all.
 *
 * Use Toggle for settings/state, Checkbox for consent, chips for filters,
 * Radio for option lists (design rule 8).
 */

export type ToggleTone = 'default' | 'danger';

const TRACK_ON: Record<ToggleTone, string> = {
  // was green-600 in settings/sync — the app's accent is the on-state now (change 16)
  default: 'bg-accent',
  // was a raw #DD4444 hex; danger toggles (Skip permissions, approve-all) ride
  // the theme's destructive token so packs can restyle them (change 17)
  danger: 'bg-destructive',
};

/**
 * Track geometry.
 *
 * The border is present in BOTH states — visible when off, transparent when on.
 * That is load-bearing, not decoration: `absolute` children position against the
 * PADDING box, so a border that exists in only one state shifts the knob by 1px
 * when you flip it. (The spec flagged this as risk 3 and asked for the 18px/2px
 * knob positions to be "visually verified on both states" — keeping the border
 * constant means there's nothing to verify: the two states are geometrically
 * identical by construction.)
 */
// Change 48: coarse-hit. The 36x20 geometry was chosen FOR Android touch, but
// 20px tall is still less than half the ~44dp guideline on the short axis — the
// size that made it look right for a phone did not make it easy to hit on one.
// `.coarse-hit` paints an invisible centred 44x44 target under `pointer: coarse`
// only, so desktop is byte-identical. The `relative` it needs is already here.
const TRACK_BASE =
  'relative coarse-hit w-9 h-5 rounded-full border transition-colors shrink-0 ' +
  'disabled:opacity-60 disabled:cursor-not-allowed ' +
  FOCUS_RING;

/**
 * Knob offsets, in px, relative to the track's PADDING box (inset 1px by the
 * border above). 1 -> 17 renders as a symmetric 2px gap on each end with a 16px
 * travel, which is the approved 36x20 / 16px-knob geometry.
 *
 * The spec wrote these as 2 -> 18 because it measured against a border-less
 * track; with the constant border those same numbers would push the knob 1px
 * past center. Same rendered result, corrected for the box it actually lives in.
 */
const KNOB_LEFT_OFF = 1;
const KNOB_LEFT_ON = 17;

export type ToggleProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> & {
  checked: boolean;
  onChange: (next: boolean) => void;
  tone?: ToggleTone;
};

export const Toggle = React.forwardRef<HTMLButtonElement, ToggleProps>(function Toggle(
  { checked, onChange, tone = 'default', className = '', disabled, ...rest },
  ref,
) {
  const track = checked
    ? `${TRACK_ON[tone]} border-transparent`
    : 'bg-inset border-edge-dim';

  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`${TRACK_BASE} ${track} ${className}`.trim()}
      {...rest}
    >
      {/* Knob. The border is not decoration either: bare bg-white sits at ~1.2:1
          against Creme's off-state track (--inset #DDD1BE), where shadow-sm was
          doing all the work of separating knob from track. The ring keeps it
          legible on light themes and is invisible on dark ones. */}
      <span
        className="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-white border border-edge-dim shadow-sm transition-all"
        style={{ left: checked ? KNOB_LEFT_ON : KNOB_LEFT_OFF }}
      />
    </button>
  );
});
