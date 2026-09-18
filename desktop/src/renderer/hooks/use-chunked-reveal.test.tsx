// @vitest-environment jsdom
import React, { useRef } from 'react';
import { render, act } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { useChunkedReveal, REVEAL_CHUNK } from './use-chunked-reveal';
import { installFiringIntersectionObserver } from '../../../tests/helpers/firing-intersection-observer';

function List({ n, q, active = true, alt = false, keepScroll = false }: { n: number; q: string; active?: boolean; alt?: boolean; keepScroll?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const items = Array.from({ length: n }, (_, i) => i);
  const r = useChunkedReveal(items, { resetKey: q, rootRef: root, active, resetScrollOnActivate: !keepScroll });
  return (
    <div ref={root} data-testid="root">
      {r.visible.map((i) => <div key={i} data-row />)}
      {/* alt swaps the sentinel ELEMENT (what grid ↔ list view does in FilesTab). */}
      {r.hasMore && (alt
        ? <span key="alt" ref={r.sentinelRef} data-sentinel />
        : <div key="main" ref={r.sentinelRef} data-sentinel />)}
    </div>
  );
}
const rows = (c: HTMLElement) => c.querySelectorAll('[data-row]').length;

describe('useChunkedReveal', () => {
  let io: ReturnType<typeof installFiringIntersectionObserver>;
  afterEach(() => io?.restore());

  it('draws one chunk of a long list', () => {
    io = installFiringIntersectionObserver();
    const { container } = render(<List n={2000} q="" />);
    expect(rows(container)).toBe(REVEAL_CHUNK);
  });

  it('adds a chunk each time the sentinel is reached', () => {
    io = installFiringIntersectionObserver();
    const { container } = render(<List n={2000} q="" />);
    act(() => io.fireAll());
    expect(rows(container)).toBe(REVEAL_CHUNK * 2);
  });

  it('draws a short list whole, with no sentinel', () => {
    io = installFiringIntersectionObserver();
    const { container } = render(<List n={12} q="" />);
    expect(rows(container)).toBe(12);
    expect(container.querySelector('[data-sentinel]')).toBeNull();
  });

  it('resets to one chunk on a new query, in the same render', () => {
    io = installFiringIntersectionObserver();
    const { container, rerender } = render(<List n={2000} q="a" />);
    act(() => io.fireAll()); act(() => io.fireAll());
    expect(rows(container)).toBe(REVEAL_CHUNK * 3);
    rerender(<List n={2000} q="b" />);
    expect(rows(container)).toBe(REVEAL_CHUNK);
  });

  it('keeps the window when only the items change (tagging a row must not collapse the list)', () => {
    io = installFiringIntersectionObserver();
    const { container, rerender } = render(<List n={2000} q="a" />);
    act(() => io.fireAll());
    rerender(<List n={2001} q="a" />);
    expect(rows(container)).toBe(REVEAL_CHUNK * 2);
  });

  it('does not grow while inactive', () => {
    io = installFiringIntersectionObserver();
    const { container } = render(<List n={2000} q="" active={false} />);
    act(() => io.fireAll());
    expect(rows(container)).toBe(REVEAL_CHUNK);
  });

  it('keeps growing after the sentinel element is replaced (count unchanged)', () => {
    io = installFiringIntersectionObserver();
    const { container, rerender } = render(<List n={2000} q="" />);
    rerender(<List n={2000} q="" alt />);
    act(() => io.fireAll());
    expect(rows(container)).toBe(REVEAL_CHUNK * 2);
  });

  it('scrolls to the top on a new query, and on re-activation only when asked to', () => {
    io = installFiringIntersectionObserver();
    const { getByTestId, rerender } = render(<List n={2000} q="a" keepScroll />);
    const root = getByTestId('root');
    root.scrollTop = 120;
    rerender(<List n={2000} q="a" keepScroll active={false} />);
    rerender(<List n={2000} q="a" keepScroll />);
    expect(root.scrollTop).toBe(120);            // hidden and shown again: untouched
    rerender(<List n={2000} q="b" keepScroll />);
    expect(root.scrollTop).toBe(0);              // a new query always starts at the top
    root.scrollTop = 120;
    rerender(<List n={2000} q="b" active={false} />);
    rerender(<List n={2000} q="b" />);
    expect(root.scrollTop).toBe(0);              // default: a reopened panel starts at the top
  });

  it('reveals everything when IntersectionObserver does not exist', () => {
    const prev = (globalThis as any).IntersectionObserver;
    delete (globalThis as any).IntersectionObserver;
    try {
      const { container } = render(<List n={300} q="" />);
      expect(rows(container)).toBe(300);
    } finally { (globalThis as any).IntersectionObserver = prev; }
  });
});
