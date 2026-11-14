// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Every step of the simulation ends the run at once with 3 pipes, so the end-of-run card shows without real play.
vi.mock('../src/renderer/components/game/flappy-engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/renderer/components/game/flappy-engine')>();
  return { ...real, step: (s: any) => ({ ...s, status: 'dead', score: 3, deathCause: 'pipe' }) };
});
vi.mock('../src/renderer/state/theme-context', () => ({ useTheme: () => ({ reducedEffects: true }) }));

import FlappyGame from '../src/renderer/components/game/FlappyGame';

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 0) as unknown as number);
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// Destin's N3 for Flappy (the 2048 case is in solo-new-best.test.tsx).
describe('Flappy end-of-run "New best"', () => {
  it('shows New best when the run beats a known best', async () => {
    render(<FlappyGame onEnd={vi.fn()} best={1} />);
    expect(await screen.findByText('New best')).toBeInTheDocument();
  });

  it('hides it when the online best could not be loaded, though 3 pipes beats the 1 this computer knows', async () => {
    render(<FlappyGame onEnd={vi.fn()} best={1} onlineBestUnknown />);
    await screen.findByText('3 pipes');
    expect(screen.queryByText('New best')).toBeNull();
  });
});
