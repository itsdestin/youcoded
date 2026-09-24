import React from 'react';

/**
 * ChevronDown — the app's one "this opens a list" glyph. It was drawn inline
 * three times (Select, the find bar, FilterMenuChip) before the 2026-09-10
 * code review counted them; a caller sizes and colours it with `className`.
 *
 * `expanded` (T4, project-plugin-controls review F2): a disclosure caller
 * used to spin the glyph itself by passing `transition-transform` plus a
 * conditional `-rotate-90` through `className` — that reads as restyling a
 * primitive's own motion and trips `shadcn/no-restyle` at every call site
 * (`no-restyle` is off inside `components/ui/**`, so the same classes cost
 * nothing written HERE). Pass `expanded` instead: `false` points the glyph
 * left (closed), `true` leaves it pointing down (open), matching every
 * existing disclosure's rotation direction.
 */
export function ChevronDown({
  className = 'w-3 h-3 shrink-0', strokeWidth = 2, expanded,
}: { className?: string; strokeWidth?: number; expanded?: boolean }) {
  const rotate = expanded === undefined ? '' : ` transition-transform ${expanded ? '' : '-rotate-90'}`;
  return (
    <svg
      className={`${className}${rotate}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
    </svg>
  );
}
