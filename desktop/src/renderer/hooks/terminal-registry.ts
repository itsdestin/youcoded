import { Terminal } from '@xterm/xterm';

const terminals = new Map<string, Terminal>();

// Pub/sub for write-completion notifications
type BufferReadyCallback = (sessionId: string) => void;
const bufferReadyListeners = new Set<BufferReadyCallback>();

export function onBufferReady(cb: BufferReadyCallback): () => void {
  bufferReadyListeners.add(cb);
  // Fire immediately for all existing terminals so the new subscriber can
  // read any content already in the buffer. This handles the race where
  // TerminalView's signalReady flushes buffered PTY output (triggering
  // notifyBufferReady) before the prompt detector subscribes — React runs
  // child effects before parent effects, so the child's flush fires with
  // zero listeners. This catch-up ensures nothing is missed.
  if (terminals.size > 0) {
    queueMicrotask(() => {
      for (const sessionId of terminals.keys()) {
        cb(sessionId);
      }
    });
  }
  return () => bufferReadyListeners.delete(cb);
}

// Batch buffer-ready notifications via requestAnimationFrame — during heavy PTY
// output, xterm.write completions fire many times per frame.  Without batching,
// each completion triggers a full terminal-buffer scan in the prompt detector
// and a TERMINAL_ACTIVITY dispatch, overwhelming the main thread.
const dirtySessions = new Set<string>();
let rafPending = false;

function flushBufferReady() {
  rafPending = false;
  const sessions = Array.from(dirtySessions);
  dirtySessions.clear();
  for (const sid of sessions) {
    bufferReadyListeners.forEach((cb) => cb(sid));
  }
}

export function notifyBufferReady(sessionId: string) {
  dirtySessions.add(sessionId);
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(flushBufferReady);
  }
}

// WHY (2026-09-10): rig instrument; the heal costs every open terminal a
// re-rasterize, so the rig counts clears per switch. TerminalView's glyph-atlas
// heal clears the texture atlas SHARED by every open terminal, and nothing
// measured how often that happens. The perf rig
// (youcoded-dev scripts/perf-lab/scenario-terminal.mjs) reads this through
// window.__terminalRegistry.atlasClears before and after each session switch.
// A plain module counter: no timers, no allocation, no effect on rendering.
let atlasClears = 0;

/** Record one clearTextureAtlas() call. Called from BOTH heal sites in TerminalView. */
export function noteAtlasClear(): void {
  atlasClears++;
}

/** How many times any terminal has cleared the shared glyph atlas since load. */
export function getAtlasClears(): number {
  return atlasClears;
}

export function registerTerminal(sessionId: string, terminal: Terminal) {
  terminals.set(sessionId, terminal);
}

export function unregisterTerminal(sessionId: string) {
  terminals.delete(sessionId);
}

/**
 * Serialize the terminal buffer to text, joining wrapped lines.
 *
 * @param tailRows When set, only the last `tailRows` buffer rows are
 *   serialized (walked back to the nearest logical-line start so a wrapped
 *   line is never cut). The hot callers only need the tail — the prompt
 *   detector reads once per buffer flush (up to ~60/s while Claude streams)
 *   and the attention classifier keeps just the last 40 lines — so
 *   serializing the full scrollback (1000+ rows × translateToString) on
 *   every read was the single largest renderer CPU cost during streaming.
 *   Omit for the full buffer.
 */
export function getScreenText(sessionId: string, tailRows?: number): string | null {
  const terminal = terminals.get(sessionId);
  if (!terminal) return null;

  // Guard against accessing a disposed terminal's buffer
  let buf;
  try {
    buf = terminal.buffer.active;
  } catch {
    return null;
  }

  let start = 0;
  if (tailRows !== undefined && buf.length > tailRows) {
    start = buf.length - tailRows;
    // Never start mid-wrapped-line: walk back to the logical line start so
    // the join below sees the whole first line, not a fragment.
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
    if (line.isWrapped) {
      // Continuation of previous line — append without newline
      current += text;
    } else {
      if (current) lines.push(current);
      current = text;
    }
  }
  if (current) lines.push(current);

  return lines.join('\n');
}

// Extra rows past the visible screen so a wrapped line straddling the
// boundary still joins completely, with headroom for tall Ink menus.
const VISIBLE_TAIL_MARGIN_ROWS = 40;

/**
 * The visible screen (plus a wrap-join margin) — the cheap read for hot
 * callers. Ink menus render at the bottom of the screen, so the prompt
 * detector never needs scrollback; feeding it less than the full buffer also
 * stops menus that scrolled AWAY from shadowing a live one.
 */
export function getVisibleScreenText(sessionId: string): string | null {
  const terminal = terminals.get(sessionId);
  if (!terminal) return null;
  return getScreenText(sessionId, terminal.rows + VISIBLE_TAIL_MARGIN_ROWS);
}
