// @vitest-environment jsdom
// Perf cycle 2, Destin's verdict on the first attempt: "the scroll bar feels a
// little jumpy ... when loading in the new content after scrolling to the top".
//
// Two independent causes, one test each:
//  1. Prepending changes timeline.length, which re-armed the "sending a message
//     re-arms auto-scroll" effect and YANKED the view to the bottom whenever the
//     newest entry happened to be the user's.
//  2. The view was restored with height arithmetic captured before the fetch.
//     It is now anchored to the topmost visible ENTRY, and re-applied as late
//     content lays out.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  state: {} as any,
  dispatch: vi.fn(),
  stickToBottom: vi.fn(),
  scrollToBottom: vi.fn(),
}));

vi.mock('../src/renderer/state/chat-context', () => ({
  useChatState: () => mocks.state,
  useChatDispatch: () => mocks.dispatch,
}));
vi.mock('../src/renderer/state/ArtifactContext', () => {
  // ChatView reads the artifact store through narrow selectors (perf, 2026-09-23).
  const state = { drawerOpenBySession: {}, drawerExpanded: false };
  return {
    useArtifactSelector: (select: (s: any) => unknown) => select(state),
    // UserMessage's reference chips open their file on click (useOpenFilepath).
    useArtifactStoreOptional: () => null,
    useArtifactDispatch: () => vi.fn(),
  };
});
vi.mock('../src/renderer/hooks/use-stick-to-bottom', () => ({
  useStickToBottom: () => ({
    atBottom: false,
    stickRef: { current: false },
    scrollToBottom: mocks.scrollToBottom,
    stickToBottom: mocks.stickToBottom,
    jumpToBottom: vi.fn(),
    releaseStick: vi.fn(),
  }),
}));

(globalThis as any).IntersectionObserver = class {
  cb: (e: any[]) => void;
  constructor(cb: (e: any[]) => void) { this.cb = cb; }
  observe(el: Element) { this.cb([{ isIntersecting: true, target: el }]); }
  unobserve() {} disconnect() {} takeRecords() { return []; }
};
// Every ResizeObserver the view builds, so a test can deliver "the layout changed" itself.
const resizeObservers = new Set<{ cb: () => void }>();
(globalThis as any).ResizeObserver = class {
  cb: () => void;
  constructor(cb: () => void) { this.cb = cb; }
  observe() { resizeObservers.add(this); }
  unobserve() {}
  disconnect() { resizeObservers.delete(this); }
};
const fireResize = () => { for (const ro of [...resizeObservers]) ro.cb(); };

// The unmemoised view: this harness delivers new state by re-rendering with the
// SAME props, which the memoised default export skips by design (see ChatView.tsx).
import { UnmemoizedChatView as ChatView } from '../src/renderer/components/ChatView';

const userEntry = (id: string) => ({ kind: 'user', message: { id, role: 'user', content: id, timestamp: 1 } });

function baseState(timeline: any[], history: { cursor: { path: string; offset: number; sizeAtRead: number } | null; hasMore: boolean; loading: boolean } = { cursor: null, hasMore: false, loading: false }) {
  return {
    timeline, queuedMessages: [], toolCalls: new Map(), toolGroups: new Map(),
    assistantTurns: new Map(), activeTurnToolIds: new Set(), isThinking: false,
    promptProcessing: null, attentionState: 'ok', errorMessage: null, stallWarning: null,
    lastActivityAt: 0, lastOutputAt: 0, modelState: 'idle', modelInfo: null,
    modelLoadedBytes: 0, modelEverResident: false, history,
  };
}

beforeEach(() => {
  mocks.dispatch = vi.fn();
  mocks.stickToBottom = vi.fn();
  mocks.scrollToBottom = vi.fn();
  (window as any).claude = { detach: { requestTranscriptPage: vi.fn().mockResolvedValue(null) } };
});
afterEach(() => { cleanup(); resizeObservers.clear(); });

describe('prepending older history does not disturb the reader', () => {
  it('does NOT re-arm auto-scroll when the newest entry is unchanged', () => {
    // The tail objects are REUSED across the prepend, exactly as the reducer
    // spreads them — that identity is what tells a prepend from an append.
    const tail = [userEntry('older-visible'), userEntry('newest')];
    mocks.state = baseState(tail);
    const { rerender } = render(<ChatView sessionId="s1" visible={true} sessionActive={true} />);
    mocks.stickToBottom.mockClear();

    mocks.state = baseState([userEntry('page-1'), userEntry('page-2'), ...tail]);
    rerender(<ChatView sessionId="s1" visible={true} sessionActive={true} />);

    expect(mocks.stickToBottom).not.toHaveBeenCalled();
  });

  it('holds the reader in place: the anchored entry keeps its screen position', async () => {
    // jsdom has no layout, so rects are supplied. The anchor is the topmost
    // entry still on screen; after the prepend it has been pushed down 200px and
    // the container must be scrolled by exactly that much to undo it.
    const rects = new Map<string, number>();   // element text -> viewport top
    const realRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      let top: number | undefined;
      if (String(this.className ?? '').includes('chat-scroll')) top = rects.get('__scroller');
      else for (const [k, v] of rects) { if (k !== '__scroller' && (this.textContent ?? '').includes(k)) { top = v; break; } }
      const t = top ?? 0;
      return { top: t, bottom: t + 40, left: 0, right: 0, width: 0, height: 40, x: 0, y: t, toJSON() {} } as DOMRect;
    };
    try {
      rects.set('__scroller', 0);
      rects.set('older-visible', 50);   // 50px below the top edge — the anchor
      rects.set('newest', 150);

      const tail = [userEntry('older-visible'), userEntry('newest')];
      const page = { events: [], cursor: null, hasMore: false };
      (window as any).claude.detach.requestTranscriptPage = vi.fn().mockResolvedValue(page);
      mocks.state = baseState(tail, { cursor: { path: 'p', offset: 10, sizeAtRead: 99 }, hasMore: true, loading: false });

      const { container, rerender } = render(<ChatView sessionId="s1" visible={true} sessionActive={true} />);
      const scroller = container.querySelector('.chat-scroll') as HTMLElement;
      scroller.scrollTop = 400;

      // The sentinel fires, the page resolves, and the anchor is captured.
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      // The prepended turns push the anchor 200px down the screen.
      rects.set('older-visible', 250);
      mocks.state = baseState([userEntry('page-1'), ...tail], { cursor: null, hasMore: false, loading: false });
      await act(async () => { rerender(<ChatView sessionId="s1" visible={true} sessionActive={true} />); });

      expect(scroller.scrollTop).toBe(600); // 400 + the 200px of drift, undone
    } finally {
      Element.prototype.getBoundingClientRect = realRect;
    }
  });

  it('still re-arms auto-scroll when the user actually sends a message', () => {
    const tail = [userEntry('a')];
    mocks.state = baseState(tail);
    const { rerender } = render(<ChatView sessionId="s1" visible={true} sessionActive={true} />);
    mocks.stickToBottom.mockClear();

    mocks.state = baseState([...tail, userEntry('just-sent')]);
    rerender(<ChatView sessionId="s1" visible={true} sessionActive={true} />);

    expect(mocks.stickToBottom).toHaveBeenCalled();
  });

  // --- the reader's own scrolling is never undone (freeze hunt 2026-10-23, item 1) ----------------
  // A real-layout stand-in: each entry has a fixed place in the DOCUMENT (docY), and its place on
  // screen is docY - scrollTop, exactly as a browser lays it out. So a test can scroll the way a
  // scrollbar drag, touch fling or script does (assign scrollTop, no wheel/touch/key event) and
  // change the layout above an entry, then let the view's resize callback run.
  async function prependHarness() {
    const docY = new Map<string, number>([['older-visible', 450], ['newest', 550]]);
    let scroller!: HTMLElement;
    const realRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      const el = this as HTMLElement;
      let top = 0;
      if (String(el.className ?? '').includes('chat-scroll')) top = 0;
      else {
        const hit = [...docY].find(([k]) => (el.textContent ?? '').includes(k) && el.classList?.contains('timeline-entry'));
        top = hit ? hit[1] - (scroller?.scrollTop ?? 0) : 0;
      }
      return { top, bottom: top + 40, left: 0, right: 0, width: 0, height: 40, x: 0, y: top, toJSON() {} } as DOMRect;
    };
    const tail = [userEntry('older-visible'), userEntry('newest')];
    const page = { events: [], cursor: null, hasMore: false };
    (window as any).claude.detach.requestTranscriptPage = vi.fn().mockResolvedValue(page);
    mocks.state = baseState(tail, { cursor: { path: 'p', offset: 10, sizeAtRead: 99 }, hasMore: true, loading: false });
    const view = render(<ChatView sessionId="s1" visible={true} sessionActive={true} />);
    scroller = view.container.querySelector('.chat-scroll') as HTMLElement;
    scroller.scrollTop = 400;
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    // The page arrives: the anchor entry is pushed 200px further down the document.
    docY.set('older-visible', 650); docY.set('newest', 750);
    mocks.state = baseState([userEntry('page-1'), ...tail], { cursor: null, hasMore: false, loading: false });
    await act(async () => { view.rerender(<ChatView sessionId="s1" visible={true} sessionActive={true} />); });
    return { scroller, docY, restore: () => { Element.prototype.getBoundingClientRect = realRect; } };
  }

  it('does not pull the reader back when they scroll after the page arrives (any input, no wheel event)', async () => {
    const h = await prependHarness();
    try {
      expect(h.scroller.scrollTop).toBe(600);   // the prepend itself was undone
      h.scroller.scrollTop = 100;               // a scrollbar drag: no wheel, touch or key event
      await act(async () => { fireResize(); });
      expect(h.scroller.scrollTop).toBe(100);   // the old code dragged this back to ~600
      h.scroller.scrollTop = 950;               // and downwards too
      await act(async () => { fireResize(); });
      expect(h.scroller.scrollTop).toBe(950);
    } finally { h.restore(); }
  });

  it('still corrects content that changes ABOVE the entry, measured from where the reader now is', async () => {
    const h = await prependHarness();
    try {
      h.scroller.scrollTop = 100;               // the reader moved on...
      h.docY.set('older-visible', 700);         // ...then a code block above the anchor finished laying out: +50px
      await act(async () => { fireResize(); });
      expect(h.scroller.scrollTop).toBe(150);   // the entry stays where the reader's own scroll put it on screen
    } finally { h.restore(); }
  });

  it('leaves the browser scroll anchoring off only while it corrects, and puts the previous setting back', async () => {
    vi.useFakeTimers();
    const h = await prependHarness();
    try {
      expect(h.scroller.style.overflowAnchor).toBe('none');
      await act(async () => { vi.advanceTimersByTime(800); });
      expect(h.scroller.style.overflowAnchor).toBe('');
      // after the window the view is no longer touched
      h.docY.set('older-visible', 900);
      h.scroller.scrollTop = 300;
      await act(async () => { fireResize(); });
      expect(h.scroller.scrollTop).toBe(300);
    } finally { h.restore(); vi.useRealTimers(); }
  });
});
