// The reference-token pill — the one visual for a ComposeRef everywhere it
// appears: inside the composer's mirror layer (InputBar.tsx, drawn over an
// invisible plain-text marker), and in a SENT bubble (UserMessage.tsx), so a
// reference reads identically before and after sending. Ported from the
// "inline & conversational" mockup (Style C) at Destin's direction (round 2).
//
// G-14 (design guide): a tag/badge is `sm` radius with neutral text — this is
// a reference tag, not a call-to-action, so it stays neutral even though it
// is clickable.
//
// Round 3 (polish pass): the flat `bg-well` fill plus a text-only label with
// no glyph read as "a grey monospace tag", not a reference — a small
// message/file icon plus a subtle ACCENT tint (still neutral text, per G-14)
// fixes that without inventing a fourth chip shape. On the sent user bubble
// (`tone="on-accent"`) the translucent on-accent wash could go low-contrast
// on a pale theme accent; this now borrows Button's `raised` idea instead — a
// solid PANEL fill reads on any accent color in every theme, the same reason
// an attachment-thumbnail's × button uses it.
import React from 'react';
import type { ComposeRef } from '../context-menu/compose-ref';
import { MenuIcon } from '../context-menu/menu-icons';

interface Props {
  ref_: ComposeRef;
  /** Composer only — renders a small × that removes the whole token. */
  onRemove?: () => void;
  /** Doc-kind refs: jump to the referenced span if that file is open. */
  onJump?: (ref: ComposeRef) => void;
  /** The sent user bubble is bg-accent — see the file WHY for why this tone
   *  is a solid panel fill, not a translucent accent wash. */
  tone?: 'default' | 'on-accent';
}

export function TokenPill({ ref_, onRemove, onJump, tone = 'default' }: Props) {
  const clickable = ref_.kind === 'doc' && !!onJump;
  return (
    <span
      className={`input-bar-ref-pill inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs
        leading-none align-baseline whitespace-nowrap select-none ${tone === 'on-accent'
          ? 'border border-edge bg-panel text-fg-2'
          : 'border border-edge bg-accent/10 text-fg-2'}`}
      // Decorative in the mirror layer (aria-hidden ancestor); real content in
      // a sent bubble, where this span IS the accessible text.
      title={ref_.fileName ? `${ref_.label} · ${ref_.fileName}` : ref_.label}
      onClick={clickable ? () => onJump?.(ref_) : undefined}
      style={clickable ? { pointerEvents: 'auto', cursor: 'pointer' } : undefined}
    >
      {/* A chat-origin ref reads as a message; a doc-origin one as a file —
          reusing the context-menu's own icon set (it's already the app's
          icon language, just previously fixed at menu-row size). */}
      <MenuIcon name={ref_.kind === 'doc' ? 'path' : 'comment'} className="w-3 h-3 shrink-0 text-fg-muted" />
      <span className="truncate max-w-40">{ref_.label}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove reference ${ref_.label}`}
          className="-mr-0.5 text-fg-muted hover:text-fg leading-none shrink-0"
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
