// src/renderer/components/tags/TagCloud.tsx
//
// The Tags card of the tags-and-note editor: every tag, and everything you can do to one,
// on one card.
//
// WHY this shape (pick-menus-8 … -15, Destin 2026-10-02/04): fifteen review rounds ended
// on a single page — "move the edit menu ... into the primary tags/note page within the
// tags card instead of having two separate pages". Every tag is a pill: tinted with × when
// it is on this session, faint and dashed with + when it isn't, grey when archived.
// Clicking a pill opens its edit box inside this card; "+ New tag" opens an empty one. The
// separate Manage tags popup and its "…" menus are gone.
import { useMemo, useState } from 'react';
import type { TagRecord } from '../../../shared/tags';
import { DEFAULT_TAG_COLOR, TAG_COLORS, type TagColor } from '../../../shared/tags';
import type { TagRegistryApi } from '../../hooks/useTagRegistry';
import { Button, CARD_LEVEL_1, CARD_LEVEL_2, ErrorState, FieldError, InputGroup, SectionLabel, SettingRow, TextInput, Toggle } from '../ui';
import { TagChip } from './TagChip';

export function TagCloud({ registry, appliedIds, onToggle }: {
  registry: TagRegistryApi;
  appliedIds: Set<string>;
  onToggle: (tagId: string, next: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | 'new' | null>(null);
  const q = query.trim().toLowerCase();
  const live = useMemo(() => registry.tags.filter((t) => !t.archived), [registry.tags]);
  const archived = useMemo(() => registry.tags.filter((t) => t.archived), [registry.tags]);
  const match = (t: TagRecord) => !q || t.label.toLowerCase().includes(q);
  // A second tag with the same name would be indistinguishable in every pill.
  const canCreate = q.length > 0 && !registry.tags.some((t) => t.label.toLowerCase() === q && !t.archived);
  const create = async () => {
    const tag = await registry.create(query.trim(), DEFAULT_TAG_COLOR);
    if (tag) { onToggle(tag.id, true); setQuery(''); }
  };
  const editing = picked && picked !== 'new' ? registry.byId.get(picked) ?? null : null;
  const toggleOpen = (id: string) => setPicked((p) => (p === id ? null : id));

  const pill = (t: TagRecord) => {
    const on = appliedIds.has(t.id);
    return (
      // The pill opens its edit box; its ×/+ (inside TagChip) switches it on or off.
      // A span, not a button: TagChip's ×/+ are buttons and buttons can't nest.
      <span key={t.id} role="button" tabIndex={0} aria-pressed={picked === t.id} aria-label={`Edit ${t.label}`}
        onClick={() => toggleOpen(t.id)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleOpen(t.id); } }}
        className={`rounded-full cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${picked === t.id ? 'ring-2 ring-accent ring-offset-1 ring-offset-inset' : ''}`}>
        {t.archived
          ? <TagChip tag={t} archivedLook className="!text-2xs !py-0.5" />
          : <TagChip tag={t} dim={!on} className="!text-2xs !py-0.5"
              onRemove={on ? () => onToggle(t.id, false) : undefined}
              onAdd={on ? undefined : () => onToggle(t.id, true)} />}
      </span>
    );
  };

  return (
    <section>
      <SectionLabel className="mb-2">Tags</SectionLabel>
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
        ) : (
          // gap-1: the pills wrap only when the row is really full (PM15-1: "pills wrap to
          // next line early? big gap on the right").
          <div className="flex flex-wrap items-center gap-1">
            {registry.error && <FieldError className="w-full">Couldn't refresh your tags — showing the last ones loaded.</FieldError>}
            {live.filter(match).map(pill)}
            {archived.filter(match).map(pill)}
            {/* "+ New tag" in the tags' own shape (PM12-2), dashed so it never reads as a tag. */}
            <button type="button" onClick={() => setPicked((p) => (p === 'new' ? null : 'new'))} aria-pressed={picked === 'new'}
              className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full border border-dashed text-2xs leading-none transition-colors ${picked === 'new' ? 'border-accent text-fg' : 'border-edge text-fg-2 hover:text-fg hover:bg-inset'}`}>
              + New tag
            </button>
          </div>
        )}
        {/* The edit box opens inside the Tags card, nested (guide: Card levels). */}
        {picked === 'new' && (
          <div className={`${CARD_LEVEL_2} p-3 space-y-2`}>
            <div className="text-xs font-medium text-fg">New tag</div>
            <NewTagFields registry={registry} onDone={(id) => { if (id) onToggle(id, true); setPicked(null); }} onCancel={() => setPicked(null)} />
          </div>
        )}
        {editing && (
          <div className={`${CARD_LEVEL_2} p-3 space-y-2`}>
            <div className="text-xs font-medium text-fg">Edit “{editing.label}”</div>
            <TagFields key={editing.id} tag={editing} registry={registry} onClose={() => setPicked(null)} />
          </div>
        )}
      </div>
    </section>
  );
}

/** The ten theme-tuned colours, then a picker for any colour (PM12-2, approved PM13-2). */
export function ColourRow({ value, onChange, label }: { value: TagColor; onChange: (c: TagColor) => void; label: string }) {
  const custom = value.startsWith('#');
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-fg">Colour</div>
      <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={label}>
        {TAG_COLORS.map((c) => (
          <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={c.replace('tag-', '')}
            onClick={() => onChange(c)}
            className={`w-5 h-5 rounded-full border ${value === c ? 'ring-2 ring-offset-2 ring-offset-inset ring-fg-dim' : ''}`}
            style={{ backgroundColor: `var(--${c})`, borderColor: `var(--${c})` }} />
        ))}
        {/* Any colour: a rainbow ring around the picked colour (or the rainbow alone). */}
        <label title="Any colour"
          className={`relative w-5 h-5 rounded-full cursor-pointer overflow-hidden ${custom ? 'ring-2 ring-offset-2 ring-offset-inset ring-fg-dim' : ''}`}
          style={{ background: custom ? `radial-gradient(${value} 45%, transparent 47%), conic-gradient(red, yellow, lime, cyan, blue, magenta, red)` : 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' }}>
          <input type="color" aria-label="Pick any colour" value={custom ? value : '#888888'}
            onChange={(e) => onChange(e.target.value as TagColor)}
            className="absolute inset-0 opacity-0 cursor-pointer" />
        </label>
      </div>
    </div>
  );
}

/** One tag's settings: a draft until Save (PM12-2: "a clearer save/confirm button");
 *  red Delete tag far left, asking first (PM13-4). */
export function TagFields({ tag, registry, onClose }: { tag: TagRecord; registry: TagRegistryApi; onClose: () => void }) {
  const [label, setLabel] = useState(tag.label);
  const [color, setColor] = useState<TagColor>(tag.color);
  const [archived, setArchived] = useState(!!tag.archived);
  const [confirm, setConfirm] = useState(false);
  const n = label.trim();
  const taken = registry.tags.some((t) => t.id !== tag.id && !t.archived && t.label.toLowerCase() === n.toLowerCase());
  const save = () => {
    if (!n || taken) return;
    const patch: Partial<Pick<TagRecord, 'label' | 'color' | 'archived'>> = {};
    if (n !== tag.label) patch.label = n;
    if (color !== tag.color) patch.color = color;
    if (archived !== !!tag.archived) patch.archived = archived;
    if (Object.keys(patch).length) void registry.update(tag.id, patch);
    onClose();
  };
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <div className="text-xs font-medium text-fg">Name</div>
        <TextInput size="sm" value={label} onChange={(e) => setLabel(e.target.value)} aria-label={`Name of ${tag.label}`} className="w-full" />
        {!n ? <FieldError>A tag needs a name.</FieldError>
          : taken ? <FieldError>A tag called “{n}” already exists.</FieldError> : null}
      </div>
      <ColourRow value={color} onChange={setColor} label={`Colour of ${tag.label}`} />
      <SettingRow header variant="item" title="Archived" description="Stays on its conversations, but isn't offered when tagging"
        control={<Toggle checked={archived} onChange={setArchived} aria-label="Archived" />} />
      {confirm ? (
        // The guide's destructive confirm: the red button takes the main action's place.
        <div className="flex items-center gap-2">
          <span className="flex-1 text-xs text-fg-2">Delete “{tag.label}” from every conversation?</span>
          <Button variant="secondary" size="sm" onClick={() => setConfirm(false)}>Keep it</Button>
          <Button variant="danger" size="sm" onClick={() => { void registry.remove(tag.id); onClose(); }}>Delete</Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button variant="danger" size="sm" onClick={() => setConfirm(true)}>Delete tag</Button>
          <span className="flex-1" />
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={save}>Save</Button>
        </div>
      )}
    </div>
  );
}

/** A new tag: name and colour; red Cancel left, Create right (PM12-3). Create never greys
 *  out — an empty name answers with the guide's short error line (PM13-3). */
export function NewTagFields({ registry, onDone, onCancel }: { registry: TagRegistryApi; onDone: (id: string | null) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState<TagColor>(DEFAULT_TAG_COLOR);
  const [tried, setTried] = useState(false);
  const n = name.trim();
  const taken = registry.tags.some((t) => !t.archived && t.label.toLowerCase() === n.toLowerCase());
  const create = async () => {
    setTried(true);
    if (!n || taken) return;
    const t = await registry.create(n, color);
    onDone(t ? t.id : null);
  };
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <div className="text-xs font-medium text-fg">Name</div>
        <TextInput size="sm" value={name} autoFocus onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void create(); } }}
          placeholder="Name the tag" aria-label="New tag name" className="w-full" />
        {taken ? <FieldError>A tag called “{n}” already exists.</FieldError>
          : tried && !n ? <FieldError>Give the tag a name first.</FieldError> : null}
      </div>
      <ColourRow value={color} onChange={setColor} label="Colour of the new tag" />
      <div className="flex items-center gap-2">
        <Button variant="danger" size="sm" onClick={onCancel}>Cancel</Button>
        <span className="flex-1" />
        <Button size="sm" onClick={() => void create()}>Create</Button>
      </div>
    </div>
  );
}

