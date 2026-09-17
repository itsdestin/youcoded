import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SyncService } from '../src/main/sync-service';
import { setClaudeDirForTests, readWarnings, writeWarnings } from '../src/main/sync-state';

// Simplification audit W12: the periodic sync health check did a DNS lookup of
// github.com and re-read config every minute — window hidden, sync off, no
// matter what — and its only reader is the status push. It now runs every five
// minutes, only while main.ts's gate says someone is looking, and only when
// some sync is configured.

const tmpHome = path.join(os.tmpdir(), `sync-service-${process.pid}-${Date.now()}`);
const FIVE_MIN = 5 * 60_000;

function makeService(opts: { configured: boolean }) {
  const svc = new SyncService(tmpHome);
  vi.spyOn(svc as any, 'autoDetectBackend').mockResolvedValue(null);
  vi.spyOn(svc as any, 'probeInternet').mockResolvedValue(true);
  vi.spyOn(svc as any, 'isPrimarySyncEnabled').mockReturnValue(opts.configured);
  vi.spyOn(svc, 'push').mockResolvedValue({ success: true, errors: 0, backends: [] });
  const check = vi.spyOn(svc, 'runHealthCheck').mockResolvedValue([]);
  return { svc, check };
}

beforeEach(() => {
  fs.mkdirSync(path.join(tmpHome, '.claude', 'toolkit-state'), { recursive: true });
  setClaudeDirForTests(tmpHome);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

describe('SyncService periodic health check', () => {
  it('runs at launch, then every five minutes while someone is looking — not every minute', async () => {
    const { svc, check } = makeService({ configured: true });
    let looking = true;
    svc.setHealthCheckGate(() => looking);
    await svc.start();
    expect(check).toHaveBeenCalledTimes(1); // the launch run, backends probed
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(check).toHaveBeenCalledTimes(1); // the old 60 s cadence would be at five by now
    await vi.advanceTimersByTimeAsync(60_000);
    expect(check).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenLastCalledWith({ probeBackends: false });

    looking = false; // window hidden, no phone
    await vi.advanceTimersByTimeAsync(3 * FIVE_MIN);
    expect(check).toHaveBeenCalledTimes(2);

    looking = true;
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(check).toHaveBeenCalledTimes(3);
    svc.stop();
  });

  it('runs one more check when sync is switched off, so a showing warning can clear and "No sync configured" can appear', async () => {
    const { svc, check } = makeService({ configured: true });
    let looking = true;
    svc.setHealthCheckGate(() => looking);
    await svc.start();
    expect(check).toHaveBeenCalledTimes(1);
    (svc as any).isPrimarySyncEnabled.mockReturnValue(false); // switched off mid-session
    looking = false; // nobody looking at that tick — the transition must not be lost
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(check).toHaveBeenCalledTimes(1);
    looking = true;
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(check).toHaveBeenCalledTimes(2); // the one transition check
    await vi.advanceTimersByTimeAsync(3 * FIVE_MIN);
    expect(check).toHaveBeenCalledTimes(2); // and then nothing while unconfigured
    svc.stop();
  });

  it('does not run at all while no sync of any kind is configured', async () => {
    const { svc, check } = makeService({ configured: false });
    svc.setHealthCheckGate(() => true);
    await svc.start();
    expect(check).toHaveBeenCalledTimes(1); // launch still writes "No sync configured"
    await vi.advanceTimersByTimeAsync(3 * FIVE_MIN);
    expect(check).toHaveBeenCalledTimes(1);
    // Setting sync up mid-session is noticed on the next tick — no DNS was
    // needed to notice, just the config re-read.
    (svc as any).isPrimarySyncEnabled.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(check).toHaveBeenCalledTimes(2);
    svc.stop();
  });

  it('after a failed probe the next check comes in 60 s, so "No internet" lands within about a minute; a good probe returns to 5 min', async () => {
    await writeWarnings([]);
    const svc = new SyncService(tmpHome);
    vi.spyOn(svc as any, 'autoDetectBackend').mockResolvedValue(null);
    vi.spyOn(svc as any, 'isPrimarySyncEnabled').mockReturnValue(true);
    vi.spyOn(svc, 'push').mockResolvedValue({ success: true, errors: 0, backends: [] });
    const net = { online: true };
    const probe = vi.spyOn(svc as any, 'probeInternet').mockImplementation(async () => net.online);
    svc.setHealthCheckGate(() => true);
    const codes = async () => (await readWarnings()).map((w) => w.code);
    // The real check writes the warnings file (real I/O), and only reschedules
    // once it has: wait for the next health timer to exist before moving the
    // clock (the hourly snapshot timer is also pending, so the timer COUNT is
    // no signal), and wait on the file for the positive assertions.
    const advance = async (ms: number) => {
      await vi.waitFor(() => expect((svc as any).healthTimer).not.toBeNull());
      await vi.advanceTimersByTimeAsync(ms);
    };
    const probes = (n: number) => vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(n));

    await svc.start();
    expect(probe).toHaveBeenCalledTimes(1); // launch, online

    net.online = false;
    await advance(FIVE_MIN);
    await probes(2); // strike one, on the healthy cadence
    expect(await codes()).not.toContain('OFFLINE');
    await advance(60_000);
    await probes(3); // strike two, a minute later — not five
    await vi.waitFor(async () => expect(await codes()).toContain('OFFLINE'));
    await advance(60_000);
    await probes(4); // still every minute while offline

    net.online = true;
    await advance(60_000);
    await probes(5); // the probe that clears it
    await vi.waitFor(async () => expect(await codes()).not.toContain('OFFLINE'));
    await advance(4 * 60_000);
    expect(probe).toHaveBeenCalledTimes(5); // back on the 5-minute cadence
    await advance(60_000);
    await probes(6);
    svc.stop();
    await Promise.allSettled(probe.mock.results.map((r) => r.value));
  });

  it('stop() ends the timer', async () => {
    const { svc, check } = makeService({ configured: true });
    await svc.start();
    svc.stop();
    await vi.advanceTimersByTimeAsync(3 * FIVE_MIN);
    expect(check).toHaveBeenCalledTimes(1);
  });
});
