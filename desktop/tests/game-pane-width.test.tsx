// @vitest-environment jsdom
// desktop/tests/game-pane-width.test.tsx
//
// ONE INVARIANT: `applyGameDefaultWidth` keeps the SAME identity when the
// games-pane width changes.
//
// Why that is worth a test file of its own. ArcadeShell calls this function
// from an effect, so its identity is part of that effect's trigger list. It
// used to be recreated on every ThemeProvider render, which meant committing a
// drag of the pane's edge — a gamePaneWidth state change — handed the effect a
// new identity and re-ran it. The effect it re-ran also stopped play: the
// player was 40 pipes into Flappy, dragged the pane wider to see more board,
// let go of the mouse, and the game vanished with the run uncounted. Resetting
// the width by double-clicking the handle, and shrinking the window far enough
// to clamp the pane, did the same thing.
//
// This is the root-cause half of the fix. The other half — that stopping play
// is its own effect, keyed on the open game alone — is the ast-grep rule
// arcade-stop-play-keyed-on-open-game (plus a count in arcade-authority.test.ts),
// because it is a fact about how the effect is WRITTEN and no amount of
// rendering can pin it.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { ThemeProvider, useTheme } from '../src/renderer/state/theme-context';

afterEach(() => { cleanup(); try { localStorage.clear(); } catch { /* jsdom quirk */ } });

/** Records the identity handed out on every render, and exposes the three ways
 *  a pane width gets committed. */
function Probe({ seen }: { seen: Array<(px: number) => void> }) {
  const { applyGameDefaultWidth, setGamePaneWidth, resetGamePaneWidth, gamePaneWidth } = useTheme();
  seen.push(applyGameDefaultWidth);
  return (
    <div>
      <span data-testid="width">{gamePaneWidth}</span>
      <button data-testid="drag" onClick={() => setGamePaneWidth(560)}>drag</button>
      <button data-testid="reset" onClick={resetGamePaneWidth}>reset</button>
    </div>
  );
}

function mount() {
  const seen: Array<(px: number) => void> = [];
  const utils = render(<ThemeProvider><Probe seen={seen} /></ThemeProvider>);
  return { ...utils, seen };
}

/** Every identity handed out must be the one from the first render. */
function allIdentical(seen: Array<(px: number) => void>): boolean {
  return seen.length > 0 && seen.every((fn) => fn === seen[0]);
}

describe('applyGameDefaultWidth survives a width change', () => {
  it('holds its identity when a drag is committed', () => {
    const { getByTestId, seen } = mount();
    act(() => { getByTestId('drag').click(); });
    // Proof the render actually happened — otherwise this passes vacuously.
    expect(getByTestId('width').textContent).toBe('560');
    expect(seen.length).toBeGreaterThan(1);
    expect(allIdentical(seen)).toBe(true);
  });

  it('holds it through a double-click reset too', () => {
    const { getByTestId, seen } = mount();
    act(() => { getByTestId('drag').click(); });
    const afterDrag = seen.length;
    act(() => { getByTestId('reset').click(); });
    expect(getByTestId('width').textContent).toBe('420');
    expect(seen.length).toBeGreaterThan(afterDrag);
    expect(allIdentical(seen)).toBe(true);
  });

  it('holds it when the window shrinks far enough to re-clamp the pane', async () => {
    const { getByTestId, seen } = mount();
    act(() => { getByTestId('drag').click(); });
    const afterDrag = seen.length;
    await act(async () => {
      (window as unknown as { innerWidth: number }).innerWidth = 700;
      window.dispatchEvent(new Event('resize'));
      // ThemeProvider re-clamps inside a requestAnimationFrame; wait one out.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    // 60% of 700 = 420, so the pane really was clamped down from 560.
    expect(getByTestId('width').textContent).toBe('420');
    expect(seen.length).toBeGreaterThan(afterDrag);
    expect(allIdentical(seen)).toBe(true);
  });
});
