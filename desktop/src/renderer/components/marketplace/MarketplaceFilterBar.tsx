// Sticky chip bar — type, vibe, meta, search.
//
// At ≥ 640px: chips render inline (current behavior).
// At < 640px: only the search input + a "Filters" button render in the sticky
//   bar; tapping the button opens a bottom-anchored FilterSheet that hosts the
//   same chip groups stacked vertically. State shape and toggle logic are
//   unchanged — the sheet is just a different layout container.
//
// Active count for the Filters button: (type ? 1 : 0) + vibes.size + meta.size.
// The query is excluded since it's already visible in the search input.

import React, { useState } from "react";
import { Scrim, OverlayPanel } from "../overlays/Overlay";
import { useEscClose } from "../../hooks/use-esc-close";
import { useNarrowViewport } from "../../hooks/use-narrow-viewport";

export type TypeChip = "skill" | "theme";
export type MetaChip = "new" | "popular" | "picks";

const VIBES = ["school", "work", "creative", "health", "personal", "finance", "home"] as const;
export type VibeChip = typeof VIBES[number];

export interface FilterState {
  type: TypeChip | null;
  vibes: Set<VibeChip>;
  meta: Set<MetaChip>;
  query: string;
}

export function emptyFilter(): FilterState {
  return { type: null, vibes: new Set(), meta: new Set(), query: "" };
}

export function isActive(f: FilterState): boolean {
  return f.type !== null || f.vibes.size > 0 || f.meta.size > 0 || f.query.trim().length > 0;
}

function activeFilterCount(f: FilterState): number {
  return (f.type !== null ? 1 : 0) + f.vibes.size + f.meta.size;
}

interface Props {
  value: FilterState;
  onChange(next: FilterState): void;
}

export default function MarketplaceFilterBar({ value, onChange }: Props) {
  const compact = useNarrowViewport();
  const [sheetOpen, setSheetOpen] = useState(false);

  const toggleMulti = (key: "vibes" | "meta", v: any) => {
    const next = { ...value, vibes: new Set(value.vibes), meta: new Set(value.meta) };
    const set = next[key] as Set<any>;
    if (set.has(v)) set.delete(v); else set.add(v);
    onChange(next);
  };
  const setType = (t: TypeChip) => {
    onChange({ ...value, type: value.type === t ? null : t });
  };

  if (compact) {
    const count = activeFilterCount(value);
    return (
      <>
        {/* Single rounded pill: leading magnifier icon, borderless input, trailing
            filter button — same in-row pattern as InputBar's send button. The
            outer wrapper carries the border + focus ring; the input itself is
            transparent so focus styling reads as one element. */}
        <div className="layer-surface sticky top-0 z-20 p-2">
          <div className="flex items-center bg-inset border border-edge rounded-md focus-within:ring-2 focus-within:ring-accent">
            <span className="pl-2.5 pr-1 text-fg-muted shrink-0" aria-hidden>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </span>
            <input
              type="search"
              placeholder="Search…"
              value={value.query}
              onChange={(e) => onChange({ ...value, query: e.target.value })}
              className="flex-1 min-w-0 bg-transparent border-0 outline-none px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted"
            />
            <button
              type="button"
              onClick={() => setSheetOpen(true)}
              className="shrink-0 relative p-2 mr-1 rounded-md text-fg-2 hover:text-fg hover:bg-edge-dim"
              aria-label={count > 0 ? `Filters (${count} active)` : 'Filters'}
              title={count > 0 ? `Filters (${count} active)` : 'Filters'}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <line x1="4" y1="6" x2="20" y2="6" />
                <line x1="6" y1="12" x2="18" y2="12" />
                <line x1="9" y1="18" x2="15" y2="18" />
              </svg>
              {count > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-accent text-on-accent text-[10px] font-medium leading-[16px] text-center">
                  {count}
                </span>
              )}
            </button>
          </div>
        </div>
        {sheetOpen && (
          <FilterSheet
            value={value}
            onChange={onChange}
            onClose={() => setSheetOpen(false)}
            toggleMulti={toggleMulti}
            setType={setType}
          />
        )}
      </>
    );
  }

  // Wide layout — unchanged from before the mobile redesign.
  return (
    <div className="layer-surface sticky top-0 z-20 flex flex-wrap items-center gap-2 p-3">
      <ChipGroup label="Type">
        <Chip active={value.type === "skill"} onClick={() => setType("skill")}>Plugins</Chip>
        <Chip active={value.type === "theme"} onClick={() => setType("theme")}>Themes</Chip>
      </ChipGroup>
      <Divider />
      <ChipGroup label="Vibe">
        {VIBES.map((v) => (
          <Chip key={v} active={value.vibes.has(v)} onClick={() => toggleMulti("vibes", v)}>
            {v[0].toUpperCase() + v.slice(1)}
          </Chip>
        ))}
      </ChipGroup>
      <Divider />
      <ChipGroup label="Meta">
        <Chip active={value.meta.has("new")} onClick={() => toggleMulti("meta", "new")}>New</Chip>
        <Chip active={value.meta.has("popular")} onClick={() => toggleMulti("meta", "popular")}>Popular</Chip>
        <Chip active={value.meta.has("picks")} onClick={() => toggleMulti("meta", "picks")}>Destin's picks</Chip>
      </ChipGroup>
      <div className="w-full sm:w-auto sm:ml-auto">
        <input
          type="search"
          placeholder="Search…"
          value={value.query}
          onChange={(e) => onChange({ ...value, query: e.target.value })}
          className="bg-inset border border-edge rounded-md px-3 py-1.5 text-sm text-fg placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent w-full sm:w-48"
        />
      </div>
    </div>
  );
}

// Bottom-anchored sheet hosting the same chip groups stacked vertically. Built
// on the existing Scrim + OverlayPanel primitives so theme tokens (scrim color,
// blur, shadow, z-index) drive the look. Chip toggles update FilterState live —
// "Apply" is just a close affordance.
function FilterSheet({
  value, onChange, onClose, toggleMulti, setType,
}: {
  value: FilterState;
  onChange(next: FilterState): void;
  onClose(): void;
  toggleMulti(key: 'vibes' | 'meta', v: any): void;
  setType(t: TypeChip): void;
}) {
  // FilterSheet pushes onto the EscClose LIFO stack — closes top-down ahead of
  // MarketplaceScreen's own ESC handler without a gate change in the screen.
  useEscClose(true, onClose);

  const clearAll = () => {
    // Preserve the search query (it's still visible in the sticky bar) but
    // reset all chip selections.
    onChange({ ...emptyFilter(), query: value.query });
  };

  return (
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        role="dialog"
        aria-modal
        aria-labelledby="marketplace-filter-sheet-title"
        className="fixed inset-x-2 max-h-[80vh] overflow-y-auto rounded-2xl flex flex-col"
        style={{ bottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
      >
        <header className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 border-b border-edge-dim bg-panel">
          <h2 id="marketplace-filter-sheet-title" className="text-base font-semibold text-fg">Filters</h2>
          <button
            type="button"
            onClick={clearAll}
            className="text-sm text-fg-2 hover:text-fg"
          >
            Clear all
          </button>
        </header>
        <div className="flex-1 flex flex-col gap-4 p-4">
          <SheetGroup label="Type">
            <Chip active={value.type === "skill"} onClick={() => setType("skill")}>Plugins</Chip>
            <Chip active={value.type === "theme"} onClick={() => setType("theme")}>Themes</Chip>
          </SheetGroup>
          <SheetGroup label="Vibe">
            {VIBES.map((v) => (
              <Chip key={v} active={value.vibes.has(v)} onClick={() => toggleMulti("vibes", v)}>
                {v[0].toUpperCase() + v.slice(1)}
              </Chip>
            ))}
          </SheetGroup>
          <SheetGroup label="Meta">
            <Chip active={value.meta.has("new")} onClick={() => toggleMulti("meta", "new")}>New</Chip>
            <Chip active={value.meta.has("popular")} onClick={() => toggleMulti("meta", "popular")}>Popular</Chip>
            <Chip active={value.meta.has("picks")} onClick={() => toggleMulti("meta", "picks")}>Destin's picks</Chip>
          </SheetGroup>
        </div>
        <footer className="sticky bottom-0 z-10 px-4 py-3 border-t border-edge-dim bg-panel">
          <button
            type="button"
            onClick={onClose}
            className="w-full px-4 py-2 rounded-md bg-accent text-on-accent font-medium hover:opacity-90"
          >
            Apply
          </button>
        </footer>
      </OverlayPanel>
    </>
  );
}

function SheetGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs uppercase tracking-wide text-fg-dim">{label}</h3>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={active}
      onClick={onClick}
      className={`px-3 py-1 rounded-full text-sm transition-colors ${
        active
          ? "bg-accent text-on-accent"
          : "bg-inset text-fg-2 hover:text-fg border border-edge hover:border-edge-dim"
      }`}
    >
      {children}
    </button>
  );
}

function ChipGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5" aria-label={label}>
      {children}
    </div>
  );
}

function Divider() {
  return <span className="w-px h-5 bg-edge-dim mx-1" aria-hidden />;
}
