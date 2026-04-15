export type GameScreen = 'setup' | 'lobby' | 'waiting' | 'joining' | 'playing' | 'game-over';
export type PlayerColor = 'red' | 'yellow';

export interface OnlineUser {
  username: string;
  status: 'idle' | 'in-game';
}

export interface ChatMessage {
  from: string;
  text: string;
  timestamp: number;
}

export interface GameState {
  connected: boolean;
  /** True once we've been spinning on "Connecting…" long enough that the UI
   * should swap in a friendlier "taking longer than usual" message. Separate
   * from `partyError` so the spinner path stays distinct from hard failures. */
  slowConnect: boolean;
  /** Set by the lightweight HTTP probe in usePartyLobby when slowConnect
   * fires — gives the spinner screen a plain-language explanation of the
   * likely cause (offline vs server-napping vs just-slow). */
  slowConnectHint: string | null;
  partyError: string | null;
  username: string | null;
  onlineUsers: OnlineUser[];
  screen: GameScreen;
  roomCode: string | null;
  myColor: PlayerColor | null;
  opponent: string | null;
  board: number[][];
  turn: PlayerColor;
  lastMove: { col: number; row: number } | null;
  winner: PlayerColor | 'draw' | null;
  winLine: [number, number][] | null;
  chatMessages: ChatMessage[];
  panelOpen: boolean;
  /** Incoming challenge from another player */
  challengeFrom: string | null;
  /** Room code from incoming challenge */
  challengeCode: string | null;
  /** Outgoing challenge was declined */
  challengeDeclinedBy: string | null;
  /** Whether this player has requested a rematch */
  rematchRequested: boolean;
  /** Opponent disconnected during game */
  opponentDisconnected: boolean;
}

export type GameAction =
  | { type: 'PARTY_CONNECTED'; username: string }
  | { type: 'PARTY_DISCONNECTED'; code?: number; reason?: string }
  | { type: 'PARTY_ERROR'; message: string }
  | { type: 'PARTY_ERROR_CLEARED' }
  | { type: 'PARTY_SLOW_CONNECT'; hint?: string | null }
  | { type: 'PARTY_SLOW_CLEARED' }
  | { type: 'PRESENCE_UPDATE'; online: OnlineUser[] }
  | { type: 'USER_JOINED'; username: string; status: string }
  | { type: 'USER_LEFT'; username: string }
  | { type: 'USER_STATUS'; username: string; status: string }
  | { type: 'ROOM_CREATED'; code: string; color: PlayerColor }
  | { type: 'JOINING_GAME'; code: string }
  | { type: 'GAME_START'; board: number[][]; you: PlayerColor; opponent: string }
  | { type: 'GAME_STATE'; board: number[][]; turn: PlayerColor; lastMove: { col: number; row: number }; winner?: PlayerColor | 'draw'; winLine?: [number, number][] }
  | { type: 'CHAT_MESSAGE'; from: string; text: string }
  | { type: 'OPPONENT_DISCONNECTED' }
  | { type: 'OPPONENT_RECONNECTED'; username: string }
  | { type: 'ROOM_FULL' }
  | { type: 'TOGGLE_PANEL' }
  | { type: 'RETURN_TO_LOBBY' }
  | { type: 'RESET' }
  | { type: 'CHALLENGE_RECEIVED'; from: string; code: string }
  | { type: 'CHALLENGE_ACCEPTED'; by: string }
  | { type: 'CHALLENGE_DECLINED'; by: string }
  | { type: 'CHALLENGE_FAILED'; target: string }
  | { type: 'CLEAR_CHALLENGE' }
  | { type: 'REMATCH_REQUESTED' };

export interface GameConnection {
  createGame: () => void;
  joinGame: (code: string) => void;
  makeMove: (column: number) => void;
  sendChat: (text: string) => void;
  requestRematch: () => void;
  leaveGame: () => void;
  challengePlayer: (target: string) => void;
  respondToChallenge: (from: string, accept: boolean) => void;
  /** Force a fresh lobby socket — used by the ErrorScreen Retry button when
   * partysocket's auto-reconnect has given up. */
  reconnectLobby: () => void;
}

export function createInitialGameState(): GameState {
  return {
    connected: false,
    slowConnect: false,
    slowConnectHint: null,
    partyError: null,
    username: null,
    onlineUsers: [],
    screen: 'setup',
    roomCode: null,
    myColor: null,
    opponent: null,
    board: [],
    turn: 'red',
    lastMove: null,
    winner: null,
    winLine: null,
    chatMessages: [],
    panelOpen: false,
    challengeFrom: null,
    challengeCode: null,
    challengeDeclinedBy: null,
    rematchRequested: false,
    opponentDisconnected: false,
  };
}
