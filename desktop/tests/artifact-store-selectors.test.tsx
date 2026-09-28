// @vitest-environment jsdom
// Perf, 2026-09-23 ("many tabs"): the artifact state used to reach its readers
// as ONE context value whose identity changed on every artifact dispatch — an
// agent writing a file in any session, a drawer click, a preview. Every reader
// re-rendered, including every open session's ChatView (routing around its
// React.memo) and every tool card body. The provider now hands down a store
// created once, and readers select only their slice.
//
// This pins the user-facing half of that: a dispatch that touches session A
// does not re-render session B's chat view or tool body. Renders are counted
// with a React Profiler around each session's subtree — safe here because no
// PARENT re-renders during a dispatch (only subscribed readers do), so a
// Profiler commit means something inside that subtree really redrew.
import React, { Profiler } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { ChatProvider } from '../src/renderer/state/chat-context';
import {
  ArtifactProvider,
  createArtifactStore,
  type ArtifactStore,
} from '../src/renderer/state/ArtifactContext';
import type { ToolCallState } from '../src/shared/types';

vi.mock('../src/renderer/components/MarkdownContent', () => ({
  default: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

if (typeof (globalThis as any).IntersectionObserver === 'undefined') {
  (globalThis as any).IntersectionObserver = class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  };
}

import ChatView from '../src/renderer/components/ChatView';
import ToolBody from '../src/renderer/components/tool-views/ToolBody';

const ROOT = '/projects/alpha';
const record = (id: string, path: string) => ({
  id, kind: 'internal', path, status: 'active', versions: [],
} as any);
const writeTool = (path: string): ToolCallState => ({
  id: 'tool-1', toolUseId: 'toolu_1', toolName: 'Write',
  input: { file_path: `${ROOT}/${path}`, content: 'x' }, status: 'complete', response: 'ok',
} as ToolCallState);

let store: ArtifactStore;
let renders: Record<string, number>;
const count = (id: string) => () => { renders[id] = (renders[id] ?? 0) + 1; };

function Tree() {
  return (
    <ChatProvider>
      <ArtifactProvider store={store}>
        {['A', 'B'].map((sid) => (
          <React.Fragment key={sid}>
            <Profiler id={`chat-${sid}`} onRender={count(`chat-${sid}`)}>
              <ChatView sessionId={sid} visible={sid === 'A'} sessionActive={sid === 'A'} gamePane={null} />
            </Profiler>
            <Profiler id={`tool-${sid}`} onRender={count(`tool-${sid}`)}>
              <ToolBody tool={writeTool(`${sid}.md`)} sessionId={sid} />
            </Profiler>
          </React.Fragment>
        ))}
      </ArtifactProvider>
    </ChatProvider>
  );
}

beforeEach(() => {
  renders = {};
  store = createArtifactStore();
  // Both sessions already have a tracked file, so each tool body is a live
  // reader of its own session's list (the clickable file preview).
  store.dispatch({ type: 'SESSION_ARTIFACTS_LOADED', sessionId: 'A', artifacts: [record('a1', 'A.md')] });
  store.dispatch({ type: 'SESSION_ARTIFACTS_LOADED', sessionId: 'B', artifacts: [record('b1', 'B.md')] });
});
afterEach(cleanup);

describe('an artifact dispatch for one session leaves the other session alone', () => {
  it('session A writing a file re-renders A\'s tool body and nothing of B', () => {
    render(<Tree />);
    const before = { ...renders };
    act(() => {
      store.dispatch({ type: 'SESSION_ARTIFACTS_LOADED', sessionId: 'A', artifacts: [record('a1', 'A.md'), record('a2', 'A2.md')] });
    });
    expect(renders['tool-A']).toBeGreaterThan(before['tool-A']);  // the reader that cares
    expect(renders['tool-B']).toBe(before['tool-B']);
    expect(renders['chat-B']).toBe(before['chat-B']);
  });

  it('opening A\'s drawer re-renders A\'s chat and not B\'s', () => {
    render(<Tree />);
    const before = { ...renders };
    act(() => { store.dispatch({ type: 'DRAWER_OPENED', sessionId: 'A' }); });
    expect(renders['chat-A']).toBeGreaterThan(before['chat-A']);  // control: it does redraw
    expect(renders['chat-B']).toBe(before['chat-B']);
    expect(renders['tool-B']).toBe(before['tool-B']);
  });

  it('a pill lookup, a selection and a preview in A do not reach B', () => {
    render(<Tree />);
    const before = { ...renders };
    act(() => {
      store.dispatch({ type: 'PILL_RESOLVE_STARTED', sessionId: 'A', name: 'x.md' });
      store.dispatch({ type: 'ACTIVE_ARTIFACT_SET', sessionId: 'A', artifactId: 'a1' });
      store.dispatch({ type: 'SESSION_PREVIEW_SET', sessionId: 'A', provider: 'claude', id: 'c1', title: 'T' });
      store.dispatch({ type: 'SET_SESSION_CWD', sessionId: 'A', cwd: ROOT });
    });
    expect(renders['chat-B']).toBe(before['chat-B']);
    expect(renders['tool-B']).toBe(before['tool-B']);
  });
});

describe('the artifact store', () => {
  it('keeps one dispatch for its whole life and stays silent when nothing changed', () => {
    const s = createArtifactStore();
    const d = s.dispatch;
    const heard = vi.fn();
    s.subscribe(heard);
    s.dispatch({ type: 'DRAWER_OPENED', sessionId: 'A' });
    expect(heard).toHaveBeenCalledTimes(1);
    // Removing a session with no entries returns the same state — no wake-up.
    s.dispatch({ type: 'SESSION_REMOVED', sessionId: 'never-seen' });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(s.dispatch).toBe(d);
  });
});
