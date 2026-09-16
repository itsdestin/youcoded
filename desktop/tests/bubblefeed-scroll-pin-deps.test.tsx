// @vitest-environment jsdom
// The buddy window's twin of tests/chatview-scroll-pin-deps.test.tsx.
//
// BubbleFeed's auto-scroll effect calls scrollToBottom(), which READS
// scrollHeight and WRITES scrollTop on the feed's scroll container. Reading
// scrollHeight right after a commit whose DOM is still dirty forces a
// synchronous layout of the whole document. That effect used to depend on
// state.lastActivityAt — a timestamp the reducer re-stamps on EVERY streamed
// delta (and on tool events, heartbeats, …) — so a buddy window watching a
// streaming session paid one forced reflow per token. Identical to the ChatView
// defect fixed in perf cycle 1 on 2026-08-27; this twin was left in place then
// because BubbleFeed had no ResizeObserver to take over the re-pinning.
// Investigation: docs/active/investigations/2026-09-01-buddy-bubblefeed-reflow-per-token.md
//
// This file pins BOTH halves of the fix, because half of it alone is a
// regression: dropping the timestamp dep without the observer would stop
// auto-scroll mid-stream, and no assertion about dependency arrays would notice.
//
//   1. a state change that touches only the timestamps (and the live turn's
//      object) must not read the scroll container's geometry;
//   2. a change that appends a timeline entry, or flips the thinking indicator,
//      still must;
//   3. the ResizeObserver on the content wrapper re-pins on growth — and stays
//      out of the way once the user has scrolled up.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ state: {} as any }));

vi.mock('../src/renderer/state/chat-context', () => ({
  useChatState: () => mocks.state,
  useChatDispatch: () => vi.fn(),
}));

vi.mock('../src/renderer/state/theme-context', () => ({
  useTheme: () => ({ showTimestamps: false }),
}));

vi.mock('../src/renderer/components/MarkdownContent', () => ({
  default: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

// ---- controllable observers ------------------------------------------------
// setup-dom.ts installs an INERT ResizeObserver stub for the whole suite; this
// file needs one it can actually fire, so it stubs over it. Same shape as
// WideViewToggle.test.tsx's.
class ControlledResizeObserver {
  static instances: ControlledResizeObserver[] = [];
  target: Element | null = null;
  disconnect = vi.fn();
  constructor(private readonly cb: ResizeObserverCallback) {
    ControlledResizeObserver.instances.push(this);
  }
  observe(el: Element) { this.target = el; }
  unobserve() {}
  fire() { this.cb([], this as unknown as ResizeObserver); }
}

class ControlledIntersectionObserver {
  static instances: ControlledIntersectionObserver[] = [];
  constructor(private readonly cb: IntersectionObserverCallback) {
    ControlledIntersectionObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
  fire(isIntersecting: boolean) {
    this.cb([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

beforeEach(() => {
  ControlledResizeObserver.instances = [];
  ControlledIntersectionObserver.instances = [];
  vi.stubGlobal('ResizeObserver', ControlledResizeObserver);
  vi.stubGlobal('IntersectionObserver', ControlledIntersectionObserver);
  // BubbleFeed owns its own IPC subscriptions (it runs in a separate renderer
  // from App.tsx, so nothing wires them for it). No event is ever delivered
  // here — the tests drive state through the mocked useChatState instead.
  (window as any).claude = {
    on: {
      transcriptEvent: (h: unknown) => h,
      hookEvent: (h: unknown) => h,
      specialistEvent: () => () => {},
      shellEvent: () => () => {},
    },
    off: () => {},
    detach: { requestTranscriptPage: () => Promise.resolve(null) },
  };
});

import { BubbleFeed } from '../src/renderer/components/buddy/BubbleFeed';

function textTurn(id: string, content: string) {
  return {
    id,
    segments: [{ type: 'text', content, messageId: `${id}-m1`, partId: 'p1' }],
    timestamp: 1000,
    stopReason: null,
    model: null,
    usage: null,
    anthropicRequestId: null,
  };
}

function sessionState(overrides: Record<string, unknown>) {
  return {
    timeline: [] as any[],
    queuedMessages: [] as any[],
    toolCalls: new Map(),
    toolGroups: new Map(),
    assistantTurns: new Map(),
    activeTurnToolIds: new Set(),
    isThinking: true,
    compactionPending: false,
    promptProcessing: null,
    attentionState: 'ok',
    errorMessage: null,
    stallWarning: null,
    lastActivityAt: 1000,
    lastOutputAt: 1000,
    modelState: 'idle',
    modelInfo: null,
    ...overrides,
  };
}

const view = () => <BubbleFeed sessionId="s1" />;

/** Count reads of the layout-forcing property on the scroll container. jsdom
 *  never lays out, so the value is a stand-in; only the COUNT matters. */
function countScrollHeightReads(scroller: HTMLElement): () => number {
  let reads = 0;
  Object.defineProperty(scroller, 'scrollHeight', {
    configurable: true,
    get: () => { reads++; return 2000; },
  });
  return () => reads;
}

const scrollerOf = (r: { container: HTMLElement }) =>
  r.container.querySelector('.buddy-bubble-feed') as HTMLElement;

describe('BubbleFeed — auto-scroll pins on content, never on the activity timestamp', () => {
  it('a streamed delta (timestamps + live turn changed, same timeline) forces no layout read', () => {
    const timeline = [{ kind: 'assistant-turn', turnId: 'turn_1' }];
    mocks.state = sessionState({
      timeline,
      assistantTurns: new Map([['turn_1', textTurn('turn_1', 'Hel')]]),
    });
    const r = render(view());
    const scroller = scrollerOf(r);
    expect(scroller).not.toBeNull();
    const reads = countScrollHeightReads(scroller);

    for (const content of ['Hello', 'Hello, ', 'Hello, wor', 'Hello, world']) {
      mocks.state = {
        ...mocks.state,
        assistantTurns: new Map([['turn_1', textTurn('turn_1', content)]]),
        lastActivityAt: mocks.state.lastActivityAt + 7,
        lastOutputAt: mocks.state.lastOutputAt + 7,
      };
      r.rerender(view());
    }
    expect(r.container.textContent).toContain('Hello, world');
    expect(reads()).toBe(0);
  });

  it('an appended timeline entry still pins to the bottom (reads the geometry once)', () => {
    const timeline = [{ kind: 'assistant-turn', turnId: 'turn_1' }];
    mocks.state = sessionState({
      timeline,
      assistantTurns: new Map([['turn_1', textTurn('turn_1', 'First')]]),
    });
    const r = render(view());
    const reads = countScrollHeightReads(scrollerOf(r));

    mocks.state = {
      ...mocks.state,
      timeline: [...timeline, { kind: 'assistant-turn', turnId: 'turn_2' }],
      assistantTurns: new Map([
        ...mocks.state.assistantTurns,
        ['turn_2', textTurn('turn_2', 'Second')],
      ]),
      lastActivityAt: mocks.state.lastActivityAt + 7,
    };
    r.rerender(view());
    expect(reads()).toBeGreaterThanOrEqual(1);
  });

  it('the thinking indicator toggling still pins to the bottom', () => {
    const timeline = [{ kind: 'assistant-turn', turnId: 'turn_1' }];
    mocks.state = sessionState({
      timeline,
      isThinking: false,
      assistantTurns: new Map([['turn_1', textTurn('turn_1', 'First')]]),
    });
    const r = render(view());
    const reads = countScrollHeightReads(scrollerOf(r));

    mocks.state = { ...mocks.state, isThinking: true, lastActivityAt: mocks.state.lastActivityAt + 7 };
    r.rerender(view());
    expect(reads()).toBeGreaterThanOrEqual(1);
  });
});

describe('BubbleFeed — the ResizeObserver is what re-pins during a stream', () => {
  /** Mount with one turn and hand back the scroller, the observed content
   *  wrapper, its observer, and a knob for the wrapper's height. */
  function mountStreaming() {
    mocks.state = sessionState({
      timeline: [{ kind: 'assistant-turn', turnId: 'turn_1' }],
      assistantTurns: new Map([['turn_1', textTurn('turn_1', 'Hel')]]),
    });
    const r = render(view());
    const scroller = scrollerOf(r);
    const wrapper = scroller.firstElementChild as HTMLElement;
    // Proves the observer is attached to the CONTENT wrapper — the element that
    // grows — and not to the scroll container, whose height never changes.
    const ro = ControlledResizeObserver.instances.find((i) => i.target === wrapper);
    let contentHeight = 0;
    Object.defineProperty(wrapper, 'scrollHeight', {
      configurable: true,
      get: () => contentHeight,
    });
    return { r, scroller, wrapper, ro, setContentHeight: (h: number) => { contentHeight = h; } };
  }

  it('observes the content wrapper and re-pins when it grows', () => {
    const { scroller, wrapper, ro, setContentHeight } = mountStreaming();
    expect(wrapper).not.toBeNull();
    expect(ro).toBeDefined();

    const reads = countScrollHeightReads(scroller);
    setContentHeight(500);
    ro!.fire();
    // The read is the proof: scrollToBottom() is the only thing that touches the
    // scroll container's scrollHeight.
    expect(reads()).toBeGreaterThanOrEqual(1);
  });

  it('does NOT yank the view down once the user has scrolled up', () => {
    const { scroller, ro, setContentHeight } = mountStreaming();
    // The bottom sentinel leaving view is how the feed learns the user scrolled
    // up (atBottomRef). Fire it false, then grow the content.
    const io = ControlledIntersectionObserver.instances.at(-1)!;
    io.fire(false);

    const reads = countScrollHeightReads(scroller);
    setContentHeight(500);
    ro!.fire();
    expect(reads()).toBe(0);

    // …and re-pins again as soon as the user scrolls back to the bottom.
    io.fire(true);
    setContentHeight(900);
    ro!.fire();
    expect(reads()).toBeGreaterThanOrEqual(1);
  });

  it('releases the observed element when the feed unmounts', () => {
    const { r, ro } = mountStreaming();
    r.unmount();
    expect(ro!.disconnect).toHaveBeenCalled();
  });
});
