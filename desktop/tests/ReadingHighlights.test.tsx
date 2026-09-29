// @vitest-environment jsdom
// F3 (T7 review): clicking a SENT Ask Your Assistant summary chip ("N
// comments · file") stopped opening the comment panel once compose-ref.ts's
// wire format changed — a decoded summary chip carries no `commentId`, so the
// jump listener's existing `ref.commentId` branch never matched it. The fix
// recognises the summary chip's shape and opens the panel focused on the
// first still-open comment, WITHOUT the wire text needing to carry any ids.
// `detail.handled` must be set ONLY when this listener actually opened
// something, so a summary chip whose file is genuinely closed still falls
// through to `jumpToRef`'s own `openFile` path (compose-ref.ts).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { createRef } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ReadingHighlights } from '../src/renderer/components/comments/ReadingHighlights';
import { addComment, resolveComment, __resetDocCommentsStoreForTest } from '../src/renderer/state/doc-comments-store';
import { genRefId, type ComposeRef } from '../src/renderer/components/context-menu/compose-ref';

function summaryChipRef(path: string, fileName: string, count: number): ComposeRef {
  return {
    id: genRefId(), kind: 'doc', path, fileName,
    label: `${count} ${count === 1 ? 'comment' : 'comments'} · ${fileName}`,
  };
}

function dispatchJump(ref: ComposeRef): { ref: ComposeRef; handled: boolean } {
  const detail: { ref: ComposeRef; handled: boolean } = { ref, handled: false };
  window.dispatchEvent(new CustomEvent('youcoded:jump-to-ref', { detail }));
  return detail;
}

function mount(path: string, onOpenComments: (id?: string) => void) {
  const containerRef = createRef<HTMLDivElement>();
  render(
    <div ref={containerRef}>
      <ReadingHighlights containerRef={containerRef} path={path} onOpenComments={onOpenComments} />
    </div>,
  );
}

describe('a decoded summary-chip reference opens the comment panel on click', () => {
  it('opens the panel focused on the first still-open comment, and marks the event handled', () => {
    const path = 'test-fixtures/f3-click-open.md';
    const openId = addComment(path, 'quote one', path);
    const resolvedId = addComment(path, 'quote two', path);
    resolveComment(resolvedId, 'user');

    const onOpenComments = vi.fn();
    mount(path, onOpenComments);

    const detail = dispatchJump(summaryChipRef(path, 'f3-click-open.md', 2));

    expect(onOpenComments).toHaveBeenCalledWith(openId);
    expect(detail.handled).toBe(true);
  });

  it('a summary chip for a different, closed file is left unhandled — jumpToRef still opens it', () => {
    const openPath = 'test-fixtures/f3-click-this-one-is-open.md';
    const onOpenComments = vi.fn();
    mount(openPath, onOpenComments);

    // Nothing in THIS viewer is mounted for the closed file's path, so the
    // listener must not claim the event.
    const detail = dispatchJump(summaryChipRef('docs/some-other-closed-file.md', 'x.md', 1));

    expect(onOpenComments).not.toHaveBeenCalled();
    expect(detail.handled).toBe(false);
  });

  it('a summary chip whose file IS open but has nothing open right now is also left unhandled', () => {
    const path = 'test-fixtures/f3-click-nothing-open.md';
    const onlyId = addComment(path, 'quote', path);
    resolveComment(onlyId, 'user');

    const onOpenComments = vi.fn();
    mount(path, onOpenComments);

    const detail = dispatchJump(summaryChipRef(path, 'f3-click-nothing-open.md', 1));

    expect(onOpenComments).not.toHaveBeenCalled();
    expect(detail.handled).toBe(false);
  });
});

// Code review 2026-09-27, desktop F3 (renderer-lists.md): CommentsMargin.tsx's
// own header comment claimed comment counts are "small (a handful per file)"
// to justify skipping renderer-lists.md's 1,000-item stress pin, and
// ReadingHighlights shares the exact same anchoring hook (useQuoteMarks) and
// therefore the same per-mark listener-attachment cost — this is that pin's
// twin for THIS component. See CommentsMargin.tsx's header for the measured
// numbers (this hook's cost, not this component's own render, dominates
// either way) and `CommentsMargin.test.tsx`'s matching describe block for the
// real-fixture (elden-ring, 315 cell comments) case.
// This test's own wall-clock budget (test-suite-hygiene.md's "budgets are
// measured, not guessed" — a named constant, not the 30s suite default). It
// does real work seven times over (1 warm-up + 3 trials each of 100 and
// 1,000 comments), so under `verify.sh --full`'s own heavy concurrent load
// (every other check running at once — 2026-09-28) the file's default 30s
// vitest timeout was hit even though every individual mount stayed well
// under its own CPU budget: wall clock under contention can inflate far
// past CPU time alone (the CPU-usage ratio assertion below already accounts
// for that; this is the SEPARATE wall-clock budget for the whole test).
const STRESS_TEST_BUDGET_MS = 90_000;

describe('ReadingHighlights — render cost at a realistic high comment count', () => {
  it('mounts against 1,000 comments in one pass, with cost growing in line with the count', () => {
    // WHY a ratio, not a fixed ceiling: matches CommentsMargin.test.tsx's own
    // fix (fdd3db1b9) — a fixed 5s CPU ceiling measured ~1.6s alone but 5.07s
    // in a full-suite run on a loaded machine (2026-09-28), because CPU time
    // itself inflates under contention. Measuring 100 and 1,000 in the SAME
    // run cancels out machine load.
    //
    // WHY best-of-3, not one sample each: a single ratio still flaked on a
    // heavily loaded machine (2026-09-28: measured 16x, one of the two mounts
    // landing on a scheduling/GC hiccup the other didn't). Contention can
    // only ADD overhead to a mount, never remove it, so the MINIMUM across
    // repeated trials of the same size is the closest any sample gets to the
    // uncontended cost.
    //
    // WHY the store is reset after every mount: doc-comments-store's
    // `publishKey`/`addComment` shallow-copy the WHOLE `commentsByKey` object
    // per write (one entry per distinct path ever touched — a deliberate
    // O(open files) cost the store accepts for O(1) per-file reads; see its
    // own `pruneKeyIfUnused` comment). Each best-of-3 trial uses its own
    // path, so this keeps that object's size constant across trials instead
    // of growing it — measured to make no difference to the ratio below, but
    // left in on principle so a future higher TRIALS count doesn't quietly
    // reintroduce it.
    //
    // WHY the document is the SAME size for every count (2026-09-29, the
    // recipe CommentsMargin.test.tsx uses): each comment's anchoring searches
    // the whole document text, so when the document grew with the comment
    // count, "10x the comments" also meant a 10x longer document — normal cost
    // measured 32-35x and a loaded full-suite run crossed the old 70x bound with
    // nothing wrong. Holding the document at DOC_PARAGRAPHS isolates what this
    // pin is for: cost per COMMENT. 100 vs 1,000 (10x the comments).
    const DOC_PARAGRAPHS = 1000;
    const mountWith = (path: string, count: number) => {
      // One <p> per quote — see CommentsMargin.test.tsx's own note on why a
      // rendered document is many block elements, not one flat text blob.
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
      const startedCpu = process.cpuUsage();
      const { unmount } = render(<ReadingHighlights containerRef={containerRef} path={path} onOpenComments={vi.fn()} />);
      const usedCpu = process.cpuUsage(startedCpu);
      // Every comment anchored — proves the full pass actually ran, not an
      // early bail-out.
      expect(content.querySelectorAll('mark')).toHaveLength(count);
      unmount();
      content.remove();
      __resetDocCommentsStoreForTest();
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
    const small = bestOf('100-comments', 100);
    const large = bestOf('1000-comments', 1000);
    // 17, not 70 (2026-09-29): with the document held constant, normal cost
    // measures 8.4-8.8x alone (six runs) and reached 13.3x in one full verify.sh
    // run (+57% under load, so a 13 bound flaked). 70 was set when the document
    // grew with the count (normal 32-35x) and flaked at 71.9x; it also let a
    // planted per-pair DOM change (every new mark touching every earlier one)
    // through at 26-30x. 17 sits above the loaded measurement and well below
    // the planted one. WHY not CommentsMargin's 200-vs-1,000 step (tried
    // 2026-09-29): normal 4.7-5.9x, but single runs alone also gave 13.4x and
    // 2.3x, while the planted change measured only 12.0-17.1x — no bound
    // separates them.
    expect(large / Math.max(small, 1)).toBeLessThan(17);
  }, STRESS_TEST_BUDGET_MS);
});
