// @vitest-environment jsdom
// ChatView — the chat pane, rendered against a quiescent session.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, cleanup, screen } from '@testing-library/react';

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
  artifact: { drawerOpenBySession: {} as Record<string, boolean>, drawerExpanded: false },
}));

vi.mock('../src/renderer/state/chat-context', () => ({
  useChatState: () => mocks.state,
  useChatDispatch: () => vi.fn(),
}));

// ChatView pulls several app-wide contexts it would normally get from App.
// These tests only care about the pane itself, so they are stubbed rather
// than provided for real.
vi.mock('../src/renderer/state/ArtifactContext', () => ({
  // ChatView reads the artifact store through narrow selectors (perf, 2026-09-23).
  useArtifactSelector: (select: (s: any) => unknown) => select(mocks.artifact),
  useArtifactDispatch: () => vi.fn(),
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
import { ContentFindBar } from '../src/renderer/components/ContentFindBar';

// The chat's Ctrl+F find bar gets its own ROW above the messages, like a
// browser's, instead of a card floating over the first user message. The row
// is an in-flow sibling right before the scroll container inside .chat-pane;
// while it is open the scroll container drops its header-clearing padding
// (chat-scroll--below-find-row) because the content now starts under the row,
// not under the header. The artifact viewer keeps the floating card
// (ContentFindBar's default layout) — untouched.
const ctrlF = () => fireEvent.keyDown(window, { key: 'f', ctrlKey: true });

describe('chat find bar row', () => {
  beforeEach(() => cleanup());

  it('Ctrl+F opens the bar as an in-flow row directly above the scroll container', () => {
    const { container } = render(<ChatView sessionId="s1" visible sessionActive />);
    expect(container.querySelector('.find-row')).toBeNull();
    ctrlF();
    const row = container.querySelector('.chat-pane > .find-row');
    expect(row).toBeTruthy();
    // Not the floating card: in flow, no absolute positioning.
    expect(row!.className).not.toMatch(/\babsolute\b/);
    // Sits immediately before the scroll container so the messages shift down
    // by exactly the row's height.
    const scroll = container.querySelector('.chat-scroll');
    expect(row!.nextElementSibling).toBe(scroll);
    expect(scroll!.className).toContain('chat-scroll--below-find-row');
    // The scroller takes the remaining height rather than 100% of the pane.
    expect(scroll!.className).toContain('flex-1');
    expect(scroll!.className).not.toMatch(/\bh-full\b/);
    // Focus lands in the field, ready to type.
    expect(document.activeElement).toBe(screen.getByLabelText('Find in chat'));
  });

  it('Escape closes the row and the scroll container gets its header padding back', () => {
    const { container } = render(<ChatView sessionId="s1" visible sessionActive />);
    ctrlF();
    const input = screen.getByLabelText('Find in chat');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(container.querySelector('.find-row')).toBeNull();
    expect(container.querySelector('.chat-scroll')!.className).not.toContain('chat-scroll--below-find-row');
  });

  it('Enter / Shift+Enter stay inside the field (navigation, not a close or submit)', () => {
    const onClose = vi.fn();
    const { container } = render(<ChatView sessionId="s1" visible sessionActive />);
    ctrlF();
    const input = screen.getByLabelText('Find in chat');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(container.querySelector('.find-row')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Previous (Shift+Enter)')).toBeTruthy();
    expect(screen.getByLabelText('Next (Enter)')).toBeTruthy();
    expect(screen.getByLabelText('Close (Esc)')).toBeTruthy();
  });

  it('ContentFindBar still floats by default (the artifact viewer is untouched)', () => {
    const ref = { current: document.createElement('div') };
    const { container } = render(
      <ContentFindBar containerRef={ref} onClose={() => {}} resetKey="a" />,
    );
    const bar = container.firstElementChild!;
    expect(bar.className).toMatch(/\babsolute\b/);
    expect(bar.className).not.toContain('find-row');
  });
});

// App renders a ChatView for EVERY open session and used to hide the inactive
// ones with visibility:hidden, which does NOT take an element out of layout.
// Every window-resize tick therefore re-wrapped every open conversation —
// measured at 117ms per resize step with 6 populated sessions (13 long tasks),
// which presents as the window content freezing and then snapping to its new
// size.
//
// The fix keys content-visibility on sessionActive. The two axes MUST stay
// separate: folding this back into `visible` would put the active session's
// chat pane into content-visibility:hidden whenever its terminal tab is
// showing, reintroducing the chat↔terminal reflow that the visibility+opacity
// approach was written to fix in the first place.
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

// The expand flag is app-wide but the drawer is per-session. Expanding in one
// session used to hide the chat of every other session (Destin, 2026-09-19):
// only a session whose own drawer is open may take the expanded layout.
describe('ChatView expanded drawer', () => {
  function shellClass(open: Record<string, boolean>) {
    mocks.artifact.drawerOpenBySession = open;
    mocks.artifact.drawerExpanded = true;
    try {
      // visible=false: the drawer's CONTENTS only mount when visible, and
      // this test is about the shell's layout class, which is computed either way.
      const { container } = render(<ChatView sessionId="s1" visible={false} sessionActive />);
      return container.querySelector('.framed-shell')!.className;
    } finally {
      mocks.artifact.drawerOpenBySession = {};
      mocks.artifact.drawerExpanded = false;
    }
  }

  it('does not expand a session whose drawer is closed', () => {
    expect(shellClass({ other: true })).not.toContain('drawer-expanded');
  });

  it('expands the session whose drawer is open', () => {
    expect(shellClass({ s1: true })).toContain('drawer-expanded');
  });
});
