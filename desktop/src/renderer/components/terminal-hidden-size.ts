// The size a hidden terminal WILL have once shown, worked out while it is collapsed (TerminalView — why).
// The same arithmetic as @xterm/addon-fit's proposeDimensions, so the first real fit agrees with it and the program
// is not resized (and does not redraw) when the terminal is first shown.

export interface HiddenSizeInput {
  /** The box the terminal fills when shown (its wrapper's parent), in CSS px. */
  hostWidth: number; hostHeight: number;
  /** The grid container's insets inside that box. */
  top: number; bottom: number; left: number; right: number;
  /** The .xterm element's padding. */
  padTop: number; padBottom: number; padLeft: number; padRight: number;
  /** What FitAddon subtracts for xterm's scrollbar. */
  scrollbarWidth: number;
  cellWidth: number; cellHeight: number;
}

const MINIMUM_COLS = 2;
const MINIMUM_ROWS = 1;

export function hiddenTerminalSize(i: HiddenSizeInput): { cols: number; rows: number } | null {
  if (!(i.cellWidth > 0) || !(i.cellHeight > 0)) return null;
  // FitAddon reads the container's computed width/height with parseInt, i.e. floored px.
  const width = Math.max(0, Math.floor(i.hostWidth - i.left - i.right));
  const height = Math.floor(i.hostHeight - i.top - i.bottom);
  if (width <= 0 || height <= 0) return null;
  const availableWidth = width - (Math.trunc(i.padLeft) + Math.trunc(i.padRight)) - i.scrollbarWidth;
  const availableHeight = height - (Math.trunc(i.padTop) + Math.trunc(i.padBottom));
  return {
    cols: Math.max(MINIMUM_COLS, Math.floor(availableWidth / i.cellWidth)),
    rows: Math.max(MINIMUM_ROWS, Math.floor(availableHeight / i.cellHeight)),
  };
}

/** The terminal view's bottom inset as last seen on screen — a phone's terminal view has its own input bar, whose
 *  height chat view cannot measure. Per-viewer convenience: missing storage just means the chat bar's height. */
const BOTTOM_KEY = 'youcoded:terminal-bottom-inset';
export function savedTerminalBottomInset(): number | null {
  try { const v = Number(localStorage.getItem(BOTTOM_KEY)); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; }
}
export function saveTerminalBottomInset(px: number): void {
  try { if (px > 0) localStorage.setItem(BOTTOM_KEY, String(Math.round(px))); } catch { /* ignore */ }
}
