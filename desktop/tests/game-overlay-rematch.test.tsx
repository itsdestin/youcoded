// @vitest-environment jsdom
// B-6: the game-over button must read "Accept rematch" and stay pressable when the
// opponent asked first; it greys out only after WE ask.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import React, { useEffect } from 'react';
import { GameProvider, useGameDispatch } from '../src/renderer/state/game-context';
import type { GameAction } from '../src/renderer/state/game-types';
import GameOverlay from '../src/renderer/components/game/GameOverlay';

afterEach(cleanup);

function Driver({ actions }: { actions: GameAction[] }) {
  const dispatch = useGameDispatch();
  useEffect(() => { actions.forEach(dispatch); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function setup(actions: GameAction[]) {
  const requestRematch = vi.fn();
  render(
    <GameProvider>
      <Driver actions={actions} />
      <GameOverlay connection={{ requestRematch, leaveGame: vi.fn() } as never} />
    </GameProvider>,
  );
  return requestRematch;
}

describe('GameOverlay rematch button', () => {
  it('plain state: "Rematch", enabled', () => {
    setup([]);
    expect((screen.getByText('Rematch').closest('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('opponent asked first: "Accept rematch", enabled, and pressing it calls requestRematch', () => {
    const requestRematch = setup([{ type: 'OPPONENT_REMATCH_REQUESTED' }]);
    const btn = screen.getByText('Accept rematch').closest('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(requestRematch).toHaveBeenCalledTimes(1);
  });

  it('we asked: "Rematch requested", disabled', () => {
    setup([{ type: 'REMATCH_REQUESTED' }]);
    expect((screen.getByText('Rematch requested').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
