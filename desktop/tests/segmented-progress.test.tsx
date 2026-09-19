// @vitest-environment jsdom
//
// Pins components/ui/SegmentedProgress.tsx — the bar made of parts, added for
// the plan card's proposed state (a plan whose shape is "three at once, then
// one, then one" cannot be a percentage).
//
// What is pinned, and why each one would be a real regression:
//  * one segment per part, each as wide as its weight — the widths ARE the
//    information; equal segments would say every step is the same size;
//  * the accent paints only a segment that is finished or running (G-8:
//    accent is state, never decoration), so an unstarted bar carries none;
//  * a pending segment is the app's resting inset container (inset fill,
//    edge-dim border), not a filled block;
//  * the bar reports its progress as a progressbar with the caller's name, so
//    the same object can say "none finished" before approval and "2 of 3"
//    while it runs.
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SegmentedProgress, type ProgressSegment } from '../src/renderer/components/ui/SegmentedProgress';

afterEach(cleanup);

const STEPS: ProgressSegment[] = [
  { id: 's1', weight: 3, label: 'Step 1 · 3 reviewers' },
  { id: 's2', weight: 1, label: 'Step 2 · 1 reviewer' },
  { id: 's3', weight: 1, label: 'Step 3 · 1 worker' },
];

function segments(): HTMLElement[] {
  return Array.from(screen.getByRole('progressbar').children) as HTMLElement[];
}

describe('SegmentedProgress', () => {
  it('draws one segment per part, each as wide as its weight', () => {
    render(<SegmentedProgress segments={STEPS} aria-label="Plan shape" />);
    const parts = segments();
    expect(parts).toHaveLength(3);
    expect(parts.map((p) => p.style.flexGrow)).toEqual(['3', '1', '1']);
    // Weights alone decide the widths: an `auto` basis would let borders and
    // gaps into the ratio and bend the shape the bar is there to show.
    expect(parts.every((p) => p.style.flexBasis === '0px' || p.style.flexBasis === '0')).toBe(true);
    expect(parts.map((p) => p.getAttribute('title'))).toEqual(STEPS.map((s) => s.label));
  });

  it('gives a missing, zero or nonsense weight the minimum width', () => {
    render(
      <SegmentedProgress
        aria-label="Plan shape"
        segments={[
          { id: 'a', label: 'a' },
          { id: 'b', weight: 0, label: 'b' },
          { id: 'c', weight: Number.NaN, label: 'c' },
          { id: 'd', weight: 4, label: 'd' },
        ]}
      />,
    );
    expect(segments().map((p) => p.style.flexGrow)).toEqual(['1', '1', '1', '4']);
  });

  it('paints the accent only where there is state to show (G-8)', () => {
    render(
      <SegmentedProgress
        aria-label="Plan shape"
        segments={[
          { id: 's1', weight: 3, state: 'done', label: 'Step 1' },
          { id: 's2', state: 'running', label: 'Step 2' },
          { id: 's3', state: 'pending', label: 'Step 3' },
        ]}
      />,
    );
    const [done, running, pending] = segments();
    expect(done.className).toContain('bg-accent');
    expect(running.className).toContain('bg-accent/25');
    expect(pending.className).not.toContain('accent');
    // An unstarted segment is the resting inset container, not a filled block.
    expect(pending.className).toContain('bg-inset');
    expect(pending.className).toContain('border-edge-dim');
  });

  it('carries no accent at all before anything has started', () => {
    render(<SegmentedProgress segments={STEPS} aria-label="Plan shape" />);
    expect(segments().every((p) => !p.className.includes('accent'))).toBe(true);
  });

  it('reports progress as how many parts are finished, under the caller name', () => {
    const { rerender } = render(<SegmentedProgress segments={STEPS} aria-label="Plan shape — nothing finished" />);
    const bar = () => screen.getByRole('progressbar');
    expect(bar()).toHaveAttribute('aria-label', 'Plan shape — nothing finished');
    expect(bar()).toHaveAttribute('aria-valuenow', '0');
    expect(bar()).toHaveAttribute('aria-valuemin', '0');
    expect(bar()).toHaveAttribute('aria-valuemax', '3');

    rerender(
      <SegmentedProgress
        aria-label="Plan shape — 2 of 3 done"
        segments={STEPS.map((s, i) => (i < 2 ? { ...s, state: 'done' as const } : s))}
      />,
    );
    expect(bar()).toHaveAttribute('aria-valuenow', '2');
  });
});
