// terminal-screen-text.ts — turn a terminal's buffer into the text the attention check and the card reader look at.
//
// WHY (2026-10-01 one-core R5-4b): the renderer's terminal registry and the computer's own headless copy of a session's terminal (main/session-screens.ts)
// must read a screen IDENTICALLY, or "stuck" and the cards would depend on which of them looked. This is the one reader; both pass their own xterm
// buffer in (the buffer shape is the same in @xterm/xterm and @xterm/headless). Pure: no DOM, no Electron.

/** The slice of an xterm buffer this reads (declared here so neither xterm package has to be imported). */
export interface ScreenBuffer {
  readonly length: number;
  getLine(y: number): { readonly isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined;
}

/**
 * The buffer as text, wrapped rows joined into one logical line.
 *
 * @param tailRows When set, only the last `tailRows` buffer rows are read (walked back to the nearest logical-line start so a wrapped line is never cut).
 *   The hot callers only need the tail: the card reader reads on every flush and the attention check asks for 40 rows once a second, and reading
 *   the whole scrollback each time was the single largest renderer CPU cost during streaming.
 */
export function screenTextOf(buf: ScreenBuffer, tailRows?: number): string {
  let start = 0;
  if (tailRows !== undefined && buf.length > tailRows) {
    start = buf.length - tailRows;
    // Never start mid-wrapped-line: walk back to the logical line start so the join below sees the whole first line, not a fragment.
    while (start > 0) {
      const line = buf.getLine(start);
      if (!line || !line.isWrapped) break;
      start--;
    }
  }
  const lines: string[] = [];
  let current = '';
  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped) current += text; // continuation of the previous line: append without a newline
    else {
      if (current) lines.push(current);
      current = text;
    }
  }
  if (current) lines.push(current);
  return lines.join('\n');
}

/** Rows past the visible screen so a wrapped line straddling the top edge still joins completely, with headroom for tall Ink menus. */
export const VISIBLE_TAIL_MARGIN_ROWS = 40;

/** The visible screen plus the wrap-join margin: the cheap read for hot callers. Ink menus render at the bottom, so scrollback is never needed. */
export function visibleScreenTextOf(buf: ScreenBuffer, rows: number): string {
  return screenTextOf(buf, rows + VISIBLE_TAIL_MARGIN_ROWS);
}
