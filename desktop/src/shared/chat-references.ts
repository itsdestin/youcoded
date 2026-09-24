// Doc comments / "Ask about this" (mockup, Style A "Margin"): the bracket
// token InputBar.tsx embeds at the front of a sent message's content for each
// attached quote reference, and the exact prefix UserMessage.tsx strips back
// out to redraw it as a QuoteReferenceChip instead of raw text. ONE format
// shared by both ends, the same way attachment-path prefixing already works.
export function referenceToken(sourceLabel: string): string {
  return `[[ref:${sourceLabel}]]`;
}
