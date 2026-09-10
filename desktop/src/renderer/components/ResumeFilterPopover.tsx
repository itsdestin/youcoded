// src/renderer/components/ResumeFilterPopover.tsx
//
// Phone-width home for the Resume browser's filters. At desktop width the three
// chips (Projects · Tags · Most recent) sit under the search box; below 640px
// they did not fit and had to scroll sideways, and Destin asked (deck round 1,
// S-7) for "the expandable filter menu button thing used in the project view
// and session file view" instead — the sliders button docked in SearchFilterPill,
// opening this popover. Same shell as FileFilterPopover (a .layer-surface
// popover, ESC via the shared stack, click-outside owned by the parent); the
// controls are the app's own — FilterChip for the pick-any groups, SegmentedTabs
// for the one-of-two order — rather than that file's local 12px chip.
//
// Portaled and fixed-positioned by the parent (it passes `anchor`) for the same
// reason the desktop menus are: the Resume panel clips its overflow, and with
// one row left the panel is shorter than this popover.
import React from 'react';
import { useEscClose } from '../hooks/use-esc-close';
import { FilterChip, SegmentedTabs } from './ui';
import type { TagRecord } from '../../shared/tags';

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-2xs font-medium text-fg-muted tracking-wide uppercase">{label}</span>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>{children}</div>
    </div>
  );
}

const ORDER_TABS = [
  { id: 'desc', label: 'Most recent' },
  { id: 'asc', label: 'Oldest first' },
];

export const ResumeFilterPopover = React.forwardRef<HTMLDivElement, {
  anchor: { top: number; right: number };
  projects: Array<{ path: string; label: string; count: number }>;
  selectedProjects: ReadonlySet<string>;
  onProjects(next: Set<string>): void;
  tags: Array<Pick<TagRecord, 'id' | 'label' | 'color'>>;
  tagCounts: ReadonlyMap<string, number>;
  selectedTagIds: ReadonlySet<string>;
  onTags(next: Set<string>): void;
  sortDir: 'asc' | 'desc';
  onSortDir(next: 'asc' | 'desc'): void;
  onClose(): void;
}>(function ResumeFilterPopover(
  { anchor, projects, selectedProjects, onProjects, tags, tagCounts, selectedTagIds, onTags, sortDir, onSortDir, onClose },
  ref,
) {
  useEscClose(true, onClose);
  // Order is a preference, not a filter, so Clear leaves it alone — the same
  // call FileFilterPopover makes for its sort.
  const filtersActive = selectedProjects.size > 0 || selectedTagIds.size > 0;
  const toggled = (set: ReadonlySet<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  };
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Filters"
      className="layer-surface w-[min(264px,calc(100vw-1rem))] p-3 flex flex-col gap-3"
      style={{ position: 'fixed', top: anchor.top, right: anchor.right, zIndex: 60 }}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-fg">Filters</span>
        {filtersActive && (
          <button
            type="button"
            className="text-xs text-fg-2 hover:text-fg transition-colors"
            onClick={() => { onProjects(new Set()); onTags(new Set()); }}
          >
            Clear
          </button>
        )}
      </div>
      {projects.length > 0 && (
        <Group label="Project">
          {projects.map((p) => (
            <FilterChip key={p.path} active={selectedProjects.has(p.path)} onClick={() => onProjects(toggled(selectedProjects, p.path))}>
              {p.label} <span className="opacity-70 tabular-nums">{p.count}</span>
            </FilterChip>
          ))}
        </Group>
      )}
      {tags.length > 0 && (
        <Group label="Tags">
          {tags.map((t) => (
            <FilterChip key={t.id} active={selectedTagIds.has(t.id)} onClick={() => onTags(toggled(selectedTagIds, t.id))}>
              {t.label} <span className="opacity-70 tabular-nums">{tagCounts.get(t.id) ?? 0}</span>
            </FilterChip>
          ))}
        </Group>
      )}
      <Group label="Order">
        <SegmentedTabs
          variant="pill"
          tabs={ORDER_TABS}
          value={sortDir}
          onChange={(id) => onSortDir(id as 'asc' | 'desc')}
          aria-label="Order"
        />
      </Group>
    </div>
  );
});
