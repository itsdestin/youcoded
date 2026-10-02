// src/renderer/components/tags/TagCloud.tsx
//
// The Tags card of Tags & note, and its two edit pages.
//
// WHY this shape (pick-menus-8#PM8-1, Destin 2026-10-02: "cloud is interesting, but would
// need refinement. dont like the three dot menu. want a clear manage/edit menu thing.
// maybe keep x/+ on the right side of each tag pill"): every tag is one pill in a block
// — tinted with × when it is on this session, faint with + when it isn't — and editing
// moved behind one clear "Edit tags" button. The edit pages copy the approved quick chips
// editor (pick-menus-4#PM4-1): shelves of pills (Tags / Archived), a page per item with
// the Dialog's back arrow, the destructive button red on the far left, Cancel then Save
// on the right.
import { useMemo, useState } from 'react';
import type { TagRecord } from '../../../shared/tags';
import { DEFAULT_TAG_COLOR, TAG_COLORS, type TagColor } from '../../../shared/tags';
import type { TagRegistryApi } from '../../hooks/useTagRegistry';
import { Button, CARD_LEVEL_1, ErrorState, InputGroup, SectionLabel, SettingRow, TextInput, Toggle } from '../ui';
import { TagChip } from './TagChip';

/** The Tags card: search-or-create, then every live tag as a pill. */
export function TagCloud({ registry, appliedIds, onToggle, onEditTags }: {
  registry: TagRegistryApi;
  appliedIds: Set<string>;
  onToggle: (tagId: string, next: boolean) => void;
  onEditTags: () => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const live = useMemo(() => registry.tags.filter((t) => !t.archived), [registry.tags]);
  const shown = useMemo(() => live.filter((t) => !q || t.label.toLowerCase().includes(q)), [live, q]);
  // A second tag with the same name would be indistinguishable in every pill.
  const canCreate = q.length > 0 && !registry.tags.some((t) => t.label.toLowerCase() === q && !t.archived);
  const create = async () => {
    const tag = await registry.create(query.trim(), DEFAULT_TAG_COLOR);
    if (tag) { onToggle(tag.id, true); setQuery(''); }
  };

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <SectionLabel>Tags</SectionLabel>
        <Button variant="secondary" size="sm" onClick={onEditTags}>Edit tags</Button>
      </div>
      <div className={`${CARD_LEVEL_1} p-3 space-y-2.5`}>
        <InputGroup size="sm">
          <InputGroup.Field
            aria-label="Search or create a tag"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && canCreate) { e.preventDefault(); void create(); } }}
            placeholder="Search or create a tag…"
          />
          {canCreate && <Button size="sm" onClick={() => void create()} aria-label={`Create tag ${query.trim()}`}>Create</Button>}
        </InputGroup>
        {registry.error && registry.tags.length === 0 ? (
          <ErrorState variant="inline" message={`Couldn't load your tags: ${registry.error}`} onRetry={registry.reload} />
        ) : shown.length === 0 ? (
          <p className="text-3xs text-fg-muted">{live.length === 0 ? 'No tags yet — type a name to create one.' : 'No tag matches.'}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {shown.map((t) => {
              const on = appliedIds.has(t.id);
              return (
                // The whole pill switches it; the ×/+ at its right says which way.
                <button key={t.id} type="button" onClick={() => onToggle(t.id, !on)} aria-pressed={on}
                  aria-label={on ? `Take ${t.label} off this session` : `Put ${t.label} on this session`}
                  className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  <TagChip tag={t} dim={!on} className="!text-2xs !py-0.5"
                    onRemove={on ? () => onToggle(t.id, false) : undefined}
                    onAdd={on ? undefined : () => onToggle(t.id, true)} />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

/** "Edit tags": every tag as a pill on two shelves — Tags and Archived. Click one to edit it. */
export function TagShelvesPage({ registry, onPick }: { registry: TagRegistryApi; onPick: (tagId: string) => void }) {
  const shelf = (archived: boolean, title: string, empty: string) => {
    const items = registry.tags.filter((t) => !!t.archived === archived);
    return (
      <section>
        <SectionLabel className="mb-2">{title}</SectionLabel>
        <div className={`${CARD_LEVEL_1} p-3 flex flex-wrap gap-1.5 min-h-12`}>
          {items.length === 0 && <span className="text-3xs text-fg-muted self-center">{empty}</span>}
          {items.map((t) => (
            <button key={t.id} type="button" onClick={() => onPick(t.id)} aria-label={`Edit ${t.label}`}
              className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              <TagChip tag={t} dim={archived} className="!text-2xs !py-0.5 hover:brightness-95" />
            </button>
          ))}
        </div>
      </section>
    );
  };
  return (
    <>
      {shelf(false, 'Tags', 'No tags yet')}
      {shelf(true, 'Archived', 'Archived tags stay on their conversations but leave the picker')}
      <p className="text-3xs text-fg-muted">Click a tag to rename it, change its colour, archive or delete it. Renaming changes it everywhere it's used.</p>
    </>
  );
}

/** One tag: name, colour, Archived; Delete (asks first) far left, Cancel then Save right. */
export function TagEditPage({ tag, registry, onDone }: { tag: TagRecord; registry: TagRegistryApi; onDone: () => void }) {
  const [label, setLabel] = useState(tag.label);
  const [color, setColor] = useState<TagColor>(tag.color as TagColor);
  const [archived, setArchived] = useState(!!tag.archived);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const name = label.trim();
  const taken = registry.tags.some((t) => t.id !== tag.id && !t.archived && t.label.toLowerCase() === name.toLowerCase());
  const canSave = name.length > 0 && !taken;

  const save = () => {
    if (!canSave) return;
    const patch: Partial<TagRecord> = {};
    if (name !== tag.label) patch.label = name;
    if (color !== tag.color) patch.color = color;
    if (archived !== !!tag.archived) patch.archived = archived;
    if (Object.keys(patch).length) registry.update(tag.id, patch);
    onDone();
  };

  return (
    <>
      <div className={`${CARD_LEVEL_1} p-3 space-y-2.5`}>
        <TextInput size="sm" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Tag name" className="w-full" autoFocus />
        {taken && <p className="text-3xs text-fg-muted">A tag called “{name}” already exists.</p>}
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Colour">
          {TAG_COLORS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c.replace('tag-', '')}
              onClick={() => setColor(c as TagColor)}
              className={`w-5 h-5 rounded-full border ${color === c ? 'ring-2 ring-offset-2 ring-offset-inset ring-fg-dim' : ''}`}
              style={{ backgroundColor: `var(--${c})`, borderColor: `var(--${c})` }} />
          ))}
        </div>
      </div>
      <div className={`${CARD_LEVEL_1} px-3 py-1`}>
        <SettingRow header variant="item" title="Archived" description="Stays on its conversations, but leaves the tag picker"
          control={<Toggle checked={archived} onChange={setArchived} aria-label="Archived" />} />
      </div>
      <div className="flex items-center gap-2">
        {/* Delete asks once: a tag can sit on conversations you can't see from here. */}
        <Button variant="danger" size="sm" onClick={() => { if (confirmDelete) { registry.remove(tag.id); onDone(); } else setConfirmDelete(true); }}
          onBlur={() => setConfirmDelete(false)}>
          {confirmDelete ? 'Delete everywhere?' : 'Delete'}
        </Button>
        <span className="flex-1" />
        <Button variant="secondary" size="sm" onClick={onDone}>Cancel</Button>
        <Button size="sm" onClick={save} disabled={!canSave}>Save</Button>
      </div>
    </>
  );
}
