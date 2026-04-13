// @vitest-environment jsdom
// report-review-button.test.tsx
// Tests for ReportReviewButton — signed-out guard, dialog open, submit success,
// 429 rate-limit, generic error, and optional reason forwarding.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act, screen } from '@testing-library/react';

import * as AuthContextModule from '../src/renderer/state/marketplace-auth-context';
import ReportReviewButton from '../src/renderer/components/marketplace/ReportReviewButton';

// ── Mock helpers ───────────────────────────────────────────────────────────────

function mockAuth(signedIn: boolean) {
  vi.spyOn(AuthContextModule, 'useMarketplaceAuth').mockReturnValue({
    signedIn,
    user: signedIn ? { id: 'github:1', login: 'alice', avatar_url: '' } : null,
    signInPending: false,
    startSignIn: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
  });
}

function setupApiMock(reportMock: ReturnType<typeof vi.fn>) {
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.claude = {
    marketplaceApi: {
      report: reportMock,
    },
  };
}

function renderButton(overrides: Partial<React.ComponentProps<typeof ReportReviewButton>> = {}) {
  return render(
    <ReportReviewButton
      ratingUserId="github:42"
      pluginId="test-plugin"
      reviewerLogin="alice"
      {...overrides}
    />
  );
}

/** Get the flag icon trigger button */
function getFlagButton() {
  return screen.getByRole('button', { name: /report review by/i }) as HTMLButtonElement;
}

/** Get the "Report review" submit button inside the dialog */
function getSubmitButton() {
  return screen.getByRole('button', { name: /report review$/i }) as HTMLButtonElement;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('ReportReviewButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.restoreAllMocks();
  });

  // ── Signed-out: no API call, inline toast present ────────────────────────────

  it('does NOT call the API when signed out', async () => {
    const reportMock = vi.fn();
    setupApiMock(reportMock);
    mockAuth(false);

    renderButton();

    await act(async () => {
      fireEvent.click(getFlagButton());
    });

    expect(reportMock).not.toHaveBeenCalled();
  });

  it('shows a signed-out toast message instead of the dialog when signed out', async () => {
    setupApiMock(vi.fn());
    mockAuth(false);

    renderButton();

    await act(async () => {
      fireEvent.click(getFlagButton());
    });

    // Toast should appear with a sign-in message; dialog should NOT be open
    const toast = screen.getByRole('status');
    expect(toast.textContent).toMatch(/sign in/i);
    // Dialog title must not be present
    expect(screen.queryByText(/report this review/i)).toBeNull();
  });

  // ── Signed-in: dialog opens ──────────────────────────────────────────────────

  it('opens the confirmation dialog when signed in', async () => {
    setupApiMock(vi.fn());
    mockAuth(true);

    renderButton();

    await act(async () => {
      fireEvent.click(getFlagButton());
    });

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(/report this review/i)).toBeTruthy();
  });

  // ── Submit success: shows confirmation, then closes ──────────────────────────

  it('shows "Report submitted" confirmation on success, then closes the dialog', async () => {
    const reportMock = vi.fn().mockResolvedValue({ ok: true });
    setupApiMock(reportMock);
    mockAuth(true);

    renderButton();

    // Open dialog
    await act(async () => {
      fireEvent.click(getFlagButton());
    });

    // Submit
    await act(async () => {
      fireEvent.click(getSubmitButton());
      await Promise.resolve();
    });

    // Success message appears
    const successMsg = screen.getByRole('status');
    expect(successMsg.textContent).toMatch(/report submitted/i);

    // After 2 seconds the dialog closes
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // ── 429 rate-limit: inline message, dialog stays open ───────────────────────

  it('shows rate-limit message on 429 and keeps the dialog open', async () => {
    const reportMock = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    setupApiMock(reportMock);
    mockAuth(true);

    renderButton();

    await act(async () => {
      fireEvent.click(getFlagButton());
    });

    await act(async () => {
      fireEvent.click(getSubmitButton());
      await Promise.resolve();
    });

    // Error alert with rate-limit copy
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/too many|try again later/i);

    // Dialog still open
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  // ── Generic error: inline message, dialog stays open ────────────────────────

  it('shows generic error message on non-429 failure and keeps the dialog open', async () => {
    const reportMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    setupApiMock(reportMock);
    mockAuth(true);

    renderButton();

    await act(async () => {
      fireEvent.click(getFlagButton());
    });

    await act(async () => {
      fireEvent.click(getSubmitButton());
      await Promise.resolve();
    });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/couldn't submit/i);

    // Dialog still open
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  // ── Optional reason forwarded to API ────────────────────────────────────────

  it('passes the typed reason to the API call', async () => {
    const reportMock = vi.fn().mockResolvedValue({ ok: true });
    setupApiMock(reportMock);
    mockAuth(true);

    renderButton();

    // Open dialog
    await act(async () => {
      fireEvent.click(getFlagButton());
    });

    // Type a reason
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Spam content in this review' } });

    // Submit
    await act(async () => {
      fireEvent.click(getSubmitButton());
      await Promise.resolve();
    });

    expect(reportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rating_user_id: 'github:42',
        rating_plugin_id: 'test-plugin',
        reason: 'Spam content in this review',
      })
    );
  });

  // ── Aria label with fallback ──────────────────────────────────────────────────

  it('uses "reviewer" as fallback in aria-label when reviewerLogin is not provided', () => {
    setupApiMock(vi.fn());
    mockAuth(true);

    renderButton({ reviewerLogin: undefined });

    expect(screen.getByRole('button', { name: /report review by reviewer/i })).toBeTruthy();
  });
});
