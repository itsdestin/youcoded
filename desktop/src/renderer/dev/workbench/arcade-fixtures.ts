// Workbench fixture data for the arcade's score channels (spec §6.1, §6.5, §6.6).
//
// These are the WIRE shapes, not display shapes: raw numbers, snake_case, and
// an ApiResult envelope, exactly as `arcade:status` / `arcade:leaderboard`
// answer in the real app. That is the whole point — the workbench must exercise
// the same mapping code the shipped app runs (`components/game/arcade-api.ts`),
// or it proves nothing about the screens it is used to review.
//
// Note what is NOT here any more: who is online. Presence is a socket fact and
// arrives through the mocked `social.onPresenceEvent`, the same path the real
// app uses. It used to be baked into a status fixture, which meant the picker's
// "Jake is online" line was reviewed against something no server ever said.
//
// The scenarios exist because the states that are hard to get right are the
// ones you never see by accident: a board with only you on it, a service that
// is down, a player who has never played.

import { JAKE_ID, JAKE_USERNAME } from './fake-party';

/** The one thing the real channel returns per game: a raw best. */
export interface GameScoreRowFixture {
  best: number;
  best_at: number;
  runs: number;
}

/** One ranked row, in the Worker's own vocabulary. */
export interface BoardEntryFixture {
  id: string;
  display_name: string;
  handle: string | null;
  avatar_url: string | null;
  best_score: number;
  best_at: number;
  rank: number;
  is_you: boolean;
}

type Ok<T> = { ok: true; value: T };

// Fixed timestamps, not Date.now(): a screenshot diff must not change because
// the clock moved between two review runs.
const T = 1_756_600_000;

/** The second friend the leaderboards and the `?friends=many` list share. */
export const MIRA_ID = 'mira';

const DEFAULT_BESTS: Record<string, GameScoreRowFixture> = {
  'flappy': { best: 31, best_at: T, runs: 47 },
  'twenty-forty-eight': { best: 12_480, best_at: T, runs: 12 },
};

/** `empty` — a brand-new install. Nothing played. This is the state the picker
 *  MUST still read as inviting (§6.5): two of the four tiles are playable right
 *  now and the screen has to make that obvious. */
const NO_BESTS: Record<string, GameScoreRowFixture> = {};

const you = (score: number, rank: number): BoardEntryFixture => ({
  id: 'you', display_name: 'You', handle: 'destin', avatar_url: null,
  best_score: score, best_at: T, rank, is_you: true,
});

const POPULATED: Record<string, BoardEntryFixture[]> = {
  'flappy': [
    { id: MIRA_ID, display_name: 'Mira', handle: 'mira', avatar_url: null, best_score: 58, best_at: T, rank: 1, is_you: false },
    you(31, 2),
    { id: JAKE_ID, display_name: JAKE_USERNAME, handle: 'jake', avatar_url: null, best_score: 19, best_at: T, rank: 3, is_you: false },
  ],
  'twenty-forty-eight': [
    you(12_480, 1),
    { id: JAKE_ID, display_name: JAKE_USERNAME, handle: 'jake', avatar_url: null, best_score: 9_216, best_at: T, rank: 2, is_you: false },
  ],
};

/** The state §6.5 calls the most common one early on: you, alone. It is a REAL
 *  ranked row (#1 of 1, which is true) rather than a "no data" panel — the
 *  screen has to read as an invitation, not a failure. */
const ALONE: Record<string, BoardEntryFixture[]> = {
  'flappy': [you(31, 1)],
  'twenty-forty-eight': [you(12_480, 1)],
};

/** One head-to-head record, in the Worker's own vocabulary — MY wins first. */
export interface HeadToHeadFixture {
  opponent_id: string;
  game: string;
  wins: number;
  losses: number;
  draws: number;
  last_played_at: number;
}

/** Records against the one friend the workbench has. Deliberately NOT symmetric
 *  and not round: a 4-2-1 chess record and a 1-0 Connect 4 one show the three
 *  columns doing different work, where 1-1 or 0-0 would hide a column that was
 *  rendering wrong. `empty` has none — nobody has finished a versus game yet,
 *  which is the state every new install is in. */
const RECORDS: HeadToHeadFixture[] = [
  { opponent_id: JAKE_ID, game: 'chess', wins: 4, losses: 2, draws: 1, last_played_at: T },
  { opponent_id: JAKE_ID, game: 'connect-four', wins: 1, losses: 0, draws: 0, last_played_at: T - 86_400 },
  // `?friends=many` (games-social redesign): Mira LEADS you and Sam is level, so
  // a lobby shows a winning, a losing and an even record side by side. Listed
  // after Jake's so the match-report echo (which reads the first record for a
  // game) still bumps Jake's. Ada has none: a friend you have never played.
  { opponent_id: MIRA_ID, game: 'chess', wins: 1, losses: 3, draws: 0, last_played_at: T - 2 * 86_400 },
  { opponent_id: 'sam', game: 'chess', wins: 2, losses: 2, draws: 0, last_played_at: T - 5 * 86_400 },
  { opponent_id: MIRA_ID, game: 'connect-four', wins: 0, losses: 2, draws: 0, last_played_at: T - 3 * 86_400 },
];

export type ArcadeScenario = 'default' | 'empty' | 'alone' | 'degraded';

/** True when the scenario is the one where the versus service is down. The mock
 *  shim reads this to push a real `error` presence event, so the picker's
 *  "can't reach the game server" line comes from the SAME reducer path a real
 *  outage takes rather than from a hardcoded fixture string. */
export function arcadeVersusIsDown(scenario: ArcadeScenario): boolean {
  return scenario === 'degraded';
}

export function arcadeStatusFor(
  scenario: ArcadeScenario,
): Ok<Record<string, GameScoreRowFixture>> {
  // Solo bests are UNTOUCHED by the degraded scenario on purpose: §4.2 says an
  // outage in the versus service must not take the solo games with it.
  return { ok: true, value: scenario === 'empty' ? NO_BESTS : DEFAULT_BESTS };
}

export function arcadeBoardFor(
  scenario: ArcadeScenario,
  gameId: string,
): Ok<{ board: { game: string; you: BoardEntryFixture | null; entries: BoardEntryFixture[] }; cachedAt: number | null }> {
  const entries =
    scenario === 'empty' ? []
    : scenario === 'alone' ? (ALONE[gameId] ?? [])
    : (POPULATED[gameId] ?? []);
  // Degraded does NOT clear the board — it labels it. A leaderboard that
  // empties itself when the network blips teaches the player their scores were
  // lost, which is both alarming and untrue. Four minutes back so the note
  // renders its plural form.
  const cachedAt = scenario === 'degraded' ? Date.now() - 4 * 60_000 : null;
  return {
    ok: true,
    value: {
      board: { game: gameId, you: entries.find((e) => e.is_you) ?? null, entries },
      cachedAt,
    },
  };
}

export function arcadeRecordsFor(
  scenario: ArcadeScenario,
  game?: string,
): Ok<HeadToHeadFixture[]> {
  if (scenario === 'empty') return { ok: true, value: [] };
  return { ok: true, value: game ? RECORDS.filter((r) => r.game === game) : RECORDS };
}
