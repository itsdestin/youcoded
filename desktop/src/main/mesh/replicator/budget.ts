// Budgets: memory and send rate, in one place so the limits in the plan are numbers a test can read (plan section 3, "Serving a want"; invariant 10).
//
// WHY explicit counters: the replicator serves several peers at once and each batch is read into memory before it is sent. Without a shared
// ceiling, fifteen peers asking for a 300 MB chat would hold gigabytes. A request that does not fit is refused loudly (the peer re-asks later).
export const MAX_SESSIONS = 4;
export const WINDOW_FRAMES = 4;
/** WHY 80 MiB (review 1, F5): a single line may be 64 MiB (the wire cap) and must be readable on its own; the budget used to be 16 MiB, so a 17 MiB line could never be served. The 16 MiB
 *  that is left over is what ordinary batches (at most 640 KiB each) share. */
export const READ_BUFFER_BUDGET_BYTES = 80 * 1024 * 1024;
/** One peer may hold this many of the shared serve sessions (F6): one device cannot fill all four. */
export const MAX_SESSIONS_PER_PEER = 2;
/** Entries kept per peer for versions it has told me about, and unknown-version announcement requests I will make per peer per period (F6). */
export const MAX_PEER_HEADS = 20_000;
export const MAX_INTRO_ASKS_PER_PERIOD = 32;
export const INTRO_PERIOD_MS = 60_000;
/** An unfinished reassembly is dropped after this long without a new part (F6). */
export const REASSEMBLY_IDLE_MS = 30_000;
/** A version-queue step that has not finished after this long is reported blocked (F8). */
export const QUEUE_STEP_LIMIT_MS = 120_000;
export const REASSEMBLY_BUDGET_BYTES = 64 * 1024 * 1024;
/** The relay allows 100 holds a second per device (RATE_MAX_HOLDS); the replicator stays far under it so control traffic always has room. */
export const MAX_HOLDS_PER_SECOND = 6;

/** A pool of bytes. `take` is all-or-nothing; `give` returns what was taken. Going below zero or above the ceiling is a programming error and throws. */
export class ByteBudget {
  #used = 0;
  constructor(readonly ceiling: number) {}
  get used(): number { return this.#used; }
  take(n: number): boolean {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('bad take');
    if (this.#used + n > this.ceiling) return false;
    this.#used += n;
    return true;
  }
  give(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.#used) throw new RangeError('gave back more than was taken');
    this.#used -= n;
  }
}

/** Token bucket on the replicator's own clock (virtual in tests): at most `perSecond` takes per second, a burst of `perSecond`. */
export class RateLimiter {
  #tokens: number;
  #last: number;
  /** `burst` defaults to `perSecond` (a bucket that holds one second's worth). */
  constructor(private readonly perSecond: number, private readonly now: () => number, private readonly burst: number = perSecond) { this.#tokens = burst; this.#last = now(); }
  /** True and one token spent, or false and `retryInMs` says when to ask again. */
  take(): boolean {
    this.refill();
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
  get retryInMs(): number { this.refill(); return this.#tokens >= 1 ? 0 : Math.ceil(((1 - this.#tokens) / this.perSecond) * 1000); }
  private refill(): void {
    const t = this.now();
    if (t > this.#last) this.#tokens = Math.min(this.burst, this.#tokens + ((t - this.#last) / 1000) * this.perSecond);
    this.#last = Math.max(this.#last, t);
  }
}
/** The same peer is not sent another `want` for the same version sooner than this, and a child asks for its parent at most this often (a peer that cannot serve answers at once, and an immediate re-ask made two devices ping-pong at full speed, fuzz seed 815612). */
export const WANT_GAP_MS = 2_000;

/** How long after start a writer that has heard from NO peer waits before it may write alone (named `writing-alone`; review 2, finding 1). */
export const WRITER_ALONE_MS = 5_000;

/** A peer's claim of MORE lines than the writer holds that has stayed the same, unbacked by any batch from that peer, for this long no longer blocks the writer's append (it is counted and named). */
export const CLAIM_UNBACKED_MS = 10 * 60_000;

/** A claim of more lines ends its hold on the writer after this long since it was FIRST heard, whatever happened in between (review 4, F3). */
export const CLAIM_ABSOLUTE_MS = 30 * 60_000;
/** The writer gate waits this long for a device it has heard to send its heads completely, then stops counting it (named, review 4, F4). */
export const GATE_HEADS_WAIT_MS = 60_000;

/** How many versions ONE other roster device may announce to this device (review 4, F7): each costs store folders, announcement files and table entries here for good, and until the control log exists any roster
 *  device may announce a new root. Over the budget an announcement is counted (`intro-over-budget`) and ignored; this device's own chats are not counted. */
export const MAX_ANNOUNCED_PER_DEVICE = 1000;
