import { describe, it, expect } from 'vitest';
import {
  createBoard,
  dropPiece,
  checkWin,
  checkDraw,
  getValidColumns,
  ROWS,
  COLS,
} from '../shared/connect-four';

describe('createBoard', () => {
  it('creates a 7x6 board filled with zeros', () => {
    const board = createBoard();
    expect(board.length).toBe(COLS); // 7 columns
    expect(board[0].length).toBe(ROWS); // 6 rows each
    expect(board.flat().every((cell) => cell === 0)).toBe(true);
  });
});

describe('dropPiece', () => {
  it('drops piece to bottom of empty column', () => {
    const board = createBoard();
    const result = dropPiece(board, 3, 1);
    expect(result).not.toBeNull();
    expect(result!.row).toBe(0);
    expect(result!.board[3][0]).toBe(1);
  });

  it('stacks pieces in same column', () => {
    let board = createBoard();
    board = dropPiece(board, 3, 1)!.board;
    const result = dropPiece(board, 3, 2);
    expect(result).not.toBeNull();
    expect(result!.row).toBe(1);
    expect(result!.board[3][1]).toBe(2);
  });

  it('returns null for full column', () => {
    let board = createBoard();
    for (let i = 0; i < ROWS; i++) {
      board = dropPiece(board, 0, i % 2 === 0 ? 1 : 2)!.board;
    }
    expect(dropPiece(board, 0, 1)).toBeNull();
  });

  it('does not mutate original board', () => {
    const board = createBoard();
    const original = JSON.stringify(board);
    dropPiece(board, 3, 1);
    expect(JSON.stringify(board)).toBe(original);
  });
});

describe('checkWin', () => {
  it('detects horizontal win', () => {
    let board = createBoard();
    for (let c = 0; c < 4; c++) {
      board = dropPiece(board, c, 1)!.board;
    }
    const result = checkWin(board, { col: 3, row: 0 });
    expect(result).not.toBeNull();
    expect(result!.length).toBe(4);
  });

  it('detects vertical win', () => {
    let board = createBoard();
    for (let i = 0; i < 4; i++) {
      board = dropPiece(board, 0, 1)!.board;
    }
    const result = checkWin(board, { col: 0, row: 3 });
    expect(result).not.toBeNull();
    expect(result!.length).toBe(4);
  });

  it('detects diagonal win (ascending)', () => {
    let board = createBoard();
    board = dropPiece(board, 0, 1)!.board;
    board = dropPiece(board, 1, 2)!.board;
    board = dropPiece(board, 1, 1)!.board;
    board = dropPiece(board, 2, 2)!.board;
    board = dropPiece(board, 2, 2)!.board;
    board = dropPiece(board, 2, 1)!.board;
    board = dropPiece(board, 3, 2)!.board;
    board = dropPiece(board, 3, 2)!.board;
    board = dropPiece(board, 3, 2)!.board;
    board = dropPiece(board, 3, 1)!.board;
    const result = checkWin(board, { col: 3, row: 3 });
    expect(result).not.toBeNull();
    expect(result!.length).toBe(4);
  });

  it('returns null when no win', () => {
    let board = createBoard();
    board = dropPiece(board, 0, 1)!.board;
    board = dropPiece(board, 1, 2)!.board;
    expect(checkWin(board, { col: 1, row: 0 })).toBeNull();
  });
});

describe('checkDraw', () => {
  it('returns false for non-full board', () => {
    expect(checkDraw(createBoard())).toBe(false);
  });

  it('returns true when board is full', () => {
    const board = createBoard();
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        board[c][r] = (c + r) % 2 === 0 ? 1 : 2;
      }
    }
    expect(checkDraw(board)).toBe(true);
  });
});

describe('getValidColumns', () => {
  it('returns all columns for empty board', () => {
    expect(getValidColumns(createBoard())).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('excludes full columns', () => {
    let board = createBoard();
    for (let i = 0; i < ROWS; i++) {
      board = dropPiece(board, 0, 1)!.board;
    }
    const valid = getValidColumns(board);
    expect(valid).not.toContain(0);
    expect(valid.length).toBe(6);
  });
});
