// src/renderer/components/tags/TagEditRow.tsx
import { useState } from 'react';
import type { TagRecord } from '../../../shared/tags';
import { TAG_COLORS, TagColor } from '../../../shared/tags';
import type { TagRegistryApi } from '../../hooks/useTagRegistry';
import { Button, TextInput } from '../ui';

// One tag's editor: swatch (opens the palette), inline-rename field, archive, delete.
// WHY its own file (pick-menus#PM-4, 2026-10-01): it moved out of the retired Manage
// tags popup and now opens under a tag's "…" right inside the tag picker, so renaming
// or deleting happens in the same list you tick tags in.
export function TagEditRow({ tag, registry }: { tag: TagRecord; registry: TagRegistryApi }) {
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
          // A swatch has no fill to change — it IS the colour — so a ring answers instead.
          className="w-4 h-4 shrink-0 rounded-full border transition-shadow hover:ring-2 hover:ring-edge active:ring-fg-muted"
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
        {/* WHY outlined (guide: secondary actions are outlined, never bare
            text): both were hand-rolled text-fg-muted buttons in a dense row. */}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => registry.update(tag.id, { archived: !tag.archived })}
          className="shrink-0"
        >
          {tag.archived ? 'Unarchive' : 'Archive'}
        </Button>
        {/* Two-step delete: a tag can be applied to conversations this list
            doesn't show, so the first click has to say what's about to happen
            rather than just doing it. The confirm step swaps to the guide's
            "destructive confirm: the red button takes the main action's
            place" instead of colouring the label text red. */}
        <Button
          variant={confirmDelete ? 'danger' : 'secondary'}
          size="sm"
          onClick={() => { if (confirmDelete) registry.remove(tag.id); else setConfirmDelete(true); }}
          onBlur={() => setConfirmDelete(false)}
          className="shrink-0"
        >
          {confirmDelete ? 'Delete?' : 'Delete'}
        </Button>
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
