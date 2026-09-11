import React from 'react';

/**
 * SearchFilterPill — the search field with its filter trigger docked INSIDE the
 * right edge. Used by both file browsers: Project View's files tabs and the
 * session Files drawer.
 *
 * Extracted 2026-07-23. The two surfaces had drifted into different controls for
 * the same job — Project View had this pill, while the drawer had a plain
 * rounded field with a bare, unfilled sliders glyph floating beside it — and
 * each file carried its OWN copy of the sliders glyph. One component now owns
 * the shape, the glyphs, and the active-filter badge.
 *
 * Click-outside is deliberately NOT handled here: FileFilterPopover's contract
 * (see its header) is that ONE ref must contain both the trigger and the
 * popover, because owning the listener inside the popover races the trigger's
 * own click and re-toggles. So the wrapper is forwarded as a ref for the parent
 * to watch, and the popover is passed as `children` so it renders inside it.
 */

function SearchGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
    </svg>
  );
}

// lucide-style sliders-horizontal — the standard "filters" glyph.
function SlidersGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="21" y1="4" x2="14" y2="4" /><line x1="10" y1="4" x2="3" y2="4" />
      <line x1="21" y1="12" x2="12" y2="12" /><line x1="8" y1="12" x2="3" y2="12" />
      <line x1="21" y1="20" x2="16" y2="20" /><line x1="12" y1="20" x2="3" y2="20" />
      <line x1="14" y1="2" x2="14" y2="6" /><line x1="8" y1="10" x2="8" y2="14" />
      <line x1="16" y1="18" x2="16" y2="22" />
    </svg>
  );
}

export type SearchFilterPillProps = {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  /** Names the input for screen readers (the placeholder alone isn't a label). */
  inputAriaLabel: string;
  /**
   * Count of filters active BEYOND the default view. Drives the accent badge, so
   * a narrowed list is never mistaken for the full one while the popover is shut.
   * Each surface decides what counts — defaults-on filters shouldn't be counted.
   */
  activeFilters?: number;
  filterOpen?: boolean;
  /**
   * Opens/closes the filter UI. OPTIONAL since P-1 #2: the marketplace's wide
   * bar reuses this pill for its search field, but its filters are the chips
   * beside it — so when this is absent the sliders trigger is not rendered at
   * all, rather than rendering a button that does nothing.
   */
  onToggleFilter?: () => void;
  /** Accessible name for the trigger. Defaults to the file browsers' wording;
   *  surfaces with no sort (the marketplace) pass their own. */
  filterLabel?: string;
  /** Sizing for the wrapper (e.g. "flex-1" or a fixed width). */
  className?: string;
  /** The filter popover — rendered inside the ref'd wrapper. */
  children?: React.ReactNode;
};

export const SearchFilterPill = React.forwardRef<HTMLDivElement, SearchFilterPillProps>(
  function SearchFilterPill(
    {
      value, onChange, placeholder, inputAriaLabel,
      activeFilters = 0, filterOpen = false, onToggleFilter,
      filterLabel: idleLabel = 'Filter and sort', className = '', children,
    },
    ref,
  ) {
    const filterLabel = activeFilters > 0 ? `Filters (${activeFilters} active)` : idleLabel;
    // Without a trigger the input is the last child, so the right inset matches
    // the left one instead of the 4px the docked button needs.
    const hasTrigger = !!onToggleFilter;
    return (
      <div ref={ref} className={`relative ${className}`.trim()}>
        {/* Fix: focus used to render `border-edge-dim` — LESS contrast than the
            resting `border-edge`, i.e. an invisible focus state. `border-accent`
            is the design system's focus token (see InputGroup.tsx / field.ts). */}
        <div className={`flex items-center gap-2 bg-inset border border-edge rounded-full pl-3 ${hasTrigger ? 'pr-1' : 'pr-3'} py-1 w-full focus-within:border-accent`}>
          <span className="text-fg-muted shrink-0"><SearchGlyph /></span>
          <input
            type="text"
            placeholder={placeholder}
            aria-label={inputAriaLabel}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="bg-transparent outline-none text-sm-tight text-fg w-full min-w-0 placeholder:text-fg-muted"
          />
          {hasTrigger && <button
            type="button"
            className={`shrink-0 relative w-7 h-7 rounded-full inline-flex items-center justify-center transition-colors ${
              filterOpen || activeFilters > 0
                ? 'text-fg bg-well'
                : 'text-fg-muted hover:text-fg hover:bg-well'
            }`}
            onClick={onToggleFilter}
            aria-expanded={filterOpen}
            aria-label={filterLabel}
          >
            <SlidersGlyph />
            {activeFilters > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-0.5 rounded-full bg-accent text-on-accent text-[9.5px] font-medium leading-[15px] text-center">
                {activeFilters}
              </span>
            )}
          </button>}
        </div>
        {children}
      </div>
    );
  },
);
