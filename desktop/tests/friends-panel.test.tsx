// @vitest-environment jsdom
// The friends panel signed out (redesign backlog row 11): the sign-in banner moved
// to the TOP of the Games list as one card with Destin's sentence and a filled
// Sign in. Signed-in behaviour (add, accept, block) is in friends-screen.test.tsx.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const h = vi.hoisted(() => ({ startSignIn: vi.fn(), signInPending: false, signInError: null as string | null }));

vi.mock('../src/renderer/state/game-context', () => ({
  useGameState: () => ({ connected: false, partyError: null, username: '', onlineUsers: [] }),
  useGameDispatch: () => vi.fn(),
}));
vi.mock('../src/renderer/state/account-context', () => ({
  useAccount: () => ({ signedIn: false, user: null, signInPending: h.signInPending, signInError: h.signInError, startSignIn: h.startSignIn }),
}));

import FriendsPanel from '../src/renderer/components/game/FriendsPanel';

afterEach(() => { cleanup(); h.startSignIn.mockClear(); h.signInPending = false; h.signInError = null; });

describe('friends panel, signed out', () => {
  it("says Destin's sentence and signs in with a filled button", () => {
    render(<FriendsPanel />);
    expect(screen.getByText('Sign in to play with friends and put your scores on the board.')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Sign in' });
    // Filled = the primary button (guide "Buttons": the main action is filled).
    expect(button.className).toContain('bg-accent');
    fireEvent.click(button);
    expect(h.startSignIn).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/play without an account/i)).toBeNull();
  });

  it('shows a failed sign-in instead of swallowing it', () => {
    h.signInError = 'the browser was closed';
    render(<FriendsPanel />);
    expect(screen.getByText(/Sign-in failed: the browser was closed/)).toBeInTheDocument();
  });
});
