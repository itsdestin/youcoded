// The end of a solo run (Destin, 2026-08-31: "single-player/high-score games
// should have a clear end/failure screen with a retry button").
//
// WHY THIS IS SHARED AND NOT PER-GAME: Flappy and 2048 had each grown their own
// end overlay, and they had already drifted — Flappy celebrated a new best,
// 2048 silently did not, so the same achievement was worth a badge in one game
// and nothing in the other. G-1 (one primitive, one look) exists for exactly
// this. Every solo game added later gets the same ending for free, and the
// answer to "what happens when you lose" stops being per-game folklore.
//
// The card is deliberately about the SCORE, not the failure. "No moves left" is
// a subtitle; the number you got is the headline, because that is the thing a
// high-score game is asking you to beat.

import { prefersTouchInput } from '../../utils/touch-input';
import { Button, Pill } from '../ui';

interface Props {
  /** Why the run ended, in the game's own words — "You hit a pipe", "No moves
   *  left". One short sentence; the score below is the real headline. */
  reason: string;
  /** The run's score, already formatted by the game (§3: "31 pipes", "12,480"). */
  score: string;
  /** True when this run beat the player's previous best. */
  isBest: boolean;
  /** Their standing best, formatted, when this run did NOT beat it. Showing the
   *  target is what makes "again" tempting rather than aimless. */
  best?: string;
  onRetry: () => void;
  /** Back to the games shelf. Optional so a game can omit it. */
  onExit?: () => void;
  /** How to retry without the mouse, e.g. "Space". Rendered under the button —
   *  a keyboard game whose retry is mouse-only breaks its own contract. */
  retryKeyHint?: string;
}

export default function RunOverCard({
  reason, score, isBest, best, onRetry, onExit, retryKeyHint,
}: Props) {
  return (
    // Covers the playfield rather than replacing it: the board you just lost on
    // stays visible behind, which is the difference between "here is your
    // result" and "that never happened".
    <div className="absolute inset-0 rounded-lg flex flex-col items-center justify-center gap-1 px-4 bg-canvas/85">
      <span className="text-2xs text-fg-muted">{reason}</span>

      {/* The score is the headline. Tabular figures so it does not jiggle
          between runs of different digit widths. */}
      <span className="text-2xl font-semibold text-fg tabular-nums leading-tight">{score}</span>

      {isBest ? (
        // WHY the shared Pill, not a solid accent block (guide "Status and notices"; decisions
        // "Status labels": a status is a small tinted pill, words in the normal text colour).
        // `info` is the accent-tinted tone, the nearest to the old accent fill.
        <Pill tone="info">New best</Pill>
      ) : best ? (
        // Not a scolding — a target. "Your best is 31" is why you press again.
        <span className="text-2xs text-fg-muted">Your best: {best}</span>
      ) : null}

      {/* G-4: one primary per view. Retry is it; leaving is secondary. */}
      {/* WHY Back to games first, Play again last (decisions "Button arrangement by width":
          side by side, the filled button on the right, the outlined one directly left of it). */}
      <div className="flex items-center gap-2 pt-2">
        {onExit && (
          <Button variant="secondary" size="sm" onClick={onExit}>Back to games</Button>
        )}
        <Button variant="primary" size="sm" onClick={onRetry}>Play again</Button>
      </div>

      {/* WHY: no keyboard on a phone — "or press Space" would be noise there. */}
      {retryKeyHint && !prefersTouchInput() && (
        <span className="text-3xs text-fg-muted pt-1">or press {retryKeyHint}</span>
      )}
    </div>
  );
}
