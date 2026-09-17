// @vitest-environment jsdom
// Find-in-document walks the text nodes when the QUERY changes, not when the
// user steps to the next match (2026-09-16 audit W22). On a fully read
// conversation the walk is ~1.4M nodes, so a next-match that re-walked cost as
// much as retyping the search.
import React, { useRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, screen, act } from '@testing-library/react';
import { ContentFindBar } from '../src/renderer/components/ContentFindBar';

// jsdom has neither the CSS Custom Highlight API nor a Range that can measure
// itself. Stand in a registry that records what was set.
class FakeHighlight {
  ranges: Range[];
  constructor(...ranges: Range[]) { this.ranges = ranges; }
}

function Harness() {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div ref={ref} data-testid="searched">
        <p>alpha beta</p>
        <p>beta gamma beta</p>
      </div>
      <ContentFindBar containerRef={ref} onClose={() => {}} resetKey="doc-1" />
    </div>
  );
}

describe('ContentFindBar and the text-node walk', () => {
  let highlights: Map<string, FakeHighlight>;

  beforeEach(() => {
    highlights = new Map();
    (globalThis as any).CSS = { highlights };
    (window as any).Highlight = FakeHighlight;
    Range.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 10, left: 0, right: 10, width: 10, height: 10, x: 0, y: 0, toJSON() {} } as DOMRect);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete (globalThis as any).CSS;
    delete (window as any).Highlight;
  });

  it('walks once per query and not at all when stepping to the next match', async () => {
    render(<Harness />);
    // Resolve every element first: Testing Library's own queries walk the DOM
    // too, and they must not be counted against the component.
    const input = screen.getByLabelText('Find in document');
    const next = screen.getByLabelText('Next (Enter)');
    const prev = screen.getByLabelText('Previous (Shift+Enter)');
    const walker = vi.spyOn(document, 'createTreeWalker');

    fireEvent.change(input, { target: { value: 'beta' } });
    expect(walker).toHaveBeenCalledTimes(1);
    expect(highlights.get('artifact-find')!.ranges).toHaveLength(3);
    const first = highlights.get('artifact-find-current')!.ranges[0];
    expect(screen.getByText('1/3')).toBeTruthy();

    walker.mockClear();
    await act(async () => { fireEvent.click(next); });
    expect(walker).not.toHaveBeenCalled();
    // The current highlight moved to a different range without a re-walk.
    const second = highlights.get('artifact-find-current')!.ranges[0];
    expect(second).not.toBe(first);
    expect(second.startOffset).not.toBe(first.startOffset);
    expect(screen.getByText('2/3')).toBeTruthy();

    walker.mockClear();
    await act(async () => { fireEvent.click(prev); });
    expect(walker).not.toHaveBeenCalled();
    expect(screen.getByText('1/3')).toBeTruthy();
  });

  it('text that arrives after the query (a streaming reply) is found by Next, with the count updated', async () => {
    render(<Harness />);
    const input = screen.getByLabelText('Find in document');
    const next = screen.getByLabelText('Next (Enter)');
    const searched = screen.getByTestId('searched');
    fireEvent.change(input, { target: { value: 'beta' } });
    expect(screen.getByText('1/3')).toBeTruthy();

    // A fourth match streams in below the searched content. (The spy is armed
    // AFTER the append: jsdom walks the tree itself when a node is inserted.)
    await act(async () => {
      const p = document.createElement('p');
      p.textContent = 'delta beta';
      searched.appendChild(p);
      await Promise.resolve(); // let the MutationObserver deliver
    });
    expect(screen.getByText('1/3')).toBeTruthy(); // no walk until the user asks for a match
    const walker = vi.spyOn(document, 'createTreeWalker');

    await act(async () => { fireEvent.click(next); });
    expect(walker).toHaveBeenCalledTimes(1);
    expect(screen.getByText('2/4')).toBeTruthy();
    expect(highlights.get('artifact-find')!.ranges).toHaveLength(4);

    // Stepping on to the streamed-in match reaches it, and needs no further walk.
    walker.mockClear();
    await act(async () => { fireEvent.click(next); });
    await act(async () => { fireEvent.click(next); });
    expect(walker).not.toHaveBeenCalled(); // checked BEFORE getByText, which walks the DOM itself
    expect(screen.getByText('4/4')).toBeTruthy();
    expect(highlights.get('artifact-find-current')!.ranges[0].startContainer.textContent).toBe('delta beta');
  });

  it('a new query with the same match count still repaints the current highlight from the new ranges', () => {
    render(<Harness />);
    const input = screen.getByLabelText('Find in document');
    fireEvent.change(input, { target: { value: 'beta' } });
    const betaFirst = highlights.get('artifact-find-current')!.ranges[0];
    expect(betaFirst.toString()).toBe('beta');
    // "a" also occurs three times? No — pick a query with exactly three hits: "gamma"
    // has one. Use "et" (in each "beta"): three hits, same count as "beta".
    fireEvent.change(input, { target: { value: 'et' } });
    expect(screen.getByText('1/3')).toBeTruthy();
    const etFirst = highlights.get('artifact-find-current')!.ranges[0];
    expect(etFirst).not.toBe(betaFirst);
    expect(etFirst.toString()).toBe('et');
  });
});
