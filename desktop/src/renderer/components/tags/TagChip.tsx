// src/renderer/components/tags/TagChip.tsx
import { useState } from 'react';
import type { TagRecord } from '../../../shared/tags';
import { TagGlyph } from './glyphs';

// A colored, plain-word tag chip (no status glyphs — per user preference). The
// color is a slot key (e.g. 'tag-blue') → var(--tag-blue).
// WHY the word is the theme's text colour (2026-09-17): the chip reads like the
// session status pill (SessionStrip.tsx StatusPill, design guide G-26) — the tag
// colour lives in the fill and border, never the word. The tag palette is fixed
// across themes, so coloured words were hard to read on the pale ones, and the
// two chip kinds sat side by side looking unrelated.
// WHY the colour is blended with --fg first: the --tag-* slots are one palette
// for every theme. A quarter of the theme's text colour lifts them on dark
// themes and deepens them on pale ones, so every theme (community ones too —
// they all set --fg) gets a fitted shade. Fill and border are a step stronger
// than the status pill's, for contrast against the card behind.
// TRIAL: which tag look the pick-menus-5 deck shows.
const TAG_LOOK = 'status' as 'box' | 'dot' | 'pill' | 'outline' | 'outline-icon' | 'outline-icon-neutral' | 'status';

export function TagChip({ tag, onRemove, onAdd, dim = false, className = '' }: {
  tag: Pick<TagRecord, 'label' | 'color'>;
  onRemove?: () => void;
  /** A "+" at the right instead of "×" — the tag isn't on this session yet
   *  (pick-menus-8#PM8-1: "keep x/+ on the right side of each tag pill"). */
  onAdd?: () => void;
  /** Faint: a tag that is not on this session. */
  dim?: boolean;
  className?: string;
}) {
  const c = `color-mix(in srgb, var(--${tag.color}) 75%, var(--fg))`;
  // TRIAL (pick-menus-5): three other looks for a tag, everywhere tags show.
  if (TAG_LOOK !== 'box') {
    const remove = onRemove && (
      <button onClick={(e) => { e.stopPropagation(); onRemove(); }} className="opacity-60 hover:opacity-100 leading-none" aria-label={`Remove ${tag.label}`}>×</button>
    ) || onAdd && (
      <button onClick={(e) => { e.stopPropagation(); onAdd(); }} className="opacity-60 hover:opacity-100 leading-none" aria-label={`Add ${tag.label}`}>+</button>
    );
    if (TAG_LOOK === 'status') {
      // The session status pill's shape (SessionStrip StatusPill: rounded, light tint,
      // 4xs text), with a tag icon in the tag's colour where the status dot sits
      // (pick-menus-6#PM6-1: "tag icon in something more like the working chip").
      return (
        <span className={`shrink-0 inline-flex items-center gap-1 pl-1 pr-1.5 py-[1px] rounded-full border text-4xs leading-none ${dim ? 'text-fg-muted border-dashed' : 'text-fg-2'} ${className}`}
          style={{ backgroundColor: dim ? 'transparent' : `color-mix(in srgb, ${c} 15%, transparent)`, borderColor: `color-mix(in srgb, ${c} ${dim ? 40 : 30}%, transparent)` }}>
          {/* Filled icon (pick-menus-7#PM7-1: "want filled icons on the expanded cards"). */}
          <span className="flex shrink-0" style={{ color: c }}><FilledTag className="w-3 h-3" /></span>
          {tag.label}{remove}
        </span>
      );
    }
    if (TAG_LOOK === 'dot') {
      return (
        <span className={`inline-flex items-center gap-1 text-3xs leading-none text-fg-2 ${className}`}>
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: c }} />{tag.label}{remove}
        </span>
      );
    }
    const pill = TAG_LOOK === 'pill';
    const icon = TAG_LOOK === 'outline-icon' || TAG_LOOK === 'outline-icon-neutral';
    const neutral = TAG_LOOK === 'outline-icon-neutral';
    return (
      <span className={`inline-flex items-center gap-1 ${icon ? 'pl-1.5 pr-2' : 'px-2'} py-0.5 rounded-full text-3xs leading-none border ${pill ? 'text-fg' : 'text-fg-2'} ${neutral ? 'border-edge' : ''} ${className}`}
        style={{
          backgroundColor: pill ? `color-mix(in srgb, ${c} 15%, transparent)` : 'transparent',
          ...(neutral ? {} : { borderColor: `color-mix(in srgb, ${c} ${pill ? 35 : 70}%, transparent)` }),
        }}>
        {icon && <span className="shrink-0 flex" style={{ color: c }}><TagGlyph className="w-2.5 h-2.5" /></span>}
        {tag.label}{remove}
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-[1px] rounded-sm text-3xs leading-none text-fg border ${className}`}
      style={{
        backgroundColor: `color-mix(in srgb, ${c} 24%, transparent)`,
        borderColor: `color-mix(in srgb, ${c} 55%, transparent)`,
      }}
    >
      {tag.label}
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="opacity-60 hover:opacity-100 leading-none"
          aria-label={`Remove ${tag.label}`}
        >×</button>
      )}
    </span>
  );
}

/** "+N" for the tags past the first few (pick-menus-5#PM5-1: "try collapsing if a lot
 *  of tags"). A neutral outline pill so it reads as a count, not another tag. */
export function MoreTagsChip({ names, className = '' }: { names: string[]; className?: string }) {
  if (names.length === 0) return null;
  return (
    <span title={names.join(', ')} className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-3xs leading-none border border-edge text-fg-muted ${className}`}>
      +{names.length}
    </span>
  );
}


/** A solid tag with a ring in the panel colour, so overlapped tags stay apart. */
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

const tagColour = (color: string) => `color-mix(in srgb, var(--${color}) 75%, var(--fg))`;

/** The session's tag icons, stacked and overlapping, each in its tag's colour
 *  (pick-menus-6#PM6-2: "stacked tags of the relevant colors for that session"). */
export function TagIconStack({ tags, className = '' }: { tags: Pick<TagRecord, 'label' | 'color'>[]; className?: string }) {
  return (
    <span className={`inline-flex items-center ${className}`} aria-hidden>
      {tags.map((t, i) => (
        <span key={i} className={`flex ${i ? '-ml-2' : ''}`} style={{ color: tagColour(t.color), zIndex: tags.length - i }}>
          <FilledTag className="w-3.5 h-3.5" />
        </span>
      ))}
    </span>
  );
}

/** Three or more tags: one small button of stacked tag icons that rolls out into the
 *  full tag pills while pointed at (or focused, or tapped on touch). WHY (pick-menus-6
 *  #PM6-1): "3+ tags should collapse into a single hover sensitive button that has the
 *  different colored tags visible stacked together, then rolled out on hover." */
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
        <span className="inline-flex items-center px-1 py-[1px] rounded-full border border-edge-dim bg-inset text-4xs leading-none text-fg-2">
          <TagIconStack tags={tags} />
        </span>
      )}
    </span>
  );
}
