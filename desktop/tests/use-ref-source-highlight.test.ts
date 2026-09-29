// @vitest-environment jsdom
// F3 (T7 review): the sent Ask Your Assistant summary chip ("N comments ·
// file") stopped highlighting anything on hover once compose-ref.ts's wire
// format changed — a decoded summary chip carries no `commentIds` at all
// (§6.2's own reasoning: the comments reach the assistant through its comment
// tools, not the chip), so `rangeFor`'s existing `commentIds`-based branch
// never matched it. The fix recognises the summary chip's SHAPE
// (`isSummaryChipRef`) and recovers "every currently open comment on this
// path" from the live store instead of from the (deliberately id-less) wire
// text.
import { describe, it, expect } from 'vitest';
import { rangeFor } from '../src/renderer/components/comments/use-ref-source-highlight';
import { addComment, resolveComment } from '../src/renderer/state/doc-comments-store';
import { genRefId, type ComposeRef } from '../src/renderer/components/context-menu/compose-ref';

function container(text: string): HTMLElement {
  const el = document.createElement('div');
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}

/** The exact shape `decodeRefPayload` produces for a summary chip — no
 *  quote/commentId/commentIds/cell/lineRange, just a path and label. */
function summaryChipRef(path: string, fileName: string, count: number): ComposeRef {
  return {
    id: genRefId(), kind: 'doc', path, fileName,
    label: `${count} ${count === 1 ? 'comment' : 'comments'} · ${fileName}`,
  };
}

describe('a decoded summary-chip reference highlights every currently open comment', () => {
  it('returns one range per open comment and skips resolved ones', () => {
    const path = 'test-fixtures/f3-hover-open.md';
    addComment(path, 'first open quote', path);
    addComment(path, 'second open quote', path);
    const resolvedId = addComment(path, 'a resolved quote', path);
    resolveComment(resolvedId, 'user');

    const root = container('first open quote — second open quote — a resolved quote');
    const ref = summaryChipRef(path, 'f3-hover-open.md', 3);
    const result = rangeFor(root, ref);

    expect(Array.isArray(result)).toBe(true);
    const ranges = result as Range[];
    expect(ranges).toHaveLength(2);
    expect(ranges.map((r) => r.toString())).toEqual(['first open quote', 'second open quote']);
  });

  it('a summary chip for a path with nothing open highlights nothing', () => {
    const path = 'test-fixtures/f3-hover-all-resolved.md';
    const id = addComment(path, 'only quote', path);
    resolveComment(id, 'user');

    const root = container('only quote is here');
    const ref = summaryChipRef(path, 'f3-hover-all-resolved.md', 1);
    expect(rangeFor(root, ref)).toBeNull();
  });

  it('does not treat an ordinary ephemeral doc-quote reference as a summary chip', () => {
    // An "Ask about this" ref always carries a quote — `isSummaryChipRef`
    // must not misfire on it and substitute the store's comments instead of
    // the ref's own quote.
    const root = container('the real quoted sentence sits here');
    const ref: ComposeRef = {
      id: genRefId(), kind: 'doc', path: 'docs/notes.md', fileName: 'notes.md',
      quote: 'the real quoted sentence', label: '“the real quoted sentence”',
    };
    const result = rangeFor(root, ref);
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(false);
    expect((result as Range).toString()).toBe('the real quoted sentence');
  });
});
