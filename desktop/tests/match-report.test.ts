import { describe, it, expect } from 'vitest';
import { gameReducer } from '../src/renderer/state/game-reducer';
import { createInitialGameState, type GameState } from '../src/renderer/state/game-types';
import { matchIdOf, outcomeFor } from '../src/renderer/hooks/useMatchReport';

// Head-to-head records (games spec §6.2). Everything here guards ONE claim:
// that this client can say, correctly and exactly once, WHO it played and HOW
// that match ended. Get either wrong and the app writes a permanent, visible,
// wrong fact about another person — which is why the server also refuses to
// write anything until both players independently agree.

const start = (s: GameState, seat: 0 | 1 = 0, opponent = 'Jake'): GameState =>
  gameReducer(s, { type: 'GAME_START', seat, opponent, play: {}, turnSeat: 0 });

describe('learning who you are playing', () => {
  it("the CHALLENGER keeps the account id they challenged", () => {
    // The lobby row's id — not the display name the game room tags moves with.
    const s = gameReducer(createInitialGameState(),
      { type: 'ROOM_CREATED', code: 'ABCD', seat: 0, opponentId: 'acct-jake' });
    expect(s.opponentId).toBe('acct-jake');
  });

  it('the ACCEPTER takes it from the challenge that arrived', () => {
    const challenged = gameReducer(createInitialGameState(), {
      type: 'CHALLENGE_RECEIVED',
      from: { id: 'acct-mira', name: 'Mira', handle: 'mira' },
      gameType: 'chess',
      code: 'WXYZ',
    });
    const joined = gameReducer(challenged, { type: 'JOINING_GAME', code: 'WXYZ' });
    expect(joined.opponentId).toBe('acct-mira');
  });

  it('the display name is NOT the identity', () => {
    // Two friends may share a display name; they cannot share an account. If
    // these two ever collapse into one field, records merge between people.
    let s = gameReducer(createInitialGameState(),
      { type: 'ROOM_CREATED', code: 'ABCD', seat: 0, opponentId: 'acct-jake' });
    s = start(s, 0, 'Jake');
    expect(s.opponent).toBe('Jake');
    expect(s.opponentId).toBe('acct-jake');
    expect(s.opponent).not.toBe(s.opponentId);
  });

  it('leaving forgets them, so the next game cannot inherit an opponent', () => {
    let s = gameReducer(createInitialGameState(),
      { type: 'ROOM_CREATED', code: 'ABCD', seat: 0, opponentId: 'acct-jake' });
    s = start(s);
    s = gameReducer(s, { type: 'RETURN_TO_LOBBY' });
    expect(s.opponentId).toBeNull();
    expect(matchIdOf(s)).toBeNull();
  });
});

describe('a rematch is a different match', () => {
  // THE bug this counter exists to prevent. A rematch reuses the room, so if the
  // match id were the room code the second game would look to the server like a
  // duplicate of the first and be silently discarded — the player would win
  // twice and see one win.
  it('gives each game in one room its own id', () => {
    let s = gameReducer(createInitialGameState(),
      { type: 'ROOM_CREATED', code: 'ABCD', seat: 0, opponentId: 'acct-jake' });
    s = start(s);
    const first = matchIdOf(s);
    // WHY: the reducer has no 'GAME_OVER' action (it was a silent no-op here); a game ends via GAME_STATE carrying an outcome.
    s = gameReducer(s, { type: 'GAME_STATE', play: {}, turnSeat: 0, outcome: { winnerSeat: 0 } });
    s = start(s);                              // the rematch, same room
    const second = matchIdOf(s);

    expect(first).toBe('ABCD#1');
    expect(second).toBe('ABCD#2');
    expect(first).not.toBe(second);
    expect(s.roomCode).toBe('ABCD');           // …and it really is the same room
  });

  it('has no id before a match has actually started', () => {
    const waiting = gameReducer(createInitialGameState(),
      { type: 'ROOM_CREATED', code: 'ABCD', seat: 0, opponentId: 'acct-jake' });
    // Sitting in an empty room is not a match. Reporting one here would file a
    // record for a game nobody played.
    expect(matchIdOf(waiting)).toBeNull();
  });

  it('both players derive the same id without exchanging one', () => {
    // Same room, same count of mutually-agreed starts, opposite seats.
    const mk = (seat: 0 | 1) => start(gameReducer(createInitialGameState(),
      { type: 'ROOM_CREATED', code: 'ABCD', seat, opponentId: 'x' }), seat);
    expect(matchIdOf(mk(0))).toBe(matchIdOf(mk(1)));
  });
});

describe('how the match looked from THIS seat', () => {
  const at = (seat: 0 | 1, outcome: GameState['outcome']): GameState =>
    ({ ...createInitialGameState(), seat, outcome });

  it('reads win and loss from opposite chairs', () => {
    expect(outcomeFor(at(0, { winnerSeat: 0 }))).toBe('win');
    expect(outcomeFor(at(1, { winnerSeat: 0 }))).toBe('loss');
    expect(outcomeFor(at(0, { winnerSeat: 1 }))).toBe('loss');
    expect(outcomeFor(at(1, { winnerSeat: 1 }))).toBe('win');
  });

  it('a draw is a draw from either chair', () => {
    expect(outcomeFor(at(0, { draw: true }))).toBe('draw');
    expect(outcomeFor(at(1, { draw: true }))).toBe('draw');
  });

  it('says nothing while the game is still running', () => {
    expect(outcomeFor(at(0, null))).toBeNull();
  });

  it('refuses to guess with no seat', () => {
    // Rather than defaulting to 'loss' and quietly filing a defeat nobody had.
    expect(outcomeFor({ seat: null, outcome: { winnerSeat: 0 } })).toBeNull();
  });
});

describe('the settled record', () => {
  const record = {
    opponent_id: 'acct-jake', game: 'chess',
    wins: 4, losses: 2, draws: 1, last_played_at: 1756600000,
  };

  /** A match actually in progress: chess against Jake, first game in ABCD.
   *  These tests MUST start from one — a record is only accepted for the match
   *  on screen, so dispatching against a lobby state would make every
   *  assertion below pass vacuously (see the guard in game-reducer.test.ts). */
  const inMatch = (): GameState => start(gameReducer(createInitialGameState(),
    { type: 'ROOM_CREATED', code: 'ABCD', seat: 0, opponentId: 'acct-jake' }));

  /** Settle THIS match — the id both clients derive, and the one the server
   *  keys the record on. */
  const settle = (s: GameState): GameState => gameReducer(s, {
    type: 'MATCH_RECORDED', record, opponentId: 'acct-jake', matchId: matchIdOf(s)!,
  });

  it('is stored when the server says both players agreed', () => {
    expect(settle(inMatch()).record).toEqual(record);
  });

  it('does not linger into the next match', () => {
    const s = start(settle(inMatch()));
    // Otherwise the rematch opens showing the score from the game before it,
    // which reads as though it already counted.
    expect(s.record).toBeNull();
  });

  it('is dropped on the way back to the lobby', () => {
    const s = gameReducer(settle(inMatch()), { type: 'RETURN_TO_LOBBY' });
    expect(s.record).toBeNull();
  });
});
