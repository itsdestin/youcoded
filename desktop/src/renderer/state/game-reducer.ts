import { GameState, GameAction, createInitialGameState } from './game-types';

export function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case 'PARTY_CONNECTED':
      // Clear both hard errors AND the slow-connect hint — a fresh successful
      // open means the earlier friendlier copy is no longer relevant.
      return {
        ...state,
        connected: true,
        username: action.username,
        screen: 'lobby',
        partyError: null,
        slowConnect: false,
        slowConnectHint: null,
      };

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
      // User hit Retry on the ErrorScreen — clear the banner so partysocket's
      // ongoing reconnect attempts can promote to PARTY_CONNECTED, or so the
      // lobby effect re-runs the auth fetch on next dependency change.
      return { ...state, partyError: null, slowConnect: false, slowConnectHint: null };

    case 'PARTY_SLOW_CONNECT':
      // Fired by PartyClient's slow-connect timer (10s of CONNECTING with no
      // open). usePartyLobby may follow up with an HTTP probe to set the hint
      // based on what the server actually returned.
      return { ...state, slowConnect: true, slowConnectHint: action.hint ?? state.slowConnectHint };

    case 'PARTY_SLOW_CLEARED':
      return { ...state, slowConnect: false, slowConnectHint: null };

    case 'PRESENCE_UPDATE':
      return { ...state, onlineUsers: action.online };

    case 'USER_JOINED':
      return {
        ...state,
        onlineUsers: [...state.onlineUsers.filter(u => u.username !== action.username), { username: action.username, status: action.status as 'idle' | 'in-game' }],
      };

    case 'USER_LEFT':
      return {
        ...state,
        onlineUsers: state.onlineUsers.filter(u => u.username !== action.username),
      };

    case 'USER_STATUS':
      return {
        ...state,
        onlineUsers: state.onlineUsers.map(u => u.username === action.username ? { ...u, status: action.status as 'idle' | 'in-game' } : u),
      };

    case 'ROOM_CREATED':
      return {
        ...state,
        roomCode: action.code,
        myColor: action.color,
        screen: 'waiting',
      };

    case 'JOINING_GAME':
      return {
        ...state,
        roomCode: action.code,
        screen: 'joining',
      };

    case 'GAME_START':
      return {
        ...state,
        board: action.board,
        myColor: action.you,
        opponent: action.opponent,
        turn: 'red',
        screen: 'playing',
        winner: null,
        winLine: null,
        chatMessages: [],
        lastMove: null,
        rematchRequested: false,
        opponentDisconnected: false,
      };

    case 'GAME_STATE': {
      const next: GameState = {
        ...state,
        board: action.board,
        turn: action.turn,
        lastMove: action.lastMove,
      };
      if (action.winner) {
        return { ...next, winner: action.winner, winLine: action.winLine ?? null, screen: 'game-over' };
      }
      return next;
    }

    case 'CHAT_MESSAGE':
      return {
        ...state,
        chatMessages: [
          ...state.chatMessages,
          { from: action.from, text: action.text, timestamp: Date.now() },
        ],
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
        myColor: null,
        partyError: 'That room is full. Try a different code.',
      };

    case 'TOGGLE_PANEL':
      return { ...state, panelOpen: !state.panelOpen };

    case 'RETURN_TO_LOBBY':
      return {
        ...state,
        screen: 'lobby',
        roomCode: null,
        myColor: null,
        opponent: null,
        board: [],
        winner: null,
        winLine: null,
        chatMessages: [],
        lastMove: null,
        challengeCode: null,
        rematchRequested: false,
        opponentDisconnected: false,
        partyError: null,
      };

    case 'CHALLENGE_RECEIVED':
      return { ...state, challengeFrom: action.from, challengeCode: action.code, panelOpen: true };

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
          myColor: null,
          challengeDeclinedBy: action.by,
        };
      }
      return { ...state, challengeDeclinedBy: action.by };

    case 'CHALLENGE_FAILED':
      // Target wasn't reachable — return challenger to lobby with feedback
      if (state.screen === 'waiting') {
        return {
          ...state,
          screen: 'lobby',
          roomCode: null,
          myColor: null,
          partyError: `${action.target} is no longer online.`,
        };
      }
      return state;

    case 'CLEAR_CHALLENGE':
      return { ...state, challengeFrom: null, challengeCode: null, challengeDeclinedBy: null, partyError: null };

    case 'REMATCH_REQUESTED':
      return { ...state, rematchRequested: true };

    case 'RESET':
      return createInitialGameState();

    default:
      return state;
  }
}
