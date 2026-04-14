// Sticky chip bar — type, vibe, meta, search. Chips are multi-select;
// active chips switch the screen from discovery mode (hero + rails) to
// search mode (filtered grid only).

import React from "react";

export type TypeChip = "skill" | "theme";
export type MetaChip = "new" | "popular" | "picks";

// Kept in sync with destincode-marketplace/scripts/schema.js ALLOWED_LIFE_AREAS.
// If this list drifts, chips will still render but won't filter — the intersection
// is server-truth via the `lifeArea` entry field.
const VIBES = ["school", "work", "creative", "health", "personal", "finance", "home"] as const;
export type VibeChip = typeof VIBES[number];

export interface FilterState {
  types: Set<TypeChip>;
  vibes: Set<VibeChip>;
  meta: Set<MetaChip>;
  query: string;
}

export function emptyFilter(): FilterState {
  return { types: new Set(), vibes: new Set(), meta: new Set(), query: "" };
}

export function isActive(f: FilterState): boolean {
  return f.types.size > 0 || f.vibes.size > 0 || f.meta.size > 0 || f.query.trim().length > 0;
}

interface Props {
  value: FilterState;
  onChange(next: FilterState): void;
}

export default function MarketplaceFilterBar({ value, onChange }: Props) {
  const toggle = <K extends keyof FilterState>(key: K, v: any) => {
    const next = { ...value, types: new Set(value.types), vibes: new Set(value.vibes), meta: new Set(value.meta) };
    const set = next[key] as Set<any>;
    if (set.has(v)) set.delete(v); else set.add(v);
    onChange(next);
  };

  return (
    <div className="layer-surface sticky top-0 z-20 flex flex-wrap items-center gap-2 p-3">
      <ChipGroup label="Type">
        <Chip active={value.types.has("skill")} onClick={() => toggle("types", "skill")}>Skills</Chip>
        <Chip active={value.types.has("theme")} onClick={() => toggle("types", "theme")}>Themes</Chip>
      </ChipGroup>
      <Divider />
      <ChipGroup label="Vibe">
        {VIBES.map((v) => (
          <Chip key={v} active={value.vibes.has(v)} onClick={() => toggle("vibes", v)}>
            {v[0].toUpperCase() + v.slice(1)}
          </Chip>
        ))}
      </ChipGroup>
      <Divider />
      <ChipGroup label="Meta">
        <Chip active={value.meta.has("new")} onClick={() => toggle("meta", "new")}>New</Chip>
        <Chip active={value.meta.has("popular")} onClick={() => toggle("meta", "popular")}>Popular</Chip>
        <Chip active={value.meta.has("picks")} onClick={() => toggle("meta", "picks")}>Destin's picks</Chip>
      </ChipGroup>
      <div className="ml-auto">
        <input
          type="search"
          placeholder="Search…"
          value={value.query}
          onChange={(e) => onChange({ ...value, query: e.target.value })}
          className="bg-inset border border-edge rounded-md px-3 py-1.5 text-sm text-fg placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent w-48"
        />
      </div>
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
