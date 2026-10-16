// The head-to-head record shape is the SAME over both transports — the presence
// socket pushes one when a match settles, and GET /games/records serves a list
// of them. Imported rather than redeclared so the two can never drift apart.
import type { HeadToHead } from './marketplace-api-client';
export type { HeadToHead };
export type GameScreen = 'setup' | 'lobby' | 'waiting' | 'joining' | 'playing' | 'game-over';

/** Which of the two chairs you are sitting in. THE SHELL KNOWS NOTHING ELSE
 *  about a game's players — not their colour, not their side, not their piece
 *  set. Seat 0 is whoever created the room (the challenger); seat 1 joined it.
 *
 *  This replaced `PlayerColor = 'red' | 'yellow'`, which was Connect 4's own
 *  vocabulary sitting in the shared state where chess and 2048 had to read it
 *  (spec §3.1, the largest piece of work in the project). */
export type Seat = 0 | 1;

/** How a versus game ended, in terms the shell can act on without knowing the
 *  rules. `GameDefinition.outcomeOf` is how a game produces one. */
export type GameOutcome = { winnerSeat: Seat } | { draw: true };

// Identity is the ACCOUNT (spec §3): display name is the visible tag, account
// id is the stable key (display names aren't unique).
export interface OnlineUser {
  id: string;
  name: string;            // display_name from the account
  handle: string | null;
  status: 'idle' | 'in-game';
}


export interface ChatMessage {
  from: string;
  text: string;
  timestamp: number;
}

export interface GameState {
  connected: boolean;
  partyError: string | null;
  /** Incognito could not connect hidden, and why (final review F4): 'unsupported' = the server said it
   *  cannot hide this device (an older server); 'unreachable' = the check could not be made and is being
   *  retried. null otherwise. Lets the friends card say only what is true. */
  hiddenBlocked: 'unsupported' | 'unreachable' | null;
  username: string | null;
  onlineUsers: OnlineUser[];
  screen: GameScreen;
  roomCode: string | null;
  opponent: string | null;
  /** The ACCOUNT of the person you are playing. `opponent` above is their
   *  display name, which is what the game room tags moves with — but a
   *  permanent head-to-head record has to be filed against an account, or two
   *  friends who chose the same display name would share one record.
   *
   *  It never comes from the game room, which only ever sees display names. It
   *  comes from the CHALLENGE: the challenger knows who they challenged, and
   *  the accepter knows who challenged them. Two paths, one fact. */
  opponentId: string | null;
  /** How many matches have STARTED in the current room, so `${roomCode}#${n}`
   *  is this match's identity.
   *
   *  A rematch REUSES the room (verified: 'rematch' dispatches GAME_START again
   *  with no new code), so the room code alone is not a match identity — the
   *  second game would look to the server like a duplicate of the first and be
   *  silently dropped. Both clients count the same GAME_STARTs, so both derive
   *  the same id without having to agree on one over the wire. */
  matchesStarted: number;
  /** The record the server settled for the match that just finished, pushed to
   *  both players once they agree on how it ended. Null until then — a match
   *  whose players disagree settles as nothing, which is the safe failure. */
  record: HeadToHead | null;

  // ── The three things the shell needs from ANY turn-based game (§3.1) ──
  /** Which chair you are in, or null outside a game. */
  seat: Seat | null;
  /** Whose turn it is. The shell renders "Your turn" from this and nothing else. */
  turnSeat: Seat | null;
  /** Set once the game is over. Null while it is still running. */
  outcome: GameOutcome | null;
  /** THE GAME'S OWN STATE, OPAQUE TO THE SHELL. Connect 4 puts a
   *  `ConnectFourPlay` here; chess will put a position. Nothing outside the
   *  game's own components may read into this — that is the whole point of the
   *  split, and why it is `unknown` rather than a union of every game. */
  play: unknown;

  chatMessages: ChatMessage[];
  panelOpen: boolean;
  /** Incoming challenge from another player (account identity: id is the stable
   * key, name is the visible tag; handle is carried through for the Task 8
   * friends UI to render @handle in the challenge banner). */
  challengeFrom: { id: string; name: string; handle: string | null } | null;
  /** Room code from incoming challenge */
  challengeCode: string | null;
  /** WHICH GAME the incoming challenge is for. The wire has carried this since
   *  the lobby was built (`gameType`), but the reducer used to drop it on the
   *  floor — so Accept could only ever open Connect 4 (§3.1 item 3). */
  challengeGame: string | null;
  /** Outgoing challenge was declined (account identity, handle included — see
   * challengeFrom). */
  challengeDeclinedBy: { id: string; name: string; handle: string | null } | null;
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
  | { type: 'PRESENCE_HIDDEN_BLOCKED'; why: 'unsupported' | 'unreachable' }
  | { type: 'PRESENCE_UPDATE'; online: OnlineUser[] }
  | { type: 'USER_JOINED'; user: OnlineUser }
  | { type: 'USER_LEFT'; id: string }
  | { type: 'USER_STATUS'; id: string; status: 'idle' | 'in-game' }
  | { type: 'ROOM_CREATED'; code: string; seat: Seat; opponentId: string }
  | { type: 'JOINING_GAME'; code: string }
  | { type: 'GAME_START'; seat: Seat; opponent: string; play: unknown; turnSeat: Seat }
  // The three identity fields are NOT decoration — the reducer refuses a
  // record that is not for the match currently on screen. See matchIdOf().
  | { type: 'MATCH_RECORDED'; record: HeadToHead; opponentId: string; matchId: string }
  | { type: 'GAME_STATE'; play: unknown; turnSeat: Seat; outcome?: GameOutcome }
  | { type: 'CHAT_MESSAGE'; from: string; text: string }
  | { type: 'OPPONENT_DISCONNECTED' }
  | { type: 'OPPONENT_RECONNECTED'; username: string }
  | { type: 'ROOM_FULL' }
  | { type: 'TOGGLE_PANEL' }
  | { type: 'RETURN_TO_LOBBY' }
  | { type: 'RESET' }
  | { type: 'CHALLENGE_RECEIVED'; from: { id: string; name: string; handle: string | null }; gameType: string; code: string }
  | { type: 'CHALLENGE_ACCEPTED'; by: { id: string; name: string; handle: string | null } }
  | { type: 'CHALLENGE_DECLINED'; by: { id: string; name: string; handle: string | null } }
  | { type: 'CHALLENGE_FAILED'; target: string }
  | { type: 'CLEAR_CHALLENGE' }
  | { type: 'REMATCH_REQUESTED' };

export interface GameConnection {
  // createGame was removed 2026-07-09 with the manual room-code UI (Destin:
  // challenges are the only game entry now). Room codes REMAIN the internal
  // capability token for PartyKit rooms — challengePlayer generates one and
  // joinGame consumes the code received with an accepted challenge.
  /** Join a game room by code — the code arrives with an incoming challenge.
   *  `gameId` says WHICH game, so the accepting client connects to the right
   *  referee instead of always assuming Connect 4 (§3.1 item 3). */
  joinGame: (code: string, gameId: string) => void;
  /** A move in whatever shape the open game uses — a column number for Connect
   *  4, a from/to pair for chess. The shell forwards it without inspecting it. */
  makeMove: (move: unknown) => void;
  sendChat: (text: string) => void;
  requestRematch: () => void;
  leaveGame: () => void;
  /** target is the challenged player's ACCOUNT ID (spec §3); `gameId` is which
   *  game you are challenging them to. */
  challengePlayer: (target: string, gameId: string) => void;
  /** `from` is the challenger's ACCOUNT ID (spec §3). */
  respondToChallenge: (from: string, accept: boolean) => void;
  /** Force a fresh presence socket — used by the ErrorScreen Retry button when
   * the platform-layer socket has dropped and needs a clean reconnect. */
  reconnectLobby: () => void;
}

/** This match's identity: `${roomCode}#${matchesStarted}`, the same string both
 *  clients derive and the same one the server keys a settled record on.
 *
 *  Lives HERE rather than beside its sender (useMatchReport.ts) because both
 *  ends of the round trip need it — the hook to SEND a report, and the reducer
 *  to decide whether an arriving record belongs to the match on screen. Two
 *  copies of this string is exactly how a record would end up filed against the
 *  wrong game. */
export function matchIdOf(state: Pick<GameState, 'roomCode' | 'matchesStarted'>): string | null {
  if (!state.roomCode || state.matchesStarted < 1) return null;
  return `${state.roomCode}#${state.matchesStarted}`;
}

export function createInitialGameState(): GameState {
  return {
    connected: false,
    partyError: null,
    hiddenBlocked: null,
    username: null,
    onlineUsers: [],
    screen: 'setup',
    roomCode: null,
    opponent: null,
    opponentId: null,
    matchesStarted: 0,
    record: null,
    seat: null,
    turnSeat: null,
    outcome: null,
    play: null,
    chatMessages: [],
    panelOpen: false,
    challengeFrom: null,
    challengeCode: null,
    challengeGame: null,
    challengeDeclinedBy: null,
    rematchRequested: false,
    opponentDisconnected: false,
  };
}
