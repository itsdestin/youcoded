import { describe, it, expect } from 'vitest';
import { gameReducer } from '../src/renderer/state/game-reducer';
import { createInitialGameState, GameState, OnlineUser } from '../src/renderer/state/game-types';

// Accounts Phase 2 (Task 7): presence identity is the ACCOUNT now — keyed by id,
// display name is the visible tag. These pin the account-keyed presence/challenge
// reducer behavior and that the retired slow-connect action type is gone.

function withUsers(users: OnlineUser[]): GameState {
  return { ...createInitialGameState(), onlineUsers: users };
}

const alice: OnlineUser = { id: 'github:1', name: 'Alice', handle: 'alice', status: 'idle' };
const bob: OnlineUser = { id: 'github:2', name: 'Bob', handle: null, status: 'idle' };

describe('gameReducer — presence (account-keyed)', () => {
  it('PARTY_CONNECTED sets the visible tag and moves to the lobby', () => {
    const next = gameReducer(createInitialGameState(), { type: 'PARTY_CONNECTED', username: 'Alice' });
    expect(next.connected).toBe(true);
    expect(next.username).toBe('Alice');
    expect(next.screen).toBe('lobby');
    expect(next.partyError).toBeNull();
  });

  it('PARTY_CONNECTED preserves an in-progress game screen (reload-replay broadcast)', () => {
    // The platform layer's renderer-reload replay re-emits a synthetic
    // 'connected' to ALL windows when any one of them reconnects — a second
    // window mid-game must not be yanked back to the lobby.
    for (const screen of ['waiting', 'joining', 'playing', 'game-over'] as const) {
      const next = gameReducer({ ...createInitialGameState(), screen }, { type: 'PARTY_CONNECTED', username: 'Alice' });
      expect(next.screen).toBe(screen);
      expect(next.connected).toBe(true);
    }
  });

  it('PRESENCE_UPDATE replaces the whole list', () => {
    const next = gameReducer(withUsers([alice]), { type: 'PRESENCE_UPDATE', online: [bob] });
    expect(next.onlineUsers).toEqual([bob]);
  });

  it('PRESENCE_UPDATE ignores a malformed payload (keeps existing list)', () => {
    // A malformed frame must never wipe onlineUsers to undefined — later
    // USER_* reducers call .filter/.map on it.
    const next = gameReducer(withUsers([alice]), { type: 'PRESENCE_UPDATE', online: undefined as any });
    expect(next.onlineUsers).toEqual([alice]);
  });

  it('USER_JOINED keys on id (replaces an existing entry for the same id)', () => {
    const updatedAlice: OnlineUser = { ...alice, status: 'in-game' };
    const next = gameReducer(withUsers([alice]), { type: 'USER_JOINED', user: updatedAlice });
    expect(next.onlineUsers).toHaveLength(1);
    expect(next.onlineUsers[0].status).toBe('in-game');
  });

  it('USER_JOINED appends a new account', () => {
    const next = gameReducer(withUsers([alice]), { type: 'USER_JOINED', user: bob });
    expect(next.onlineUsers.map(u => u.id)).toEqual(['github:1', 'github:2']);
  });

  it('USER_LEFT removes by id', () => {
    const next = gameReducer(withUsers([alice, bob]), { type: 'USER_LEFT', id: 'github:1' });
    expect(next.onlineUsers.map(u => u.id)).toEqual(['github:2']);
  });

  it('USER_STATUS updates status by id', () => {
    const next = gameReducer(withUsers([alice, bob]), { type: 'USER_STATUS', id: 'github:2', status: 'in-game' });
    expect(next.onlineUsers.find(u => u.id === 'github:2')?.status).toBe('in-game');
    expect(next.onlineUsers.find(u => u.id === 'github:1')?.status).toBe('idle');
  });
});

describe('gameReducer — challenges (account identity)', () => {
  it('CHALLENGE_RECEIVED stores the full card {id, name, handle}, sets the code, and opens the panel', () => {
    const next = gameReducer(createInitialGameState(), {
      type: 'CHALLENGE_RECEIVED',
      from: { id: 'github:2', name: 'Bob', handle: 'bob' },
      gameType: 'connect-four',
      code: 'ABC123',
    });
    // handle is carried through (Task 8's friends UI renders @handle).
    expect(next.challengeFrom).toEqual({ id: 'github:2', name: 'Bob', handle: 'bob' });
    expect(next.challengeCode).toBe('ABC123');
    expect(next.panelOpen).toBe(true);
  });

  it('CHALLENGE_DECLINED stores the full card {id, name, handle} of the decliner', () => {
    const next = gameReducer(createInitialGameState(), { type: 'CHALLENGE_DECLINED', by: { id: 'github:2', name: 'Bob', handle: null } });
    expect(next.challengeDeclinedBy).toEqual({ id: 'github:2', name: 'Bob', handle: null });
  });

  it('CHALLENGE_FAILED resolves the account id to a visible name via the presence list', () => {
    const state: GameState = { ...withUsers([bob]), screen: 'waiting' };
    const next = gameReducer(state, { type: 'CHALLENGE_FAILED', target: 'github:2' });
    expect(next.screen).toBe('lobby');
    expect(next.partyError).toBe('Bob is no longer online.');
  });

  it('CLEAR_CHALLENGE clears all challenge fields', () => {
    const state: GameState = {
      ...createInitialGameState(),
      challengeFrom: { id: 'github:2', name: 'Bob', handle: 'bob' },
      challengeCode: 'ABC123',
      challengeDeclinedBy: { id: 'github:3', name: 'Cara', handle: null },
    };
    const next = gameReducer(state, { type: 'CLEAR_CHALLENGE' });
    expect(next.challengeFrom).toBeNull();
    expect(next.challengeCode).toBeNull();
    expect(next.challengeDeclinedBy).toBeNull();
  });
});

describe('gameReducer — disconnect semantics', () => {
  it('PARTY_DISCONNECTED with no code is silent (intentional local disconnect)', () => {
    const next = gameReducer({ ...withUsers([alice]), connected: true }, { type: 'PARTY_DISCONNECTED' });
    expect(next.connected).toBe(false);
    expect(next.onlineUsers).toEqual([]);
    expect(next.partyError).toBeNull();
  });

  it('PARTY_DISCONNECTED with a code surfaces an error (real drop)', () => {
    const next = gameReducer({ ...withUsers([alice]), connected: true }, { type: 'PARTY_DISCONNECTED', code: 1006 });
    expect(next.connected).toBe(false);
    expect(next.partyError).toContain('1006');
  });
});

describe('gameReducer — retired action types', () => {
  it('PARTY_SLOW_CONNECT is no longer part of the action union', () => {
    // @ts-expect-error — PARTY_SLOW_CONNECT was deleted with the PartyKit lobby (Task 7).
    const next = gameReducer(createInitialGameState(), { type: 'PARTY_SLOW_CONNECT', hint: 'x' });
    // Unknown action → default branch returns state unchanged.
    expect(next).toEqual(createInitialGameState());
  });
});

// ── The state split (spec §3.1) ────────────────────────────────────────────
// The shell used to hold `board`, `myColor: 'red'|'yellow'`, `turn`, `winner`
// and `winLine` — Connect 4's own vocabulary, in the state chess and 2048 also
// had to read. It now holds only a SEAT, whose turn it is, and an outcome; the
// game's own state rides in `play`, opaque to everything outside that game.
describe('gameReducer — the state split', () => {
  it('GAME_START takes the game\'s own state whole and does not inspect it', () => {
    const weird = { anything: 'at all', nested: [1, 2, 3] };
    const s = gameReducer(createInitialGameState(), {
      type: 'GAME_START', seat: 1, opponent: 'Jake', play: weird, turnSeat: 0,
    });
    expect(s.play).toBe(weird);      // handed over by reference, untouched
    expect(s.seat).toBe(1);
    expect(s.turnSeat).toBe(0);
    expect(s.screen).toBe('playing');
    expect(s.outcome).toBeNull();
  });

  it('GAME_STATE ends the game only when an outcome arrives', () => {
    const playing = gameReducer(createInitialGameState(), {
      type: 'GAME_START', seat: 0, opponent: 'Jake', play: {}, turnSeat: 0,
    });
    const moved = gameReducer(playing, { type: 'GAME_STATE', play: { n: 1 }, turnSeat: 1 });
    expect(moved.screen).toBe('playing');
    expect(moved.outcome).toBeNull();

    const won = gameReducer(moved, {
      type: 'GAME_STATE', play: { n: 2 }, turnSeat: 0, outcome: { winnerSeat: 0 },
    });
    expect(won.screen).toBe('game-over');
    expect(won.outcome).toEqual({ winnerSeat: 0 });
  });

  it('a draw is an outcome too, not a magic winner value', () => {
    const s = gameReducer(createInitialGameState(), { type: 'GAME_STATE', play: {}, turnSeat: 1, outcome: { draw: true } });
    expect(s.outcome).toEqual({ draw: true });
    expect(s.screen).toBe('game-over');
  });

  it('RETURN_TO_LOBBY drops the game\'s own state', () => {
    // Otherwise one game's leftovers reach the next game's board — the exact
    // failure the split exists to make impossible.
    const playing = gameReducer(createInitialGameState(), {
      type: 'GAME_START', seat: 0, opponent: 'Jake', play: { board: 'stale' }, turnSeat: 0,
    });
    const back = gameReducer(playing, { type: 'RETURN_TO_LOBBY' });
    expect(back.play).toBeNull();
    expect(back.seat).toBeNull();
    expect(back.turnSeat).toBeNull();
    expect(back.outcome).toBeNull();
  });

  it('CHALLENGE_RECEIVED keeps WHICH game it is for', () => {
    // This is the bug the split fixed: the wire has always carried gameType,
    // and the reducer dropped it — so Accept could only ever open Connect 4.
    const s = gameReducer(createInitialGameState(), {
      type: 'CHALLENGE_RECEIVED',
      from: { id: 'jake', name: 'Jake', handle: 'jake' },
      gameType: 'chess',
      code: 'ABCD',
    });
    expect(s.challengeGame).toBe('chess');
    expect(gameReducer(s, { type: 'CLEAR_CHALLENGE' }).challengeGame).toBeNull();
  });

  it('an empty gameType falls back rather than leaving the accept path blank', () => {
    const s = gameReducer(createInitialGameState(), {
      type: 'CHALLENGE_RECEIVED',
      from: { id: 'jake', name: 'Jake', handle: null },
      gameType: '',
      code: 'ABCD',
    });
    expect(s.challengeGame).toBe('connect-four');
  });
});

// ── MATCH_RECORDED: a record only ever belongs to the match on screen ────────
//
// The bug these pin: the presence socket fans every frame to EVERY window and
// every connected remote browser, and the Worker holds an unpaired report for
// up to two minutes before settling. So a record for a different opponent, or
// for the match before this one, genuinely arrives while another game is
// showing — and the overlay printed it next to whoever was on screen. Your
// Connect 4 record against Mira, captioned "You lead 5-1", under a chess win
// over Jake. Wrong about ANOTHER PERSON is the failure this feature must not
// have, so anything that does not match is dropped rather than guessed at.
describe('gameReducer — MATCH_RECORDED', () => {
  // Mid-match: chess against Jake, second game in room AAAA.
  const playing: GameState = {
    ...createInitialGameState(),
    opponentId: 'acct_jake', opponent: 'Jake', roomCode: 'AAAA', matchesStarted: 2,
  };
  const record = (opponent: string, game: string) => ({
    opponent_id: opponent, game, wins: 5, losses: 1, draws: 0, last_played_at: 0,
  });

  it('takes the record for the match on screen', () => {
    const s = gameReducer(playing, {
      type: 'MATCH_RECORDED',
      record: record('acct_jake', 'chess'),
      opponentId: 'acct_jake',
      matchId: 'AAAA#2',
    });
    expect(s.record).toEqual(record('acct_jake', 'chess'));
  });

  it('drops a record settled for a DIFFERENT opponent', () => {
    const s = gameReducer(playing, {
      type: 'MATCH_RECORDED',
      record: record('acct_mira', 'connect-four'),
      opponentId: 'acct_mira',
      matchId: 'ZZZZ#1',
    });
    expect(s.record).toBeNull();
    expect(s).toBe(playing); // untouched, not a new object
  });

  it('drops a LATE record for the previous match against the same opponent', () => {
    // Same person, same room — but match 1, and we are on match 2 now. Its
    // numbers are one game out of date, which on this screen reads as a wrong
    // score rather than an old one.
    const s = gameReducer(playing, {
      type: 'MATCH_RECORDED',
      record: record('acct_jake', 'chess'),
      opponentId: 'acct_jake',
      matchId: 'AAAA#1',
    });
    expect(s.record).toBeNull();
  });

  it('drops one that arrives when no match is in progress', () => {
    const s = gameReducer(createInitialGameState(), {
      type: 'MATCH_RECORDED',
      record: record('acct_jake', 'chess'),
      opponentId: 'acct_jake',
      matchId: 'AAAA#2',
    });
    expect(s.record).toBeNull();
  });
});

describe('gameReducer — CHAT_MESSAGE cap', () => {
  it('keeps the last 200 of 250 messages, dropping the oldest', () => {
    let s = createInitialGameState();
    for (let i = 0; i < 250; i++) {
      s = gameReducer(s, { type: 'CHAT_MESSAGE', from: 'Alice', text: `msg-${i}` });
    }
    expect(s.chatMessages).toHaveLength(200);
    // Oldest 50 (msg-0..msg-49) aged out; the newest survives at the tail.
    expect(s.chatMessages[0].text).toBe('msg-50');
    expect(s.chatMessages[s.chatMessages.length - 1].text).toBe('msg-249');
  });

  it('does not truncate under the cap', () => {
    let s = createInitialGameState();
    for (let i = 0; i < 5; i++) {
      s = gameReducer(s, { type: 'CHAT_MESSAGE', from: 'Bob', text: `hi-${i}` });
    }
    expect(s.chatMessages).toHaveLength(5);
  });
});
