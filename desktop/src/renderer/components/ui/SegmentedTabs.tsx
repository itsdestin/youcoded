import React from 'react';
import { FOCUS_RING } from './Button';

/**
 * Tab rows (change 45, §1.8).
 *
 * One active-state recipe. Today Library tabs and BugReportPopup's Bug/Feature
 * share the active style but disagree on inactive (Library tints it bg-inset,
 * BugReport leaves it bare).
 *
 * DECIDED 2026-07-16: inactive is option B — transparent, hover reveals the
 * tint. Option A (always-tinted inactive) was rendered and not taken.
 *
 * Filters are NOT tabs — marketplace filter Chips stay chips (design rule 8).
 */

export type SegmentedTab = {
  id: string;
  label: React.ReactNode;
};

export type SegmentedTabsProps = {
  tabs: readonly SegmentedTab[];
  value: string;
  onChange: (id: string) => void;
  /** bare = a plain row. contained = tabs share an inset trough and split the
   *  width evenly (BugReportPopup). pill = one rounded-full layer-surface pill
   *  holding rounded-full segments — the Projects header switcher, adopted by
   *  the Library (UI review P-2 #2) so the two top-level browsing screens share
   *  one switcher shape. */
  variant?: 'bare' | 'contained' | 'pill';
  'aria-label'?: string;
  className?: string;
};

const TAB_BASE = `px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${FOCUS_RING}`;
const TAB_ACTIVE = 'bg-accent text-on-accent';
const TAB_INACTIVE = 'text-fg-2 hover:bg-inset';

// Pill recipe — copied verbatim from ProjectView's segmented control (the
// wide/desktop branch) so a Library segment and a Projects segment render
// pixel-identical. Kept as separate constants rather than folded into TAB_*
// so the bare/contained variants stay byte-for-byte what they were.
// w-fit: the pill hugs its segments like the Projects header does — as a plain `flex`
// in a block parent it stretched across the whole Library page (seen in the Phase C
// after-sweep, 2026-08-27).
// Compact (Destin, 2026-08-27, review 2): segments are px-3 py-1 text-sm — the same box as
// the marketplace filter chips — so the switch and the chips beside it read as one size.
const PILL_CONTAINER = 'w-fit flex items-center gap-0.5 p-0.5 layer-surface !rounded-full';
const PILL_TAB_BASE = `shrink-0 px-3 py-1 rounded-full text-sm font-medium inline-flex items-center justify-center gap-1.5 transition-colors ${FOCUS_RING}`;
const PILL_TAB_INACTIVE = 'text-fg-2 hover:text-fg hover:bg-inset';

export function SegmentedTabs({
  tabs,
  value,
  onChange,
  variant = 'bare',
  className = '',
  'aria-label': ariaLabel,
}: SegmentedTabsProps) {
  const onKeyDown = (e: React.KeyboardEvent) => {
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0) return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.id === value);
    if (i === -1) return;
    onChange(tabs[(i + delta + tabs.length) % tabs.length].id);
  };

  const pill = variant === 'pill';

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={[
        pill
          ? PILL_CONTAINER
          : variant === 'contained'
            ? 'flex gap-1 p-1 bg-inset/50 rounded-lg'
            : 'flex gap-2',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      // layer-surface carries the big panel drop shadow; a control sitting in
      // a header should not cast one. Same override ProjectView uses.
      style={pill ? { boxShadow: 'none' } : undefined}
    >
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            // Roving tabindex: the row is one tab stop, arrows move within it.
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={[
              // Contained tabs split the width evenly (flex-1), so side padding only sets
              // the MINIMUM width — cutting it to px-1 lets five short words fit a 420px
              // popup (Appearance's bubble/message-box strips, 2026-09-24) and changes
              // nothing visible on the two-tab strips, whose text is centred anyway.
              pill ? PILL_TAB_BASE : variant === 'contained' ? TAB_BASE.replace('px-3', 'px-1 min-w-0') : TAB_BASE,
              active ? TAB_ACTIVE : pill ? PILL_TAB_INACTIVE : TAB_INACTIVE,
              variant === 'contained' ? 'flex-1' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

// Shared by the Library's Plugins | Themes switcher and the Marketplace's All | Plugins |
// Themes switch (Destin, 2026-08-27: 'make this match the skills/themes toggle surface').
// Segment contents for the pill switcher: icon + label + count. Count styling
// mirrors ProjectView's segments — subdued on the active (accent) segment,
// muted on inactive ones — so the two screens read as one control.
export function SegmentedTabLabel({ icon, text, count, active }: { icon: React.ReactNode; text: string; count: number; active: boolean }) {
  return (
    <>
      <span className="shrink-0 inline-flex" aria-hidden>{icon}</span>
      <span>{text}</span>
      <span className={`text-2xs shrink-0 ${active ? 'opacity-80' : 'text-fg-muted'}`}>{count}</span>
    </>
  );
}

// Inline icons sized to match ProjectView's segment icons (16px, 2px stroke).
export function PluginIcon() {
  // Four-point sparkle — the app's plugin/skill mark.
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z" />
    </svg>
  );
}

export function PaletteIcon() {
  // Painter's palette with four paint wells.
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a9 9 0 1 0 0 18h1.5a2 2 0 0 0 1.4-3.4 2 2 0 0 1 1.4-3.4H19a2.5 2.5 0 0 0 2.5-2.5A9 9 0 0 0 12 3z" />
      <circle cx="7.5" cy="12" r="1" />
      <circle cx="10" cy="7.5" r="1" />
      <circle cx="15" cy="7.5" r="1" />
      <circle cx="17.5" cy="11.5" r="1" />
    </svg>
  );
}
