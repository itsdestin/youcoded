import React from 'react';
import { CheckboxMark } from './Checkbox';
import { FOCUS_RING } from './Button';

/**
 * The "I understand" line before a risky action — the WHOLE line is one
 * tappable box, the tick box sits on its LEFT, and the box lights up (accent
 * border and tint) once ticked. The action it guards stays disabled until then;
 * that part is the caller's (`disabled={!checked}` on its button).
 *
 * WHY (decisions.md "Consent tick box", `ui-element-review-settings-pieces#P-6`;
 * design guide "Settings" → "I understand" before a risky action): the Skip
 * Permissions popup had a bare 14px square beside a sentence — only the tiny
 * square was the target, and Destin said the "vibe is off" (fix batch 1,
 * B1-2). Here the row IS the checkbox (role="checkbox"), and the square inside
 * is `CheckboxMark` — the checkbox's look with no button of its own — so there
 * is one focus stop and no button nested in a button.
 *
 * `bg-accent/15`, not the callout's `/10`: this is a control's selected state,
 * not a notice, and it must read as distinct from an info callout beside it.
 */
export type ConsentRowProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: React.ReactNode;
  disabled?: boolean;
  className?: string;
};

export function ConsentRow({ checked, onChange, children, disabled, className = '' }: ConsentRowProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={[
        'w-full flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left text-xs text-fg transition-colors',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        FOCUS_RING,
        // WHY `surface-1` + the card outline when unticked (final-review#PR-7/#ST-12, one rule for
        // popup tick boxes): the box is a first-level card on the popup and, inside a popup's body
        // card, takes the nested look automatically (globals.css "Surface levels") — so every tick
        // box reads as a box at whatever depth it sits. Ticked keeps its accent tint, which the
        // surface-level rule would otherwise paint over, so `surface-1` goes only on the unticked.
        checked ? 'border-accent bg-accent/15' : 'surface-1 border-edge-card bg-inset/50 hover:bg-inset',
        className,
      ].filter(Boolean).join(' ')}
    >
      {/* mt-px lines the 14px square up with the first line of 12px text. */}
      <CheckboxMark checked={checked} className="mt-px" />
      <span className="min-w-0 flex-1 leading-relaxed">{children}</span>
    </button>
  );
}
