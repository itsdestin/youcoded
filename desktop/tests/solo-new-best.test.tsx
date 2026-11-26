// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// A finished 2048 board with 500 points, so the end-of-run card shows at once.
vi.mock('../src/renderer/components/game/twenty-forty-eight', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/renderer/components/game/twenty-forty-eight')>();
  return { ...real, createGame: (rng: any) => ({ ...real.createGame(rng), over: true, score: 500 }) };
});
vi.mock('../src/renderer/state/theme-context', () => ({ useTheme: () => ({ reducedEffects: true }) }));

import TwentyFortyEightGame from '../src/renderer/components/game/TwentyFortyEightGame';

afterEach(cleanup);

// Card #134 / Destin's N3: no "New best" when the online best failed to load - it may be higher.
describe('end-of-run "New best"', () => {
  it('shows New best when the run beats a known best', () => {
    render(<TwentyFortyEightGame onEnd={vi.fn()} best={100} />);
    expect(screen.getByText('New best')).toBeInTheDocument();
  });

  it('hides it when the online best could not be loaded, though the score beats what this computer knows', () => {
    render(<TwentyFortyEightGame onEnd={vi.fn()} best={100} onlineBestUnknown />);
    expect(screen.queryByText('New best')).toBeNull();
    expect(screen.getByText('No moves left')).toBeInTheDocument(); // the end-of-run card is still there
  });
});
