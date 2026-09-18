// The game slot (spec §3) — what a game declares about itself so the arcade
// shell never hardcodes a game's name, rules, or shape.
//
// STEP 1 SCOPE: this file carries the declaration only. `View` (the playfield)
// and the state split land in Step 2 — the shell is being designed first, and
// the slot's final shape depends on what that design needs. Nothing here
// imports a rules module, so adding a game to this list costs nothing yet.

import React from 'react';
import { ConnectFourTile, ChessTile, FlappyTile, TwentyFortyEightTile } from './GameTiles';

export type GameKind = 'solo' | 'versus';

/** What a SOLO game is handed. Deliberately tiny: a solo game is a local loop
 *  plus a number at the end. It never sees the network, the friends list, the
 *  opponent, or the shell's state — which is why the two solo games can be
 *  built at the same time as everything else (spec §3).
 *
 *  §7 RULE, and this is why the props are this short: a game is NOT told when
 *  the assistant finishes, and must not go looking. The chime and the status
 *  light are the only signals; nothing here pauses, blurs, or interrupts a run.
 *  The ast-grep rule arcade-no-forbidden-attention-apis fails the build if a
 *  game file reaches for that. */
export interface SoloGameProps {
  /** Called once when a run ends, with the run's score. The shell owns what
   *  happens next — saving it, publishing it, showing the board again. */
  onEnd: (score: number) => void;
  /** The player's current best, for the game to show in its own chrome if it
   *  wants to. Undefined means they have never finished a run. */
  best?: number;
  /** Back to the games shelf. The end-of-run card offers it, so a player who is
   *  done does not have to hunt for the header's back arrow. */
  onExit?: () => void;
}

export interface GameDefinition {
  /** Stable id. NOTE: for Connect 4 this is 'connect-four' because that is the
   *  string already on the wire (usePartyGame.ts sends it today) — deliberately
   *  NOT the same as `party` below, which is the PartyKit party name. */
  id: string;
  name: string;
  kind: GameKind;
  /** One line under the name in the picker. Says what the game IS, not why it's
   *  fun — the tile has ~40 characters and the player already knows chess. */
  blurb: string;
  /** Picker tile art. Theme-token only — no game ships its own palette (§5.5). */
  Tile: React.ComponentType;
  /** Solo games only: the playfield. Lazy so a game's code is not in the bundle
   *  until someone opens it — four games behind one button should not cost four
   *  games' worth of startup. */
  Play?: React.LazyExoticComponent<React.ComponentType<SoloGameProps>>;
  /** Starting pane width in px. The user's resize wins and is remembered per
   *  game (§4.3) — this is only the first-open default. */
  defaultPaneWidth: number;
  /** Solo games only: how a run's result becomes a leaderboard number.
   *  `format` turns the raw number into what the board shows, so "31 pipes"
   *  and "12,480" are the game's vocabulary and not the shell's. */
  scoring?: { label: string; higherIsBetter: boolean; format: (score: number) => string };
  /** Versus games only: the PartyKit party that referees it. Distinct from `id`
   *  — the shipped party is spelled 'connectfour' (partykit.json) while the
   *  wire's gameType is 'connect-four'. Keeping both fields avoids a migration. */
  party?: string;
}

/** Registration order IS picker order. Solo games lead because they are the
 *  ones playable with nobody online — the picker must not open on two tiles
 *  that say "no friends online" (§4.1). */
export const GAMES: readonly GameDefinition[] = [
  {
    id: 'flappy',
    name: 'Flappy',
    kind: 'solo',
    blurb: 'Fly your theme\u2019s mascot through the gaps.',
    Tile: FlappyTile,
    Play: React.lazy(() => import('./FlappyGame')),
    defaultPaneWidth: 420,
    scoring: {
      label: 'Pipes cleared', higherIsBetter: true,
      format: (n) => `${n} ${n === 1 ? 'pipe' : 'pipes'}`,
    },
  },
  {
    id: 'twenty-forty-eight',
    name: '2048',
    kind: 'solo',
    blurb: 'Slide and merge. Put it down mid-move; nothing is lost.',
    Tile: TwentyFortyEightTile,
    // Lazy so a game's code is not in the bundle until someone opens it.
    Play: React.lazy(() => import('./TwentyFortyEightGame')),
    defaultPaneWidth: 440,
    scoring: { label: 'Score', higherIsBetter: true, format: (n) => n.toLocaleString() },
  },
  {
    id: 'connect-four',
    name: 'Connect 4',
    kind: 'versus',
    blurb: 'Four in a row against a friend.',
    Tile: ConnectFourTile,
    defaultPaneWidth: 420,
    party: 'connectfour',
  },
  {
    id: 'chess',
    name: 'Chess',
    kind: 'versus',
    blurb: 'Full rules, refereed by the server.',
    Tile: ChessTile,
    // Widest default (§5.3): at 400px the squares are ~50px, which is
    // cramped and bad on touch. 520 puts them near 60px inside the pane's
    // padding without crowding the chat below.
    defaultPaneWidth: 520,
    party: 'chess',
  },
];

export function gameById(id: string): GameDefinition | undefined {
  return GAMES.find((g) => g.id === id);
}
