// The reference-token pill in a SENT bubble (UserMessage.tsx). The composer
// draws its twin, DraftChip (InputBar.tsx), so a reference reads identically
// before and after sending. Ported from the
// "inline & conversational" mockup (Style C) at Destin's direction (round 2).
//
// G-14 (design guide): a tag/badge is `sm` radius with neutral text — this is
// a reference tag, not a call-to-action, so it stays neutral even though it
// is clickable.
//
// (Earlier rounds' icon + bordered-box styling was replaced below.)
//
// 2026-09-24 (Destin: "the chip itself is also just styled a little
// strangely… not a huge fan of the icon"): no icon, no border-box padding —
// the same chip as the composer's DraftChip (InputBar.tsx), styled after the
// app's TagChip: a tinted fill with a stronger tinted edge and the text in
// the surrounding colour, at the surrounding text size, so a reference reads
// identically before and after sending. On the accent-coloured sent bubble
// the tint is taken from --on-accent (the bubble's own text colour), which
// stays readable on every theme's accent.
import type { ComposeRef } from '../context-menu/compose-ref';

interface Props {
  ref_: ComposeRef;
  /** Doc-kind refs: jump to the referenced span if that file is open. */
  onJump?: (ref: ComposeRef) => void;
  /** 'on-accent' inside the sent user bubble (bg-accent). */
  tone?: 'default' | 'on-accent';
}

export function TokenPill({ ref_, onJump, tone = 'default' }: Props) {
  const clickable = ref_.kind === 'doc' && !!onJump;
  const base = tone === 'on-accent' ? 'var(--on-accent)' : 'var(--accent)';
  return (
    <span
      className={`rounded-sm px-1 py-0.5 whitespace-nowrap select-none ${tone === 'on-accent' ? 'text-on-accent' : 'text-fg'}`}
      style={{
        backgroundColor: `color-mix(in srgb, ${base} 22%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${base} 50%, transparent)`,
        ...(clickable ? { cursor: 'pointer' } : null),
      }}
      title={ref_.fileName ? `${ref_.label} · ${ref_.fileName}` : ref_.label}
      onClick={clickable ? () => onJump?.(ref_) : undefined}
    >
      {ref_.label}
    </span>
  );
}
