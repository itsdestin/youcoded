import React from 'react';
import { useGameState, useGameDispatch } from '../../state/game-context';
import { GameConnection } from '../../state/game-types';

interface Props {
  connection: GameConnection;
}

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
    <div className="absolute inset-0 bg-canvas/80 backdrop-blur-sm flex flex-col items-center justify-center gap-4 z-10 rounded-sm">
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
    </div>
  );
}
