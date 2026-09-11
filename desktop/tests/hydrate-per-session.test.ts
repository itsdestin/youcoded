// Remote access batch 2, design §4 and §6 (T4), contract R3 and R5: how a phone
// applies the computer's copy. A complete copy replaces; an incomplete one
// replaces only what it holds and keeps the rest; both keep the phone's own
// unsent actions; and every delivered session is marked so the phone never
// loads a first page on top of it.
import { describe, it, expect } from 'vitest';
import { chatReducer, keptByHydrate } from '../src/renderer/state/chat-reducer';
import { serializeChatState, type ChatAction, type ChatState, type SerializedChatState } from '../src/renderer/state/chat-types';

function run(actions: ChatAction[], state: ChatState = new Map()): ChatState {
  return actions.reduce((s, a) => chatReducer(s, a), state);
}
const init = (sessionId: string): ChatAction => ({ type: 'SESSION_INIT', sessionId });
const said = (sessionId: string, uuid: string, text: string): ChatAction => ({ type: 'TRANSCRIPT_USER_MESSAGE', sessionId, uuid, text, timestamp: 1 });
const answered = (sessionId: string, uuid: string, text: string): ChatAction => ({ type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId, uuid, text, timestamp: 2 });
const typed = (sessionId: string, content: string): ChatAction => ({ type: 'USER_PROMPT', sessionId, content, timestamp: 3 });
const queued = (sessionId: string, content: string): ChatAction => ({ type: 'QUEUED_MESSAGE_ADDED', sessionId, queueId: `q-${content}`, content, timestamp: 4 } as any);

/** The computer's copy: a host store that ran these actions, serialized. */
function hostCopy(actions: ChatAction[], extra: Partial<SerializedChatState> = {}): SerializedChatState {
  return { ...serializeChatState(run(actions)), ...extra };
}
const userTexts = (s: ChatState, sid: string) => s.get(sid)!.timeline
  .filter((e): e is Extract<typeof e, { kind: 'user' }> => e.kind === 'user')
  .map((e) => `${e.message.content}${e.pending ? ' (pending)' : ''}`);

describe('a complete copy', () => {
  it('replaces the whole state, marks every delivered session hydrated, and keeps nothing', () => {
    const phone = run([init('s1'), init('gone'), said('gone', 'g1', 'old')]);
    const copy = hostCopy([init('s1'), said('s1', 'u1', 'hello'), answered('s1', 'a1', 'hi')]);
    const after = chatReducer(phone, { type: 'HYDRATE_CHAT_STATE', sessions: copy });
    expect([...after.keys()]).toEqual(['s1']);
    expect(after.get('s1')!.history.hydrated).toBe(true);
    expect(keptByHydrate(phone, copy)).toEqual([]);
  });
});

describe('an incomplete copy', () => {
  it('replaces only the sessions it holds with a non-empty copy, keeps every other, deletes nothing', () => {
    const phone = run([
      init('s1'), said('s1', 'p1', 'phone-s1'),
      init('s2'), said('s2', 'p2', 'phone-s2'),
      init('s3'), said('s3', 'p3', 'phone-s3'),
    ]);
    const copy = hostCopy([init('s1'), said('s1', 'h1', 'host-s1'), init('s3')], { degraded: true });
    const after = chatReducer(phone, { type: 'HYDRATE_CHAT_STATE', sessions: copy });
    expect(userTexts(after, 's1')).toEqual(['host-s1']);
    expect(after.get('s1')!.history.hydrated).toBe(true);
    expect(userTexts(after, 's2')).toEqual(['phone-s2']);          // omitted by the host: the phone's copy stays
    expect(userTexts(after, 's3')).toEqual(['phone-s3']);          // an EMPTY host copy never replaces a real one
    expect(after.get('s2')!.history.hydrated).toBeFalsy();
    expect(keptByHydrate(phone, copy)).toEqual(['s2', 's3']);
  });

  it('an empty copy for a session the phone does not have is added blank and not marked hydrated', () => {
    const copy = hostCopy([init('s9')], { degraded: true });
    const after = chatReducer(new Map(), { type: 'HYDRATE_CHAT_STATE', sessions: copy });
    expect(after.has('s9')).toBe(true);
    expect(after.get('s9')!.history.hydrated).toBeFalsy();
  });
});

describe('an empty copy', () => {
  it('changes nothing, and everything counts as kept', () => {
    const phone = run([init('s1'), said('s1', 'p1', 'x')]);
    const copy: SerializedChatState = { sessions: [], degraded: true };
    expect(chatReducer(phone, { type: 'HYDRATE_CHAT_STATE', sessions: copy })).toBe(phone);
    expect(keptByHydrate(phone, copy)).toEqual(['s1']);
  });
});

describe.each([
  ['complete', {}],
  ['incomplete', { degraded: true as const }],
])('a %s copy keeps the phone\'s unsent actions', (_label, extra) => {
  it('a pending bubble and a queued message the transcript has not echoed both stay', () => {
    const phone = run([init('s1'), said('s1', 'u1', 'earlier'), typed('s1', 'on its way'), queued('s1', 'next up')]);
    const copy = hostCopy([init('s1'), said('s1', 'u1', 'earlier'), answered('s1', 'a1', 'reply')], extra);
    const after = chatReducer(phone, { type: 'HYDRATE_CHAT_STATE', sessions: copy });
    expect(userTexts(after, 's1')).toEqual(['earlier', 'on its way (pending)']);
    expect(after.get('s1')!.queuedMessages.map((q) => q.content)).toEqual(['next up']);
  });

  it('a pending bubble the computer\'s copy already echoed is not shown twice', () => {
    const phone = run([init('s1'), typed('s1', 'hello')]);
    const copy = hostCopy([init('s1'), said('s1', 'u1', 'hello')], extra);
    const after = chatReducer(phone, { type: 'HYDRATE_CHAT_STATE', sessions: copy });
    expect(userTexts(after, 's1')).toEqual(['hello']);
  });

  it('the same words sent twice: one already echoed earlier, the new one still pending, stays pending', () => {
    const phone = run([init('s1'), said('s1', 'u1', 'yes'), typed('s1', 'yes')]);
    const copy = hostCopy([init('s1'), said('s1', 'u1', 'yes')], extra);
    const after = chatReducer(phone, { type: 'HYDRATE_CHAT_STATE', sessions: copy });
    expect(userTexts(after, 's1')).toEqual(['yes', 'yes (pending)']);
  });

  it('a queued message the computer already received is not kept as queued', () => {
    const phone = run([init('s1'), queued('s1', 'drained')]);
    const copy = hostCopy([init('s1'), said('s1', 'u1', 'drained')], extra);
    const after = chatReducer(phone, { type: 'HYDRATE_CHAT_STATE', sessions: copy });
    expect(after.get('s1')!.queuedMessages).toEqual([]);
  });
});

describe('one source for history', () => {
  it('an older page after the hydrate prepends without repeating a turn or a message', () => {
    const copy = hostCopy([init('s1'), said('s1', 'new-u', 'new question'), answered('s1', 'new-a', 'new answer')]);
    let phone = chatReducer(run([init('s1')]), { type: 'HYDRATE_CHAT_STATE', sessions: copy });
    phone = chatReducer(phone, { type: 'HISTORY_PAGE_REQUESTED', sessionId: 's1' });
    phone = chatReducer(phone, {
      type: 'HISTORY_PAGE_LOADED', sessionId: 's1', cursor: null, hasMore: false,
      events: [
        { type: 'user-message', sessionId: 's1', uuid: 'old-u', timestamp: 0, data: { text: 'old question' } },
        { type: 'assistant-text', sessionId: 's1', uuid: 'old-a', timestamp: 0, data: { text: 'old answer' } },
        { type: 'turn-complete', sessionId: 's1', uuid: 'old-t', timestamp: 0, data: { stopReason: 'end_turn' } },
      ] as any,
    });
    const s = phone.get('s1')!;
    expect(userTexts(phone, 's1')).toEqual(['old question', 'new question']);
    const turnIds = s.timeline.filter((e) => e.kind === 'assistant-turn').map((e: any) => e.turnId);
    expect(new Set(turnIds).size).toBe(turnIds.length);
    const messageIds = s.timeline.filter((e) => e.kind === 'user').map((e: any) => e.message.id);
    expect(new Set(messageIds).size).toBe(messageIds.length);
  });
});
