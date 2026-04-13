// @vitest-environment jsdom
// rating-submit-modal.test.tsx
// Tests for RatingSubmitModal — signed-out state, happy-path submit,
// 403 install-gate, 429 rate-limit, and success close/callback behavior.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act, screen } from '@testing-library/react';

import * as AuthContextModule from '../src/renderer/state/marketplace-auth-context';
import * as StatsContextModule from '../src/renderer/state/marketplace-stats-context';
import RatingSubmitModal from '../src/renderer/components/marketplace/RatingSubmitModal';

// ── Mock helpers ───────────────────────────────────────────────────────────────

function mockAuth(signedIn: boolean, startSignIn = vi.fn().mockResolvedValue(undefined)) {
  vi.spyOn(AuthContextModule, 'useMarketplaceAuth').mockReturnValue({
    signedIn,
    user: signedIn ? { id: 'github:1', login: 'alice', avatar_url: '' } : null,
    signInPending: false,
    startSignIn,
    signOut: vi.fn().mockResolvedValue(undefined),
  });
}

function mockStats(refreshMock = vi.fn().mockResolvedValue(undefined)) {
  vi.spyOn(StatsContextModule, 'useMarketplaceStats').mockReturnValue({
    loading: false,
    plugins: {},
    themes: {},
    refresh: refreshMock,
  });
  return refreshMock;
}

function setupApiMock(overrides: Partial<typeof window.claude.marketplaceApi> = {}) {
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.claude = {
    marketplaceApi: {
      rate: vi.fn().mockResolvedValue({ ok: true, value: { hidden: false } }),
      install: vi.fn().mockResolvedValue({ ok: true }),
      deleteRating: vi.fn(),
      likeTheme: vi.fn(),
      report: vi.fn(),
      ...overrides,
    },
  };
}

function renderModal(props: Partial<React.ComponentProps<typeof RatingSubmitModal>> = {}) {
  const defaults = {
    pluginId: 'test-plugin',
    open: true,
    onClose: vi.fn(),
    onSubmitted: vi.fn(),
  };
  return render(<RatingSubmitModal {...defaults} {...props} />);
}

/** Click star N (1-5) in the picker */
function clickStar(n: number) {
  const starButtons = screen.getAllByRole('radio');
  fireEvent.click(starButtons[n - 1]);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('RatingSubmitModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // ── Signed-out state ─────────────────────────────────────────────────────────

  it('shows sign-in message instead of form when signed out', () => {
    mockAuth(false);
    mockStats();
    setupApiMock();

    renderModal();

    // Must show the sign-in prompt — check for the button specifically (the <p> also contains "sign in")
    expect(screen.getByRole('button', { name: /sign in with github/i })).toBeTruthy();
    // Must NOT render the star picker
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    // Must NOT render the submit button
    expect(screen.queryByRole('button', { name: /submit rating/i })).toBeNull();
  });

  it('calls startSignIn when the sign-in button is clicked (signed out)', async () => {
    const startSignIn = vi.fn().mockResolvedValue(undefined);
    mockAuth(false, startSignIn);
    mockStats();
    setupApiMock();

    renderModal();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in with github/i }));
    });

    expect(startSignIn).toHaveBeenCalledTimes(1);
  });

  // ── Star picker + textarea ───────────────────────────────────────────────────

  it('renders 5 star radio buttons when signed in', () => {
    mockAuth(true);
    mockStats();
    setupApiMock();

    renderModal();

    expect(screen.getAllByRole('radio')).toHaveLength(5);
  });

  it('keeps submit button disabled until a star is selected', () => {
    mockAuth(true);
    mockStats();
    setupApiMock();

    renderModal();

    const submitBtn = screen.getByRole('button', { name: /submit rating/i });
    expect((submitBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables submit button after selecting a star', async () => {
    mockAuth(true);
    mockStats();
    setupApiMock();

    renderModal();

    await act(async () => { clickStar(4); });

    const submitBtn = screen.getByRole('button', { name: /submit rating/i });
    expect((submitBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it('calls marketplaceApi.rate with correct args on submit', async () => {
    const rateMock = vi.fn().mockResolvedValue({ ok: true, value: { hidden: false } });
    mockAuth(true);
    mockStats();
    setupApiMock({ rate: rateMock });

    renderModal();

    await act(async () => { clickStar(5); });

    // Type review text
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Excellent plugin!' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit rating/i }));
      await Promise.resolve();
    });

    expect(rateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        plugin_id: 'test-plugin',
        stars: 5,
        review_text: 'Excellent plugin!',
      })
    );
  });

  // ── 403 install-gate ─────────────────────────────────────────────────────────

  it('shows install-gate affordance on 403 response', async () => {
    const rateMock = vi.fn().mockResolvedValue({ ok: false, status: 403, message: 'must install first' });
    mockAuth(true);
    mockStats();
    setupApiMock({ rate: rateMock });

    renderModal();

    await act(async () => { clickStar(3); });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit rating/i }));
      await Promise.resolve();
    });

    // Should show the install-and-rate button
    expect(screen.getByRole('button', { name: /install and rate/i })).toBeTruthy();
    // The regular submit row should be hidden while install-gate is shown
    expect(screen.queryByRole('button', { name: /submit rating/i })).toBeNull();
  });

  it('calls install then rate when "Install and rate" is clicked', async () => {
    const rateMock = vi
      .fn()
      // First call: 403 install-gate
      .mockResolvedValueOnce({ ok: false, status: 403, message: 'must install first' })
      // Second call (after install): success
      .mockResolvedValueOnce({ ok: true, value: { hidden: false } });

    const installMock = vi.fn().mockResolvedValue({ ok: true });
    const onSubmitted = vi.fn();
    const onClose = vi.fn();
    const refresh = mockStats();

    mockAuth(true);
    setupApiMock({ rate: rateMock, install: installMock });

    render(
      <RatingSubmitModal
        pluginId="test-plugin"
        open
        onClose={onClose}
        onSubmitted={onSubmitted}
      />
    );

    // First: trigger 403
    await act(async () => { clickStar(4); });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit rating/i }));
      await Promise.resolve();
    });

    // Now click Install and rate
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /install and rate/i }));
      await Promise.resolve();
    });

    expect(installMock).toHaveBeenCalledWith('test-plugin');
    expect(rateMock).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(onSubmitted).toHaveBeenCalled();
  });

  // ── 429 rate-limit ───────────────────────────────────────────────────────────

  it('shows rate-limit message on 429 response', async () => {
    const rateMock = vi.fn().mockResolvedValue({ ok: false, status: 429, message: 'too many requests' });
    mockAuth(true);
    mockStats();
    setupApiMock({ rate: rateMock });

    renderModal();

    await act(async () => { clickStar(2); });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit rating/i }));
      await Promise.resolve();
    });

    expect(screen.getByRole('alert').textContent).toMatch(/too many|last hour/i);
  });

  // ── Success ──────────────────────────────────────────────────────────────────

  it('closes modal and fires onSubmitted on success', async () => {
    const rateMock = vi.fn().mockResolvedValue({ ok: true, value: { hidden: false } });
    const onClose = vi.fn();
    const onSubmitted = vi.fn();
    const refresh = mockStats();
    mockAuth(true);
    setupApiMock({ rate: rateMock });

    render(
      <RatingSubmitModal
        pluginId="test-plugin"
        open
        onClose={onClose}
        onSubmitted={onSubmitted}
      />
    );

    await act(async () => { clickStar(5); });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit rating/i }));
      await Promise.resolve();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalled();
  });

  // ── Offline error: specific message + Retry button ───────────────────────────

  it('shows offline message and Retry button when rate rejects with TypeError', async () => {
    // TypeError simulates a fetch-level network failure (offline / DNS failure)
    const rateMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const onClose = vi.fn();
    mockAuth(true);
    mockStats();
    setupApiMock({ rate: rateMock });

    render(
      <RatingSubmitModal
        pluginId="test-plugin"
        open
        onClose={onClose}
        onSubmitted={vi.fn()}
      />
    );

    await act(async () => { clickStar(3); });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit rating/i }));
      await Promise.resolve();
    });

    // Offline-specific error message
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/offline/i);

    // Retry button should be visible
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('retries the submission when Retry is clicked after offline error', async () => {
    const rateMock = vi
      .fn()
      // First call: offline failure
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      // Second call (retry): success
      .mockResolvedValueOnce({ ok: true, value: { hidden: false } });

    const onClose = vi.fn();
    const onSubmitted = vi.fn();
    const refresh = mockStats();
    mockAuth(true);
    setupApiMock({ rate: rateMock });

    render(
      <RatingSubmitModal
        pluginId="test-plugin"
        open
        onClose={onClose}
        onSubmitted={onSubmitted}
      />
    );

    await act(async () => { clickStar(4); });

    // First submit — fails offline
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit rating/i }));
      await Promise.resolve();
    });

    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();

    // Click Retry — succeeds
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /retry/i }));
      await Promise.resolve();
    });

    expect(rateMock).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(onSubmitted).toHaveBeenCalled();
  });

  // ── Not-open state ───────────────────────────────────────────────────────────

  it('renders nothing when open=false', () => {
    mockAuth(true);
    mockStats();
    setupApiMock();

    const { container } = renderModal({ open: false });
    expect(container.firstChild).toBeNull();
  });
});
