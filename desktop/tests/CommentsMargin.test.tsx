// @vitest-environment jsdom
// T6 of the doc-comments build (docs/active/specs/2026-09-26-doc-comments-
// build-design.md §2.3): CommentsMargin's handling of a comment T14's real
// anchoring pass (use-quote-marks.ts) could not find text/a cell for —
// ordering (grouped after the anchored ones), that clicking it never tries to
// scroll to a highlight that doesn't exist, and that the narrow marker rail
// gives it its own reachable spot instead of piling it at the very top with
// every other marker.
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, render, cleanup, renderHook } from '@testing-library/react';
import { CommentsMargin } from '../src/renderer/components/comments/CommentsMargin';
import {
  addComment,
  useDocComments,
  __resetDocCommentsStoreForTest,
} from '../src/renderer/state/doc-comments-store';

// Code review 2026-09-27, desktop F3: the elden-ring golden fixture (a REAL
// captured file, not a seeded test quote) has 315 comments on its single
// busiest sheet — the "a handful per file" exemption this component's own
// comment (`CommentsMargin.tsx` header) used to claim was a guess, not a
// measured bound. Reusing the fixture here (rather than a synthetic cell
// count) is what makes the "measured bound" WHY comment a real-world number.
// `__dirname` (not `import.meta.url`/`.pathname` — test-suite-hygiene.md's
// Windows-path rule), matching xlsx-comments.test.ts's own fixture-path idiom.
const ELDEN_FIXTURE_PATH = join(__dirname, 'fixtures', 'doc-comments', 'golden', 'elden-ring-completionist-checklist.json');
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

/** Mounts the "document" text CommentsMargin's own useQuoteMarks anchors
 *  against — a plain div, same shape use-quote-marks.test.tsx's own
 *  `mountRoot` uses, independent of the CommentsMargin React tree itself. */
function mountContent(text: string): HTMLDivElement {
  const root = document.createElement('div');
  root.textContent = text;
  document.body.appendChild(root);
  return root;
}

/** Gives a just-`addComment`-ed draft its note text via the real hook API
 *  (`setCommentText` is intentionally not a bare export — see doc-comments-
 *  store.ts's own WHY) so CommentCard renders it as a real comment, not an
 *  empty draft. */
function writeNote(path: string, id: string, text: string): void {
  const { result } = renderHook(() => useDocComments(path));
  act(() => { result.current.setCommentText(id, text); });
}

describe('CommentsMargin — a comment resolveSelector could not anchor', () => {
  it('wide mode: groups the detached comment after every anchored one, in document order', () => {
    const path = 'doc.md';
    const content = mountContent('alpha ANCHORED beta gamma');
    const anchoredId = addComment(path, 'ANCHORED', 'label', { prefix: '', suffix: '', occurrence: 0 });
    const detachedId = addComment(path, 'text that was deleted', 'label', { prefix: '', suffix: '', occurrence: 0 });
    writeNote(path, anchoredId, 'This is the anchored note.');
    writeNote(path, detachedId, 'This is the detached note.');

    const containerRef = { current: content };
    const { container } = render(<CommentsMargin containerRef={containerRef} path={path} narrow={false} />);

    const text = container.textContent ?? '';
    expect(text.indexOf('This is the anchored note.')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('This is the detached note.')).toBeGreaterThan(text.indexOf('This is the anchored note.'));
    // §2.3: no highlight is ever drawn for the detached one — the anchored
    // comment gets exactly one <mark>, never two.
    expect(content.querySelectorAll('mark')).toHaveLength(1);
  });

  it('clicking the detached comment\'s card never tries to scroll to a highlight', () => {
    const path = 'doc2.md';
    const content = mountContent('nothing matches here');
    const detachedId = addComment(path, 'text nobody will find', 'label', { prefix: '', suffix: '', occurrence: 0 });
    writeNote(path, detachedId, 'A note on missing text.');

    const containerRef = { current: content };
    const { container } = render(<CommentsMargin containerRef={containerRef} path={path} narrow={false} />);

    // jsdom has no real scrollIntoView; stub it so a call is observable.
    const calls: HTMLElement[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = vi.fn(function (this: HTMLElement) { calls.push(this); });

    const card = container.querySelector('[data-comments-list] > div') as HTMLElement;
    expect(card).toBeTruthy();
    act(() => { card.click(); });

    // No <mark> exists for this comment at all (nothing to scroll to), and
    // nothing inside the document's own content root was asked to scroll —
    // only the card's own scroll-into-view-in-the-list call may fire.
    expect(content.querySelectorAll('mark')).toHaveLength(0);
    expect(calls.filter((el) => content.contains(el))).toHaveLength(0);
    Element.prototype.scrollIntoView = original;
  });

  it('narrow mode: a detached comment has no marker position and gets its own bottom group, muted and dashed', () => {
    const path = 'doc3.md';
    const content = mountContent('alpha ANCHORED beta');
    const anchoredId = addComment(path, 'ANCHORED', 'label', { prefix: '', suffix: '', occurrence: 0 });
    const detachedId = addComment(path, 'gone text', 'label', { prefix: '', suffix: '', occurrence: 0 });
    writeNote(path, anchoredId, 'anchored note');
    writeNote(path, detachedId, 'detached note');

    const containerRef = { current: content };
    const { container } = render(<CommentsMargin containerRef={containerRef} path={path} narrow />);

    const anchoredMarker = container.querySelector(`[data-marker-id="${anchoredId}"]`) as HTMLElement;
    const detachedMarker = container.querySelector(`[data-marker-id="${detachedId}"]`) as HTMLElement;
    expect(anchoredMarker).toBeTruthy();
    expect(detachedMarker).toBeTruthy();

    // The anchored marker is absolutely positioned by its own top offset.
    expect(anchoredMarker.className).toMatch(/\babsolute\b/);
    expect(anchoredMarker.style.top).not.toBe('');
    // The detached one sits inside the dedicated bottom group instead (laid
    // out by that group's own flex column, not its own top offset), and
    // reads as visually distinct (muted, dashed) rather than a normal marker.
    expect(detachedMarker.className).not.toMatch(/\babsolute\b/);
    expect(detachedMarker.style.top).toBe('');
    expect(detachedMarker.className).toMatch(/border-dashed/);
    expect(detachedMarker.getAttribute('aria-label')).toMatch(/text no longer found/i);
  });

  it('a detached comment is still counted as OPEN (Ask Your Assistant / summary counts)', () => {
    const path = 'doc4.md';
    const content = mountContent('irrelevant document text');
    const detachedId = addComment(path, 'vanished quote', 'label', { prefix: '', suffix: '', occurrence: 0 });
    writeNote(path, detachedId, 'still an open comment');

    const { result } = renderHook(() => useDocComments(path));
    expect(result.current.comments).toHaveLength(1);
    const [c] = result.current.comments;
    expect(c.resolved).toBe(false); // counted wherever code filters on `!resolved`, unaffected by `status`
    void content;
  });
});

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
// This test file's own wall-clock budget for the two stress tests below
// (test-suite-hygiene.md's "budgets are measured, not guessed" — a named
// constant, not the 30s suite default). Each does real work seven times over
// (1 warm-up + 3 best-of-3 trials each of two sizes), and under
// `verify.sh --full`'s own heavy concurrent load (every other check running
// at once — 2026-09-28) ReadingHighlights.test.tsx's identical shape hit the
// file's default 30s vitest timeout even though every individual mount
// stayed well under its own CPU budget — wall clock under contention can
// inflate far past CPU time alone. Same fix applied here defensively.
const STRESS_TEST_BUDGET_MS = 90_000;

describe('CommentsMargin — render cost at a realistic high comment count', () => {
  it('renders 1,000 text comments in one pass, with cost growing in line with the count', () => {
    // WHY a ratio, not a fixed ceiling: the first version asserted 1,000
    // comments stayed under 5s of CPU. It measured ~1.6s alone but 5.08s in a
    // full-suite run on a loaded machine (2026-09-27) — CPU time inflates under
    // contention too, so any fixed number is a flake waiting to happen. What
    // this pin actually exists to catch is the per-comment cost blowing up
    // (e.g. every mark re-walking the whole document: 5x the comments → ~25x
    // the cost). Measuring 200 and 1,000 in the SAME run cancels out machine
    // load: linear work is ~5x, and anything under 12x is still near-linear.
    //
    // WHY best-of-3, not one sample each: a single ratio still flaked on a
    // heavily loaded machine (2026-09-28: measured 16x against this 12x bound
    // in ReadingHighlights.test.tsx's identical pin, one of the two mounts
    // landing on a scheduling/GC hiccup the other didn't — same risk here).
    // Contention can only ADD overhead to a mount, never remove it, so the
    // MINIMUM across repeated trials of the same size is the closest any
    // sample gets to the uncontended cost.
    const mountWith = (path: string, count: number) => {
      // One <p> per quote — a rendered markdown document is many block
      // elements, never one flat text blob, so this is the realistic DOM shape
      // (many one-line paragraphs, not one many-line paragraph).
      const content = document.createElement('div');
      for (let i = 0; i < count; i++) {
        const p = document.createElement('p');
        p.textContent = `filler filler Q${i}filler filler`;
        content.appendChild(p);
      }
      document.body.appendChild(content);
      for (let i = 0; i < count; i++) {
        addComment(path, `Q${i}filler`, 'label', { prefix: '', suffix: '', occurrence: 0 });
      }
      const containerRef = { current: content };
      const startedCpu = process.cpuUsage();
      const { container, unmount } = render(<CommentsMargin containerRef={containerRef} path={path} narrow={false} />);
      const usedCpu = process.cpuUsage(startedCpu);
      // Every comment anchored (proves the pass actually did the full-count
      // work being measured, not an early bail-out).
      expect(content.querySelectorAll('mark')).toHaveLength(count);
      expect(container.querySelectorAll('[data-comments-list] > div')).toHaveLength(count);
      unmount();
      content.remove();
      return (usedCpu.user + usedCpu.system) / 1000;
    };
    // 5, not 3 (2026-09-28): best-of-3 still hit 13x once during a full
    // 15,000-test run while the same code measured 6.3-7.2x across 18
    // isolated and parallel-loaded reruns — one more outlier-prone sample
    // per size, not a looser bound, is what keeps a quadratic regression
    // (~25x) clearly separated from normal linear cost (~5-7x).
    const TRIALS = 5;
    /** The best (minimum) of TRIALS same-size mounts, each its own path so
     *  the store never carries duplicate comments across trials. */
    const bestOf = (label: string, count: number) => {
      const samples: number[] = [];
      for (let t = 0; t < TRIALS; t++) samples.push(mountWith(`stress/${label}-${t}.md`, count));
      return Math.min(...samples);
    };

    // Warm-up mount so one-time costs (module init, JIT) don't land on a
    // measured trial and make the ratio look better than it is.
    mountWith('stress/warmup.md', 50);
    const small = bestOf('200-comments', 200);
    const large = bestOf('1000-comments', 1000);
    expect(large / Math.max(small, 1)).toBeLessThan(12);
  }, STRESS_TEST_BUDGET_MS);

  it('renders the elden-ring fixture\'s busiest real sheet (315 cell comments), with cost growing in line with the count', () => {
    // WHY a ratio, not a fixed ceiling: same fix as the synthetic case above
    // (fdd3db1b9) — a fixed 5s CPU ceiling here (10x the ~0.5s measured alone
    // on 2026-09-27) still tripped in a full-suite run on a loaded machine
    // (2026-09-28), because CPU time itself inflates under contention, not
    // just wall clock. Measuring a real subset of this SAME fixture (the
    // first 60 of its 315 cell comments) against the full sheet in one run
    // cancels out machine load instead of guessing a bigger fixed number.
    const allCellComments = eldenBossListCellComments();
    expect(allCellComments.length).toBeGreaterThan(300); // the real number this test exists to cover — see fixture read above
    const SMALL_COUNT = 60;

    // A distinct path per mount — same reason CommentsMargin's synthetic
    // 1,000-comment fix uses a distinct path per size: addComment always
    // APPENDS (never dedupes by cell), so reusing one path across mounts
    // would pile every earlier slice's comments onto the later ones.
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
      const startedCpu = process.cpuUsage();
      const { container, unmount } = render(<CommentsMargin containerRef={containerRef} path={path} narrow={false} />);
      const usedCpu = process.cpuUsage(startedCpu);
      expect(container.querySelectorAll('[data-comments-list] > div')).toHaveLength(cellComments.length);
      unmount();
      grid.remove();
      return (usedCpu.user + usedCpu.system) / 1000;
    };
    // 5, not 3 (2026-09-28): best-of-3 still hit 13x once during a full
    // 15,000-test run while the same code measured 6.3-7.2x across 18
    // isolated and parallel-loaded reruns — one more outlier-prone sample
    // per size, not a looser bound, is what keeps a quadratic regression
    // (~25x) clearly separated from normal linear cost (~5-7x).
    const TRIALS = 5;
    /** The best (minimum) of TRIALS mounts of the same slice, each its own
     *  path (see WHY above — addComment always appends). Contention can only
     *  ADD overhead, never remove it, so the minimum across repeated trials
     *  is the closest any sample gets to the uncontended cost — same fix as
     *  the synthetic 1,000-comment case above, after a single-sample ratio
     *  here also flaked under load. */
    const bestOf = (label: string, cellComments: Array<{ cell: string; sheet: string }>) => {
      const samples: number[] = [];
      for (let t = 0; t < TRIALS; t++) samples.push(mountWith(`${label}-${t}`, cellComments));
      return Math.min(...samples);
    };

    // Warm-up mount so one-time costs (module init, JIT) don't land on a
    // measured trial and make the ratio look better than it is.
    mountWith('warmup', allCellComments.slice(0, 20));
    const small = bestOf('small', allCellComments.slice(0, SMALL_COUNT));
    const large = bestOf('large', allCellComments);
    // 315 / 60 ≈ 5.25x if linear; generous headroom over that, same bound as
    // the synthetic 1,000-comment case above.
    expect(large / Math.max(small, 1)).toBeLessThan(12);
  }, STRESS_TEST_BUDGET_MS);
});
