import React, { createContext, useContext, useReducer, Dispatch } from 'react';
import { GameState, GameAction, createInitialGameState } from './game-types';
import { gameReducer } from './game-reducer';

const GameStateContext = createContext<GameState>(createInitialGameState());
const GameDispatchContext = createContext<Dispatch<GameAction>>(() => {});

export function GameProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(gameReducer, createInitialGameState());
  return React.createElement(
    GameStateContext.Provider,
    { value: state },
    React.createElement(GameDispatchContext.Provider, { value: dispatch }, children),
  );
}

export function useGameState(): GameState {
  return useContext(GameStateContext);
}

export function useGameDispatch(): Dispatch<GameAction> {
  return useContext(GameDispatchContext);
}
