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
// This test's own wall-clock budget (test-suite-hygiene.md's "budgets are measured, not guessed" — a named
// constant, not the 30s suite default). It mounts 1,000 real comments three times over (a warm-up and two
// measured mounts) — about a second alone, but tens of seconds inside `verify.sh --full`'s concurrent load
// (2026-09-28: 26 s). The assertion no longer reads a clock (see the WHY inside); this only stops vitest's
// default timeout from firing on a slow machine.
const STRESS_TEST_BUDGET_MS = 90_000;

describe('ReadingHighlights — render cost at a realistic high comment count', () => {
  it('mounts against 1,000 comments in one pass, with cost growing in line with the count', () => {
    // WHY counted work, not time (2026-09-30, one-core R3-4): this pin measured CPU time as a 1,000-vs-100
    // ratio and failed again under `verify.sh --full` (76.7x against a 70x bound, when it reads 32-35x idle
    // and passes eight-at-a-time under 64 busy loops). Process CPU time includes the JS engine's own
    // helper threads, whose spinning inflates with machine load for the allocation-heavy 1,000-comment
    // case and not for the small one — no bound on a time ratio survives that (the bound had already been
    // raised, and best-of-3 widened to best-of-5). So the guard now counts the work itself: how many
    // document text nodes the highlight pass visits. That count does not change with load. The pass reads
    // the document's text ONCE and resolves every comment against it, so 1,000 comments visit about
    // ten times the nodes of 100; anchoring that rewalked the
    // document per comment would visit about a hundred times as many — well clear of the line. (Measured
    // 2026-09-30: 207 vs 2,008 visits, 9.7x. Before wrapSegments started its walk at the quote instead
    // of the top of the document, 15,157 vs 1,501,508, 99x — a real quadratic that the time ratio hid.)
    //
    // WHY 100 vs 1,000 (10x): the wider the gap, the further apart "in line with the count" (~10x) and
    // "quadratic" (~100x) sit.
    const mountWith = (path: string, count: number) => {
      // One <p> per quote — see CommentsMargin.test.tsx's own note on why a
      // rendered document is many block elements, not one flat text blob.
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

      const containerRef = createRef<HTMLDivElement>();
      (containerRef as { current: HTMLElement | null }).current = content;
      // Count the document text nodes the pass visits (the walker every text scan goes through).
      const walkerProto = Object.getPrototypeOf(document.createTreeWalker(content)) as { nextNode: () => Node | null };
      const realNextNode = walkerProto.nextNode;
      let visits = 0;
      walkerProto.nextNode = function (this: unknown) { visits++; return realNextNode.call(this); };
      let unmount: () => void;
      try {
        ({ unmount } = render(<ReadingHighlights containerRef={containerRef} path={path} onOpenComments={vi.fn()} />));
      } finally { walkerProto.nextNode = realNextNode; }
      // Every comment anchored — proves the full pass actually ran, not an
      // early bail-out.
      expect(content.querySelectorAll('mark')).toHaveLength(count);
      unmount();
      content.remove();
      __resetDocCommentsStoreForTest();
      return visits;
    };
    // A count is the same every run, so one trial each is enough (no best-of-N to absorb noise).
    // Warm-up mount first, so one-time module init does not land on the measured mount.
    mountWith('stress/warmup.md', 50);
    const small = mountWith('stress/100-comments.md', 100);
    const large = mountWith('stress/1000-comments.md', 1000);
    // Linear is ~10x; a pass that rewalked the document per comment is ~100x. 30x sits well clear of both.
    expect(large / Math.max(small, 1)).toBeLessThan(30);
  }, STRESS_TEST_BUDGET_MS);
});
