import { useEffect, useRef, useCallback, useState } from 'react';
import { useGameDispatch } from '../state/game-context';
import { PartyClient } from '../game/party-client';

const PING_INTERVAL = 30_000; // 30s — matches server sweep interval

export function usePartyLobby() {
  const dispatch = useGameDispatch();
  const clientRef = useRef<PartyClient | null>(null);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [incognito, setIncognitoState] = useState(false);
  const incognitoLoadedRef = useRef(false);

  // Load incognito preference on mount
  useEffect(() => {
    (window as any).claude?.getIncognito?.().then((val: boolean) => {
      setIncognitoState(val ?? false);
      incognitoLoadedRef.current = true;
    }).catch(() => {
      incognitoLoadedRef.current = true;
    });
  }, []);

  // Connect/disconnect lobby based on incognito state
  useEffect(() => {
    // Don't act until we've loaded the preference
    if (!incognitoLoadedRef.current) return;

    if (incognito) {
      // Disconnect from lobby if connected
      pingRef.current && clearInterval(pingRef.current);
      pingRef.current = null;
      clientRef.current?.close();
      clientRef.current = null;
      dispatch({ type: 'PARTY_DISCONNECTED' });
      return;
    }

    let cancelled = false;
    const w = window as any;

    w.claude?.getGitHubAuth?.()
      .then((auth: { username: string } | null) => {
        if (cancelled) return;
        if (!auth) {
          dispatch({ type: 'PARTY_ERROR', message: 'GitHub CLI not authenticated. Run: gh auth login' });
          return;
        }

        const client = new PartyClient({
          room: 'global-lobby',
          username: auth.username,
          onMessage: (data) => {
            switch (data.type) {
              case 'presence':
                dispatch({ type: 'PRESENCE_UPDATE', online: data.users });
                break;
              case 'user-joined':
                dispatch({ type: 'USER_JOINED', username: data.username, status: data.status });
                break;
              case 'user-left':
                dispatch({ type: 'USER_LEFT', username: data.username });
                break;
              case 'user-status':
                dispatch({ type: 'USER_STATUS', username: data.username, status: data.status });
                break;
              case 'challenge':
                dispatch({ type: 'CHALLENGE_RECEIVED', from: data.from, code: data.code });
                break;
              case 'challenge-response':
                if (!data.accept) {
                  dispatch({ type: 'CHALLENGE_DECLINED', by: data.from });
                }
                break;
            }
          },
          onOpen: () => {
            dispatch({ type: 'PARTY_CONNECTED', username: auth.username });
          },
          onClose: () => {
            dispatch({ type: 'PARTY_DISCONNECTED' });
          },
          onError: () => {
            dispatch({ type: 'PARTY_ERROR', message: 'Lost connection to game server' });
          },
        });

        clientRef.current = client;

        // Start heartbeat pings
        pingRef.current = setInterval(() => {
          clientRef.current?.send({ type: 'ping' });
        }, PING_INTERVAL);
      })
      .catch(() => {
        if (!cancelled) {
          dispatch({ type: 'PARTY_ERROR', message: 'Failed to get GitHub auth' });
        }
      });

    return () => {
      cancelled = true;
      pingRef.current && clearInterval(pingRef.current);
      pingRef.current = null;
      clientRef.current?.close();
      clientRef.current = null;
    };
  }, [dispatch, incognito]);

  const updateStatus = useCallback((status: 'idle' | 'in-game') => {
    clientRef.current?.send({ type: 'status', status });
  }, []);

  const challengePlayer = useCallback((target: string, gameType: string, code: string) => {
    clientRef.current?.send({ type: 'challenge', target, gameType, code });
  }, []);

  const respondToChallenge = useCallback((from: string, accept: boolean) => {
    clientRef.current?.send({ type: 'challenge-response', from, accept });
  }, []);

  const toggleIncognito = useCallback(() => {
    setIncognitoState(prev => {
      const next = !prev;
      (window as any).claude?.setIncognito?.(next);
      return next;
    });
  }, []);

  return { updateStatus, challengePlayer, respondToChallenge, incognito, toggleIncognito };
}
