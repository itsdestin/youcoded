// src/renderer/components/tags/TagChip.tsx
import type { TagRecord } from '../../../shared/tags';

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
const TAG_LOOK = 'box' as 'box' | 'dot' | 'pill' | 'outline';

export function TagChip({ tag, onRemove, className = '' }: {
  tag: Pick<TagRecord, 'label' | 'color'>;
  onRemove?: () => void;
  className?: string;
}) {
  const c = `color-mix(in srgb, var(--${tag.color}) 75%, var(--fg))`;
  // TRIAL (pick-menus-5): three other looks for a tag, everywhere tags show.
  if (TAG_LOOK !== 'box') {
    const remove = onRemove && (
      <button onClick={(e) => { e.stopPropagation(); onRemove(); }} className="opacity-60 hover:opacity-100 leading-none" aria-label={`Remove ${tag.label}`}>×</button>
    );
    if (TAG_LOOK === 'dot') {
      return (
        <span className={`inline-flex items-center gap-1 text-3xs leading-none text-fg-2 ${className}`}>
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: c }} />{tag.label}{remove}
        </span>
      );
    }
    const pill = TAG_LOOK === 'pill';
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-3xs leading-none border ${pill ? 'text-fg' : 'text-fg-2'} ${className}`}
        style={{
          backgroundColor: pill ? `color-mix(in srgb, ${c} 15%, transparent)` : 'transparent',
          borderColor: `color-mix(in srgb, ${c} ${pill ? 35 : 70}%, transparent)`,
        }}>
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
