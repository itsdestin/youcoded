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
vi.mock('../src/renderer/state/ArtifactContext', () => ({
  useArtifact: () => ({ state: { drawerOpenBySession: {}, drawerExpanded: false }, dispatch: vi.fn() }),
}));
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
(globalThis as any).ResizeObserver = class {
  observe() {} unobserve() {} disconnect() {}
};

// The unmemoised view: this harness delivers new state by re-rendering with the
// SAME props, which the memoised default export skips by design (see ChatView.tsx).
import { UnmemoizedChatView as ChatView } from '../src/renderer/components/ChatView';

const userEntry = (id: string) => ({ kind: 'user', message: { id, role: 'user', content: id, timestamp: 1 } });

function baseState(timeline: any[], history = { cursor: null, hasMore: false, loading: false }) {
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
afterEach(() => cleanup());

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
});
