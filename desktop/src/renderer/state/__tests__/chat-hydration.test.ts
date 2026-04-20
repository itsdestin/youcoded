import { describe, it, expect } from 'vitest';
import { chatReducer } from '../chat-reducer';
import { createSessionChatState, serializeChatState } from '../chat-types';
import type { ChatState } from '../chat-types';

describe('HYDRATE_CHAT_STATE', () => {
  it('replaces the entire ChatState map', () => {
    const existing: ChatState = new Map([['old-session', createSessionChatState()]]);

    const incoming = createSessionChatState();
    incoming.isThinking = true;
    incoming.attentionState = 'awaiting-input';
    const snapshot = serializeChatState(new Map([['new-session', incoming]]));

    const next = chatReducer(existing, { type: 'HYDRATE_CHAT_STATE', sessions: snapshot });

    expect(next.has('old-session')).toBe(false);
    expect(next.has('new-session')).toBe(true);
    expect(next.get('new-session')!.attentionState).toBe('awaiting-input');
  });

  it('leaves state untouched if deserialization throws', () => {
    const existing: ChatState = new Map([['s1', createSessionChatState()]]);
    // Malformed snapshot (sessions is not an array of tuples)
    const bad = { sessions: 'oops' } as any;
    const next = chatReducer(existing, { type: 'HYDRATE_CHAT_STATE', sessions: bad });
    expect(next).toBe(existing);
  });
});
