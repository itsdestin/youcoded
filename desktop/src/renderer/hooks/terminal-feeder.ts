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
// A WINDOW THAT IS HIDDEN OR MINIMISED (document.hidden) is different from a hidden terminal: the browser
// stretches every timer to ~1 s there, and xterm's parse loop is timer-driven, so its "drawn" confirmations
// would arrive a few per second and the braked program (and a phone watching it) would crawl. Nobody can see
// that window, so the confirmations cannot be trusted to pace anything: the feeder confirms on RECEIPT
// instead (the program runs at full speed, as before the brake existed), keeps the newest DOC_HIDDEN_CAP
// characters it has not yet handed to xterm (older ones are dropped — scrollback eviction, a flood past that
// size would have scrolled them off anyway) and writes them as time allows. Coming back to the window
// writes the rest at once. Memory stays bounded either way.
//
// This only applies where the brake actually exists: the desktop's own window. A remote browser / the
// phone app has no brake (and a hidden queue there would just grow), so it writes straight through.

export const HIDDEN_RATE = 512 * 1024;      // characters per second, sustained, while hidden
export const HIDDEN_BURST = 1024 * 1024;    // characters that pass instantly after a quiet spell
const HIDDEN_TICK_MS = 50;           // how often a backlog is topped up
// Safety valve: the brake upstream already bounds the backlog to ~1 M, so this only trips if that
// ever stops being true (a non-owner window that is never braked). Past it, write everything through
// rather than let a queue grow without bound.
export const HIDDEN_QUEUE_MAX = 4 * 1024 * 1024;
// Window hidden/minimised: newest characters kept un-drawn (~50-100k lines, well past xterm's scrollback).
export const DOC_HIDDEN_CAP = 4 * 1024 * 1024;

export interface TerminalFeederOptions {
  /** Hand text to the terminal; call `done` once it has been PARSED (xterm's write callback). */
  write(data: string, done: () => void): void;
  /** Tell main this many characters were parsed. */
  ack(chars: number): void;
  isHidden(): boolean;
  /** The whole window is hidden/minimised (timers throttled). Default: document.visibilityState. */
  isDocHidden?(): boolean;
  /** False where there is no upstream brake (remote browser, phone app): never hold anything back. */
  throttleHidden: boolean;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export interface TerminalFeeder {
  /** New output from the PTY. */
  push(data: string): void;
  /** The window was hidden/shown: re-read isDocHidden() now (the module listener calls this). */
  docVisibilityChanged(): void;
  /** The terminal became visible (or must catch up now): write everything queued. */
  wake(): void;
  /** The terminal is going away: release everything still owed so the program is not left braked. */
  dispose(): void;
  /** Characters waiting in the hidden backlog (tests, diagnostics). */
  queued(): number;
}

interface Item { s: string; paid: boolean; }

const feeders = new Set<() => void>();
let docListener = false;
function watchDocument(onChange: () => void): () => void {
  feeders.add(onChange);
  if (!docListener && typeof document !== 'undefined') {
    docListener = true;
    // One listener for every terminal: not one per hidden terminal.
    document.addEventListener('visibilitychange', () => feeders.forEach((f) => f()));
  }
  return () => feeders.delete(onChange);
}

export function createTerminalFeeder(opts: TerminalFeederOptions): TerminalFeeder {
  const now = opts.now ?? (() => performance.now());
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const docHidden = opts.isDocHidden ?? (() => typeof document !== 'undefined' && document.visibilityState === 'hidden');

  const queue: Item[] = [];
  let queuedChars = 0;
  let queuedUnpaid = 0;
  let outstanding = 0;        // written to xterm, callback not yet fired, NOT yet confirmed upstream
  let tokens = HIDDEN_BURST;
  let lastRefill = now();
  let timer: unknown = null;
  let disposed = false;
  let dropped = false;        // text was cut from the queue: reset colours before the next write
  let docWasHidden = false;
  let paidEpoch = 0;          // bumped by payAll(): writes issued earlier were already confirmed upstream

  const writeNow = (data: string, paid: boolean) => {
    if (data.length === 0) return;
    if (dropped) { dropped = false; data = '\x1b[0m' + data; }
    const n = data.length;
    const epoch = paidEpoch;
    if (!paid) outstanding += n;
    opts.write(data, () => {
      // After dispose() or payAll() everything owed was already released in one go; do not release it twice.
      if (disposed || paid || epoch !== paidEpoch) return;
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
    while (queue.length) { const it = queue.shift()!; writeNow(it.s, it.paid); }
    queuedChars = 0; queuedUnpaid = 0;
    tokens = HIDDEN_BURST;
    lastRefill = now();
  };

  // Confirm upstream everything not yet confirmed (the window just went out of sight).
  const payAll = () => {
    const owed = outstanding + queuedUnpaid;
    for (const it of queue) it.paid = true;
    outstanding = 0; queuedUnpaid = 0;
    paidEpoch++;   // writes already in xterm must not be confirmed again when their callbacks fire
    if (owed > 0) opts.ack(owed);
  };

  const drainSome = () => {
    timer = null;
    if (disposed) return;
    if (!opts.isHidden() && !docHidden()) { drainAll(); return; }
    refill();
    while (queue.length && tokens >= 1) {
      const it = queue[0];
      const head = it.s;
      let take = Math.min(head.length, Math.floor(tokens));
      // Never cut between the two halves of a surrogate pair (xterm would draw two broken halves).
      if (take < head.length) {
        const c = head.charCodeAt(take - 1);
        if (c >= 0xd800 && c <= 0xdbff) take += 1;
      }
      const whole = take >= head.length;
      const piece = whole ? head : head.slice(0, take);
      if (whole) queue.shift(); else it.s = head.slice(take);
      queuedChars -= piece.length;
      if (!it.paid) queuedUnpaid -= piece.length;
      tokens -= take;
      writeNow(piece, it.paid);
    }
    if (queue.length) timer = setTimer(drainSome, HIDDEN_TICK_MS);
  };

  const enqueue = (data: string, paid: boolean) => {
    queue.push({ s: data, paid });
    queuedChars += data.length;
    if (!paid) queuedUnpaid += data.length;
    if (timer === null) timer = setTimer(drainSome, HIDDEN_TICK_MS);
  };

  const onDocChange = () => {
    if (disposed) return;
    const h = docHidden();
    if (h === docWasHidden) return;
    docWasHidden = h;
    if (h && opts.throttleHidden) payAll();
    if (!h) { if (!opts.isHidden() && queue.length) drainAll(); else if (queue.length && timer === null) timer = setTimer(drainSome, HIDDEN_TICK_MS); }
  };
  const unwatch = opts.throttleHidden ? watchDocument(onDocChange) : () => {};

  return {
    push(data: string) {
      if (disposed || data.length === 0) return;
      if (opts.throttleHidden && docHidden()) {
        // Window out of sight: confirm on receipt (see the header), keep only the newest DOC_HIDDEN_CAP.
        if (!docWasHidden) { docWasHidden = true; payAll(); }
        opts.ack(data.length);
        refill();
        if (queue.length === 0 && tokens >= data.length) { tokens -= data.length; writeNow(data, true); return; }
        enqueue(data, true);
        while (queuedChars > DOC_HIDDEN_CAP && queue.length > 1) {
          const cut = queue.shift()!;
          queuedChars -= cut.s.length;
          if (!cut.paid) { queuedUnpaid -= cut.s.length; opts.ack(cut.s.length); }
          dropped = true;
        }
        return;
      }
      if (docWasHidden) { docWasHidden = false; }
      if (!opts.throttleHidden || !opts.isHidden()) {
        // Visible: straight through, exactly as before (no added latency). Anything left over from a
        // hidden spell goes first so the text stays in order.
        if (queue.length) drainAll();
        writeNow(data, false);
        return;
      }
      refill();
      if (queue.length === 0 && tokens >= data.length) {
        tokens -= data.length;
        writeNow(data, false);
        return;
      }
      enqueue(data, false);
      if (queuedChars > HIDDEN_QUEUE_MAX) drainAll();
    },
    docVisibilityChanged: onDocChange,
    wake() {
      if (disposed) return;
      if (queue.length) drainAll();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unwatch();
      if (timer !== null) { clearTimer(timer); timer = null; }
      const owed = outstanding + queuedUnpaid;
      queue.length = 0;
      queuedChars = 0; queuedUnpaid = 0;
      outstanding = 0;
      if (owed > 0) opts.ack(owed);
    },
    queued: () => queuedChars,
  };
}
