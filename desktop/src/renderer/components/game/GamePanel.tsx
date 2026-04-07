import React from 'react';
import { useGameState, useGameDispatch } from '../../state/game-context';
import GameLobby from './GameLobby';
import ConnectFourBoard from './ConnectFourBoard';
import GameChat from './GameChat';
import GameOverlay from './GameOverlay';
import { GameConnection } from '../../state/game-types';

interface Props {
  connection: GameConnection;
  incognito?: boolean;
  onToggleIncognito?: () => void;
}

export default function GamePanel({ connection, incognito, onToggleIncognito }: Props) {
  const state = useGameState();
  const dispatch = useGameDispatch();
  const isPlaying = state.screen === 'playing' || state.screen === 'game-over';

  return (
    <div className="w-80 bg-panel border-l border-edge flex flex-col h-full shrink-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-edge">
        <span className="text-sm font-semibold text-fg">Connect 4</span>
        <button
          onClick={() => {
            if (state.screen !== 'lobby' && state.screen !== 'setup') {
              connection.leaveGame();
              dispatch({ type: 'RETURN_TO_LOBBY' });
            }
            dispatch({ type: 'TOGGLE_PANEL' });
          }}
          className="text-fg-muted hover:text-fg-2 transition-colors"
        >
          ✕
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto flex flex-col">
        {isPlaying ? (
          <div className="relative flex flex-col flex-1">
            <ConnectFourBoard connection={connection} />
            <GameChat connection={connection} />
            {state.screen === 'game-over' && (
              <GameOverlay connection={connection} />
            )}
          </div>
        ) : (
          <GameLobby connection={connection} incognito={incognito} onToggleIncognito={onToggleIncognito} />
        )}
      </div>
    </div>
  );
}
