// A fill starts the conversation over (SESSION_FILL_RESET) but keeps what only this screen knows: its queued rows and its own sends the
// transcript has not echoed yet (R5-2 review fix).
import { describe, it, expect } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { eventToAction } from '../src/renderer/state/transcript-event-actions';
import { ev } from './helpers/transcript-events';
import { screenOf, SID } from './helpers/fill-scenarios';
import type { ChatState } from '../src/renderer/state/chat-types';

const fresh = (): ChatState => chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: SID });
const apply = (st: ChatState, e: any): ChatState => { for (const a of eventToAction(e, { live: true })) st = chatReducer(st, a); return st; };

describe('a fill keeps this screen\'s own un-echoed send', () => {
  it('survives the reset as a pending bubble', () => {
    let st = fresh();
    st = chatReducer(st, { type: 'USER_PROMPT', sessionId: SID, content: 'hello there', timestamp: 1 } as any);
    st = chatReducer(st, { type: 'SESSION_FILL_RESET', sessionId: SID });
    expect(screenOf(st)!.timeline).toEqual(['user(pending): hello there']);
  });

  it('is confirmed (not duplicated) when the fill\'s recent past carries its echo', () => {
    let st = fresh();
    st = chatReducer(st, { type: 'USER_PROMPT', sessionId: SID, content: 'hello there', timestamp: 1 } as any);
    st = chatReducer(st, { type: 'SESSION_FILL_RESET', sessionId: SID });
    st = apply(st, ev('user-message', { text: 'hello there' }, { uuid: 'echo1', sessionId: SID, timestamp: 2 }));
    expect(screenOf(st)!.timeline).toEqual(['user: hello there']);
  });

  it('still starts everything else over', () => {
    let st = fresh();
    st = apply(st, ev('user-message', { text: 'old' }, { uuid: 'o1', sessionId: SID, timestamp: 1 }));
    st = chatReducer(st, { type: 'SESSION_FILL_RESET', sessionId: SID });
    expect(screenOf(st)!.timeline).toEqual([]);
  });
});
