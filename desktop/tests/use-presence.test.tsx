// @vitest-environment jsdom
// use-presence.test.tsx
// Focused tests for usePresence (Task 7) — the account-identity presence hook
// that replaced usePartyLobby. game-context and account-context are mocked so
// the test observes exactly which reducer actions the hook dispatches in
// response to the platform-layer presence events.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Hoisted shared handles the mock factories close over.
const h = vi.hoisted(() => ({
  dispatch: vi.fn(),
  account: {
    signedIn: true as boolean,
    user: { id: 'github:1', login: 'me', display_name: 'Me', avatar_url: '' } as any,
  },
}));

vi.mock('../src/renderer/state/game-context', () => ({
  useGameDispatch: () => h.dispatch,
  useGameState: () => ({}),
}));
vi.mock('../src/renderer/state/account-context', () => ({
  useAccount: () => h.account,
}));

import { usePresence } from '../src/renderer/hooks/usePresence';

// Captured presence-event callback so tests can drive relayed server frames.
let eventCb: (ev: any) => void = () => {};

function makeSocial(overrides: Record<string, any> = {}) {
  eventCb = () => {};
  return {
    presenceConnect: vi.fn().mockResolvedValue({ ok: true }),
    presenceDisconnect: vi.fn().mockResolvedValue({ ok: true }),
    presenceSend: vi.fn().mockResolvedValue({ ok: true }),
    onPresenceEvent: vi.fn((cb: any) => { eventCb = cb; return () => {}; }),
    ...overrides,
  };
}

beforeEach(() => {
  h.dispatch.mockClear();
  h.account.signedIn = true;
  h.account.user = { id: 'github:1', login: 'me', display_name: 'Me', avatar_url: '' };
  (window as any).claude = {
    social: makeSocial(),
    getIncognito: vi.fn().mockResolvedValue(false),
    setIncognito: vi.fn(),
  };
});

describe('usePresence — desired state', () => {
  it('connects when signed in and not incognito', async () => {
    renderHook(() => usePresence());
    await waitFor(() => expect((window as any).claude.social.presenceConnect).toHaveBeenCalled());
    expect((window as any).claude.social.presenceDisconnect).not.toHaveBeenCalled();
  });

  it('disconnects when signed out', async () => {
    h.account.signedIn = false;
    renderHook(() => usePresence());
    await waitFor(() => expect((window as any).claude.social.presenceDisconnect).toHaveBeenCalled());
    expect((window as any).claude.social.presenceConnect).not.toHaveBeenCalled();
  });

  it('non-leader window disconnects even while signed in (no duplicate presence)', async () => {
    renderHook(() => usePresence(false));
    await waitFor(() => expect((window as any).claude.social.presenceDisconnect).toHaveBeenCalled());
    expect((window as any).claude.social.presenceConnect).not.toHaveBeenCalled();
  });

  it('stored incognito=true disconnects instead of connecting', async () => {
    (window as any).claude.getIncognito = vi.fn().mockResolvedValue(true);
    renderHook(() => usePresence());
    await waitFor(() => expect((window as any).claude.social.presenceDisconnect).toHaveBeenCalled());
    expect((window as any).claude.social.presenceConnect).not.toHaveBeenCalled();
  });
});

describe('usePresence — event mapping', () => {
  it('maps a presence snapshot to PRESENCE_UPDATE with account-keyed users', async () => {
    renderHook(() => usePresence());
    await waitFor(() => expect((window as any).claude.social.onPresenceEvent).toHaveBeenCalled());
    act(() => {
      eventCb({ type: 'presence', users: [{ id: 'github:2', display_name: 'Bob', handle: 'bob', status: 'idle' }] });
    });
    expect(h.dispatch).toHaveBeenCalledWith({
      type: 'PRESENCE_UPDATE',
      online: [{ id: 'github:2', name: 'Bob', handle: 'bob', status: 'idle' }],
    });
  });

  it('maps a local disconnect to a silent PARTY_DISCONNECTED (no code)', async () => {
    renderHook(() => usePresence());
    await waitFor(() => expect((window as any).claude.social.onPresenceEvent).toHaveBeenCalled());
    act(() => { eventCb({ type: 'disconnected', reason: 'local' }); });
    expect(h.dispatch).toHaveBeenCalledWith({ type: 'PARTY_DISCONNECTED' });
  });

  it('maps a real drop to PARTY_DISCONNECTED with the close code', async () => {
    renderHook(() => usePresence());
    await waitFor(() => expect((window as any).claude.social.onPresenceEvent).toHaveBeenCalled());
    act(() => { eventCb({ type: 'disconnected', code: 1006, reason: 'abnormal' }); });
    expect(h.dispatch).toHaveBeenCalledWith({ type: 'PARTY_DISCONNECTED', code: 1006, reason: 'abnormal' });
  });
});

describe('usePresence — challenge send', () => {
  it('dispatches CHALLENGE_FAILED when the challenge send never leaves the machine', async () => {
    (window as any).claude.social.presenceSend = vi.fn().mockResolvedValue({ ok: false, status: 0, message: 'not connected' });
    const { result } = renderHook(() => usePresence());
    await act(async () => {
      result.current.challengePlayer('github:9', 'connect-four', 'ABC123');
    });
    await waitFor(() =>
      expect(h.dispatch).toHaveBeenCalledWith({ type: 'CHALLENGE_FAILED', target: 'github:9' }),
    );
  });

  it('does not dispatch CHALLENGE_FAILED when the challenge send succeeds', async () => {
    const { result } = renderHook(() => usePresence());
    await act(async () => {
      result.current.challengePlayer('github:9', 'connect-four', 'ABC123');
    });
    expect((window as any).claude.social.presenceSend).toHaveBeenCalledWith({
      type: 'challenge', target: 'github:9', gameType: 'connect-four', code: 'ABC123',
    });
    expect(h.dispatch).not.toHaveBeenCalledWith({ type: 'CHALLENGE_FAILED', target: 'github:9' });
  });
});

// The incognito choice was read once; a read lost during a phone's drop fell back to
// "not incognito" for the page's life.
describe('usePresence — incognito after a remote reconnect', () => {
  it('reads the choice again, and a failed re-read keeps what is shown', async () => {
    const { REMOTE_RECONNECTED_EVENT } = await import('../src/renderer/remote-events');
    const getIncognito = vi.fn()
      .mockRejectedValueOnce(new Error('lost'))
      .mockResolvedValueOnce(true)
      .mockRejectedValue(new Error('lost again'));
    (window as any).claude.getIncognito = getIncognito;
    const { result } = renderHook(() => usePresence());
    await waitFor(() => expect(getIncognito).toHaveBeenCalledTimes(1));
    await act(async () => { window.dispatchEvent(new Event(REMOTE_RECONNECTED_EVENT)); });
    await waitFor(() => expect(result.current.incognito).toBe(true));
    await act(async () => { window.dispatchEvent(new Event(REMOTE_RECONNECTED_EVENT)); });
    expect(getIncognito).toHaveBeenCalledTimes(3);
    expect(result.current.incognito).toBe(true);
  });
});
