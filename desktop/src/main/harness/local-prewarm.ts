// Reading a local chat's opening in the background, before the user sends.
//
// WHY (2026-11-07, Destin: "prompt processing also feels miserably slow"):
// every native chat opens with ~13-19k tokens of instructions and tool
// descriptions, and a local model on a laptop chip reads ~100-150 a second —
// so the FIRST reply in a chat waited one to three minutes before a word
// appeared, while the model sat loaded and idle the whole time the user was
// typing. llama.cpp keeps what it has read and reuses any matching start of
// the next request, so reading the opening while the user types makes that
// first reply start in about a second.
//
// Measured 2026-11-07 on the Z13 (Qwen3.8 27B, b10665 Vulkan, 13k-token
// opening): background read 80 s, then the real first message read 24 new
// tokens and reused 12,961 (0.75 s).
//
// The one thing this must never do is make a reply SLOWER. The engine has
// four slots, so a message sent while the background read is still going
// goes to a second slot and reads the whole opening AGAIN, side by side:
// measured, that message took 140 s instead of the ~80 s it would have taken
// alone. So a turn that starts during a background read WAITS for it (and
// then reuses it); one that starts before the read even began cancels it.
// Only one background read runs at a time, app-wide, so opening several chats
// does not have them all competing for the chip.

/** What a finished background read covered. */
export interface WarmRead {
  /** The history messages (by identity) the read included before its placeholder. */
  prefix: readonly unknown[];
  modelId: string;
  /** Estimated tokens the read covered — the next request's already-read part. */
  promptTokens: number;
}

interface Run { abort: AbortController; started: boolean; done: Promise<void> }

/** One background read at a time across every chat. */
let queue: Promise<void> = Promise.resolve();

export class LocalPrewarm {
  private current: Run | null = null;
  private warm: WarmRead | null = null;

  /** Start (or restart) this chat's background read. `read` sends the request
   *  and resolves with what it covered; a failure only means no head start. */
  start(read: (signal: AbortSignal) => Promise<WarmRead>): void {
    this.cancel();
    const run: Run = { abort: new AbortController(), started: false, done: Promise.resolve() };
    const before = queue;
    run.done = (async () => {
      await before;
      if (run.abort.signal.aborted) return;
      run.started = true;
      try {
        const w = await read(run.abort.signal);
        if (this.current === run && !run.abort.signal.aborted) this.warm = w;
      } catch { /* engine busy, stopped or refused: the turn simply reads it itself */ }
      if (this.current === run) this.current = null;
    })();
    queue = run.done;
    this.current = run;
  }

  /** Called as a turn starts. A read that has not begun is dropped; a read in
   *  progress is waited for (`onWait` runs first; Stop ends the wait AND the
   *  read). Returns the finished read, if any — at most once. */
  async beforeTurn(turnSignal: AbortSignal, onWait: () => void): Promise<WarmRead | null> {
    const run = this.current;
    if (run && !run.started) this.cancel();
    else if (run) {
      onWait();
      const stop = () => run.abort.abort();
      turnSignal.addEventListener('abort', stop, { once: true });
      try { await run.done; } finally { turnSignal.removeEventListener('abort', stop); }
    }
    const w = this.warm;
    this.warm = null;
    return w;
  }

  /** The chat changed model, closed, or no longer matches what was read. */
  cancel(): void {
    this.current?.abort.abort();
    this.current = null;
    this.warm = null;
  }
}
