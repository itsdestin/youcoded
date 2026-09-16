// @vitest-environment jsdom
// Destin, 2026-08-16: clicking "Resume from summary" put FOUR things on screen
// at once — the resolved prompt card, the CompactingCard, a redundant
// `/compact` user bubble, and the generic thinking indicator underneath it.
//
// This file pins the half of that fix that lives in the view: while a
// compaction is pending, CompactingCard is the ONLY status. The thinking
// indicator's rotating copy ("Connecting dots", "Weighing options") describes
// the model reasoning about the conversation, which is not what a summarize
// step is doing — and its spinner duplicates the card's own pulse + elapsed
// counter. The bubble half is pinned in chat-reducer.test.ts.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// A quiescent session with every field ChatView reads. `compactionPending` and
// `timeline` are overwritten per test.
const mocks = vi.hoisted(() => ({
  state: {
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
    lastActivityAt: 0,
    // null, not a timestamp: ThinkingIndicator suppresses itself for a few
    // seconds after real output, which would make an absence assertion pass
    // for the wrong reason.
    lastOutputAt: null as number | null,
    modelState: null as string | null,
    modelInfo: null,
    modelLoadedBytes: 0,
    modelEverResident: false,
    compactionPending: null as { startedAt: number; beforeContextTokens: number | null } | null,
  },
}));

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

if (typeof (globalThis as any).IntersectionObserver === 'undefined') {
  (globalThis as any).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
}

import ChatView from '../src/renderer/components/ChatView';

const renderChat = () =>
  render(<ChatView sessionId="s1" visible sessionActive />);

describe('one status per compaction', () => {
  beforeEach(() => {
    cleanup();   // no auto-cleanup configured here; a leftover tree fails the absence assertions
    mocks.state.timeline = [];
    mocks.state.compactionPending = null;
    mocks.state.isThinking = true;
    mocks.state.attentionState = 'ok';
  });

  it('shows the compacting card and NO thinking indicator while compacting', () => {
    mocks.state.compactionPending = { startedAt: Date.now(), beforeContextTokens: null };
    mocks.state.timeline = [{ kind: 'compacting', id: 'c1', startedAt: Date.now() }];
    renderChat();
    expect(screen.getByText(/Compacting conversation/)).toBeTruthy();
    expect(screen.queryByTestId('thinking-indicator')).toBeNull();
  });

  // The first version of this fix folded !compactionPending into `thinkingArea`,
  // which ALSO gates the 'stuck' AttentionBanner — silently swallowing the one
  // message that says something is wrong, during exactly the long operation
  // most likely to hang.
  it('still warns that the session is stuck DURING a compaction', () => {
    mocks.state.compactionPending = { startedAt: Date.now(), beforeContextTokens: null };
    mocks.state.timeline = [{ kind: 'compacting', id: 'c1', startedAt: Date.now() }];
    mocks.state.attentionState = 'stuck';
    renderChat();
    expect(screen.queryByTestId('thinking-indicator')).toBeNull();   // still no spinner
    expect(screen.getByText(/Still waiting on your assistant/)).toBeTruthy(); // but the warning survives
  });

  it('still shows the thinking indicator on an ordinary turn', () => {
    // Guards against "fixing" this by suppressing the indicator everywhere.
    expect(renderChat().container.querySelector('[data-testid="thinking-indicator"]')).toBeTruthy();
    expect(screen.queryByText(/Compacting conversation/)).toBeNull();
  });
});
