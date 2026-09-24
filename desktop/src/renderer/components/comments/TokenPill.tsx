// The reference-token pill — the one visual for a ComposeRef everywhere it
// appears: inside the composer's mirror layer (InputBar.tsx, drawn over an
// invisible plain-text marker), and in a SENT bubble (UserMessage.tsx), so a
// reference reads identically before and after sending. Ported from the
// "inline & conversational" mockup (Style C) at Destin's direction (round 2).
//
// G-14 (design guide): a tag/badge is `sm` radius with neutral text — this is
// a reference tag, not a call-to-action, so it stays neutral (bg-well, not
// bg-accent) even though it is clickable.
import React from 'react';
import type { ComposeRef } from '../context-menu/compose-ref';

interface Props {
  ref_: ComposeRef;
  /** Composer only — renders a small × that removes the whole token. */
  onRemove?: () => void;
  /** Doc-kind refs: jump to the referenced span if that file is open. */
  onJump?: (ref: ComposeRef) => void;
  /** The sent user bubble is bg-accent — the default neutral pill (tuned for
   *  a panel background) would sit at low contrast on it, same reasoning as
   *  Button's 'on-accent' variant (a control sitting ON an accent fill). */
  tone?: 'default' | 'on-accent';
}

export function TokenPill({ ref_, onRemove, onJump, tone = 'default' }: Props) {
  const clickable = ref_.kind === 'doc' && !!onJump;
  return (
    <span
      className={`input-bar-ref-pill inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs
        leading-none align-middle whitespace-nowrap select-none ${tone === 'on-accent'
          ? 'border border-on-accent/30 bg-on-accent/15 text-on-accent'
          : 'border border-edge bg-well text-fg-2'}`}
      // Decorative in the mirror layer (aria-hidden ancestor); real content in
      // a sent bubble, where this span IS the accessible text.
      title={ref_.fileName ? `${ref_.label} · ${ref_.fileName}` : ref_.label}
      onClick={clickable ? () => onJump?.(ref_) : undefined}
      style={clickable ? { pointerEvents: 'auto', cursor: 'pointer' } : undefined}
    >
      {ref_.label}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove reference ${ref_.label}`}
          className="-mr-0.5 text-fg-muted hover:text-fg leading-none"
          style={{ pointerEvents: 'auto' }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
        >
          ×
        </button>
      )}
    </span>
  );
}
