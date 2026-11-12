// @vitest-environment jsdom
// WHY (error inventory 2026-09-10, Marketplace rows 18/21): a failed friends read left "Loading your
// friends…" for ever, and a failed requests read read as "no requests". Both now say they could not load.
// game-context and account-context are mocked (same style as use-presence.test.tsx)
// so we can drive game state + signed-in status directly; window.claude.social is
// a vi.fn mock so we observe exactly which social IPC calls the UI makes.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup, fireEvent, waitFor } from '@testing-library/react';

// Hoisted shared handles the mock factories close over.
const h = vi.hoisted(() => ({
  dispatch: vi.fn(),
  toggleIncognito: vi.fn(),
  state: {
    connected: true,
    partyError: null as string | null,
    hiddenBlocked: null as 'unsupported' | 'unreachable' | null,
    username: 'Me',
    onlineUsers: [] as Array<{ id: string; name: string; handle: string | null; status: 'idle' | 'in-game' }>,
    screen: 'lobby' as string,
    challengeFrom: null as any,
    challengeDeclinedBy: null as any,
    challengeCode: null as string | null,
  },
}));

vi.mock('../src/renderer/state/game-context', () => ({
  useGameState: () => h.state,
  useGameDispatch: () => h.dispatch,
}));
vi.mock('../src/renderer/state/account-context', () => ({
  // user.id feeds the presence-refetch self-exclusion (id-keyed, review fix).
  useAccount: () => ({ signedIn: true, user: { id: 'github:me' }, signInPending: false, signInError: null, startSignIn: vi.fn() }),
}));

import GameLobby from '../src/renderer/components/game/GameLobby';
import FriendsPanel from '../src/renderer/components/game/FriendsPanel';

const err = (status: number, message = 'nope') => ({ ok: false as const, status, message });
const ok = <T,>(value: T) => ({ ok: true as const, value });

function makeConnection() {
  return { joinGame: vi.fn(), makeMove: vi.fn(), sendChat: vi.fn(), requestRematch: vi.fn(), leaveGame: vi.fn(), challengePlayer: vi.fn(), respondToChallenge: vi.fn(), reconnectLobby: vi.fn() } as any;
}

beforeEach(() => { h.state.connected = true; h.state.hiddenBlocked = null; h.state.onlineUsers = []; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Friends when a read fails', () => {
  it('lobby: says it could not load the friends, with the reason, and Try again re-asks', async () => {
    const listFriends = vi.fn().mockResolvedValueOnce(err(503, 'the server is busy')).mockResolvedValue(ok([]));
    (window as any).claude = { social: { listFriends, listRequests: vi.fn().mockResolvedValue(ok({ incoming: [], outgoing: [] })) } };
    const u = render(<GameLobby connection={makeConnection()} gameId="connect-four" />);
    expect(await u.findByText(/Couldn.t load your friends: the server is busy/)).toBeTruthy();
    expect(u.queryByText(/Loading your friends/)).toBeNull();
    await act(async () => { fireEvent.click(u.getByText('Try again')); });
    await waitFor(() => expect(u.queryByText(/Couldn.t load your friends/)).toBeNull());
    expect(listFriends).toHaveBeenCalledTimes(2);
  });

  it('panel: a failed requests read is reported, not shown as "no requests"', async () => {
    (window as any).claude = { social: {
      listFriends: vi.fn().mockResolvedValue(ok([])),
      listRequests: vi.fn().mockResolvedValue(err(500, 'requests unavailable')),
    } };
    const u = render(<FriendsPanel social="online" onRetry={vi.fn()} onToggleIncognito={vi.fn()} />);
    fireEvent.click(await u.findByRole('button', { name: /^Show all/ }));
    expect(await u.findByText(/Couldn.t load your friend requests: requests unavailable/)).toBeTruthy();
  });

  it('panel: a failed friends read replaces "Loading your friends…"', async () => {
    (window as any).claude = { social: {
      listFriends: vi.fn().mockRejectedValue(new Error('offline')),
      listRequests: vi.fn().mockResolvedValue(ok({ incoming: [], outgoing: [] })),
    } };
    const u = render(<FriendsPanel social="online" onRetry={vi.fn()} onToggleIncognito={vi.fn()} />);
    fireEvent.click(await u.findByRole('button', { name: /^Show all/ }));
    expect(await u.findByText(/Couldn.t load your friends: offline/)).toBeTruthy();
  });
});
