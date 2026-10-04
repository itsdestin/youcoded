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

// WHY 1px down: measured 2026-10-04 at 8× zoom, the app's monospace font sets lowercase
// words about a pixel below the middle of their line, so a truly centred icon sat that
// much above "work". Measured centres after: icon 31.9, word 32.0, pill 31.9 (px).
export const TAG_ICON = 'flex shrink-0 translate-y-px';

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
        {tag.label}{action}
      </span>
    );
  }
  return (
    <span className={`shrink-0 inline-flex items-center gap-1 pl-1 pr-1.5 py-0.25 rounded-full border text-4xs leading-none ${dim ? 'text-fg-muted border-dashed' : 'text-fg-2'} ${className}`}
      style={{ backgroundColor: dim ? 'transparent' : `color-mix(in srgb, ${c} 15%, transparent)`, borderColor: `color-mix(in srgb, ${c} ${dim ? 40 : 30}%, transparent)` }}>
      <span className={TAG_ICON} style={{ color: c }}><FilledTag className="w-3 h-3" /></span>
      {tag.label}{action}
    </span>
  );
}

/** A solid tag lying level, point to the left, hole cut through (it shows whatever is
 *  behind). WHY level (session-details-2#SD2-1, -3: "text/icon centering ... still weird"):
 *  the earlier tag stood on its corner, its weight in the top-left, so even centred it read
 *  as riding above the word; a level tag is symmetric top to bottom, like the status dot.
 *  `ring` adds an outline in the panel colour — only for stacks, where tags overlap. */
export function FilledTag({ className = '', ring = false }: { className?: string; ring?: boolean }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden>
      <path fillRule="evenodd"
        d="M2.5 12L7.6 6.4A1.5 1.5 0 018.7 5.9H20A1.5 1.5 0 0121.5 7.4V16.6A1.5 1.5 0 0120 18.1H8.7A1.5 1.5 0 017.6 17.6Z M9.2 12a1.5 1.5 0 103 0a1.5 1.5 0 10-3 0Z"
        fill="currentColor" stroke={ring ? 'var(--panel)' : 'none'} strokeWidth={ring ? 2.5 : 0} strokeLinejoin="round" />
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
          <FilledTag className="w-3.5 h-3.5" ring />
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
