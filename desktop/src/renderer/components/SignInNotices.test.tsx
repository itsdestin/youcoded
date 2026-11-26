// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import { ProviderSignInCard } from './SignInNotices';
import { startSignIn, resetSignIn } from '../state/provider-sign-in-store';
import { useExpiredSignIns } from '../hooks/useExpiredSignIns';

// Card #236: the per-provider sign-in outcome lives for the whole app run, so a LATER expiry must not
// draw the earlier "Sign in successful" card (review F1), and the card tells never-signed-in apart (F4).
function Dot() { return <span data-testid="dot">{String(useExpiredSignIns())}</span>; }

describe('the ChatGPT / OpenRouter sign-in card', () => {
  let chatgptStatus: any;
  const claudeStatus = vi.fn(async (_o?: any) => ({ state: 'signed-in', apiKey: false }));
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    chatgptStatus = { state: 'signed-out', expired: true };
    (window as any).claude = {
      capabilities: { openExternal: true },
      network: { check: async () => ({ online: true }) },
      chatgpt: { supported: true, status: async () => chatgptStatus, signIn: async () => true, cancelSignIn: async () => true },
      claudeCode: { status: claudeStatus, signIn: async () => true, cancelSignIn: async () => true },
    };
  });
  afterEach(() => { cleanup(); resetSignIn('chatgpt'); resetSignIn('claude'); vi.useRealTimers(); delete (window as any).claude; claudeStatus.mockClear(); });

  async function signInThroughStore() {
    chatgptStatus = { state: 'signed-out' };
    const done = startSignIn('chatgpt');
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    chatgptStatus = { state: 'signed-in' }; // the person finished in the browser
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    await done;
  }

  it('shows "Sign in successful" right after a sign-in done on the same card', async () => {
    const { container, getByRole } = render(<ProviderSignInCard provider="chatgpt" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(getByRole('button', { name: 'Sign in' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    chatgptStatus = { state: 'signed-in' };
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(container.textContent).toContain('Sign in successful.');
  });

  it('a NEW expiry later in the same app run draws the red expired card with its button, not the old success', async () => {
    await signInThroughStore();
    chatgptStatus = { state: 'signed-out', expired: true }; // expired again hours later
    const { container, getByRole } = render(<ProviderSignInCard provider="chatgpt" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(container.textContent).toContain('Your ChatGPT sign-in has expired.');
    expect(container.textContent).not.toContain('Sign in successful');
    expect(getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('a person who never connected ChatGPT is told to sign in, not that a sign-in expired', () => {
    const { container } = render(<ProviderSignInCard provider="chatgpt" neverSignedIn />);
    expect(container.textContent).toContain('Sign in to ChatGPT to use this model.');
    expect(container.textContent).not.toContain('expired');
  });

  it('a failed reply makes the settings gear look again', async () => {
    const dot = render(<Dot />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const before = claudeStatus.mock.calls.length;
    render(<ProviderSignInCard provider="chatgpt" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(claudeStatus.mock.calls.length).toBeGreaterThan(before);
    dot.unmount();
  });

  it('the Claude sign-in wait never asks for a forced re-read (main already re-reads every 2 s)', async () => {
    const done = startSignIn('claude');
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    await done;
    expect(claudeStatus).toHaveBeenCalled();
    for (const call of claudeStatus.mock.calls) expect(call[0]?.refresh).not.toBe(true);
  });
});
