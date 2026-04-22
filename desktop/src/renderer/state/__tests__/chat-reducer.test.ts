import { describe, it, expect } from 'vitest';
import { chatReducer } from '../chat-reducer';
import { createSessionChatState } from '../chat-types';
import type { ChatState } from '../chat-types';
import type { ToolCallState } from '../../../shared/types';

function stateWithInFlightTurn(sessionId = 'sess-1', turnId = 'turn-1'): ChatState {
  const session = createSessionChatState();
  session.currentTurnId = turnId;
  session.isThinking = true;
  const runningTool: ToolCallState = {
    toolUseId: 'tool-1',
    toolName: 'Bash',
    status: 'running',
    input: { command: 'sleep 1000' },
  } as any;
  const awaitingTool: ToolCallState = {
    toolUseId: 'tool-2',
    toolName: 'Edit',
    status: 'awaiting-approval',
    input: {},
  } as any;
  session.toolCalls.set('tool-1', runningTool);
  session.toolCalls.set('tool-2', awaitingTool);
  session.activeTurnToolIds.add('tool-1');
  session.activeTurnToolIds.add('tool-2');
  session.assistantTurns.set(turnId, {
    id: turnId,
    segments: [],
    timestamp: 1000,
    stopReason: null,
    model: null,
    usage: null,
    anthropicRequestId: null,
  });
  return new Map([[sessionId, session]]);
}

describe('chatReducer TRANSCRIPT_INTERRUPT', () => {
  it('attaches stopReason=interrupted to the in-flight turn', () => {
    const state = stateWithInFlightTurn();
    const next = chatReducer(state, {
      type: 'TRANSCRIPT_INTERRUPT',
      sessionId: 'sess-1',
      uuid: 'u-1',
      timestamp: 2000,
      kind: 'plain',
    });
    const session = next.get('sess-1')!;
    expect(session.assistantTurns.get('turn-1')?.stopReason).toBe('interrupted');
  });

  it('flips running/awaiting-approval tools to failed with error "Turn interrupted"', () => {
    const state = stateWithInFlightTurn();
    const next = chatReducer(state, {
      type: 'TRANSCRIPT_INTERRUPT',
      sessionId: 'sess-1',
      uuid: 'u-1',
      timestamp: 2000,
      kind: 'tool-use',
    });
    const session = next.get('sess-1')!;
    expect(session.toolCalls.get('tool-1')?.status).toBe('failed');
    expect((session.toolCalls.get('tool-1') as any).error).toBe('Turn interrupted');
    expect(session.toolCalls.get('tool-2')?.status).toBe('failed');
    expect((session.toolCalls.get('tool-2') as any).error).toBe('Turn interrupted');
  });

  it('clears turn-scoped state via endTurn()', () => {
    const state = stateWithInFlightTurn();
    const next = chatReducer(state, {
      type: 'TRANSCRIPT_INTERRUPT',
      sessionId: 'sess-1',
      uuid: 'u-1',
      timestamp: 2000,
      kind: 'plain',
    });
    const session = next.get('sess-1')!;
    expect(session.isThinking).toBe(false);
    expect(session.currentTurnId).toBeNull();
    expect(session.activeTurnToolIds.size).toBe(0);
    expect(session.attentionState).toBe('ok');
  });

  it('is a no-op-safe call when there is no in-flight turn', () => {
    const session = createSessionChatState();
    session.isThinking = false;
    session.currentTurnId = null;
    const state: ChatState = new Map([['sess-1', session]]);
    const next = chatReducer(state, {
      type: 'TRANSCRIPT_INTERRUPT',
      sessionId: 'sess-1',
      uuid: 'u-1',
      timestamp: 2000,
      kind: 'plain',
    });
    const nextSession = next.get('sess-1')!;
    expect(nextSession.isThinking).toBe(false);
    expect(nextSession.currentTurnId).toBeNull();
  });

  it('returns original state if sessionId is unknown', () => {
    const state = stateWithInFlightTurn();
    const next = chatReducer(state, {
      type: 'TRANSCRIPT_INTERRUPT',
      sessionId: 'no-such-session',
      uuid: 'u-1',
      timestamp: 2000,
      kind: 'plain',
    });
    expect(next).toBe(state);
  });
});
