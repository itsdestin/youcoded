import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../src/main/remote-server.ts', import.meta.url), 'utf8');

describe('one device cannot lock out the others', () => {
  it('no failure bucket is keyed by network address', () => {
    // WHY this is the whole finding: behind the loopback bind every remote device arrives
    // as 127.0.0.1. A per-address bucket becomes ONE bucket for the household, and five bad
    // guesses from anybody — or, on upgrade day, every retired credential failing at once —
    // locks the owner out of their own computer.
    expect(server).not.toContain('failedAttempts.get(ip)');
    expect(server).not.toContain('failedAttempts.set(ip');
    expect(server).not.toContain('isRateLimited(ip)');
    expect(server).not.toMatch(/recordFailedAttempt\(ip\)/);
  });

  it('a burst slows new connections instead of refusing them', () => {
    // A refusal is indistinguishable from the feature being broken, and the person who
    // hits it is the owner far more often than an attacker.
    expect(server).toContain('HOST_FAILURES_BEFORE_SLOWDOWN');
    expect(server).toContain('HOST_SLOWDOWN_MS');
    expect(server).toContain('const slowStart = this.connectionDelayMs()');
  });

  it('attempts are counted on the connection they arrived on', () => {
    expect(server).toContain('attemptsOnThisSocket');
    expect(server).toContain('AUTH_ATTEMPTS_PER_SOCKET');
  });
});
