import React from 'react';
import { FILTER_CHIP_BASE, FILTER_CHIP_ACTIVE, FILTER_CHIP_INACTIVE } from './FilterChip';

/**
 * FilterMenuChip — a filter pill that OPENS A MENU (pick any of several)
 * instead of toggling one filter. Same recipe as FilterChip — the app's one
 * filter-pill look, design guide G-14 — plus the app's dropdown chevron: the
 * Select field's 12px stroked glyph, turned to point up while the menu is open.
 *
 * Extracted 2026-09-10 from the Resume browser's local FilterPill, which drew
 * an 11px pill (the guide's filter pills are 14px; its 12px drawer pills were
 * already rejected as the smallest text in the app) with a 9px "▾" text glyph
 * painted in fg-faint, the decorative-only token. `active` means "a filter is
 * applied through this menu" and lights the chip like any other lit
 * FilterChip, so a narrowed list reads as narrowed from the row alone.
 *
 * Click-outside and positioning stay with the caller: the menu is the caller's
 * (usually portaled), and the trigger only reports open/closed.
 */

export type FilterMenuChipProps = {
  /** Whether a filter is currently applied through this menu. */
  active: boolean;
  /** Whether the menu is open — turns the chevron and sets aria-expanded. */
  open: boolean;
  /** Receives the event so a caller owning an outside-click handler can stop
   *  propagation before that handler re-closes the menu it just opened. */
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
  /** For measuring the trigger's rect when the menu is portaled. */
  buttonRef?: React.Ref<HTMLButtonElement>;
  /** Extra layout classes (a max width, a margin) — never a colour override. */
  className?: string;
  'aria-label'?: string;
};

/** The Select field's chevron, so a chip that opens a list points the same
 *  way a field that opens a list does. Internal: the chip is its only home. */
function MenuChevron({ className = '' }: { className?: string }) {
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

export function FilterMenuChip({
  active, open, onClick, children, buttonRef, className = '', 'aria-label': ariaLabel,
}: FilterMenuChipProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={ariaLabel}
      onClick={onClick}
      // inline-flex + a truncating label: a chip whose label is a project name
      // must cut with "…" rather than push the row wider than a phone.
      className={`${FILTER_CHIP_BASE} ${active ? FILTER_CHIP_ACTIVE : FILTER_CHIP_INACTIVE} inline-flex items-center gap-1.5 max-w-full ${className}`.trim()}
    >
      <span className="truncate">{children}</span>
      {/* On a lit chip the chevron inherits on-accent; at rest it is the same
          fg-muted the Select field paints its own chevron in. */}
      <MenuChevron
        className={`w-3 h-3 shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''} ${active ? '' : 'text-fg-muted'}`.trim()}
      />
    </button>
  );
}
