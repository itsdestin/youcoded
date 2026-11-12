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

/**
 * The program size this screen last gave a terminal, and the window it was decided for.
 *
 * WHY (Destin, 2026-11-04, a brand-new phone session: "still duplication, see claude code version line"): the first
 * line of Claude Code's welcome banner was printed twice. Every new session's program started at the spawn default
 * (80×24 — the phone's log: "pty spawn size 80 24", then "resize 47 41" 0.2-0.5 s later, when its hidden terminal
 * worked out its real size). By then Claude Code had begun drawing at 80 columns, and redrawing at 47 left the first
 * line behind. Asking for the remembered size when the session is created means the program starts at the size it
 * keeps, so there is no resize and nothing to redraw. Only offered for the same window size: after a turn or a fold
 * nothing is offered and the old default applies, exactly as before. Per-viewer convenience: no storage, no guess.
 */
const PROGRAM_KEY = 'youcoded:terminal-program-size';
export function saveProgramSize(cols: number, rows: number): void {
  try {
    if (cols > 0 && rows > 0) localStorage.setItem(PROGRAM_KEY, JSON.stringify({ cols, rows, w: window.innerWidth, h: window.innerHeight }));
  } catch { /* ignore */ }
}
function programSizeGuess(): { cols: number; rows: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(PROGRAM_KEY) || 'null');
    if (!v || v.w !== window.innerWidth || v.h !== window.innerHeight) return null;
    if (!Number.isInteger(v.cols) || !Number.isInteger(v.rows) || v.cols < 1 || v.rows < 1 || v.cols > 1000 || v.rows > 1000) return null;
    return { cols: v.cols, rows: v.rows };
  } catch { return null; }
}
/** A new session's start request with the remembered size added — remote-shim's session.create (the phone's). A
 *  caller's own size wins; no guess, no size (the backend's 80×24 default, as before). */
export function withStartSize<T extends { cols?: number; rows?: number }>(opts: T): T {
  const size = opts && opts.cols === undefined && opts.rows === undefined ? programSizeGuess() : null;
  return size ? { ...opts, ...size } : opts;
}
