// @vitest-environment jsdom
// Destin, 2026-09-18: "the switch still lags a second behind me clicking a
// different session name. and clicking a bunch back-and-forth seems to freeze up
// a smidge".
//
// App renders a ChatView for EVERY open session and re-renders on every session
// switch. ChatView was unmemoised AND App handed it three inline arrows, so every
// open conversation re-walked its whole timeline inside the click, ahead of the
// switch's first frame — a cost that grew with the number of tabs and the length
// of each. This pins the shape that fixes it: a switch re-renders the two
// conversations involved and NOTHING else.
//
// Scaffolding mirrors chatview-archive-boundary-memo.test.tsx. The per-session
// render count is read off the mocked useChatState, which ChatView calls exactly
// once per render with its own sessionId.
import React, { useCallback, useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ state: {} as any, renders: {} as Record<string, number> }));

vi.mock('../src/renderer/state/chat-context', () => ({
  useChatState: (id: string) => { mocks.renders[id] = (mocks.renders[id] ?? 0) + 1; return mocks.state; },
  useChatDispatch: () => vi.fn(),
}));

vi.mock('../src/renderer/state/ArtifactContext', () => {
  // ChatView reads the artifact store through narrow selectors (perf, 2026-09-23).
  const state = { drawerOpenBySession: {}, drawerExpanded: false };
  return {
    useArtifactSelector: (select: (s: any) => unknown) => select(state),
    useArtifactDispatch: () => vi.fn(),
  };
});

vi.mock('../src/renderer/components/MarkdownContent', () => ({
  default: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

if (typeof (globalThis as any).IntersectionObserver === 'undefined') {
  (globalThis as any).IntersectionObserver = class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  };
}

import ChatView from '../src/renderer/components/ChatView';

const emptySession = {
  timeline: [] as any[], queuedMessages: [] as any[],
  toolCalls: new Map(), toolGroups: new Map(), assistantTurns: new Map(), activeTurnToolIds: new Set(),
  isThinking: false, promptProcessing: null, attentionState: 'ok', errorMessage: null, stallWarning: null,
  lastActivityAt: 1000, lastOutputAt: 1000,
  modelState: 'idle', modelInfo: null, modelLoadedBytes: 0, modelEverResident: false,
};

let select: (id: string) => void;
let bump: () => void;

/** App's shape, reduced to what matters: every session mounted, one active, and
 *  the props App passes — stable callbacks when `stable`, inline arrows when not. */
function Shell({ stable }: { stable: boolean }) {
  const [active, setActive] = useState('s1');
  const [, setTick] = useState(0);
  select = setActive;
  bump = () => setTick((n) => n + 1);
  const onOpen = useCallback(() => {}, []);
  return (
    <>
      {['s1', 's2', 's3'].map((id) => (
        <ChatView key={id} sessionId={id} visible={id === active} sessionActive={id === active}
          gamePane={null}
          onOpenProviderSettings={stable ? onOpen : () => {}} />
      ))}
    </>
  );
}

beforeEach(() => { mocks.state = emptySession; mocks.renders = {}; });

describe('a session switch re-renders only the two conversations involved', () => {
  it('the uninvolved conversation does no work at all', () => {
    render(<Shell stable />);
    const before = { ...mocks.renders };
    act(() => { select('s2'); });
    expect(mocks.renders.s1).toBeGreaterThan(before.s1);   // left
    expect(mocks.renders.s2).toBeGreaterThan(before.s2);   // arrived
    expect(mocks.renders.s3).toBe(before.s3);              // bystander
  });

  it('an App render that changes nothing about any conversation re-renders none of them', () => {
    render(<Shell stable />);
    const before = { ...mocks.renders };
    act(() => { bump(); });
    expect(mocks.renders).toEqual(before);
  });

  it('ONE inline arrow among the props undoes all of it — which is why App\'s are useCallback', () => {
    // The regression this file exists for, shown live rather than described: the
    // same switch, with an inline arrow, drags the bystander back in.
    render(<Shell stable={false} />);
    const before = { ...mocks.renders };
    act(() => { select('s2'); });
    expect(mocks.renders.s3).toBeGreaterThan(before.s3);
  });
});
