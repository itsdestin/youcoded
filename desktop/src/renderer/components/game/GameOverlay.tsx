import { useGameState, useGameDispatch } from '../../state/game-context';
import { GameConnection } from '../../state/game-types';
import { OverlayPanel } from '../overlays/Overlay';
import { Button } from '../ui';
import { recordSentence } from './head-to-head';

interface Props {
  connection: GameConnection;
}

// End-of-game overlay. Renders as a small centered card so the final board
// stays visible around it — player should still see the winning line and
// piece layout while deciding Rematch vs. Back to Lobby. Glassmorphism
// refactor (see GLASSMORPHISM-REFACTOR-PLAN.md § GameOverlay) replaced the
// old full-screen scrim with this trimmed centered layer-surface card.
export default function GameOverlay({ connection }: Props) {
  const state = useGameState();
  const dispatch = useGameDispatch();

  // The split (§3.1): the shell records an OUTCOME, not a winning colour, so
  // this reads the same for chess, Connect 4 and anything after them.
  const { outcome, seat } = state;
  const youWon = outcome != null && 'winnerSeat' in outcome && outcome.winnerSeat === seat;
  const draw = outcome != null && 'draw' in outcome;

  let headline = 'Draw!';
  let headlineClass = 'text-fg';

  if (outcome && !draw) {
    if (youWon) {
      headline = 'You Win!';
      // WHY the normal text colour (guide principle 2; decisions "Status colours out of
      // words, app-wide", small-fixes-3#SF3-10): colour never goes in words, and the accent
      // headline was coloured text. The words already say who won; "You Lose!" keeps its
      // dimmer weight so the two still read differently.
      headlineClass = 'text-fg';
    } else {
      headline = 'You Lose!';
      headlineClass = 'text-fg-dim';
    }
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
      <OverlayPanel
        layer={2}
        className="flex flex-col items-center gap-4 px-6 py-5 pointer-events-auto"
      >
        <div className="flex flex-col items-center gap-1">
          <span className={`text-3xl font-black ${headlineClass}`}>{headline}</span>
          {outcome && !draw && (
            <span className="text-xs text-fg-muted">
              {youWon ? 'Congratulations!' : 'Better luck next time'}
            </span>
          )}
          {/* The running record, once the SERVER has settled it (§6.2). It is
              absent until both players have independently reported the same
              result, so this line appears a moment after the headline — and
              never at all if the two disagree. Showing a provisional number
              here and correcting it later would be worse than showing none:
              this is a fact about someone else, and it should appear once,
              already true. */}
          {state.record && (
            <span className="text-xs text-fg-2 pt-1">
              {recordSentence(state.record, state.opponent)}
            </span>
          )}
        </div>

        {/* WHY w-full, not a fixed w-40 column (guide Buttons; decisions "Button arrangement
            by width" + "Single button": stacked buttons in a narrow surface span its full
            width, filled on top). */}
        <div className="flex flex-col gap-2 w-full">
          {/* Rematch is the main action here, so it's the shared `primary` button.
              The old hand-rolled classes had `hover:bg-accent` on top of a
              `bg-accent` base — i.e. the hover did nothing. The primitive fades
              the fill on hover, so this button now actually responds to the cursor. */}
          <Button
            variant="primary"
            size="lg"
            onClick={() => { if (!state.rematchRequested) connection.requestRematch(); }}
            disabled={state.rematchRequested}
            className="w-full"
          >
            {/* Sentence case (decisions "Feature names in Title Case" → sentence case). */}
            {state.rematchRequested ? 'Rematch requested' : 'Rematch'}
          </Button>
          {/* Filled-grey (`bg-inset`) was a second, unofficial secondary style —
              it collapses into the primitive's outlined `secondary`. */}
          <Button
            variant="secondary"
            size="lg"
            onClick={() => { connection.leaveGame(); dispatch({ type: 'RETURN_TO_LOBBY' }); }}
            className="w-full"
          >
            Back to lobby
          </Button>
        </div>
      </OverlayPanel>
    </div>
  );
}
