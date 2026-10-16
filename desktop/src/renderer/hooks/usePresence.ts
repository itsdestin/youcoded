import { useEffect, useRef, useCallback, useState } from 'react';
import { useGameDispatch } from '../state/game-context';
import { useAccount } from '../state/account-context';
import { OnlineUser } from '../state/game-types';
import { useOnRemoteReconnect } from './useOnRemoteReconnect';

// Replaces usePartyLobby (PartyKit global lobby, retired — spec §3). The
// socket itself lives in the PLATFORM layer (Electron main / SessionService);
// this hook only expresses desired state and translates relayed events into
// game-reducer actions. Same reducer event names as before.

// Shape of a user/card as the presence server relays it (Task 6 contract).
type ServerUser = { id: string; display_name?: string; handle?: string | null; status?: string };

// Map a relayed account card → the reducer's account-keyed OnlineUser.
function toOnlineUser(u: ServerUser): OnlineUser {
  return {
    id: String(u.id),
    name: u.display_name ?? '',
    handle: u.handle ?? null,
    status: u.status === 'in-game' ? 'in-game' : 'idle',
  };
}

/** Backoff for re-reading the incognito choice after a failed read; the last value repeats. */
const INCOGNITO_READ_RETRY_MS = [2_000, 5_000, 15_000, 30_000];

// isLeader: true when this renderer is the leader window (multi-window detach
// feature). Only the leader should hold the presence socket open; non-leader
// windows would otherwise double-register the same account as online.
export function usePresence(isLeader: boolean = true) {
  const dispatch = useGameDispatch();
  const { signedIn, user } = useAccount();
  // The visible player tag is the account display name (spec §3); login is the
  // fallback for accounts predating display names. Held in a ref so the event
  // subscription can read the current value without re-subscribing every time
  // the profile refreshes (focus / 15-min revalidation in account-context).
  const nameRef = useRef<string>('');
  nameRef.current = user?.display_name ?? user?.login ?? '';

  const [incognito, setIncognitoState] = useState(false);
  // State (not ref) so the desired-state effect re-runs once the preference loads.
  const [incognitoLoaded, setIncognitoLoaded] = useState(false);
  const loadedRef = useRef(false);
  loadedRef.current = incognitoLoaded;

  // Load incognito preference on mount — same persistence usePartyLobby used.
  // All three surfaces (preload / remote-shim / SessionService) currently
  // provide getIncognito, but guard the promise anyway: the optional-chained
  // CALL returns undefined when the method is absent, and `.then` on undefined
  // throws — so branch on the promise instead of chaining blindly.
  // WHY a failed read keeps presence OFF and tries again (final review F5): it used to count as
  // "not incognito" and connect VISIBLY, announcing a user who had chosen incognito. Until an answer
  // arrives nothing connects; the read is retried on a backoff (and after a remote reconnect, below).
  // A surface with no getIncognito at all cannot have stored a choice, so it connects as before.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = (attempt: number) => {
      const p = (window as any).claude?.getIncognito?.();
      if (!p) { setIncognitoLoaded(true); return; }
      p.then((val: boolean) => {
        if (!alive) return;
        setIncognitoState(val ?? false);
        setIncognitoLoaded(true);
      }).catch(() => {
        if (!alive) return;
        // Another path (a remote reconnect, a relayed switch) may answer first; then stop asking.
        timer = setTimeout(() => { if (!loadedRef.current) read(attempt + 1); }, INCOGNITO_READ_RETRY_MS[Math.min(attempt, INCOGNITO_READ_RETRY_MS.length - 1)]);
      });
    };
    read(0);
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);
  // After a remote reconnect, read the choice again. WHY: it was read once, and a read lost
  // during a phone's drop fell back to "not incognito" for the page's life (2026-09-11 phone
  // pass sweep). Only an answer changes it — a failed re-read keeps what is shown.
  useOnRemoteReconnect(() => {
    const p = (window as any).claude?.getIncognito?.();
    p?.then((val: boolean) => { setIncognitoState(val ?? false); setIncognitoLoaded(true); }).catch(() => {});
  });
  // WHY (final review F27): the choice is per device but was read once per window, so switching
  // incognito in a detached window — or from a phone — never reached the window holding the
  // connection, which stayed visible. A switch is now relayed to every other window and phone over
  // the existing live appearance relay (appearance:broadcast → appearance:sync, which ThemeProvider
  // ignores for keys it does not know), and each one applies it.
  useEffect(() => {
    const onSync = (window as any).claude?.appearance?.onSync;
    if (typeof onSync !== 'function') return;
    const unsub = onSync((prefs: any) => {
      if (prefs && typeof prefs.incognito === 'boolean') {
        setIncognitoState(prefs.incognito);
        setIncognitoLoaded(true);
      }
    });
    return () => { try { unsub?.(); } catch { /* already gone */ } };
  }, []);

  // Desired-state effect: connect only when signed in, not incognito, and this
  // is the leader window. The platform layer owns the actual socket; we just
  // express intent. Connection-state + presence events (below) drive reducer
  // state — including the disconnected transition when we call disconnect.
  useEffect(() => {
    // Don't act until the incognito preference has loaded (incognitoLoaded is
    // state so this effect re-runs when it flips true — mirrors usePartyLobby).
    if (!incognitoLoaded) return;
    // WHY incognito no longer disconnects (games-social round 5 — Destin: "they shouldn't be
    // able to see me in incognito, but i feel like i should still be able to see who else is
    // online"): incognito connects HIDDEN — this device receives friends' presence and is never
    // shown to them. Main refuses to connect at all if the server can't do that
    // (presence-socket.ts HIDDEN MODE), so the fallback is "see no one", never "be seen".
    const shouldConnect = signedIn && isLeader;
    // WHY the .catch (R4-1): presence belongs to the computer's own windows (the table refuses it for a phone), so on a phone the
    // call is answered "unsupported" and rejected. Nothing is wrong, so it must not surface as an unhandled error in the console.
    if (shouldConnect) {
      void window.claude.social.presenceConnect({ hidden: incognito }).catch(() => {});
    } else {
      void window.claude.social.presenceDisconnect().catch(() => {});
    }
  }, [signedIn, incognito, incognitoLoaded, isLeader]);

  // Read by the send helpers below without re-creating them on every toggle.
  const incognitoRef = useRef(incognito);
  incognitoRef.current = incognito;

  // Event subscription: map relayed server frames + synthetic connection-state
  // events onto the SAME reducer actions the old PartyKit hook dispatched.
  useEffect(() => {
    const unsub = window.claude.social.onPresenceEvent((ev) => {
      const e = ev as any;
      switch (ev.type) {
        case 'connected':
          dispatch({ type: 'PARTY_CONNECTED', username: nameRef.current });
          break;

        case 'disconnected':
          // reason:'local' = intentional local disconnect (incognito toggle,
          // sign-out, leader handoff). Dispatch WITHOUT a code so the reducer
          // takes its silent path — matches the old hook's deliberate-teardown
          // dispatch and keeps GameLobby from flashing the ErrorScreen. A real
          // socket drop carries the close code so the user can see *why* the
          // lobby dropped (DevTools is unavailable to non-developers).
          if (e.reason === 'local') {
            dispatch({ type: 'PARTY_DISCONNECTED' });
          } else {
            dispatch({ type: 'PARTY_DISCONNECTED', code: e.code, reason: e.reason });
          }
          break;

        case 'error':
          dispatch({
            type: 'PARTY_ERROR',
            message: String(e.message ?? "Lost the connection to the game server. We'll keep trying."),
          });
          break;

        case 'presence': {
          // Full online-friends snapshot (first connect + after visibility
          // changes). Defensive against a malformed frame — never map undefined.
          const users = Array.isArray(e.users) ? e.users.map(toOnlineUser) : [];
          dispatch({ type: 'PRESENCE_UPDATE', online: users });
          break;
        }

        case 'user-joined':
          if (e.user) dispatch({ type: 'USER_JOINED', user: toOnlineUser(e.user) });
          break;

        case 'user-left':
          dispatch({ type: 'USER_LEFT', id: String(e.id) });
          break;

        case 'user-status':
          dispatch({ type: 'USER_STATUS', id: String(e.id), status: e.status === 'in-game' ? 'in-game' : 'idle' });
          break;

        case 'challenge':
          dispatch({
            type: 'CHALLENGE_RECEIVED',
            from: { id: String(e.from?.id), name: e.from?.display_name ?? '', handle: e.from?.handle ?? null },
            gameType: String(e.gameType ?? ''),
            code: String(e.code ?? ''),
          });
          break;

        case 'challenge-response': {
          // Server relays the responder's card in `from`. handle carried through
          // for the Task 8 friends UI (@handle in banners).
          const by = { id: String(e.from?.id), name: e.from?.display_name ?? '', handle: e.from?.handle ?? null };
          if (e.accept) dispatch({ type: 'CHALLENGE_ACCEPTED', by });
          else dispatch({ type: 'CHALLENGE_DECLINED', by });
          break;
        }

        case 'challenge-failed':
          dispatch({ type: 'CHALLENGE_FAILED', target: String(e.target) });
          break;

        // ── Head-to-head records (games §6.2) ───────────────────────────
        // The server never takes one player's word for how a match ended: both
        // report, and only when the two agree does it write a row and push the
        // settled record to BOTH of them. So this arrives already agreed — the
        // client's job is to show it, not to compute it.
        case 'game-record': {
          const r = e.record as { wins?: unknown } | undefined;
          // Defensive: a malformed frame must not put NaN on screen next to a
          // friend's name. Anything that is not a well-formed record is dropped.
          if (r && typeof r.wins === 'number') {
            // WHO and WHICH MATCH travel with the numbers. They are not
            // decoration: this subscription runs in EVERY window and every
            // connected remote browser, so a record settled for a game in one
            // window arrives in all of them, and the server can settle a match
            // up to two minutes late. The reducer drops anything that is not
            // for the match on screen — it can only do that if it is told.
            dispatch({
              type: 'MATCH_RECORDED',
              record: e.record as never,
              opponentId: String(e.opponent ?? ''),
              matchId: String(e.match_id ?? ''),
            });
          }
          break;
        }

        // Your half is in; the server is waiting on your opponent's. Not an
        // error and not worth a message — the record simply appears if and when
        // they agree. Named here so it is visibly HANDLED rather than falling
        // through as an unknown frame.
        case 'game-result-pending':
          break;

        // The server declined the report (a match already settled, a bad id, a
        // forfeit claimed while the opponent is still connected). Nothing is
        // shown: the game itself is over and correct either way, and inventing
        // a message about a record the player never asked for would be noise.
        case 'game-result-rejected':
          break;

        case 'pong':
          // Liveness only — no state change.
          break;

        // Incognito, but the server could not promise to hide this device: main stayed
        // disconnected. Silent like a deliberate disconnect, but the reason is kept so the friends
        // card says only what is true (final review F4): an older server ('hidden-unsupported') or
        // a check that could not be made and is being retried ('hidden-check-failed').
        case 'hidden-unsupported':
          dispatch({ type: 'PRESENCE_HIDDEN_BLOCKED', why: 'unsupported' });
          break;
        case 'hidden-check-failed':
          dispatch({ type: 'PRESENCE_HIDDEN_BLOCKED', why: 'unreachable' });
          break;

        // The server refused something a hidden device tried to send. The UI never offers
        // those while incognito, so there is nothing to show.
        case 'refused':
          break;
      }
    });
    return unsub;
  }, [dispatch]);

  const updateStatus = useCallback((status: 'idle' | 'in-game') => {
    // Incognito: a status change would show friends this device is here.
    if (incognitoRef.current) return;
    // Fire-and-forget: presenceSend is fallible ('not connected' while
    // reconnecting), but a dropped status ping self-heals on the next presence
    // snapshot, so we don't surface an error for it.
    void window.claude.social.presenceSend({ type: 'status', status });
  }, []);

  const challengePlayer = useCallback((target: string, gameType: string, code: string) => {
    // Incognito: a challenge would reveal you, so it never leaves this device.
    if (incognitoRef.current) { dispatch({ type: 'CHALLENGE_FAILED', target }); return; }
    // target is the challenged player's ACCOUNT ID (spec §3). presenceSend is
    // fallible — if the challenge never leaves the machine (socket down),
    // synthesize a CHALLENGE_FAILED so the UI doesn't hang on the waiting
    // screen for a challenge that was never delivered.
    void window.claude.social.presenceSend({ type: 'challenge', target, gameType, code }).then((res) => {
      if (!res.ok) dispatch({ type: 'CHALLENGE_FAILED', target });
    });
  }, [dispatch]);

  const respondToChallenge = useCallback((to: string, accept: boolean) => {
    // `to` is the challenger's ACCOUNT ID. Fire-and-forget — a failed response
    // send has no local waiting-state to recover, so no CHALLENGE_FAILED here.
    void window.claude.social.presenceSend({ type: 'challenge-response', to, accept });
  }, []);

  const toggleIncognito = useCallback(() => {
    setIncognitoState(prev => {
      const next = !prev;
      (window as any).claude?.setIncognito?.(next);
      // Tell the other windows and phones (F27 above); fire-and-forget, a single window has no peers.
      try { (window as any).claude?.appearance?.broadcast?.({ incognito: next }); } catch { /* best effort */ }
      return next;
    });
  }, []);

  const reconnect = useCallback(() => {
    // Clear the error banner immediately, then bounce the platform socket
    // (disconnect + connect) so a stuck connection rebuilds cleanly. Used by the
    // ErrorScreen Retry button.
    dispatch({ type: 'PARTY_ERROR_CLEARED' });
    // WHY hidden here too: a plain presenceConnect() means "visible" to main, so Retry while
    // incognito used to show this device to friends. Reconnect keeps the device's incognito state.
    void window.claude.social.presenceDisconnect().then(() => window.claude.social.presenceConnect({ hidden: incognitoRef.current }));
  }, [dispatch]);

  return { updateStatus, challengePlayer, respondToChallenge, incognito, toggleIncognito, reconnect };
}
