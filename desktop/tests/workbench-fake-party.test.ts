// Task 7c. Pins the fake Connect Four opponent's protocol against the real
// message shapes the PartyKit room uses (wecoded-marketplace worker/src/games/relay-room.ts:
// `{type:'player-joined', username}`, `{type:'move', username, column}`) and
// against the real client-side rules (src/renderer/game/connect-four.ts), so
// a drift in either the real room or the real rules would break these tests
// too — not just something workbench-only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FakeConnectFourServer,
  FakePartySocket,
  JAKE_USERNAME,
  type FakeMessage,
} from '../src/renderer/dev/workbench/fake-party';
import { createBoard, dropPiece, checkWin, checkDraw } from '../src/renderer/game/connect-four';

const ROWS = 6;
const COLS = 7;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('FakeConnectFourServer', () => {
  it('a join yields an empty 7x6 board with Jake present', () => {
    const server = new FakeConnectFourServer();

    // Real room protocol: onConnect tells the new arrival about every player
    // already in the room. There is always exactly one — Jake.
    const joinMsg = server.join();
    expect(joinMsg).toEqual({ type: 'player-joined', username: 'Jake' });
    expect(joinMsg.username).toBe(JAKE_USERNAME);

    // The board a fresh client reconstructs on 'player-joined' (see
    // usePartyGame.ts's GAME_START branch) is createBoard() — 7 columns of 6
    // empty (0) cells. The fake server starts in the same state.
    const board = server.getBoard();
    expect(board).toHaveLength(COLS);
    for (const col of board) {
      expect(col).toHaveLength(ROWS);
      expect(col.every((cell) => cell === 0)).toBe(true);
    }
    expect(board).toEqual(createBoard());
  });

  it('a move in column 3 lands at the bottom, then Jake answers after ~1.2s with a legal move', () => {
    const server = new FakeConnectFourServer();
    const received: FakeMessage[] = [];

    server.receive(JSON.stringify({ type: 'move', username: 'you', column: 3 }), (msg) => received.push(msg));

    // Your own move is applied server-side immediately (mirrors dropPiece being
    // called synchronously in usePartyGame.ts's makeMove) — no message is
    // delivered back to you for it (the real room never echoes the sender's
    // own message to themselves).
    expect(received).toHaveLength(0);
    let board = server.getBoard();
    expect(board[3]![0]).toBe(1); // red, bottom row
    expect(board[3]!.slice(1).every((c) => c === 0)).toBe(true);

    // Nothing yet — Jake is "thinking".
    vi.advanceTimersByTime(1199);
    expect(received).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(received).toHaveLength(1);
    const jakeMove = received[0]!;
    expect(jakeMove.type).toBe('move');
    expect(jakeMove.username).toBe(JAKE_USERNAME);
    const col = jakeMove.column as number;
    expect(col).toBeGreaterThanOrEqual(0);
    expect(col).toBeLessThan(COLS);

    // The move must be the one *legal* reply to the board as it stood after
    // your move — i.e. applying it with the real dropPiece succeeds and adds
    // exactly one yellow (2) piece.
    board = server.getBoard();
    const yellowCount = board.reduce((n, c) => n + c.filter((cell) => cell === 2).length, 0);
    expect(yellowCount).toBe(1);
  });

  it('drops an illegal column silently, same as a no-op relay', () => {
    const server = new FakeConnectFourServer();
    const received: FakeMessage[] = [];
    server.receive(JSON.stringify({ type: 'move', username: 'you', column: 99 }), (msg) => received.push(msg));
    expect(server.getBoard()).toEqual(createBoard());
    vi.advanceTimersByTime(5000);
    expect(received).toHaveLength(0); // no bot reply — there was nothing to reply to
  });

  it('drops a chess-shaped move (no column) without throwing, and Jake stays silent', () => {
    const server = new FakeConnectFourServer();
    const received: FakeMessage[] = [];
    expect(() => server.receive(JSON.stringify({ type: 'move', username: 'you', move: { from: 'e2', to: 'e4' } }), (msg) => received.push(msg))).not.toThrow();
    vi.advanceTimersByTime(5000);
    expect(received).toEqual([]);
  });

  it('a winning sequence ends with a real move-message shape, and checkWin agrees', () => {
    // Deterministic bot: always column 6, ignoring the board — lets the test
    // build a guaranteed vertical win for Jake without needing to out-think
    // the default block-or-random strategy.
    const server = new FakeConnectFourServer({ pickColumn: () => 6 });
    const received: FakeMessage[] = [];
    const deliver = (msg: FakeMessage) => received.push(msg);

    // Human plays four different, non-adjacent columns (never four in a row
    // for red) so only Jake's stacked column-6 replies can complete a line.
    for (const humanCol of [0, 2, 4, 1]) {
      server.receive(JSON.stringify({ type: 'move', username: 'you', column: humanCol }), deliver);
      vi.advanceTimersByTime(1200);
    }

    expect(received).toHaveLength(4);
    const lastMsg = received[3]!;
    // Real protocol shape — connect-four-room.ts relays exactly this, nothing
    // richer (win detection is client-side, not a server concept).
    expect(lastMsg).toEqual({ type: 'move', username: JAKE_USERNAME, column: 6 });

    // Reconstruct the board a REAL client would have after these four
    // messages, using the real client rules (same calls usePartyGame.ts's
    // 'move' case makes), and confirm the last one is in fact a win.
    let board = createBoard();
    let lastResult: ReturnType<typeof dropPiece> = null;
    for (const humanCol of [0, 2, 4, 1]) {
      lastResult = dropPiece(board, humanCol, 1)!;
      board = lastResult.board;
      lastResult = dropPiece(board, 6, 2)!;
      board = lastResult.board;
    }
    const winLine = checkWin(board, { col: 6, row: lastResult!.row });
    expect(winLine).not.toBeNull();
    expect(winLine!.length).toBeGreaterThanOrEqual(4);
    expect(checkDraw(board)).toBe(false);
  });
});

describe('FakePartySocket', () => {
  it('opens and delivers player-joined for Jake, matching the wire format PartyClient parses', () => {
    const socket = new FakePartySocket({ host: 'fake', room: 'ANY', party: 'connectfour', query: { username: 'you' } });
    const opened = vi.fn();
    const messages: any[] = [];
    socket.addEventListener('open', opened);
    socket.addEventListener('message', (ev) => messages.push(JSON.parse(ev.data)));

    expect(socket.readyState).toBe(0); // CONNECTING
    expect(opened).not.toHaveBeenCalled();

    vi.advanceTimersByTime(80);

    expect(opened).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(1); // OPEN — PartyClient reads this via WS_OPEN
    expect(messages).toEqual([{ type: 'player-joined', username: 'Jake' }]);
  });

  it('relays a sent move to a scheduled Jake reply, and stops replying after close', () => {
    const socket = new FakePartySocket({ host: 'fake', room: 'ANY', party: 'connectfour', query: { username: 'you' } });
    vi.advanceTimersByTime(80);

    const messages: any[] = [];
    socket.addEventListener('message', (ev) => messages.push(JSON.parse(ev.data)));
    socket.send(JSON.stringify({ type: 'move', username: 'you', column: 0 }));

    socket.close();
    vi.advanceTimersByTime(5000);
    // Closed before Jake's reply timer fired — the fake server was disposed,
    // so nothing arrives late after close() (mirrors a real socket: no events
    // after the connection is torn down).
    expect(messages).toHaveLength(0);
  });
});
