import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SyncService } from '../src/main/sync-service';
import { setClaudeDirForTests } from '../src/main/sync-state';

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
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
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

  it('stop() ends the timer', async () => {
    const { svc, check } = makeService({ configured: true });
    await svc.start();
    svc.stop();
    await vi.advanceTimersByTimeAsync(3 * FIVE_MIN);
    expect(check).toHaveBeenCalledTimes(1);
  });
});
