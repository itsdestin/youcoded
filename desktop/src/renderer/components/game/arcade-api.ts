// The arcade's data boundary (spec §6.1, §6.5, §6.6).
//
// Everything here is a PURE function from what the server said to what a screen
// renders, plus the type of the `window.claude.arcade` bridge. It lives apart
// from ArcadeShell so the mapping can be tested directly: two of the three bugs
// found in this feature were states that only exist in the real app, and those
// are exactly the states a pure function can be handed on purpose.
//
// THE RULE THIS FILE ENFORCES: scores cross the wire as raw NUMBERS. "31 pipes"
// and "12,480" are a particular game's own words and come from its entry in
// game-registry.ts. Main and the Worker never learn a game's vocabulary, so
// adding a game is a renderer-only change.

import type { GameBoard, GameScoreRow } from '../../state/marketplace-api-client';
import type { ArcadeStatus } from './ArcadePicker';
import type { LeaderboardRow } from './Leaderboard';
import { GAMES, type GameDefinition } from './game-registry';

// Local mirror of the renderer/main ApiResult shape — the same convention
// GameLobby.tsx uses, because the canonical declaration lives in main/ and the
// renderer must not import across that boundary.
type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; message: string };

/** A board plus, when it is a remembered copy served because the live fetch
 *  failed, WHEN we fetched it. `cachedAt: null` means fresh. */
export interface BoardResult {
  board: GameBoard;
  cachedAt: number | null;
}

/** What `window.claude.arcade` provides. Optional at every level: the workbench
 *  installs a fake, Electron and remote access install the real thing, and any
 *  surface that has neither must still render a playable picker (§4.2). */
export interface ArcadeApi {
  status: () => Promise<ApiResult<Record<string, GameScoreRow>>>;
  leaderboard: (game: string) => Promise<ApiResult<BoardResult>>;
  submitScore?: (game: string, score: number) => Promise<ApiResult<{ best: number; is_best: boolean }>>;
}

export function arcadeApi(): ArcadeApi | undefined {
  return (window.claude as unknown as { arcade?: ArcadeApi }).arcade;
}

/** Server bests, reduced to plain numbers keyed by game id. Rows for games this
 *  build doesn't have are dropped rather than carried — an old score for a
 *  removed game is not something any screen can render. */
export function serverBests(scores: Record<string, GameScoreRow>): Record<string, number> {
  const known = new Set(GAMES.map((g) => g.id));
  const out: Record<string, number> = {};
  for (const [id, row] of Object.entries(scores ?? {})) {
    if (known.has(id) && typeof row?.best === 'number') out[id] = row.best;
  }
  return out;
}

/** ONE best per game, from the two places a best can live.
 *
 *  Takes the HIGHER of the server's number and this computer's, and that is not
 *  a tie-break dodge — either can legitimately be ahead. The server is ahead
 *  when you played on your phone; this computer is ahead when you played
 *  offline and the run has not been published yet. Taking the max is the only
 *  rule that never shows you a number LOWER than one you have already seen,
 *  which is the thing a player would read as "it lost my score".
 *
 *  Every game in the arcade scores higher-is-better;
 *  `GameDefinition.scoring.higherIsBetter` exists for a future game that does
 *  not, and this is the one function that would have to learn about it. */
export function mergeBests(
  server: Record<string, number>,
  local: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...local };
  for (const [id, n] of Object.entries(server ?? {})) {
    const mine = out[id];
    if (mine === undefined || n > mine) out[id] = n;
  }
  return out;
}

/** The picker's per-game deciding fact, assembled from the sources it has.
 *
 *  `friendsOnline` comes from the LIVE PRESENCE LIST, not from the server: who
 *  is online is a socket fact, and asking an HTTP endpoint for it would be both
 *  slower and wrong within seconds. */
export function buildStatuses(input: {
  bests: Record<string, number>;
  onlineNames: string[];
  versusUnavailable?: string;
  /** A versus line that is not a failure ("You're incognito") — the tile stays playable. */
  versusNote?: string;
}): Record<string, ArcadeStatus> {
  const out: Record<string, ArcadeStatus> = {};
  for (const game of GAMES) {
    if (game.kind === 'solo') {
      const best = input.bests[game.id];
      out[game.id] = best === undefined || !game.scoring
        ? {}
        : { bestScore: game.scoring.format(best) };
    } else {
      out[game.id] = input.versusUnavailable
        ? { unavailable: input.versusUnavailable }
        : input.versusNote
          ? { note: input.versusNote, friendsOnline: input.onlineNames }
          : { friendsOnline: input.onlineNames };
    }
  }
  return out;
}

/** Ranked server rows → the display rows Leaderboard takes. Order is the
 *  Worker's and is preserved exactly: rank (and its tie rule, earliest-to-the-
 *  score wins) is decided once, server-side, so every player sees one board. */
export function toRows(board: GameBoard | null, game: GameDefinition): LeaderboardRow[] {
  if (!board?.entries?.length) return [];
  const format = game.scoring?.format ?? ((n: number) => String(n));
  return board.entries.map((e) => ({
    accountId: e.id,
    name: e.display_name,
    handle: e.handle,
    score: format(e.best_score),
    isYou: e.is_you,
  }));
}

/** How to word a board we are showing from memory. States WHEN, never WHY —
 *  we have not verified a cause and must not invent one. `null` for a fresh
 *  board, so the caller can pass it straight through. */
export function staleNote(cachedAt: number | null, now = Date.now()): string | undefined {
  if (cachedAt === null) return undefined;
  const mins = Math.floor(Math.max(0, now - cachedAt) / 60_000);
  if (mins < 1) return 'Updated just now';
  if (mins === 1) return 'Updated 1 minute ago';
  if (mins < 60) return `Updated ${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  return hours === 1 ? 'Updated 1 hour ago' : `Updated ${hours} hours ago`;
}
