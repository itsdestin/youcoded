// TRIAL sketches for the pick-menus-4 deck (pick-menus-3#PM3-2: "still not loving the
// tag interface"). Two other shapes for the Tags card of Tags & note; the "…" menu on
// each tag is the approved one (TagEditRow's ContextMenu, PM3-3). Not wired beyond
// apply/unapply — the chosen one gets built properly.
import { useMemo, useState } from 'react';
import type { TagRecord } from '../../../shared/tags';
import type { TagRegistryApi } from '../../hooks/useTagRegistry';
import { ContextMenu } from '../context-menu/ContextMenu';
import { InputGroup, SectionLabel, CARD_LEVEL_1 } from '../ui';
import { TagChip } from './TagChip';

function Dots() {
  return (
    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

function useTagMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; tag: TagRecord } | null>(null);
  const open = (e: React.MouseEvent, tag: TagRecord) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: r.right - 4, y: r.bottom + 2, tag });
  };
  const el = menu && (
    <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} entries={[
      { type: 'item', id: 'rename', label: 'Rename', icon: 'rename', run: () => {} },
      { type: 'item', id: 'colour', label: 'Change colour', icon: 'colour', run: () => {} },
      { type: 'item', id: 'archive', label: 'Archive', icon: 'archive', run: () => {} },
      { type: 'sep' },
      { type: 'item', id: 'delete', label: 'Delete…', icon: 'delete', run: () => {} },
    ]} />
  );
  return { open, el };
}

/** A: every tag a chip in one cloud — filled when on, outlined when off; "…" on hover. */
export function TagCloudSketch({ registry, appliedIds, onToggle }: {
  registry: TagRegistryApi; appliedIds: Set<string>; onToggle: (id: string, next: boolean) => void;
}) {
  const [q, setQ] = useState('');
  const tags = useMemo(() => registry.tags.filter((t) => !t.archived && t.label.toLowerCase().includes(q.trim().toLowerCase())), [registry.tags, q]);
  const menu = useTagMenu();
  return (
    <div className="space-y-2.5">
      <InputGroup size="sm">
        <InputGroup.Field aria-label="Search or create a tag" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search or create a tag…" />
      </InputGroup>
      <div className="flex flex-wrap gap-1.5">
        {tags.map((t, i) => {
          const on = appliedIds.has(t.id);
          return (
            <span key={t.id} className="group/tag relative inline-flex items-center">
              <button type="button" onClick={() => onToggle(t.id, !on)} aria-pressed={on}>
                <TagChip tag={t} className={`!text-2xs !px-2 !py-1 ${on ? '' : '!bg-transparent opacity-60'}`} />
              </button>
              <button type="button" aria-label={`More for ${t.label}`} onClick={(e) => menu.open(e, t)}
                className={`ml-0.5 w-4 h-4 rounded-sm flex items-center justify-center text-fg-muted hover:bg-inset ${i === 0 ? 'opacity-100' : 'opacity-0'} group-hover/tag:opacity-100`}>
                <Dots />
              </button>
            </span>
          );
        })}
      </div>
      <p className="text-3xs text-fg-muted">Click a tag to put it on this session or take it off.</p>
      {menu.el}
    </div>
  );
}

/** B: what's on this session first (with ✕), everything else below to add. */
export function TagOnOffSketch({ registry, appliedIds, onToggle }: {
  registry: TagRegistryApi; appliedIds: Set<string>; onToggle: (id: string, next: boolean) => void;
}) {
  const [q, setQ] = useState('');
  const live = registry.tags.filter((t) => !t.archived);
  const on = live.filter((t) => appliedIds.has(t.id));
  const off = live.filter((t) => !appliedIds.has(t.id) && t.label.toLowerCase().includes(q.trim().toLowerCase()));
  const menu = useTagMenu();
  return (
    <div className="space-y-4">
      <section>
        <SectionLabel className="mb-2">On this session</SectionLabel>
        <div className={`${CARD_LEVEL_1} p-3 flex flex-wrap gap-1.5 min-h-12`}>
          {on.length === 0 && <span className="text-3xs text-fg-muted">No tags yet</span>}
          {on.map((t) => (
            <TagChip key={t.id} tag={t} className="!text-2xs !px-2 !py-1" onRemove={() => onToggle(t.id, false)} />
          ))}
        </div>
      </section>
      <section>
        <SectionLabel className="mb-2">Add a tag</SectionLabel>
        <div className={`${CARD_LEVEL_1} p-3 space-y-2`}>
          <InputGroup size="sm">
            <InputGroup.Field aria-label="Search or create a tag" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search or create a tag…" />
          </InputGroup>
          <div className="flex flex-col">
            {off.map((t) => (
              <div key={t.id} className="flex items-center gap-1 rounded-md hover:bg-inset">
                <button type="button" onClick={() => onToggle(t.id, true)} className="flex-1 flex items-center gap-2 px-2 py-1.5 text-left">
                  <span className="text-fg-muted text-xs leading-none">+</span>
                  <TagChip tag={t} />
                </button>
                <button type="button" aria-label={`More for ${t.label}`} onClick={(e) => menu.open(e, t)}
                  className="shrink-0 w-6 h-6 rounded-sm flex items-center justify-center text-fg-muted hover:bg-inset hover:text-fg"><Dots /></button>
              </div>
            ))}
          </div>
        </div>
      </section>
      {menu.el}
    </div>
  );
}
