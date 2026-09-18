// @vitest-environment jsdom
// Perf cycle 1, N2 (docs/active/handoffs/2026-08-27-perf-cycle-1-handoff.md §3).
//
// ChatView's auto-scroll effect calls scrollToBottom(), which READS scrollHeight
// and WRITES scrollTop. Reading scrollHeight after a commit whose DOM is still
// dirty forces a synchronous layout of the document — the hook's own PERF note
// calls it "a FULL forced reflow of a large transcript". That effect used to
// depend on state.lastActivityAt, a timestamp the reducer re-stamps on EVERY
// streamed delta (and on tool events, heartbeats, …), so a streaming session
// paid one forced reflow per token even though the content growth those deltas
// cause is already re-pinned by the ResizeObserver on the content wrapper —
// which runs AFTER layout, where the read is free.
//
// This pins the fix: a state change that touches only the timestamps (and the
// live turn's object) must not read the scroll container's geometry; a change
// that appends a timeline entry still must.
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ state: {} as any }));

vi.mock('../src/renderer/state/chat-context', () => ({
  useChatState: () => mocks.state,
  useChatDispatch: () => vi.fn(),
}));

vi.mock('../src/renderer/state/ArtifactContext', () => ({
  useArtifact: () => ({
    state: { drawerOpenBySession: {}, drawerExpanded: false },
    dispatch: vi.fn(),
  }),
}));

vi.mock('../src/renderer/components/MarkdownContent', () => ({
  default: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

if (typeof (globalThis as any).IntersectionObserver === 'undefined') {
  (globalThis as any).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
}

// The unmemoised view: this harness delivers new state by re-rendering with the
// SAME props, which the memoised default export skips by design (see ChatView.tsx).
import { UnmemoizedChatView as ChatView } from '../src/renderer/components/ChatView';

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
    promptProcessing: null,
    attentionState: 'ok',
    errorMessage: null,
    stallWarning: null,
    lastActivityAt: 1000,
    lastOutputAt: 1000,
    modelState: 'idle',
    modelInfo: null,
    modelLoadedBytes: 0,
    modelEverResident: false,
    ...overrides,
  };
}

const view = () => <ChatView sessionId="s1" visible={true} sessionActive={true} />;

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

describe('ChatView — auto-scroll pins on content, never on the activity timestamp', () => {
  it('a streamed delta (timestamps + live turn changed, same timeline) forces no layout read', () => {
    const timeline = [{ kind: 'assistant-turn', turnId: 'turn_1' }];
    mocks.state = sessionState({
      timeline,
      assistantTurns: new Map([['turn_1', textTurn('turn_1', 'Hel')]]),
    });
    const r = render(view());
    const scroller = r.container.querySelector('.chat-scroll') as HTMLElement;
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
    const scroller = r.container.querySelector('.chat-scroll') as HTMLElement;
    const reads = countScrollHeightReads(scroller);

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
    const scroller = r.container.querySelector('.chat-scroll') as HTMLElement;
    const reads = countScrollHeightReads(scroller);

    mocks.state = { ...mocks.state, isThinking: true, lastActivityAt: mocks.state.lastActivityAt + 7 };
    r.rerender(view());
    expect(reads()).toBeGreaterThanOrEqual(1);
  });
});
