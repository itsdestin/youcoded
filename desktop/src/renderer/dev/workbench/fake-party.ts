// fake-party.ts — Task 7c. Workbench-only stand-in for the Connect
// Four room (wecoded-marketplace worker/src/games/relay-room.ts), so the game is playable in a
// browser tab with no socket, no server, and no Destin-facing network call.
//
// WHY this exists: the real client (party-client.ts) wraps `partysocket`,
// which tries to open a real WebSocket to api.youcoded.ai.
// The workbench never opens sockets (see dev-workbench design spec §2), so the
// panel sat on "Connecting…" forever. This file speaks the SAME wire protocol
// the real room does — `{type:'player-joined', username}` and
// `{type:'move', username, column}` — so the real client code in
// usePartyGame.ts (dropPiece/checkWin/checkDraw from ../../game/connect-four)
// runs completely unmodified against a fake opponent, "Jake".
//
// Two layers:
//   1. FakeConnectFourServer — tracks the board, decides Jake's replies. Pure
//      logic, no socket shape, easy to unit test directly.
//   2. FakePartySocket — the thing actually injected in place of `PartySocket`
//      via party-client.ts's __setPartySocketFactory (see install-mock.ts).
//      Implements just the subset of the PartySocket surface party-client.ts
//      touches: addEventListener/removeEventListener, send, close, readyState.

import { createBoard, dropPiece, checkWin, checkDraw, type Board } from '../../game/connect-four';

export const JAKE_USERNAME = 'Jake';
// Stable id for Jake's presence card — used by mock-shim.ts's `social` fake so
// the SAME "Jake" appears as a friend, an online user, and the Connect Four
// opponent (one scripted character, not three unrelated fixtures).
export const JAKE_ID = 'jake';

// ~1.2s "thinking" delay before Jake answers a move, per the task brief — long
// enough to read as a real opponent, short enough that a filmed clip doesn't
// drag.
const BOT_MOVE_DELAY_MS = 1200;
// Simulated socket-open latency — the panel should still show a brief, real
// "Connecting…" flash rather than resolving on the same tick (same reasoning
// as mock-shim's DEFAULT_LATENCY_MS: a 0ms mock hides loading-state bugs).
const OPEN_DELAY_MS = 80;

const RED = 1;   // player 1 — always the human here (see FakePartySocket note)
const YELLOW = 2; // player 2 — Jake

export type BotPicker = (board: Board, botPlayer: number, humanPlayer: number) => number;

/** Default bot strategy ("block-or-random", as the task brief suggests):
 *  take an immediate win if one exists, else block the human's immediate win,
 *  else play a random legal column. Deliberately only one move of lookahead —
 *  this is meant to be a fun, fair, occasionally-beatable opponent for a demo
 *  reel, not a solver. */
export function defaultPickColumn(board: Board, botPlayer: number, humanPlayer: number): number {
  const legalCols = board.reduce<number[]>((acc, col, i) => {
    if (col.some((cell) => cell === 0)) acc.push(i);
    return acc;
  }, []);

  const winningMove = (player: number): number | null => {
    for (const c of legalCols) {
      const result = dropPiece(board, c, player);
      if (result && checkWin(result.board, { col: c, row: result.row })) return c;
    }
    return null;
  };

  return winningMove(botPlayer) ?? winningMove(humanPlayer) ?? legalCols[Math.floor(Math.random() * legalCols.length)]!;
}

/** `?bot=passive` — an opponent that never blocks and never wins: it always
 *  drops into the rightmost legal column.
 *
 *  WHY IT EXISTS: the default bot picks randomly when it has no immediate win
 *  or block, so no fixed sequence of clicks can reliably finish a game. That
 *  made the END of a match — the result card, and now the head-to-head record
 *  on it — impossible for the review rig to reach, which meant those states
 *  could only ever be reviewed by hand. With this, four clicks in one column
 *  wins every time. Workbench-only, read from the URL, never a shipped setting. */
export function passivePickColumn(board: Board): number {
  for (let c = board.length - 1; c >= 0; c--) if (board[c]!.some((cell) => cell === 0)) return c;
  return 0;
}

export function workbenchBotPicker(): BotPicker | undefined {
  if (typeof location === 'undefined') return undefined;
  return new URLSearchParams(location.search).get('bot') === 'passive'
    ? passivePickColumn
    : undefined;
}

export interface FakeMessage {
  type: string;
  [key: string]: unknown;
}

/** Tracks one Connect Four game against Jake. Board state mirrors exactly what
 *  BOTH real clients would independently compute from the moves exchanged —
 *  this class never invents a message shape the real room doesn't use. */
export class FakeConnectFourServer {
  private board: Board = createBoard();
  private ended = false;
  private pickColumn: BotPicker;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts?: { pickColumn?: BotPicker }) {
    this.pickColumn = opts?.pickColumn ?? defaultPickColumn;
  }

  /** What a client sees the instant it "connects" — the real ConnectFourRoom
   *  tells a new arrival about every player already in the room
   *  (connect-four-room.ts onConnect). Jake is always already there. */
  join(): FakeMessage {
    return { type: 'player-joined', username: JAKE_USERNAME };
  }

  getBoard(): Board {
    return this.board;
  }

  /** Process a message the human sent. `deliver` is called (once, after the
   *  bot's think delay) with Jake's reply — never synchronously, and never for
   *  the human's own move, matching the real room's `broadcast(msg, [sender])`
   *  which never echoes the sender's own message back to them. */
  receive(raw: string, deliver: (msg: FakeMessage) => void): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg?.type !== 'move' || this.ended) return;
    // WHY (2026-09-03, promo film): the chess client sends through this same
    // fake socket, and its move is a `{move:{from,to}}` pair with no `column`.
    // dropPiece(board, undefined) threw inside the client's send(), which sat
    // BEFORE useChessGame's local dispatch — so the pawn never moved on screen.
    // A move this server does not understand is dropped, like the illegal
    // column below; Jake simply never answers a chess move.
    if (!Number.isInteger(msg.column)) return;

    const result = dropPiece(this.board, msg.column, RED);
    if (!result) return; // illegal column (full or out of range) — drop it, same as a no-op relay
    this.board = result.board;

    const winLine = checkWin(this.board, { col: msg.column, row: result.row });
    const draw = !winLine && checkDraw(this.board);
    if (winLine || draw) {
      // Game over on the human's own move — nothing for Jake to answer, same
      // as a real opponent who has stopped playing.
      this.ended = true;
      return;
    }

    this.timer = setTimeout(() => {
      const col = this.pickColumn(this.board, YELLOW, RED);
      const botResult = dropPiece(this.board, col, YELLOW);
      if (!botResult) { this.ended = true; return; }
      this.board = botResult.board;
      const botWin = checkWin(this.board, { col, row: botResult.row });
      const botDraw = !botWin && checkDraw(this.board);
      if (botWin || botDraw) this.ended = true;
      deliver({ type: 'move', username: JAKE_USERNAME, column: col });
    }, BOT_MOVE_DELAY_MS);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

// --- FakePartySocket ---------------------------------------------------------
// The minimal shape party-client.ts actually calls on a PartySocket instance.
// Kept structural (not `implements PartySocket`) because the real class pulls
// in `partysocket`'s ReconnectingWebSocket internals we have no reason to fake.
export interface PartySocketLike {
  addEventListener(type: string, cb: (ev: any) => void): void;
  removeEventListener?(type: string, cb: (ev: any) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
}

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSED = 3;

/** Constructor shape party-client.ts passes: `{ host, room, party, query }`.
 *  Only `query.username` matters here — everything else is real-server plumbing
 *  the fake has no use for (there's exactly one room: the one Jake is in). */
export interface FakePartySocketOptions {
  host?: string;
  room?: string;
  party?: string;
  query?: Record<string, string | undefined | null>;
}

export class FakePartySocket implements PartySocketLike {
  readyState = WS_CONNECTING;
  private listeners: Record<string, Set<(ev: any) => void>> = {
    open: new Set(), message: new Set(), close: new Set(), error: new Set(),
  };
  private server: FakeConnectFourServer;
  private openTimer: ReturnType<typeof setTimeout> | null;

  constructor(_options: FakePartySocketOptions, serverOverride?: FakeConnectFourServer) {
    this.server = serverOverride ?? new FakeConnectFourServer({ pickColumn: workbenchBotPicker() });
    this.openTimer = setTimeout(() => {
      this.openTimer = null;
      this.readyState = WS_OPEN;
      this.emit('open', {});
      // Jake is already "in the room" the moment the socket opens — real
      // ConnectFourRoom.onConnect sends this to every arriving player.
      this.emit('message', { data: JSON.stringify(this.server.join()) });
    }, OPEN_DELAY_MS);
  }

  addEventListener(type: string, cb: (ev: any) => void): void {
    this.listeners[type]?.add(cb);
  }

  removeEventListener(type: string, cb: (ev: any) => void): void {
    this.listeners[type]?.delete(cb);
  }

  private emit(type: string, ev: any): void {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }

  send(data: string): void {
    if (this.readyState !== WS_OPEN) return;
    this.server.receive(data, (msg) => this.emit('message', { data: JSON.stringify(msg) }));
  }

  close(code = 1000, reason = ''): void {
    if (this.openTimer) { clearTimeout(this.openTimer); this.openTimer = null; }
    this.server.dispose();
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    this.emit('close', { code, reason });
  }
}

// --- Shared "is this the fake-Connect-Four workbench" gate ------------------
// Checked by both install-mock.ts (whether to inject FakePartySocket at all)
// and GameLobby.tsx (whether to auto-start a game instead of waiting for a
// real friend to challenge). `__workbenchStore` only exists after
// install-mock.ts's installMock() has run — it is never set in the shipped
// Electron/Android app, so this can never be true outside the workbench.
export function isWorkbenchAutoplay(): boolean {
  if (!isWorkbenchFakeParty()) return false;
  // `?autoplay=0` OPTS OUT. Autoplay exists so the landing-page film has a live
  // board within a second of opening the panel — but it fires the moment
  // presence connects, which made the LOBBY (the friend list, the Challenge
  // buttons, and now each friend's head-to-head record) unreachable in the
  // workbench for any signed-in session. A surface nobody can screenshot is a
  // surface nobody reviews.
  return new URLSearchParams(location.search).get('autoplay') !== '0';
}

// WHY a second gate (2026-09-03, promo film): install-mock.ts used to inject the
// fake Connect Four socket only when autoplay was on, so `?autoplay=0` reached
// the lobby but its Challenge button then went down the REAL PartySocket path —
// a production WebSocket from a workbench tab, and never a board. The promo's
// lobby scene clicks that button and needs Jake to answer. The fake socket now
// follows `?signedIn=1` alone; autoplay only decides whether the lobby is
// skipped. Signed-out stays byte-for-byte what it was.
export function isWorkbenchFakeParty(): boolean {
  if (typeof window === 'undefined' || !(window as any).__workbenchStore) return false;
  if (typeof location === 'undefined') return false;
  // Same switch mock-shim.ts's `account` fake uses (`?signedIn=1`) — keeps a
  // signed-out workbench byte-for-byte identical to before this task.
  return new URLSearchParams(location.search).get('signedIn') === '1';
}
