// @vitest-environment jsdom
// T14 of the doc-comments build (docs/active/specs/2026-09-26-doc-comments-
// build-design.md §2.2/§2.3): use-quote-marks.ts's highlight layer swapped
// from the mockup's own `findQuote` substring search onto the real
// `resolveSelector`, and now computes each comment's `status` ('anchored' /
// 'detached') at read time instead of leaving it forever `undefined`. These
// pins exercise exactly the scenarios the design calls out: a repeated
// phrase resolving to the SAVED copy (not always the first), moved text
// still anchoring, deleted text going detached without disappearing from the
// list, cell comments, and that a settled pass reaches a fixed point rather
// than re-marking forever.
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useQuoteMarks } from '../src/renderer/components/comments/use-quote-marks';
import {
  addComment,
  commentsForPath,
  __resetDocCommentsStoreForTest,
} from '../src/renderer/state/doc-comments-store';
import { quoteContextAt } from '../src/shared/doc-comments-anchor';

afterEach(() => {
  __resetDocCommentsStoreForTest();
  document.body.innerHTML = '';
});

function mountRoot(source: 'rendered' | 'raw' | 'sheet', fill: (root: HTMLElement) => void): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('data-artifact-source', source);
  fill(root);
  document.body.appendChild(root);
  return root;
}

describe('use-quote-marks — real anchoring (resolveSelector)', () => {
  it('a repeated phrase resolves to the exact copy it was saved from, not the first', () => {
    const path = 'test-fixtures/repeated.md';
    const fullText = 'first AAA here. second AAA here.';
    const secondStart = fullText.lastIndexOf('AAA');
    const ctx = quoteContextAt(fullText, secondStart, secondStart + 'AAA'.length);
    addComment(path, 'AAA', 'label', { prefix: ctx.prefix, suffix: ctx.suffix, occurrence: ctx.occurrence });

    const root = mountRoot('rendered', (r) => { r.textContent = fullText; });
    const containerRef = { current: root };

    const { result } = renderHook(() => useQuoteMarks(containerRef, commentsForPath(path)));

    expect(result.current.size).toBe(1);
    const segs = [...result.current.values()][0];
    expect(segs).toHaveLength(1);
    // The wrapped "AAA" is the SECOND copy: its preceding sibling text node
    // ends in "second ", not "first ".
    expect(segs[0].previousSibling?.textContent).toContain('second');
    expect(commentsForPath(path)[0].status).toBe('anchored');
  });

  it('text that moved elsewhere in the document still resolves (status stays anchored)', () => {
    const path = 'test-fixtures/moved.md';
    const original = 'Some intro. TARGET phrase in old spot. trailing.';
    const start = original.indexOf('TARGET phrase');
    const ctx = quoteContextAt(original, start, start + 'TARGET phrase'.length);
    addComment(path, 'TARGET phrase', 'label', { prefix: ctx.prefix, suffix: ctx.suffix, occurrence: ctx.occurrence });

    const moved = 'Totally different neighbors now. TARGET phrase in a new place, unrelated to before.';
    const root = mountRoot('rendered', (r) => { r.textContent = moved; });
    const containerRef = { current: root };

    const { result } = renderHook(() => useQuoteMarks(containerRef, commentsForPath(path)));

    expect(result.current.size).toBe(1);
    const seg = [...result.current.values()][0][0];
    expect(seg.textContent).toBe('TARGET phrase');
    expect(commentsForPath(path)[0].status).toBe('anchored');
  });

  it('deleted text resolves to detached, has no highlight, and stays in the list', () => {
    const path = 'test-fixtures/deleted.md';
    addComment(path, 'this text will be removed entirely', 'label', { prefix: '', suffix: '', occurrence: 0 });

    const root = mountRoot('rendered', (r) => { r.textContent = 'Completely different content now.'; });
    const containerRef = { current: root };

    const { result } = renderHook(() => useQuoteMarks(containerRef, commentsForPath(path)));

    expect(result.current.size).toBe(0); // no highlight
    expect(commentsForPath(path)).toHaveLength(1); // still listed (R6)
    expect(commentsForPath(path)[0].status).toBe('detached');
  });

  it('a "raw" plain-text viewer resolves against the <pre>, the same root build-menu.ts captured context from', () => {
    const path = 'test-fixtures/plain.txt';
    const fullText = 'alpha beta GAMMA delta';
    const start = fullText.indexOf('GAMMA');
    const ctx = quoteContextAt(fullText, start, start + 'GAMMA'.length);
    addComment(path, 'GAMMA', 'label', { prefix: ctx.prefix, suffix: ctx.suffix, occurrence: ctx.occurrence });

    const root = mountRoot('raw', (r) => {
      const pre = document.createElement('pre');
      pre.textContent = fullText;
      r.appendChild(pre);
    });
    const containerRef = { current: root };

    const { result } = renderHook(() => useQuoteMarks(containerRef, commentsForPath(path)));

    expect(result.current.size).toBe(1);
    expect(commentsForPath(path)[0].status).toBe('anchored');
  });

  it('a cell comment on the active sheet resolves as anchored', () => {
    const path = 'test-fixtures/sheet.xlsx';
    addComment(path, '42', 'label', { cell: 'C4', sheet: 'Q3' });

    const root = mountRoot('sheet', (r) => {
      r.innerHTML = '<div data-sheet="Q3"><table><tbody><tr><td data-cell="C4">42</td></tr></tbody></table></div>';
    });
    const containerRef = { current: root };

    const { result } = renderHook(() => useQuoteMarks(containerRef, commentsForPath(path)));

    expect(result.current.size).toBe(1);
    expect(commentsForPath(path)[0].status).toBe('anchored');
  });

  it('a cell comment whose cell was deleted from the active sheet resolves as detached', () => {
    const path = 'test-fixtures/sheet-deleted-cell.xlsx';
    addComment(path, '42', 'label', { cell: 'Z99', sheet: 'Q3' });

    const root = mountRoot('sheet', (r) => {
      r.innerHTML = '<div data-sheet="Q3"><table><tbody><tr><td data-cell="C4">42</td></tr></tbody></table></div>';
    });
    const containerRef = { current: root };

    const { result } = renderHook(() => useQuoteMarks(containerRef, commentsForPath(path)));

    expect(result.current.size).toBe(0);
    expect(commentsForPath(path)[0].status).toBe('detached');
  });

  it('a cell comment on a DIFFERENT (not currently active) sheet tab is left unjudged, not detached', () => {
    const path = 'test-fixtures/sheet-other-tab.xlsx';
    addComment(path, '99', 'label', { cell: 'B2', sheet: 'By rep' });

    // Only "Q3" is rendered right now — "By rep" isn't the active tab.
    const root = mountRoot('sheet', (r) => {
      r.innerHTML = '<div data-sheet="Q3"><table><tbody><tr><td data-cell="C4">42</td></tr></tbody></table></div>';
    });
    const containerRef = { current: root };

    renderHook(() => useQuoteMarks(containerRef, commentsForPath(path)));

    // No DOM evidence either way for a tab that isn't showing — status is
    // left alone (still undefined), never wrongly flipped to 'detached'.
    expect(commentsForPath(path)[0].status).toBeUndefined();
  });

  it('reaches a fixed point instead of re-marking on every settle pass', () => {
    const path = 'test-fixtures/storm.md';
    addComment(path, 'hello world', 'label', { prefix: '', suffix: '', occurrence: 0 });

    const root = mountRoot('rendered', (r) => { r.textContent = 'say hello world to everyone'; });
    const containerRef = { current: root };

    const { result, rerender } = renderHook(
      ({ comments }) => useQuoteMarks(containerRef, comments),
      { initialProps: { comments: commentsForPath(path) } },
    );
    expect(result.current.size).toBe(1);
    const settledStatus = commentsForPath(path)[0].status;
    expect(settledStatus).toBe('anchored');

    // Simulate the store handing down a FRESH array reference each render
    // (exactly what CommentsMargin/ReadingHighlights's own `visible` useMemo
    // does on every unrelated store change) — the pass must keep landing on
    // the SAME status and the SAME single highlight, never oscillate or grow.
    for (let i = 0; i < 5; i++) {
      rerender({ comments: commentsForPath(path) });
    }
    expect(commentsForPath(path)[0].status).toBe(settledStatus);
    expect(result.current.size).toBe(1);
  });
});
