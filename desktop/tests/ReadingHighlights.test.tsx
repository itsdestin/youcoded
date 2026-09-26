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
import { addComment, resolveComment } from '../src/renderer/state/doc-comments-store';
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
