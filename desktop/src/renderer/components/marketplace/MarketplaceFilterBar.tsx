// Sticky filter bar — type switch, vibe + view dropdowns, search.
//
// At ≥ 640px: ONE row — the Type switch, two dropdowns, search on the right.
// At < 640px: only the search pill (with its docked filters trigger) renders in
//   the sticky bar; tapping the trigger opens a bottom-anchored FilterSheet that
//   hosts the same controls stacked vertically.
//
// P-1 (2026-08-26): Plugins/Themes is "pick one" so it is a SegmentedTabs row
// (with an explicit All); the search field is the app's shared SearchFilterPill.
//
// Overhaul round 2 (Destin, 2026-08-28): "keep the full container to a single
// row; collapse the other filter toggles into dropdowns". The seven vibe chips
// became a Vibe dropdown (pick one) and the New / Popular / Featured picks chips
// became a Show dropdown (pick one) — the chips wrapped to a second line once the
// type switch grew to seven segments.
//
// Active count for the Filters button: (type ? 1 : 0) + (vibe ? 1 : 0) + (view ≠ all ? 1 : 0).
// The query is excluded since it's already visible in the search input.

import React, { useState } from "react";
import { Scrim, OverlayPanel } from "../overlays/Overlay";
import { Button, SearchFilterPill, SectionLabel, SegmentedTabs, SegmentedTabLabel, PaletteIcon, Select } from "../ui";
import { CATALOG_ITEM_TYPES, CATALOG_TYPE_LABEL, catalogType, type CatalogItemType } from "../../../shared/catalog-types";
import { typeIcon } from "./type-icons";
import { useMarketplace } from "../../state/marketplace-context";
import { useEscClose } from "../../hooks/use-esc-close";
import { useNarrowViewport } from "../../hooks/use-narrow-viewport";

// Marketplace overhaul (2026-08-27, decision #1): the type switch names the
// five installable kinds plus themes. "skill" used to mean "any plugin"; it
// now means an actual skill, and "plugin" is the bundle.
export type TypeChip = CatalogItemType | "theme";

const VIBES = ["school", "work", "creative", "health", "personal", "finance", "home"] as const;
export type VibeChip = typeof VIBES[number];

/** What the grid shows: everything, the curated picks, newest first, or most
 *  installed first. Pick-one — it replaced three toggle chips. */
export type ViewChip = "all" | "picks" | "new" | "popular";

const VIBE_OPTIONS = [
  { value: "", label: "Any vibe" },
  ...VIBES.map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })),
];

const VIEW_OPTIONS: Array<{ value: ViewChip; label: string }> = [
  { value: "all", label: "Everything" },
  { value: "picks", label: "Featured picks" },
  { value: "new", label: "Newest first" },
  { value: "popular", label: "Most installed" },
];

export interface FilterState {
  type: TypeChip | null;
  vibe: VibeChip | null;
  view: ViewChip;
  query: string;
}

export function emptyFilter(): FilterState {
  return { type: null, vibe: null, view: "all", query: "" };
}

export function isActive(f: FilterState): boolean {
  return f.type !== null || f.vibe !== null || f.view !== "all" || f.query.trim().length > 0;
}

function activeFilterCount(f: FilterState): number {
  return (f.type !== null ? 1 : 0) + (f.vibe !== null ? 1 : 0) + (f.view !== "all" ? 1 : 0);
}

// The Type switch always shows a selection (a tab row can't be "nothing lit"
// the way the old chips were), so "All" stands in for "no type filter".
// Round 2 (Destin, 2026-08-27): the switch is the SAME pill as the Library's Plugins |
// Themes switcher — icon + label + count, variant="pill" — so the two surfaces read as one
// control. Counts are registry sizes (what you can browse), the Library's are installed.
// Overhaul: one segment per kind — Plugins · Skills · Specialists · Connections ·
// Prompts · Themes — each counting every row of that kind, INCLUDING the
// ones that live inside a bundle (that is what picking a type is for:
// "grouped when browsing, split when looking for something specific").
// "All" counts only what the grouped grid shows (bundles + standalone items
// + themes), so the two numbers say what you will actually see.
function useTypeTabs(active: string) {
  const mp = useMarketplace();
  const counts: Record<CatalogItemType, number> = { plugin: 0, skill: 0, specialist: 0, tool: 0, prompt: 0 };
  let grouped = 0;
  for (const s of mp.skillEntries) {
    counts[catalogType(s.catalog)] += 1;
    if (!s.catalog?.partOf) grouped += 1;
  }
  const themes = mp.themeEntries.length;
  return [
    { id: "all", label: <SegmentedTabLabel icon={null} text="All" count={grouped + themes} active={active === "all"} /> },
    ...CATALOG_ITEM_TYPES.map((t) => ({
      id: t,
      label: <SegmentedTabLabel icon={typeIcon(t)} text={CATALOG_TYPE_LABEL[t].many} count={counts[t]} active={active === t} />,
    })),
    { id: "theme", label: <SegmentedTabLabel icon={<PaletteIcon />} text="Themes" count={themes} active={active === "theme"} /> },
  ];
}

interface Props {
  value: FilterState;
  onChange(next: FilterState): void;
}

export default function MarketplaceFilterBar({ value, onChange }: Props) {
  const compact = useNarrowViewport();
  const [sheetOpen, setSheetOpen] = useState(false);
  const typeTabs = useTypeTabs(value.type ?? "all");

  // Maps a Type tab id back onto FilterState.type. "all" → null keeps
  // isActive() / activeFilterCount() exactly as they were: no type filter.
  const setTypeTab = (id: string) => {
    onChange({ ...value, type: id === "all" ? null : (id as TypeChip) });
  };
  const setVibe = (v: string) => onChange({ ...value, vibe: (v || null) as VibeChip | null });
  const setView = (v: string) => onChange({ ...value, view: v as ViewChip });

  if (compact) {
    const count = activeFilterCount(value);
    return (
      <>
        {/* P-1 #2: the shared SearchFilterPill (same shape as the file browsers
            and the wide bar below) — magnifier, rounded pill, and the sliders
            trigger docked inside with its active-count badge. */}
        <div className="layer-surface sticky top-0 z-20 p-2">
          <SearchFilterPill
            value={value.query}
            onChange={(q) => onChange({ ...value, query: q })}
            placeholder="Search…"
            inputAriaLabel="Search the marketplace"
            activeFilters={count}
            filterOpen={sheetOpen}
            onToggleFilter={() => setSheetOpen(true)}
            filterLabel="Filters"
          />
        </div>
        {sheetOpen && (
          <FilterSheet
            value={value}
            onChange={onChange}
            onClose={() => setSheetOpen(false)}
            setTypeTab={setTypeTab}
            setVibe={setVibe}
            setView={setView}
          />
        )}
      </>
    );
  }

  // Wide layout — one row, never wraps (round 2). The search shrinks before
  // anything else does.
  return (
    <div className="layer-surface sticky top-0 z-20 flex flex-nowrap items-center gap-2 p-3">
      {/* P-1 #1: pick-one Type switch, visually distinct from the pick-one
          dropdowns that follow. */}
      {/* shrink-0 on the switch and fixed-width boxes around the dropdowns:
          the dropdown draws itself full-width, so without a box it took the
          whole row and squeezed the switch to nothing (round 2 first cut). */}
      <div className="shrink-0">
        <SegmentedTabs
          variant="pill"
          tabs={typeTabs}
          value={value.type ?? "all"}
          onChange={setTypeTab}
          aria-label="Type"
        />
      </div>
      <Divider />
      <div className="w-32 shrink-0"><Select size="sm" aria-label="Vibe" options={VIBE_OPTIONS} value={value.vibe ?? ""} onChange={setVibe} /></div>
      <div className="w-40 shrink-0"><Select size="sm" aria-label="Show" options={VIEW_OPTIONS} value={value.view} onChange={setView} /></div>
      <div className="ml-auto min-w-[9rem] w-56 shrink">
        {/* P-1 #2: the same SearchFilterPill as the narrow bar, minus the
            sliders trigger — the dropdowns beside it ARE the filters. */}
        <SearchFilterPill
          value={value.query}
          onChange={(q) => onChange({ ...value, query: q })}
          placeholder="Search…"
          inputAriaLabel="Search the marketplace"
          className="w-full"
        />
      </div>
    </div>
  );
}

// Bottom-anchored sheet hosting the same controls stacked vertically. Built
// on the existing Scrim + OverlayPanel primitives so theme tokens (scrim color,
// blur, shadow, z-index) drive the look. Changes apply live — "Apply" is just
// a close affordance.
function FilterSheet({
  value, onChange, onClose, setTypeTab, setVibe, setView,
}: {
  value: FilterState;
  onChange(next: FilterState): void;
  onClose(): void;
  setTypeTab(id: string): void;
  setVibe(v: string): void;
  setView(v: string): void;
}) {
  // FilterSheet pushes onto the EscClose LIFO stack — closes top-down ahead of
  // MarketplaceScreen's own ESC handler without a gate change in the screen.
  useEscClose(true, onClose);
  const typeTabs = useTypeTabs(value.type ?? "all");

  const clearAll = () => {
    // Preserve the search query (it's still visible in the sticky bar) but
    // reset every other choice.
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
            {/* P-1 #1: same pick-one switch as the wide bar. Seven segments do
                not fit a phone — the row scrolls sideways INSIDE the sheet's
                padding (round 1 bled past the edge, which read as a bug). */}
            <div className="w-full overflow-x-auto">
              <SegmentedTabs
                variant="pill"
                tabs={typeTabs}
                value={value.type ?? "all"}
                onChange={setTypeTab}
                aria-label="Type"
              />
            </div>
          </SheetGroup>
          <SheetGroup label="Vibe">
            <Select size="md" aria-label="Vibe" options={VIBE_OPTIONS} value={value.vibe ?? ""} onChange={setVibe} />
          </SheetGroup>
          <SheetGroup label="Show">
            <Select size="md" aria-label="Show" options={VIEW_OPTIONS} value={value.view} onChange={setView} />
          </SheetGroup>
        </div>
        <footer className="sticky bottom-0 z-10 px-4 py-3 border-t border-edge-dim bg-panel">
          <Button
            size="lg"
            type="button"
            onClick={onClose}
            className="w-full"
          >
            Apply
          </Button>
        </footer>
      </OverlayPanel>
    </>
  );
}

// WHY SectionLabel, not the old spaced-caps eyebrow (labels batch, guide: no
// spaced capitals — decisions H-3/L-1…L-4).
function SheetGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>{label}</SectionLabel>
      <div className="flex flex-wrap gap-2 [&>*]:w-full [&>*]:min-w-0">{children}</div>
    </div>
  );
}

function Divider() {
  return <span className="w-px h-5 bg-edge-dim mx-1 shrink-0" aria-hidden />;
}
