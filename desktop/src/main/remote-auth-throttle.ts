/**
 * Password-guess throttle for remote access (security audit RA-1, 2026-10).
 *
 * WHY: the old defence only slowed new connections by 2 s after 25 failures, so a
 * guesser on the private network could still try ~1M passwords a day, and each try
 * spent real CPU in the app's main process. This adds:
 *   - a per-source lockout: 10 wrong passwords inside 10 minutes locks that address
 *     out for 15 minutes; each further lockout doubles it (cap 24 h);
 *   - a host-wide lockout with the same shape but a higher bar (40 failures), so a
 *     guesser rotating addresses still hits a wall;
 *   - a cap on sign-ins still waiting to finish per address, and on password checks
 *     running at once.
 *
 * Only PASSWORD attempts are gated. A phone that is already paired signs in with its
 * saved device key, which is checked BEFORE this and is never blocked by a lockout.
 * Pure and clock-injectable so it is unit-testable; no Electron/network imports.
 */
export const FAILURES_BEFORE_LOCK = 10;
export const GLOBAL_FAILURES_BEFORE_LOCK = 40;
export const FAILURE_WINDOW_MS = 10 * 60_000;
export const BASE_LOCK_MS = 15 * 60_000;
export const MAX_LOCK_MS = 24 * 60 * 60_000;
export const MAX_UNAUTH_PER_SOURCE = 8;
/** Password checks (bcrypt) allowed to run or wait at once; more are refused as busy. */
export const MAX_PENDING_VERIFICATIONS = 4;
/** Entries kept at most, so a flood of distinct source addresses cannot grow memory. */
const MAX_TRACKED_SOURCES = 2048;

interface Track {
  /** Failure timestamps inside the window. */
  fails: number[];
  lockedUntil: number;
  /** How many lockouts so far (drives the doubling). Decays when the source behaves for a day. */
  strikes: number;
  lastSeen: number;
}

/** ::ffff:1.2.3.4 and 1.2.3.4 are the same peer. */
export function normalizeSource(ip: string | undefined | null): string {
  const s = (ip || '').toLowerCase();
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}

export class AuthThrottle {
  private sources = new Map<string, Track>();
  private global: Track = { fails: [], lockedUntil: 0, strikes: 0, lastSeen: 0 };
  private unauth = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  private lockLength(strikes: number): number {
    return Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** Math.max(0, strikes - 1));
  }

  private fail(t: Track, limit: number): void {
    const now = this.now();
    // A day of good behaviour forgives earlier lockouts.
    if (now - t.lastSeen > MAX_LOCK_MS) t.strikes = 0;
    t.lastSeen = now;
    t.fails = t.fails.filter((at) => now - at < FAILURE_WINDOW_MS);
    t.fails.push(now);
    if (t.fails.length >= limit) {
      t.strikes++;
      t.lockedUntil = now + this.lockLength(t.strikes);
      t.fails = [];
    }
  }

  /** Milliseconds until a password attempt from `ip` may be tried, or 0 when allowed now. */
  retryAfterMs(ip: string | undefined | null): number {
    const now = this.now();
    const s = this.sources.get(normalizeSource(ip));
    return Math.max(0, (s?.lockedUntil ?? 0) - now, this.global.lockedUntil - now);
  }

  recordFailure(ip: string | undefined | null): void {
    const key = normalizeSource(ip);
    let t = this.sources.get(key);
    if (!t) {
      if (this.sources.size >= MAX_TRACKED_SOURCES) this.evict();
      t = { fails: [], lockedUntil: 0, strikes: 0, lastSeen: 0 };
      this.sources.set(key, t);
    }
    this.fail(t, FAILURES_BEFORE_LOCK);
    this.fail(this.global, GLOBAL_FAILURES_BEFORE_LOCK);
  }

  /** A correct password: that source is forgiven. The host-wide count is cleared too, since the owner is here. */
  recordSuccess(ip: string | undefined | null): void {
    this.sources.delete(normalizeSource(ip));
    this.global = { fails: [], lockedUntil: 0, strikes: 0, lastSeen: this.now() };
  }

  private evict(): void {
    const now = this.now();
    for (const [k, t] of this.sources) {
      if (t.lockedUntil <= now && t.fails.every((at) => now - at >= FAILURE_WINDOW_MS)) this.sources.delete(k);
    }
    // Still full of live entries: drop the oldest-seen unlocked one (a locked entry is the one we must keep).
    if (this.sources.size >= MAX_TRACKED_SOURCES) {
      let oldest: string | null = null; let oldestAt = Infinity;
      for (const [k, t] of this.sources) if (t.lockedUntil <= now && t.lastSeen < oldestAt) { oldest = k; oldestAt = t.lastSeen; }
      if (oldest) this.sources.delete(oldest);
    }
  }

  /** Reserve a pending-handshake slot for `ip`; false when that address already holds too many. */
  acquireUnauth(ip: string | undefined | null): boolean {
    const key = normalizeSource(ip);
    const n = this.unauth.get(key) ?? 0;
    if (key && n >= MAX_UNAUTH_PER_SOURCE) return false;
    this.unauth.set(key, n + 1);
    return true;
  }

  releaseUnauth(ip: string | undefined | null): void {
    const key = normalizeSource(ip);
    const n = (this.unauth.get(key) ?? 0) - 1;
    if (n <= 0) this.unauth.delete(key); else this.unauth.set(key, n);
  }
}

/**
 * Runs password checks ONE at a time and refuses to queue more than
 * MAX_PENDING_VERIFICATIONS, so a flood cannot pile up CPU-heavy hashing on the main
 * thread. Resolves 'busy' instead of running when full.
 */
export class VerificationQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  async run(check: () => Promise<boolean>): Promise<boolean | 'busy'> {
    if (this.pending >= MAX_PENDING_VERIFICATIONS) return 'busy';
    this.pending++;
    const mine = this.tail.then(check, check);
    this.tail = mine.catch(() => {});
    try { return await mine; } finally { this.pending--; }
  }
}
