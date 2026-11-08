// What a one-finger swipe in terminal view does, as a pure decision (TerminalView's touch handler).
//
// WHY (card #213; Destin 2026-11-08: "okay" to fullscreen plus the swipe fix): the phone now starts
// Claude Code in its fullscreen display mode (main/tui-fullscreen-default.ts). There Claude Code
// draws on the terminal's alternate screen, which has no history of its own: xterm holds only the
// visible rows, so scrolling xterm (what a swipe always did) moves nothing. Claude Code keeps the
// conversation itself and scrolls it on mouse-wheel reports, which it asks for by turning mouse
// tracking on (both seen in docs/active/investigations/2026-11-08-phone-fullscreen-mode.md). So on
// the alternate screen with mouse tracking on, a swipe becomes wheel reports to the program; in
// every other case it scrolls xterm's history as before.

export type SwipeAction =
  | { kind: 'scroll-history'; lines: number }
  | { kind: 'send'; data: string };

// Most wheel reports sent for one touchmove: a fast fling must not flood the program.
const MAX_WHEEL_PER_MOVE = 10;

/** `lines` > 0 = finger moved up = show newer; < 0 = finger moved down = show older.
 *  SGR wheel report: ESC[<64;x;yM is wheel up (older), 65 is wheel down (newer), at a cell
 *  in the middle of the screen (1-based) so it lands on the conversation, not the input box. */
export function swipeAction(
  lines: number,
  screen: { alternate: boolean; mouseTracking: boolean; cols: number; rows: number },
): SwipeAction {
  if (!screen.alternate || !screen.mouseTracking) return { kind: 'scroll-history', lines };
  const n = Math.min(Math.abs(lines), MAX_WHEEL_PER_MOVE);
  const button = lines < 0 ? 64 : 65;
  const x = Math.max(1, Math.floor(screen.cols / 2));
  const y = Math.max(1, Math.floor(screen.rows / 3));
  return { kind: 'send', data: `\x1b[<${button};${x};${y}M`.repeat(n) };
}
