import { useState } from 'react';
import { useGameState, useGameDispatch } from '../../state/game-context';
import { GameConnection } from '../../state/game-types';
import type { ConnectFourPlay } from '../../game/connect-four';
import { Button, Pill, StatusStrip } from '../ui';

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

  // The state split (§3.1): the shell holds only your SEAT, whose turn it is,
  // and the outcome. Connect 4's own board lives in `state.play`, which the
  // shell treats as opaque — this narrowing is the one place that knows the
  // shape, and it is inside Connect 4's own component where it belongs.
  const play = (state.play ?? { board: [], lastMove: null, winLine: null }) as ConnectFourPlay;

  const isMyTurn = state.seat !== null && state.turnSeat === state.seat;
  const isPlaying = state.screen === 'playing';
  const canMove = isMyTurn && isPlaying && !state.opponentDisconnected;

  // The board stores 1 for seat 0's discs and 2 for seat 1's, so your own
  // discs are `seat + 1`. Hoisted out of the cell loop because the
  // screen-reader commentary below needs it too, to say whether the last
  // disc was yours or theirs.
  const mine = (state.seat ?? 0) + 1;

  const handleColClick = (col: number) => {
    if (!canMove) return;
    connection.makeMove(col);
  };

  // The row a disc dropped into this column would land in, or null if the
  // column is full (or the board has not arrived yet). One helper, because
  // the ghost disc, the tab-stop gating and the column's spoken name all
  // need the same answer.
  const landingRow = (col: number): number | null => {
    const column = play.board[col];
    if (!column) return null;
    for (let row = 0; row < ROWS; row++) {
      if (!column[row]) return row;
    }
    return null; // column full
  };

  const filledCount = (col: number): number => {
    const column = play.board[col];
    if (!column) return 0;
    let n = 0;
    for (let row = 0; row < ROWS; row++) if (column[row]) n++;
    return n;
  };

  // Ghost piece: shown for the column under the pointer OR the one holding
  // keyboard focus — focus is the keyboard's hover, so a player who tabs
  // along the columns gets the same "it lands here" preview a mouse gives.
  const getGhostRow = (col: number): number | null => {
    if (!canMove || hoveredCol !== col) return null;
    return landingRow(col);
  };

  // What assistive tech reads for a column. Occupancy is the fact a player
  // who cannot see the board actually needs to choose a move.
  const columnLabel = (col: number): string => {
    const filled = filledCount(col);
    const full = landingRow(col) === null;
    const occupancy = full ? 'full' : `${filled} of ${ROWS} filled`;
    return canMove && !full
      ? `Column ${col + 1}, ${occupancy}, drop here`
      : `Column ${col + 1}, ${occupancy}`;
  };

  // Running commentary for screen readers: who just moved where, and whose
  // turn it is now. Reading the disc at lastMove tells us whose it was
  // without the shell having to track a mover seat.
  const lastMoveText = play.lastMove
    ? `${cellValue(play.board, play.lastMove.col, play.lastMove.row) === mine ? 'You' : state.opponent ?? 'Opponent'} dropped in column ${play.lastMove.col + 1}. `
    : '';
  const commentary = !isPlaying
    ? ''
    : `${lastMoveText}${canMove ? 'Your turn.' : `${state.opponent ?? 'Opponent'}'s turn.`}`;

  return (
    <div className="flex flex-col gap-2 p-3">
      {/* Disconnect banner. Retheme (§5.4): was a hand-rolled red box
          (`bg-red-900/30` + `border-red-800/50` + `text-red-300`) — three raw
          Tailwind colours that are identical in every theme, and design rule 6
          says a waiting state is not a red box anyway. <StatusStrip busy> is
          the primitive for "what is this doing right now, plus the one action
          that resolves it", which is exactly this. */}
      {state.opponentDisconnected && (
        <StatusStrip
          tone="busy"
          detail="They have a moment to come back before the game is called."
          action={
            // WHY outlined, not ghost (decisions "Secondary buttons": a less-important action is
            // outlined, never bare text; the other StatusStrip actions — LocalModelDownloadStrip's
            // "Resume download", OfficeAlerts' "Open Office" — are secondary).
            <Button
              variant="secondary"
              size="sm"
              onClick={() => { connection.leaveGame(); dispatch({ type: 'RETURN_TO_LOBBY' }); }}
            >
              Leave
            </Button>
          }
        >
          {state.opponent ?? 'Your opponent'} dropped out — waiting for them to reconnect
        </StatusStrip>
      )}

      {/* Turn indicator */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5">
          {/* Retheme (spec §5.4/§5.5): YOU are the accent, your opponent is the
              neutral foreground — the same rule as chat, the chess board and the
              leaderboard. The old `red`/`yellow` was identical in all 11 themes,
              and naming the colour in the label ("You (red)") only worked while
              the discs really were red. */}
          <span className="w-3 h-3 rounded-full bg-accent" />
          <span className="text-fg-dim">You</span>
        </div>
        {/* WHY the shared Pill (decisions "Status labels"; "Control shape follows the theme" — no
            hand-set rounded-full on a hand-made chip): the turn is a status, the one tinted pill.
            Neutral either way — the words say whose turn it is. Drawn only during play: the old
            chip was an empty box before it. */}
        {isPlaying ? <Pill>{canMove ? 'Your turn' : `${state.opponent ?? 'Opponent'}'s turn`}</Pill> : <span />}
        <div className="flex items-center gap-1.5">
          <span className="text-fg-dim">{state.opponent ?? 'Opponent'}</span>
          <span className="w-3 h-3 rounded-full bg-fg-muted" />
        </div>
      </div>

      {/* Board. `w-full` + a 7:6 aspect ratio means it fills whatever width
          the pane is dragged to and stays the right shape, instead of the old
          fixed 36px cells that left the board marooned in the middle of the
          pane (Destin, G-7: "it just sits in the panel funny"). */}
      <div
        className="bg-inset border border-edge rounded-lg p-2 select-none w-full"
        onMouseLeave={() => setHoveredCol(null)}
      >
        <div className="flex gap-1 w-full" style={{ aspectRatio: `${COLS} / ${ROWS}` }}>
          {Array.from({ length: COLS }, (_, col) => {
            const isHovered = hoveredCol === col;
            const ghostRow = getGhostRow(col);

            // Only a column you could actually drop into takes a tab stop, the
            // same rule ChessBoard uses for its squares — seven dead stops on
            // the opponent's turn would bury the rest of the pane. The button
            // is never `disabled`, because a disabled button cannot be focused
            // and so cannot be read at all; handleColClick already refuses.
            const playable = canMove && landingRow(col) !== null;

            return (
              <button
                key={col}
                type="button"
                // A real button, so the board is playable from the keyboard —
                // Tab to a column, Enter or Space to drop. Chess in this same
                // panel has always worked this way; Connect 4's columns were
                // plain divs with mouse handlers only.
                tabIndex={playable ? 0 : -1}
                aria-label={columnLabel(col)}
                // Lets the review rig play a real game to its end — without a
                // stable hook the end-of-match card (and the head-to-head line
                // on it) can only be reached by clicking blind coordinates.
                data-col={col}
                // `p-0 border-0` undoes the browser's button chrome. The
                // background is a SINGLE conditional class, never two `bg-*`
                // utilities on one element — those do not blend, one just wins
                // (the same trap ChessBoard documents on its square shading).
                className={`flex-1 min-w-0 flex flex-col gap-1 rounded-sm p-0 border-0 transition-colors ${
                  playable ? 'cursor-pointer' : 'cursor-default'
                } ${canMove && isHovered ? 'bg-accent/15' : 'bg-transparent'}`}
                onMouseEnter={() => setHoveredCol(col)}
                // Focus is the keyboard's hover: tabbing onto a column shows
                // the same ghost disc the pointer does, so a sighted keyboard
                // player can see where the piece would land.
                onFocus={() => setHoveredCol(col)}
                onBlur={() => setHoveredCol(null)}
                onClick={() => handleColClick(col)}
              >
                {/* Render rows top-down visually (ROWS-1 down to 0 in data) */}
                {Array.from({ length: ROWS }, (_, visualRow) => {
                  const dataRow = ROWS - 1 - visualRow;
                  const value = cellValue(play.board, col, dataRow);
                  const isWin = isWinCell(play.winLine, col, dataRow);
                  const isGhost = ghostRow === dataRow;

                  // Discs are OWNERSHIP, not colour: `mine` is whichever seat
                  // this player holds, so both players see their own pieces in
                  // the accent — exactly how chat renders "you" on both ends of
                  // a conversation. `ring-white` went with the blue board: a
                  // literal white ring is invisible on the light themes, so the
                  // win line rings in the accent instead.
                  // `flex-1` + `aspect-square`: the disc takes its size from
                  // the column, which takes its size from the pane.
                  let cellClass = 'flex-1 min-h-0 aspect-square rounded-full transition-all ';
                  if (isWin) {
                    cellClass += value === mine
                      ? 'bg-accent ring-2 ring-accent/50 animate-pulse'
                      : 'bg-fg-muted ring-2 ring-fg-muted/50 animate-pulse';
                  } else if (value === mine) {
                    cellClass += 'bg-accent';
                  } else if (value !== 0) {
                    cellClass += 'bg-fg-muted';
                  } else if (isGhost) {
                    cellClass += 'bg-accent/35';
                  } else {
                    // An empty hole must read as a HOLE — the surface behind the
                    // board showing through — so it takes `canvas` against an
                    // `inset` frame. The first pass had inset holes in a well
                    // frame, one step apart on the depth ladder, and the holes
                    // were nearly invisible in the dark themes.
                    cellClass += 'bg-canvas';
                  }

                  return <div key={dataRow} className={cellClass} aria-hidden="true" />;
                })}
              </button>
            );
          })}
        </div>
      </div>

      {/* Screen-reader running commentary, the same primitive 2048 and Flappy
          use. Polite, and only the facts a player who cannot see the board
          needs between moves: what the last drop was, and whose turn it is. */}
      <span className="sr-only" role="status" aria-live="polite">
        {commentary}
      </span>
    </div>
  );
}
