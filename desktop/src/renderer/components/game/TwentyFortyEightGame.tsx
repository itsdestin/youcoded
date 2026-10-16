// 2048 — the playfield (spec §5.2, §5.5, §10).
//
// The rules live next door in `twenty-forty-eight.ts` and are pure; this file
// is only pixels, keys and animation. Splitting them that way is what lets the
// awkward rules ([2,2,2,2] must become [4,4], never [8]) be tested without a
// browser.
//
// §7, and it is the reason this game is in the lineup at all: NOTHING here
// watches the assistant. No timer, no countdown, no idle penalty, no pause when
// a turn ends. You can stop mid-move, look away for an hour, and come back to
// exactly the board you left.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../../state/theme-context';
import { isTypingTarget } from '../../utils/is-typing-target';
import { Button, Pill } from '../ui';
import type { SoloGameProps } from './game-registry';
import RunOverCard from './RunOverCard';
import {
  SIZE, createGame, move, type Direction, type Game, type Rng, type Tile,
} from './twenty-forty-eight';

/* ── The value ramp (§5.2) ──────────────────────────────────────────────────
 *
 * A tile's fill walks from the board's own neutral surface toward the theme's
 * accent as its number climbs, so the board visibly "heats up" as you play.
 *
 * THE TRAP, and why these numbers are not copied from `sheet-theme.ts`: that
 * file's five constants all mix toward a literal `#ffffff`, deliberately — a
 * spreadsheet's paper stays white in every theme, like Excel. A board built the
 * same way is white-on-white in every dark theme. So the TECHNIQUE transfers
 * (color-mix, stepped percentages) and the ENDPOINTS do not: both ends here are
 * theme tokens (`--inset` → `--accent`), which means the ramp inverts itself in
 * a dark theme instead of blowing out.
 *
 * Adjacent steps are ~9% apart, which is deliberately gentle: the NUMBER on the
 * tile is the information and the colour is reinforcement, so the ramp only has
 * to read as a gradient across the board, not as eleven nameable colours.
 *
 * The text colour flips at the halfway point. Below 50% the fill is nearer the
 * neutral surface, where `--fg` is the theme's own guaranteed-legible text;
 * at or above 50% it is nearer the accent, where `--on-accent` is (the theme
 * validator computes `--on-accent` to be legible against `--accent`). The
 * worst case for both is exactly at the switch, and that midpoint was measured
 * in all four built-in themes — see the note at the bottom of this file. */
const RAMP: Record<number, number> = {
  2: 14, 4: 22, 8: 30, 16: 38, 32: 46, 64: 55, 128: 64, 256: 73, 512: 82, 1024: 91,
};
/** Anything past 1024 is the top of the ramp — pure accent. */
const accentPct = (value: number) => RAMP[value] ?? 100;
const tileFill = (value: number) =>
  `color-mix(in srgb, var(--accent) ${accentPct(value)}%, var(--inset))`;
const tileInk = (value: number) => (accentPct(value) >= 50 ? 'var(--on-accent)' : 'var(--fg)');

/** Both input schemes, in one map (§10). Arrows are 2048's real interface and
 *  WASD is the one every player already has their hand on. `e.key` is
 *  lower-cased before the lookup so Caps Lock does not break the game. */
const KEYS: Record<string, Direction> = {
  arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down',
  a: 'left', d: 'right', w: 'up', s: 'down',
};

/** Board geometry, as fractions of the board's own width, so every one of these
 *  scales with the pane instead of being a pixel guess (§4.3: the pane is
 *  resizable from 320px to 60% of the window). */
const FRAME_INSET = '2.6%'; // gap between the board's border and the grid
const CELL_PAD = '1.6%';    // half the gap between two tiles

export default function TwentyFortyEightGame({ onEnd, best, onExit }: SoloGameProps) {
  const { reducedEffects } = useTheme();
  // Real play is unpredictable; the rules module never calls Math.random itself.
  const rng = useRef<Rng>(Math.random).current;
  const [game, setGame] = useState<Game>(() => createGame(rng));
  const boardRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const [boardPx, setBoardPx] = useState(0);
  // The run's score is reported exactly once, however many times React
  // re-renders after the board dies.
  const reported = useRef(false);

  useEffect(() => {
    if (game.over && !reported.current) {
      reported.current = true;
      onEnd(game.score);
    }
  }, [game.over, game.score, onEnd]);

  // Tile numbers are sized off the MEASURED board width rather than a viewport
  // unit: the pane is user-resizable, so `vw` would size the digits off the
  // whole window and leave "1024" spilling out of its tile at a narrow pane.
  useLayoutEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const measure = () => setBoardPx(el.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Focus the board on open so the keyboard — 2048's ONLY real input — works
  // without hunting for a click target. It yields if the user was mid-sentence
  // somewhere: `isTypingTarget` is the app's single answer to "is a text field
  // active?", the same one every global shortcut asks. `preventScroll` stops the
  // pane jumping to the board on mount.
  useEffect(() => {
    if (!isTypingTarget(document.activeElement)) boardRef.current?.focus({ preventScroll: true });
  }, []);

  const restart = useCallback(() => {
    reported.current = false;
    setGame(createGame(rng));
    boardRef.current?.focus({ preventScroll: true });
  }, [rng]);

  // KEY SCOPING (§10). This handler is bound to the board element, not to
  // `window`, so it can only fire while the board (or something inside it) has
  // focus. That is what keeps 2048 from eating the arrow keys the chat uses to
  // scroll: with the board unfocused this component listens to nothing at all.
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // Modifier combinations belong to the app (shortcuts, text selection), never
    // to the board.
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    // Enter starts the next game once the board is dead — the same
    // press-again-to-retry Flappy has, so the two do not disagree about how to
    // begin a run. Arrows deliberately do NOT retry: on a dead board they are
    // the reflex of someone still trying to move, not a decision to start over.
    if (e.key === 'Enter') {
      if (overRef.current) { e.preventDefault(); restart(); }
      return;
    }
    const dir = KEYS[e.key.toLowerCase()];
    if (!dir) return;
    // Stops the arrow key ALSO scrolling the pane this board sits in.
    e.preventDefault();
    setGame((g) => (g.over ? g : move(g, dir, rng).game));
  }, [rng, restart]);

  // WHY a ref and not `game.over` straight from the closure: the handler is
  // memoised on [rng, restart], so reading state directly would see whatever
  // the board was when it was last rebuilt — which is not when it died.
  const overRef = useRef(game.over);
  useEffect(() => { overRef.current = game.over; }, [game.over]);

  // Ghost tiles are the ones just swallowed by a merge; they exist only to be
  // animated out. With animation off there is nothing for them to do, so they
  // are not rendered at all rather than rendered invisible.
  const painted = useMemo<{ tile: Tile; ghost: boolean }[]>(() => [
    ...game.tiles.map((tile) => ({ tile, ghost: false })),
    ...(reducedEffects ? [] : game.ghosts.map((tile) => ({ tile, ghost: true }))),
  ], [game.tiles, game.ghosts, reducedEffects]);

  return (
    <div className="p-3 flex-1 min-h-0 flex flex-col gap-3">
      <div className="flex items-end gap-4">
        <Stat label="Score" value={game.score.toLocaleString()} />
        <Stat label="Best" value={best != null ? best.toLocaleString() : '—'} />
        <div className="flex-1" />
        {/* Reaching 2048 is worth saying out loud, but it does not stop the run
            — the score keeps climbing and the leaderboard wants the bigger one. */}
        {/* WHY the shared Pill (decisions "Status labels"): a status is a small tinted pill,
            not a solid accent block — the same piece as RunOverCard's "New best". */}
        {game.won && <Pill tone="info">2048 reached</Pill>}
        <Button variant="secondary" size="sm" onClick={restart}>New game</Button>
      </div>

      <div
        ref={boardRef}
        tabIndex={0}
        role="application"
        aria-label="2048 board. Arrow keys or W A S D to slide the tiles."
        // Marker for the app's window-level arrow handler (ChatView scrolls the
        // transcript on Up/Down from anywhere that is not a text field). While
        // this board holds focus its keys are the game's, and that handler can
        // bail on this attribute in one line without knowing what 2048 is.
        data-game-keys="arrows"
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={[
          'relative w-full aspect-square rounded-lg border outline-none select-none',
          // The board frame is the neutral end of the tile ramp, so a low tile
          // reads as "barely off the board" and a high one as "all accent".
          'bg-inset',
          // Focus is not decoration here — it is the difference between the
          // keys doing something and doing nothing, so it gets a real ring and
          // not the usual focus-visible-only one (clicking the board would not
          // trigger focus-visible, and the player would be left guessing).
          focused ? 'border-accent ring-2 ring-accent/40' : 'border-edge',
        ].join(' ')}
      >
        <div className="absolute" style={{ inset: FRAME_INSET }}>
          {/* Empty squares. Painted once, underneath everything. */}
          {Array.from({ length: SIZE * SIZE }, (_, i) => (
            <Square key={i} row={Math.floor(i / SIZE)} col={i % SIZE}>
              <div className="w-full h-full rounded-md bg-well" />
            </Square>
          ))}

          {/* Live tiles and ghosts share ONE keyed list on purpose: a tile that
              gets swallowed moves from `tiles` into `ghosts`, and only by living
              in the same list does React keep its DOM node — which is what lets
              it slide into the merge instead of blinking out where it stood. */}
          {painted.map(({ tile, ghost }) => (
            <Square
              key={tile.id}
              row={tile.row}
              col={tile.col}
              style={{
                opacity: ghost ? 0 : 1,
                // A ghost sits under the tile that ate it; a freshly merged tile
                // sits above its neighbours while it pops.
                zIndex: ghost ? 1 : tile.merged ? 3 : 2,
                pointerEvents: 'none',
                transition: reducedEffects ? 'none' : 'transform 110ms ease-out, opacity 110ms ease-out',
              }}
            >
              {/* Keyed by value so that a merge REMOUNTS the face — which is
                  what replays the grow-in below as the merge "pop". A tile that
                  only slides keeps its face and does not pop. */}
              <TileFace
                key={tile.value}
                value={tile.value}
                boardPx={boardPx}
                reducedEffects={reducedEffects}
              />
            </Square>
          ))}
        </div>

        {game.over && (
          // Game state, not app state — this appears because the board is dead,
          // never because the assistant did something (§7). The card is shared
          // with Flappy (G-1); before it, this screen silently failed to
          // celebrate a new best while Flappy's did.
          <RunOverCard
            reason="No moves left"
            score={game.score.toLocaleString()}
            // Same rule as Flappy: a zero is not a new best, and "Your best: 0"
            // is not a target worth printing.
            isBest={game.score > 0 && game.score > (best ?? 0)}
            best={best != null && best > 0 && game.score <= best ? best.toLocaleString() : undefined}
            onRetry={restart}
            onExit={onExit}
            retryKeyHint="Enter"
          />
        )}
      </div>

      {/* Says which input is live right now. Without it a player whose board has
          lost focus presses an arrow, the chat scrolls, and nothing explains why. */}
      <p className="text-2xs text-fg-muted leading-relaxed">
        {focused
          ? 'Arrow keys or W A S D to slide. Nothing here is timed — leave it as long as you like.'
          : 'Click the board (or Tab to it) to play with the keyboard.'}
      </p>

      {/* Screen-reader running commentary. Polite, and only the two facts worth
          interrupting for: the score after a move, and the end of the run. */}
      <span className="sr-only" role="status" aria-live="polite">
        {game.over ? `No moves left. Final score ${game.score}.` : `Score ${game.score}.`}
      </span>
    </div>
  );
}

/** One cell-sized box parked on a grid square.
 *
 *  Everything is a percentage of the grid layer, which is itself a square: a
 *  box is a quarter of it, and `translate` in percent moves by whole cells. The
 *  board therefore has no pixel measurements in it at all and stays correct at
 *  every pane width from 320px up. */
function Square({ row, col, style, children }: {
  row: number; col: number; style?: React.CSSProperties; children?: React.ReactNode;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        width: `${100 / SIZE}%`,
        height: `${100 / SIZE}%`,
        padding: CELL_PAD,
        transform: `translate(${col * 100}%, ${row * 100}%)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** The visible face of a tile: the ramp fill, and the number. */
function TileFace({ value, boardPx, reducedEffects }: {
  value: number; boardPx: number; reducedEffects: boolean;
}) {
  // Grow-in. The face mounts slightly small and is scaled to full size on the
  // next frame, so the browser has two states to interpolate between — that is
  // the whole animation, with no keyframes and no stylesheet of its own. With
  // reduced effects it simply mounts at full size.
  const [grown, setGrown] = useState(reducedEffects);
  useEffect(() => {
    if (reducedEffects) return;
    const raf = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(raf);
  }, [reducedEffects]);

  // Long numbers get proportionally smaller type so "1024" fits the same tile
  // "2" does, without ever wrapping.
  const digits = String(value).length;
  const scale = digits <= 2 ? 0.105 : digits === 3 ? 0.085 : 0.066;

  return (
    <div
      className="w-full h-full rounded-md flex items-center justify-center font-semibold tabular-nums"
      style={{
        background: tileFill(value),
        color: tileInk(value),
        fontSize: boardPx ? `${Math.max(10, boardPx * scale)}px` : `${scale * 100}%`,
        transform: `scale(${grown ? 1 : 0.74})`,
        transition: reducedEffects ? 'none' : 'transform 110ms ease-out',
      }}
    >
      {value}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex flex-col leading-tight">
      {/* WHY no uppercase/tracking (decisions "Heading ladder": small labels in normal case,
          no spaced-out capitals). */}
      <span className="text-2xs text-fg-muted">{label}</span>
      <span className="text-sm font-semibold text-fg tabular-nums">{value}</span>
    </span>
  );
}

/* ── Ramp legibility, measured (not eyeballed) ───────────────────────────────
 *
 * Every one of the eleven steps was mixed against each built-in theme's real
 * `--inset` and `--accent` and scored against the ink `tileInk` picks for it.
 * The WEAKEST step per theme (all eleven are listed in the working note):
 *
 *   light 4.41:1 @32   dark 3.54:1 @32   midnight 3.55:1 @32   creme 3.79:1 @64
 *
 * All clear the 3:1 floor for large bold text, which is what a tile number is at
 * every pane width the board supports. The weakest step is always one of the two
 * either side of the 50% ink switch, which is exactly where it should be — and
 * the two dark themes score as well as the light ones, which is the thing
 * copying `sheet-theme.ts` would have destroyed.
 *
 * The other measured number is the empty square (`bg-well`) against the lowest
 * tile, which is what stops a 2 reading as a hole: 1.78 / 1.52 / 1.67 / 1.77
 * across the four themes. The ramp starts at 14% rather than 10% for exactly
 * that reason — at 10% the dark theme's 2-tile was only 1.37 off its square. */
