import { GameState, GameAction, createInitialGameState, matchIdOf } from './game-types';

// WHY: GameChat (components/game/GameChat.tsx) renders the whole list on
// every message and has no scrollback/pagination — an hours-long match's
// transcript would otherwise grow the array and the re-rendered DOM without
// bound. 200 is comfortably more than anyone scrolls back to read.
const GAME_CHAT_LIMIT = 200;

export function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case 'PARTY_CONNECTED': {
      // Clear any hard error — a fresh successful open means the earlier
      // failure copy is no longer relevant. `username` is the player's own
      // visible tag (display_name, spec §3), set by usePresence from the account.
      //
      // Preserve an in-progress game flow: the platform layer's renderer-reload
      // replay re-emits a synthetic 'connected' to ALL windows whenever any one
      // of them re-requests presence-connect (dev HMR / Ctrl+R), so a second
      // window mid-game must NOT get yanked back to the lobby. Game rooms are a
      // separate PartyKit socket — a presence reconnect doesn't invalidate them.
      // Only 'setup' (and a no-op 'lobby') resets to the lobby screen.
      const inGameFlow = state.screen === 'waiting' || state.screen === 'joining'
        || state.screen === 'playing' || state.screen === 'game-over';
      return {
        ...state,
        connected: true,
        username: action.username,
        screen: inGameFlow ? state.screen : 'lobby',
        partyError: null,
      };
    }

    case 'PARTY_DISCONNECTED': {
      // Keep username — game actions guard on it, and PARTY_CONNECTED refreshes
      // it on reconnect anyway. Clear onlineUsers so incognito self-filter works
      // and stale entries don't linger.
      //
      // Distinguish two paths:
      //  - No `code` → intentional local disconnect (incognito toggle, leader
      //    handoff). Stay silent — don't show the error screen.
      //  - `code` present → real socket close. Surface the code so a user
      //    without DevTools can see *why* the lobby dropped. Codes:
      //    1000 normal, 1006 abnormal/network, 1011 server error,
      //    4000 missing username, 4001 superseded, 4003 heartbeat timeout.
      if (action.code === undefined) {
        return { ...state, connected: false, onlineUsers: [], partyError: null };
      }
      // Keep the raw code in the message so classifyPartyError() can still
      // pick a specific hint — but phrase the headline in plain language.
      // "Lost the connection (code 1006) — trying again…" reads less alarming
      // than "Disconnected from game server" while preserving the diagnostic.
      const reason = action.reason ? `: ${action.reason}` : '';
      return {
        ...state,
        connected: false,
        onlineUsers: [],
        partyError: `Lost the connection (code ${action.code}${reason}) — trying again…`,
      };
    }

    case 'PARTY_ERROR':
      return { ...state, connected: false, partyError: action.message };

    case 'PARTY_ERROR_CLEARED':
      // User hit Retry on the ErrorScreen — clear the banner so a fresh
      // presence connect can promote to PARTY_CONNECTED, or so the desired-state
      // effect re-runs on the next reconnect.
      return { ...state, partyError: null };

    case 'PRESENCE_UPDATE':
      // Defensive: a malformed server frame (wrong schema, missing `users`) must
      // not wipe onlineUsers to undefined — subsequent USER_JOINED/LEFT/STATUS
      // reducers call .filter/.map on it and would crash the whole App tree
      // (PRESENCE_UPDATE dispatch originates in usePresence at AppInner scope,
      // above the GamePanel ErrorBoundary, so the throw reaches RootErrorBoundary
      // and resets chat state). Fall back to the existing list if the payload
      // is missing, never to undefined.
      return { ...state, onlineUsers: Array.isArray(action.online) ? action.online : state.onlineUsers };

    case 'USER_JOINED':
      // Key on account id (display names aren't unique, spec §3). Replace any
      // existing entry for the same id, then append the fresh one.
      return {
        ...state,
        onlineUsers: [...state.onlineUsers.filter(u => u.id !== action.user.id), action.user],
      };

    case 'USER_LEFT':
      return {
        ...state,
        onlineUsers: state.onlineUsers.filter(u => u.id !== action.id),
      };

    case 'USER_STATUS':
      return {
        ...state,
        onlineUsers: state.onlineUsers.map(u => u.id === action.id ? { ...u, status: action.status } : u),
      };

    case 'ROOM_CREATED':
      return {
        ...state,
        roomCode: action.code,
        seat: action.seat,
        // The CHALLENGER's route to the opponent's account: they picked the
        // person, so they have the id the game room will never tell them.
        opponentId: action.opponentId,
        matchesStarted: 0,
        record: null,
        screen: 'waiting',
      };

    case 'JOINING_GAME':
      return {
        ...state,
        roomCode: action.code,
        // The ACCEPTER's route to the same fact: whoever challenged them. Read
        // here rather than passed in, because `joinGame(code, gameId)` is the
        // one signature every game shares (§3.1) and must not grow a third arg
        // that only head-to-head records care about.
        opponentId: state.challengeFrom?.id ?? null,
        matchesStarted: 0,
        record: null,
        screen: 'joining',
      };

    case 'GAME_START':
      // `play` is the game's own opening state, handed over whole. The reducer
      // does not know or care what is inside it (§3.1) — that is what lets
      // chess and Connect 4 share this one case.
      return {
        ...state,
        seat: action.seat,
        opponent: action.opponent,
        play: action.play,
        turnSeat: action.turnSeat,
        screen: 'playing',
        outcome: null,
        // Both clients count the same GAME_STARTs — the initial one and every
        // mutually-agreed rematch — so both derive the same match id without
        // negotiating one. If they ever diverge the two halves simply never
        // agree and NOTHING is recorded, which is the safe direction to fail.
        matchesStarted: state.matchesStarted + 1,
        // Last match's record must not linger over this one.
        record: null,
        chatMessages: [],
        rematchRequested: false,
        opponentDisconnected: false,
      };

    case 'GAME_STATE': {
      const next: GameState = {
        ...state,
        play: action.play,
        turnSeat: action.turnSeat,
      };
      // A game ends when the GAME the referee runs says so — the shell just
      // records the outcome and switches screens.
      if (action.outcome) return { ...next, outcome: action.outcome, screen: 'game-over' };
      return next;
    }

    case 'CHAT_MESSAGE':
      // WHY: game chat has no "load older" path, no unread counter and no
      // persistence (GameChat.tsx just maps state.chatMessages) — a long
      // match's transcript otherwise grows unbounded in memory and re-renders
      // a longer list on every message. Cap at the last GAME_CHAT_LIMIT so
      // old messages age out; nothing else reads the dropped ones.
      return {
        ...state,
        chatMessages: [
          ...state.chatMessages,
          { from: action.from, text: action.text, timestamp: Date.now() },
        ].slice(-GAME_CHAT_LIMIT),
      };

    case 'OPPONENT_DISCONNECTED':
      return { ...state, opponentDisconnected: true };

    case 'OPPONENT_RECONNECTED':
      return { ...state, opponentDisconnected: false, opponent: action.username };

    case 'ROOM_FULL':
      // Tried to join a full room — return to lobby with a message
      return {
        ...state,
        screen: 'lobby',
        roomCode: null,
        seat: null,
        partyError: 'That room is full. Try a different code.',
      };

    case 'TOGGLE_PANEL':
      return { ...state, panelOpen: !state.panelOpen };

    case 'RETURN_TO_LOBBY':
      return {
        ...state,
        screen: 'lobby',
        roomCode: null,
        seat: null,
        turnSeat: null,
        outcome: null,
        // Dropping the game's own state on the way out is what stops one
        // game's leftovers reaching the next game's board.
        play: null,
        opponent: null,
        opponentId: null,
        matchesStarted: 0,
        record: null,
        chatMessages: [],
        challengeCode: null,
        challengeGame: null,
        rematchRequested: false,
        opponentDisconnected: false,
        partyError: null,
      };

    case 'CHALLENGE_RECEIVED':
      // Store the full account card {id, name, handle} — Task 8's friends UI
      // renders @handle in the challenge banner. Forces the panel open so an
      // incoming challenge is seen even if the games panel is closed.
      return {
        ...state,
        challengeFrom: { id: action.from.id, name: action.from.name, handle: action.from.handle },
        challengeCode: action.code,
        // Keep WHICH game this challenge is for. Dropping it here is what made
        // Accept always open Connect 4 no matter what you were challenged to.
        challengeGame: action.gameType || 'connect-four',
        panelOpen: true,
      };

    case 'CHALLENGE_ACCEPTED':
      // Informational — the game starts when opponent joins the room.
      // No screen transition needed; just clear the "waiting" uncertainty.
      return state;

    case 'CHALLENGE_DECLINED':
      // If challenger is on the waiting screen, return them to lobby
      if (state.screen === 'waiting') {
        return {
          ...state,
          screen: 'lobby',
          roomCode: null,
          seat: null,
          challengeDeclinedBy: action.by,
        };
      }
      return { ...state, challengeDeclinedBy: action.by };

    case 'CHALLENGE_FAILED': {
      // Target wasn't reachable — return challenger to lobby with feedback.
      // action.target is an account id now (spec §3); resolve it to the visible
      // name via the presence list so the message reads naturally.
      const targetName = state.onlineUsers.find(u => u.id === action.target)?.name ?? 'That player';
      if (state.screen === 'waiting') {
        return {
          ...state,
          screen: 'lobby',
          roomCode: null,
          seat: null,
          partyError: `${targetName} is no longer online.`,
        };
      }
      return state;
    }

    case 'CLEAR_CHALLENGE':
      return { ...state, challengeFrom: null, challengeCode: null, challengeGame: null, challengeDeclinedBy: null, partyError: null };

    case 'MATCH_RECORDED': {
      // A record is only shown against the match it is FOR. The presence socket
      // fans every frame to EVERY window and every connected remote browser, and
      // the server holds an unpaired report for up to two minutes — so a record
      // for a different opponent, or for the match before this one, genuinely
      // does arrive while another game is on screen. Without this guard the
      // overlay printed those numbers next to whoever was showing: your Connect
      // 4 record against Mira, captioned "You lead 5-1", under a chess win over
      // Jake. Wrong about someone else is the one failure this feature must not
      // have, so a record that does not match is dropped, not guessed at.
      //
      // The pair (opponent, matchId) is a complete check on its own: matchId
      // carries the room code, and a room belongs to exactly one game.
      if (action.opponentId !== state.opponentId) return state;
      if (action.matchId !== matchIdOf(state)) return state;
      return { ...state, record: action.record };
    }

    case 'REMATCH_REQUESTED':
      return { ...state, rematchRequested: true };

    case 'RESET':
      return createInitialGameState();

    default:
      return state;
  }
}
