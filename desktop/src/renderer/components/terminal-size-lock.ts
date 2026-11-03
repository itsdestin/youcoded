// When a phone's terminal may tell Claude Code a new size, and how far its grid slides up when it may not
// (TerminalView's fitAndSync — why).
//
// WHY (Destin, 2026-11-03: "still getting issues with duplicated lines"): every new size makes Claude Code redraw its
// screen in place, and when its conversation is taller than the screen that redraw cannot reach the lines that have
// already scrolled up — so lines come out twice, or go missing. Measured with Claude Code 2.1.300 (the phone's) and
// 2.1.317 in a real terminal: four rows more printed four lines twice; four rows fewer lost four; a width change
// printed a whole screen twice. On a phone the terminal's height followed the message box floating over it, so typing
// a second line, or the first time the terminal view was opened, resized the program. Now, on a touch screen, only a
// real change of the window (a turn, a fold, a split screen), of the column count or of the character size gives the
// program a new size. When only the box over the terminal grows, the grid keeps its rows and slides up by the overlap
// (the same way it slides up with the keyboard), so its last lines stay visible above the box.

/** What the terminal's size was decided for. */
export interface SizeBasis {
  /** The window, in CSS px (window.innerWidth / innerHeight). */
  winW: number; winH: number;
  /** xterm's character cell, in CSS px; 0 when not known yet. */
  cellW: number; cellH: number;
  /** The column count that was decided. */
  cols: number;
}

/** True when a fit may NOT resize the program: the same window, the same character size and the same column count
 *  as last time, so the only thing that moved is the chrome over the terminal (the message box growing a line, the
 *  key row, a strip appearing). The first decision (no basis yet) always fits. */
export function keepProgramSize(prev: SizeBasis | null, now: SizeBasis): boolean {
  return !!prev
    && prev.winW === now.winW && prev.winH === now.winH
    && prev.cellW === now.cellW && prev.cellH === now.cellH
    && prev.cols === now.cols;
}

/** How far the grid must slide up so its last row sits inside its box (0 when the rows fit). CSS px, whole pixels. */
export function gridOverflow(rows: number, cellH: number, padY: number, boxHeight: number): number {
  if (!(cellH > 0) || !(rows > 0)) return 0;
  return Math.max(0, Math.ceil(rows * cellH + padY - boxHeight));
}
