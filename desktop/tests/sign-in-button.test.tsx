// @vitest-environment jsdom
// sign-in-button.test.tsx
// Tests for the marketplace SignInButton component.
// Renders each of the three visual states (signed out, pending, signed in)
// by mocking MarketplaceAuthContext and asserts the correct element renders.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';

// We'll import the context + component after mocking
import * as AuthContextModule from '../src/renderer/state/marketplace-auth-context';
import SignInButton from '../src/renderer/components/marketplace/SignInButton';

// ── Context mock helper ────────────────────────────────────────────────────────

type AuthState = {
  signedIn: boolean;
  user: { id: string; login: string; avatar_url: string } | null;
  signInPending: boolean;
  startSignIn: () => Promise<void>;
  signOut: () => Promise<void>;
};

function renderWithAuth(state: AuthState) {
  vi.spyOn(AuthContextModule, 'useMarketplaceAuth').mockReturnValue(state);
  return render(<SignInButton />);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('SignInButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders sign-in button when signed out', () => {
    const { getByRole } = renderWithAuth({
      signedIn: false,
      user: null,
      signInPending: false,
      startSignIn: vi.fn().mockResolvedValue(undefined),
      signOut: vi.fn().mockResolvedValue(undefined),
    });

    const btn = getByRole('button');
    expect(btn.textContent).toContain('Sign in');
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it('calls startSignIn when the sign-in button is clicked', async () => {
    const startSignIn = vi.fn().mockResolvedValue(undefined);
    const { getByRole } = renderWithAuth({
      signedIn: false,
      user: null,
      signInPending: false,
      startSignIn,
      signOut: vi.fn().mockResolvedValue(undefined),
    });

    fireEvent.click(getByRole('button'));
    expect(startSignIn).toHaveBeenCalledTimes(1);
  });

  it('renders disabled pending button while sign-in is in progress', () => {
    const { getByRole } = renderWithAuth({
      signedIn: false,
      user: null,
      signInPending: true,
      startSignIn: vi.fn().mockResolvedValue(undefined),
      signOut: vi.fn().mockResolvedValue(undefined),
    });

    const btn = getByRole('button');
    expect(btn.textContent).toContain('browser');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders username chip when signed in', () => {
    const { getByRole, getByText } = renderWithAuth({
      signedIn: true,
      user: { id: 'github:1', login: 'testuser', avatar_url: 'https://example.com/avatar.png' },
      signInPending: false,
      startSignIn: vi.fn().mockResolvedValue(undefined),
      signOut: vi.fn().mockResolvedValue(undefined),
    });

    // The chip button should contain the username
    expect(getByText('testuser')).toBeTruthy();
  });

  it('shows sign-out option after clicking chip when signed in', () => {
    const { getByRole, getByText, queryByText } = renderWithAuth({
      signedIn: true,
      user: { id: 'github:1', login: 'testuser', avatar_url: 'https://example.com/avatar.png' },
      signInPending: false,
      startSignIn: vi.fn().mockResolvedValue(undefined),
      signOut: vi.fn().mockResolvedValue(undefined),
    });

    // Sign-out option should not be visible before clicking
    expect(queryByText('Sign out')).toBeNull();

    // Click the chip to open the dropdown
    fireEvent.click(getByRole('button'));

    // Now sign-out option should be visible
    expect(getByText('Sign out')).toBeTruthy();
  });

  it('calls signOut when sign-out button is clicked', async () => {
    const signOut = vi.fn().mockResolvedValue(undefined);
    const { getByRole, getByText } = renderWithAuth({
      signedIn: true,
      user: { id: 'github:1', login: 'testuser', avatar_url: 'https://example.com/avatar.png' },
      signInPending: false,
      startSignIn: vi.fn().mockResolvedValue(undefined),
      signOut,
    });

    // Open dropdown
    fireEvent.click(getByRole('button'));
    // Click sign out
    fireEvent.click(getByText('Sign out'));

    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
