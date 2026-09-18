// @vitest-environment jsdom
// Perf cycle 1, N1 (docs/active/handoffs/2026-08-27-perf-cycle-1-handoff.md §3).
//
// findArchiveBoundary scans the WHOLE timeline backwards. ChatView used to call
// it inline in the render body, so a streaming session — which renders once per
// delta — paid a full-timeline scan per token. The timeline array's identity
// only changes when an entry is appended (a delta replaces assistantTurns, not
// timeline), so the scan must run once per appended entry and NOT per delta.
//
// Scaffolding mirrors chatview-empty-response-gate.test.tsx (the established
// ChatView mounting pattern). The archive-boundary module is wrapped in a spy
// around the REAL implementation so the render output is unchanged and only
// the call count is observed.
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

// The real markdown pipeline is irrelevant here and slow to mount.
vi.mock('../src/renderer/components/MarkdownContent', () => ({
  default: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

vi.mock('../src/renderer/state/archive-boundary', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/renderer/state/archive-boundary')>();
  return { ...real, findArchiveBoundary: vi.fn(real.findArchiveBoundary) };
});

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
import { findArchiveBoundary } from '../src/renderer/state/archive-boundary';

const scan = findArchiveBoundary as unknown as ReturnType<typeof vi.fn>;

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

describe('ChatView — the archive-boundary scan runs per appended entry, not per streamed delta', () => {
  it('a delta (same timeline reference, new turn object, new timestamps) does not rescan', () => {
    const timeline = [{ kind: 'assistant-turn', turnId: 'turn_1' }];
    mocks.state = sessionState({
      timeline,
      assistantTurns: new Map([['turn_1', textTurn('turn_1', 'Hel')]]),
    });
    const r = render(view());
    const afterMount = scan.mock.calls.length;
    expect(afterMount).toBeGreaterThanOrEqual(1);

    // Exactly what the reducer does on TRANSCRIPT_ASSISTANT_TEXT with a partId:
    // a fresh assistantTurns Map holding a fresh turn object, lastActivityAt /
    // lastOutputAt re-stamped, and the SAME timeline array.
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
    expect(scan.mock.calls.length).toBe(afterMount);
  });

  it('an appended entry (new timeline reference) rescans exactly once', () => {
    const timeline = [{ kind: 'assistant-turn', turnId: 'turn_1' }];
    mocks.state = sessionState({
      timeline,
      assistantTurns: new Map([['turn_1', textTurn('turn_1', 'First')]]),
    });
    const r = render(view());
    scan.mockClear();

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
    expect(r.container.textContent).toContain('Second');
    expect(scan.mock.calls.length).toBe(1);
  });
});
