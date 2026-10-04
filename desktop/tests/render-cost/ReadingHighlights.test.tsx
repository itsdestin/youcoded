// @vitest-environment jsdom
// ReadingHighlights' render-cost pin. It lives in tests/render-cost/ — not in
// tests/ReadingHighlights.test.tsx with the component's other tests — because
// this folder runs in its own vitest project AFTER the parallel suite, one file
// at a time (vitest.config.ts → 'render-cost'; tests/helpers/render-cost.ts
// says why: inside the parallel suite this CPU ratio moved with nothing wrong).
//
// Code review 2026-09-27, desktop F3 (renderer-lists.md): ReadingHighlights
// shares CommentsMargin's anchoring hook (useQuoteMarks) and therefore its
// per-mark listener-attachment cost — this is the twin of
// tests/render-cost/CommentsMargin.test.tsx's 1,000-comment pin for THIS
// component.
import React from 'react';
import { createRef } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ReadingHighlights } from '../../src/renderer/components/comments/ReadingHighlights';
import { addComment, __resetDocCommentsStoreForTest } from '../../src/renderer/state/doc-comments-store';
import { costRatio, cpuMsOf, RENDER_COST_BUDGET_MS } from '../helpers/render-cost';

describe('ReadingHighlights — render cost at a realistic high comment count', () => {
  it('mounts against 1,000 comments in one pass, with cost growing in line with the count', () => {
    // WHY a ratio, not a fixed ceiling: a fixed 5s CPU ceiling measured ~1.6s
    // alone but 5.07s in a loaded full-suite run. Measuring 100 and 1,000 in
    // the SAME run cancels out machine speed.
    //
    // WHY the store is reset after every mount: doc-comments-store's
    // `publishKey`/`addComment` shallow-copy the WHOLE `commentsByKey` object
    // per write (one entry per distinct path ever touched — see its own
    // `pruneKeyIfUnused` comment). Each trial uses its own path, so this keeps
    // that object's size constant across trials instead of growing it.
    //
    // WHY the document is the SAME size for every count: each comment's
    // anchoring searches the whole document text, so a document that grew
    // with the count made normal cost look super-linear. Holding it at
    // DOC_PARAGRAPHS isolates cost per COMMENT. 100 vs 1,000 (10x the comments).
    const DOC_PARAGRAPHS = 1000;
    const mountWith = (path: string, count: number) => {
      // One <p> per quote — a rendered document is many block elements, not
      // one flat text blob.
      const content = document.createElement('div');
      for (let i = 0; i < DOC_PARAGRAPHS; i++) {
        const p = document.createElement('p');
        p.textContent = `filler filler Q${i}filler filler`;
        content.appendChild(p);
      }
      document.body.appendChild(content);
      for (let i = 0; i < count; i++) {
        addComment(path, `Q${i}filler`, 'label', { prefix: '', suffix: '', occurrence: 0 });
      }

      const containerRef = createRef<HTMLDivElement>();
      (containerRef as { current: HTMLElement | null }).current = content;
      let mounted!: ReturnType<typeof render>;
      const ms = cpuMsOf(() => {
        mounted = render(<ReadingHighlights containerRef={containerRef} path={path} onOpenComments={vi.fn()} />);
      });
      // Every comment anchored — proves the full pass actually ran, not an
      // early bail-out.
      expect(content.querySelectorAll('mark')).toHaveLength(count);
      mounted.unmount();
      content.remove();
      __resetDocCommentsStoreForTest();
      return ms;
    };

    // Warm-up mount so one-time costs (module init, JIT) don't land on a
    // measured trial and make the ratio look better than it is.
    mountWith('stress/warmup.md', 50);
    const { ratio } = costRatio(
      (t) => mountWith(`stress/small-${t}.md`, 100),
      (t) => mountWith(`stress/large-${t}.md`, 1000),
    );
    // WHY 7.5 (was 15; re-measured 2026-10-01): linear text highlighting
    // made this component's own per-comment cost small next to its fixed
    // cost, so normal fell to 2.6-2.8x in 6 runs alone and 2.2-3.2x in 24
    // runs of six copies of this project at once. A planted per-pair DOM
    // change (every new mark toggling a class on every earlier one) reads
    // 19.4-21.8x — 15 still caught it, but by only 1.3x, while sitting 4.7x
    // above normal. 7.5 is 2.3x the worst normal reading (more
    // than the usual 50% headroom: the Windows and macOS runners' ratio is
    // not measured here) and the planted change clears it by 2.6x.
    expect(ratio).toBeLessThan(7.5);
  }, RENDER_COST_BUDGET_MS);
});
