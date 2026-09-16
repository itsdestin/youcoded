// src/renderer/components/ResumeFilterPopover.tsx
//
// Phone-width home for the Resume browser's filters. At desktop width the three
// chips (Projects ▾ · Tags ▾ · Most recent) sit under the search box; below 640px
// they did not fit, and Destin asked (deck round 1, S-7) for "the expandable
// filter menu button thing used in the project view and session file view" —
// the sliders button docked in SearchFilterPill, opening this popover.
//
// What sits inside is the SAME three chips as the desktop row, wrapped onto as
// many lines as they need: round 2 drew chip rows for Project and Tags and a
// two-way switch for the order, and that came back as "most recent/oldest first
// should not be a switch like that, it's weird. project/tags should be
// dropdowns" (S-9). So the popover is a shell — header, Clear, ESC — and the
// parent hands it the row it already renders on desktop; the Projects and Tags
// menus open from those chips exactly as they do at full width.
//
// Same shell as FileFilterPopover (a .layer-surface popover, ESC via the shared
// stack, click-outside owned by the parent). Portaled and fixed-positioned by
// the parent (it passes `anchor`) for the same reason the menus are: the Resume
// panel clips its overflow, and with one row left it is shorter than this.
import React from 'react';
import { useEscClose } from '../hooks/use-esc-close';

export const ResumeFilterPopover = React.forwardRef<HTMLDivElement, {
  anchor: { top: number; right: number };
  /** Whether Clear has anything to clear (the order is a preference, not a filter). */
  filtersActive: boolean;
  onClear(): void;
  onClose(): void;
  /** The chips row the desktop layout renders under the search box. */
  children: React.ReactNode;
}>(function ResumeFilterPopover({ anchor, filtersActive, onClear, onClose, children }, ref) {
  useEscClose(true, onClose);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Filters"
      className="layer-surface w-[min(320px,calc(100vw-1rem))] p-3 flex flex-col gap-3"
      style={{ position: 'fixed', top: anchor.top, right: anchor.right, zIndex: 60 }}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-fg">Filters</span>
        {filtersActive && (
          <button
            type="button"
            className="text-xs text-fg-2 hover:text-fg transition-colors"
            onClick={onClear}
          >
            Clear
          </button>
        )}
      </div>
      {children}
    </div>
  );
});
