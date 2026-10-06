// @vitest-environment jsdom
// friends-screen.test.tsx
// Render tests for the friends UI: the friends panel at the top of the Games list
// (FriendsPanel.tsx — add a friend, requests, unfriend/block) and a game's lobby
// (GameLobby.tsx — people, status, Challenge). Split 2026-10-05, redesign backlog
// row 11: "no add friend in game panels".
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

const ok = <T,>(value: T) => ({ ok: true as const, value });

// The friends card starts folded (games-social round 2, GS-2): open it, and when asked
// open the add box too — the steps a person takes.
async function openPanel(opts: { add?: boolean } = {}) {
  const u = render(<FriendsPanel social="online" onRetry={vi.fn()} onToggleIncognito={h.toggleIncognito} />);
  fireEvent.click(await u.findByRole('button', { name: /^Show all/ }));
  if (opts.add) fireEvent.click(u.getByRole('button', { name: 'Add a friend' }));
  return u;
}
const err = (status: number, message = 'nope') => ({ ok: false as const, status, message });

// A no-op connection; challengePlayer is spied where a test needs it.
// (No createGame — it left GameConnection with the room-code UI, 2026-07-09.)
function makeConnection(over: Record<string, any> = {}) {
  return {
    joinGame: vi.fn(),
    makeMove: vi.fn(),
    sendChat: vi.fn(),
    requestRematch: vi.fn(),
    leaveGame: vi.fn(),
    challengePlayer: vi.fn(),
    respondToChallenge: vi.fn(),
    reconnectLobby: vi.fn(),
    ...over,
  } as any;
}

function makeSocial(over: Record<string, any> = {}) {
  return {
    listFriends: vi.fn().mockResolvedValue(ok([])),
    listRequests: vi.fn().mockResolvedValue(ok({ incoming: [], outgoing: [] })),
    sendRequest: vi.fn().mockResolvedValue(ok({ status: 'pending' })),
    acceptRequest: vi.fn().mockResolvedValue(ok(undefined)),
    declineRequest: vi.fn().mockResolvedValue(ok(undefined)),
    cancelRequest: vi.fn().mockResolvedValue(ok(undefined)),
    unfriend: vi.fn().mockResolvedValue(ok(undefined)),
    block: vi.fn().mockResolvedValue(ok(undefined)),
    ...over,
  };
}

beforeEach(() => {
  h.dispatch.mockClear();
  h.state.connected = true;
  h.state.onlineUsers = [];
  h.state.username = 'Me';
  h.state.challengeFrom = null;
  h.state.challengeDeclinedBy = null;
  (window as any).claude = { social: makeSocial() };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const friend = (over: Partial<{ id: string; display_name: string; handle: string | null; last_seen_at: number | null }> = {}) => ({
  id: over.id ?? 'github:1',
  display_name: over.display_name ?? 'Alice',
  handle: over.handle ?? 'alice',
  avatar_url: null,
  last_seen_at: over.last_seen_at ?? null,
  created_at: 0,
});

describe('Lobby — friends list', () => {
  it('renders merged rows online-first with plain-word statuses', async () => {
    // Alice offline, Bob online (live presence). mergeFriends should put Bob first.
    h.state.onlineUsers = [{ id: 'github:2', name: 'Bob', handle: 'bob', status: 'idle' }];
    (window as any).claude.social = makeSocial({
      listFriends: vi.fn().mockResolvedValue(ok([
        friend({ id: 'github:1', display_name: 'Alice', handle: 'alice', last_seen_at: null }),
        friend({ id: 'github:2', display_name: 'Bob', handle: 'bob' }),
      ])),
    });

    const { findByText, getByText, getAllByText, queryByText, queryByPlaceholderText } = render(<GameLobby connection={makeConnection()} gameId="connect-four" />);

    // Wait for refresh() to populate the list.
    await findByText('Alice');
    expect(getByText('Bob')).toBeTruthy();
    // Word statuses — never glyphs — as pills (row 11: "online status should be
    // a status pill").
    expect(getAllByText('Online').length).toBeGreaterThan(0);
    expect(getByText('Offline')).toBeTruthy();  // Alice (no lastSeenAt)

    // The room-code UI is gone (Destin decision 2026-07-09) — challenges are
    // the only game entry point.
    expect(queryByText('Create Game')).toBeNull();
    expect(queryByPlaceholderText('Room code')).toBeNull();

    // Online-first ordering: Bob's row precedes Alice's in the DOM.
    const bobIdx = getByText('Bob').compareDocumentPosition(getByText('Alice'));
    // FOLLOWING (4) means Alice comes after Bob.
    expect(bobIdx & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows Challenge only on online rows', async () => {
    h.state.onlineUsers = [{ id: 'github:2', name: 'Bob', handle: 'bob', status: 'idle' }];
    const challengePlayer = vi.fn();
    (window as any).claude.social = makeSocial({
      listFriends: vi.fn().mockResolvedValue(ok([
        friend({ id: 'github:1', display_name: 'Alice', last_seen_at: null }),
        friend({ id: 'github:2', display_name: 'Bob', handle: 'bob' }),
      ])),
    });

    const { findAllByText } = render(<GameLobby connection={makeConnection({ challengePlayer })} gameId="connect-four" />);

    // Exactly one Challenge button (Bob, the only online friend).
    const buttons = await findAllByText('Challenge');
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(challengePlayer).toHaveBeenCalledWith('github:2', 'connect-four');
  });
});

describe('Lobby — no social controls', () => {
  it('has no add-a-friend box, no requests and no friend menu', async () => {
    (window as any).claude.social = makeSocial({
      listFriends: vi.fn().mockResolvedValue(ok([friend()])),
      listRequests: vi.fn().mockResolvedValue(ok({
        incoming: [{ id: 'req-1', from: { id: 'github:9', display_name: 'Zed', handle: 'zed', avatar_url: null }, created_at: 0 }],
        outgoing: [],
      })),
    });
    const { findByText, queryByLabelText, queryByText } = render(<GameLobby connection={makeConnection()} gameId="connect-four" />);
    await findByText('Alice');
    expect(queryByLabelText("Friend's handle")).toBeNull();
    expect(queryByText('Zed')).toBeNull();
    expect(queryByLabelText('Friend options')).toBeNull();
  });

  it('an empty lobby sends you back to the Games list to add a friend', async () => {
    const onAddFriend = vi.fn();
    const { findByRole } = render(<GameLobby connection={makeConnection()} gameId="connect-four" onAddFriend={onAddFriend} />);
    fireEvent.click(await findByRole('button', { name: 'Add a friend' }));
    expect(onAddFriend).toHaveBeenCalledTimes(1);
  });
});

describe('Friends panel — add a friend', () => {
  it('maps a 404 to "No one has that handle"', async () => {
    const sendRequest = vi.fn().mockResolvedValue(err(404));
    (window as any).claude.social = makeSocial({ sendRequest });

    const { findByLabelText, getByRole, getByText } = await openPanel({ add: true });
    const input = (await findByLabelText("Friend's handle")) as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'ghost' } });
    fireEvent.click(getByRole('button', { name: 'Send friend request' }));

    await waitFor(() => expect(getByText('No one has that handle')).toBeTruthy());
    expect(sendRequest).toHaveBeenCalledWith('ghost');
  });

  it('lowercases the handle as the user types', async () => {
    const { findByLabelText } = await openPanel({ add: true });
    const input = (await findByLabelText("Friend's handle")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'AlIcE' } });
    expect(input.value).toBe('alice');
  });
});

describe('Friends panel — in-flight mutation guards', () => {
  it('double-clicking Accept fires acceptRequest once', async () => {
    // Hold the mutation open across both clicks so the second click hits the
    // in-flight guard rather than a completed (re-enabled) button.
    let release: (v: any) => void = () => {};
    const acceptRequest = vi.fn().mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    (window as any).claude.social = makeSocial({
      listRequests: vi.fn().mockResolvedValue(ok({
        incoming: [{ id: 'req-1', from: { id: 'github:9', display_name: 'Zed', handle: 'zed', avatar_url: null }, created_at: 0 }],
        outgoing: [],
      })),
      acceptRequest,
    });

    const { findByText } = await openPanel();
    const accept = await findByText('Accept');

    fireEvent.click(accept);
    fireEvent.click(accept); // double-tap — guarded by pendingRowsRef + disabled state
    expect(acceptRequest).toHaveBeenCalledTimes(1);

    // The button is disabled while the mutation is in flight.
    await waitFor(() => expect((accept as HTMLButtonElement).disabled).toBe(true));

    // Release the mutation; the button re-enables after refresh.
    await act(async () => { release(ok(undefined)); });
    await waitFor(() => expect((accept as HTMLButtonElement).disabled).toBe(false));
  });

  it('add-friend Send button is guarded against double-submit', async () => {
    let release: (v: any) => void = () => {};
    const sendRequest = vi.fn().mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    (window as any).claude.social = makeSocial({ sendRequest });

    const { findByLabelText, getByRole, getByText } = await openPanel({ add: true });
    const input = (await findByLabelText("Friend's handle")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'zed' } });

    const send = getByRole('button', { name: 'Send friend request' }) as HTMLButtonElement;
    fireEvent.click(send);
    // Enter while the first request is still in flight must not double-send.
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(send);
    expect(sendRequest).toHaveBeenCalledTimes(1);

    await act(async () => { release(ok({ status: 'pending' })); });
    await waitFor(() => expect(getByText('Request sent')).toBeTruthy());
  });
});

describe('Friends panel — block is consequence-gated', () => {
  it('requires the confirm step in the friend details popup before calling block()', async () => {
    const blockFn = vi.fn().mockResolvedValue(ok(undefined));
    (window as any).claude.social = makeSocial({
      listFriends: vi.fn().mockResolvedValue(ok([friend({ id: 'github:1', display_name: 'Alice', handle: 'alice' })])),
      block: blockFn,
    });
    const u = await openPanel();
    fireEvent.click(await u.findByRole('button', { name: 'Alice — details' }));
    // The popup names the friend and shows the handle; no warning yet.
    expect(await u.findByText('@alice')).toBeTruthy();
    expect(u.queryByText(/Blocking removes this friend/)).toBeNull();
    fireEvent.click(u.getByRole('button', { name: 'Block…' }));
    expect(u.getByText(/Blocking removes this friend/)).toBeTruthy();
    expect(blockFn).not.toHaveBeenCalled();
    fireEvent.click(u.getByRole('button', { name: 'Block Alice' }));
    await waitFor(() => expect(blockFn).toHaveBeenCalledWith('github:1'));
  });
});

describe('Friends panel — folded summary and request order', () => {
  it('starts folded to one line that counts who is online, and opens on click', async () => {
    h.state.onlineUsers = [{ id: 'github:2', name: 'Bob', handle: 'bob', status: 'idle' }];
    (window as any).claude.social = makeSocial({
      listFriends: vi.fn().mockResolvedValue(ok([friend({ id: 'github:1', display_name: 'Alice' }), friend({ id: 'github:2', display_name: 'Bob', handle: 'bob' })])),
    });
    const u = render(<FriendsPanel social="online" onRetry={vi.fn()} />);
    await u.findByText('1 of 2 friends online');
    expect(u.queryByText('Alice')).toBeNull();
    fireEvent.click(u.getByRole('button', { name: /^Show all/ }));
    expect(await u.findByText('Alice')).toBeTruthy();
  });

  it('puts the filled Accept to the RIGHT of Decline', async () => {
    (window as any).claude.social = makeSocial({
      listRequests: vi.fn().mockResolvedValue(ok({
        incoming: [{ id: 'req-1', from: { id: 'github:9', display_name: 'Zed', handle: 'zed', avatar_url: null }, created_at: 0 }],
        outgoing: [],
      })),
    });
    const u = await openPanel();
    const accept = await u.findByRole('button', { name: 'Accept' });
    const decline = u.getByRole('button', { name: 'Decline' });
    // Guide "Buttons": two side by side, the filled one on the right.
    expect(decline.compareDocumentPosition(accept) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('no internet and an unreachable server replace the whole card with the error card', async () => {
    const off = render(<FriendsPanel social="offline" onRetry={vi.fn()} />);
    expect(await off.findByText(/^No internet connection\./)).toBeTruthy();
    expect(off.queryByRole('button', { name: /^Show all/ })).toBeNull();
    off.unmount();
    const onRetry = vi.fn();
    const srv = render(<FriendsPanel social="server" onRetry={onRetry} />);
    expect(await srv.findByText(/^Can't reach the game server\./)).toBeTruthy();
    expect(srv.queryByText(/No internet connection/)).toBeNull();
    fireEvent.click(srv.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('Friends panel — your status pill and the handle', () => {
  it('your status is a pill you click; its menu switches to Incognito', async () => {
    h.toggleIncognito.mockClear();
    const u = render(<FriendsPanel social="online" onRetry={vi.fn()} onToggleIncognito={h.toggleIncognito} />);
    fireEvent.click(await u.findByRole('button', { name: 'Your status: Online' }));
    fireEvent.click(u.getByRole('menuitemradio', { name: /Incognito/ }));
    expect(h.toggleIncognito).toHaveBeenCalledTimes(1);
  });

  it('rows show the name only; the @handle is in the friend details popup', async () => {
    (window as any).claude.social = makeSocial({
      listFriends: vi.fn().mockResolvedValue(ok([friend({ id: 'github:1', display_name: 'Alice', handle: 'alice' })])),
    });
    const u = await openPanel();
    await u.findByText('Alice');
    expect(u.queryByText('@alice')).toBeNull();
    fireEvent.click(u.getByRole('button', { name: 'Alice — details' }));
    expect(await u.findByText('@alice')).toBeTruthy();
  });
});

describe('Friends panel — incognito', () => {
  it('connected hidden: shows the real online count and that friends cannot see you', async () => {
    h.state.onlineUsers = [{ id: 'github:1', name: 'Alice', handle: 'alice', status: 'idle' }];
    (window as any).claude.social = makeSocial({
      listFriends: vi.fn().mockResolvedValue(ok([friend({ id: 'github:1', display_name: 'Alice' }), friend({ id: 'github:2', display_name: 'Bo' })])),
    });
    const u = render(<FriendsPanel social="incognito" incognito onRetry={vi.fn()} onToggleIncognito={h.toggleIncognito} />);
    expect(await u.findByText("1 of 2 friends online · they can't see you")).toBeTruthy();
  });

  it('not connected (an older server refused hidden mode): says who is online is hidden, never a number', async () => {
    h.state.connected = false;
    (window as any).claude.social = makeSocial({
      listFriends: vi.fn().mockResolvedValue(ok([friend({ id: 'github:1', display_name: 'Alice' })])),
    });
    const u = render(<FriendsPanel social="incognito" incognito onRetry={vi.fn()} onToggleIncognito={h.toggleIncognito} />);
    expect(await u.findByText(/1 friend · who's online is hidden/)).toBeTruthy();
  });
});
