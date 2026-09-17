// A frame's worth of transcript actions must notify subscribers once.
//
// The transcript batcher coalesces renders to one per animation frame, but it
// used to hand the store its actions one at a time, and every dispatch ran
// every subscriber — twelve app-wide subscribeAll readers plus the
// per-session ones. Ten streamed words in a frame ran all of them ten times.
// dispatchMany applies the actions in order and notifies once at the end.
import { describe, it, expect, vi } from 'vitest';
import { createChatStore } from '../src/renderer/state/chat-context';
import type { ChatAction } from '../src/renderer/state/chat-types';

const SID = 's1';
const OTHER = 's2';
const text = (i: number): ChatAction => ({ type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SID, uuid: `u${i}`, text: 'w', timestamp: i });

describe('ChatStore.dispatchMany', () => {
  it('ten actions notify the app-wide and per-session subscribers once, and an untouched session not at all', () => {
    const store = createChatStore();
    store.dispatch({ type: 'SESSION_INIT', sessionId: SID });
    store.dispatch({ type: 'SESSION_INIT', sessionId: OTHER });
    const all = vi.fn(); const mine = vi.fn(); const other = vi.fn();
    store.subscribeAll(all); store.subscribeSession(SID, mine); store.subscribeSession(OTHER, other);

    store.dispatchMany(Array.from({ length: 10 }, (_, i) => text(i)));

    expect(all).toHaveBeenCalledTimes(1);
    expect(mine).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(0);
    // Every action was still applied, in order.
    const turns = [...store.getSession(SID).assistantTurns.values()];
    expect(turns.flatMap((t) => t.segments).map((s: any) => s.content).join('')).toBe('wwwwwwwwww');
  });

  it('a batch that changes nothing notifies nobody', () => {
    const store = createChatStore();
    store.dispatch({ type: 'SESSION_INIT', sessionId: SID });
    store.dispatch(text(0));
    const all = vi.fn();
    store.subscribeAll(all);
    store.dispatchMany([text(0), text(0)]); // duplicates are deduped by uuid → state unchanged
    expect(all).toHaveBeenCalledTimes(0);
  });

  it('dispatch (single) still notifies per action, so nothing else changed', () => {
    const store = createChatStore();
    store.dispatch({ type: 'SESSION_INIT', sessionId: SID });
    const all = vi.fn();
    store.subscribeAll(all);
    store.dispatch(text(0)); store.dispatch(text(1));
    expect(all).toHaveBeenCalledTimes(2);
  });
});
