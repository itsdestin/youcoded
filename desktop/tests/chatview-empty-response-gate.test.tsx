// @vitest-environment jsdom
// Empty-step recovery (spec 2026-08-21, decision 4) — review fix, PR #324.
//
// The unit tests that shipped with the recovery ladder mounted
// AssistantTurnBubble DIRECTLY and asserted on reducer state — so they all
// passed while the feature was dead in the real app: ChatView's timeline gate
// (`if (!turn || turn.segments.length === 0) return null;`) dropped every
// segment-less turn before AssistantTurnBubble ever mounted, which is exactly
// the shape the empty_response footer exists for. This test crosses the
// ChatView boundary: state in, rendered footer out.
//
// Scaffolding mirrors ChatView.test.tsx (the established
// ChatView mounting pattern): chat-context and app-wide contexts are mocked,
// jsdom gets an IntersectionObserver stub.
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

function emptySessionState() {
  return {
    timeline: [] as any[],
    queuedMessages: [] as any[],
    toolCalls: new Map(),
    toolGroups: new Map(),
    assistantTurns: new Map(),
    activeTurnToolIds: new Set(),
    isThinking: false,
    promptProcessing: null,
    attentionState: 'ok',
    errorMessage: null,
    stallWarning: null,
    lastActivityAt: 0,
    lastOutputAt: 0,
    modelState: 'idle',
    modelInfo: null,
    modelLoadedBytes: 0,
    modelEverResident: false,
  };
}

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

if (typeof (globalThis as any).IntersectionObserver === 'undefined') {
  (globalThis as any).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
}

import ChatView from '../src/renderer/components/ChatView';

/** A segment-less assistant turn, as minted by TRANSCRIPT_TURN_COMPLETE's
 *  abnormal-stopReason branch (chat-reducer.ts). */
function segmentlessTurn(stopReason: string | null) {
  return {
    id: 'turn_1',
    segments: [] as any[],
    timestamp: 1000,
    stopReason,
    model: null,
    usage: null,
    anthropicRequestId: null,
  };
}

function renderWithTurn(stopReason: string | null) {
  mocks.state = {
    ...emptySessionState(),
    timeline: [{ kind: 'assistant-turn', turnId: 'turn_1' }],
    assistantTurns: new Map([['turn_1', segmentlessTurn(stopReason)]]),
  };
  return render(<ChatView sessionId="s1" visible={true} sessionActive={true} />);
}

describe('ChatView timeline gate — segment-less turns (empty-step recovery)', () => {
  it('renders the empty_response footer for a segment-less turn (end-to-end through the gate)', () => {
    const { container } = renderWithTurn('empty_response');
    expect(container.textContent).toContain('The model returned an empty response twice. Retrying may help.');
  });

  it('still drops a segment-less turn that completed normally', () => {
    cleanup();
    const { container } = renderWithTurn('end_turn');
    expect(container.textContent).not.toContain('empty response');
  });

  it('still drops a segment-less turn with no stopReason at all', () => {
    cleanup();
    const { container } = renderWithTurn(null);
    expect(container.textContent).not.toContain('Response ended');
  });
});
