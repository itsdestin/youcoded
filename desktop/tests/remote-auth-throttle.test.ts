import { describe, it, expect } from 'vitest';
import {
  AuthThrottle, VerificationQueue, normalizeSource,
  FAILURES_BEFORE_LOCK, GLOBAL_FAILURES_BEFORE_LOCK, BASE_LOCK_MS, MAX_UNAUTH_PER_SOURCE, MAX_PENDING_VERIFICATIONS,
} from '../src/main/remote-auth-throttle';

function clock() { let t = 1_000_000; return { now: () => t, advance: (ms: number) => { t += ms; } }; }

describe('AuthThrottle', () => {
  it('locks a source for 15 minutes after 10 failures, then doubles', () => {
    const c = clock(); const th = new AuthThrottle(c.now);
    for (let i = 0; i < FAILURES_BEFORE_LOCK - 1; i++) th.recordFailure('100.1.1.1');
    expect(th.retryAfterMs('100.1.1.1')).toBe(0);
    th.recordFailure('100.1.1.1');
    expect(th.retryAfterMs('100.1.1.1')).toBe(BASE_LOCK_MS);
    // Other sources are not affected by a per-source lock.
    expect(th.retryAfterMs('100.2.2.2')).toBe(0);
    c.advance(BASE_LOCK_MS + 1);
    expect(th.retryAfterMs('100.1.1.1')).toBe(0);
    for (let i = 0; i < FAILURES_BEFORE_LOCK; i++) th.recordFailure('100.1.1.1');
    expect(th.retryAfterMs('100.1.1.1')).toBe(BASE_LOCK_MS * 2);
  });

  it('forgets failures older than the 10 minute window', () => {
    const c = clock(); const th = new AuthThrottle(c.now);
    for (let i = 0; i < FAILURES_BEFORE_LOCK - 1; i++) th.recordFailure('a');
    c.advance(11 * 60_000);
    th.recordFailure('a');
    expect(th.retryAfterMs('a')).toBe(0);
  });

  it('a correct password forgives that source', () => {
    const c = clock(); const th = new AuthThrottle(c.now);
    for (let i = 0; i < FAILURES_BEFORE_LOCK - 1; i++) th.recordFailure('a');
    th.recordSuccess('a');
    th.recordFailure('a');
    expect(th.retryAfterMs('a')).toBe(0);
  });

  it('locks everyone out when many different sources keep failing', () => {
    const c = clock(); const th = new AuthThrottle(c.now);
    for (let i = 0; i < GLOBAL_FAILURES_BEFORE_LOCK; i++) th.recordFailure(`10.0.0.${i}`);
    expect(th.retryAfterMs('100.9.9.9')).toBe(BASE_LOCK_MS);
  });

  it('treats ::ffff:1.2.3.4 and 1.2.3.4 as one source', () => {
    expect(normalizeSource('::ffff:1.2.3.4')).toBe('1.2.3.4');
    const th = new AuthThrottle(clock().now);
    for (let i = 0; i < FAILURES_BEFORE_LOCK; i++) th.recordFailure(i % 2 ? '::ffff:1.2.3.4' : '1.2.3.4');
    expect(th.retryAfterMs('1.2.3.4')).toBeGreaterThan(0);
  });

  it('caps unfinished sign-ins per address and frees them on release', () => {
    const th = new AuthThrottle(clock().now);
    for (let i = 0; i < MAX_UNAUTH_PER_SOURCE; i++) expect(th.acquireUnauth('a')).toBe(true);
    expect(th.acquireUnauth('a')).toBe(false);
    expect(th.acquireUnauth('b')).toBe(true);
    th.releaseUnauth('a');
    expect(th.acquireUnauth('a')).toBe(true);
  });
});

describe('VerificationQueue', () => {
  it('runs checks one at a time and refuses beyond the queue cap', async () => {
    const q = new VerificationQueue();
    let running = 0; let maxRunning = 0;
    const releases: Array<() => void> = [];
    const check = () => new Promise<boolean>((resolve) => {
      running++; maxRunning = Math.max(maxRunning, running);
      releases.push(() => { running--; resolve(true); });
    });
    const all = Array.from({ length: MAX_PENDING_VERIFICATIONS }, () => q.run(check));
    expect(await q.run(check)).toBe('busy');
    for (let i = 0; i < MAX_PENDING_VERIFICATIONS; i++) {
      await new Promise((r) => setImmediate(r));
      releases[i]();
    }
    expect(await Promise.all(all)).toEqual(Array(MAX_PENDING_VERIFICATIONS).fill(true));
    expect(maxRunning).toBe(1);
  });
});
