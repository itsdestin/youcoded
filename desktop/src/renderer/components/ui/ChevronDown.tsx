import React from 'react';

/**
 * ChevronDown — the app's one "this opens a list" glyph. It was drawn inline
 * three times (Select, the find bar, FilterMenuChip) before the 2026-09-10
 * code review counted them; a caller sizes and colours it with `className`.
 */
export function ChevronDown({ className = 'w-3 h-3 shrink-0' }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
    </svg>
  );
}
