// @vitest-environment jsdom
// The folder-trust question is an ordinary prompt card (2026-11-01): the
// full-screen TrustGate takeover was removed. What must still hold is that it
// blocks sending until answered — the same way every other unanswered card does
// (pty-input-gate) — and that the "Initializing session…" cover steps aside for it.
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ state: { timeline: [] as any[] } }));

vi.mock('../src/renderer/state/chat-context', () => ({
  useChatStore: () => ({ getSession: () => mocks.state, subscribeSession: () => () => {} }),
}));

import { usePendingPromptActive } from '../src/renderer/state/startup-dialog-store';
import { hasPendingInteraction, pendingInteractionKind } from '../src/renderer/state/pty-input-gate';
import { createSessionChatState, HISTORY_EXPAND_PROMPT_ID } from '../src/renderer/state/chat-types';

function promptEntry(title: string, completed: string | false = false) {
  return { kind: 'prompt', prompt: { promptId: 'p1', title, buttons: [], completed } };
}

describe('trust card blocks sending until answered', () => {
  it('refuses sends while the trust card is unanswered, allows them once answered', () => {
    const session = createSessionChatState();
    session.timeline = [promptEntry('Trust This Folder?')] as any;
    expect(hasPendingInteraction(session)).toBe(true);
    expect(pendingInteractionKind(session)).toBe('prompt');
    session.timeline = [promptEntry('Trust This Folder?', 'Yes, I trust this folder')] as any;
    expect(hasPendingInteraction(session)).toBe(false);
  });
});

describe('usePendingPromptActive', () => {
  it('is true while the trust card (or any card) is unanswered, so the Initializing cover steps aside', () => {
    mocks.state.timeline = [promptEntry('Trust This Folder?')];
    expect(renderHook(() => usePendingPromptActive('s1')).result.current).toBe(true);
  });

  it('is false once it is answered', () => {
    mocks.state.timeline = [promptEntry('Trust This Folder?', 'Yes, I trust this folder')];
    expect(renderHook(() => usePendingPromptActive('s1')).result.current).toBe(false);
  });

  it('ignores the "See previous messages" marker', () => {
    mocks.state.timeline = [{ kind: 'prompt', prompt: { promptId: HISTORY_EXPAND_PROMPT_ID, title: 'x', buttons: [], completed: false } }];
    expect(renderHook(() => usePendingPromptActive('s1')).result.current).toBe(false);
  });
});
