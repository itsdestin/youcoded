// @vitest-environment jsdom
// unified-diff-fill.test.tsx — pins the `fill` prop that the git review
// timeline relies on (2026-07-23). The review wraps each diff in its own
// 45vh scroll box; UnifiedDiff's internal 15-line preview cap + "Expand"
// button would stack a second, redundant scrollbar inside that box and the
// "Expand" click barely moved anything. `fill` must suppress BOTH the cap and
// the button so the host is the sole scroll surface — this test is the guard
// against that regressing back to the nested-scroll jank Destin reported.
import React from 'react';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { UnifiedDiff } from '../src/renderer/components/diff/UnifiedDiff';
import type { StructuredPatchHunk } from '../src/shared/types';
import { installFiringIntersectionObserver } from './helpers/firing-intersection-observer';

afterEach(cleanup);

// A hunk with far more than DIFF_PREVIEW_LINES (15) rows, so the internal cap
// + Expand button WOULD appear without `fill`.
const bigHunk: StructuredPatchHunk = {
  oldStart: 1,
  oldLines: 0,
  newStart: 1,
  newLines: 40,
  lines: Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`),
};

describe('UnifiedDiff fill prop', () => {
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
    expect(box(container).className).not.toContain('max-h-[45vh]');
    fireEvent.click(screen.getByText('Show 4985 more lines'));
    expect(rowCount(container)).toBe(200);
    expect(box(container).className).toContain('max-h-[45vh]');
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
    expect(box(container).className).not.toContain('max-h-[45vh]');
    act(() => io.fireAll());
    expect(rowCount(container)).toBe(400);
  });
});
