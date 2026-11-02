// Chess's own PartyKit client (spec §3.1, §5.3).
//
// It returns the SAME shape `usePartyGame` returns, so the arcade shell calls
// one signature for every game and picks the client by the id the challenge
// carried. Chess brings its own room, its own party ('chess',
// the Worker's CHESS room) and its own move shape; nothing here is shared with Connect 4
// except the socket wrapper and the reducer actions.
//
// TRUST MODEL. The chess room (worker/src/games/relay-room.ts) is a RELAY — it forwards messages between the
// two players and knows no rules. So every move that arrives over the socket is
// re-validated here with chess.js (`applyMove`) and DROPPED if it is illegal,
// rather than being applied to the board. A peer cannot corrupt this client's
// position by sending a bogus move.

import { useEffect, useRef, useCallback } from 'react';
import { useGameDispatch, useGameState } from '../state/game-context';
import { PartyClient } from '../game/party-client';
import {
  applyMove,
  outcomeOf,
  startingPlay,
  turnSeatOf,
  type ChessMove,
  type ChessPlay,
} from '../game/chess';
import type { Seat } from '../state/game-types';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

/** A move message off the wire, before it is trusted. Shaped, not validated —
 *  `applyMove` is what decides whether it is a legal chess move. */
function readWireMove(value: unknown): ChessMove | null {
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Partial<ChessMove>;
  if (typeof m.from !== 'string' || typeof m.to !== 'string') return null;
  const promotion = m.promotion;
  if (promotion !== undefined && !['q', 'r', 'b', 'n'].includes(promotion)) return null;
  return { from: m.from, to: m.to, ...(promotion ? { promotion } : {}) };
}

export function useChessGame(
  lobbyStatusUpdate: (status: 'idle' | 'in-game') => void,
  lobbyChallenge: (target: string, gameType: string, code: string) => void,
) {
  const dispatch = useGameDispatch();
  const state = useGameState();
  // Same single source as Connect 4: the in-room tag is state.username, frozen
  // at PARTY_CONNECTED time, so GameChat's own-message check keeps matching.
  const playerName = state.username;
  const clientRef = useRef<PartyClient | null>(null);
  const gameCodeRef = useRef<string | null>(null);
  const seatRef = useRef<Seat | null>(null);
  /** The authoritative local position. Everything else is derived from it. */
  const playRef = useRef<ChessPlay | null>(null);
  const rematchRequestedRef = useRef(false);
  const opponentRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      clientRef.current?.close();
      clientRef.current = null;
    };
  }, []);

  // Forced back to the lobby (challenge declined/failed while waiting) — drop
  // the room socket so partysocket does not keep retrying a dead game.
  useEffect(() => {
    if (state.screen === 'lobby' && clientRef.current) {
      clientRef.current.close();
      clientRef.current = null;
      gameCodeRef.current = null;
      seatRef.current = null;
      playRef.current = null;
      rematchRequestedRef.current = false;
      opponentRef.current = null;
      lobbyStatusUpdate('idle');
    }
  }, [state.screen, lobbyStatusUpdate]);

  const connectToRoom = useCallback((code: string, username: string) => {
    clientRef.current?.close();

    /** One dispatch site for "the position changed", so the outcome and the
     *  turn are derived the same way whoever made the move. */
    function commit(play: ChessPlay) {
      playRef.current = play;
      const outcome = outcomeOf(play);
      dispatch({
        type: 'GAME_STATE',
        play,
        turnSeat: turnSeatOf(play),
        ...(outcome ? { outcome } : {}),
      });
    }

    const client = new PartyClient({
      party: 'chess',
      room: code,
      username,
      onMessage: (data) => {
        switch (data.type) {
          case 'player-joined': {
            if (data.username === username) break;

            // A reconnection of the opponent we already had must NOT reset the
            // position — the server only marks `reconnect` on broadcasts to the
            // OTHER player, so opponentRef is the reliable test (same reasoning
            // as Connect 4).
            if (opponentRef.current === data.username) {
              dispatch({ type: 'OPPONENT_RECONNECTED', username: data.username });
              break;
            }

            const play = startingPlay();
            playRef.current = play;
            opponentRef.current = data.username;
            dispatch({
              type: 'GAME_START',
              seat: seatRef.current ?? 0,
              opponent: data.username,
              play,
              turnSeat: 0, // White moves first, and seat 0 plays white.
            });
            lobbyStatusUpdate('in-game');
            break;
          }

          case 'player-left': {
            if (data.username !== username) dispatch({ type: 'OPPONENT_DISCONNECTED' });
            break;
          }

          case 'room-full': {
            clientRef.current?.close();
            clientRef.current = null;
            dispatch({ type: 'ROOM_FULL' });
            break;
          }

          case 'move': {
            if (data.username === username) break;
            const current = playRef.current;
            if (!current) break;
            const move = readWireMove(data.move);
            if (!move) break;
            // THE WIRE IS NOT TRUSTED. An illegal move is ignored outright —
            // the board keeps the position it had rather than taking on the
            // sender's version of reality.
            const next = applyMove(current.fen, move);
            if (!next) break;
            commit(next.play);
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
              // Both agreed. Sides swap, exactly as they do over the board.
              const play = startingPlay();
              playRef.current = play;
              seatRef.current = seatRef.current === 0 ? 1 : 0;
              rematchRequestedRef.current = false;
              dispatch({
                type: 'GAME_START',
                seat: seatRef.current,
                opponent: data.username,
                play,
                turnSeat: 0,
              });
            } else {
              dispatch({ type: 'REMATCH_REQUESTED' });
            }
            break;
          }
        }
      },
    });

    clientRef.current = client;
    gameCodeRef.current = code;
  }, [dispatch, lobbyStatusUpdate]);

  /** `gameId` is accepted and ignored: this hook IS chess's client. The
   *  argument exists so the shell can call one signature for every game. */
  const joinGame = useCallback((code: string, _gameId: string) => {
    if (!playerName) return;
    seatRef.current = 1; // The joiner takes seat 1 and plays black.
    rematchRequestedRef.current = false;
    opponentRef.current = null;
    playRef.current = null;
    dispatch({ type: 'JOINING_GAME', code });
    connectToRoom(code, playerName);
  }, [playerName, dispatch, connectToRoom]);

  // The shell forwards moves as `unknown` so one interface serves every game
  // (§3.1). Chess's move is a from/to pair, so it narrows here — inside chess's
  // own client, the only place that knows the shape.
  const makeMove = useCallback((move: unknown) => {
    const wanted = readWireMove(move);
    const current = playRef.current;
    if (!wanted || !current || !clientRef.current || !playerName) return;
    // Validate our OWN move too. The board should never offer an illegal one,
    // but if it does, this is what stops the two clients drifting apart.
    const next = applyMove(current.fen, wanted);
    if (!next) return;

    playRef.current = next.play;
    clientRef.current.send({ type: 'move', username: playerName, move: wanted });
    const outcome = outcomeOf(next.play);
    dispatch({
      type: 'GAME_STATE',
      play: next.play,
      turnSeat: turnSeatOf(next.play),
      ...(outcome ? { outcome } : {}),
    });
  }, [playerName, dispatch]);

  const sendChat = useCallback((text: string) => {
    if (!clientRef.current || !playerName) return;
    clientRef.current.send({ type: 'chat', username: playerName, text });
    dispatch({ type: 'CHAT_MESSAGE', from: playerName, text });
  }, [playerName, dispatch]);

  const requestRematch = useCallback(() => {
    if (!clientRef.current || !playerName) return;
    rematchRequestedRef.current = true;
    clientRef.current.send({ type: 'rematch', username: playerName });
    dispatch({ type: 'REMATCH_REQUESTED' });
  }, [playerName, dispatch]);

  const leaveGame = useCallback(() => {
    if (clientRef.current && playerName) {
      clientRef.current.send({ type: 'leave', username: playerName });
      clientRef.current.close();
      clientRef.current = null;
    }
    gameCodeRef.current = null;
    seatRef.current = null;
    playRef.current = null;
    rematchRequestedRef.current = false;
    opponentRef.current = null;
    lobbyStatusUpdate('idle');
  }, [playerName, lobbyStatusUpdate]);

  /** `target` is the challenged player's ACCOUNT ID (spec §3). The room code is
   *  the capability token for the PartyKit room — generated here, sent with the
   *  challenge, consumed by the accepting client's `joinGame`. */
  const challengePlayer = useCallback((target: string, gameId: string) => {
    if (!playerName) return;
    const code = generateCode();
    seatRef.current = 0; // The challenger creates the room and plays white.
    rematchRequestedRef.current = false;
    opponentRef.current = null;
    playRef.current = null;
    // `target` IS the opponent's account id (the lobby row's id). Carrying it
    // into state here is the CHALLENGER's half of learning who they are
    // playing — the game room only ever tags people by display name, which
    // is not an identity a permanent record can be filed against.
    dispatch({ type: 'ROOM_CREATED', code, seat: 0, opponentId: target });
    connectToRoom(code, playerName);
    lobbyChallenge(target, gameId, code);
  }, [playerName, dispatch, connectToRoom, lobbyChallenge]);

  return { joinGame, makeMove, sendChat, requestRematch, leaveGame, challengePlayer };
}
