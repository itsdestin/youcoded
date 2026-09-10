// Chess board (spec §5.3, §5.5) — now playable.
//
// The VISUAL language was signed off in Step 1 (deck step G-8) and is unchanged
// here: two shades of one surface family for the squares, and the two players
// told apart by SHAPE (solid pieces vs hollow ones), not only by shade.
//
// MEASURED, Step 1 capture: fill alone DOES NOT separate the players on a
// board. The first pass used one solid glyph set with `accent` for you and
// `fg-muted` for them, reasoning from §5.5 that chat proves fill is enough.
// In the dark theme that renders #D4D4D4 against #898989 — two light greys,
// side by side in one grid, and they were not tellable apart even knowing
// which was which. Chat gets away with it because it ALSO has position
// (right-aligned vs left); a board has no such cue.
//
// DECIDED (Destin, deck step G-8, 2026-08-30): 'outline' — the chess
// convention. The two rejected treatments stay behind the parameter, not
// deleted, because this rule now governs every two-player game we add:
//   'disc'  your piece sits on a filled accent disc — strongest separation,
//           rejected as too busy (16 filled circles at the opening position).
//   'fill'  the original colour-only pass — REJECTED, see above.
//
// WHAT'S NEW IN STEP 2: move input. Click your piece to pick it up, click a dot
// to move. Legality comes entirely from chess.js via `game/chess.ts` — nothing
// in this file knows a rule, which is deliberate (§5.3: a chess player finds an
// illegal-move bug in one game).
//
// FIXES THE OPEN ITEM FROM THE DECK (step S-2, "the picked-up square is too
// faint — the legal-move dots read as causeless"). A single 25%-accent wash was
// the whole selection cue. It now carries THREE stacked cues, because the
// wash alone is the one that disappears on a light theme:
//   1. a full-strength accent ring around the square (a hard edge, not a tint),
//   2. a stronger accent wash inside it, and
//   3. the piece itself lifts — it scales up, so the square you picked up
//      reads as picked up rather than merely tinted.

import { useEffect, useMemo, useState } from 'react';
import { useGameState, useGameDispatch } from '../../state/game-context';
import { GameConnection } from '../../state/game-types';
import {
  colorForSeat,
  isPromotion,
  legalTargets,
  readPosition,
  startingPlay,
  type ChessPlay,
  type PlacedPiece,
  type PromotionPiece,
} from '../../game/chess';
import { Button, StatusStrip } from '../ui';

const SOLID: Record<string, string> = {
  k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟',
};
const OUTLINE: Record<string, string> = {
  k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙',
};

const PIECE_NAMES: Record<string, string> = {
  k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn',
};

export type PieceTreatment = 'disc' | 'outline' | 'fill';

const FILES = 'abcdefgh';
const RANKS = '87654321';

interface Props {
  connection: GameConnection;
  /** How the two players' pieces are told apart. Settled: 'outline'. The other
   *  two stay reachable so the decision can be re-examined, never as a user
   *  setting — one rule per app, or the games stop teaching each other. */
  treatment?: PieceTreatment;
}

/** How the board's two square shades are made.
 *
 *  DECIDED (Destin, deck `board-contrast`, 2026-08-31): 'contrast' — full
 *  strength, neutral. The three rejected candidates stay behind `?board=`, not
 *  deleted, because this is the same question every future board-shaped game
 *  will ask. WORKBENCH-ONLY, exactly like `?chess=`: never a user setting.
 *
 *  WHAT WAS WRONG. The board said `bg-inset bg-accent/[0.07]` — two background
 *  utilities on one element. They do not blend; one wins. So the intended tint
 *  never painted and the two squares were the raw surface values one ladder
 *  rung apart: measured #D7D7D7 vs #F9F9F9 in light, #222222 vs #1C1C1C in
 *  dark. That is 1.05-1.40 square-to-square contrast where a physical board is
 *  nearer 2.5-3, and it is why a bishop's colour was unreadable.
 *
 *  WHY NEUTRAL BEAT THE PRETTIER OPTION. 'wood' takes the theme's own accent
 *  and looks markedly better in four themes (creme becomes a cream-and-brown
 *  board). But it depends on a colour a THEME AUTHOR chose: pure accent
 *  measured 1.40 on halftone-dimension and 1.44 on meadow-mist, and even
 *  blended toward `--fg` it only reaches 1.80. 'contrast' is built from `--fg`,
 *  which contrasts with its own surface by definition or the theme would be
 *  unreadable — so it cannot be defeated by a community theme nobody has
 *  reviewed, and those ship constantly.
 *
 *  Measured across the six themes: today 1.05-1.40 · soft 1.50-1.86 ·
 *  contrast 2.01-2.97 · wood 1.80-2.86. */
export type BoardShading = 'today' | 'soft' | 'contrast' | 'wood';

function boardShading(): BoardShading {
  if (typeof location === 'undefined') return 'contrast';
  const v = new URLSearchParams(location.search).get('board');
  return v === 'soft' || v === 'wood' || v === 'today' ? v : 'contrast';
}

/** The dark square's extra layer. `null` for `today`, which keeps the two raw
 *  surface tokens it ships with.
 *
 *  `--fg` and `--accent` are used as the MIX SOURCE rather than a fixed black
 *  or white, so the step lands in the right direction in every theme without
 *  the board knowing whether it is light or dark: `--fg` always contrasts
 *  strongly with its own surface, including in a community theme nobody has
 *  seen yet. That is the argument for `contrast` over the alternatives — it
 *  cannot be defeated by a theme we did not test. */
function boardShadeStyle(shading: BoardShading): { background: string } | null {
  switch (shading) {
    // Neutral, gentle. Reads as a board without competing with the pieces.
    case 'soft':     return { background: 'color-mix(in srgb, var(--fg) 22%, transparent)' };
    // SHIPPING (deck `board-contrast`). Neutral, full strength — the ratio a
    // physical board has, in every theme including ones we have never seen.
    case 'contrast': return { background: 'color-mix(in srgb, var(--fg) 36%, transparent)' };
    // The theme's own colour, with a guaranteed floor. Creme goes brown and
    // midnight goes blue, the way a real board is two woods rather than two
    // greys — but the accent is blended toward `--fg` first, because MEASURED:
    // pure accent at 34% collapses to 1.40 on halftone-dimension and 1.44 on
    // meadow-mist, whose accents sit close to their own surfaces. Colour alone
    // cannot be trusted across themes nobody has reviewed yet.
    case 'wood':     return { background: 'color-mix(in srgb, color-mix(in srgb, var(--accent) 60%, var(--fg)) 38%, transparent)' };
    default:         return null;
  }
}

export default function ChessBoard({ connection, treatment = 'outline' }: Props) {
  const state = useGameState();
  const dispatch = useGameDispatch();

  // The state split (§3.1): the shell holds only your SEAT, whose turn it is,
  // and the outcome. Chess's own position lives in `state.play`, which the
  // shell treats as opaque — this narrowing is the one place that knows the
  // shape, and it is inside chess's own component where it belongs.
  const play = (state.play ?? startingPlay()) as ChessPlay;

  const mySeat = state.seat ?? 0;
  const myColor = colorForSeat(mySeat);
  const pieces = useMemo(() => readPosition(play.fen), [play.fen]);
  // 'contrast' in every shipped build; `?board=` renders the rejected three.
  const shading = boardShading();
  const shadeStyle = boardShadeStyle(shading);

  const [selected, setSelected] = useState<string | null>(null);
  /** A pawn move that needs a piece chosen before it can be sent. */
  const [promoting, setPromoting] = useState<{ from: string; to: string } | null>(null);

  const isMyTurn = state.seat !== null && state.turnSeat === state.seat;
  const isPlaying = state.screen === 'playing';
  const canMove = isMyTurn && isPlaying && !state.opponentDisconnected && !play.over;

  // Whenever the position changes — our move landed, or theirs arrived — the
  // picked-up square is stale. Clearing it here rather than at every call site
  // is what stops a stale selection painting dots on the new position.
  useEffect(() => {
    setSelected(null);
    setPromoting(null);
  }, [play.fen]);

  const targets = useMemo(
    () => (selected && canMove ? legalTargets(play.fen, selected) : []),
    [selected, canMove, play.fen],
  );

  const send = (from: string, to: string, promotion?: PromotionPiece) => {
    connection.makeMove(promotion ? { from, to, promotion } : { from, to });
    setSelected(null);
    setPromoting(null);
  };

  const onSquare = (square: string) => {
    if (!canMove) return;

    // Completing a move: the square is one of the dots.
    if (selected && targets.includes(square)) {
      // A promoting pawn must name what it becomes — chess.js rejects the move
      // without it rather than assuming a queen, so we have to ask.
      if (isPromotion(play.fen, selected, square)) {
        setPromoting({ from: selected, to: square });
        return;
      }
      send(selected, square);
      return;
    }

    // Picking a piece up, or swapping to a different one of yours.
    const piece = pieces[square];
    if (piece && piece.color === myColor) {
      setSelected(square === selected ? null : square);
      return;
    }

    // Anything else — an empty square, an enemy piece that isn't a legal
    // capture — puts the piece back down. Nothing illegal is ever sent.
    setSelected(null);
  };

  // Your own colour sits at the bottom, the way a board does in front of you.
  const ranks = myColor === 'w' ? RANKS : [...RANKS].reverse().join('');
  const files = myColor === 'w' ? FILES : [...FILES].reverse().join('');

  return (
    <div className="p-3 flex flex-col gap-2 shrink-0">
      {/* Same primitive Connect 4 uses for the same situation — "what is this
          doing right now, plus the one action that resolves it". */}
      {state.opponentDisconnected && (
        <StatusStrip
          tone="busy"
          detail="They have a moment to come back before the game is called."
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { connection.leaveGame(); dispatch({ type: 'RETURN_TO_LOBBY' }); }}
            >
              Leave
            </Button>
          }
        >
          {state.opponent ?? 'Your opponent'} dropped out — waiting for them to reconnect
        </StatusStrip>
      )}

      <StatusLine play={play} canMove={canMove} isPlaying={isPlaying} opponent={state.opponent} />

      {/* WHY the cqh clamp (2026-09-09): the board was `w-full aspect-square`, so in a pane
          wider than it is tall — the app zoomed to 135 % on a laptop, or any short window —
          it grew taller than the room and the shell's overflow-hidden cut off ranks 8–5 (the
          promo footage). The shell's game area is a size container (ArcadeShell), so the
          board is its full width OR the container's height less ~11rem (the status line,
          the game chat's few lines, paddings), whichever is smaller. A tall pane is
          unchanged; a short one gets a smaller board and keeps the chat. Where no container
          is queryable the unit falls back to the viewport, which is also fine. */}
      <div className="relative">
        <div className="aspect-square mx-auto grid grid-cols-8 grid-rows-8 rounded-md overflow-hidden border border-edge" style={{ width: 'min(100%, calc(100cqh - 11rem))' }}>
          {[...ranks].map((rank, r) =>
            [...files].map((file, c) => {
              const name = `${file}${rank}`;
              const piece = pieces[name];
              // Light/dark alternates by the SQUARE's real coordinates, so
              // flipping the board for black doesn't recolour it.
              const dark = (FILES.indexOf(file) + Number(rank)) % 2 === 0;
              const isSelected = selected === name;
              const isTarget = targets.includes(name);
              const isCheck = play.checkSquare === name;
              const isLast = play.lastMove?.from === name || play.lastMove?.to === name;
              const mine = piece?.color === myColor;
              const interactive = canMove && ((mine ?? false) || isTarget);

              return (
                <button
                  key={name}
                  type="button"
                  // A real button, so the board is playable from the keyboard
                  // (§10). Only the squares you could actually act on take a
                  // tab stop — 64 stops would bury the rest of the pane.
                  tabIndex={interactive ? 0 : -1}
                  aria-label={squareLabel(name, piece, isTarget, isSelected)}
                  aria-pressed={isSelected}
                  onClick={() => onSquare(name)}
                  className={[
                    'relative flex items-center justify-center select-none p-0 border-0',
                    // The board's base surface. The two square shades are made
                    // by the OVERLAY below, not by two background classes —
                    // see boardOverlay().
                    shading === 'today' ? (dark ? 'bg-well' : 'bg-inset') : 'bg-inset',
                    interactive ? 'cursor-pointer' : 'cursor-default',
                  ].join(' ')}
                >
                  {/* The dark square's shade. A real overlay layer, because two
                      `bg-*` utilities on one element DO NOT BLEND — one simply
                      wins. That is why the old `bg-inset bg-accent/[0.07]` light
                      square rendered as flat `--inset` and the board's two
                      shades were the raw tokens, one ladder rung apart. */}
                  {dark && shadeStyle && (
                    <span className="absolute inset-0" style={shadeStyle} aria-hidden="true" />
                  )}

                  {/* Highlights are WASHES over the square, never a third square
                      colour — so they stack on either shade without inventing a
                      fourth surface. */}
                  {isLast && !isSelected && (
                    <span className="absolute inset-0 bg-accent/20" aria-hidden="true" />
                  )}
                  {isCheck && <span className="absolute inset-0 bg-destructive/30" aria-hidden="true" />}

                  {/* THE PICKED-UP SQUARE (deck step S-2). Ring first, wash
                      second: the ring is a hard edge at full accent strength,
                      which is the cue that survives a light theme where a 25%
                      wash all but vanished. */}
                  {isSelected && (
                    <>
                      <span className="absolute inset-0 bg-accent/35" aria-hidden="true" />
                      <span className="absolute inset-0 ring-2 ring-inset ring-accent" aria-hidden="true" />
                    </>
                  )}

                  {isTarget && !piece && (
                    <span className="absolute w-[24%] h-[24%] rounded-full bg-accent/60" aria-hidden="true" />
                  )}
                  {isTarget && piece && (
                    <span className="absolute inset-0 ring-2 ring-inset ring-accent/70" aria-hidden="true" />
                  )}

                  {piece && (
                    <Piece
                      piece={piece}
                      yours={piece.color === myColor}
                      treatment={treatment}
                      lifted={isSelected}
                    />
                  )}

                  {/* Coordinates, in the two margins a real board prints them.
                      Cheap, and it is how a player says "knight to f3" out loud
                      to the person they are playing. */}
                  {c === 0 && (
                    <span className="absolute top-0 left-0.5 text-3xs leading-none pt-0.5 text-fg-muted" aria-hidden="true">{rank}</span>
                  )}
                  {r === 7 && (
                    <span className="absolute bottom-0 right-0.5 text-3xs leading-none pb-0.5 text-fg-muted" aria-hidden="true">{file}</span>
                  )}
                </button>
              );
            }),
          )}
        </div>

        {promoting && (
          <PromotionPicker
            onPick={(p) => send(promoting.from, promoting.to, p)}
            onCancel={() => setPromoting(null)}
            treatment={treatment}
          />
        )}
      </div>

      {/* Plain-word legend. The board's rule is not self-evident the first time
          you see it, and one line is cheaper than a player discovering it by
          moving the wrong piece. */}
      <div className="flex items-center gap-4">
        <LegendDot className="bg-accent" label="You" />
        <LegendDot className={treatment === 'outline' ? 'bg-fg-dim' : 'bg-fg-muted'} label="Opponent" />
      </div>
    </div>
  );
}

/** Whose move it is, or how the game ended — in words, not a colour. */
function StatusLine({
  play, canMove, isPlaying, opponent,
}: { play: ChessPlay; canMove: boolean; isPlaying: boolean; opponent: string | null }) {
  const them = opponent ?? 'Opponent';
  let text = '';
  if (play.over) {
    text = END_TEXT[play.over.reason];
  } else if (isPlaying) {
    const check = play.checkSquare ? 'Check — ' : '';
    text = `${check}${canMove ? 'your turn' : `${them}'s turn`}`;
  }

  return (
    <div className="flex items-center justify-between text-xs">
      <div className="flex items-center gap-1.5">
        <span className="w-3 h-3 rounded-full bg-accent" />
        <span className="text-fg-dim">You</span>
      </div>
      <div className={`text-xs font-medium px-2 py-0.5 rounded-full first-letter:uppercase ${
        canMove ? 'bg-inset/50 text-fg-2' : 'bg-inset text-fg-muted'
      }`}>
        {text}
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-fg-dim">{them}</span>
        <span className="w-3 h-3 rounded-full bg-fg-muted" />
      </div>
    </div>
  );
}

/** Why the game stopped, said plainly. "Draw" alone tells a player nothing
 *  about what just happened to them. */
const END_TEXT: Record<string, string> = {
  'checkmate': 'Checkmate',
  'stalemate': 'Stalemate — draw',
  'insufficient-material': 'Draw — not enough pieces to mate',
  'threefold-repetition': 'Draw — same position three times',
  'fifty-move': 'Draw — fifty moves without a capture',
};

/** The pawn reached the far rank. It cannot move until you say what it becomes,
 *  so this is a blocking choice rather than a silent default to a queen —
 *  under-promoting to a knight is a real move people make. */
function PromotionPicker({
  onPick, onCancel, treatment,
}: { onPick: (p: PromotionPiece) => void; onCancel: () => void; treatment: PieceTreatment }) {
  // Always the SOLID set here: these are YOUR pieces, and yours are solid in
  // every treatment. `treatment` is still taken so the disc trial can restyle
  // this card without a second signature change.
  const glyphs = treatment === 'disc' ? SOLID : SOLID;
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-canvas/70 rounded-md">
      <div className="flex flex-col items-center gap-2 px-4 py-3 rounded-lg bg-panel border border-edge shadow-lg">
        <span className="text-xs text-fg-2">Promote to</span>
        <div className="flex gap-1">
          {(['q', 'r', 'b', 'n'] as const).map((p) => (
            <button
              key={p}
              type="button"
              aria-label={`Promote to ${PIECE_NAMES[p]}`}
              onClick={() => onPick(p)}
              className="w-10 h-10 flex items-center justify-center rounded-md bg-inset hover:bg-accent/20 border border-edge-dim text-fg text-xl leading-none transition-colors"
            >
              {glyphs[p]}
            </button>
          ))}
        </div>
        {/* Ghost, not a second primary — G-4 allows one primary per view and
            the four piece buttons already are the decision. */}
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

/** One piece, in whichever treatment is being trialled.
 *
 *  Drawn as SVG text in a 100×100 viewBox rather than a font-size in px or vw:
 *  the pane is user-resizable (§4.3), so the glyph has to scale with the square
 *  it sits in. The viewBox does that for free — the old `min(6.2vw, 32px)`
 *  scaled with the WINDOW, which is the wrong thing entirely once the pane can
 *  be dragged. */
function Piece({
  piece, yours, treatment, lifted,
}: { piece: PlacedPiece; yours: boolean; treatment: PieceTreatment; lifted: boolean }) {
  const key = piece.type;
  // The lift is the third selection cue (deck step S-2): a picked-up piece
  // visibly comes off the board instead of only sitting on a tinted square.
  const size = lifted ? 'w-[92%] h-[92%]' : 'w-[78%] h-[78%]';

  if (treatment === 'disc' && yours) {
    // The strongest separation available without inventing a colour: your piece
    // sits ON the accent, exactly as your chat bubble and your leaderboard row
    // do. `on-accent` is computed per theme to be legible on that accent
    // (theme-validator.ts), so this cannot go grey-on-grey in any pack.
    return (
      <span className="relative flex items-center justify-center w-[80%] h-[80%] rounded-full bg-accent">
        <Glyph char={SOLID[key]!} className="text-on-accent w-[78%] h-[78%]" />
      </span>
    );
  }
  if (treatment === 'outline') {
    // The chess convention: the two sets differ in SHAPE, not only in colour,
    // so they stay distinct even where a theme's accent is itself a grey.
    return (
      <Glyph
        char={(yours ? SOLID[key] : OUTLINE[key])!}
        className={`${yours ? 'text-fg' : 'text-fg-dim'} ${size} transition-all`}
      />
    );
  }
  return (
    <Glyph
      char={SOLID[key]!}
      className={`${yours ? 'text-accent' : 'text-fg-muted'} ${size} transition-all`}
    />
  );
}

function Glyph({ char, className }: { char: string; className: string }) {
  return (
    <svg viewBox="0 0 100 100" className={`relative pointer-events-none ${className}`} aria-hidden="true">
      <text
        x="50"
        y="54"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="88"
        fill="currentColor"
      >
        {char}
      </text>
    </svg>
  );
}

function squareLabel(
  square: string,
  piece: PlacedPiece | undefined,
  isTarget: boolean,
  isSelected: boolean,
): string {
  const what = piece ? `${piece.color === 'w' ? 'white' : 'black'} ${PIECE_NAMES[piece.type]}` : 'empty';
  const suffix = isSelected ? ', selected' : isTarget ? ', legal move' : '';
  return `${square}, ${what}${suffix}`;
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`w-2.5 h-2.5 rounded-full ${className}`} aria-hidden="true" />
      <span className="text-2xs text-fg-muted">{label}</span>
    </span>
  );
}
