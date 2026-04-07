// shared/connect-four.ts
export const ROWS = 6;
export const COLS = 7;

/** Board is column-major: board[col][row], row 0 = bottom */
export type Board = number[][];

export interface DropResult {
  board: Board;
  row: number;
}

export function createBoard(): Board {
  return Array.from({ length: COLS }, () => Array(ROWS).fill(0));
}

export function cloneBoard(board: Board): Board {
  return board.map((col) => [...col]);
}

export function dropPiece(board: Board, col: number, player: number): DropResult | null {
  if (col < 0 || col >= COLS) return null;
  const column = board[col];
  const row = column.indexOf(0);
  if (row === -1) return null;
  const next = cloneBoard(board);
  next[col][row] = player;
  return { board: next, row };
}

export function checkWin(
  board: Board,
  lastMove: { col: number; row: number },
): [number, number][] | null {
  const { col, row } = lastMove;
  const player = board[col][row];
  if (player === 0) return null;

  const directions = [
    [1, 0],  // horizontal
    [0, 1],  // vertical
    [1, 1],  // diagonal ascending
    [1, -1], // diagonal descending
  ];

  for (const [dc, dr] of directions) {
    const line: [number, number][] = [[col, row]];

    for (let i = 1; i < 4; i++) {
      const c = col + dc * i;
      const r = row + dr * i;
      if (c < 0 || c >= COLS || r < 0 || r >= ROWS || board[c][r] !== player) break;
      line.push([c, r]);
    }

    for (let i = 1; i < 4; i++) {
      const c = col - dc * i;
      const r = row - dr * i;
      if (c < 0 || c >= COLS || r < 0 || r >= ROWS || board[c][r] !== player) break;
      line.push([c, r]);
    }

    if (line.length >= 4) return line;
  }

  return null;
}

export function checkDraw(board: Board): boolean {
  return board.every((col) => col.every((cell) => cell !== 0));
}

export function getValidColumns(board: Board): number[] {
  return board
    .map((col, i) => (col[ROWS - 1] === 0 ? i : -1))
    .filter((i) => i !== -1);
}
