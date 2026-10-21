// @vitest-environment jsdom
// unified-diff-fill.test.tsx — pins the `fill` prop that the git review
// timeline relies on (2026-07-23). The review wraps each diff in its own
// 45vh scroll box; UnifiedDiff's internal 15-line preview cap + "Expand"
// button would stack a second, redundant scrollbar inside that box and the
// "Expand" click barely moved anything. `fill` must suppress BOTH the cap and
// the button so the host is the sole scroll surface — this test is the guard
// against that regressing back to the nested-scroll jank Destin reported.
import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { diffLines } from 'diff';

vi.mock('diff', async (original) => {
  const actual = await original<typeof import('diff')>();
  return { ...actual, diffLines: vi.fn(actual.diffLines) };
});
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { UnifiedDiff } from '../src/renderer/components/diff/UnifiedDiff';
import { OnScreenContext } from '../src/renderer/state/on-screen-context';
import type { StructuredPatchHunk } from '../src/shared/types';
import { installFiringIntersectionObserver } from './helpers/firing-intersection-observer';

afterEach(cleanup);

// A hunk with far more than DIFF_PREVIEW_LINES (15) rows, so the internal cap
// + Expand button WOULD appear without `fill`.
describe('large comparisons keep the renderer free', () => {
  const workers: FakeWorker[] = [];
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { preventDefault: () => void }) => void) | null = null;
    postMessage = vi.fn();
    terminate = vi.fn();
    constructor() { workers.push(this); }
  }
  const large = (prefix: string) => Array.from({ length: 1000 }, (_, i) => `${prefix}${i}`).join('\n');
  beforeEach(() => { workers.length = 0; vi.mocked(diffLines).mockClear(); vi.stubGlobal('Worker', FakeWorker); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('does not run an expensive comparison in render, then draws its worker result', async () => {
    render(<UnifiedDiff oldStr={large('old')} newStr={large('new')} />);
    expect(diffLines).not.toHaveBeenCalled();
    expect(screen.getByText(/Loading comparison/)).toBeInTheDocument();
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    await act(async () => workers[0].onmessage?.({ data: { ok: true, rows: [{ kind: 'add', newN: 1, text: 'worker result' }] } }));
    expect(screen.getByText('worker result')).toBeInTheDocument();
    expect(screen.queryByText(/Loading comparison/)).toBeNull();
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it('cancels an obsolete comparison and ignores its late answer', async () => {
    const view = render(<UnifiedDiff oldStr={large('old')} newStr={large('first')} />);
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    const late = workers[0].onmessage;
    view.rerender(<UnifiedDiff oldStr={large('old')} newStr={large('second')} />);
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    act(() => late?.({ data: { ok: true, rows: [{ kind: 'add', newN: 1, text: 'obsolete result' }] } }));
    expect(screen.queryByText('obsolete result')).toBeNull();
    await act(async () => workers[1].onmessage?.({ data: { ok: true, rows: [{ kind: 'add', newN: 1, text: 'current result' }] } }));
    expect(screen.getByText('current result')).toBeInTheDocument();
  });

  it('pauses hidden chats without throwing away a completed comparison', async () => {
    const viewOf = (visible: boolean) => <OnScreenContext.Provider value={visible}><UnifiedDiff oldStr={large('old')} newStr={large('new')} /></OnScreenContext.Provider>;
    const view = render(viewOf(true));
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    view.rerender(viewOf(false));
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(screen.queryByText(/Loading comparison/)).toBeNull();
    view.rerender(viewOf(true));
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    await act(async () => workers[1].onmessage?.({ data: { ok: true, rows: [{ kind: 'add', newN: 1, text: 'kept result' }] } }));
    view.rerender(viewOf(false));
    view.rerender(viewOf(true));
    await act(async () => {}); // settle: showing a completed comparison starts no new job
    expect(workers).toHaveLength(2);
    expect(screen.getByText('kept result')).toBeInTheDocument();
  });

  it('offers retry after worker failure and cancels the retry when unmounted', async () => {
    const view = render(<UnifiedDiff oldStr={large('old')} newStr={large('new')} />);
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    await act(async () => workers[0].onerror?.({ preventDefault: vi.fn() }));
    expect(screen.getByText('Couldn’t calculate this comparison.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText(/Loading comparison/)).toBeInTheDocument();
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    view.unmount();
    expect(workers[1].terminate).toHaveBeenCalledOnce();
    expect(diffLines).not.toHaveBeenCalled();
  });

  it('keeps short comparisons immediate and structured patches off the worker path', () => {
    const view = render(<UnifiedDiff oldStr="before" newStr="after" />);
    expect(screen.getByText('after')).toBeInTheDocument();
    view.rerender(<UnifiedDiff oldStr={large('old')} newStr={large('new')} structuredPatch={[{oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+provided patch']}]} />);
    expect(screen.getByText('provided patch')).toBeInTheDocument();
    expect(workers).toHaveLength(0);
  });
});

const bigHunk: StructuredPatchHunk = {
  oldStart: 1,
  oldLines: 0,
  newStart: 1,
  newLines: 40,
  lines: Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`),
};

describe('UnifiedDiff fill prop', () => {
  it('preserves gutter width at an EOF-newline digit boundary', () => {
    const text = Array.from({ length: 99 }, () => 'same').join('\n') + '\n';
    const { container } = render(<UnifiedDiff oldStr={text} newStr={text} />);
    expect((container.querySelector('.items-start > span') as HTMLElement).style.width).toBe('calc(3ch + 0.75rem)');
  });
  it('without fill: a long diff shows only the preview and a Show more button', () => {
    render(<UnifiedDiff oldStr="" newStr="" structuredPatch={[bigHunk]} />);
    expect(screen.getByText('Show 25 more lines')).toBeInTheDocument();
  });

  it('with fill: no Expand button and no maxHeight cap on the scroll container', () => {
    const { container } = render(
      <UnifiedDiff oldStr="" newStr="" structuredPatch={[bigHunk]} fill />
    );
    // The redundant inner button is gone — the host owns the height cap.
    expect(screen.queryByText(/more lines/)).not.toBeInTheDocument();
    // The diff container renders full-height (no inline maxHeight style).
    const diffBox = container.querySelector('.font-mono') as HTMLElement | null;
    expect(diffBox).not.toBeNull();
    expect(diffBox!.style.maxHeight).toBe('');
  });
});

// Two hunks so hunkBoundaries carries a real, non-zero index. Because every
// drawn slice (collapsed or the chunked reveal) always starts at row 0, `idx`
// inside `drawn.map` stays the ORIGINAL row index without re-indexing — this
// pins that alignment surviving both slice paths.
const twoHunks = (n1: number, n2: number): StructuredPatchHunk[] => [
  { oldStart: 1, oldLines: 0, newStart: 1, newLines: n1, lines: Array.from({ length: n1 }, (_, i) => `+A${i + 1}`) },
  { oldStart: n1 + 1, oldLines: 0, newStart: n1 + 1, newLines: n2, lines: Array.from({ length: n2 }, (_, i) => `+B${i + 1}`) },
];

describe('hunk separator stays aligned to the original row after slicing', () => {
  let io: ReturnType<typeof installFiringIntersectionObserver>;
  beforeEach(() => { io = installFiringIntersectionObserver(); });
  afterEach(() => io.restore());

  // The separator div and each row div are DOM siblings (React.Fragment adds
  // no wrapper), so "immediately precedes B1" is a real position check, not
  // just a presence count — a re-indexed slice keeps the same separator COUNT
  // but attaches it to the wrong row (proved by the break-it run below).
  const separatorPrecedes = (rowText: string) => {
    const row = screen.getByText(rowText).closest('.items-start');
    return row?.previousElementSibling?.textContent?.trim();
  };

  it('draws the separator before the row it belongs to when the second hunk starts inside the 15-row collapsed slice', () => {
    // Boundary at row 10 (0-indexed), inside the 15-row collapsed slice.
    render(<UnifiedDiff oldStr="" newStr="" structuredPatch={twoHunks(10, 10)} />);
    expect(screen.getAllByText('⋯')).toHaveLength(1);
    expect(separatorPrecedes('B1')).toBe('⋯');
    // A10 (the last row of hunk 1) is NOT preceded by the separator.
    expect(separatorPrecedes('A10')).not.toBe('⋯');
  });

  it('draws no separator while collapsed, then draws it once expanding reveals that row, when the second hunk starts past the 15-row slice', () => {
    // Boundary at row 20 (0-indexed), past the 15-row collapsed slice.
    const { container } = render(<UnifiedDiff oldStr="" newStr="" structuredPatch={twoHunks(20, 10)} />);
    expect(screen.queryByText('⋯')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/more lines/));
    act(() => io.fireAll());
    expect(container.querySelectorAll('.font-mono')).not.toHaveLength(0);
    expect(screen.getAllByText('⋯')).toHaveLength(1);
    expect(separatorPrecedes('B1')).toBe('⋯');
    expect(separatorPrecedes('A20')).not.toBe('⋯');
  });
});

const hunkOf = (n: number): StructuredPatchHunk => ({
  oldStart: 1,
  oldLines: 0,
  newStart: 1,
  newLines: n,
  lines: Array.from({ length: n }, (_, i) => `+line ${i + 1}`),
});

// Rows are the box's flex children; the 1px reveal sentinel is not a row.
const box = (c: HTMLElement) => c.querySelector('.font-mono') as HTMLElement;
const rowCount = (c: HTMLElement) => box(c).querySelectorAll(':scope > div.flex').length;

describe('UnifiedDiff long diffs draw a slice, then scroll in chunks', () => {
  let io: ReturnType<typeof installFiringIntersectionObserver>;
  beforeEach(() => { io = installFiringIntersectionObserver(); });
  afterEach(() => io.restore());

  it('collapsed draws only the first 15 rows; expanded fills a capped scroller 200 rows at a time; Show less drops back', () => {
    const { container } = render(<UnifiedDiff oldStr="" newStr="" structuredPatch={[hunkOf(5000)]} />);
    expect(rowCount(container)).toBe(15);
    expect(box(container).className).not.toContain('scroll-box-cap');
    fireEvent.click(screen.getByText('Show 4985 more lines'));
    expect(rowCount(container)).toBe(200);
    expect(box(container).className).toContain('scroll-box-cap');
    act(() => io.fireAll());
    expect(rowCount(container)).toBe(400);
    fireEvent.click(screen.getByText('Show less'));
    expect(rowCount(container)).toBe(15);
    // Re-opening starts from one chunk again: the revealed rows were released.
    fireEvent.click(screen.getByText('Show 4985 more lines'));
    expect(rowCount(container)).toBe(200);
  });

  it('a short diff draws every row with no button and no sentinel', () => {
    const { container } = render(<UnifiedDiff oldStr="" newStr="" structuredPatch={[hunkOf(10)]} />);
    expect(rowCount(container)).toBe(10);
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('[data-reveal-sentinel]')).toBeNull();
  });

  it('fill mode has no button or cap and grows 200 rows at a time as the host scrolls', () => {
    const { container } = render(<UnifiedDiff oldStr="" newStr="" structuredPatch={[hunkOf(5000)]} fill />);
    expect(rowCount(container)).toBe(200);
    expect(screen.queryByRole('button')).toBeNull();
    expect(box(container).className).not.toContain('scroll-box-cap');
    act(() => io.fireAll());
    expect(rowCount(container)).toBe(400);
  });
});
