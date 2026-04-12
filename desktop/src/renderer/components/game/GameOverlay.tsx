import React from 'react';
import { useGameState, useGameDispatch } from '../../state/game-context';
import { GameConnection } from '../../state/game-types';
import { OverlayPanel } from '../overlays/Overlay';

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

  const { winner, myColor } = state;

  let headline = 'Draw!';
  let headlineClass = 'text-fg';

  if (winner && winner !== 'draw') {
    if (winner === myColor) {
      headline = 'You Win!';
      headlineClass = winner === 'red' ? 'text-red-400' : 'text-yellow-400';
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
          {winner && winner !== 'draw' && (
            <span className="text-xs text-fg-muted">
              {winner === myColor ? 'Congratulations!' : 'Better luck next time'}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-2 w-40">
          <button
            onClick={() => { if (!state.rematchRequested) connection.requestRematch(); }}
            disabled={state.rematchRequested}
            className="w-full bg-accent hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed text-on-accent text-sm font-medium rounded-lg py-2 transition-colors"
          >
            {state.rematchRequested ? 'Rematch Requested' : 'Rematch'}
          </button>
          <button
            onClick={() => { connection.leaveGame(); dispatch({ type: 'RETURN_TO_LOBBY' }); }}
            className="w-full bg-inset hover:bg-edge text-fg-2 text-sm font-medium rounded-lg py-2 transition-colors"
          >
            Back to Lobby
          </button>
        </div>
      </OverlayPanel>
    </div>
  );
}
