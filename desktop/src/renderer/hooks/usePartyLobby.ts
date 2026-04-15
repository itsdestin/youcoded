import { useEffect, useRef, useCallback, useState } from 'react';
import { useGameDispatch } from '../state/game-context';
import { PartyClient, PARTYKIT_HOST } from '../game/party-client';

const PING_INTERVAL = 30_000; // 30s — matches server sweep interval

// Called once the socket has been stuck in CONNECTING for ~10s. Runs a
// plain HTTP GET against the lobby room to classify *why* the socket isn't
// opening, then returns user-facing copy with no jargon or error codes.
//
// Why probe separately: partysocket silently retries forever on 5xx and
// never surfaces the response code to its consumers. The only way to tell
// "server is down" from "server is reachable but crashing" from "you're
// offline" is to ask the HTTPS endpoint directly.
async function classifySlowConnect(): Promise<string> {
  try {
    const res = await fetch(`https://${PARTYKIT_HOST}/party/global-lobby`, {
      method: 'GET',
      // Short abort so we don't hang here longer than the user's patience —
      // friendlier copy beats a second silent wait.
      signal: AbortSignal.timeout(6_000),
    });
    if (res.status >= 500) {
      return 'The game server is having a rough morning. Give it a minute and try again.';
    }
    // 2xx / 3xx / 4xx all mean the server answered — so the WebSocket
    // handshake is just slow. Network is fine; encourage patience.
    return 'Taking a little longer than usual. Hang tight…';
  } catch {
    // Fetch rejected → DNS failure, offline, or firewall. Avoid "network
    // error" jargon and just describe what to check.
    return "Can't reach the game server. Check your internet and try again.";
  }
}

// isLeader: true when this renderer is the leader window (multi-window detach
// feature). Only the leader maintains the lobby socket; non-leader windows
// would otherwise double-register the same user as online.
export function usePartyLobby(isLeader: boolean = true) {
  const dispatch = useGameDispatch();
  const clientRef = useRef<PartyClient | null>(null);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [incognito, setIncognitoState] = useState(false);
  // State (not ref) so the connection effect re-runs when the preference loads
  const [incognitoLoaded, setIncognitoLoaded] = useState(false);
  // Bumping this nonce forces the connection effect to fully tear down the
  // existing socket and rebuild from scratch — used by the Retry button when
  // partysocket's internal reconnect loop has given up (e.g. after a long
  // network drop or repeated server 5xx responses).
  const [reconnectNonce, setReconnectNonce] = useState(0);

  // Load incognito preference on mount
  useEffect(() => {
    (window as any).claude?.getIncognito?.().then((val: boolean) => {
      setIncognitoState(val ?? false);
      setIncognitoLoaded(true);
    }).catch(() => {
      setIncognitoLoaded(true);
    });
  }, []);

  // Connect/disconnect lobby based on incognito state
  useEffect(() => {
    // Don't act until we've loaded the preference — incognitoLoaded is state
    // so this effect re-runs when it flips to true (fixes missing username on
    // first load when stored preference is already false)
    if (!incognitoLoaded) return;

    // Non-leader windows don't open a lobby socket — two windows per user
    // would otherwise double-register the same GitHub identity as online.
    // When leadership transfers (primary closes), the new leader's effect
    // re-runs because isLeader is a dep below.
    if (!isLeader) {
      pingRef.current && clearInterval(pingRef.current);
      pingRef.current = null;
      clientRef.current?.close();
      clientRef.current = null;
      dispatch({ type: 'PARTY_DISCONNECTED' });
      return;
    }

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
          dispatch({ type: 'PARTY_ERROR', message: "You're not signed in to GitHub yet — games use your GitHub name as your player tag." });
          return;
        }

        const client = new PartyClient({
          room: 'global-lobby',
          username: auth.username,
          onMessage: (data) => {
            switch (data.type) {
              case 'presence':
              case 'pong':
                // Both carry a full user list — 'presence' on first connect,
                // 'pong' every 30s so clients self-correct missed events
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
                if (data.accept) {
                  dispatch({ type: 'CHALLENGE_ACCEPTED', by: data.from });
                } else {
                  dispatch({ type: 'CHALLENGE_DECLINED', by: data.from });
                }
                break;
              case 'challenge-failed':
                // Target wasn't reachable on the server
                dispatch({ type: 'CHALLENGE_FAILED', target: data.target });
                break;
            }
          },
          onOpen: () => {
            dispatch({ type: 'PARTY_CONNECTED', username: auth.username });
          },
          onSlowConnect: () => {
            // Swap the bare spinner for friendlier copy immediately, then
            // kick off an HTTP probe to refine the hint. We dispatch twice
            // so the user sees *something* change right at the 10s mark
            // without waiting on the probe round-trip.
            dispatch({ type: 'PARTY_SLOW_CONNECT', hint: 'Taking a little longer than usual. Hang tight…' });
            classifySlowConnect().then((hint) => {
              if (!cancelled) dispatch({ type: 'PARTY_SLOW_CONNECT', hint });
            });
          },
          onClose: (info) => {
            // Forward the close code so the UI can show *why* (DevTools is
            // unavailable in some environments — this is the only way for
            // a non-developer to see the reason behind a flicker loop)
            dispatch({ type: 'PARTY_DISCONNECTED', code: info.code, reason: info.reason });
          },
          onError: () => {
            dispatch({ type: 'PARTY_ERROR', message: "Lost the connection to the game server. We'll keep trying." });
          },
        });

        clientRef.current = client;

        // Start heartbeat pings
        pingRef.current = setInterval(() => {
          clientRef.current?.send({ type: 'ping' });
        }, PING_INTERVAL);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          // Surface the actual error — "Failed to get GitHub auth" alone gave
          // no signal whether the IPC was missing, gh wasn't on PATH, or the
          // token call failed. The detail makes the lobby ErrorScreen useful.
          const detail = err instanceof Error ? err.message : String(err);
          console.warn('[lobby] getGitHubAuth failed:', err);
          // Keep the raw detail in the console for debugging, but show the
          // user a plain-language version. Destin is a non-dev — "GitHub auth
          // failed: Error: spawn gh ENOENT" is meaningless to a real user.
          dispatch({ type: 'PARTY_ERROR', message: "Couldn't check your GitHub sign-in. Make sure the GitHub CLI (gh) is installed and you've signed in." });
        }
      });

    return () => {
      cancelled = true;
      pingRef.current && clearInterval(pingRef.current);
      pingRef.current = null;
      clientRef.current?.close();
      clientRef.current = null;
    };
  }, [dispatch, incognito, incognitoLoaded, isLeader, reconnectNonce]);

  const reconnect = useCallback(() => {
    // Clear the banner immediately so the UI returns to the spinner state,
    // then bump the nonce — the cleanup function above closes the dead socket
    // and the effect re-runs to build a fresh PartyClient + re-fetch gh auth.
    dispatch({ type: 'PARTY_ERROR_CLEARED' });
    setReconnectNonce(n => n + 1);
  }, [dispatch]);

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

  return { updateStatus, challengePlayer, respondToChallenge, incognito, toggleIncognito, reconnect };
}
