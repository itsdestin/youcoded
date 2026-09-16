import React from 'react';

/**
 * FilterChip — a pick-ANY filter pill: tap to add a filter, tap again to
 * remove it. Several chips in one row may be lit at once, which is what tells
 * it apart from SegmentedTabs (pick ONE of N, exactly one lit).
 *
 * Extracted 2026-08-27 (UI review P-9 #1) from the Marketplace filter bar's
 * local `Chip`. The skills drawer (CommandDrawer) drew the same control with
 * its own recipe — 12px text, tighter padding, a different border pair, and a
 * third "on" look for its Favorites toggle — so the two rows that do the same
 * job read as two different controls. One component now owns the shape; a
 * chip row anywhere in the app is this, not a new className.
 *
 * The recipe below is the Marketplace's original, verbatim, and
 * tests/filter-chip.test.tsx pins it: the extraction must not repaint the
 * marketplace. Note the asymmetry is deliberate and pre-existing — the lit
 * chip has no border (accent fill carries it), the unlit one does.
 */

export const FILTER_CHIP_BASE = 'px-3 py-1 rounded-full text-sm transition-colors';
export const FILTER_CHIP_ACTIVE = 'bg-accent text-on-accent';
export const FILTER_CHIP_INACTIVE = 'bg-inset text-fg-2 hover:text-fg border border-edge hover:border-edge-dim';

export type FilterChipProps = {
  /** Whether this filter is currently applied. */
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  /** Extra layout classes (e.g. a margin) — never a colour override. */
  className?: string;
  /** Accessible name when the visible label isn't the whole story (e.g. "★ Favorites only"). */
  'aria-label'?: string;
  title?: string;
  /**
   * `filter` (default) is a pick-any filter: role=checkbox, "checked" when lit.
   * `toggle` is a two-state button whose LABEL changes with the state — the
   * Resume browser's sort chip reads "Most recent" or "Oldest first" — where a
   * checkbox named by its current label would announce "Most recent, not
   * checked". Same paint either way; only what a screen reader hears differs.
   */
  kind?: 'filter' | 'toggle';
};

export function FilterChip({ active, onClick, children, className = '', title, kind = 'filter', 'aria-label': ariaLabel }: FilterChipProps) {
  const isToggle = kind === 'toggle';
  return (
    <button
      type="button"
      // role=checkbox + aria-checked: a filter chip is an on/off state, not a
      // pressed button — screen readers announce "checked"/"not checked".
      role={isToggle ? undefined : 'checkbox'}
      aria-checked={isToggle ? undefined : active}
      aria-pressed={isToggle ? active : undefined}
      aria-label={ariaLabel}
      title={title}
      onClick={onClick}
      className={`${FILTER_CHIP_BASE} ${active ? FILTER_CHIP_ACTIVE : FILTER_CHIP_INACTIVE} ${className}`.trim()}
    >
      {children}
    </button>
  );
}
