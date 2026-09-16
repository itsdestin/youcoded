import { describe, it, expect, vi } from 'vitest';
import { chatReducer } from '../chat-reducer';
import { createSessionChatState, serializeChatState } from '../chat-types';
import type { ChatState } from '../chat-types';

describe('HYDRATE_CHAT_STATE', () => {
  it('preserves host turns and tool groups when a fresh client receives live events', async () => {
    // WHY: resetModules models independent host/client counters, not two states
    // sharing one reducer boot (which cannot reproduce the collision).
    vi.resetModules();
    const host = (await import('../chat-reducer')).chatReducer;
    let state: ChatState = new Map([['s1', createSessionChatState()]]);
    state = host(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: 's1', uuid: 'host-text', text: 'Host answer', timestamp: 1 });
    state = host(state, { type: 'TRANSCRIPT_TOOL_USE', sessionId: 's1', uuid: 'host-tool', toolUseId: 'host-call', toolName: 'Read', toolInput: {}, timestamp: 2 });
    state = host(state, { type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: 's1', uuid: 'host-end', timestamp: 3, stopReason: 'end_turn', model: null, anthropicRequestId: null, usage: null });
    const prior = state.get('s1')!;
    const oldTurns = structuredClone(prior.assistantTurns);
    const oldGroups = structuredClone(prior.toolGroups);
    const oldTimeline = structuredClone(prior.timeline);
    const snapshot = JSON.parse(JSON.stringify(serializeChatState(state)));
    vi.resetModules();
    const client = (await import('../chat-reducer')).chatReducer;
    state = client(new Map(), { type: 'HYDRATE_CHAT_STATE', sessions: snapshot });
    state = client(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: 's1', uuid: 'live-text', text: 'New answer', timestamp: 4 });
    state = client(state, { type: 'TRANSCRIPT_TOOL_USE', sessionId: 's1', uuid: 'live-tool', toolUseId: 'live-call', toolName: 'Read', toolInput: {}, timestamp: 5 });
    const next = state.get('s1')!;
    expect.soft(next.assistantTurns.size).toBe(2);
    expect.soft(next.toolGroups.size).toBe(2);
    for (const [id, turn] of oldTurns) expect.soft(next.assistantTurns.get(id)).toEqual(turn);
    for (const [id, group] of oldGroups) expect.soft(next.toolGroups.get(id)).toEqual(group);
    expect(next.timeline.slice(0, oldTimeline.length)).toEqual(oldTimeline);
    expect(next.assistantTurns.get(next.currentTurnId!)?.segments).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', content: 'New answer' }),
    ]));
    expect(next.toolGroups.get(next.currentGroupId!)?.toolIds).toEqual(['live-call']);
  });

  it('replaces the entire ChatState map', () => {
    const existing: ChatState = new Map([['old-session', createSessionChatState()]]);

    const incoming = createSessionChatState();
    incoming.isThinking = true;
    incoming.attentionState = 'stuck';
    const snapshot = serializeChatState(new Map([['new-session', incoming]]));

    const next = chatReducer(existing, { type: 'HYDRATE_CHAT_STATE', sessions: snapshot });

    expect(next.has('old-session')).toBe(false);
    expect(next.has('new-session')).toBe(true);
    expect(next.get('new-session')!.attentionState).toBe('stuck');
  });

  it('leaves state untouched if deserialization throws', () => {
    const existing: ChatState = new Map([['s1', createSessionChatState()]]);
    // Malformed snapshot (sessions is not an array of tuples)
    const bad = { sessions: 'oops' } as any;
    const next = chatReducer(existing, { type: 'HYDRATE_CHAT_STATE', sessions: bad });
    expect(next).toBe(existing);
  });
});
