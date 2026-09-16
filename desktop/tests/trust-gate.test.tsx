// @vitest-environment jsdom
// Regression test (2026-07-16): TrustGate matched prompts with
// title.includes('trust'), so any prompt whose title merely contained the word
// (e.g. a mislabeled or future "…untrusted…" prompt) was hijacked by the
// full-screen trust takeover with its hardcoded folder-permission body text.
// TrustGate must claim ONLY the parser's canonical trust title.
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  state: { timeline: [] as any[] },
}));

// useTrustGateActive reads through the store (a cached selector since
// 2026-09-16 — see its WHY), so the mock exposes the same state via the two
// store methods the selector uses. Each test assigns a NEW timeline array, so
// the selector's timeline-identity cache rescans per case.
vi.mock('../src/renderer/state/chat-context', () => ({
  useChatState: () => mocks.state,
  useChatDispatch: () => vi.fn(),
  useChatStore: () => ({
    getSession: () => mocks.state,
    subscribeSession: () => () => {},
  }),
}));

import { useTrustGateActive } from '../src/renderer/components/TrustGate';

function promptEntry(title: string, completed: string | false = false) {
  return {
    kind: 'prompt',
    prompt: { promptId: 'p1', title, buttons: [], completed },
  };
}

describe('useTrustGateActive', () => {
  it('activates for the canonical trust prompt title', () => {
    mocks.state.timeline = [promptEntry('Trust This Folder?')];
    const { result } = renderHook(() => useTrustGateActive('s1'));
    expect(result.current).toBe(true);
  });

  it('does NOT activate for other titles that merely contain "trust"', () => {
    mocks.state.timeline = [promptEntry('Untrusted files warning')];
    const { result } = renderHook(() => useTrustGateActive('s1'));
    expect(result.current).toBe(false);
  });

  it('does NOT activate for the model-safeguard prompt', () => {
    mocks.state.timeline = [promptEntry('Message Flagged')];
    const { result } = renderHook(() => useTrustGateActive('s1'));
    expect(result.current).toBe(false);
  });

  it('ignores completed trust prompts', () => {
    mocks.state.timeline = [promptEntry('Trust This Folder?', 'Yes, I trust this folder')];
    const { result } = renderHook(() => useTrustGateActive('s1'));
    expect(result.current).toBe(false);
  });
});
