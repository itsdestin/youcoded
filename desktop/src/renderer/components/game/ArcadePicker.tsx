// The arcade picker (spec §4.1) — the panel's home screen.
//
// The design rule this screen exists to satisfy: EVERY tile carries the one
// fact that decides whether you click it, so the panel answers "is there
// anything to do here?" before you click anything.
//   - solo tile   -> your best score (or "Not played yet")
//   - versus tile -> who is online who could play it right now
//
// Solo tiles are never gated and never degraded: they play signed out and
// they play with the leaderboard down (§4.2, §6.6). Only versus tiles can go
// unavailable, and when they do they say WHY rather than disappearing.

import { GAMES, type GameDefinition } from './game-registry';
import { Button, CARD_LEVEL_1 } from '../ui';

/** What the shell knows about a game right now. Deliberately flat and dumb —
 *  Step 2 fills it from the reducer + leaderboard; Step 1 fills it from a
 *  fixture, and neither one changes this component. */
export interface ArcadeStatus {
  /** Solo: the player's own best, already formatted. undefined = never played. */
  bestScore?: string;
  /** Versus: names of friends online who could play right now. */
  friendsOnline?: string[];
  /** Versus: set when the game cannot be started at all, with the reason in the
   *  user's words. Renders in place of the online list — never as an error dot,
   *  because a service being down is not the player's problem to fix. */
  unavailable?: string;
}

interface Props {
  statuses: Record<string, ArcadeStatus>;
  onPick: (game: GameDefinition) => void;
  /** Signed-out players still get the whole picker; versus tiles explain the
   *  gate on the tile rather than hiding behind a wall (§4.2). */
  signedIn: boolean;
  onSignIn: () => void;
}

/** The deciding fact, in plain words. This function is the whole point of the
 *  screen, so it lives at the top where it can be read in one go. */
function decidingFact(
  game: GameDefinition,
  status: ArcadeStatus,
  signedIn: boolean,
): { text: string; tone: 'ready' | 'quiet' } {
  if (game.kind === 'solo') {
    return status.bestScore
      ? { text: `Your best: ${status.bestScore}`, tone: 'ready' }
      : { text: 'Not played yet', tone: 'quiet' };
  }
  if (!signedIn) return { text: 'Sign in to play', tone: 'quiet' };
  if (status.unavailable) return { text: status.unavailable, tone: 'quiet' };
  const online = status.friendsOnline ?? [];
  if (online.length === 0) return { text: 'No friends online', tone: 'quiet' };
  if (online.length === 1) return { text: `${online[0]} is online`, tone: 'ready' };
  if (online.length === 2) return { text: `${online[0]} and ${online[1]} are online`, tone: 'ready' };
  return { text: `${online[0]} and ${online.length - 1} others are online`, tone: 'ready' };
}

function GameCard({
  game, status, signedIn, onPick,
}: { game: GameDefinition; status: ArcadeStatus; signedIn: boolean; onPick: () => void }) {
  const fact = decidingFact(game, status, signedIn);
  // A versus game is only truly unclickable when the service is down. Signed
  // out is NOT disabled — clicking explains the gate, which is a better answer
  // than a dead tile (design guide §4.7: a disabled control must say why).
  const disabled = game.kind === 'versus' && !!status.unavailable;

  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      // G-3: `lg` radius — this is a card, not a button-shaped control.
      //
      // Surface fix (found in the Step 1 capture): these were `bg-inset`, and
      // the games PANE is itself `bg-inset` — so the cards were invisible in
      // all six themes. `well` is the next step DOWN the depth ladder (§2.1)
      // from the pane, and the hairline gives the card an edge on the themes
      // where well and inset sit close together.
      //
      // WHY CARD_LEVEL_1 (quick-fix batch, 2026-09-29; ui-labels-batch#LB-16):
      // the app's one first-level card — outline-led, so it reads on the
      // bg-inset pane in every theme without the darker `well` fill. Hover
      // deepens the fill like a clickable Settings row (SettingRow).
      className={`group ${CARD_LEVEL_1} flex flex-col gap-2 p-3 text-left transition-colors hover:bg-inset disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
    >
      <game.Tile />
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-sm font-medium text-fg truncate">{game.name}</span>
        {/* G-5: the deciding fact is INFORMATION, so it sits at text-2xs and
            never lower. `fg-2` when there is something to act on, `fg-muted`
            when there isn't — a value contrast, not a colour code. */}
        <span className={`text-2xs truncate ${fact.tone === 'ready' ? 'text-fg-2' : 'text-fg-muted'}`}>
          {fact.text}
        </span>
      </div>
    </button>
  );
}

export default function ArcadePicker({ statuses, onPick, signedIn, onSignIn }: Props) {
  return (
    <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        {GAMES.map((game) => (
          <GameCard
            key={game.id}
            game={game}
            status={statuses[game.id] ?? {}}
            signedIn={signedIn}
            onPick={() => onPick(game)}
          />
        ))}
      </div>

      {/* The sign-in line sits UNDER the grid, not in front of it. Reversing
          the old panel's gate is the point of §4.2: Flappy and 2048 are
          playable right now, and the account only buys the ranking. */}
      {!signedIn && (
        <div className={`${CARD_LEVEL_1} px-3 py-2.5 flex flex-col gap-2`}>
          <p className="text-2xs text-fg-muted leading-relaxed">
            Flappy and 2048 play without an account. Sign in to play friends and
            to put your scores on the board.
          </p>
          {/* WHY outlined, not the old "G-4: the only primary" text-link
              (guide: secondary actions are outlined, never bare text —
              "Sign in links that are really actions" is named explicitly). */}
          <Button variant="secondary" size="sm" className="self-start" onClick={onSignIn}>
            Sign in
          </Button>
        </div>
      )}
    </div>
  );
}
