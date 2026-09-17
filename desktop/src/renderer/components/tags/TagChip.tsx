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
export function TagChip({ tag, onRemove, className = '' }: {
  tag: Pick<TagRecord, 'label' | 'color'>;
  onRemove?: () => void;
  className?: string;
}) {
  const c = `color-mix(in srgb, var(--${tag.color}) 75%, var(--fg))`;
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
