import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const server = read('../src/main/remote-server.ts');

// Other recovery guarantees (timed-out requests asked about not resent, per-device ids, unpaired close, a stale
// socket not rebinding) are covered by remote-shim-connection.test.ts and remote-server.test.ts. These two have no
// behaviour test yet, so their source pins stay until one replaces them.
describe('host remembers finished requests honestly, and within a limit', () => {
  it('the host answers unknown rather than guessing, and cannot grow without bound', () => {
    expect(server).toContain('COMPLETED_RING_PER_DEVICE');
    expect(server).toContain('COMPLETED_RING_MS');
    expect(server).toContain("return ring.some(e => e.id === id && e.at >= cutoff) ? 'completed' : 'unknown';");
    // No ring at all — a fresh start — is 'unknown', the honest answer after a host restart.
    expect(server).toContain("if (!ring) return 'unknown';");
  });
});

describe('host notices a half-open connection', () => {
  it('a half-open connection is noticed instead of waiting out the request timeout', () => {
    expect(server).toContain('PING_INTERVAL_MS');
    expect(server).toContain('MAX_MISSED_PINGS');
    // And it tolerates a phone that locks or changes network for a moment: one missed check
    // closed the connection after as little as 20 s, and every reconnect cost a full catch-up.
    expect(server).toMatch(/if \(missed > MAX_MISSED_PINGS\)/);
    // terminate(), so the drop is noticed when it happens rather than after ws's own 30 s wait.
    expect(server).toContain('socket.terminate();');
    expect(server).toContain("ws.on('pong'");
    // And the log can tell a phone that was locked from a connection that broke mid-use: the
    // 2026-09-11 log recorded seven drops in ten minutes with no times and no way to tell.
    expect(server).toContain('new Date().toISOString()');
    expect(server).toMatch(/silent for \$\{silent\} s/);
  });
});
