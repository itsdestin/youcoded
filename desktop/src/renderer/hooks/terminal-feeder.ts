// Terminal feeder — the renderer's half of PTY flow control (2026-10-04).
//
// THE PROBLEM IT SOLVES: xterm.js keeps an internal queue of text it has been handed but has not yet
// parsed, and once that queue passes ~50 million characters it DISCARDS new input ("write data
// discarded"). The app used to hand it everything the program printed, instantly, with no way for the
// program to slow down, so a `cat` of a huge file lost most of its output — including the final lines
// and the prompt.
//
// HOW: every write reports back when xterm has finished parsing it (`terminal.write(data, callback)`).
// This module turns each such callback into an acknowledgement (`ack(chars)`) that travels
// renderer -> main -> pty-worker.js, where it releases a brake on the program (see the flow-control
// block at the top of pty-worker.js). So at most ~1 M characters are ever waiting here — far below
// xterm's limit — and the program is held back by the kernel, as it would be on a slow real terminal.
//
// HIDDEN TERMINALS: xterm keeps parsing a terminal nobody is looking at (the buffer must stay current for
// the attention classifier and for when you switch back), and parsing was measured to cost as much as a
// visible one (~27% of the window's main thread per MB/s). So a hidden terminal is given a spending
// allowance: a burst of HIDDEN_BURST characters passes at full speed (a Claude Code redraw, a normal
// build log) and a SUSTAINED stream is fed at HIDDEN_RATE per second. The rest waits here, bounded by the
// same brake upstream, and is acknowledged only once actually parsed — so a hidden flooding program is
// slowed instead of eating the window. The moment the terminal becomes visible everything queued is
// written. Nothing is ever dropped.
//
// This only applies where the brake actually exists: the desktop's own window. A remote browser / the
// phone app has no brake (and a hidden queue there would just grow), so it writes straight through.

export const HIDDEN_RATE = 512 * 1024;      // characters per second, sustained, while hidden
export const HIDDEN_BURST = 1024 * 1024;    // characters that pass instantly after a quiet spell
export const HIDDEN_TICK_MS = 50;           // how often a backlog is topped up
// Safety valve: the brake upstream already bounds the backlog to ~1 M, so this only trips if that
// ever stops being true (a non-owner window that is never braked). Past it, write everything through
// rather than let a queue grow without bound.
export const HIDDEN_QUEUE_MAX = 4 * 1024 * 1024;

export interface TerminalFeederOptions {
  /** Hand text to the terminal; call `done` once it has been PARSED (xterm's write callback). */
  write(data: string, done: () => void): void;
  /** Tell main this many characters were parsed. */
  ack(chars: number): void;
  isHidden(): boolean;
  /** False where there is no upstream brake (remote browser, phone app): never hold anything back. */
  throttleHidden: boolean;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export interface TerminalFeeder {
  /** New output from the PTY. */
  push(data: string): void;
  /** The terminal became visible (or must catch up now): write everything queued. */
  wake(): void;
  /** The terminal is going away: release everything still owed so the program is not left braked. */
  dispose(): void;
  /** Characters waiting in the hidden backlog (tests, diagnostics). */
  queued(): number;
}

export function createTerminalFeeder(opts: TerminalFeederOptions): TerminalFeeder {
  const now = opts.now ?? (() => performance.now());
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const queue: string[] = [];
  let queuedChars = 0;
  let outstanding = 0;        // written to xterm, callback not yet fired
  let tokens = HIDDEN_BURST;
  let lastRefill = now();
  let timer: unknown = null;
  let disposed = false;

  const writeNow = (data: string) => {
    if (data.length === 0) return;
    const n = data.length;
    outstanding += n;
    opts.write(data, () => {
      // After dispose() everything owed was already released in one go; do not release it twice.
      if (disposed) return;
      outstanding -= n;
      opts.ack(n);
    });
  };

  const refill = () => {
    const t = now();
    tokens = Math.min(HIDDEN_BURST, tokens + ((t - lastRefill) / 1000) * HIDDEN_RATE);
    lastRefill = t;
  };

  const drainAll = () => {
    if (timer !== null) { clearTimer(timer); timer = null; }
    while (queue.length) writeNow(queue.shift()!);
    queuedChars = 0;
    tokens = HIDDEN_BURST;
    lastRefill = now();
  };

  const drainSome = () => {
    timer = null;
    if (disposed) return;
    if (!opts.isHidden()) { drainAll(); return; }
    refill();
    while (queue.length && tokens >= 1) {
      const head = queue[0];
      let take = Math.min(head.length, Math.floor(tokens));
      // Never cut between the two halves of a surrogate pair (xterm would draw two broken halves).
      if (take < head.length) {
        const c = head.charCodeAt(take - 1);
        if (c >= 0xd800 && c <= 0xdbff) take += 1;
      }
      if (take >= head.length) queue.shift(); else queue[0] = head.slice(take);
      queuedChars -= Math.min(take, head.length);
      tokens -= take;
      writeNow(take >= head.length ? head : head.slice(0, take));
    }
    if (queue.length) timer = setTimer(drainSome, HIDDEN_TICK_MS);
  };

  return {
    push(data: string) {
      if (disposed || data.length === 0) return;
      if (!opts.throttleHidden || !opts.isHidden()) {
        // Visible: straight through, exactly as before (no added latency). Anything left over from a
        // hidden spell goes first so the text stays in order.
        if (queue.length) drainAll();
        writeNow(data);
        return;
      }
      refill();
      if (queue.length === 0 && tokens >= data.length) {
        tokens -= data.length;
        writeNow(data);
        return;
      }
      queue.push(data);
      queuedChars += data.length;
      if (queuedChars > HIDDEN_QUEUE_MAX) { drainAll(); return; }
      if (timer === null) timer = setTimer(drainSome, HIDDEN_TICK_MS);
    },
    wake() {
      if (disposed) return;
      if (queue.length) drainAll();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== null) { clearTimer(timer); timer = null; }
      const owed = outstanding + queuedChars;
      queue.length = 0;
      queuedChars = 0;
      outstanding = 0;
      if (owed > 0) opts.ack(owed);
    },
    queued: () => queuedChars,
  };
}
