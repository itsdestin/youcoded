// Chess's own module (spec §3.1, §5.3).
//
// WHY THIS FILE EXISTS AT ALL, rather than a `ChessPlay` field on the shared
// game state: the shell must never learn what a board is. `GameState.play` is
// `unknown` on purpose, and each game narrows it inside its OWN module. Connect
// 4 does the same in `connect-four.ts`; the ast-grep rule
// arcade-state-play-only-in-own-board fails the build if a shell file starts
// reading into it.
//
// WHY chess.js AND NOT HAND-WRITTEN RULES (spec §5.3): castling, en passant,
// promotion, check, stalemate, threefold repetition and the fifty-move rule are
// a solved problem, and a chess player finds an illegal-move bug in one game.
// The version is pinned exact in package.json so an upgrade is a decision, not
// a `npm install` side effect.

import { Chess } from 'chess.js';
import type { Color, Square } from 'chess.js';
import type { Seat, GameOutcome } from '../state/game-types';

/** What a promoting pawn may become. Chess.js spells these as single letters. */
export type PromotionPiece = 'q' | 'r' | 'b' | 'n';

/** A chess move on the wire and at the `GameConnection.makeMove` boundary.
 *  Squares are algebraic ('e2', 'e4'); `promotion` is REQUIRED when the move
 *  promotes a pawn — chess.js rejects a promoting move without it rather than
 *  silently assuming a queen, which is why the board has to ask. */
export interface ChessMove {
  from: string;
  to: string;
  promotion?: PromotionPiece;
}

/** Why a finished game finished. Kept as a reason rather than a boolean so the
 *  board can say "Stalemate" instead of the useless "Draw". */
export type ChessEndReason =
  | 'checkmate'
  | 'stalemate'
  | 'insufficient-material'
  | 'threefold-repetition'
  | 'fifty-move';

/** CHESS'S OWN STATE — what rides in `GameState.play` while a chess game is
 *  open. The FEN is the whole position (pieces, side to move, castling rights,
 *  en-passant target, halfmove clock), so this one string is enough for either
 *  client to rebuild the board from scratch after a reconnect. */
export interface ChessPlay {
  /** Forsyth–Edwards Notation: the complete position in one string. */
  fen: string;
  /** The move that produced this position, for the from/to highlight. */
  lastMove: { from: string; to: string } | null;
  /** Square of the king that is in check, or null. The one place a board uses
   *  `--destructive` (§5.5). */
  checkSquare: string | null;
  /** Null while the game is still running. */
  over: { reason: ChessEndReason; winner: Color | null } | null;
}

/** One piece on the board, keyed by its square. */
export interface PlacedPiece {
  type: 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
  color: Color;
}

// ── Seats ───────────────────────────────────────────────────────────────────
// Seat 0 is whoever created the room (the challenger), exactly as in Connect 4.
// White moves first, so seat 0 plays white. Kept as two one-line helpers so the
// translation happens in one place instead of at every dispatch site.

export const colorForSeat = (seat: Seat): Color => (seat === 0 ? 'w' : 'b');
export const seatForColor = (color: Color): Seat => (color === 'w' ? 0 : 1);

// ── Reading a position ──────────────────────────────────────────────────────

/** Build a chess.js game from a FEN, or null if the FEN is unusable. Returns
 *  null rather than throwing because BOTH callers are handling untrusted input
 *  (a socket message, or state that survived a reload) and a throw here would
 *  take the whole renderer down with it. */
export function load(fen: string): Chess | null {
  try {
    return new Chess(fen);
  } catch {
    return null;
  }
}

/** The opening position, before either player has moved. */
export function startingPlay(): ChessPlay {
  return describePosition(new Chess(), null);
}

/** Turn a live chess.js game into the plain, serialisable state the reducer
 *  stores. Everything the board renders comes from here — the board itself
 *  never calls a chess.js method that mutates. */
export function describePosition(
  game: Chess,
  lastMove: { from: string; to: string } | null,
): ChessPlay {
  const inCheck = game.isCheck();
  return {
    fen: game.fen(),
    lastMove,
    checkSquare: inCheck ? kingSquare(game, game.turn()) : null,
    over: endReason(game),
  };
}

/** Where a colour's king is standing. Only used to paint the check square. */
export function kingSquare(game: Chess, color: Color): string | null {
  for (const row of game.board()) {
    for (const cell of row) {
      if (cell && cell.type === 'k' && cell.color === color) return cell.square;
    }
  }
  return null;
}

function endReason(game: Chess): ChessPlay['over'] {
  if (game.isCheckmate()) {
    // `turn()` is the side that has just been mated, so the winner is the other.
    return { reason: 'checkmate', winner: game.turn() === 'w' ? 'b' : 'w' };
  }
  if (game.isStalemate()) return { reason: 'stalemate', winner: null };
  if (game.isInsufficientMaterial()) return { reason: 'insufficient-material', winner: null };
  if (game.isThreefoldRepetition()) return { reason: 'threefold-repetition', winner: null };
  if (game.isDrawByFiftyMoves()) return { reason: 'fifty-move', winner: null };
  return null;
}

/** Every piece on the board, keyed by square — what the component renders. */
export function readPosition(fen: string): Record<string, PlacedPiece> {
  const game = load(fen);
  if (!game) return {};
  const out: Record<string, PlacedPiece> = {};
  for (const row of game.board()) {
    for (const cell of row) {
      if (cell) out[cell.square] = { type: cell.type, color: cell.color };
    }
  }
  return out;
}

/** Whose turn it is, as a seat the shell understands. */
export function turnSeatOf(play: ChessPlay): Seat {
  const game = load(play.fen);
  return seatForColor(game ? game.turn() : 'w');
}

/** How the shell records the ending (spec §3's `outcomeOf`). Null while the
 *  game is still running. */
export function outcomeOf(play: ChessPlay): GameOutcome | null {
  if (!play.over) return null;
  if (play.over.winner) return { winnerSeat: seatForColor(play.over.winner) };
  return { draw: true };
}

// ── Making a move ───────────────────────────────────────────────────────────

/** Squares the piece on `from` may legally move to. Empty when the square holds
 *  nothing, holds the wrong colour, or the piece is pinned. */
export function legalTargets(fen: string, from: string): string[] {
  const game = load(fen);
  if (!game) return [];
  try {
    return game.moves({ square: from as Square, verbose: true }).map((m) => m.to);
  } catch {
    // chess.js throws on a malformed square name rather than returning [].
    return [];
  }
}

/** Would moving from→to promote a pawn? The board has to know BEFORE it sends,
 *  because chess.js rejects a promoting move that does not name the piece. */
export function isPromotion(fen: string, from: string, to: string): boolean {
  const game = load(fen);
  if (!game) return false;
  try {
    return game
      .moves({ square: from as Square, verbose: true })
      .some((m) => m.to === to && m.isPromotion());
  } catch {
    return false;
  }
}

/** THE VALIDATOR. Applies a move to a position and returns the resulting state,
 *  or **null if the move is illegal**.
 *
 *  Both clients run this on every move — the one they make and the one that
 *  arrives over the socket. The PartyKit room is a relay (`chess-room.ts`), so
 *  a peer sending a bogus move must be rejected here or it corrupts the board.
 *  Never trust the wire. */
export function applyMove(
  fen: string,
  move: ChessMove,
): { play: ChessPlay; san: string } | null {
  const game = load(fen);
  if (!game) return null;
  if (typeof move?.from !== 'string' || typeof move?.to !== 'string') return null;
  try {
    const made = game.move({ from: move.from, to: move.to, promotion: move.promotion });
    return {
      play: describePosition(game, { from: made.from, to: made.to }),
      san: made.san,
    };
  } catch {
    // chess.js throws "Invalid move" for anything not in the legal move list —
    // wrong turn, wrong colour, pinned piece, missing promotion piece.
    return null;
  }
}
