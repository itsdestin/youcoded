// @vitest-environment jsdom
// 2026-09-28 PR review: comment highlights wrap and split the text nodes React
// rendered. When a commented markdown file changed on disk (the assistant
// editing it), React patched those same nodes — highlighted words appeared
// twice, or React threw "The node to be removed is not a child of this node"
// and the viewer was replaced by an error. Separately, the old undo called
// `normalize()` on the whole document, merging React's own neighbouring text
// nodes, so later updates to a file went missing even with no comments.
import React, { useRef, useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { MarkdownView } from '../src/renderer/components/artifact-views/MarkdownView';
import { useQuoteMarks } from '../src/renderer/components/comments/use-quote-marks';
import { addComment, commentsForPath, __resetDocCommentsStoreForTest } from '../src/renderer/state/doc-comments-store';

afterEach(() => {
  __resetDocCommentsStoreForTest();
});

function viewerText(container: HTMLElement): string {
  return container.querySelector('[data-artifact-viewer]')!.textContent!.replace(/\s+/g, ' ').trim();
}

describe('a commented markdown file that changes on disk', () => {
  it('shows the new text once, keeps the highlight, and never throws', async () => {
    const path = 'test-fixtures/react-updates.md';
    addComment(path, 'brave world', path);
    const { container, rerender } = render(<MarkdownView absolutePath={`/p/${path}`} isEditable={false} path={path} content={'Hello **brave** world and more.'} />);
    expect(container.querySelector('mark[data-comment-id]')).not.toBeNull();

    await act(async () => {
      // Changes the very text node the highlight split (" world and more.").
      rerender(<MarkdownView absolutePath={`/p/${path}`} isEditable={false} path={path} content={'Hello **brave** world and less.'} />);
      // The highlight pass re-runs from a MutationObserver (a microtask).
      await Promise.resolve();
    });

    expect(viewerText(container)).toBe('Hello brave world and less.');
    const marked = Array.from(container.querySelectorAll('mark[data-comment-id]')).map((m) => m.textContent).join('');
    expect(marked).toBe('brave world');
  });

  it('removing the highlighted words does not crash the viewer', () => {
    const path = 'test-fixtures/react-updates-structural.md';
    addComment(path, 'tail words', path);
    // " tail words" is its own React text node; the highlight moves it into a
    // <mark>, so React's later removeChild of it used to throw.
    const { container, rerender } = render(<MarkdownView absolutePath={`/p/${path}`} isEditable={false} path={path} content={'Intro **bold** tail words'} />);
    expect(container.querySelector('mark[data-comment-id]')).not.toBeNull();

    act(() => {
      rerender(<MarkdownView absolutePath={`/p/${path}`} isEditable={false} path={path} content={'Intro **bold**'} />);
    });

    expect(viewerText(container)).toBe('Intro bold');
    expect(container.querySelector('mark[data-comment-id]')).toBeNull();
  });
});

describe("highlights never merge React's own text nodes", () => {
  // `<p>{a}{b}</p>` is two React text nodes side by side. The old undo's
  // `normalize()` merged them, and React's next update to `b` went to a node
  // no longer in the page.
  function Harness({ path }: { path: string }) {
    const ref = useRef<HTMLDivElement>(null);
    const [b, setB] = useState(' world');
    useQuoteMarks(ref, commentsForPath(path));
    return (
      <div ref={ref} data-artifact-source="rendered">
        <p>{'Hello'}{b}</p>
        <p>Commented sentence here.</p>
        <button onClick={() => setB(' there')}>change</button>
      </div>
    );
  }

  it('a later update to a neighbouring text node still shows', () => {
    const path = 'test-fixtures/react-updates-neighbours.md';
    addComment(path, 'Commented sentence', path);
    const { container, getByText } = render(<Harness path={path} />);
    expect(container.querySelector('mark[data-comment-id]')).not.toBeNull();

    act(() => {
      getByText('change').click();
    });

    expect(container.querySelector('p')!.textContent).toBe('Hello there');
  });
});
