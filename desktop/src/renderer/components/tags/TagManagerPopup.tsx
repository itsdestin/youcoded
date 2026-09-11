// src/renderer/components/tags/TagManagerPopup.tsx
//
// The one place tags are MANAGED (renamed, recolored, archived, deleted).
//
// WHY THIS EXISTS: tag CRUD used to live inside TagPicker — a ✎ button on each
// row expanded a rename/color/archive/delete block *inside the apply popover*.
// That put two different jobs in one control: "tag this conversation" (done
// constantly, wants to be fast) and "reorganize my tags" (done rarely, wants
// room). It also meant the only way to rename a tag was to open a session's
// tag popover, so registry editing was reachable only from a per-session
// surface. Splitting them follows the pattern the rest of the app already uses
// for the same shape — FolderSwitcher's "Manage projects…" footer opens Project
// View, ModelPicker's "Manage models…" footer opens Settings → Model Providers.
// TagPicker's "Manage tags…" footer opens this.
//
// Layer 2 (Dialog's default) so it stacks above the Resume Browser's layer-1
// overlay, which is where it is opened from today.
import { useMemo, useState } from 'react';
import type { TagRecord } from '../../../shared/tags';
import { TAG_COLORS, DEFAULT_TAG_COLOR, TagColor } from '../../../shared/tags';
import { TagRegistryApi } from '../../hooks/useTagRegistry';
import { Button, Dialog, EmptyState, ErrorState, InputGroup, TextInput, Toggle } from '../ui';

export function TagManagerPopup({ open, onClose, registry, layer = 2 }: {
  open: boolean;
  onClose: () => void;
  registry: TagRegistryApi;
  /** Overlay layer. Defaults to 2, which sits above the Resume Browser's
   *  layer-1 panel. Callers that are THEMSELVES layer 2 (the StatusBar tags
   *  chip, the close-session prompt) must pass 3, or the manager renders at the
   *  same z-index as the surface that opened it. */
  layer?: 2 | 3;
}) {
  const [draft, setDraft] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const name = draft.trim();
  // Same duplicate guard TagPicker's inline create uses — a second tag with an
  // identical label is indistinguishable in every chip UI, so it's blocked
  // rather than silently created.
  const exists = registry.tags.some((t) => t.label.toLowerCase() === name.toLowerCase() && !t.archived);
  const canCreate = name.length > 0 && !exists;

  const visible = useMemo(
    () => registry.tags.filter((t) => showArchived || !t.archived),
    [registry.tags, showArchived],
  );
  const archivedCount = registry.tags.filter((t) => t.archived).length;

  const handleCreate = async () => {
    if (!canCreate) return;
    await registry.create(name, DEFAULT_TAG_COLOR);
    setDraft('');
  };

  if (!open) return null;

  return (
    <Dialog open onClose={onClose} title="Manage Tags" size="panel" layer={layer}>
      <p className="text-2xs text-fg-dim leading-relaxed">
        Tags are labels you put on conversations so you can find them again. Renaming or recoloring
        one here updates it everywhere it's applied.
      </p>

      <InputGroup size="sm">
        <InputGroup.Field
          aria-label="New tag name"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && canCreate) { e.preventDefault(); handleCreate(); } }}
          placeholder="New tag name…"
        />
        <Button size="sm" onClick={handleCreate} disabled={!canCreate}>Create</Button>
      </InputGroup>
      {/* Plain-words reason the Create button is dead, rather than a button that
          silently does nothing (error-message standards: specific and accurate). */}
      {name.length > 0 && exists && (
        <p className="text-3xs text-fg-muted">A tag called “{name}” already exists.</p>
      )}

      <div className="flex flex-col gap-1">
        {/* WHY (error inventory 2026-09-10, false message 16): a failed read used to reach
            this list as [] and read "No tags yet — create one above" to someone with tags.
            With nothing ever loaded, the failure IS the answer. With tags from an earlier
            read, they stay — they are real — and one line says they may be out of date. */}
        {registry.error && registry.tags.length === 0 ? (
          <ErrorState variant="inline" message={`Couldn't load your tags: ${registry.error}`} onRetry={registry.reload} />
        ) : visible.length === 0 ? (
          <EmptyState message={showArchived ? 'No tags yet' : 'No tags yet — create one above'} />
        ) : (
          <>
            {registry.error && (
              <ErrorState variant="inline" message="Couldn't refresh your tags — showing the last ones loaded." onRetry={registry.reload} />
            )}
            {visible.map((t) => <ManagedTagRow key={t.id} tag={t} registry={registry} />)}
          </>
        )}
      </div>

      {/* Archived tags stay applied to their conversations but drop out of the
          apply picker, so this is the only surface that can surface them again. */}
      {archivedCount > 0 && (
        <div className="flex items-center justify-between">
          <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase">
            Show Archived ({archivedCount})
          </label>
          <Toggle checked={showArchived} onChange={setShowArchived} aria-label="Show Archived" />
        </div>
      )}
    </Dialog>
  );
}

// One tag: swatch (opens the palette), inline-rename field, archive, delete.
// `bg-inset/50` borderless is change 25's in-panel ROW surface — the same call
// EngineCard and LocalModelsSection make for a row inside a panel.
function ManagedTagRow({ tag, registry }: { tag: TagRecord; registry: TagRegistryApi }) {
  const [label, setLabel] = useState(tag.label);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Commit on blur (and on Enter) only when it actually changed, matching
  // NoteEditor's save-on-blur convention. An emptied field reverts rather than
  // writing a nameless tag.
  const commit = () => {
    const next = label.trim();
    if (!next) { setLabel(tag.label); return; }
    if (next !== tag.label) registry.update(tag.id, { label: next });
  };

  return (
    <div className="rounded-md bg-inset/50 px-2 py-1.5 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setPaletteOpen((o) => !o)}
          className="w-4 h-4 shrink-0 rounded-full border"
          style={{ backgroundColor: `var(--${tag.color})`, borderColor: `var(--${tag.color})` }}
          aria-label={`Change color (currently ${tag.color.replace('tag-', '')})`}
          aria-expanded={paletteOpen}
        />
        <TextInput
          size="sm"
          className="flex-1 min-w-0"
          aria-label={`Rename ${tag.label}`}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
        <button
          type="button"
          onClick={() => registry.update(tag.id, { archived: !tag.archived })}
          className="text-3xs text-fg-muted hover:text-fg shrink-0"
        >
          {tag.archived ? 'Unarchive' : 'Archive'}
        </button>
        {/* Two-step delete: a tag can be applied to conversations this list
            doesn't show, so the first click has to say what's about to happen
            rather than just doing it. */}
        <button
          type="button"
          onClick={() => { if (confirmDelete) registry.remove(tag.id); else setConfirmDelete(true); }}
          onBlur={() => setConfirmDelete(false)}
          className={`text-3xs shrink-0 ${confirmDelete ? 'text-destructive-fg font-medium' : 'text-fg-muted hover:text-fg'}`}
        >
          {confirmDelete ? 'Delete?' : 'Delete'}
        </button>
      </div>
      {paletteOpen && (
        <div className="flex flex-wrap gap-1 pl-6">
          {TAG_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => { registry.update(tag.id, { color: c as TagColor }); setPaletteOpen(false); }}
              className={`w-4 h-4 rounded-full border ${tag.color === c ? 'ring-2 ring-offset-1 ring-offset-inset ring-fg-dim' : ''}`}
              style={{ backgroundColor: `var(--${c})`, borderColor: `var(--${c})` }}
              aria-label={c}
              title={c}
            />
          ))}
        </div>
      )}
    </div>
  );
}
