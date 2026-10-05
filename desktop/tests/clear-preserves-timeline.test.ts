// /clear must NOT wipe the visible conversation.
//
// Destin, 2026-07-28: "/clear is broken and seems to completely wipe the visible
// timeline for both native and claude code sessions. we should ensure it works
// like /compact and leaves the messages visible but faded in chat view."
//
// CLEAR_TIMELINE replaced the whole timeline with a single marker. That was
// wrong on both providers and for the same reason: clearing resets the MODEL'S
// context, not the user's ability to read what they said. /compact already had
// the right shape — keep everything, mark the boundary, fade what is no longer
// in context — and /clear is the same idea with a harder boundary.
//
// It also made the native path fragile: because the wipe was irreversible
// (seenUuids survives it, so a transcript replay dedups to nothing), the
// dispatcher had to defer the UI effect entirely rather than risk clearing on a
// clear the runtime then refused.
import { describe, it, expect } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import type { ChatState } from '../src/renderer/state/chat-types';

const S = 's';

function withHistory(): ChatState {
  let st = chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: S });
  st = chatReducer(st, { type: 'TRANSCRIPT_USER_MESSAGE', sessionId: S, uuid: 'u1', text: 'first question', timestamp: 1 } as any);
  st = chatReducer(st, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: S, uuid: 'a1', text: 'first answer', partId: 'p1', timestamp: 2 } as any);
  st = chatReducer(st, { type: 'TRANSCRIPT_USER_MESSAGE', sessionId: S, uuid: 'u2', text: 'second question', timestamp: 3 } as any);
  return st;
}
const clear = (st: ChatState, markerId = 'm1') =>
  chatReducer(st, { type: 'CLEAR_TIMELINE', sessionId: S, markerId, timestamp: 100 } as any);

describe('CLEAR_TIMELINE keeps the conversation readable', () => {
  it('does not discard the entries that came before it', () => {
    const before = withHistory().get(S)!.timeline.length;
    expect(before).toBeGreaterThan(0);
    expect(clear(withHistory()).get(S)!.timeline.length).toBe(before + 1);
  });

  it('the user\'s own messages are still there to re-read', () => {
    const tl = clear(withHistory()).get(S)!.timeline;
    const texts = tl.filter((e) => e.kind === 'user').map((e: any) => e.message.content);
    expect(texts).toContain('first question');
    expect(texts).toContain('second question');
  });

  it('appends the boundary marker LAST, so it reads as a divider', () => {
    const tl = clear(withHistory()).get(S)!.timeline;
    const last = tl[tl.length - 1];
    expect(last.kind).toBe('system-marker');
    expect((last as any).marker.variant).toBe('clear');
    expect((last as any).marker.label).toBe('Conversation cleared');
  });

  it('still ends the turn — a clear stops whatever was running', () => {
    let st = withHistory();
    st = chatReducer(st, { type: 'USER_PROMPT', sessionId: S, content: 'x', timestamp: 4 } as any);
    expect(st.get(S)!.isThinking).toBe(true);
    expect(clear(st).get(S)!.isThinking).toBe(false);
  });

  it('two clears leave two markers and still lose nothing', () => {
    const tl = clear(clear(withHistory()), 'm2').get(S)!.timeline;
    expect(tl.filter((e) => e.kind === 'system-marker').length).toBe(2);
    expect(tl.filter((e) => e.kind === 'user').length).toBe(2);
  });
});

describe('the same clear delivered twice', () => {
  it('draws one divider (the computer\'s numbered event can be replayed)', () => {
    const tl = clear(clear(withHistory())).get(S)!.timeline;
    expect(tl.filter((e) => e.kind === 'system-marker').length).toBe(1);
  });
});
