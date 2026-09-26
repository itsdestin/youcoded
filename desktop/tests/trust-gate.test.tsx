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
  dispatch: vi.fn(),
  send: vi.fn(),
}));

vi.mock('../src/renderer/state/prompt-input', () => ({
  sendPromptInput: (...a: unknown[]) => mocks.send(...a),
  PROMPT_FAILURE_COPY: { 'menu-changed': 'options changed', 'menu-gone': 'gone', 'not-taken': 'not taken' },
  PROMPT_UNKNOWN_FAILURE: 'may not have reached',
}));

// useTrustGateActive reads through the store (a cached selector since
// 2026-09-16 — see its WHY), so the mock exposes the same state via the two
// store methods the selector uses. Each test assigns a NEW timeline array, so
// the selector's timeline-identity cache rescans per case.
vi.mock('../src/renderer/state/chat-context', () => ({
  useChatState: () => mocks.state,
  useChatDispatch: () => mocks.dispatch,
  useChatStore: () => ({
    getSession: () => mocks.state,
    subscribeSession: () => () => {},
  }),
}));

import TrustGate, { useTrustGateActive, usePendingPromptActive } from '../src/renderer/components/TrustGate';
import { render, screen, fireEvent, act } from '@testing-library/react';

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

describe('TrustGate answering', () => {
  const trustPrompt = () => ({
    kind: 'prompt',
    prompt: {
      promptId: 'p1', title: 'Trust This Folder?', completed: false,
      buttons: [
        { label: 'No, exit', input: '', pick: { signature: 'sig', index: 0 } },
        { label: 'Yes, I trust this folder', input: '', pick: { signature: 'sig', index: 1 } },
      ],
    },
  });

  it('stays up and says why when Claude Code did not take the answer — never marks it answered', async () => {
    mocks.state.timeline = [trustPrompt()];
    mocks.dispatch.mockClear();
    mocks.send.mockReset();
    mocks.send.mockResolvedValue({ ok: false, reason: 'menu-changed', typed: false });
    render(<TrustGate sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, I trust this folder' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'options changed');
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('marks the prompt answered only once Claude Code took it', async () => {
    mocks.state.timeline = [trustPrompt()];
    mocks.dispatch.mockClear();
    mocks.send.mockReset();
    mocks.send.mockResolvedValue({ ok: true });
    render(<TrustGate sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'No, exit' }));
    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'COMPLETE_PROMPT', selection: 'No, exit' })));
    expect(mocks.send.mock.calls[0][1]).toMatchObject({ label: 'No, exit', pick: { index: 0 } });
  });
});

describe('usePendingPromptActive', () => {
  it('is true while any prompt card is unanswered, so the Initializing cover steps aside', () => {
    mocks.state.timeline = [promptEntry('Skip Permissions Warning')];
    expect(renderHook(() => usePendingPromptActive('s1')).result.current).toBe(true);
  });

  it('is false once it is answered', () => {
    mocks.state.timeline = [promptEntry('Skip Permissions Warning', 'Yes, I accept')];
    expect(renderHook(() => usePendingPromptActive('s1')).result.current).toBe(false);
  });
});

describe('TrustGate — one answer at a time', () => {
  const trust = () => ({
    kind: 'prompt',
    prompt: {
      promptId: 'p1', title: 'Trust This Folder?', completed: false,
      buttons: [
        { label: 'No, exit', input: '', pick: { signature: 'sig', index: 0 } },
        { label: 'Yes, I trust this folder', input: '', pick: { signature: 'sig', index: 1 } },
      ],
    },
  });

  it('disables both buttons while an answer is being typed', () => {
    mocks.state.timeline = [trust()];
    mocks.send.mockReset();
    mocks.send.mockReturnValue(new Promise(() => {}));
    render(<TrustGate sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'No, exit' }));
    expect((screen.getByRole('button', { name: 'Yes, I trust this folder' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'No, exit' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('two clicks in one frame (before the re-render) start ONE answer, not two interleaved ones', () => {
    mocks.state.timeline = [trust()];
    mocks.send.mockReset();
    mocks.send.mockReturnValue(new Promise(() => {}));
    render(<TrustGate sessionId="s1" />);
    const no = screen.getByRole('button', { name: 'No, exit' });
    const yes = screen.getByRole('button', { name: 'Yes, I trust this folder' });
    act(() => { no.click(); yes.click(); });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
});

describe('TrustGate — an answer that throws', () => {
  it('releases the buttons and says it may not have gone through', async () => {
    mocks.state.timeline = [{ kind: 'prompt', prompt: { promptId: 'p1', title: 'Trust This Folder?', completed: false,
      buttons: [{ label: 'No, exit', input: '', pick: { signature: 's', index: 0 } }] } }];
    mocks.send.mockReset();
    mocks.send.mockRejectedValue(new Error('boom'));
    render(<TrustGate sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'No, exit' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'No, exit' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
