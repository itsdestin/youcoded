// src/renderer/components/tags/SessionDetails.tsx
//
// Session details: a session's name and note, its tags and Pin to top — the editor every
// surface but the close prompt uses (status bar popup, Resume's organize sheet, the side
// panel's sheet, a project's conversation preview).
//
// WHY this shape (tags-final#TF-1 → session-details-1…5, Destin 2026-10-04): the top card
// mirrors a project's card — the name large (click to rename), then the note "in quotes and
// italics, as we do for description in project view", or "+ Add a note". One Tags card
// (layout A): this session's tags first, larger and filled; then "Add a tag" with the search,
// the other tags as grey outlines and archived ones flat grey. Clicking a tag opens its edit
// box in the card. A surface whose header already shows the name passes no `name`.
import { useMemo, useState } from 'react';
import type { TagRecord } from '../../../shared/tags';
import { DEFAULT_TAG_COLOR } from '../../../shared/tags';
import type { TagRegistryApi } from '../../hooks/useTagRegistry';
import { Button, CARD_LEVEL_1, CARD_LEVEL_2, ErrorState, FieldError, FoldRow, InputGroup, SegmentedTabs, SectionLabel, SettingRow, Textarea, Toggle } from '../ui';
import { ChipAction, TagWord, mix } from './TagChip';
import { NewTagFields, TagFields } from './TagCloud';
import { PinIcon } from './PinIcon';

type Props = {
  /** The session's name, shown large and renamed on click; omit where the surface's own
   *  header already shows it. */
  name?: string;
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
function HeaderCard({ name, onRename, note, onNote }: { name?: string; onRename?: () => void; note: string; onNote: (t: string) => void }) {
  return (
    <div className={`${CARD_LEVEL_1} p-4`}>
      <NoteBlock name={name} onRename={onRename} note={note} onNote={onNote} />
    </div>
  );
}

/** The name (when given) and the note — no card of its own, so a sheet can place it. */
function NoteBlock({ name, onRename, note, onNote, hang = true }: { name?: string; onRename?: () => void; note: string; onNote: (t: string) => void; hang?: boolean }) {
  // The project card hangs the note's box into the card's margin so its WORDS line up with
  // the name; in the narrow Resume sheet that left the box touching the card's edge.
  const ml = hang ? '-ml-2.5' : '', mlAdd = hang ? '-ml-2' : '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note);
  const fit = (el: HTMLTextAreaElement | null) => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } };
  // No name above (Resume, side panel, Projects): the note leads the card, no gap over it.
  const top = name !== undefined ? 'mt-1.5' : '';
  const commit = () => { setEditing(false); if (draft.trim() !== note.trim()) onNote(draft.trim()); };
  return (
    <div>
      {/* The Resume card's title control: dotted underline and a pencil, click to rename. */}
      {name !== undefined && <div><button type="button" onClick={onRename} disabled={!onRename} aria-label={`Rename ${name}`}
        className="group inline-flex max-w-full items-start gap-1.5 -ml-1 px-1 py-0.5 rounded-md text-left hover:bg-inset transition-colors">
        <span className="text-lg font-semibold text-fg leading-tight break-words underline decoration-dotted decoration-fg-muted underline-offset-[3px]">{name}</span>
        <svg className="w-3.5 h-3.5 mt-1 shrink-0 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      </button></div>}
      {editing ? (
        <Textarea size="sm" ref={fit} rows={1} autoFocus value={draft} aria-label="Note"
          placeholder="A note for later — shows under All sessions"
          className={`${top} ${ml} w-full text-sm italic overflow-hidden`}
          onChange={(e) => { setDraft(e.target.value); fit(e.currentTarget); }}
          onKeyDown={(e) => { if (e.key === 'Escape') { setDraft(note); setEditing(false); } }}
          onBlur={commit} />
      ) : note ? (
        <button type="button" onClick={() => { setDraft(note); setEditing(true); }} title="Edit note"
          className={`${top} block w-full text-left rounded-lg border border-transparent ${ml} px-2.5 py-1.5 hover:bg-inset transition-colors`}>
          <span className="text-sm italic text-fg-dim whitespace-pre-wrap break-words">“{note}”</span>
        </button>
      ) : (
        // Its own line under the name (a bare inline button sat beside it).
        <div><button type="button" onClick={() => { setDraft(''); setEditing(true); }}
          className={`${top} ${mlAdd} inline-flex items-center gap-1 rounded-md border border-dashed border-edge-dim px-2 py-1 text-xs text-fg-muted hover:text-fg hover:border-edge hover:bg-inset transition-colors`}>
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
function AppliedPill({ t, onEdit, onRemove, picked }: { t: TagRecord; onEdit: () => void; onRemove: () => void; picked: boolean }) {
  const c = mix(t.color);
  return (
    <span role="button" tabIndex={0} onClick={onEdit} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEdit(); } }} aria-label={`Edit ${t.label}`} aria-pressed={picked}
      className={`shrink-0 inline-flex items-center gap-1.5 pl-1.5 pr-2 h-6.5 rounded-full border text-xs leading-none text-fg cursor-pointer ${picked ? 'ring-2 ring-accent ring-offset-1 ring-offset-inset' : ''}`}
      style={{ backgroundColor: `color-mix(in srgb, ${c} 25%, transparent)`, borderColor: `color-mix(in srgb, ${c} 60%, transparent)` }}>
      <TagWord label={t.label} size={16} iconStyle={{ color: c }} />
      <ChipAction kind="remove" label={t.label} onClick={onRemove} size="md" />
    </span>
  );
}
function OtherPill({ t, onEdit, onAdd, picked }: { t: TagRecord; onEdit: () => void; onAdd?: () => void; picked: boolean }) {
  const archived = !!t.archived;
  return (
    <span role="button" tabIndex={0} onClick={onEdit} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEdit(); } }} aria-label={`Edit ${t.label}`} aria-pressed={picked}
      className={`shrink-0 inline-flex items-center gap-1 pl-1 ${onAdd ? 'pr-1' : 'pr-1.5'} h-4.5 rounded-full border text-2xs leading-none cursor-pointer transition-colors ${
        archived ? 'border-transparent bg-inset text-fg-faint' : 'border-edge-dim text-fg-2 hover:bg-inset'
      } ${picked ? 'ring-2 ring-accent ring-offset-1 ring-offset-inset' : ''}`}>
      <TagWord label={t.label} size={12} iconClass={archived ? 'text-fg-faint' : ''} iconStyle={archived ? undefined : { color: mix(t.color) }} />
      {onAdd && <ChipAction kind="add" label={t.label} onClick={onAdd} />}
    </span>
  );
}

/** The tag editor's pieces, for each layout to arrange. */
function useTagEditor({ registry, appliedIds, onToggleTag }: Pick<Props, 'registry' | 'appliedIds' | 'onToggleTag'>) {
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

  // Nothing loaded at all: the whole editor is this error (error inventory #16).
  const failed = registry.error && registry.tags.length === 0
    ? <ErrorState variant="inline" message={`Couldn't load your tags: ${registry.error}`} onRetry={registry.reload} />
    : null;
  // A failed refresh keeps the tags already shown and says so.
  const stale = registry.error ? <FieldError>Couldn't refresh your tags — showing the last ones loaded.</FieldError> : null;

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
        <span className="tag-line tag-line--caps">+ New tag</span>
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

  return { failed, stale, applied, appliedPills, search, otherCloud, editBox, openNew: () => setPicked('new') };
}

function Tags(p: Props) {
  const t = useTagEditor(p);
  if (t.failed) return t.failed;
  return (
    <section>
      <SectionLabel className="mb-2">Tags</SectionLabel>
      <div className={`${CARD_LEVEL_1} p-3 space-y-3`}>
        {t.stale}
        {t.appliedPills}
        <div className="space-y-2">
          <div className="text-xs font-medium text-fg-2">Add a tag</div>
          {t.search}
          {t.otherCloud}
        </div>
        {t.editBox}
      </div>
    </section>
  );
}

// ── The Resume sheet (TRIAL, round 2 — resume-sheet-1#RS-2: A/B/C were "none of these. try
// again"). These borrow Resume's OWN expanded panel (ResumeOptionsForm), not the popup:
//   D — like the Resume panel: grey captions over each control, a plain switch row, no boxes
//   E — fold-out rows: "Note" and "Tags" as the Settings fold-out (FoldRow), each opening in
//       place, and Pin to top as a switch row
//   F — tabs: a "Tags | Note" switch (SegmentedTabs) over one of the two, Pin to top under
export const TRIAL_SHEET = 'D' as 'D' | 'E' | 'F';

export function SessionSheet(p: Props) {
  const t = useTagEditor(p);
  const [tab, setTab] = useState<'tags' | 'note'>('tags');
  const caption = 'text-xs font-medium text-fg-muted mb-1 block';
  const tags = t.failed ?? <div className="space-y-2">{t.stale}{t.appliedPills}{t.search}{t.otherCloud}{t.editBox}</div>;
  const note = <NoteBlock note={p.note} onNote={p.onNote} hang={false} />;
  // The Resume panel's own switch row: label left, switch right, no box.
  const pinRow = (
    <div className="flex items-center justify-between">
      <span className="text-xs font-medium text-fg-muted">Pin to top</span>
      <Toggle checked={p.pin.pinned} onChange={p.pin.onPin} aria-label="Pin to top" />
    </div>
  );
  if (TRIAL_SHEET === 'D') {
    return (
      <div className="flex flex-col gap-3">
        <div><span className={caption}>Note</span>{note}</div>
        <div><span className={caption}>Tags</span>{tags}</div>
        {pinRow}
      </div>
    );
  }
  if (TRIAL_SHEET === 'E') {
    const applied = t.applied.map((x) => x.label).join(', ');
    return (
      <div className="flex flex-col gap-2">
        <FoldRow title="Note" description={p.note ? `“${p.note}”` : 'None yet'}>{note}</FoldRow>
        <FoldRow title="Tags" description={applied || 'None yet'}>{tags}</FoldRow>
        <SettingRow variant="item" title="Pin to top" icon={<PinIcon className="w-3.5 h-3.5 text-fg-muted" />}
          control={<Toggle checked={p.pin.pinned} onChange={p.pin.onPin} aria-label="Pin to top" />} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <SegmentedTabs variant="contained" aria-label="Tags or note" value={tab} onChange={(id) => setTab(id as 'tags' | 'note')}
        tabs={[{ id: 'tags', label: t.applied.length ? `Tags (${t.applied.length})` : 'Tags' }, { id: 'note', label: p.note ? 'Note ✓' : 'Note' }]} />
      {tab === 'tags' ? tags : note}
      {pinRow}
    </div>
  );
}
