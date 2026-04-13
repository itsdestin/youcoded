// @vitest-environment jsdom
// review-list.test.tsx
// Tests for ReviewList — loading state, empty state, populated list, error state.
// Mocks the module-level apiClient inside ReviewList by mocking fetch directly.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, screen } from '@testing-library/react';

import ReviewList from '../src/renderer/components/marketplace/ReviewList';
import type { RatingEntry } from '../src/renderer/state/marketplace-api-client';

// ── Helpers ────────────────────────────────────────────────────────────────────

const SAMPLE_RATING: RatingEntry = {
  id: 'github:42:test-plugin',
  user_id: 'github:42',
  user_login: 'alice',
  user_avatar_url: 'https://avatars.githubusercontent.com/u/42',
  stars: 5,
  review_text: 'Works great!',
  created_at: 1712880000, // 2024-04-12
};

/** Stub global fetch to return the given ratings array. */
function mockFetchRatings(ratings: RatingEntry[]) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ ratings }), { status: 200 })
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** Stub global fetch to reject (network error). */
function mockFetchError() {
  const fetchMock = vi.fn().mockRejectedValue(new Error('Network error'));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('ReviewList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // ── Loading state ────────────────────────────────────────────────────────────

  it('shows loading state while fetching', async () => {
    // Use a never-resolving promise to keep it in loading state
    let _resolve!: (v: any) => void;
    const pending = new Promise<any>((res) => { _resolve = res; });
    globalThis.fetch = vi.fn().mockReturnValue(pending) as unknown as typeof fetch;

    render(<ReviewList pluginId="test-plugin" />);

    expect(screen.getByText(/loading reviews/i)).toBeTruthy();

    // Clean up: resolve so the promise doesn't leak
    await act(async () => {
      _resolve(new Response(JSON.stringify({ ratings: [] })));
    });
  });

  // ── Empty list ───────────────────────────────────────────────────────────────

  it('shows empty-state message when no reviews exist', async () => {
    mockFetchRatings([]);

    await act(async () => {
      render(<ReviewList pluginId="test-plugin" />);
      // Flush all microtasks so the fetch resolves
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText(/no reviews yet/i)).toBeTruthy();
  });

  // ── Populated list ───────────────────────────────────────────────────────────

  it('renders avatar, login, and review text for each rating', async () => {
    mockFetchRatings([SAMPLE_RATING]);

    await act(async () => {
      render(<ReviewList pluginId="test-plugin" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Username rendered
    expect(screen.getByText('alice')).toBeTruthy();
    // Review text rendered (React auto-escapes — XSS safe)
    expect(screen.getByText('Works great!')).toBeTruthy();
    // Avatar image rendered with alt text
    const img = screen.getByRole('img', { name: 'alice' });
    expect(img).toBeTruthy();
    expect((img as HTMLImageElement).src).toContain('avatars.githubusercontent.com');
  });

  it('renders multiple review rows', async () => {
    const second: RatingEntry = {
      ...SAMPLE_RATING,
      id: 'github:99:test-plugin',
      user_id: 'github:99',
      user_login: 'bob',
      review_text: 'Very useful.',
      stars: 4,
    };
    mockFetchRatings([SAMPLE_RATING, second]);

    await act(async () => {
      render(<ReviewList pluginId="test-plugin" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('alice')).toBeTruthy();
    expect(screen.getByText('bob')).toBeTruthy();
  });

  it('renders a review with no text without crashing', async () => {
    mockFetchRatings([{ ...SAMPLE_RATING, review_text: null }]);

    await act(async () => {
      render(<ReviewList pluginId="test-plugin" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('alice')).toBeTruthy();
    // No review text element — just ensure no crash and username is present
    expect(screen.queryByText('Works great!')).toBeNull();
  });

  // ── Error state ──────────────────────────────────────────────────────────────

  it("shows error message when fetch fails", async () => {
    mockFetchError();

    await act(async () => {
      render(<ReviewList pluginId="test-plugin" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText(/couldn't load reviews/i)).toBeTruthy();
  });

  // ── refreshKey re-fetch ──────────────────────────────────────────────────────

  it('re-fetches when refreshKey changes', async () => {
    const fetchMock = mockFetchRatings([SAMPLE_RATING]);

    let rerender!: (ui: React.ReactElement) => void;

    await act(async () => {
      const result = render(<ReviewList pluginId="test-plugin" refreshKey={0} />);
      rerender = result.rerender;
      await Promise.resolve();
      await Promise.resolve();
    });

    // First fetch
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Bump refreshKey
    await act(async () => {
      rerender(<ReviewList pluginId="test-plugin" refreshKey={1} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Second fetch triggered by refreshKey change
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
