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

export function registerTerminal(sessionId: string, terminal: Terminal) {
  terminals.set(sessionId, terminal);
}

export function unregisterTerminal(sessionId: string) {
  terminals.delete(sessionId);
}

export function getScreenText(sessionId: string): string | null {
  const terminal = terminals.get(sessionId);
  if (!terminal) return null;

  // Guard against accessing a disposed terminal's buffer
  let buf;
  try {
    buf = terminal.buffer.active;
  } catch {
    return null;
  }
  const lines: string[] = [];
  let current = '';

  for (let i = 0; i < buf.length; i++) {
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
