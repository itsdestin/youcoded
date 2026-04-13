// @vitest-environment jsdom
// like-button.test.tsx
// Tests for the LikeButton component — optimistic update, server reconciliation,
// and signed-out guard behavior.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';

import * as AuthContextModule from '../src/renderer/state/marketplace-auth-context';
import LikeButton from '../src/renderer/components/marketplace/LikeButton';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Build and assign a fresh window.claude mock. Returns the likeTheme mock fn for assertions. */
function setupApiMock(likeThemeMock: ReturnType<typeof vi.fn>) {
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.claude = {
    marketplaceApi: {
      likeTheme: likeThemeMock,
    },
  };
}

function mockAuth(signedIn: boolean) {
  vi.spyOn(AuthContextModule, 'useMarketplaceAuth').mockReturnValue({
    signedIn,
    user: signedIn ? { id: 'github:1', login: 'u', avatar_url: '' } : null,
    signInPending: false,
    startSignIn: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
  });
}

/** Helper: returns the heart button element */
function getHeartButton(container: HTMLElement) {
  return container.querySelector('button') as HTMLButtonElement;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('LikeButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // ── Optimistic flip on click ─────────────────────────────────────────────────

  it('flips heart state immediately before API resolves (optimistic)', async () => {
    // Use a promise that we control — won't resolve until we say so
    let resolve!: (value: any) => void;
    const pending = new Promise<any>((res) => { resolve = res; });

    setupApiMock(vi.fn().mockReturnValue(pending));
    mockAuth(true);

    const { container } = render(
      <LikeButton themeId="my-theme" initialCount={5} initialLiked={false} />
    );

    const btn = getHeartButton(container);

    // Before click: aria-pressed = false (not liked)
    expect(btn.getAttribute('aria-pressed')).toBe('false');

    // Click — optimistic update fires synchronously before the API resolves
    await act(async () => {
      fireEvent.click(btn);
    });

    // After click, before API response: button should show liked state optimistically
    expect(btn.getAttribute('aria-pressed')).toBe('true');

    // Clean up: resolve the pending promise so no setState leaks after test
    await act(async () => {
      resolve({ ok: true, value: { liked: true } });
      await Promise.resolve();
    });
  });

  // ── Server ok + liked:true → stay liked ─────────────────────────────────────

  it('stays liked when server returns {ok:true, value:{liked:true}}', async () => {
    const likeTheme = vi.fn().mockResolvedValue({ ok: true, value: { liked: true } });
    setupApiMock(likeTheme);
    mockAuth(true);

    const { container } = render(
      <LikeButton themeId="my-theme" initialCount={5} initialLiked={false} />
    );

    await act(async () => {
      fireEvent.click(getHeartButton(container));
      await Promise.resolve();
    });

    expect(getHeartButton(container).getAttribute('aria-pressed')).toBe('true');
  });

  // ── Server ok + liked:false → back to unliked (server toggled back) ──────────

  it('reverts to unliked when server returns {ok:true, value:{liked:false}}', async () => {
    const likeTheme = vi.fn().mockResolvedValue({ ok: true, value: { liked: false } });
    setupApiMock(likeTheme);
    mockAuth(true);

    const { container } = render(
      <LikeButton themeId="my-theme" initialCount={5} initialLiked={false} />
    );

    await act(async () => {
      fireEvent.click(getHeartButton(container));
      await Promise.resolve();
    });

    // Server said liked:false — should reconcile back to unliked
    expect(getHeartButton(container).getAttribute('aria-pressed')).toBe('false');
  });

  // ── Server 401 → revert ──────────────────────────────────────────────────────

  it('reverts to pre-click state when server returns {ok:false, status:401}', async () => {
    const likeTheme = vi.fn().mockResolvedValue({ ok: false, status: 401, message: 'Unauthorized' });
    setupApiMock(likeTheme);
    mockAuth(true);

    const { container } = render(
      <LikeButton themeId="my-theme" initialCount={5} initialLiked={false} />
    );

    await act(async () => {
      fireEvent.click(getHeartButton(container));
      await Promise.resolve();
    });

    // Should revert to pre-click state (not liked)
    expect(getHeartButton(container).getAttribute('aria-pressed')).toBe('false');
  });

  // ── Signed-out guard ─────────────────────────────────────────────────────────

  it('does NOT call the API when signed out', async () => {
    const likeTheme = vi.fn();
    setupApiMock(likeTheme);
    mockAuth(false); // signed out

    const { container } = render(
      <LikeButton themeId="my-theme" initialCount={5} initialLiked={false} />
    );

    await act(async () => {
      fireEvent.click(getHeartButton(container));
    });

    // API should NOT have been called
    expect(likeTheme).not.toHaveBeenCalled();
  });

  it('does not flip heart state when signed out', async () => {
    setupApiMock(vi.fn());
    mockAuth(false);

    const { container } = render(
      <LikeButton themeId="my-theme" initialCount={5} initialLiked={false} />
    );

    await act(async () => {
      fireEvent.click(getHeartButton(container));
    });

    // State must remain unliked
    expect(getHeartButton(container).getAttribute('aria-pressed')).toBe('false');
  });

  // ── Stats-context reactivity (count sync after mount) ─────────────────────────

  it('updates count when initialCount prop changes (stats load after mount)', async () => {
    setupApiMock(vi.fn());
    mockAuth(false);

    const { rerender, container } = render(
      <LikeButton themeId="t" initialCount={0} />
    );

    // Initial render with 0 — count element should be empty (component hides 0)
    // The aria-label still reflects the count, which is the reliable assertion here
    expect(getHeartButton(container).getAttribute('aria-label')).toContain('0');

    // Stats context loads — re-render with the real count
    await act(async () => {
      rerender(<LikeButton themeId="t" initialCount={42} />);
    });

    // aria-label should now reflect the updated count
    expect(getHeartButton(container).getAttribute('aria-label')).toContain('42');
  });
});
