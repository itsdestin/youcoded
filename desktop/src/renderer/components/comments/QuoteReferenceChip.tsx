// QuoteReferenceChip — same card family as AttachmentChip.tsx (Destin's
// approved 128x96 shape: preview on top, a label strip along the bottom, the
// remover ALWAYS visible top-right, never hover-only). This is the "attached
// reference" the redesigned "Ask about this" produces: a quoted snippet +
// its source, sitting above the composer instead of dumped into the textarea
// (spec: "must NOT put quoted text into the typing box"). The same chip,
// without a remover, is how a sent message shows what it referenced on the
// user's own bubble (UserMessage.tsx) — one look for "attached", composing
// or already sent.
import React from 'react';
import { Button } from '../ui/Button';

interface Props {
  quote: string;
  sourceLabel: string;
  /** A comment's own note text — shown under the quote when this chip is
   *  standing in for a held margin comment (the "Send to assistant" batch). */
  note?: string;
  onRemove?: () => void;
}

export function QuoteReferenceChip({ quote, sourceLabel, note, onRemove }: Props) {
  return (
    <div
      title={quote}
      className="relative shrink-0 w-44 rounded-md border border-edge bg-panel overflow-hidden flex flex-col"
    >
      <div className="flex-1 min-h-[52px] bg-inset px-2.5 py-2">
        <p className="text-2xs text-fg-2 italic leading-snug line-clamp-3">&ldquo;{quote}&rdquo;</p>
        {note && <p className="mt-1 text-3xs text-fg-muted leading-snug line-clamp-2">{note}</p>}
      </div>
      <div className="flex items-center px-1.5 h-5 border-t border-edge bg-panel text-fg-dim text-3xs shrink-0">
        <span className="truncate min-w-0">{sourceLabel}</span>
      </div>
      {onRemove && (
        // Same geometry/variant as AttachmentChip's remover — one look for
        // "remove what's attached", file or reference.
        <Button
          variant="raised"
          size="icon-xs"
          aria-label="Remove reference"
          onClick={onRemove}
          className="absolute top-1 right-1"
        >
          ×
        </Button>
      )}
    </div>
  );
}
