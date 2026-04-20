import { describe, it, expect } from 'vitest';
import {
  createSessionChatState,
  serializeChatState,
  deserializeChatState,
} from '../chat-types';
import type { ChatState, ToolCallState } from '../chat-types';

describe('chat state serialization', () => {
  it('round-trips an empty ChatState', () => {
    const state: ChatState = new Map();
    const round = deserializeChatState(serializeChatState(state));
    expect(round).toEqual(state);
  });

  it('round-trips a session with tool calls, turns, and an active turn set', () => {
    const session = createSessionChatState();
    const toolCall: ToolCallState = {
      id: 'tool-1',
      name: 'Bash',
      status: 'success',
      input: { command: 'ls' },
      result: 'file.txt',
    } as any;
    session.toolCalls.set('tool-1', toolCall);
    session.activeTurnToolIds.add('tool-1');
    session.assistantTurns.set('turn-1', {
      id: 'turn-1',
      segments: [],
      timestamp: 123,
      stopReason: null,
      model: null,
      usage: null,
      anthropicRequestId: null,
    });
    session.timeline.push({ kind: 'assistant-turn', turnId: 'turn-1' });
    session.isThinking = true;
    session.attentionState = 'awaiting-input';
    session.compactionPending = { startedAt: 456, beforeContextTokens: 1000 };
    const state: ChatState = new Map([['session-a', session]]);

    const serialized = serializeChatState(state);
    const viaJson = JSON.parse(JSON.stringify(serialized));
    const round = deserializeChatState(viaJson);

    const restored = round.get('session-a')!;
    expect(restored.toolCalls.get('tool-1')).toEqual(toolCall);
    expect(restored.activeTurnToolIds.has('tool-1')).toBe(true);
    expect(restored.assistantTurns.get('turn-1')?.timestamp).toBe(123);
    expect(restored.timeline).toEqual([{ kind: 'assistant-turn', turnId: 'turn-1' }]);
    expect(restored.isThinking).toBe(true);
    expect(restored.attentionState).toBe('awaiting-input');
    expect(restored.compactionPending).toEqual({ startedAt: 456, beforeContextTokens: 1000 });
  });
});
