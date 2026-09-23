// @vitest-environment jsdom
// A hidden chat holds still while its reply streams, and is current the
// instant it is shown.
//
// App keeps a ChatView mounted for every open session; a hidden one used to
// re-draw its whole timeline once per streamed word. ChatView now reads its
// state with useChatState(id, { paused: !visible }). Pinned here: while paused
// the reader neither re-renders nor sees new state; the render that un-pauses
// already carries the LIVE state (no stale frame to catch up from); and the
// store itself kept every event the whole time.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { ChatProvider, useChatStore, useChatState, type ChatStore } from '../src/renderer/state/chat-context';
import type { ChatAction, SessionChatState } from '../src/renderer/state/chat-types';

const SID = 's1';
const OTHER = 's2';
/** Every state the reader rendered with, in order. */
let seen: SessionChatState[] = [];

function Reader({ sessionId, paused }: { sessionId: string; paused: boolean }) {
  seen.push(useChatState(sessionId, { paused }));
  return null;
}

function Harness({ onStore, sessionId, paused }: { onStore: (s: ChatStore) => void; sessionId: string; paused: boolean }) {
  onStore(useChatStore());
  return <Reader sessionId={sessionId} paused={paused} />;
}

function mount(paused: boolean) {
  let store!: ChatStore;
  const ui = (p: boolean, id = SID) => (
    <ChatProvider><Harness onStore={(s) => { store = s; }} sessionId={id} paused={p} /></ChatProvider>
  );
  const r = render(ui(paused));
  act(() => {
    store.dispatch({ type: 'SESSION_INIT', sessionId: SID });
    store.dispatch({ type: 'SESSION_INIT', sessionId: OTHER });
  });
  return { store: () => store, rerender: (p: boolean, id?: string) => r.rerender(ui(p, id)) };
}

const text = (i: number): ChatAction => ({ type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SID, uuid: `u${i}`, text: 'word ', timestamp: i } as ChatAction);

afterEach(() => { cleanup(); seen = []; });

describe('useChatState while paused', () => {
  it('a streamed reply does not re-render a paused reader', () => {
    const { store, rerender } = mount(false);
    rerender(true);
    const before = seen.length;
    const frozen = seen[seen.length - 1];
    act(() => { for (let i = 0; i < 40; i++) store().dispatch(text(i)); });
    expect(seen.length - before).toBe(0);
    // The store itself applied every word.
    expect(store().getSession(SID)).not.toBe(frozen);
    expect(store().getSession(SID).timeline.length).toBeGreaterThan(0);
  });

  it('un-pausing renders the live state in that very render', () => {
    const { store, rerender } = mount(false);
    rerender(true);
    act(() => { for (let i = 0; i < 10; i++) store().dispatch(text(i)); });
    const before = seen.length;
    rerender(false);
    // The FIRST render after showing already has the live state.
    expect(seen[before]).toBe(store().getSession(SID));
  });

  it('a paused reader re-rendered for another reason still shows its held state', () => {
    const { store, rerender } = mount(false);
    rerender(true);
    const frozen = seen[seen.length - 1];
    act(() => { store().dispatch(text(0)); });
    rerender(true);
    expect(seen[seen.length - 1]).toBe(frozen);
  });

  it('once un-paused it follows the stream again', () => {
    const { store, rerender } = mount(true);
    rerender(false);
    const before = seen.length;
    act(() => { store().dispatch(text(0)); });
    expect(seen.length).toBeGreaterThan(before);
    expect(seen[seen.length - 1]).toBe(store().getSession(SID));
  });

  it('a paused reader switched to another session reads that session, not the held one', () => {
    const { store, rerender } = mount(false);
    rerender(true);
    rerender(true, OTHER);
    expect(seen[seen.length - 1]).toBe(store().getSession(OTHER));
  });
});
