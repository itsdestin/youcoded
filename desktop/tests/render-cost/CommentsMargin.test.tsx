// @vitest-environment jsdom
// CommentsMargin's render-cost pins. They live in tests/render-cost/ — not in
// tests/CommentsMargin.test.tsx with the component's other tests — because this
// folder runs in its own vitest project AFTER the parallel suite, one file at a
// time (vitest.config.ts → 'render-cost'; tests/helpers/render-cost.ts says
// why: inside the parallel suite these CPU ratios moved with nothing wrong).
//
// Code review 2026-09-27, desktop F3 (renderer-lists.md): this component's
// own header comment claimed comment counts are "small (a handful per file)"
// and exempted it from renderer-lists.md's 1,000-item stress-pin requirement
// — a judgment call, not a measured one. These two tests are that
// measurement: a synthetic 1,000-comment text file (renderer-lists.md's own
// literal bar) and the elden-ring golden fixture's REAL busiest sheet (315
// cell comments — a real user's file, not a seeded worst case). Both mount
// the full component (markAll's tree walk / per-cell querySelector,
// useAnchorTops's ResizeObserver, useQuoteMarks's per-mark listeners) and
// assert CPU time (never wall clock — test-suite-hygiene.md), not a chunked
// count: unlike a Resume/Conversations row list, every comment here can be
// scrolled to individually from its own highlight, so hiding rows below a
// chunk boundary would silently break "click a highlight, see its card."
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { CommentsMargin } from '../../src/renderer/components/comments/CommentsMargin';
import { addComment, __resetDocCommentsStoreForTest } from '../../src/renderer/state/doc-comments-store';
import { bestOf, cpuMsOf, RENDER_COST_BUDGET_MS } from '../helpers/render-cost';

// The elden-ring golden fixture (a REAL captured file, not a seeded test
// quote) has 315 comments on its single busiest sheet. `__dirname` (not
// `import.meta.url`/`.pathname` — test-suite-hygiene.md's Windows-path rule).
const ELDEN_FIXTURE_PATH = join(__dirname, '..', 'fixtures', 'doc-comments', 'golden', 'elden-ring-completionist-checklist.json');
function eldenBossListCellComments(): Array<{ cell: string; sheet: string }> {
  const raw = JSON.parse(readFileSync(ELDEN_FIXTURE_PATH, 'utf8')) as {
    comments: Array<{ selector: { kind: string; selector: { cell: string; sheet: string } } }>;
  };
  return raw.comments
    .filter((c) => c.selector.kind === 'cell' && c.selector.selector.sheet === 'Boss List')
    .map((c) => ({ cell: c.selector.selector.cell, sheet: c.selector.selector.sheet }));
}

afterEach(() => {
  __resetDocCommentsStoreForTest();
  cleanup();
  document.body.innerHTML = '';
});

describe('CommentsMargin — render cost at a realistic high comment count', () => {
  it('renders 1,000 text comments in one pass, with cost growing in line with the count', () => {
    // WHY a ratio, not a fixed ceiling: the first version asserted 1,000
    // comments stayed under 5s of CPU; CPU time differs by machine, so any
    // fixed number is either loose or a flake. What this pin exists to catch
    // is the per-comment cost blowing up (e.g. every mark re-walking the whole
    // document, or touching every earlier mark). Measuring two counts in the
    // SAME run cancels out machine speed.
    //
    // WHY the document is the SAME size for every count: each comment's
    // anchoring searches the whole document text, so a document that grew
    // with the comment count made normal cost look super-linear. Holding it at
    // DOC_PARAGRAPHS isolates cost per COMMENT.
    const DOC_PARAGRAPHS = 1000;
    const mountWith = (path: string, count: number) => {
      // One <p> per quote — a rendered markdown document is many block
      // elements, never one flat text blob, so this is the realistic DOM shape.
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
      const containerRef = { current: content };
      let mounted!: ReturnType<typeof render>;
      const ms = cpuMsOf(() => {
        mounted = render(<CommentsMargin containerRef={containerRef} path={path} narrow={false} />);
      });
      // Every comment anchored (proves the pass actually did the full-count
      // work being measured, not an early bail-out).
      expect(content.querySelectorAll('mark')).toHaveLength(count);
      expect(mounted.container.querySelectorAll('[data-comments-list] > div')).toHaveLength(count);
      mounted.unmount();
      content.remove();
      return ms;
    };

    // Warm-up mount so one-time costs (module init, JIT) don't land on a
    // measured trial and make the ratio look better than it is.
    mountWith('stress/warmup.md', 50);
    // WHY 100 vs 1,000 (10x), not the old 200 vs 1,000 (5x): a per-pair cost
    // grows with the SQUARE of the step, so a wider step separates it from
    // normal. Measured 2026-09-29 against a planted per-pair DOM change (every
    // new mark touching every earlier one): at 200 vs 1,000 it read 8.0x
    // against a normal 4.9x — no bound with room for noise sits between; at
    // 100 vs 1,000 it reads 15.0-16.0x against a normal 7.7-8.1x.
    const small = bestOf((t) => mountWith(`stress/small-${t}.md`, 100));
    const large = bestOf((t) => mountWith(`stress/large-${t}.md`, 1000));
    // WHY 12: normal measured 7.7-8.1x alone, 6.9-8.3x in three full
    // verify.sh --full runs and 7.4-8.5x across 24 runs of six full suites at
    // once (~50% headroom); the planted per-pair change reads 15.0-16.0x.
    expect(large / Math.max(small, 1)).toBeLessThan(12);
  }, RENDER_COST_BUDGET_MS);

  it('renders the elden-ring fixture\'s busiest real sheet (315 cell comments), with cost growing in line with the count', () => {
    // Same ratio design as the synthetic case above, on a real user's file:
    // the first 60 of its 315 cell comments against the full sheet.
    const allCellComments = eldenBossListCellComments();
    expect(allCellComments.length).toBeGreaterThan(300); // the real number this test exists to cover
    const SMALL_COUNT = 60;

    // A distinct path per mount: addComment always APPENDS (never dedupes by
    // cell), so reusing one path would pile earlier slices onto later ones.
    const mountWith = (pathSuffix: string, cellComments: Array<{ cell: string; sheet: string }>) => {
      const path = `reports/elden-ring-completionist-checklist-${pathSuffix}.xlsx`;
      // A minimal stand-in for XlsxView's rendered grid: one <td data-cell>
      // per commented cell, all under one data-sheet container — the exact
      // shape use-quote-marks.ts's cellSelector/cellStatus query against.
      const grid = document.createElement('div');
      grid.setAttribute('data-sheet', 'Boss List');
      for (const { cell } of cellComments) {
        const td = document.createElement('td');
        td.setAttribute('data-cell', cell);
        grid.appendChild(td);
      }
      document.body.appendChild(grid);
      for (const { cell, sheet } of cellComments) {
        addComment(path, '', 'label', { cell, sheet });
      }
      const containerRef = { current: grid };
      let mounted!: ReturnType<typeof render>;
      const ms = cpuMsOf(() => {
        mounted = render(<CommentsMargin containerRef={containerRef} path={path} narrow={false} />);
      });
      expect(mounted.container.querySelectorAll('[data-comments-list] > div')).toHaveLength(cellComments.length);
      mounted.unmount();
      grid.remove();
      return ms;
    };

    mountWith('warmup', allCellComments.slice(0, 20));
    const small = bestOf((t) => mountWith(`small-${t}`, allCellComments.slice(0, SMALL_COUNT)));
    const large = bestOf((t) => mountWith(`large-${t}`, allCellComments));
    // WHY 12 (unchanged): 315 / 60 is 5.25x the comments; normal measured
    // 8.1-9.1x alone, 6.5-7.5x in three full verify.sh --full runs and
    // 7.2-9.2x across 24 runs of six full suites at once.
    expect(large / Math.max(small, 1)).toBeLessThan(12);
  }, RENDER_COST_BUDGET_MS);
});
