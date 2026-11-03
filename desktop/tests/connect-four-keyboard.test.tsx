// @vitest-environment jsdom
// desktop/tests/connect-four-keyboard.test.tsx
//
// Connect 4's columns were plain <div>s with mouse handlers only, so the game
// could not be played without a mouse and assistive tech had no name for a
// column — while chess in the same arcade panel renders every square as a
// labelled <button>. These cases pin the keyboard route so it cannot quietly
// regress to divs again.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createInitialGameState } from '../src/renderer/state/game-types';
import type { GameState, GameConnection } from '../src/renderer/state/game-types';

// The provider owns its reducer, so the only way to render a specific board is
// to serve the state directly.
let gameState: GameState = createInitialGameState();
vi.mock('../src/renderer/state/game-context', () => ({
  useGameState: () => gameState,
  useGameDispatch: () => vi.fn(),
}));

const ConnectFourBoard = (await import('../src/renderer/components/game/ConnectFourBoard')).default;

const COLS = 7;
const ROWS = 6;

/** An empty 7x6 board in the engine's [col][row] shape, row 0 = bottom. */
function emptyBoard(): number[][] {
  return Array.from({ length: COLS }, () => Array.from({ length: ROWS }, () => 0));
}

function makeConnection(): GameConnection {
  return {
    joinGame: vi.fn(),
    makeMove: vi.fn(),
    sendChat: vi.fn(),
    leaveGame: vi.fn(),
  } as unknown as GameConnection;
}

/** A live match where `turnSeat` decides whether it is your move. */
function playing(overrides: Partial<GameState> = {}): GameState {
  return {
    ...createInitialGameState(),
    screen: 'playing',
    seat: 0,
    turnSeat: 0,
    opponent: 'Mira',
    play: { board: emptyBoard(), lastMove: null, winLine: null },
    ...overrides,
  } as GameState;
}

function columns(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[data-col]'));
}

let connection: GameConnection;

beforeEach(() => { connection = makeConnection(); });
afterEach(() => { cleanup(); gameState = createInitialGameState(); });

describe('a column is something you can reach without a mouse', () => {
  it('renders every column as a real button, not a div', () => {
    gameState = playing();
    render(<ConnectFourBoard connection={connection} />);

    const cols = columns();
    expect(cols).toHaveLength(COLS);
    // The tag IS the keyboard route: a <button> gets Enter/Space activation and
    // a tab stop from the platform. A div gets neither, whatever we hang on it.
    for (const c of cols) expect(c.tagName).toBe('BUTTON');
  });

  it('gives every column a spoken name that includes how full it is', () => {
    const board = emptyBoard();
    board[2][0] = 1;
    board[2][1] = 2;
    gameState = playing({ play: { board, lastMove: null, winLine: null } });
    render(<ConnectFourBoard connection={connection} />);

    // Columns are named 1-7 for a player, not 0-6 like the array.
    expect(screen.getByLabelText(/Column 1\b.*\b0 of 6\b/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Column 3\b.*\b2 of 6\b/)).toBeInTheDocument();
  });

  it('drops a disc when the column is activated', () => {
    gameState = playing();
    render(<ConnectFourBoard connection={connection} />);

    fireEvent.click(columns()[4]);

    expect(connection.makeMove).toHaveBeenCalledWith(4);
  });
});

describe('only a column you could actually play takes a tab stop', () => {
  it('makes every open column focusable on your turn', () => {
    gameState = playing();
    render(<ConnectFourBoard connection={connection} />);

    for (const c of columns()) expect(c).toHaveAttribute('tabindex', '0');
  });

  it('takes them all out of the tab order on the opponent turn', () => {
    // Seven dead stops between the pane's other controls is worse than none.
    gameState = playing({ turnSeat: 1 });
    render(<ConnectFourBoard connection={connection} />);

    for (const c of columns()) expect(c).toHaveAttribute('tabindex', '-1');
  });

  it('skips a full column and says so', () => {
    const board = emptyBoard();
    for (let row = 0; row < ROWS; row++) board[3][row] = 1;
    gameState = playing({ play: { board, lastMove: null, winLine: null } });
    render(<ConnectFourBoard connection={connection} />);

    const full = columns()[3];
    expect(full).toHaveAttribute('tabindex', '-1');
    expect(full).toHaveAttribute('aria-label', 'Column 4, full');
  });

  it('refuses the move even if a stale click reaches a column off-turn', () => {
    gameState = playing({ turnSeat: 1 });
    render(<ConnectFourBoard connection={connection} />);

    fireEvent.click(columns()[0]);

    expect(connection.makeMove).not.toHaveBeenCalled();
  });
});

describe('the keyboard gets the same preview the mouse does', () => {
  it('shows the ghost disc on focus, and clears it on blur', () => {
    gameState = playing();
    render(<ConnectFourBoard connection={connection} />);

    const col = columns()[1];
    // The ghost is the only translucent-accent disc on the board.
    const ghosts = () => document.querySelectorAll('.bg-accent\\/35');

    expect(ghosts()).toHaveLength(0);
    fireEvent.focus(col);
    expect(ghosts()).toHaveLength(1);
    fireEvent.blur(col);
    expect(ghosts()).toHaveLength(0);
  });
});

describe('the board narrates itself', () => {
  it('announces whose turn it is', () => {
    gameState = playing();
    render(<ConnectFourBoard connection={connection} />);

    expect(screen.getByRole('status')).toHaveTextContent('Your turn.');
  });

  it('names who dropped the last disc and where', () => {
    const board = emptyBoard();
    board[5][0] = 2; // seat 1's disc — the opponent's, since we hold seat 0
    gameState = playing({
      turnSeat: 0,
      play: { board, lastMove: { col: 5, row: 0 }, winLine: null },
    });
    render(<ConnectFourBoard connection={connection} />);

    expect(screen.getByRole('status'))
      .toHaveTextContent(/Mira.*column 6.*your turn/i);
  });

  it('stays quiet before the match starts', () => {
    gameState = playing({ screen: 'lobby' });
    render(<ConnectFourBoard connection={connection} />);

    expect(screen.getByRole('status')).toHaveTextContent('');
  });
});
