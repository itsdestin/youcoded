// @vitest-environment jsdom
// The app root must not redraw on every streamed word.
//
// AppInner read the streaming session's WHOLE state three times — through
// useSessionTasks (for the tasks chip), useTrustGateActive (for the trust
// overlay) and a bare useChatState (for one "is it thinking" flag). Each of
// those re-rendered the entire shell — header, session pills, status bar,
// input bar, the parked settings drawer and every session's chat and terminal
// — once per streamed word, about 60 times a second while a reply arrived.
// The three hooks now return a primitive or a Map whose identity the reducer
// preserves across text deltas, so useSyncExternalStore skips the render.
//
// Counting renders of a component that uses all three: 40 deltas → 0 renders.
// A tool event still re-renders (the tasks map changed); a turn ending still
// re-renders (isThinking flipped) — pinned so the selectors cannot go dead.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { ChatProvider, useChatStore, useSessionIsThinking, type ChatStore } from '../src/renderer/state/chat-context';
import type { ChatAction } from '../src/renderer/state/chat-types';
import { useSessionTasks } from '../src/renderer/hooks/useSessionTasks';
import { useTrustGateActive } from '../src/renderer/components/TrustGate';
import ToolBody from '../src/renderer/components/tool-views/ToolBody';
import type { ToolCallState } from '../src/shared/types';

const SID = 's1';
let renders = 0;

function Probe() {
  renders++;
  useSessionTasks(SID);
  useTrustGateActive(SID);
  useSessionIsThinking(SID);
  return null;
}

function Harness({ onStore }: { onStore: (s: ChatStore) => void }) {
  onStore(useChatStore());
  return <Probe />;
}

function mount(): ChatStore {
  let store!: ChatStore;
  render(<ChatProvider><Harness onStore={(s) => { store = s; }} /></ChatProvider>);
  act(() => { store.dispatch({ type: 'SESSION_INIT', sessionId: SID }); });
  return store;
}

const text = (i: number): ChatAction => ({ type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SID, uuid: `u${i}`, text: 'word ', timestamp: i } as ChatAction);

afterEach(() => { cleanup(); renders = 0; });

describe('the app root and a streaming reply', () => {
  it('40 streamed words cause 0 re-renders of a component using all three root hooks', () => {
    const store = mount();
    act(() => { store.dispatch(text(0)); }); // creates the turn; the first delta is a structural change
    const before = renders;
    act(() => { for (let i = 1; i <= 40; i++) store.dispatch(text(i)); });
    expect(renders - before).toBe(0);
  });

  it('a tool event still re-renders (the tasks map changed)', () => {
    const store = mount();
    act(() => { store.dispatch(text(0)); });
    const before = renders;
    act(() => {
      store.dispatch({ type: 'TRANSCRIPT_TOOL_USE', sessionId: SID, uuid: 'uuid-call-1', toolUseId: 'call-1', toolName: 'Bash', toolInput: { command: 'ls' }, timestamp: 5 } as ChatAction);
    });
    expect(renders - before).toBe(1);
  });

  it('the turn ending still re-renders (isThinking flipped)', () => {
    const store = mount();
    act(() => { store.dispatch(text(0)); });
    const before = renders;
    act(() => { store.dispatch({ type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: SID } as ChatAction); });
    expect(renders - before).toBe(1);
  });
});

// A6: an EXPANDED tool card's body subscribed to the whole session (for the
// TaskUpdate view's task map), routing around ToolCard's memo comparator —
// every open card re-rendered per streamed word. Nothing above the body
// re-renders on a store dispatch here, so a Profiler commit count on the
// body's subtree is the body's own render count.
describe('an expanded tool card and a streaming reply', () => {
  const bash: ToolCallState = {
    id: 'x', toolUseId: 'toolu_1', toolName: 'Bash', status: 'complete',
    input: { command: 'ls', description: 'List files' }, response: 'a\nb\n',
  } as ToolCallState;

  it('40 streamed words cause 0 re-renders of the body', () => {
    let store!: ChatStore;
    let commits = 0;
    function Grab() { store = useChatStore(); return null; }
    render(
      <ChatProvider>
        <Grab />
        <React.Profiler id="body" onRender={() => { commits++; }}>
          <ToolBody tool={bash} sessionId={SID} />
        </React.Profiler>
      </ChatProvider>,
    );
    act(() => { store.dispatch({ type: 'SESSION_INIT', sessionId: SID }); store.dispatch(text(0)); });
    const before = commits;
    act(() => { for (let i = 1; i <= 40; i++) store.dispatch(text(i)); });
    expect(commits - before).toBe(0);
  });

  it('a tool event still re-renders the body (the task map may have changed)', () => {
    let store!: ChatStore;
    let commits = 0;
    function Grab() { store = useChatStore(); return null; }
    render(
      <ChatProvider>
        <Grab />
        <React.Profiler id="body" onRender={() => { commits++; }}>
          <ToolBody tool={bash} sessionId={SID} />
        </React.Profiler>
      </ChatProvider>,
    );
    act(() => { store.dispatch({ type: 'SESSION_INIT', sessionId: SID }); store.dispatch(text(0)); });
    const before = commits;
    act(() => {
      store.dispatch({ type: 'TRANSCRIPT_TOOL_USE', sessionId: SID, uuid: 'uuid-call-2', toolUseId: 'call-2', toolName: 'Bash', toolInput: { command: 'ls' }, timestamp: 6 } as ChatAction);
    });
    expect(commits - before).toBe(1);
  });
});
