import React from 'react';
import { FOCUS_RING } from './Button';

/**
 * Consent checkbox (§1.4).
 *
 * Narrow by design: Toggle owns settings/state, chips own filters, Radio owns
 * option lists (design rule 8). After the migration this has essentially one
 * call site — ProjectView's delete-consent checkbox — plus whatever future
 * consent gates appear.
 */

export type CheckboxProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> & {
  checked: boolean;
  onChange: (next: boolean) => void;
};

// The box's two paints, shared by the control and the mark below so the two can
// never drift apart.
const MARK_ON = 'bg-accent border border-accent';
const MARK_OFF = 'bg-inset border border-edge-dim';

function Tick() {
  return (
    <svg
      className="w-full h-full text-on-accent"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={3}
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="m5 13 4 4 10-11" />
    </svg>
  );
}

/**
 * CheckboxMark — the checkbox's LOOK with no button of its own, for a row that
 * is itself the button (a filter menu's "pick any" rows, 2026-09-10). Nesting a
 * <Checkbox> button inside a row button is invalid HTML and gives one choice two
 * focus stops; a hand-drawn `w-3 h-3 rounded-sm border` span — which is what the
 * Resume browser's menus drew — turns into a circle on a big-radius theme and
 * reads as a radio. The row carries role="menuitemcheckbox" / aria-checked; this
 * span is decoration and says so.
 */
export function CheckboxMark({ checked, className = '' }: { checked: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex items-center justify-center w-3.5 h-3.5 shrink-0 transition-colors ${checked ? MARK_ON : MARK_OFF} ${className}`.trim()}
      // Literal 4px for the same reason as the control below: the shape is meaning.
      style={{ borderRadius: 4 }}
    >
      {checked && <Tick />}
    </span>
  );
}

export const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(
  { checked, onChange, className = '', disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      // 14px is well under the ~44dp touch guideline and this renderer is also
      // the Android UI, so coarse-hit expands the tap target on touch only.
      className={
        'inline-flex items-center justify-center w-3.5 h-3.5 shrink-0 transition-colors coarse-hit ' +
        'disabled:opacity-50 disabled:cursor-not-allowed ' +
        FOCUS_RING +
        ' ' +
        (checked ? 'bg-accent border border-accent' : 'bg-inset border border-edge-dim') +
        ' ' +
        className
      }
      // Literal 4px, deliberately NOT rounded-sm. Radii are theme tokens, and on a
      // big-radius pack (--radius-sm up to 24px) a 14px box would render as a
      // circle — i.e. indistinguishable from a Radio. The shape carries meaning
      // here, so it can't be themeable.
      style={{ borderRadius: 4 }}
      {...rest}
    >
      {checked && (
        <svg
          className="w-full h-full text-on-accent"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={3}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m5 13 4 4 10-11" />
        </svg>
      )}
    </button>
  );
});
