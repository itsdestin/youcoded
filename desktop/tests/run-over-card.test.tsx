// @vitest-environment jsdom
// desktop/tests/run-over-card.test.tsx
//
// Destin, 2026-08-31: "single-player/high-score games should have a clear
// end/failure screen with a retry button."
//
// WHY these are worth pinning: Flappy and 2048 had each grown their own end
// overlay and they had ALREADY drifted — Flappy celebrated a new best, 2048
// silently did not. Same achievement, different reward, for no reason anyone
// chose. The card is now shared; these hold it that way.
//
// WHY the source scans are gone (Plan B, 2026-09-16): "every solo game renders
// the card with a keyboard retry" and "endRun never stops play / the shell
// passes onExit" are the ast-grep rules solo-game-uses-run-over-card and
// arcade-end-run-keeps-playing (workspace scripts/ast-grep/rules/).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import RunOverCard from '../src/renderer/components/game/RunOverCard';

afterEach(cleanup);

describe('the end of a run', () => {
  it('leads with the score, not the failure', () => {
    // A high-score game is asking you to beat a number, so the number is the
    // headline and the cause is the footnote.
    render(<RunOverCard reason="You hit a pipe" score="17 pipes" isBest={false} onRetry={vi.fn()} />);
    const score = screen.getByText('17 pipes');
    const reason = screen.getByText('You hit a pipe');
    expect(score.className).toMatch(/text-2xl/);
    expect(reason.className).toMatch(/text-2xs/);
  });

  it('always offers a retry', () => {
    const onRetry = vi.fn();
    render(<RunOverCard reason="No moves left" score="12,480" isBest={false} onRetry={onRetry} />);
    fireEvent.click(screen.getByText('Play again'));
    expect(onRetry).toHaveBeenCalled();
  });

  it('celebrates a new best', () => {
    render(<RunOverCard reason="You hit a pipe" score="31 pipes" isBest onRetry={vi.fn()} />);
    expect(screen.getByText('New best')).toBeInTheDocument();
  });

  it('shows the target to beat when the run fell short', () => {
    // Not a scolding — the reason to press again.
    render(<RunOverCard reason="You hit a pipe" score="9 pipes" isBest={false} best="31 pipes" onRetry={vi.fn()} />);
    expect(screen.getByText(/Your best: 31 pipes/)).toBeInTheDocument();
    expect(screen.queryByText('New best')).toBeNull();
  });

  it('names the key that retries, for a keyboard game', () => {
    render(<RunOverCard reason="x" score="1" isBest={false} onRetry={vi.fn()} retryKeyHint="Space" />);
    expect(screen.getByText(/press Space/i)).toBeInTheDocument();
  });

  it('offers a way out, not only a way back in', () => {
    const onExit = vi.fn();
    render(<RunOverCard reason="x" score="1" isBest={false} onRetry={vi.fn()} onExit={onExit} />);
    fireEvent.click(screen.getByText('Back to games'));
    expect(onExit).toHaveBeenCalled();
  });
});

describe('a zero is not an achievement', () => {
  it('does not celebrate a scoreless run', () => {
    render(<RunOverCard reason="You hit the ground" score="0 pipes" isBest={false} onRetry={vi.fn()} />);
    expect(screen.queryByText('New best')).toBeNull();
  });

  it('does not print a zero as a target to beat', () => {
    // "Your best: 0 pipes" is not a target; it is a slightly insulting way of
    // saying nothing.
    render(<RunOverCard reason="You hit the ground" score="0 pipes" isBest={false} onRetry={vi.fn()} />);
    expect(screen.queryByText(/Your best/)).toBeNull();
  });
});
