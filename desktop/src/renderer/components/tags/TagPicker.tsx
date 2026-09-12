// src/renderer/components/tags/TagPicker.tsx
//
// APPLY tags to one conversation. Deliberately does NOT manage the registry —
// rename/recolor/archive/delete moved to TagManagerPopup, reachable from the
// "Manage tags…" footer below. See that file's header for why the two jobs are
// split; the short version is that this control is used constantly and wants to
// be fast, and the editing UI it used to carry made every row a two-purpose
// target with a ✎ that expanded a form inside a popover.
//
// Archived tags are not offered here at all (they were behind a "Show archived"
// toggle). Archiving means "stop offering me this" — surfacing it in the picker
// anyway was the toggle undoing the feature. The manager can still show them.
import { useMemo, useState } from 'react';
import type { TagRecord } from '../../../shared/tags';
import { DEFAULT_TAG_COLOR } from '../../../shared/tags';
import { TagRegistryApi } from '../../hooks/useTagRegistry';
import { TagChip } from './TagChip';
import { Button, ErrorState, InputGroup } from '../ui';

/** A reserved flag rendered as a tag (see built-in-tags.ts). Not in the
 *  registry, so it carries its own applied state and setter, and never appears
 *  in the tag manager. */
export interface BuiltInTag {
  tag: Pick<TagRecord, 'id' | 'label' | 'color'>;
  hint?: string;
  applied: boolean;
  onToggle: (next: boolean) => void;
}

export function TagPicker({ appliedIds, onToggle, registry, onManageTags, builtIns = [], fieldClassName = '' }: {
  appliedIds: Set<string>;
  onToggle: (tagId: string, next: boolean) => void;
  registry: TagRegistryApi;
  /** Opens the tag manager. Omitted on surfaces that have nowhere to host it —
   *  the footer then simply isn't rendered (same optional-footer contract as
   *  ModelPicker's onManageModels / FolderSwitcher's onManageProjects). */
  onManageTags?: () => void;
  /** Reserved flags shown as tags, listed first. */
  builtIns?: BuiltInTag[];
  /** Extra classes for the search field's surface. Exists so a host whose own
   *  background is already `bg-inset` — the FIELD surface — can lift the field
   *  off it with `bg-well` rather than having an invisible control. */
  fieldClassName?: string;
}) {
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => registry.tags
    .filter((t) => !t.archived)
    .filter((t) => !q || t.label.toLowerCase().includes(q)), [registry.tags, q]);

  const visibleBuiltIns = useMemo(
    () => builtIns.filter((b) => !q || b.tag.label.toLowerCase().includes(q)),
    [builtIns, q],
  );

  // A built-in's name is taken too — creating a second "Priority" would give
  // the user two chips that look identical and behave differently.
  const exactExists = registry.tags.some((t) => t.label.toLowerCase() === q && !t.archived)
    || builtIns.some((b) => b.tag.label.toLowerCase() === q);
  const canCreate = q.length > 0 && !exactExists;

  const handleCreate = async () => {
    const tag = await registry.create(query.trim(), DEFAULT_TAG_COLOR);
    if (tag) { onToggle(tag.id, true); setQuery(''); }
  };

  return (
    <div className="flex flex-col gap-1.5">
      {/* Change 77: the Create action moves from a list row into the field itself.
          Enter still creates (same onKeyDown), and the button stays conditional on
          canCreate. The row used to echo the typed name (+ Create “x”); inside the
          field that echo is redundant visually, so it survives as the aria-label —
          screen-reader users still hear which tag they're about to create. */}
      <InputGroup size="sm" className={fieldClassName}>
        <InputGroup.Field
          aria-label="Search or create a tag"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && canCreate) { e.preventDefault(); handleCreate(); } }}
          placeholder="Search or create a tag…"
        />
        {canCreate && (
          <Button size="sm" onClick={handleCreate} aria-label={`Create tag ${query.trim()}`}>
            Create
          </Button>
        )}
      </InputGroup>
      <div className="max-h-48 overflow-y-auto flex flex-col gap-0.5">
        {/* Built-ins first and unseparated — they are meant to read as ordinary
            tags. The hint is the only thing marking them apart in the list. */}
        {visibleBuiltIns.map((b) => (
          <TagRow key={b.tag.id} tag={b.tag} applied={b.applied} hint={b.hint}
            onToggle={() => b.onToggle(!b.applied)} />
        ))}
        {visible.map((t) => (
          <TagRow key={t.id} tag={t} applied={appliedIds.has(t.id)}
            onToggle={() => onToggle(t.id, !appliedIds.has(t.id))} />
        ))}
        {/* WHY (code review 2026-09-11, F5): a failed read reaches here as no tags, and
            "No tags yet — type a name to create one." invited duplicates of tags the user
            already has. Same split as the tag manager: nothing loaded + an error = say so. */}
        {registry.error && registry.tags.length === 0 ? (
          <ErrorState variant="inline" message={`Couldn't load your tags: ${registry.error}`} onRetry={registry.reload} />
        ) : visible.length === 0 && visibleBuiltIns.length === 0 && !canCreate && (
          <div className="px-2 py-1 text-3xs text-fg-muted">No tags yet — type a name to create one.</div>
        )}
      </div>
      {/* Footer, not a list row: same shape as FolderSwitcher's "Manage
          projects…" and ModelPicker's "Manage models…" — a way OUT of the
          picker, kept visually separate from the things you can pick. */}
      {onManageTags && (
        <button
          type="button"
          onClick={onManageTags}
          className="self-start text-4xs text-fg-muted hover:text-fg-2"
        >
          Manage tags…
        </button>
      )}
    </div>
  );
}

// Apply/unapply only. The checkbox-style swatch fills when applied.
function TagRow({ tag, applied, onToggle, hint }: {
  tag: Pick<TagRecord, 'label' | 'color'>; applied: boolean; onToggle: () => void; hint?: string;
}) {
  return (
    <button onClick={onToggle} aria-pressed={applied}
      className="flex items-center gap-2 px-1 py-1 rounded-sm hover:bg-inset text-left min-w-0">
      <span className="w-3 h-3 shrink-0 rounded-sm border"
        style={{ backgroundColor: applied ? `var(--${tag.color})` : 'transparent',
                 borderColor: `var(--${tag.color})` }} />
      <TagChip tag={tag} />
      {hint && <span className="text-4xs text-fg-muted shrink-0 ml-auto">{hint}</span>}
    </button>
  );
}
