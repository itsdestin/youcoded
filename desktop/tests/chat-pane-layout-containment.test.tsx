// @vitest-environment jsdom
// Regression test (2026-08-05): App renders a ChatView for EVERY open session
// and hid the inactive ones with visibility:hidden, which does NOT take an
// element out of layout. Every window-resize tick therefore re-wrapped every
// open conversation — measured at 117ms per resize step with 6 populated
// sessions (13 long tasks), which presents as the window content freezing and
// then snapping to its new size.
//
// The fix keys content-visibility on sessionActive. The two axes MUST stay
// separate: folding this back into `visible` would put the active session's
// chat pane into content-visibility:hidden whenever its terminal tab is
// showing, reintroducing the chat↔terminal reflow that the visibility+opacity
// approach was written to fix in the first place.
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

// A quiescent session — every field ChatView reads, at its empty value.
const mocks = vi.hoisted(() => ({
  state: {
    timeline: [] as any[],
    queuedMessages: [] as any[],
    toolCalls: new Map(),
    toolGroups: new Map(),
    assistantTurns: new Map(),
    activeTurnToolIds: new Set(),
    isThinking: false,
    promptProcessing: null,
    attentionState: 'ok',
    errorMessage: null,
    stallWarning: null,
    lastActivityAt: 0,
    lastOutputAt: 0,
    modelState: 'idle',
    modelInfo: null,
    modelLoadedBytes: 0,
    modelEverResident: false,
  },
}));

vi.mock('../src/renderer/state/chat-context', () => ({
  useChatState: () => mocks.state,
  useChatDispatch: () => vi.fn(),
}));

// ChatView pulls several app-wide contexts it would normally get from App.
// This test only cares about the pane root's style, so they are stubbed
// rather than provided for real.
vi.mock('../src/renderer/state/ArtifactContext', () => ({
  useArtifact: () => ({
    state: { drawerOpenBySession: {}, drawerExpanded: false },
    dispatch: vi.fn(),
  }),
}));

// jsdom ships no IntersectionObserver; ChatView constructs one for its
// visible-bubble blur optimisation.
if (typeof (globalThis as any).IntersectionObserver === 'undefined') {
  (globalThis as any).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
}

import ChatView from '../src/renderer/components/ChatView';

/** The absolutely-positioned pane root ChatView returns. */
function paneRoot(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('div[style*="position: absolute"]');
  if (!el) throw new Error('ChatView pane root not found');
  return el;
}

function renderPane(props: { visible: boolean; sessionActive: boolean }) {
  const { container } = render(
    <ChatView sessionId="s1" visible={props.visible} sessionActive={props.sessionActive} />,
  );
  return paneRoot(container).style;
}

describe('ChatView pane layout containment', () => {
  it('takes an INACTIVE session out of layout', () => {
    const style = renderPane({ visible: false, sessionActive: false });
    expect(style.contentVisibility).toBe('hidden');
  });

  it('keeps the ACTIVE session in layout', () => {
    const style = renderPane({ visible: true, sessionActive: true });
    expect(style.contentVisibility).toBe('visible');
    // Not 'visible': the active pane INHERITS visibility (no inline value), so
    // an ancestor can hide the whole chat column under a floating-chrome
    // screen (App's data-screen-open, 2026-09-17). Only 'hidden' is a bug here.
    expect(style.visibility).not.toBe('hidden');
  });

  it('keeps the active session IN layout while its terminal tab is showing', () => {
    // This is the case that must not regress: the chat↔terminal toggle stays
    // on the visibility path so the toggle causes no reflow and focus/IME
    // survive it. content-visibility must NOT follow `visible` here.
    const style = renderPane({ visible: false, sessionActive: true });
    expect(style.contentVisibility).toBe('visible');
    expect(style.visibility).toBe('hidden');
  });
});
