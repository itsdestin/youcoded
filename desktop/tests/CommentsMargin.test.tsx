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
describe('CommentsMargin — render cost at a realistic high comment count', () => {
  it('renders 1,000 text comments in one pass within a generous CPU budget', () => {
    const path = 'stress/1000-comments.md';
    const COUNT = 1000;
    // One <p> per quote — a rendered markdown document is many block
    // elements, never one flat text blob, so this is the realistic DOM shape
    // (a thousand one-line paragraphs, not a thousand-line single paragraph).
    const content = document.createElement('div');
    for (let i = 0; i < COUNT; i++) {
      const p = document.createElement('p');
      p.textContent = `filler filler Q${i}filler filler`;
      content.appendChild(p);
    }
    document.body.appendChild(content);
    for (let i = 0; i < COUNT; i++) {
      addComment(path, `Q${i}filler`, 'label', { prefix: '', suffix: '', occurrence: 0 });
    }

    const containerRef = { current: content };
    const startedCpu = process.cpuUsage();
    const { container } = render(<CommentsMargin containerRef={containerRef} path={path} narrow={false} />);
    const usedCpu = process.cpuUsage(startedCpu);
    const cpuMs = (usedCpu.user + usedCpu.system) / 1000;

    // Every comment anchored (proves the pass actually did the full-count
    // work being measured, not an early bail-out).
    expect(content.querySelectorAll('mark')).toHaveLength(COUNT);
    expect(container.querySelectorAll('[data-comments-list] > div')).toHaveLength(COUNT);
    // Measured locally at well under 1s for 1,000 comments (jsdom, one-time
    // mount cost — see this describe block's own header for what's included).
    // Generous headroom over that measurement, matching this repo's other
    // "did the bound hold" CPU pins (doc-comments-anchor.test.ts's F1 case),
    // not a tight budget an unrelated machine hiccup should trip.
    expect(cpuMs).toBeLessThan(5_000);
  });

  it('renders the elden-ring fixture\'s busiest real sheet (315 cell comments) within budget', () => {
    const path = 'reports/elden-ring-completionist-checklist.xlsx';
    const cellComments = eldenBossListCellComments();
    expect(cellComments.length).toBeGreaterThan(300); // the real number this test exists to cover — see fixture read above

    // A minimal stand-in for XlsxView's rendered grid: one <td data-cell> per
    // commented cell, all under one data-sheet container — the exact shape
    // use-quote-marks.ts's cellSelector/cellStatus query against.
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
    const { container } = render(<CommentsMargin containerRef={containerRef} path={path} narrow={false} />);
    const usedCpu = process.cpuUsage(startedCpu);
    const cpuMs = (usedCpu.user + usedCpu.system) / 1000;

    expect(container.querySelectorAll('[data-comments-list] > div')).toHaveLength(cellComments.length);
    // Same generous, measured-not-guessed budget as the synthetic case above.
    expect(cpuMs).toBeLessThan(5_000);
  });
});
