// src/renderer/components/tags/TagChip.tsx
import { useState } from 'react';
import type { TagRecord } from '../../../shared/tags';
import { tagColorCss } from '../../../shared/tags';

// A tag, drawn in the session status pill's shape (SessionStrip StatusPill: rounded, a
// light tint, 4xs text), with a filled tag icon in the tag's colour where the status
// dot sits. WHY (pick-menus-5…7, Destin 2026-10-02): the square tinted box, a dot, a
// tinted pill and an outline were tried; he picked "tag icon in something more like the
// working chip" with "filled icons".
// WHY the word stays the theme's text colour: the tag colour lives in the icon, tint and
// border, never the word — the tag palette is fixed across themes, and coloured words
// were hard to read on the pale ones (2026-09-17).
// WHY the colour is blended with --fg first: the --tag-* slots (and any colour the user
// picked) are one value for every theme; a quarter of the theme's text colour lifts them
// on dark themes and deepens them on pale ones.

/** A tag's × / + as a small round button (session-details-1#SD1-1: "make the plus/x
 *  buttons a bit more prominent/button-y"): a disc in the border colour, stronger on hover. */
export function ChipAction({ kind, label, onClick, size = 'sm' }: { kind: 'remove' | 'add'; label: string; onClick: () => void; size?: 'sm' | 'md' }) {
  return (
    <button type="button" aria-label={`${kind === 'remove' ? 'Remove' : 'Add'} ${label}`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`${size === 'md' ? 'w-4 h-4' : 'w-3.5 h-3.5'} -mr-0.5 shrink-0 inline-flex items-center justify-center rounded-full text-fg-2 hover:text-fg bg-edge-dim hover:bg-edge transition-colors`}>
      <svg viewBox="0 0 12 12" className="w-2 h-2" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" aria-hidden>
        {kind === 'remove' ? <path d="M3 3l6 6M9 3l-6 6" /> : <path d="M6 2.5v7M2.5 6h7" />}
      </svg>
    </button>
  );
}

/** Centre an all-lowercase word on its lowercase letters; any word with a capital on its
 *  capitals — a capital poking above the centred lowercase looked high ("Follow-Up
 *  Needed", checked at 1.5×). globals.css → Tag label. */
export const tagLabelClass = (label: string) => (/\p{Lu}/u.test(label) ? 'tag-label-caps' : 'tag-label');

// The icon slot in every tag pill (centred; the word beside it is trimmed — .tag-label).
export const TAG_ICON = 'flex shrink-0';

export const mix = (color: string) => `color-mix(in srgb, ${tagColorCss(color)} 75%, var(--fg))`;

export function TagChip({ tag, onRemove, onAdd, dim = false, archivedLook = false, className = '' }: {
  tag: Pick<TagRecord, 'label' | 'color'>;
  /** A "×" at the right: take this tag off the session. */
  onRemove?: () => void;
  /** A "+" at the right: the tag isn't on this session yet (pick-menus-8#PM8-1). */
  onAdd?: () => void;
  /** Faint and dashed: a tag that is not on this session. */
  dim?: boolean;
  /** An archived tag: grey all over, no colour (pick-menus-13#PM13-2). */
  archivedLook?: boolean;
  className?: string;
}) {
  const c = mix(tag.color);
  const action = onRemove ? <ChipAction kind="remove" label={tag.label} onClick={onRemove} />
    : onAdd ? <ChipAction kind="add" label={tag.label} onClick={onAdd} /> : null;

  if (archivedLook) {
    return (
      <span className={`shrink-0 inline-flex items-center gap-1 pl-1 pr-1.5 py-0.25 rounded-full border border-edge-dim bg-inset text-4xs leading-none text-fg-muted opacity-70 ${className}`}>
        <span className={`${TAG_ICON} text-fg-faint`}><FilledTag className="w-3 h-3" /></span>
        <span className={tagLabelClass(tag.label)}>{tag.label}</span>{action}
      </span>
    );
  }
  return (
    <span className={`shrink-0 inline-flex items-center gap-1 pl-1 pr-1.5 py-0.25 rounded-full border text-4xs leading-none ${dim ? 'text-fg-muted border-dashed' : 'text-fg-2'} ${className}`}
      style={{ backgroundColor: dim ? 'transparent' : `color-mix(in srgb, ${c} 15%, transparent)`, borderColor: `color-mix(in srgb, ${c} ${dim ? 40 : 30}%, transparent)` }}>
      <span className={TAG_ICON} style={{ color: c }}><FilledTag className="w-3 h-3" /></span>
      <span className={tagLabelClass(tag.label)}>{tag.label}</span>{action}
    </span>
  );
}

/** A solid tag on its corner, mirrored like glyphs.tsx's TagGlyph so the point aims back
 *  into the content (the level tag tried in session-details-3 was rejected: "the old tag
 *  icon was better"), with its outline in the panel colour, as before. */
export function FilledTag({ className = '', ring = true }: { className?: string; ring?: boolean }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden>
      <g transform="translate(24,0) scale(-1,1)">
        <path fillRule="evenodd"
          d="M3 12.5V4.5A1.5 1.5 0 014.5 3h8l8.5 8.5a1.5 1.5 0 010 2.1l-6.9 6.9a1.5 1.5 0 01-2.1 0L3 12.5z M6.15 7.75a1.6 1.6 0 103.2 0a1.6 1.6 0 10-3.2 0z"
          fill="currentColor" stroke={ring ? 'var(--panel)' : 'none'} strokeWidth={ring ? 2.5 : 0} strokeLinejoin="round" />
      </g>
    </svg>
  );
}

/** The session's tag icons, stacked close and overlapping, each in its tag's colour
 *  (pick-menus-6#PM6-2, -7#PM7-1: "stacked tags of the relevant colors", "closer
 *  together, no count needed"). */
export function TagIconStack({ tags, className = '' }: { tags: Pick<TagRecord, 'label' | 'color'>[]; className?: string }) {
  return (
    <span className={`inline-flex items-center ${className}`} aria-hidden>
      {tags.map((t, i) => (
        <span key={i} className={`flex ${i ? '-ml-2' : ''}`} style={{ color: mix(t.color), zIndex: tags.length - i }}>
          <FilledTag className="w-3.5 h-3.5" />
        </span>
      ))}
    </span>
  );
}

/** Three or more tags: one small button of stacked tag icons that rolls out into the full
 *  tags while pointed at, focused, or tapped (pick-menus-6#PM6-1: "3+ tags should collapse
 *  into a single hover sensitive button ... then rolled out on hover"). */
export function TagStack({ tags }: { tags: Pick<TagRecord, 'label' | 'color'>[] }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={`${tags.length} tags: ${tags.map((t) => t.label).join(', ')}`}
      aria-expanded={open}
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
      onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      className="shrink-0 inline-flex items-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {open ? (
        <span className="inline-flex items-center gap-1">
          {tags.map((t, i) => <TagChip key={i} tag={t} />)}
        </span>
      ) : (
        <span className="inline-flex items-center px-1 py-0.25 rounded-full border border-edge-dim bg-inset">
          <TagIconStack tags={tags} />
        </span>
      )}
    </span>
  );
}
