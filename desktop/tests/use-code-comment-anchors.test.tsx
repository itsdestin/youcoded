// @vitest-environment jsdom
// T14 of the doc-comments build (docs/active/specs/2026-09-26-doc-comments-
// build-design.md §2.2/§2.3): CodeCommentsRail's line ranges now come from
// `resolveSelector` run against the LIVE CodeMirror document, not the stale
// creation-time `startLine`/`endLine` — this pins that an edit ABOVE a
// comment's line shifts its reported line, and that text removed entirely
// resolves to detached (and is left out of the resolved-lines map, so no
// stale highlight/jump target survives).
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { registerEditorView, unregisterEditorView } from '../src/renderer/components/artifact-views/cm/editor-registry';
import { useCodeCommentAnchors } from '../src/renderer/components/comments/use-code-comment-anchors';
import { addComment, commentsForPath, __resetDocCommentsStoreForTest } from '../src/renderer/state/doc-comments-store';
import { quoteContextAt } from '../src/shared/doc-comments-anchor';

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
});
