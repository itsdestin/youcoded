// @vitest-environment jsdom
// T14 of the doc-comments build (docs/active/specs/2026-09-26-doc-comments-
// build-design.md §2.2/§2.3): CodeCommentsRail's line ranges now come from
// `resolveSelector` run against the LIVE CodeMirror document, not the stale
// creation-time `startLine`/`endLine` — this pins that an edit ABOVE a
// comment's line shifts its reported line, and that text removed entirely
// resolves to detached (and is left out of the resolved-lines map, so no
// stale highlight/jump target survives).
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { registerEditorView, unregisterEditorView } from '../src/renderer/components/artifact-views/cm/editor-registry';
import { useCodeCommentAnchors } from '../src/renderer/components/comments/use-code-comment-anchors';
import { addComment, commentsForPath, useDocComments, __resetDocCommentsStoreForTest } from '../src/renderer/state/doc-comments-store';
import { quoteContextAt } from '../src/shared/doc-comments-anchor';
import { MAX_ANCHOR_TEXT_CHARS } from '../src/renderer/components/comments/use-quote-marks';

const PATH = 'src/example.ts';

beforeAll(() => {
  // jsdom never lays out real geometry — ref-line-highlight.ts's own
  // `visibleEditorFor` (reused here) picks the VISIBLE copy of an editor via
  // `getClientRects().length > 0`, which every element fails under jsdom.
  // Same precedent as compose-ref-chat-highlight.test.ts.
  Element.prototype.getClientRects = () => [{}] as unknown as DOMRectList;
});

function mountEditor(doc: string): { view: EditorView; host: HTMLElement } {
  const host = document.createElement('div');
  host.setAttribute('data-artifact-source', 'cm6');
  host.setAttribute('data-doc-path', PATH);
  document.body.appendChild(host);
  const view = new EditorView({ state: EditorState.create({ doc }), parent: host });
  registerEditorView(host, view);
  return { view, host };
}

function teardown(view: EditorView, host: HTMLElement): void {
  unregisterEditorView(host);
  view.destroy();
  host.remove();
}

afterEach(() => {
  __resetDocCommentsStoreForTest();
});

describe('useCodeCommentAnchors', () => {
  it('resolves a comment to its CURRENT line after text moved above it', async () => {
    const original = 'line one\nline two\nTARGET LINE\nline four';
    const start = original.indexOf('TARGET LINE');
    const ctx = quoteContextAt(original, start, start + 'TARGET LINE'.length);
    addComment(PATH, 'TARGET LINE', 'label', { prefix: ctx.prefix, suffix: ctx.suffix, occurrence: ctx.occurrence });

    // Two lines inserted above where the comment was made — the stale
    // creation-time lineHint would still say line 3; the real current line is 5.
    const moved = 'inserted one\ninserted two\nline one\nline two\nTARGET LINE\nline four';
    const { view, host } = mountEditor(moved);
    try {
      const { result } = renderHook(() => useCodeCommentAnchors(PATH, commentsForPath(PATH)));
      await waitFor(() => expect(result.current.size).toBe(1));
      const lines = [...result.current.values()][0];
      expect(lines.startLine).toBe(5);
      expect(lines.endLine).toBe(5);
      expect(commentsForPath(PATH)[0].status).toBe('anchored');
    } finally {
      teardown(view, host);
    }
  });

  it('a deleted line resolves to detached and is left out of the resolved-lines map', async () => {
    addComment(PATH, 'this exact line got deleted', 'label', { prefix: '', suffix: '', occurrence: 0 });
    const { view, host } = mountEditor('nothing matches here\nanymore');
    try {
      const { result } = renderHook(() => useCodeCommentAnchors(PATH, commentsForPath(PATH)));
      await waitFor(() => expect(commentsForPath(PATH)[0].status).toBe('detached'));
      expect(result.current.size).toBe(0);
    } finally {
      teardown(view, host);
    }
  });

  // F1/F2 (T14 review): before this fix, `resolveOne` called
  // `view.state.doc.toString()` itself, once PER COMMENT — an
  // O(document-length) copy each time. This pins that a pass now hoists ONE
  // `toString()` call regardless of how many comments are anchored against it.
  it('calls view.state.doc.toString() exactly once per pass, not once per comment', async () => {
    const doc = 'ONE\nTWO\nTHREE\nFOUR';
    for (const word of ['ONE', 'TWO', 'THREE', 'FOUR']) {
      const start = doc.indexOf(word);
      const ctx = quoteContextAt(doc, start, start + word.length);
      addComment(PATH, word, 'label', { prefix: ctx.prefix, suffix: ctx.suffix, occurrence: ctx.occurrence });
    }
    const { view, host } = mountEditor(doc);
    try {
      const spy = vi.spyOn(view.state.doc, 'toString');
      const { result } = renderHook(() => useCodeCommentAnchors(PATH, commentsForPath(PATH)));
      await waitFor(() => expect(result.current.size).toBe(4));
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      teardown(view, host);
    }
  });

  // F3 (T14 review): past MAX_ANCHOR_TEXT_CHARS the file is too large to
  // check AT ALL — comments are marked 'unchecked' (honest: the text might
  // still be there), never left with the ambiguous unset status, and never
  // the false claim 'detached' would make.
  it('marks every comment "unchecked" (not "detached") once the live document is past the size bound', async () => {
    addComment(PATH, 'anything', 'label', { prefix: '', suffix: '', occurrence: 0 });
    const oversized = 'x'.repeat(MAX_ANCHOR_TEXT_CHARS + 1);
    const { view, host } = mountEditor(oversized);
    try {
      const { result } = renderHook(() => useCodeCommentAnchors(PATH, commentsForPath(PATH)));
      await waitFor(() => expect(commentsForPath(PATH)[0].status).toBe('unchecked'));
      expect(result.current.size).toBe(0); // no highlight either — same as detached
    } finally {
      teardown(view, host);
    }
  });

  // F5 (T14 review): a settle/fixed-point pin — the class of bug T14's own
  // commit fixed once already (CodeCommentsRail's unmemoized `visible` fed a
  // fresh array into this hook's effect deps every render, including one its
  // own `setResolved` caused, producing "Maximum update depth exceeded").
  // Simulates the store handing down a FRESH array reference each render
  // (exactly what CommentsMargin/CodeCommentsRail's own `visible` useMemo
  // does whenever ANY other field on the comment changes, e.g. typing in an
  // unrelated comment's note) — the hook must land on a stable result and
  // never grow or oscillate.
  it('reaches a fixed point instead of re-resolving on every settle pass', async () => {
    const original = 'STABLE LINE\nsecond\nthird';
    const start = original.indexOf('STABLE LINE');
    const ctx = quoteContextAt(original, start, start + 'STABLE LINE'.length);
    addComment(PATH, 'STABLE LINE', 'label', { prefix: ctx.prefix, suffix: ctx.suffix, occurrence: ctx.occurrence });
    const { view, host } = mountEditor(original);
    try {
      const spy = vi.spyOn(view.state.doc, 'toString');
      const { result, rerender } = renderHook(
        ({ comments }) => useCodeCommentAnchors(PATH, comments),
        { initialProps: { comments: commentsForPath(PATH) } },
      );
      await waitFor(() => expect(result.current.size).toBe(1));
      const callsAfterSettle = spy.mock.calls.length;

      // Fresh array reference, IDENTICAL content — the anchor signature
      // (id/quote/selector/cell/sheet/resolved) is unchanged, so the effect
      // must not re-run at all: no additional resolve pass, same result.
      for (let i = 0; i < 5; i++) {
        rerender({ comments: [...commentsForPath(PATH)] });
      }
      expect(spy.mock.calls.length).toBe(callsAfterSettle);
      expect(result.current.size).toBe(1);
      expect(commentsForPath(PATH)[0].status).toBe('anchored');
    } finally {
      teardown(view, host);
    }
  });
});

// F4 (T14 review, performance.md rule 5): typing in a comment's own note/
// reply must not re-run this hook's whole-file anchoring pass — it changes
// `text`/`replies`, never the comment's id/quote/selector/cell/sheet/resolved,
// so `anchorSignature` stays the same and the effect below should not re-run.
describe('useCodeCommentAnchors — typing in a comment does not re-anchor (F4)', () => {
  it('a keystroke in setCommentText does not call view.state.doc.toString() again', async () => {
    const original = 'TARGET LINE\nsecond\nthird';
    const start = original.indexOf('TARGET LINE');
    const ctx = quoteContextAt(original, start, start + 'TARGET LINE'.length);
    const id = addComment(PATH, 'TARGET LINE', 'label', { prefix: ctx.prefix, suffix: ctx.suffix, occurrence: ctx.occurrence });
    const { view, host } = mountEditor(original);
    try {
      const spy = vi.spyOn(view.state.doc, 'toString');
      const { result, rerender } = renderHook(
        ({ comments }) => useCodeCommentAnchors(PATH, comments),
        { initialProps: { comments: commentsForPath(PATH) } },
      );
      await waitFor(() => expect(result.current.size).toBe(1));
      const callsAfterSettle = spy.mock.calls.length;

      const { result: apiResult } = renderHook(() => useDocComments(PATH));
      for (const ch of 'hello') {
        act(() => { apiResult.current.setCommentText(id, (commentsForPath(PATH)[0]?.text ?? '') + ch); });
        rerender({ comments: commentsForPath(PATH) });
      }

      expect(commentsForPath(PATH)[0].text).toBe('hello');
      expect(spy.mock.calls.length).toBe(callsAfterSettle); // no re-anchor pass
      expect(result.current.size).toBe(1); // unchanged, still anchored
    } finally {
      teardown(view, host);
    }
  });
});
