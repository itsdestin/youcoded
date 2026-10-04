// src/renderer/components/tags/SessionDetails.tsx
//
// TRIAL (tags-final#TF-1; round 2 session-details-1: no "Session" label, note in quotes and italics, rounder ×/+, icons aligned, Destin 2026-10-04): the Tags & note popup becomes a "Session
// details" page. "the first card [should] mirror the project card title/description, with
// the session name first and then ... the current note [not] in quote styling or the 'add
// note' button ... change how the applied/not applied/archived styles look, ... make
// applied more prominent and possibly put it in a new section."
//
// Three versions, picked by TRIAL_VARIANT, all from existing recipes:
//   A — one Tags card: this session's tags first, large; the rest below the search field
//   B — two cards: "On this session" (large pills) and "More tags" (search + the rest)
//   C — two cards: "On this session" as a list of rows, each with Remove; "More tags"
import { useMemo, useState } from 'react';
import type { TagRecord } from '../../../shared/tags';
import { DEFAULT_TAG_COLOR } from '../../../shared/tags';
import type { TagRegistryApi } from '../../hooks/useTagRegistry';
import { Button, CARD_LEVEL_1, CARD_LEVEL_2, ErrorState, InputGroup, SectionLabel, SettingRow, Textarea, Toggle } from '../ui';
import { ChipAction, FilledTag, TAG_ICON, mix, tagLabelClass } from './TagChip';
import { NewTagFields, TagFields } from './TagCloud';
import { PinIcon } from './PinIcon';

export const TRIAL_VARIANT = 'A' as 'A' | 'B' | 'C';

type Props = {
  name: string;
  onRename?: () => void;
  note: string;
  onNote: (text: string) => void;
  registry: TagRegistryApi;
  appliedIds: Set<string>;
  onToggleTag: (id: string, next: boolean) => void;
  pin: { pinned: boolean; onPin: (next: boolean) => void };
};

export function SessionDetails(p: Props) {
  return (
    <div className="flex flex-col gap-4">
      <HeaderCard name={p.name} onRename={p.onRename} note={p.note} onNote={p.onNote} />
      <Tags {...p} />
      <div className={`${CARD_LEVEL_1} px-3 py-1`}>
        <SettingRow header variant="item" title="Pin to top" icon={<PinIcon className="w-3.5 h-3.5 text-fg-muted" />}
          description="Keeps this session first in your session lists"
          control={<Toggle checked={p.pin.pinned} onChange={p.pin.onPin} aria-label="Pin to top" />} />
      </div>
    </div>
  );
}

/** The project card's title + description recipe (ProjectHero): a small label, the name
 *  large, then the note as plain words you click to edit — or "+ Add a note". */
function HeaderCard({ name, onRename, note, onNote }: { name: string; onRename?: () => void; note: string; onNote: (t: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note);
  const fit = (el: HTMLTextAreaElement | null) => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } };
  const commit = () => { setEditing(false); if (draft.trim() !== note.trim()) onNote(draft.trim()); };
  return (
    <div className={`${CARD_LEVEL_1} p-4`}>
      {/* The Resume card's title control: dotted underline and a pencil, click to rename. */}
      <div><button type="button" onClick={onRename} aria-label={`Rename ${name}`}
        className="group inline-flex max-w-full items-start gap-1.5 -ml-1 px-1 py-0.5 rounded-md text-left hover:bg-inset transition-colors">
        <span className="text-lg font-semibold text-fg leading-tight break-words underline decoration-dotted decoration-fg-muted underline-offset-[3px]">{name}</span>
        <svg className="w-3.5 h-3.5 mt-1 shrink-0 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      </button></div>
      {editing ? (
        <Textarea size="sm" ref={fit} rows={1} autoFocus value={draft} aria-label="Note"
          placeholder="A note for later — shows under All sessions"
          className="mt-1.5 -ml-2.5 w-full text-sm italic overflow-hidden"
          onChange={(e) => { setDraft(e.target.value); fit(e.currentTarget); }}
          onKeyDown={(e) => { if (e.key === 'Escape') { setDraft(note); setEditing(false); } }}
          onBlur={commit} />
      ) : note ? (
        <button type="button" onClick={() => { setDraft(note); setEditing(true); }} title="Edit note"
          className="mt-1.5 block w-full text-left rounded-lg border border-transparent -ml-2.5 px-2.5 py-1.5 hover:bg-inset transition-colors">
          <span className="text-sm italic text-fg-dim whitespace-pre-wrap break-words">“{note}”</span>
        </button>
      ) : (
        // Its own line under the name (a bare inline button sat beside it).
        <div><button type="button" onClick={() => { setDraft(''); setEditing(true); }}
          className="mt-1.5 -ml-2 inline-flex items-center gap-1 rounded-md border border-dashed border-edge-dim px-2 py-1 text-xs text-fg-muted hover:text-fg hover:border-edge hover:bg-inset transition-colors">
          <span aria-hidden className="text-sm leading-none">+</span>
          Add a note
        </button></div>
      )}
    </div>
  );
}

// ── Tag looks ────────────────────────────────────────────────────────────────
// On this session: larger, a stronger tint and a full-colour edge, words in the main text
// colour. Not on it: no fill, a plain grey edge, the colour only in the icon. Archived: no
// edge at all, a sunk background and faint words (unlike "+ New tag", which is dashed).
const ICON = TAG_ICON;
function AppliedPill({ t, onEdit, onRemove, picked }: { t: TagRecord; onEdit: () => void; onRemove: () => void; picked: boolean }) {
  const c = mix(t.color);
  return (
    <span role="button" tabIndex={0} onClick={onEdit} aria-label={`Edit ${t.label}`} aria-pressed={picked}
      className={`shrink-0 inline-flex items-center gap-1.5 pl-1.5 pr-2 py-1 rounded-full border text-xs leading-none text-fg cursor-pointer ${picked ? 'ring-2 ring-accent ring-offset-1 ring-offset-inset' : ''}`}
      style={{ backgroundColor: `color-mix(in srgb, ${c} 25%, transparent)`, borderColor: `color-mix(in srgb, ${c} 60%, transparent)` }}>
      <span className={ICON} style={{ color: c }}><FilledTag className="w-4 h-4" /></span>
      <span className={tagLabelClass(t.label)}>{t.label}</span>
      <ChipAction kind="remove" label={t.label} onClick={onRemove} size="md" />
    </span>
  );
}
function OtherPill({ t, onEdit, onAdd, picked }: { t: TagRecord; onEdit: () => void; onAdd?: () => void; picked: boolean }) {
  const archived = !!t.archived;
  return (
    <span role="button" tabIndex={0} onClick={onEdit} aria-label={`Edit ${t.label}`} aria-pressed={picked}
      className={`shrink-0 inline-flex items-center gap-1 pl-1 pr-1.5 py-0.5 rounded-full border text-2xs leading-none cursor-pointer transition-colors ${
        archived ? 'border-transparent bg-inset text-fg-faint' : 'border-edge-dim text-fg-2 hover:bg-inset'
      } ${picked ? 'ring-2 ring-accent ring-offset-1 ring-offset-inset' : ''}`}>
      <span className={`${ICON} ${archived ? 'text-fg-faint' : ''}`} style={archived ? undefined : { color: mix(t.color) }}><FilledTag className="w-3 h-3" /></span>
      <span className={tagLabelClass(t.label)}>{t.label}</span>
      {onAdd && <ChipAction kind="add" label={t.label} onClick={onAdd} />}
    </span>
  );
}

function Tags({ registry, appliedIds, onToggleTag }: Props) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | 'new' | null>(null);
  const q = query.trim().toLowerCase();
  const applied = useMemo(() => registry.tags.filter((t) => appliedIds.has(t.id)), [registry.tags, appliedIds]);
  const others = useMemo(() => [
    ...registry.tags.filter((t) => !appliedIds.has(t.id) && !t.archived),
    ...registry.tags.filter((t) => !appliedIds.has(t.id) && t.archived),
  ].filter((t) => !q || t.label.toLowerCase().includes(q)), [registry.tags, appliedIds, q]);
  const canCreate = q.length > 0 && !registry.tags.some((t) => t.label.toLowerCase() === q && !t.archived);
  const create = async () => { const t = await registry.create(query.trim(), DEFAULT_TAG_COLOR); if (t) { onToggleTag(t.id, true); setQuery(''); } };
  const toggle = (id: string) => setPicked((p) => (p === id ? null : id));
  const editing = picked && picked !== 'new' ? registry.byId.get(picked) ?? null : null;

  if (registry.error && registry.tags.length === 0) {
    return <ErrorState variant="inline" message={`Couldn't load your tags: ${registry.error}`} onRetry={registry.reload} />;
  }

  const search = (
    <InputGroup size="sm">
      <InputGroup.Field aria-label="Search or create a tag" value={query} placeholder="Search or create a tag…"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && canCreate) { e.preventDefault(); void create(); } }} />
      {canCreate && <Button size="sm" onClick={() => void create()}>Create</Button>}
    </InputGroup>
  );
  const otherCloud = (
    <div className="flex flex-wrap items-center gap-1">
      {others.map((t) => <OtherPill key={t.id} t={t} picked={picked === t.id} onEdit={() => toggle(t.id)} onAdd={t.archived ? undefined : () => onToggleTag(t.id, true)} />)}
      <button type="button" onClick={() => setPicked((p) => (p === 'new' ? null : 'new'))} aria-pressed={picked === 'new'}
        className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full border border-dashed text-2xs leading-none transition-colors ${picked === 'new' ? 'border-accent text-fg' : 'border-edge text-fg-2 hover:text-fg hover:bg-inset'}`}>
        <span className="tag-label">+ New tag</span>
      </button>
    </div>
  );
  const editBox = (
    <>
      {picked === 'new' && (
        <div className={`${CARD_LEVEL_2} p-3 space-y-2`}>
          <div className="text-xs font-medium text-fg">New tag</div>
          <NewTagFields registry={registry} onDone={(id) => { if (id) onToggleTag(id, true); setPicked(null); }} onCancel={() => setPicked(null)} />
        </div>
      )}
      {editing && (
        <div className={`${CARD_LEVEL_2} p-3 space-y-2`}>
          <div className="text-xs font-medium text-fg">Edit “{editing.label}”</div>
          <TagFields key={editing.id} tag={editing} registry={registry} onClose={() => setPicked(null)} />
        </div>
      )}
    </>
  );
  const none = <span className="text-xs text-fg-muted">No tags on this session yet</span>;
  const appliedPills = (
    <div className="flex flex-wrap items-center gap-1.5">
      {applied.length ? applied.map((t) => <AppliedPill key={t.id} t={t} picked={picked === t.id} onEdit={() => toggle(t.id)} onRemove={() => onToggleTag(t.id, false)} />) : none}
    </div>
  );

  if (TRIAL_VARIANT === 'A') {
    return (
      <section>
        <SectionLabel className="mb-2">Tags</SectionLabel>
        <div className={`${CARD_LEVEL_1} p-3 space-y-3`}>
          {appliedPills}
          <div className="space-y-2">
            <div className="text-xs font-medium text-fg-2">Add a tag</div>
            {search}
            {otherCloud}
          </div>
          {editBox}
        </div>
      </section>
    );
  }
  if (TRIAL_VARIANT === 'B') {
    return (
      <>
        <section>
          <SectionLabel className="mb-2">On this session</SectionLabel>
          <div className={`${CARD_LEVEL_1} p-3`}>{appliedPills}</div>
        </section>
        <section>
          <SectionLabel className="mb-2">More tags</SectionLabel>
          <div className={`${CARD_LEVEL_1} p-3 space-y-2.5`}>{search}{otherCloud}{editBox}</div>
        </section>
      </>
    );
  }
  // C — this session's tags as rows, each with its own Remove.
  return (
    <>
      <section>
        <SectionLabel className="mb-2">On this session</SectionLabel>
        <div className={`${CARD_LEVEL_1} px-3 py-1.5`}>
          {applied.length ? applied.map((t) => (
            <div key={t.id} className="flex items-center gap-2 py-1.5">
              <span className={ICON} style={{ color: mix(t.color) }}><FilledTag className="w-4 h-4" /></span>
              <button type="button" onClick={() => toggle(t.id)} className="flex-1 text-left text-sm text-fg hover:underline decoration-dotted underline-offset-2">{t.label}</button>
              <Button variant="ghost" size="sm" onClick={() => onToggleTag(t.id, false)} aria-label={`Remove ${t.label}`}>Remove</Button>
            </div>
          )) : <div className="py-1.5">{none}</div>}
        </div>
      </section>
      <section>
        <SectionLabel className="mb-2">More tags</SectionLabel>
        <div className={`${CARD_LEVEL_1} p-3 space-y-2.5`}>{search}{otherCloud}{editBox}</div>
      </section>
    </>
  );
}
