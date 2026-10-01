// src/renderer/components/tags/TagEditRow.tsx
//
// One tag in the Tags & note popup: apply it to this session, and — behind its "…" —
// rename, recolour, archive or delete it.
//
// WHY this shape (pick-menus-2#PM2-3/PM2-4, Destin 2026-10-01): the first try opened a
// half-row of mixed boxes and buttons under the tag ("doesn't match any other ui
// elements"), and Archive sat as prominent as the tag itself. Now the actions live in
// the app's own small menu (the themed ContextMenu, same as right-click), and only the
// one you pick opens: a name field, a row of colours, or the guide's destructive
// confirm (the red button takes the main action's place).
import { useState } from 'react';
import type { TagRecord } from '../../../shared/tags';
import { TAG_COLORS, TagColor } from '../../../shared/tags';
import type { TagRegistryApi } from '../../hooks/useTagRegistry';
import { ContextMenu } from '../context-menu/ContextMenu';
import { Button, TextInput, Toggle } from '../ui';
import { TagChip } from './TagChip';

export type TagRowStyle = 'switch' | 'chip';

type Mode = null | 'rename' | 'colour' | 'delete';

export function TagEditRow({ tag, registry, applied, onToggle, rowStyle }: {
  tag: TagRecord;
  registry: TagRegistryApi;
  /** Omitted for an archived tag: it can be edited, not applied. */
  applied?: boolean;
  onToggle?: () => void;
  rowStyle: TagRowStyle;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [label, setLabel] = useState(tag.label);

  const commitRename = () => {
    const next = label.trim();
    if (next && next !== tag.label) registry.update(tag.id, { label: next });
    else setLabel(tag.label);
    setMode(null);
  };

  // 'chip': the chip itself is the switch — filled when on, an outline when off.
  const chip = rowStyle === 'chip' && onToggle
    ? <TagChip tag={tag} className={applied ? '' : 'opacity-50 !bg-transparent'} />
    : <TagChip tag={tag} />;

  return (
    <div>
      <div className="flex items-center gap-1 min-h-7">
        {mode === 'rename' ? (
          <TextInput
            size="sm"
            className="flex-1 min-w-0"
            aria-label={`Rename ${tag.label}`}
            value={label}
            autoFocus
            onChange={(e) => setLabel(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') { e.stopPropagation(); setLabel(tag.label); setMode(null); }
            }}
          />
        ) : rowStyle === 'chip' && onToggle ? (
          <button type="button" onClick={onToggle} aria-pressed={applied}
            className="flex-1 flex items-center px-1 py-1 rounded-sm hover:bg-inset text-left min-w-0">
            {chip}
          </button>
        ) : (
          <span className="flex-1 flex items-center px-1 py-1 min-w-0">{chip}</span>
        )}
        <button
          type="button"
          aria-label={`More for ${tag.label}`}
          aria-haspopup="menu"
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.right - 4, y: r.bottom + 2 }); }}
          className="shrink-0 w-6 h-6 rounded-sm flex items-center justify-center text-fg-muted hover:bg-inset hover:text-fg transition-colors"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
          </svg>
        </button>
        {rowStyle === 'switch' && onToggle && (
          <Toggle checked={!!applied} onChange={onToggle} aria-label={tag.label} />
        )}
      </div>

      {mode === 'colour' && (
        <div className="flex flex-wrap gap-1.5 px-1 pt-1 pb-1.5" role="radiogroup" aria-label={`Colour for ${tag.label}`}>
          {TAG_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={tag.color === c}
              onClick={() => { registry.update(tag.id, { color: c as TagColor }); setMode(null); }}
              className={`w-4 h-4 rounded-full border ${tag.color === c ? 'ring-2 ring-offset-1 ring-offset-inset ring-fg-dim' : ''}`}
              style={{ backgroundColor: `var(--${c})`, borderColor: `var(--${c})` }}
              aria-label={c.replace('tag-', '')}
            />
          ))}
        </div>
      )}

      {mode === 'delete' && (
        // The guide's destructive confirm: one line saying what happens, the red
        // button where the main action goes, Cancel beside it.
        <div className="flex items-center gap-2 px-1 pt-1 pb-1.5">
          <span className="flex-1 text-3xs text-fg-muted">Delete “{tag.label}” from every conversation?</span>
          <Button size="sm" variant="secondary" onClick={() => setMode(null)}>Cancel</Button>
          <Button size="sm" variant="danger" onClick={() => registry.remove(tag.id)}>Delete</Button>
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          entries={[
            { type: 'item', id: 'rename', label: 'Rename', icon: 'rename', run: () => setMode('rename') },
            { type: 'item', id: 'colour', label: 'Change colour', icon: 'colour', run: () => setMode('colour') },
            { type: 'item', id: 'archive', label: tag.archived ? 'Unarchive' : 'Archive', icon: 'archive',
              run: () => registry.update(tag.id, { archived: !tag.archived }) },
            { type: 'sep' },
            { type: 'item', id: 'delete', label: 'Delete…', icon: 'delete', run: () => setMode('delete') },
          ]}
        />
      )}
    </div>
  );
}
