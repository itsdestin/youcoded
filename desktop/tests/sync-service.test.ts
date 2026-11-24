import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SyncService } from '../src/main/sync-service';
import { SpaceManager } from '../src/main/sync-spaces/space-manager';
import { setClaudeDirForTests, readWarnings, writeWarnings, dismissWarning } from '../src/main/sync-state';

// Each section owns a throwaway home and points sync-state at it in its own hooks,
// so no section reads another's warnings file.

// Simplification audit W12: the periodic sync health check did a DNS lookup of
// github.com and re-read config every minute — window hidden, sync off, no
// matter what — and its only reader is the status push. It now runs every five
// minutes, only while main.ts's gate says someone is looking, and only when
// some sync is configured.
describe('SyncService periodic health check', () => {
  const tmpHome = path.join(os.tmpdir(), `sync-service-${process.pid}-${Date.now()}`);
  const FIVE_MIN = 5 * 60_000;

  function makeService(opts: { configured: boolean }) {
    const svc = new SyncService(tmpHome);
    vi.spyOn(svc as any, 'autoDetectBackend').mockResolvedValue(null);
    vi.spyOn(svc as any, 'probeInternet').mockResolvedValue(true);
    vi.spyOn(svc as any, 'isPrimarySyncEnabled').mockReturnValue(opts.configured);
    // The saved-backups read is real async file I/O, which fake timers cannot advance; this suite is about the timer.
    vi.spyOn(svc as any, 'getSyncEnabledBackends').mockResolvedValue([]);
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

/**
 * The startup health check must describe the sync system the user actually has.
 *
 * Regression (fixed 2026-07-24): runHealthCheck() only ever looked at the LEGACY
 * additional-backup backends (`storage_backends` in toolkit-state/config.json —
 * Drive/iCloud). GitHub sync spaces, the app's PRIMARY sync since Phase 1, keeps
 * its own state file, so a machine syncing happily to GitHub with no Drive/iCloud
 * backend was told "No sync configured — your backups aren't set up" at
 * danger level, non-dismissible, which the StatusBar paints as a red
 * "Sync Failing" chip. Reported on a fresh macOS install of 1.3.0-beta.9. Older
 * installs masked it through autoDetectBackend(), whose `rclone lsd gdrive:…`
 * probe succeeds on a machine that used the legacy backups years ago (and skips
 * the warning without enabling anything). New installs have no rclone, so they
 * take the warning — which is the whole release population.
 *
 * These tests drive a REAL SpaceManager at its default path, which is the point:
 * SyncService reads that file by path rather than importing the sync-spaces
 * service (which would drag the engine, chokidar and electron into a health
 * check). If either side ever moves the file, case 1 fails.
 */
describe('runHealthCheck — primary (GitHub sync spaces) vs additional backups', () => {
  const tmpHome = path.join(os.tmpdir(), `sync-health-primary-${process.pid}-${Date.now()}`);
  const claudeDir = path.join(tmpHome, '.claude');
  const toolkitState = path.join(claudeDir, 'toolkit-state');

  // WHY: this was a module-level call when the section was its own file; the other
  // sections point sync-state at THEIR homes, so this one re-points it when it starts.
  beforeAll(() => { setClaudeDirForTests(tmpHome); });

  function makeService() {
    const svc = new SyncService(tmpHome);
    // The primary-sync gate is what's under test, not backend auto-detection —
    // stub it so a developer machine with a real rclone/gdrive remote (or a real
    // ~/Library iCloud folder) can't decide the outcome.
    vi.spyOn(svc as any, 'autoDetectBackend').mockResolvedValue(null);
    return svc;
  }

  /** Codes this suite asserts on; OFFLINE depends on the runner's network. */
  async function codes(): Promise<string[]> {
    return (await readWarnings()).map((w) => w.code);
  }

  beforeEach(async () => {
    fs.mkdirSync(toolkitState, { recursive: true });
    await writeWarnings([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  it('stays quiet when GitHub sync is on and no legacy backend exists', async () => {
    // Written through the real SpaceManager, at its real default path.
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    const sm = new SpaceManager();
    sm.setEnabled(true);
    homedir.mockRestore();
    await sm.flush(); // the state write is async (main-blocking-calls B6)
    expect(fs.existsSync(path.join(toolkitState, 'sync-spaces.json'))).toBe(true);

    await makeService().runHealthCheck();

    expect(await codes()).not.toContain('PERSONAL_NOT_CONFIGURED');
  });

  it('still warns when GitHub sync is off and nothing else is configured', async () => {
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    const sm = new SpaceManager();
    sm.setEnabled(false);
    homedir.mockRestore();
    await sm.flush(); // the state write is async (main-blocking-calls B6)

    await makeService().runHealthCheck();

    expect(await codes()).toContain('PERSONAL_NOT_CONFIGURED');
  });

  it('warns on a fresh install with no sync state file at all', async () => {
    expect(fs.existsSync(path.join(toolkitState, 'sync-spaces.json'))).toBe(false);

    await makeService().runHealthCheck();

    const warning = (await readWarnings()).find((w) => w.code === 'PERSONAL_NOT_CONFIGURED');
    expect(warning).toBeDefined();
    // Copy check: the old body told users to "connect a cloud provider", which
    // is the additional-backups flow, not the GitHub sync the app leads with.
    expect(warning!.body).toMatch(/Nothing is backing up your data yet/);
  });

  it('a stale legacy backend is reported as EXTRA backups, not as sync failing', async () => {
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    const sm = new SpaceManager();
    sm.setEnabled(true);
    homedir.mockRestore();
    await sm.flush(); // the state write is async (main-blocking-calls B6)
    fs.writeFileSync(path.join(toolkitState, 'config.json'), JSON.stringify({
      storage_backends: [
        { id: 'drive-1', type: 'drive', label: 'Personal Drive', syncEnabled: true, config: {} },
      ],
    }));
    // Two days ago — past the 24h staleness threshold.
    const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86400;
    fs.writeFileSync(path.join(toolkitState, '.sync-marker'), String(twoDaysAgo));

    const svc = makeService() as any;
    svc.lastFailedCycleAt = Date.now() - 10 * 60_000; // the last backup cycle failed ten minutes ago
    await svc.runHealthCheck();

    const stale = (await readWarnings()).find((w) => w.code === 'PERSONAL_STALE');
    expect(stale).toBeDefined();
    expect(stale!.level).toBe('warn');
    expect(stale!.title).toBe('Extra backups are stale');
    // GitHub sync doesn't stamp this marker, so the copy must not blame it.
    expect(stale!.body).toMatch(/Drive or iCloud/);
  });
});

/**
 * Health-check-owned warnings must clear themselves when their cause goes away.
 *
 * Bug (reported by Destin 2026-08-11, from his live app): the Backup & sync
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
describe('runHealthCheck — resolved warnings clear themselves', () => {
  const tmpHome = path.join(os.tmpdir(), `sync-warning-self-clear-${process.pid}-${Date.now()}`);
  const claudeDir = path.join(tmpHome, '.claude');
  const toolkitState = path.join(claudeDir, 'toolkit-state');

  // WHY: this was a module-level call when the section was its own file; the other
  // sections point sync-state at THEIR homes, so this one re-points it when it starts.
  beforeAll(() => { setClaudeDirForTests(tmpHome); });

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
  async function setPrimarySync(enabled: boolean) {
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    const sm = new SpaceManager();
    sm.setEnabled(enabled);
    homedir.mockRestore();
    await sm.flush(); // the state write is async (main-blocking-calls B6)
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

  it('clears OFFLINE on the next check once the network is back', async () => {
    await setPrimarySync(true);
    const { svc, net } = makeService(false);

    await goOffline(svc);
    expect(await codes()).toContain('OFFLINE');

    // Same app run, WiFi has come up — this is the periodic re-check.
    net.online = true;
    await svc.runHealthCheck({ probeBackends: false });
    expect(await codes()).not.toContain('OFFLINE');
  });

  it('needs two consecutive failed probes before crying offline', async () => {
    await setPrimarySync(true);
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
    await setPrimarySync(false);
    const { svc } = makeService(true);

    await svc.runHealthCheck();
    expect(await codes()).toContain('PERSONAL_NOT_CONFIGURED');

    await setPrimarySync(true);

    await svc.runHealthCheck({ probeBackends: false });
    expect(await codes()).not.toContain('PERSONAL_NOT_CONFIGURED');
  });

  it('does not shell out to the backend probe on a periodic re-check', async () => {
    await setPrimarySync(true);
    const { svc } = makeService(true);

    await svc.runHealthCheck({ probeBackends: false });

    // The probe is a ~35s rclone shell-out (measured on the Z13) — running it
    // once a minute is why the periodic path passes probeBackends: false.
    expect((svc as any).autoDetectBackend).not.toHaveBeenCalled();
  });

  it('a still-true warning survives the re-check', async () => {
    await setPrimarySync(true);
    const { svc } = makeService(false);

    await goOffline(svc);
    await svc.runHealthCheck({ probeBackends: false });

    expect(await codes()).toContain('OFFLINE');
  });

  it('does not resurrect a warning the user dismissed this run', async () => {
    await setPrimarySync(true);
    const { svc } = makeService(false);

    await goOffline(svc);
    await dismissWarning('OFFLINE');
    expect(await codes()).not.toContain('OFFLINE');

    // Still offline — but the user said they don't want to hear about it.
    await svc.runHealthCheck({ probeBackends: false });
    expect(await codes()).not.toContain('OFFLINE');
  });

  it('leaves push-failure warnings alone (they are owned by the push path)', async () => {
    await setPrimarySync(true);
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
      await setPrimarySync(true);
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
    await setPrimarySync(true);
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

// Final review F33: a cycle whose only backups are GitHub ones (which copy nothing on a computer)
// must not stamp a fresh "last backup".
describe('SyncService push with only GitHub backups', () => {
  const tmpHome = path.join(os.tmpdir(), `sync-service-gh-${process.pid}-${Date.now()}`);
  beforeEach(() => {
    fs.mkdirSync(path.join(tmpHome, '.claude', 'toolkit-state'), { recursive: true });
    setClaudeDirForTests(tmpHome);
  });
  afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {} });

  it('writes neither backup-meta.json nor the sync marker', async () => {
    const svc = new SyncService(tmpHome);
    vi.spyOn(svc as any, 'getBackendInstances').mockReturnValue([{ id: 'gh-1', type: 'github', syncEnabled: true, label: 'GitHub', config: {} }]);
    const res = await svc.push({ force: true });
    expect(res).toEqual({ success: true, errors: 0, backends: [] });
    expect(fs.existsSync(path.join(tmpHome, '.claude', 'backup-meta.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, '.claude', 'toolkit-state', '.sync-marker'))).toBe(false);
    // ...and the same for "Upload now" on that one backup.
    expect(await svc.push({ backendId: 'gh-1' })).toEqual({ success: true, errors: 0, backends: [] });
    expect(fs.existsSync(path.join(tmpHome, '.claude', 'backup-meta.json'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Backup fixes 2026-11-18 — the backup lock (D-18 / B-3), phone handling (item 2), and the
// saved-settings file never being wiped by a failed read (D-5).
// ---------------------------------------------------------------------------
import { spawnSync } from 'child_process';
import { setRunningOnPhone } from '../src/main/backup-platform';

/** A process id that belonged to a process that has ended — certain to be dead. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return parseInt(r.stdout, 10);
}

describe('SyncService warning clearing', () => {
  const tmpHome = path.join(os.tmpdir(), `sync-service-lock-${process.pid}-${Date.now()}`);
  beforeEach(() => {
    fs.mkdirSync(path.join(tmpHome, '.claude', 'toolkit-state'), { recursive: true });
    setClaudeDirForTests(tmpHome);
  });
  afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {} });

  it('a successful settings push does not clear a warning that came from the conversations half (review F7)', async () => {
    const svc = new SyncService(tmpHome) as any;
    await writeWarnings([
      { code: 'TIMEOUT', level: 'danger', backendId: 'drive-1', source: 'spaces', title: 'spaces', body: '', dismissible: false, createdEpoch: 1 },
      { code: 'UNKNOWN', level: 'danger', backendId: 'drive-1', title: 'personal', body: '', dismissible: false, createdEpoch: 1 },
    ] as any);
    await svc.clearBackendFailures('drive-1');
    expect((await readWarnings()).map((w: any) => w.title)).toEqual(['spaces']);
    await writeWarnings([]);
  });
});

describe('SyncService on a phone', () => {
  const tmpHome = path.join(os.tmpdir(), `sync-service-phone-${process.pid}-${Date.now()}`);
  const drive = { id: 'drive-1', type: 'drive', syncEnabled: true, label: 'My Drive', config: { rcloneRemote: 'gdrive' } };
  beforeEach(() => {
    fs.mkdirSync(path.join(tmpHome, '.claude', 'toolkit-state'), { recursive: true });
    setClaudeDirForTests(tmpHome);
  });
  afterEach(async () => {
    setRunningOnPhone(false);
    vi.restoreAllMocks();
    await writeWarnings([]);
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  it('never runs rclone for a Drive backup, writes no "rclone isn\'t installed" warning, and clears an old one', async () => {
    setRunningOnPhone(true);
    const svc = new SyncService(tmpHome);
    vi.spyOn(svc as any, 'getBackendInstances').mockReturnValue([drive]);
    const rclone = vi.spyOn(svc as any, 'rclone');
    await writeWarnings([{ code: 'RCLONE_MISSING', level: 'danger', backendId: 'drive-1', title: "rclone isn't installed", body: '', dismissible: false, createdEpoch: 1 }]);
    const res = await svc.push({ force: true });
    expect(res).toEqual({ success: true, errors: 0, backends: [] });
    expect(rclone).not.toHaveBeenCalled();
    expect(await readWarnings()).toEqual([]);
    expect(fs.existsSync(path.join(tmpHome, '.claude', 'backup-meta.json'))).toBe(false);
  });

  it('a service built the way the computer builds it (no phone flag) still pushes Drive', async () => {
    const svc = new SyncService(tmpHome);
    vi.spyOn(svc as any, 'getBackendInstances').mockReturnValue([drive]);
    const pushDrive = vi.spyOn(svc as any, 'pushDrive').mockResolvedValue(0);
    const res = await svc.push({ force: true });
    expect(pushDrive).toHaveBeenCalledTimes(1);
    expect(res.backends).toEqual(['drive-1']);
  });
});

describe('SyncService never wipes the saved backups after a failed read', () => {
  const tmpHome = path.join(os.tmpdir(), `sync-service-cfg-${process.pid}-${Date.now()}`);
  const cfg = () => path.join(tmpHome, '.claude', 'toolkit-state', 'config.json');
  beforeEach(() => {
    fs.mkdirSync(path.join(tmpHome, '.claude', 'toolkit-state'), { recursive: true });
    setClaudeDirForTests(tmpHome);
  });
  afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {} });

  it('a damaged settings file is left exactly as it is by the backup-list read', async () => {
    const damaged = '{"storage_backends":[{"id":"drive-1","ty';
    fs.writeFileSync(cfg(), damaged);
    const svc = new SyncService(tmpHome) as any;
    expect(await svc.getBackendInstances()).toEqual([]);
    expect(fs.readFileSync(cfg(), 'utf8')).toBe(damaged);
  });

  it('a damaged settings file is left alone by the health check\'s auto-detect write', async () => {
    const damaged = '{"storage_backends":[{"id":"drive-1","ty';
    fs.writeFileSync(cfg(), damaged);
    const svc = new SyncService(tmpHome);
    vi.spyOn(svc as any, 'probeInternet').mockResolvedValue(true);
    vi.spyOn(svc as any, 'autoDetectBackend').mockResolvedValue('drive');
    await svc.runHealthCheck();
    expect(fs.readFileSync(cfg(), 'utf8')).toBe(damaged);
  });

  it.each([['zero-byte', ''], ['whitespace-only', ' \n']])('a %s settings file is "empty, first run": no backups, no complaint, and the file may be written', async (_n, content) => {
    fs.writeFileSync(cfg(), content);
    const svc = new SyncService(tmpHome) as any;
    expect(await svc.getBackendInstances()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(cfg(), 'utf8')).storage_backends).toEqual([]); // the first-run migration wrote it
  });

  // Review M11: a file that cannot be READ is damaged, never empty.
  it('a settings file that cannot be read at all (a folder in its place) reads as no backups and is never written over', async () => {
    fs.mkdirSync(cfg());
    const svc = new SyncService(tmpHome) as any;
    expect(await svc.getBackendInstances()).toEqual([]); // no exception: nothing tried to write
    expect(fs.statSync(cfg()).isDirectory()).toBe(true);
  });

  it('a missing settings file is still the normal "no backups yet" and is created', async () => {
    const svc = new SyncService(tmpHome) as any;
    expect(await svc.getBackendInstances()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Backup fixes 2026-11-18, B-3 (every Drive copy counts), B-4 (success stamp only on real success),
// B-2 (the health check repairs / reports the saved-settings file).
// ---------------------------------------------------------------------------
describe('SyncService Drive snapshot counts every copy (B-3)', () => {
  const tmpHome = path.join(os.tmpdir(), `sync-service-drive-${process.pid}-${Date.now()}`);
  const claude = () => path.join(tmpHome, '.claude');
  const drive = { id: 'drive-1', type: 'drive', syncEnabled: true, label: 'My Drive', config: { rcloneRemote: 'gdrive' } };
  beforeEach(() => {
    fs.mkdirSync(path.join(claude(), 'toolkit-state'), { recursive: true });
    fs.mkdirSync(path.join(claude(), 'encyclopedia'), { recursive: true });
    fs.mkdirSync(path.join(claude(), 'skills', 'mine'), { recursive: true });
    fs.mkdirSync(path.join(claude(), 'plans'), { recursive: true });
    fs.writeFileSync(path.join(claude(), 'conversation-index.json'), '{}');
    setClaudeDirForTests(tmpHome);
  });
  afterEach(async () => { vi.restoreAllMocks(); await writeWarnings([]); try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {} });

  /** A Drive where only copies whose destination contains `failOn` are refused; records every call. */
  function service(failOn: string | null) {
    const svc = new SyncService(tmpHome) as any;
    vi.spyOn(svc, 'getBackendInstances').mockResolvedValue([drive]);
    vi.spyOn(svc, 'getSyncEnabledBackends').mockResolvedValue([drive]);
    const calls: string[][] = [];
    vi.spyOn(svc, 'rclone').mockImplementation(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'lsf') return { code: 0, stdout: '2000-01-01/\n', stderr: '' };
      const failing = failOn !== null && args.some((a) => a.includes(failOn));
      return { code: failing ? 1 : 0, stdout: '', stderr: failing ? 'quota exceeded' : '' };
    });
    return { svc, calls };
  }

  it.each([['encyclopedia', '/encyclopedia/'], ['skills', '/skills/mine/'], ['plans', '/plans/'], ['conversation index', 'conversation-index.json']])(
    'a Drive that refuses only the %s copy is not "0 errors": no day stamp, no pruning, a red warning, no fresh success time',
    async (_n, failOn) => {
      const { svc, calls } = service(failOn);
      const res = await svc.push({ force: true });
      expect(res.errors).toBeGreaterThan(0);
      expect(res.success).toBe(false);
      expect(fs.existsSync(path.join(claude(), 'toolkit-state', '.snapshot-marker'))).toBe(false);
      expect(calls.some((c) => c[0] === 'lsf' || c[0] === 'purge')).toBe(false);
      expect((await readWarnings()).some((w) => w.backendId === 'drive-1' && w.level === 'danger')).toBe(true);
      expect(fs.existsSync(path.join(claude(), 'toolkit-state', '.sync-marker'))).toBe(false);
      expect(fs.existsSync(path.join(claude(), 'toolkit-state', '.sync-marker-drive-1'))).toBe(false);
    });

  it('when every copy lands: the day is stamped, old snapshots are pruned, and the success time is written', async () => {
    const { svc, calls } = service(null);
    const res = await svc.push({ force: true });
    expect(res).toMatchObject({ success: true, errors: 0 });
    expect(fs.existsSync(path.join(claude(), 'toolkit-state', '.snapshot-marker'))).toBe(true);
    expect(calls.some((c) => c[0] === 'lsf')).toBe(true);
    expect(fs.existsSync(path.join(claude(), 'toolkit-state', '.sync-marker'))).toBe(true);
    expect(fs.existsSync(path.join(claude(), 'toolkit-state', '.sync-marker-drive-1'))).toBe(true);
  });

  it('a failed cycle still holds off the next automatic push for 15 minutes (the attempt marker), without a success time', async () => {
    const { svc, calls } = service('/encyclopedia/');
    await svc.push({ force: true });
    const before = calls.length;
    await svc.push(); // automatic, not forced
    expect(calls.length).toBe(before);
    expect(fs.existsSync(path.join(claude(), 'toolkit-state', '.sync-marker'))).toBe(false);
  });
});

describe('"Extra backups are stale" (B-4)', () => {
  const tmpHome = path.join(os.tmpdir(), `sync-service-stale-${process.pid}-${Date.now()}`);
  const ts = () => path.join(tmpHome, '.claude', 'toolkit-state');
  const drive = { id: 'drive-1', type: 'drive', syncEnabled: true, label: 'My Drive', config: {} };
  beforeEach(() => {
    fs.mkdirSync(ts(), { recursive: true });
    setClaudeDirForTests(tmpHome);
    fs.writeFileSync(path.join(ts(), '.sync-marker'), String(Math.floor(Date.now() / 1000) - 2 * 86400));
  });
  afterEach(async () => { vi.restoreAllMocks(); await writeWarnings([]); try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {} });
  const health = async (setup?: (svc: any) => void) => {
    const svc = new SyncService(tmpHome) as any;
    vi.spyOn(svc, 'probeInternet').mockResolvedValue(true);
    vi.spyOn(svc, 'getSyncEnabledBackends').mockResolvedValue([drive]);
    setup?.(svc);
    await svc.runHealthCheck({ probeBackends: false });
    return (await readWarnings()).filter((w) => w.code === 'PERSONAL_STALE');
  };

  it('is not shown the moment an app wakes up with an old success time, before any backup has been tried', async () => {
    expect(await health()).toEqual([]);
  });
  it('is not shown for a failure that happened before the last sleep (older than the hourly poll plus slack)', async () => {
    expect(await health((svc) => { svc.lastFailedCycleAt = Date.now() - 3 * 60 * 60_000; })).toEqual([]);
  });
  it('is shown when the last backup cycle failed and nothing has succeeded for over a day', async () => {
    expect(await health((svc) => { svc.lastFailedCycleAt = Date.now() - 5 * 60_000; })).toHaveLength(1);
  });
  it('a success clears the memory of the failure and writes the success time', async () => {
    const svc = new SyncService(tmpHome) as any;
    vi.spyOn(svc, 'getBackendInstances').mockResolvedValue([drive]);
    vi.spyOn(svc, 'getSyncEnabledBackends').mockResolvedValue([drive]);
    vi.spyOn(svc, 'pushDrive').mockResolvedValue(0);
    svc.lastFailedCycleAt = Date.now();
    await svc.push({ force: true });
    expect(svc.lastFailedCycleAt).toBeNull();
    expect(Date.now() / 1000 - parseInt(fs.readFileSync(path.join(ts(), '.sync-marker'), 'utf8'), 10)).toBeLessThan(60);
  });
  it('a failing cycle leaves the success time alone and remembers the failure', async () => {
    const svc = new SyncService(tmpHome) as any;
    vi.spyOn(svc, 'getBackendInstances').mockResolvedValue([drive]);
    vi.spyOn(svc, 'getSyncEnabledBackends').mockResolvedValue([drive]);
    vi.spyOn(svc, 'pushDrive').mockResolvedValue(2);
    const before = fs.readFileSync(path.join(ts(), '.sync-marker'), 'utf8');
    await svc.push({ force: true });
    expect(fs.readFileSync(path.join(ts(), '.sync-marker'), 'utf8')).toBe(before);
    expect(svc.lastFailedCycleAt).not.toBeNull();
  });
});

describe('the health check and the saved-settings file (B-2)', () => {
  const tmpHome = path.join(os.tmpdir(), `sync-service-cfgheal-${process.pid}-${Date.now()}`);
  const cfg = () => path.join(tmpHome, '.claude', 'toolkit-state', 'config.json');
  beforeEach(() => { fs.mkdirSync(path.dirname(cfg()), { recursive: true }); setClaudeDirForTests(tmpHome); });
  afterEach(async () => { vi.restoreAllMocks(); await writeWarnings([]); try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {} });
  const run = async () => {
    const svc = new SyncService(tmpHome) as any;
    vi.spyOn(svc, 'probeInternet').mockResolvedValue(true);
    vi.spyOn(svc, 'autoDetectBackend').mockResolvedValue(null);
    await svc.runHealthCheck({ probeBackends: false });
    return (await readWarnings()).map((w) => w.code);
  };

  it('a damaged file with a saved copy is restored, the person is told once, and dismissing ends it for good', async () => {
    const good = JSON.stringify({ storage_backends: [{ id: 'drive-1', type: 'drive', label: 'D', syncEnabled: true, config: {} }] });
    fs.writeFileSync(cfg(), good); fs.writeFileSync(`${cfg()}.good`, good);
    fs.writeFileSync(cfg(), '{"storage_backends":[{"id"');
    expect(await run()).toContain('CONFIG_RESTORED');
    expect(JSON.parse(fs.readFileSync(cfg(), 'utf8')).storage_backends).toHaveLength(1);
    const state = await import('../src/main/sync-state');
    await state.dismissWarning('CONFIG_RESTORED');
    expect(await run()).not.toContain('CONFIG_RESTORED');
    expect(fs.existsSync(`${cfg()}.recovered.json`)).toBe(false);
  });

  it('a file nothing can be read from shows the red notice (and not also "No sync configured") and is left untouched', async () => {
    const damaged = '{"storage_backends":[{"id":"drive-1","ty';
    fs.writeFileSync(cfg(), damaged);
    const codes = await run();
    expect(codes).toContain('CONFIG_DAMAGED');
    expect(codes).not.toContain('PERSONAL_NOT_CONFIGURED');
    expect(fs.readFileSync(cfg(), 'utf8')).toBe(damaged);
    const state = await import('../src/main/sync-state');
    expect(await state.startFreshBackupSettings()).toBe(true);
    expect(await run()).not.toContain('CONFIG_DAMAGED');
  });
});
