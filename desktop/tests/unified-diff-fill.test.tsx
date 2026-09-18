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
