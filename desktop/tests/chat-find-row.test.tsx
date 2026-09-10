// @vitest-environment jsdom
//
// Pins P-14 (Destin, 2026-08-27): the chat's Ctrl+F find bar gets its own ROW
// above the messages, like a browser's, instead of a card floating over the
// first user message. The row is an in-flow sibling right before the scroll
// container inside .chat-pane; while it is open the scroll container drops its
// header-clearing padding (chat-scroll--below-find-row) because the content
// now starts under the row, not under the header. The artifact viewer keeps
// the floating card (ContentFindBar's default layout) — untouched.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, cleanup, screen } from '@testing-library/react';

// Same quiescent-session mocks as chat-pane-layout-containment.test.tsx.
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

vi.mock('../src/renderer/state/ArtifactContext', () => ({
  useArtifact: () => ({
    state: { drawerOpenBySession: {}, drawerExpanded: false },
    dispatch: vi.fn(),
  }),
}));

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
