// @vitest-environment jsdom
// CHANGE (Destin, testing the dev instance): code files now show the SAME
// small floating "Add comment" box markdown/text files do, instead of
// force-opening the whole Comments panel — see CodeCommentPopover.tsx's own
// WHY and ActiveArtifactView.tsx's old call site. This pins the new
// contract: a fresh draft on a code file renders the popover (not a panel),
// and typing into it persists the note.
import React from 'react';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { registerEditorView, unregisterEditorView } from '../src/renderer/components/artifact-views/cm/editor-registry';
import { CodeCommentPopover } from '../src/renderer/components/comments/CodeCommentPopover';
import { addComment, commentsForPath, __resetDocCommentsStoreForTest } from '../src/renderer/state/doc-comments-store';

const PATH = 'src/example.ts';

beforeAll(() => {
  // jsdom never lays out real geometry — visibleEditorFor's own
  // `getClientRects().length > 0` check (same precedent as
  // use-code-comment-anchors.test.tsx) and CM6's `coordsAtPos`, which needs
  // real layout to answer, both need a stand-in under jsdom.
  Element.prototype.getClientRects = () => [{}] as unknown as DOMRectList;
  vi.spyOn(EditorView.prototype, 'coordsAtPos').mockReturnValue({ left: 10, right: 10, top: 20, bottom: 30 } as any);
});

function mountEditor(doc: string): { view: EditorView; host: HTMLElement } {
  const host = document.createElement('div');
  host.setAttribute('data-artifact-source', 'cm6');
  host.setAttribute('data-doc-path', PATH);
  // CodeEditorView's real host carries this too (the popover's `bounds`).
  host.setAttribute('data-artifact-viewer', '');
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
  cleanup();
});

describe('CodeCommentPopover — the small floating box for a fresh code-file draft', () => {
  it('renders the popover (not the panel) for a fresh draft, and typing persists the note', async () => {
    const { view, host } = mountEditor('result += price\n');
    try {
      // The exact call build-menu.ts's "Add comment" makes off a CM6 selection.
      addComment(PATH, 'result += p', 'line 1 · example.ts', {
        startLine: 1, endLine: 1, prefix: '', suffix: '', occurrence: 0,
      });

      render(<CodeCommentPopover path={PATH} />);

      const box = await screen.findByPlaceholderText(/add a comment…/i);
      expect(box).toBeTruthy();
      // Not the panel: no Show Resolved switch / panel title chrome alongside it.
      expect(screen.queryByText(/show resolved/i)).toBeNull();

      fireEvent.change(box, { target: { value: 'left factor out' } });
      await waitFor(() => expect(commentsForPath(PATH)[0].text).toBe('left factor out'));

      // Enter (send) commits the draft, same as NewCommentPopover on a
      // markdown file — the popover unmounts once focusId clears.
      fireEvent.keyDown(box, { key: 'Enter' });
      await waitFor(() => expect(screen.queryByPlaceholderText(/add a comment…/i)).toBeNull());
    } finally {
      teardown(view, host);
    }
  });

  it('Escape/cancel discards a still-empty draft', async () => {
    const { view, host } = mountEditor('result += price\n');
    try {
      addComment(PATH, 'result += p', 'line 1 · example.ts', {
        startLine: 1, endLine: 1, prefix: '', suffix: '', occurrence: 0,
      });
      render(<CodeCommentPopover path={PATH} />);
      const box = await screen.findByPlaceholderText(/add a comment…/i);

      fireEvent.keyDown(box, { key: 'Escape' });
      await waitFor(() => expect(commentsForPath(PATH)).toHaveLength(0));
    } finally {
      teardown(view, host);
    }
  });

  it('renders nothing when there is no fresh draft', () => {
    const { view, host } = mountEditor('nothing here\n');
    try {
      render(<CodeCommentPopover path={PATH} />);
      expect(screen.queryByPlaceholderText(/add a comment…/i)).toBeNull();
    } finally {
      teardown(view, host);
    }
  });
});
