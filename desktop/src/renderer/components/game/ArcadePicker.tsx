// The arcade picker (spec §4.1) — the games grid under the friends panel.
//
// The design rule this screen exists to satisfy: EVERY tile carries the one
// fact that decides whether you click it, so the panel answers "is there
// anything to do here?" before you click anything.
//   - solo tile   -> your best score (or "Not played yet")
//   - versus tile -> who is online who could play it right now
//
// Solo tiles are never gated and never degraded: they play signed out and
// they play with the leaderboard down (§4.2, §6.6). A versus tile that cannot
// be played right now — signed out, or the game server unreachable — is greyed
// and disabled, and its line still says why (redesign backlog row 11: "grey/
// disable unplayable games").

import { GAMES, type GameDefinition } from './game-registry';
import { CARD_LEVEL_1, SectionLabel } from '../ui';

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
  /** Signed-out players still get the whole picker; versus tiles are greyed
   *  with "Sign in to play" on them, and the friends panel above carries the
   *  Sign in button (§4.2; backlog row 11). */
  signedIn: boolean;
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
  // WHY signed out is disabled now (redesign backlog row 11, Destin: "grey/
  // disable unplayable games"): it used to stay clickable so the lobby could
  // explain the gate (§4.2). The friends panel above now says exactly that, with
  // the Sign in button, so a click into a lobby that can only say "sign in" is a
  // detour. The tile still says why in words (guide: a disabled control says why).
  const disabled = game.kind === 'versus' && (!signedIn || !!status.unavailable);

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
      className={`group ${CARD_LEVEL_1} flex flex-col gap-2 p-3 text-left transition-colors hover:bg-inset disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-inset/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
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

export default function ArcadePicker({ statuses, onPick, signedIn }: Props) {
  return (
    // A label over the grid (guide "Spacing" → once one card has a label, every
    // card does — the friends panel above has "Friends"). The sign-in card that
    // sat UNDER the grid moved to the top, as the friends panel (row 11).
    <section>
      <SectionLabel className="mb-2">Games</SectionLabel>
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
    </section>
  );
}
