import { useEffect, useRef, useCallback } from 'react';
import { useGameDispatch, useGameState } from '../state/game-context';
import { PartyClient } from '../game/party-client';
import { createBoard, dropPiece, checkWin, checkDraw } from '../game/connect-four';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

/** Connect 4's two colours ARE the two seats: the room's creator plays red and
 *  sits in seat 0. Kept as one-line helpers so the translation happens in
 *  exactly one place rather than at each of the eight dispatch sites. */
const seatOf = (c: 'red' | 'yellow'): 0 | 1 => (c === 'red' ? 0 : 1);
const playOf = (
  board: number[][],
  lastMove: { col: number; row: number } | null,
  winLine: [number, number][] | null = null,
) => ({ board, lastMove, winLine });

export function usePartyGame(
  lobbyStatusUpdate: (status: 'idle' | 'in-game') => void,
  lobbyChallenge: (target: string, gameType: string, code: string) => void,
) {
  const dispatch = useGameDispatch();
  const state = useGameState();
  // In-room player tag: state.username, frozen at PARTY_CONNECTED time. It
  // already carries the account display name (spec §3) because usePresence
  // dispatches PARTY_CONNECTED with display_name ?? login. SINGLE SOURCE —
  // GameChat's `from === state.username` own-message check and the lobby
  // self-filter compare against this same value, so own-message attribution
  // holds by construction even if the profile is renamed mid-session. Do NOT
  // re-source the tag from useAccount() here without also refreshing
  // state.username, or the two would diverge on a mid-session rename.
  const playerName = state.username;
  const clientRef = useRef<PartyClient | null>(null);
  const gameCodeRef = useRef<string | null>(null);
  const myColorRef = useRef<'red' | 'yellow' | null>(null);
  const boardRef = useRef<number[][]>([]);
  const turnRef = useRef<'red' | 'yellow'>('red');
  const rematchRequestedRef = useRef(false);
  const opponentRef = useRef<string | null>(null);

  // Clean up game connection on unmount
  useEffect(() => {
    return () => {
      clientRef.current?.close();
      clientRef.current = null;
    };
  }, []);

  // Auto-cleanup game room connection when forced back to lobby
  // (e.g., CHALLENGE_FAILED, CHALLENGE_DECLINED while on waiting screen)
  useEffect(() => {
    if (state.screen === 'lobby' && clientRef.current) {
      clientRef.current.close();
      clientRef.current = null;
      gameCodeRef.current = null;
      myColorRef.current = null;
      boardRef.current = [];
      turnRef.current = 'red';
      rematchRequestedRef.current = false;
      opponentRef.current = null;
      lobbyStatusUpdate('idle');
    }
  }, [state.screen, lobbyStatusUpdate]);

  const connectToRoom = useCallback((code: string, username: string) => {
    clientRef.current?.close();

    const client = new PartyClient({
      party: 'connectfour',
      room: code,
      username,
      onMessage: (data) => {
        switch (data.type) {
          case 'player-joined': {
            if (data.username === username) break;

            // If this is a reconnection of our known opponent, don't reset the board.
            // Check opponentRef regardless of data.reconnect — the server only sets
            // reconnect:true on broadcasts to OTHER players, not on the direct send
            // to the reconnecting player itself.
            if (opponentRef.current === data.username) {
              dispatch({ type: 'OPPONENT_RECONNECTED', username: data.username });
              break;
            }

            // New opponent joining — start the game
            const board = createBoard();
            boardRef.current = board;
            turnRef.current = 'red';
            opponentRef.current = data.username;
            dispatch({
              type: 'GAME_START',
              seat: seatOf(myColorRef.current!),
              opponent: data.username,
              play: playOf(board, null),
              turnSeat: 0,
            });
            lobbyStatusUpdate('in-game');
            break;
          }

          case 'player-left': {
            if (data.username !== username) {
              dispatch({ type: 'OPPONENT_DISCONNECTED' });
            }
            break;
          }

          case 'room-full': {
            // Close the client to prevent partysocket auto-reconnect loop
            clientRef.current?.close();
            clientRef.current = null;
            dispatch({ type: 'ROOM_FULL' });
            break;
          }

          case 'move': {
            if (data.username === username) break;
            const playerNum = turnRef.current === 'red' ? 1 : 2;
            const result = dropPiece(boardRef.current, data.column, playerNum);
            if (!result) break;

            boardRef.current = result.board;
            const winLine = checkWin(result.board, { col: data.column, row: result.row });
            const isDraw = !winLine && checkDraw(result.board);
            const nextTurn = turnRef.current === 'red' ? 'yellow' : 'red';
            turnRef.current = nextTurn;

            // The winner is whoever just MOVED, which is the turn before this one.
            const moverSeat = seatOf(nextTurn === 'red' ? 'yellow' : 'red');
            const lm = { col: data.column, row: result.row };
            if (winLine) {
              dispatch({
                type: 'GAME_STATE',
                play: playOf(result.board, lm, winLine as [number, number][]),
                turnSeat: seatOf(nextTurn),
                outcome: { winnerSeat: moverSeat },
              });
            } else if (isDraw) {
              dispatch({
                type: 'GAME_STATE',
                play: playOf(result.board, lm),
                turnSeat: seatOf(nextTurn),
                outcome: { draw: true },
              });
            } else {
              dispatch({
                type: 'GAME_STATE',
                play: playOf(result.board, lm),
                turnSeat: seatOf(nextTurn),
              });
            }
            break;
          }

          case 'chat': {
            if (data.username !== username) {
              dispatch({ type: 'CHAT_MESSAGE', from: data.username, text: data.text });
            }
            break;
          }

          case 'rematch': {
            if (rematchRequestedRef.current) {
              // Both players agreed — start new game
              const board = createBoard();
              boardRef.current = board;
              myColorRef.current = myColorRef.current === 'red' ? 'yellow' : 'red';
              turnRef.current = 'red';
              rematchRequestedRef.current = false;
              dispatch({
                type: 'GAME_START',
                seat: seatOf(myColorRef.current),
                opponent: data.username,
                play: playOf(board, null),
                turnSeat: 0,
              });
            } else {
              // Opponent wants a rematch; we haven't agreed yet. WHY a separate action:
              // REMATCH_REQUESTED means "we asked" and would disable our Accept button.
              dispatch({ type: 'OPPONENT_REMATCH_REQUESTED' });
            }
            break;
          }
        }
      },
    });

    clientRef.current = client;
    gameCodeRef.current = code;
  }, [dispatch, lobbyStatusUpdate]);

  // createGame (manual room creation for the old Create Game button) was
  // removed 2026-07-09 along with the room-code UI — challengePlayer below is
  // the only room-creating path now, and it generates its own code.
  // `gameId` is accepted and ignored HERE because this hook is Connect 4's own
  // client — it exists so the shell can call one signature for every game
  // (§3.1). Chess brings its own client and its own room; the arcade shell
  // picks between them by the id the challenge carried.
  const joinGame = useCallback((code: string, _gameId: string) => {
    if (!playerName) return;
    myColorRef.current = 'yellow';
    rematchRequestedRef.current = false;
    opponentRef.current = null;
    dispatch({ type: 'JOINING_GAME', code });
    connectToRoom(code, playerName);
  }, [playerName, dispatch, connectToRoom]);

  // The shell hands moves through as `unknown` so one interface serves every
  // game (§3.1). Connect 4's move IS a column, so it narrows here — at the
  // game's own boundary, which is the only place that knows the shape.
  const makeMove = useCallback((move: unknown) => {
    const column = move as number;
    if (!clientRef.current || !playerName) return;
    const playerNum = turnRef.current === 'red' ? 1 : 2;
    const result = dropPiece(boardRef.current, column, playerNum);
    if (!result) return;

    boardRef.current = result.board;
    const winLine = checkWin(result.board, { col: column, row: result.row });
    const isDraw = !winLine && checkDraw(result.board);
    const mover = turnRef.current;
    const nextTurn = mover === 'red' ? 'yellow' : 'red';
    turnRef.current = nextTurn;

    clientRef.current.send({ type: 'move', username: playerName, column });

    const lm = { col: column, row: result.row };
    if (winLine) {
      dispatch({
        type: 'GAME_STATE',
        play: playOf(result.board, lm, winLine as [number, number][]),
        turnSeat: seatOf(nextTurn),
        outcome: { winnerSeat: seatOf(mover) },
      });
    } else if (isDraw) {
      dispatch({
        type: 'GAME_STATE',
        play: playOf(result.board, lm),
        turnSeat: seatOf(nextTurn),
        outcome: { draw: true },
      });
    } else {
      dispatch({
        type: 'GAME_STATE',
        play: playOf(result.board, lm),
        turnSeat: seatOf(nextTurn),
      });
    }
  }, [playerName, dispatch]);

  const sendChat = useCallback((text: string) => {
    if (!clientRef.current || !playerName) return;
    clientRef.current.send({ type: 'chat', username: playerName, text });
    dispatch({ type: 'CHAT_MESSAGE', from: playerName, text });
  }, [playerName, dispatch]);

  const requestRematch = useCallback(() => {
    if (!clientRef.current || !playerName) return;
    clientRef.current.send({ type: 'rematch', username: playerName });
    if (state.opponentWantsRematch && opponentRef.current) {
      // The opponent asked first and is already waiting, so our message is the "yes" on
      // their side. WHY start here too: the relay only forwards to the OTHER player, so
      // we never hear our own message; without this the accepter would sit waiting.
      const board = createBoard();
      boardRef.current = board;
      myColorRef.current = myColorRef.current === 'red' ? 'yellow' : 'red';
      turnRef.current = 'red';
      dispatch({
        type: 'GAME_START',
        seat: seatOf(myColorRef.current),
        opponent: opponentRef.current,
        play: playOf(board, null),
        turnSeat: 0,
      });
      return;
    }
    rematchRequestedRef.current = true;
    dispatch({ type: 'REMATCH_REQUESTED' });
  }, [playerName, dispatch, state.opponentWantsRematch]);

  const leaveGame = useCallback(() => {
    if (clientRef.current && playerName) {
      clientRef.current.send({ type: 'leave', username: playerName });
      clientRef.current.close();
      clientRef.current = null;
    }
    gameCodeRef.current = null;
    myColorRef.current = null;
    boardRef.current = [];
    turnRef.current = 'red';
    rematchRequestedRef.current = false;
    opponentRef.current = null;
    lobbyStatusUpdate('idle');
  }, [playerName, lobbyStatusUpdate]);

  // target is the challenged player's ACCOUNT ID (spec §3) — forwarded verbatim
  // to the presence layer via lobbyChallenge; the room itself still uses our
  // display-name tag.
  // Room codes REMAIN the internal capability token for PartyKit rooms — this
  // generates one and sends it with the challenge; the recipient's Accept joins
  // by it. Only the manual create/join-by-code UI was removed (2026-07-09,
  // Destin: friends/handles cover the real use case).
  const challengePlayer = useCallback((target: string, gameId: string) => {
    if (!playerName) return;
    const code = generateCode();
    myColorRef.current = 'red';
    rematchRequestedRef.current = false;
    opponentRef.current = null;
    // `target` IS the opponent's account id (the lobby row's id). Carrying it
    // into state here is the CHALLENGER's half of learning who they are
    // playing — the game room only ever tags people by display name, which
    // is not an identity a permanent record can be filed against.
    dispatch({ type: 'ROOM_CREATED', code, seat: 0, opponentId: target });
    connectToRoom(code, playerName);
    // The challenge now carries WHICH game, instead of the hardcoded
    // 'connect-four' that made every challenge a Connect 4 challenge (§3.1).
    lobbyChallenge(target, gameId, code);
  }, [playerName, dispatch, connectToRoom, lobbyChallenge]);

  return { joinGame, makeMove, sendChat, requestRematch, leaveGame, challengePlayer };
}
