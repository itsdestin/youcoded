import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const shim = read('../src/renderer/remote-shim.ts');
const server = read('../src/main/remote-server.ts');

describe('recovery never repeats an action and never loses a pairing', () => {
  it('a timed-out request is kept and asked about, not dropped', () => {
    // The old timer deleted the entry and rejected. The request had already been SENT, so
    // it may well have run — the app said "failed" about something that succeeded.
    expect(shim).toContain('entry.outcomeUnknown = true;');
    expect(shim).toContain("invoke('remote:request-outcome'");
    // And it is never re-sent: the reconciliation reports, it does not retry.
    expect(shim).not.toMatch(/reconcileUnknownOutcomes[\s\S]{0,600}send\(/);
  });

  it('request ids name the device and the connection', () => {
    // `msg-N` came from a per-page-load counter, so two devices — or one device after a
    // reload — produced the same ids and the host could answer about the wrong request.
    // Matched as a pattern rather than quoted: a literal template expression in a plain
    // string is banned by lint, and escaping it would obscure what is being pinned.
    expect(shim).toMatch(/myDeviceId \|\| 'anon'\}:.\{connectionGeneration\}:.\{\+\+messageId\}/);
    expect(server).toContain("const deviceId = id.split(':')[0];");
  });

  it('the host answers unknown rather than guessing, and cannot grow without bound', () => {
    expect(server).toContain('COMPLETED_RING_PER_DEVICE');
    expect(server).toContain('COMPLETED_RING_MS');
    expect(server).toContain("return ring.some(e => e.id === id && e.at >= cutoff) ? 'completed' : 'unknown';");
    // No ring at all — a fresh start — is 'unknown', which is the honest answer after a
    // host restart. The milestone names host restart as a case the UI must handle.
    expect(server).toContain("if (!ring) return 'unknown';");
  });

  it('a stale socket cannot rebind the live one', () => {
    expect(shim).toContain('if (generation !== connectionGeneration) return;');
  });

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

  it('a browser keeps its pairing through a long outage', () => {
    // This path deleted the saved address and credential and connected to 'android-local',
    // which does not exist in a browser: a phone that lost signal came back unpaired.
    expect(shim).toContain("const hasLocalBridge = location.protocol === 'file:';");
    expect(shim).toContain('reconnectAttempts >= MAX_RECONNECT_ATTEMPTS && hasLocalBridge');
  });

  it('a device the host refused permanently stops retrying', () => {
    // Retrying an unpaired or retired credential can never succeed, and on upgrade day
    // every device doing it at once is what would trip the host's own limiter.
    expect(shim).toContain('function isTerminalClose(code: number)');
    expect(shim).toContain('isTerminalClose(event.code)');
  });
});
