import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SyncService } from '../src/main/sync-service';
import { SpaceManager } from '../src/main/sync-spaces/space-manager';
import { readWarnings, writeWarnings, dismissWarning, setClaudeDirForTests } from '../src/main/sync-state';

/**
 * Health-check-owned warnings must clear themselves when their cause goes away.
 *
 * Bug (reported by Destin 2026-08-11, from his live app): the Backup & Sync
 * popup showed a red "No internet · Can't reach the network" card directly
 * under a green "All synced · GitHub · 1m ago" header. runHealthCheck() ran
 * exactly once — at the end of SyncService.start() — so a launch that lost the
 * race with the WiFi coming up (or any transient DNS failure) wrote OFFLINE
 * into .sync-warnings.json and nothing ever re-evaluated it. The warning
 * outlived its cause by the whole app session.
 *
 * The 2026-07-26 fix (PR #254) made the Settings row read the live file instead
 * of a mount-time snapshot, which was a real bug — but it could only ever show
 * the file faithfully, and the FILE was the stale thing. That entry said so:
 * "any transient warning (a real OFFLINE at launch) still pins the row red
 * until restart."
 */

const tmpHome = path.join(os.tmpdir(), `sync-warning-self-clear-${process.pid}-${Date.now()}`);
const claudeDir = path.join(tmpHome, '.claude');
const toolkitState = path.join(claudeDir, 'toolkit-state');

setClaudeDirForTests(tmpHome);

/**
 * ONE service whose two shell-outs are stubbed — one instance per test, the way
 * production has one per app run. That matters: the OFFLINE warning needs two
 * consecutive failed probes, and the counter lives on the instance.
 * `net.online` flips mid-test to simulate the network coming and going.
 */
function makeService(online: boolean) {
  const net = { online };
  const svc = new SyncService(tmpHome);
  vi.spyOn(svc as any, 'autoDetectBackend').mockResolvedValue(null);
  vi.spyOn(svc as any, 'probeInternet').mockImplementation(async () => net.online);
  return { svc, net };
}

/** Drive the check to the two-strike threshold so OFFLINE is actually written. */
async function goOffline(svc: SyncService) {
  await svc.runHealthCheck({ probeBackends: false });
  await svc.runHealthCheck({ probeBackends: false });
}

async function codes(): Promise<string[]> {
  return (await readWarnings()).map((w) => w.code);
}

/** Turn the PRIMARY (GitHub sync spaces) system on or off, at its real path. */
function setPrimarySync(enabled: boolean) {
  const homedir = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  new SpaceManager().setEnabled(enabled);
  homedir.mockRestore();
}

beforeEach(async () => {
  fs.mkdirSync(toolkitState, { recursive: true });
  setClaudeDirForTests(tmpHome); // also clears the dismissed-this-run set
  await writeWarnings([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

describe('runHealthCheck — resolved warnings clear themselves', () => {
  it('clears OFFLINE on the next check once the network is back', async () => {
    setPrimarySync(true);
    const { svc, net } = makeService(false);

    await goOffline(svc);
    expect(await codes()).toContain('OFFLINE');

    // Same app run, WiFi has come up — this is the periodic re-check.
    net.online = true;
    await svc.runHealthCheck({ probeBackends: false });
    expect(await codes()).not.toContain('OFFLINE');
  });

  it('needs two consecutive failed probes before crying offline', async () => {
    setPrimarySync(true);
    const { svc, net } = makeService(false);

    // A single failure is the launch race / resolver hiccup that produced the
    // bogus card in the 2026-08-11 report. It must not warn on its own.
    await svc.runHealthCheck({ probeBackends: false });
    expect(await codes()).not.toContain('OFFLINE');

    // And a recovery resets the count — three isolated blips never add up.
    net.online = true;
    await svc.runHealthCheck({ probeBackends: false });
    net.online = false;
    await svc.runHealthCheck({ probeBackends: false });
    expect(await codes()).not.toContain('OFFLINE');
  });

  it('clears PERSONAL_NOT_CONFIGURED when sync is set up mid-session', async () => {
    setPrimarySync(false);
    const { svc } = makeService(true);

    await svc.runHealthCheck();
    expect(await codes()).toContain('PERSONAL_NOT_CONFIGURED');

    setPrimarySync(true);

    await svc.runHealthCheck({ probeBackends: false });
    expect(await codes()).not.toContain('PERSONAL_NOT_CONFIGURED');
  });

  it('does not shell out to the backend probe on a periodic re-check', async () => {
    setPrimarySync(true);
    const { svc } = makeService(true);

    await svc.runHealthCheck({ probeBackends: false });

    // The probe is a ~35s rclone shell-out (measured on the Z13) — running it
    // once a minute is why the periodic path passes probeBackends: false.
    expect((svc as any).autoDetectBackend).not.toHaveBeenCalled();
  });

  it('a still-true warning survives the re-check', async () => {
    setPrimarySync(true);
    const { svc } = makeService(false);

    await goOffline(svc);
    await svc.runHealthCheck({ probeBackends: false });

    expect(await codes()).toContain('OFFLINE');
  });

  it('does not resurrect a warning the user dismissed this run', async () => {
    setPrimarySync(true);
    const { svc } = makeService(false);

    await goOffline(svc);
    await dismissWarning('OFFLINE');
    expect(await codes()).not.toContain('OFFLINE');

    // Still offline — but the user said they don't want to hear about it.
    await svc.runHealthCheck({ probeBackends: false });
    expect(await codes()).not.toContain('OFFLINE');
  });

  it('leaves push-failure warnings alone (they are owned by the push path)', async () => {
    setPrimarySync(true);
    await writeWarnings([{
      code: 'AUTH_FAILED',
      level: 'danger',
      backendId: 'drive-1',
      title: 'Google Drive needs re-authorization',
      body: 'Sign in again to resume backups.',
      dismissible: false,
      createdEpoch: 1,
    }]);

    await makeService(true).svc.runHealthCheck({ probeBackends: false });

    expect(await codes()).toEqual(['AUTH_FAILED']);
  });

  /**
   * The load-bearing test. Every assertion above passes on the pre-fix code
   * too, because the sweep-and-rewrite logic was always there — what was
   * missing is anything that RUNS it a second time. start() called
   * runHealthCheck exactly once and then only scheduled the hourly snapshot
   * push, so the warnings file was frozen for the rest of the app's uptime.
   */
  it('start() keeps re-checking, and stop() ends it', async () => {
    vi.useFakeTimers();
    try {
      setPrimarySync(true);
      // Online: a failed launch probe would put the re-check on the 60 s retry
      // cadence (audit W12, pinned in tests/sync-service.test.ts) — this test
      // pins only that a re-check happens at all, and that stop() ends it.
      const { svc } = makeService(true);
      // Not under test here and it shells out to rclone/git.
      vi.spyOn(svc as any, 'push').mockResolvedValue({ success: true, errors: 0, backends: [] });
      const health = vi.spyOn(svc, 'runHealthCheck');

      await svc.start();
      expect(health).toHaveBeenCalledTimes(1);

      // Five minutes, not one, since audit W12.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(health).toHaveBeenCalledTimes(2);
      // The re-check must not re-run the rclone backend probe.
      expect(health.mock.calls[1][0]).toEqual({ probeBackends: false });

      svc.stop();
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      expect(health).toHaveBeenCalledTimes(2);
      // WHY: the interval-fired check does real async fs I/O that
      // advanceTimersByTimeAsync does not wait for, and stop() only clears the
      // interval — it doesn't await the in-flight check. Without this, that
      // check's writeWarnings leaked into the NEXT test and raced its own
      // atomicWrite (the cross-OS ENOENT-on-rename CI flake). Drain every
      // runHealthCheck promise before the test ends so nothing escapes.
      await Promise.allSettled(health.mock.results.map((r) => r.value));
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the file write when nothing changed', async () => {
    setPrimarySync(true);
    const { svc } = makeService(false);

    await goOffline(svc);
    const warningsPath = path.join(claudeDir, '.sync-warnings.json');
    const firstWrite = fs.statSync(warningsPath).mtimeMs;
    const firstBody = fs.readFileSync(warningsPath, 'utf8');

    // Poll cadence is once a minute; an unchanged set must not rewrite the file
    // (and must not restamp createdEpoch, which would keep re-broadcasting).
    await new Promise((r) => setTimeout(r, 20));
    await svc.runHealthCheck({ probeBackends: false });

    expect(fs.statSync(warningsPath).mtimeMs).toBe(firstWrite);
    expect(fs.readFileSync(warningsPath, 'utf8')).toBe(firstBody);
  });
});
