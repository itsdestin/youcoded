// R-4 L-1 / L-2: the backup lock is the shared owned-lock, takes over a stale one after 2 hours, and a day of skipped
// backups shows the existing red warning (and clears it when a backup runs again).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SyncService } from '../src/main/sync-service';
import { setClaudeDirForTests, readWarnings } from '../src/main/sync-state';

const HOUR = 3600_000;
describe('backup lock wiring', () => {
  let home = ''; let lockDir = ''; let svc: SyncService;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-sync-lock-'));
    fs.mkdirSync(path.join(home, '.claude', 'toolkit-state'), { recursive: true });
    setClaudeDirForTests(home);
    lockDir = path.join(home, '.claude', 'toolkit-state', '.sync-lock');
    svc = new SyncService(home);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-18T00:00:00Z'));
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }); });

  // A lock held by a running process we cannot verify (no start time recorded), made `ageH` hours ago.
  const heldByLivingUnverified = (ageH: number) => {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, startTime: null, createdAt: Date.now() - ageH * HOUR, token: 'other' }));
  };
  const acquire = () => (svc as any).acquireLock() as Promise<boolean>;

  it('L-1: refuses a young unverifiable lock, takes over one older than 2 hours', async () => {
    heldByLivingUnverified(1);
    expect(await acquire()).toBe(false);
    fs.rmSync(lockDir, { recursive: true }); heldByLivingUnverified(2.1);
    expect(await acquire()).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8')).token).not.toBe('other');
    await (svc as any).releaseLock(); expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('L-2: no warning on day one; red warning after 24 hours of skipping; gone once a backup runs', async () => {
    heldByLivingUnverified(0.5);              // owner young => skipped now; we then keep the same lock and move the clock only
    const skip = async () => { fs.rmSync(lockDir, { recursive: true, force: true }); heldByLivingUnverified(0.5); expect(await acquire()).toBe(false); };
    await skip();
    expect(await readWarnings()).toEqual([]);
    vi.setSystemTime(new Date('2026-11-18T23:00:00Z')); await skip();
    expect(await readWarnings()).toEqual([]);                 // 23 hours: not yet
    vi.setSystemTime(new Date('2026-11-19T01:00:00Z')); await skip();
    const w = (await readWarnings()).filter((x) => x.code === 'BACKUP_SKIPPED');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ level: 'danger', title: "Backups haven't run for over a day", dismissible: false });
    fs.rmSync(lockDir, { recursive: true, force: true });
    expect(await acquire()).toBe(true);                       // a backup runs again
    expect(await readWarnings()).toEqual([]);
    expect(fs.existsSync(path.join(home, '.claude', 'toolkit-state', '.sync-skipped-since'))).toBe(false);
    await (svc as any).releaseLock();
  });

  it('stop() releases the lock it holds, synchronously', async () => {
    expect(await acquire()).toBe(true);
    svc.stop(); expect(fs.existsSync(lockDir)).toBe(false);
  });
});
