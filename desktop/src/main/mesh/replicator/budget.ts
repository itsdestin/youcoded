// Budgets: memory and send rate, in one place so the limits in the plan are numbers a test can read (plan section 3, "Serving a want"; invariant 10).
//
// WHY explicit counters: the replicator serves several peers at once and each batch is read into memory before it is sent. Without a shared
// ceiling, fifteen peers asking for a 300 MB chat would hold gigabytes. A request that does not fit is refused loudly (the peer re-asks later).
export const MAX_SESSIONS = 4;
export const WINDOW_FRAMES = 4;
export const READ_BUFFER_BUDGET_BYTES = 16 * 1024 * 1024;
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
  constructor(private readonly perSecond: number, private readonly now: () => number) { this.#tokens = perSecond; this.#last = now(); }
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
    if (t > this.#last) this.#tokens = Math.min(this.perSecond, this.#tokens + ((t - this.#last) / 1000) * this.perSecond);
    this.#last = Math.max(this.#last, t);
  }
}
