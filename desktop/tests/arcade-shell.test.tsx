// @vitest-environment jsdom
// desktop/tests/arcade-shell.test.tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import ArcadePicker from '../src/renderer/components/game/ArcadePicker';
import Leaderboard from '../src/renderer/components/game/Leaderboard';
import { gameById } from '../src/renderer/components/game/game-registry';

afterEach(cleanup);

const FLAPPY = gameById('flappy')!;
const CHESS = gameById('chess')!;

function picker(statuses: Record<string, any>, signedIn = true) {
  return render(
    <ArcadePicker statuses={statuses} onPick={vi.fn()} signedIn={signedIn} onSignIn={vi.fn()} />,
  );
}

// §4.1: "Each tile carries the one fact that decides whether you click it."
// These cases ARE that requirement — if any of them regresses to a generic
// label, the picker stops answering "is there anything to do here?".
describe('the picker states the deciding fact', () => {
  it('shows a solo best when there is one', () => {
    picker({ flappy: { bestScore: '31 pipes' } });
    expect(screen.getByText('Your best: 31 pipes')).toBeInTheDocument();
  });

  it('says a solo game is unplayed rather than showing a zero', () => {
    // A "0" would read as a bad score rather than an absent one.
    picker({ flappy: {} });
    // Both solo tiles are unplayed in this fixture, which is itself the point:
    // a brand-new install shows the state on every solo game, not a blank.
    expect(screen.getAllByText('Not played yet')).toHaveLength(2);
    expect(screen.queryByText(/Your best: 0/)).toBeNull();
  });

  it('names the friend who is online, not a count, when there is one', () => {
    picker({ chess: { friendsOnline: ['Jake'] } });
    expect(screen.getByText('Jake is online')).toBeInTheDocument();
  });

  it('names both when there are two, and summarises beyond that', () => {
    cleanup();
    picker({ chess: { friendsOnline: ['Jake', 'Mira'] } });
    expect(screen.getByText('Jake and Mira are online')).toBeInTheDocument();
    cleanup();
    picker({ chess: { friendsOnline: ['Jake', 'Mira', 'Sam', 'Ada'] } });
    expect(screen.getByText('Jake and 3 others are online')).toBeInTheDocument();
  });

  it('says nobody is online instead of going blank', () => {
    picker({ chess: { friendsOnline: [] } });
    expect(screen.getAllByText('No friends online').length).toBeGreaterThan(0);
  });
});

describe('signed out, solo still plays', () => {
  it('leaves solo tiles enabled and only gates the versus ones', () => {
    picker({ flappy: { bestScore: '31 pipes' }, chess: { friendsOnline: ['Jake'] } }, false);
    const flappy = screen.getByText('Flappy').closest('button')!;
    const chess = screen.getByText('Chess').closest('button')!;
    expect(flappy).not.toBeDisabled();
    // Signed out is NOT disabled — the tile explains the gate when clicked.
    // A dead tile teaches nothing (design guide §4.7).
    expect(chess).not.toBeDisabled();
    expect(screen.getAllByText('Sign in to play').length).toBeGreaterThan(0);
  });

  it('says what an account actually buys, and does not gate the panel', () => {
    picker({}, false);
    expect(screen.getByText(/play without an account/i)).toBeInTheDocument();
    // The four tiles are still on screen — the old panel replaced everything
    // with a sign-in wall, which is the friction §4.2 exists to remove.
    expect(screen.getByText('Flappy')).toBeInTheDocument();
    expect(screen.getByText('Chess')).toBeInTheDocument();
  });
});

describe('degraded service', () => {
  it('says why a versus game is unavailable and disables only that tile', () => {
    picker({
      flappy: { bestScore: '31 pipes' },
      chess: { unavailable: "Can't reach the game server" },
    });
    expect(screen.getByText("Can't reach the game server")).toBeInTheDocument();
    expect(screen.getByText('Chess').closest('button')!).toBeDisabled();
    // The whole point: an outage in one service must not present as the panel
    // being dead. Flappy is untouched.
    expect(screen.getByText('Flappy').closest('button')!).not.toBeDisabled();
  });
});

describe('the leaderboard', () => {
  const rows = [
    { accountId: 'mira', name: 'Mira', handle: 'mira', score: '58 pipes', isYou: false },
    { accountId: 'you', name: 'You', handle: 'destin', score: '31 pipes', isYou: true },
  ];

  it('ranks you among friends and marks your own row', () => {
    render(<Leaderboard game={FLAPPY} rows={rows} />);
    expect(screen.getByText('Mira')).toBeInTheDocument();
    // Your row is accent-filled — the same you-vs-them rule as the board (§5.5).
    expect(screen.getByText('You').closest('li')!.className).toContain('bg-accent');
    // `well`, not `inset` — the games pane is itself bg-inset, so an inset row
    // had no visible edge against it (caught in the Step 1 capture).
    expect(screen.getByText('Mira').closest('li')!.className).toContain('bg-well');
  });

  it('reads as an invitation when you are alone, not as a failure', () => {
    render(<Leaderboard game={FLAPPY} rows={[rows[1]!]} />);
    // A REAL ranked row, because #1 of 1 is true...
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('31 pipes')).toBeInTheDocument();
    // ...with the invitation under it, not in place of it.
    expect(screen.getByText(/Add a friend/i)).toBeInTheDocument();
    expect(screen.queryByText(/no data|empty|nothing here/i)).toBeNull();
  });

  it('labels a stale board instead of emptying it', () => {
    render(<Leaderboard game={FLAPPY} rows={rows} staleNote="Last updated a few minutes ago" />);
    expect(screen.getByText('Last updated a few minutes ago')).toBeInTheDocument();
    // Emptying it would teach the player their scores were lost, which is both
    // alarming and untrue.
    expect(screen.getByText('Mira')).toBeInTheDocument();
  });

  it('shows a signed-out best as real, and says what signing in adds', () => {
    render(<Leaderboard game={FLAPPY} rows={[]} unpublishedBest="31 pipes" onSignIn={vi.fn()} />);
    expect(screen.getByText('31 pipes')).toBeInTheDocument();
    expect(screen.getByText(/Saved on this device/i)).toBeInTheDocument();
  });

  it('labels the column with the game\'s own scoring word', () => {
    // "Score" is wrong for Flappy and right for 2048 — the registry decides.
    // The eyebrow uppercases in CSS (G-7), so the DOM text is the real label.
    render(<Leaderboard game={FLAPPY} rows={rows} />);
    const eyebrow = screen.getByText(FLAPPY.scoring!.label);
    expect(eyebrow).toBeInTheDocument();
    expect(eyebrow.className).toContain('uppercase');
  });
});

describe('picking a game', () => {
  it('hands back the definition, not a string', () => {
    const onPick = vi.fn();
    render(<ArcadePicker statuses={{}} onPick={onPick} signedIn onSignIn={vi.fn()} />);
    fireEvent.click(screen.getByText('Chess').closest('button')!);
    expect(onPick).toHaveBeenCalledWith(CHESS);
  });
});
