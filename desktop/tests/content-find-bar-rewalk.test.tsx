// @vitest-environment jsdom
// Find-in-document walks the text nodes when the QUERY changes, not when the
// user steps to the next match (2026-09-16 audit W22). On a fully read
// conversation the walk is ~1.4M nodes, so a next-match that re-walked cost as
// much as retyping the search.
import React, { useRef, useState } from 'react';
import { resolveBodyRanges } from '../src/renderer/components/chat-message-find';
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

  it('recentres a jumped-to match after neighboring rows change its geometry', async () => {
    const ref = React.createRef<HTMLDivElement>();
    let top = 2000;
    const scroll = vi.fn(() => { top = 400; });
    Range.prototype.getBoundingClientRect = () => ({ top, bottom: top + 20, left: 0, right: 100, width: 100, height: 20 } as DOMRect);
    render(<><div ref={ref}><span data-message-find-body="0">needle</span></div>
      <ContentFindBar containerRef={ref} onClose={() => {}} resetKey="chat" chatFind={{
        search: () => ({ hits: [{ id: 'a', body: 0, ordinal: 0 }], pending: false }),
        pin: () => () => {},
        resolve: async (_hit, query) => resolveBodyRanges(ref.current!.firstElementChild as HTMLElement, query)[0],
        afterScroll: () => { top = 950; },
      }} /></>);
    ref.current!.getBoundingClientRect = () => ({ top: 100, bottom: 1000 } as DOMRect);
    ref.current!.firstElementChild!.scrollIntoView = scroll;
    fireEvent.change(screen.getByLabelText('Find in document'), { target: { value: 'needle' } });
    await vi.waitFor(() => expect(scroll).toHaveBeenCalledTimes(2));
    expect(top).toBe(400);
  });

  it('re-centres after a later content resize shifts the selected Range beneath the input chrome', async () => {
    const original = globalThis.ResizeObserver;
    const callbacks: Array<() => void> = [];
    (globalThis as any).ResizeObserver = class {
      constructor(cb: () => void) { callbacks.push(cb); }
      observe() {} disconnect() {} unobserve() {}
    };
    const ref = React.createRef<HTMLDivElement>();
    let top = 2000;
    const scroll = vi.fn(() => { top = 450; });
    Range.prototype.getBoundingClientRect = () => ({ top, bottom: top + 20, left: 0, right: 100, width: 100, height: 20 } as DOMRect);
    const view = render(<><div ref={ref}><span data-message-find-body="0">needle</span></div>
      <ContentFindBar containerRef={ref} onClose={() => {}} resetKey="chat" chatFind={{
        search: () => ({ hits: [{ id: 'a', body: 0, ordinal: 0 }], pending: false }),
        pin: () => () => {},
        resolve: async (_hit, query) => resolveBodyRanges(ref.current!.firstElementChild as HTMLElement, query)[0],
      }} /></>);
    ref.current!.getBoundingClientRect = () => ({ top: 100, bottom: 1000 } as DOMRect);
    ref.current!.firstElementChild!.scrollIntoView = scroll;
    fireEvent.change(screen.getByLabelText('Find in document'), { target: { value: 'needle' } });
    await vi.waitFor(() => expect(scroll).toHaveBeenCalledTimes(2));
    top = 950; // browser scroll anchoring AFTER both synchronous recenter calls
    await act(async () => { callbacks.forEach((cb) => cb()); await Promise.resolve(); });
    await vi.waitFor(() => expect(scroll).toHaveBeenCalledTimes(3));
    expect(top).toBe(450);
    view.unmount(); globalThis.ResizeObserver = original;
  });

  it('settles an RO-displaced match when expiry beats its queued animation frame', async () => {
    const nativeRO = globalThis.ResizeObserver;
    const nativeRaf = globalThis.requestAnimationFrame;
    const nativeCancel = globalThis.cancelAnimationFrame;
    const deliveries: Array<{ callback: () => void; target?: Element; disconnected?: boolean }> = [];
    const frames = new Map<number, FrameRequestCallback>();
    const cancelled: number[] = [];
    let frameId = 0, disconnected = 0;
    (globalThis as any).ResizeObserver = class {
      private delivery: { callback: () => void; target?: Element; disconnected?: boolean };
      constructor(cb: () => void) { this.delivery = { callback: cb }; deliveries.push(this.delivery); }
      observe(target: Element) { this.delivery.target = target; }
      unobserve() {} disconnect() { this.delivery.disconnected = true; disconnected++; }
    };
    globalThis.requestAnimationFrame = (cb) => { const id = ++frameId; frames.set(id, cb); return id; };
    globalThis.cancelAnimationFrame = (id) => { cancelled.push(id); frames.delete(id); };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const ref = React.createRef<HTMLDivElement>();
      let top = 2000;
      const scroll = vi.fn(() => { top = 450; });
      Range.prototype.getBoundingClientRect = () => ({ top, bottom: top + 20, left: 0, right: 100 } as DOMRect);
      const view = render(<><div ref={ref}><span data-message-find-body="0">needle</span></div>
        <ContentFindBar containerRef={ref} onClose={() => {}} resetKey="chat" chatFind={{
          search: () => ({ hits: [{ id: 'a', body: 0, ordinal: 0 }], pending: false }),
          pin: () => () => {},
          resolve: async (_hit, query) => resolveBodyRanges(ref.current!.firstElementChild as HTMLElement, query)[0],
        }} /></>);
      ref.current!.getBoundingClientRect = () => ({ top: 100, bottom: 1000 } as DOMRect);
      ref.current!.firstElementChild!.scrollIntoView = scroll;
      await act(async () => { fireEvent.change(screen.getByLabelText('Find in document'), { target: { value: 'needle' } }); await Promise.resolve(); });
      const findDelivery = deliveries.find((delivery) => delivery.target === ref.current && !delivery.disconnected);
      expect(findDelivery).toBeDefined();
      expect(scroll).toHaveBeenCalledTimes(2);
      top = 950; // layout moved the Range below the visible band's midpoint
      act(() => { findDelivery!.callback(); });
      expect(frames.size).toBe(1);
      act(() => { vi.advanceTimersByTime(800); }); // held rAF never runs
      expect(cancelled).toEqual([1]);
      expect(scroll).toHaveBeenCalledTimes(3);
      expect(top).toBe(450);
      expect(findDelivery!.disconnected).toBe(true);
      top = 950;
      act(() => { findDelivery!.callback(); vi.advanceTimersByTime(800); });
      expect(scroll).toHaveBeenCalledTimes(3); // expiry cannot restart tracking
      view.unmount();
    } finally {
      vi.useRealTimers();
      globalThis.ResizeObserver = nativeRO;
      globalThis.requestAnimationFrame = nativeRaf;
      globalThis.cancelAnimationFrame = nativeCancel;
    }
  });

  it('cancels a queued Find correction on wheel intent rather than flushing it at expiry', async () => {
    const nativeRO = globalThis.ResizeObserver;
    const nativeRaf = globalThis.requestAnimationFrame;
    const nativeCancel = globalThis.cancelAnimationFrame;
    let findDelivery: (() => void) | undefined;
    const frames = new Map<number, FrameRequestCallback>();
    const cancelled: number[] = [];
    (globalThis as any).ResizeObserver = class {
      constructor(private cb: () => void) {}
      observe(target: Element) { if (target === ref.current) findDelivery = this.cb; }
      unobserve() {} disconnect() {}
    };
    globalThis.requestAnimationFrame = (cb) => { frames.set(1, cb); return 1; };
    globalThis.cancelAnimationFrame = (id) => { cancelled.push(id); frames.delete(id); };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ref = React.createRef<HTMLDivElement>();
    try {
      let top = 2000;
      const scroll = vi.fn(() => { top = 450; });
      Range.prototype.getBoundingClientRect = () => ({ top, bottom: top + 20, left: 0, right: 100 } as DOMRect);
      const view = render(<><div ref={ref}><span data-message-find-body="0">needle</span></div>
        <ContentFindBar containerRef={ref} onClose={() => {}} resetKey="chat" chatFind={{
          search: () => ({ hits: [{ id: 'a', body: 0, ordinal: 0 }], pending: false }),
          pin: () => () => {},
          resolve: async (_hit, query) => resolveBodyRanges(ref.current!.firstElementChild as HTMLElement, query)[0],
        }} /></>);
      ref.current!.getBoundingClientRect = () => ({ top: 100, bottom: 1000 } as DOMRect);
      ref.current!.firstElementChild!.scrollIntoView = scroll;
      await act(async () => { fireEvent.change(screen.getByLabelText('Find in document'), { target: { value: 'needle' } }); await Promise.resolve(); });
      expect(findDelivery).toBeDefined();
      expect(scroll).toHaveBeenCalledTimes(2);
      top = 950;
      act(() => { findDelivery!(); });
      expect(frames.size).toBe(1);
      fireEvent.wheel(ref.current!, { deltaY: -100 });
      act(() => { vi.advanceTimersByTime(800); });
      expect(cancelled).toEqual([1]);
      expect(scroll).toHaveBeenCalledTimes(2);
      expect(top).toBe(950);
      view.unmount();
    } finally {
      vi.useRealTimers();
      globalThis.ResizeObserver = nativeRO;
      globalThis.requestAnimationFrame = nativeRaf;
      globalThis.cancelAnimationFrame = nativeCancel;
    }
  });

  it('chat adapter leaves other folded rows alone, pins only the chosen row and releases on close', async () => {
    const releases = vi.fn();
    const revealNearby = vi.fn();
    function ChatHarness() {
      const ref = useRef<HTMLDivElement>(null);
      const [folded, setFolded] = useState(true);
      return <div>
        <div ref={ref}><div data-entry-key="other" data-testid="other" />
          <div data-entry-key="target" data-testid="target">{!folded && <span data-message-find-body="0">hello <b>world</b></span>}</div></div>
        <ContentFindBar containerRef={ref} onClose={() => setFolded(true)} resetKey="chat" highlightName="chat-find" chatFind={{
          search: () => ({ hits: [{ id: 'target', body: 0, ordinal: 0 }], pending: false }),
          pin: () => { setFolded(false); return releases; },
          afterScroll: revealNearby,
          resolve: async (_hit, query) => {
            await vi.waitFor(() => expect(ref.current?.querySelector('[data-message-find-body]')).toBeTruthy());
            return resolveBodyRanges(ref.current!.querySelector('[data-message-find-body]')!, query)[0] ?? null;
          },
        }} />
      </div>;
    }
    render(<ChatHarness />);
    fireEvent.change(screen.getByLabelText('Find in document'), { target: { value: 'hello world' } });
    await vi.waitFor(() => expect(highlights.get('chat-find-current')?.ranges[0].toString()).toBe('hello world'));
    expect(screen.getByText('1/1')).toBeTruthy();
    expect(revealNearby).toHaveBeenCalled(); // no 100ms intersection debounce after search scroll
    expect(screen.getByTestId('other').querySelector('[data-message-find-body]')).toBeNull();
    cleanup();
    expect(releases).toHaveBeenCalled();
  });

  it('highlights a newly revealed neighboring message without restarting source search', async () => {
    const ref = React.createRef<HTMLDivElement>();
    const sourceSearch = vi.fn(() => ({ hits: [{ id: 'a', body: 0, ordinal: 0 }, { id: 'b', body: 0, ordinal: 0 }], pending: false }));
    function Box() {
      const [near, setNear] = useState(false);
      return <><div ref={ref}><div data-entry-key="a"><span data-message-find-body="0">hello</span></div>
        <div data-entry-key="b">{near && <span data-message-find-body="0">hello</span>}</div></div>
        <ContentFindBar containerRef={ref} onClose={() => {}} resetKey="chat" highlightName="chat-find" chatFind={{
          search: sourceSearch, pin: () => () => {},
          resolve: async (_hit, query) => resolveBodyRanges(ref.current!.querySelector('[data-entry-key="a"] [data-message-find-body]')!, query)[0],
          afterScroll: () => setNear(true),
        }} />
      </>;
    }
    render(<Box />);
    fireEvent.change(screen.getByLabelText('Find in document'), { target: { value: 'hello' } });
    await vi.waitFor(() => expect(highlights.get('chat-find')?.ranges).toHaveLength(2));
    expect(sourceSearch).toHaveBeenCalledTimes(2); // initial empty query and active query only
    expect(highlights.get('chat-find-current')?.ranges).toHaveLength(1);
  });

  it('a selected hit resolving after the first commit retries once without a keypress', async () => {
    const ref = React.createRef<HTMLDivElement>();
    let calls = 0;
    render(<><div ref={ref}><div data-entry-key="a"><span data-message-find-body="0">hello</span></div></div>
      <ContentFindBar containerRef={ref} onClose={() => {}} resetKey="chat" highlightName="chat-find" chatFind={{
        search: () => ({ hits: [{ id: 'a', body: 0, ordinal: 0 }], pending: false }),
        pin: () => () => {},
        resolve: async (_hit, query) => ++calls === 1 ? null : resolveBodyRanges(ref.current!.querySelector('[data-message-find-body]')!, query)[0],
      }} /></>);
    fireEvent.change(screen.getByLabelText('Find in document'), { target: { value: 'hello' } });
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => expect(highlights.get('chat-find-current')?.ranges[0].toString()).toBe('hello'));
    expect(screen.getByText('1/1')).toBeTruthy();
  });

  it('keeps counter blank through async search and discards an older query after close', async () => {
    const ref = React.createRef<HTMLDivElement>();
    const pendingSearch: Array<{ query: string; signal: AbortSignal; done: (hits: { hits: { id: string; body: number; ordinal: number }[]; pending: boolean }) => void }> = [];
    const adapter = {
      search: (query: string, signal: AbortSignal) => query ? new Promise<{ hits: { id: string; body: number; ordinal: number }[]; pending: boolean }>((done) => pendingSearch.push({ query, signal, done })) : { hits: [], pending: false },
      pin: vi.fn(() => () => {}), resolve: async () => null,
    };
    function Box() { const [open, setOpen] = useState(true); return <><div ref={ref} />{open && <ContentFindBar containerRef={ref} onClose={() => setOpen(false)} resetKey="chat" chatFind={adapter} />}</>; }
    render(<Box />);
    const input = screen.getByLabelText('Find in document');
    fireEvent.change(input, { target: { value: 'old' } });
    expect(screen.queryByText('0/0')).toBeNull();
    fireEvent.change(input, { target: { value: 'new' } });
    expect(pendingSearch[0].signal.aborted).toBe(true);
    await act(async () => { pendingSearch[0].done({ hits: [{ id: 'a', body: 0, ordinal: 0 }], pending: false }); });
    expect(screen.queryByText('1/1')).toBeNull();
    fireEvent.click(screen.getByLabelText('Close (Esc)'));
    expect(pendingSearch[1].signal.aborted).toBe(true);
    await act(async () => { pendingSearch[1].done({ hits: [{ id: 'b', body: 0, ordinal: 0 }], pending: false }); });
    expect(adapter.pin).not.toHaveBeenCalled();
  });

  it('chat navigation wraps across message bodies and refreshes after streaming/removal', async () => {
    const ref = React.createRef<HTMLDivElement>();
    const source = { hits: [{ id: 'first', body: 0, ordinal: 0 }, { id: 'second', body: 0, ordinal: 0 }] };
    const adapter = {
      search: vi.fn(() => ({ hits: source.hits, pending: false })),
      pin: vi.fn(() => () => {}),
      resolve: async (hit: { id: string }, query: string) => resolveBodyRanges(ref.current!.querySelector(`[data-entry-key="${hit.id}"] [data-message-find-body]`)!, query)[0] ?? null,
    };
    render(<><div ref={ref}>
      <div data-entry-key="first"><span data-message-find-body="0">beta</span></div>
      <div data-entry-key="second"><span data-message-find-body="0">beta</span></div>
    </div><ContentFindBar containerRef={ref} onClose={() => {}} resetKey="chat" highlightName="chat-find" chatFind={adapter} /></>);
    fireEvent.change(screen.getByLabelText('Find in document'), { target: { value: 'beta' } });
    await vi.waitFor(() => expect(screen.getByText('1/2')).toBeTruthy());
    await vi.waitFor(() => expect(highlights.get('chat-find')?.ranges).toHaveLength(2));
    expect(highlights.get('chat-find-current')?.ranges).toHaveLength(1);
    const searchesBeforeNext = adapter.search.mock.calls.length;
    fireEvent.click(screen.getByLabelText('Next (Enter)'));
    await vi.waitFor(() => expect(screen.getByText('2/2')).toBeTruthy());
    expect(adapter.search).toHaveBeenCalledTimes(searchesBeforeNext);
    fireEvent.click(screen.getByLabelText('Next (Enter)'));
    await vi.waitFor(() => expect(screen.getByText('1/2')).toBeTruthy());
    source.hits = [{ id: 'second', body: 0, ordinal: 0 }];
    await act(async () => { ref.current!.querySelector('[data-entry-key="first"]')!.remove(); await Promise.resolve(); });
    fireEvent.click(screen.getByLabelText('Next (Enter)'));
    await vi.waitFor(() => expect(screen.getByText('1/1')).toBeTruthy());
    expect(adapter.search).toHaveBeenCalled();
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
