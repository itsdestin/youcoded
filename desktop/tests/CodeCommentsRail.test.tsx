// @vitest-environment jsdom
// T6 of the doc-comments build (docs/active/specs/2026-09-26-doc-comments-
// build-design.md §2.3): code files get the SAME "text no longer found"
// treatment as markdown/docx — this pins that a comment `resolveSelector`
// can't anchor against the live CodeMirror document is grouped after every
// anchored one (not wherever its stale creation-time line number happens to
// land it), and gets no click-to-jump wiring since there is no line to jump to.
import React from 'react';
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { act, render, cleanup, waitFor, renderHook } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { registerEditorView, unregisterEditorView } from '../src/renderer/components/artifact-views/cm/editor-registry';
import { CodeCommentsRail } from '../src/renderer/components/comments/CodeCommentsRail';
import {
  addComment,
  useDocComments,
  __resetDocCommentsStoreForTest,
} from '../src/renderer/state/doc-comments-store';
import { quoteContextAt } from '../src/shared/doc-comments-anchor';

const PATH = 'src/example.ts';

beforeAll(() => {
  // jsdom never lays out real geometry — ref-line-highlight.ts's own
  // `visibleEditorFor` (reused by use-code-comment-anchors.ts) picks the
  // VISIBLE copy of an editor via `getClientRects().length > 0`, which every
  // element fails under jsdom. Same precedent as use-code-comment-anchors.test.tsx.
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

function writeNote(id: string, text: string): void {
  const { result } = renderHook(() => useDocComments(PATH));
  act(() => { result.current.setCommentText(id, text); });
}

afterEach(() => {
  __resetDocCommentsStoreForTest();
  cleanup();
});

describe('CodeCommentsRail — a comment the live editor can no longer anchor', () => {
  it('is grouped AFTER every anchored comment, regardless of its stale creation-time line', async () => {
    // The detached comment's OWN stale startLine (from a selection made
    // before the edit below) would sort it FIRST if `visible`'s stale sort
    // were used for rendering — the fix re-sorts by the LIVE line and puts
    // anything with no live line last.
    const original = 'TARGET LINE\nline two\nline three';
    const start = original.indexOf('TARGET LINE');
    const ctx = quoteContextAt(original, start, start + 'TARGET LINE'.length);
    const anchoredId = addComment(PATH, 'TARGET LINE', 'label', {
      startLine: 1, endLine: 1, prefix: ctx.prefix, suffix: ctx.suffix, occurrence: ctx.occurrence,
    });
    // A stale startLine of 0 (before the anchored comment's line 1) so a
    // naive stale-line sort would place it FIRST, not last.
    const detachedId = addComment(PATH, 'this line got removed entirely', 'label', {
      startLine: 0, endLine: 0, prefix: '', suffix: '', occurrence: 0,
    });
    writeNote(anchoredId, 'This is the anchored note.');
    writeNote(detachedId, 'This is the detached note.');

    const { view, host } = mountEditor('TARGET LINE\nline two\nline three');
    try {
      const { container } = render(<CodeCommentsRail path={PATH} />);
      await waitFor(() => expect(container.textContent).toContain('This is the anchored note.'));
      await waitFor(() => expect(container.textContent).toContain('This is the detached note.'));

      const text = container.textContent ?? '';
      expect(text.indexOf('This is the detached note.')).toBeGreaterThan(text.indexOf('This is the anchored note.'));

      // §2.3: the detached card gets the plain, non-committal line too.
      expect(text).toMatch(/text no longer found in this file\./i);
    } finally {
      teardown(view, host);
    }
  });

  it('never wires a click-to-jump for the detached card — nothing to jump to', async () => {
    const id = addComment(PATH, 'gone forever', 'label', { startLine: 1, endLine: 1, prefix: '', suffix: '', occurrence: 0 });
    writeNote(id, 'a note on missing text');
    const { view, host } = mountEditor('completely different content');
    try {
      const { container } = render(<CodeCommentsRail path={PATH} />);
      await waitFor(() => expect(container.querySelector('[data-comments-list] > div')).toBeTruthy());
      const row = container.querySelector('[data-comments-list] > div') as HTMLElement;
      // linesRef() returns null for a comment resolveSelector can't anchor —
      // CodeCommentsRail's own guard then skips jumpToRef/hover wiring and
      // the row never gets the "cursor-pointer" affordance a jumpable one has.
      expect(row.className).not.toMatch(/cursor-pointer/);
    } finally {
      teardown(view, host);
    }
  });
});
