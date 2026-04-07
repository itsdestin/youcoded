import React, { useState } from 'react';
import { useGameState, useGameDispatch } from '../../state/game-context';
import { GameConnection } from '../../state/game-types';

const COLS = 7;
const ROWS = 6;

interface Props {
  connection: GameConnection;
}

function cellValue(board: number[][], col: number, row: number): number {
  // board[col][row], row 0 = bottom of the visual board
  if (!board[col]) return 0;
  return board[col][row] ?? 0;
}

function isWinCell(winLine: [number, number][] | null, col: number, row: number): boolean {
  if (!winLine) return false;
  return winLine.some(([c, r]) => c === col && r === row);
}

export default function ConnectFourBoard({ connection }: Props) {
  const state = useGameState();
  const dispatch = useGameDispatch();
  const [hoveredCol, setHoveredCol] = useState<number | null>(null);

  const isMyTurn = state.myColor !== null && state.turn === state.myColor;
  const isPlaying = state.screen === 'playing';
  const canMove = isMyTurn && isPlaying && !state.opponentDisconnected;

  const handleColClick = (col: number) => {
    if (!canMove) return;
    connection.makeMove(col);
  };

  // Ghost piece: find the lowest empty row in the hovered column
  const getGhostRow = (col: number): number | null => {
    if (!canMove || hoveredCol !== col || !state.board[col]) return null;
    for (let row = 0; row < ROWS; row++) {
      if (!state.board[col][row]) return row;
    }
    return null; // column full
  };

  return (
    <div className="flex flex-col gap-2 p-3">
      {/* Disconnect banner */}
      {state.opponentDisconnected && (
        <div className="bg-red-900/30 border border-red-800/50 rounded-lg px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
            <span className="text-xs text-red-300 flex-1">Opponent disconnected — waiting for reconnection...</span>
          </div>
          <button
            onClick={() => { connection.leaveGame(); dispatch({ type: 'RETURN_TO_LOBBY' }); }}
            className="mt-2 w-full text-xs text-fg-dim hover:text-fg bg-inset rounded-lg py-1.5 transition-colors"
          >
            Leave Game
          </button>
        </div>
      )}

      {/* Turn indicator */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5">
          <span className={`w-3 h-3 rounded-full ${state.myColor === 'red' ? 'bg-red-500' : 'bg-yellow-400'}`} />
          <span className="text-fg-dim">You{state.myColor ? ` (${state.myColor})` : ''}</span>
        </div>
        <div className={`text-xs font-medium px-2 py-0.5 rounded-full ${
          canMove
            ? 'bg-inset/50 text-fg-2'
            : 'bg-inset text-fg-muted'
        }`}>
          {isPlaying ? (canMove ? 'Your turn' : `${state.turn}'s turn`) : ''}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-fg-dim">{state.opponent ?? 'Opponent'}</span>
          <span className={`w-3 h-3 rounded-full ${state.myColor === 'red' ? 'bg-yellow-400' : 'bg-red-500'}`} />
        </div>
      </div>

      {/* Board */}
      <div
        className="bg-blue-700 rounded-lg p-2 select-none"
        onMouseLeave={() => setHoveredCol(null)}
      >
        <div className="flex gap-1">
          {Array.from({ length: COLS }, (_, col) => {
            const isHovered = hoveredCol === col;
            const ghostRow = getGhostRow(col);

            return (
              <div
                key={col}
                className={`flex flex-col gap-1 rounded-sm cursor-pointer transition-colors ${
                  canMove && isHovered ? 'bg-blue-600/50' : ''
                }`}
                onMouseEnter={() => setHoveredCol(col)}
                onClick={() => handleColClick(col)}
              >
                {/* Render rows top-down visually (ROWS-1 down to 0 in data) */}
                {Array.from({ length: ROWS }, (_, visualRow) => {
                  const dataRow = ROWS - 1 - visualRow;
                  const value = cellValue(state.board, col, dataRow);
                  const isWin = isWinCell(state.winLine, col, dataRow);
                  const isGhost = ghostRow === dataRow;

                  let cellClass = 'w-9 h-9 rounded-full transition-all ';
                  if (isWin) {
                    cellClass += value === 1
                      ? 'bg-red-600 ring-2 ring-white animate-pulse'
                      : 'bg-yellow-500 ring-2 ring-white animate-pulse';
                  } else if (value === 1) {
                    cellClass += 'bg-red-600';
                  } else if (value === 2) {
                    cellClass += 'bg-yellow-500';
                  } else if (isGhost) {
                    cellClass += state.myColor === 'red'
                      ? 'bg-red-600/40'
                      : 'bg-yellow-500/40';
                  } else {
                    cellClass += 'bg-panel';
                  }

                  return <div key={dataRow} className={cellClass} />;
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
