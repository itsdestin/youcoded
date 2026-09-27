// @vitest-environment jsdom
// T6 of the doc-comments build (docs/active/specs/2026-09-26-doc-comments-
// build-design.md §2.3): CommentsMargin's handling of a comment T14's real
// anchoring pass (use-quote-marks.ts) could not find text/a cell for —
// ordering (grouped after the anchored ones), that clicking it never tries to
// scroll to a highlight that doesn't exist, and that the narrow marker rail
// gives it its own reachable spot instead of piling it at the very top with
// every other marker.
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, render, cleanup, renderHook } from '@testing-library/react';
import { CommentsMargin } from '../src/renderer/components/comments/CommentsMargin';
import {
  addComment,
  useDocComments,
  __resetDocCommentsStoreForTest,
} from '../src/renderer/state/doc-comments-store';

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
