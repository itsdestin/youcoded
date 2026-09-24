// Shared by CommentsMargin (Comments mode) and ReadingHighlights (Reading
// mode) — round 2 (Destin) made highlighting the PRIMARY way a comment shows
// (margin/markers moved into a distinct, opt-in "Comments mode"), so the
// mark-wrapping logic that used to live only inside CommentsMargin.tsx now
// needs to run for whichever mode is actually mounted. The two modes are
// mutually exclusive (ActiveArtifactView renders exactly one), so each
// simply calls this hook independently — never both at once, so there is no
// double-wrap risk to guard against.
import { useLayoutEffect, useState, type RefObject } from 'react';
import type { DocComment } from '../../state/doc-comments-store';

const MARK_ATTR = 'data-comment-mark';
// Soft accent tint (G-8 reads this as the "selected span" case — the same
// bg-accent/10-15 family FolderSwitcher and SettingsPanel already use for an
// active row) — an OPEN comment's anchor; resolved fades to neutral, matching
// the resolved card's own faded state.
const MARK_OPEN = 'bg-accent/15 hover:bg-accent/25 rounded-sm cursor-pointer transition-colors';
const MARK_RESOLVED = 'bg-fg-muted/10 text-fg-muted rounded-sm cursor-pointer';
// Exported: both CommentsMargin (Comments mode) and ReadingHighlights
// (Reading mode) toggle these on the SAME mark elements when linking a
// highlight to its card/hover-card, so the active look must be one constant.
export const ACTIVE_CLASSES = ['ring-2', 'ring-accent/60'];

/**
 * Wraps each visible comment's quote text in a `<mark>` inside `container`,
 * best-effort first-occurrence matching — the same caveat build-menu.ts's
 * describeArtifactSelection documents for source citing: a quote that recurs
 * earlier in the document, or that crosses an inline-formatting boundary,
 * may miss or land on the wrong occurrence. The card/hover-card still
 * renders either way; only the in-text highlight and vertical alignment
 * (Comments mode's margin) depend on it.
 */
export function useQuoteMarks(
  containerRef: RefObject<HTMLElement | null>,
  comments: DocComment[],
): Map<string, HTMLElement> {
  const [marks, setMarks] = useState<Map<string, HTMLElement>>(new Map());
  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) {
      setMarks(new Map());
      return;
    }
    // Undo the previous pass's marks first so re-highlighting never nests
    // <mark>s inside <mark>s as comments/content change.
    root.querySelectorAll(`[${MARK_ATTR}]`).forEach((el) => {
      el.replaceWith(document.createTextNode(el.textContent ?? ''));
    });
    root.normalize();
    const found = new Map<string, HTMLElement>();
    for (const c of comments) {
      const quote = c.quote.trim();
      if (!quote) continue;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? '';
        const idx = text.indexOf(quote);
        if (idx === -1) continue;
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + quote.length);
        const mark = document.createElement('mark');
        mark.setAttribute(MARK_ATTR, '');
        mark.setAttribute('data-comment-id', c.id);
        mark.className = c.resolved ? MARK_RESOLVED : MARK_OPEN;
        try {
          range.surroundContents(mark);
          found.set(c.id, mark);
        } catch {
          // Selection crosses an element boundary (bold/link mid-quote) —
          // skip the highlight; the card still renders in the margin/hover-card.
        }
        break;
      }
    }
    setMarks(found);
  }, [containerRef, comments]);
  return marks;
}
