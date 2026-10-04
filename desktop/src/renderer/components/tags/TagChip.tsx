// src/renderer/components/tags/TagChip.tsx
import React, { useState } from 'react';
import './TagChip.css';
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
// Disc sizes leave 2-4 px of the pill showing above and below it (session-details-final
// #SF-1: "the outer container of the + button is a bit too big. overlaps almost with edge
// of the tag pill"): xs for the 15 px list pill, sm for the 18 px one, md for the 26 px one.
// The pill's right padding drops to 4 px beside a button (resume-sheet-1#RS-1: "slightly
// to the right within the pill for the plus/unselected pills").
const DISC = { xs: 'w-2.5 h-2.5', sm: 'w-3 h-3', md: 'w-4 h-4' } as const;
export function ChipAction({ kind, label, onClick, size = 'sm' }: { kind: 'remove' | 'add'; label: string; onClick: () => void; size?: keyof typeof DISC }) {
  return (
    <button type="button" aria-label={`${kind === 'remove' ? 'Remove' : 'Add'} ${label}`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`${DISC[size]} shrink-0 inline-flex items-center justify-center rounded-full text-fg-2 hover:text-fg bg-edge-dim hover:bg-edge transition-colors`}>
      <svg viewBox="0 0 12 12" className={size === 'md' ? 'w-2 h-2' : 'w-1.5 h-1.5'} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" aria-hidden>
        {kind === 'remove' ? <path d="M3 3l6 6M9 3l-6 6" /> : <path d="M6 2.5v7M2.5 6h7" />}
      </svg>
    </button>
  );
}

/** A tag's icon and word as ONE line of text. WHY one line (session-details-4#SD4-2: "the
 *  text still appears visibly lower than the tag in the work chip, despite seeming fine on
 *  the bug and idea chips"): at Destin's 1.5× scale, an icon and a word laid out side by side
 *  are each rounded to the screen's pixels on their own, so some rows came out a pixel apart.
 *  Inside one line they round together. The line is trimmed to the word's lowercase letters
 *  (or its capitals, when it has any) and the icon sits on that same middle —
 *  TagChip.css. */
export function TagWord({ label, size, iconClass = '', iconStyle }: { label: string; size: 12 | 14 | 16; iconClass?: string; iconStyle?: React.CSSProperties }) {
  const caps = /\p{Lu}/u.test(label);
  return (
    <span className={`tag-line ${caps ? 'tag-line--caps' : ''}`} style={{ '--tag-ico': `${size}px` } as React.CSSProperties}>
      <span className={`tag-ico ${iconClass}`} style={iconStyle}><FilledTag className="block w-full h-full" /></span>
      {label}
    </span>
  );
}

export const mix = (color: string) => `color-mix(in srgb, ${tagColorCss(color)} 75%, var(--fg))`;

// WHY a fixed height (h-3.75, the 15 px these pills always measured): the word's line is
// trimmed to its letters (TagWord), so it no longer props the pill open by itself.
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
  const action = onRemove ? <ChipAction kind="remove" label={tag.label} onClick={onRemove} size="xs" />
    : onAdd ? <ChipAction kind="add" label={tag.label} onClick={onAdd} size="xs" /> : null;

  if (archivedLook) {
    return (
      <span className={`shrink-0 inline-flex items-center gap-1 pl-1 ${action ? 'pr-1' : 'pr-1.5'} h-3.75 rounded-full border border-edge-dim bg-inset text-4xs leading-none text-fg-muted opacity-70 ${className}`}>
        <TagWord label={tag.label} size={12} iconClass="text-fg-faint" />{action}
      </span>
    );
  }
  return (
    <span className={`shrink-0 inline-flex items-center gap-1 pl-1 ${action ? 'pr-1' : 'pr-1.5'} h-3.75 rounded-full border text-4xs leading-none ${dim ? 'text-fg-muted border-dashed' : 'text-fg-2'} ${className}`}
      style={{ backgroundColor: dim ? 'transparent' : `color-mix(in srgb, ${c} 15%, transparent)`, borderColor: `color-mix(in srgb, ${c} ${dim ? 40 : 30}%, transparent)` }}>
      <TagWord label={tag.label} size={12} iconStyle={{ color: c }} />{action}
    </span>
  );
}

/** A solid tag with a ring in the panel colour, so stacked tags stay apart. Mirrored like
 *  glyphs.tsx's TagGlyph, so the point aims back into the content. */
function FilledTag({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden>
      <g transform="translate(24,0) scale(-1,1)">
        <path d="M3 12.5V4.5A1.5 1.5 0 014.5 3h8l8.5 8.5a1.5 1.5 0 010 2.1l-6.9 6.9a1.5 1.5 0 01-2.1 0L3 12.5z"
          fill="currentColor" stroke="var(--panel)" strokeWidth={2.5} strokeLinejoin="round" />
        <circle cx="7.75" cy="7.75" r="1.6" fill="var(--panel)" />
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
