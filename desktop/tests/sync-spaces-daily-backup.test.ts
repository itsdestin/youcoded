import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isBackupDue, datedFolderName, foldersToPrune, DailyBackup } from '../src/main/sync-spaces/daily-backup';
import type { SyncSpace } from '../src/main/sync-spaces/types';
import type { BackendInstance } from '../src/main/sync-state';

const backend = (id: string, type: BackendInstance['type'], syncEnabled = true,
  config: Record<string, string> = {}): BackendInstance => ({ id, label: id, type, syncEnabled, config });

// WHY: exercise the same configuration-to-target composition the app supplies to startSyncSpaces.
const targets = async (backends: BackendInstance[]) => {
  const { loadSpaceBackupTargets } = await import('../src/main/sync-spaces/backup-targets');
  return loadSpaceBackupTargets(async () => ({ backends }));
};

describe('automatic spaces backup targets', () => {
  it('excludes paused Drive/iCloud and GitHub while keeping enabled target order', async () => {
    expect(await targets([
      backend('drive-a', 'drive', true, { rcloneRemote: 'personal', DRIVE_ROOT: 'My Files' }),
      backend('drive-paused', 'drive', false),
      backend('icloud-a', 'icloud', true, { ICLOUD_PATH: '/fixtures/cloud-a' }),
      backend('github', 'github'),
      backend('icloud-paused', 'icloud', false, { ICLOUD_PATH: '/fixtures/paused' }),
      backend('drive-b', 'drive', true, { rcloneRemote: 'work', DRIVE_ROOT: 'Work' }),
    ])).toEqual([
      { type: 'drive', base: 'personal:My Files' },
      { type: 'icloud', base: '/fixtures/cloud-a' },
      { type: 'drive', base: 'work:Work' },
    ]);
  });

  it('skips empty/missing iCloud paths and every non-true consent flag', async () => {
    const malformed = [false, undefined, null, 0, 1, '', 'false', 'true'].map(flag => ({
      ...backend(String(flag), 'drive'), syncEnabled: flag,
    })) as unknown as BackendInstance[];
    expect(await targets([...malformed, backend('icloud', 'icloud'), backend('blank', 'icloud', true, { ICLOUD_PATH: '' })])).toEqual([]);
    expect(await targets([])).toEqual([]);
  });

  it('preserves Drive defaults, explicit empty strings and frozen input', async () => {
    const entries = [
      backend('defaults', 'drive'), backend('remote', 'drive', true, { rcloneRemote: '' }),
      backend('root', 'drive', true, { DRIVE_ROOT: '' }),
      backend('both', 'drive', true, { rcloneRemote: '', DRIVE_ROOT: '' }),
    ];
    entries.forEach(entry => { Object.freeze(entry.config); Object.freeze(entry); });
    Object.freeze(entries);
    expect(await targets(entries)).toEqual([
      { type: 'drive', base: 'gdrive:Claude' }, { type: 'drive', base: ':Claude' },
      { type: 'drive', base: 'gdrive:' }, { type: 'drive', base: ':' },
    ]);
  });
});

// Backup fixes 2026-11-18 (item 2): a phone has no rclone, so its Drive entries must never be a target.
describe('backup targets on a phone', () => {
  afterEach(async () => { (await import('../src/main/backup-platform')).setRunningOnPhone(false); });
  const mixed = [
    backend('drive-a', 'drive', true, { rcloneRemote: 'personal', DRIVE_ROOT: 'My Files' }),
    backend('icloud-a', 'icloud', true, { ICLOUD_PATH: '/fixtures/cloud-a' }),
  ];

  it('leaves Drive out on the phone\'s own backend and keeps it everywhere else', async () => {
    const platform = await import('../src/main/backup-platform');
    expect(await targets(mixed)).toHaveLength(2); // a computer (the default): both
    platform.setRunningOnPhone(true);
    expect(await targets(mixed)).toEqual([{ type: 'icloud', base: '/fixtures/cloud-a' }]);
  });

  it('targetForBackend builds one destination, including a paused one (a manual "Upload now")', async () => {
    const { targetForBackend } = await import('../src/main/sync-spaces/backup-targets');
    expect(targetForBackend(backend('d', 'drive', false, { rcloneRemote: 'w', DRIVE_ROOT: 'X' }))).toEqual({ type: 'drive', base: 'w:X' });
    expect(targetForBackend(backend('i', 'icloud', false, { ICLOUD_PATH: '/p' }))).toEqual({ type: 'icloud', base: '/p' });
    expect(targetForBackend(backend('g', 'github'))).toBeNull();
    expect(targetForBackend(backend('i2', 'icloud', true, { ICLOUD_PATH: '' }))).toBeNull();
    (await import('../src/main/backup-platform')).setRunningOnPhone(true);
    expect(targetForBackend(backend('d', 'drive', true))).toBeNull();
  });
});

describe('isBackupDue', () => {
  it('due when no marker', () => expect(isBackupDue(null, new Date('2026-07-03T10:00:00Z'))).toBe(true));
  it('not due same UTC day', () => expect(isBackupDue('2026-07-03', new Date('2026-07-03T23:00:00Z'))).toBe(false));
  it('due on a new UTC day', () => expect(isBackupDue('2026-07-02', new Date('2026-07-03T00:10:00Z'))).toBe(true));
});

describe('datedFolderName', () => {
  it('is the UTC date', () => expect(datedFolderName(new Date('2026-07-03T14:00:00Z'))).toBe('2026-07-03'));
});

describe('foldersToPrune', () => {
  it('keeps 30 days, prunes older, ignores non-date names', () => {
    const now = new Date('2026-07-03T00:00:00Z');
    expect(foldersToPrune(['2026-07-01', '2026-05-01', 'junk', '2026-06-04'], now, 30))
      .toEqual(['2026-05-01']);
  });
});

// End-to-end async iCloud path: real tmp dirs, no mocks. Pins that the copy
// scrubs DEFAULT_IGNORES, the marker gates same-day re-runs, and runIfDue
// never throws — the contract the hourly timer (Task 8) relies on.
describe('DailyBackup.runIfDue (icloud end-to-end)', () => {
  let tmp: string;
  afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  it('copies scrubbed, writes marker, no-ops same UTC day', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-backup-'));
    const root = path.join(tmp, 'space');
    const base = path.join(tmp, 'icloud');
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'notes.md'), 'hello');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'i.js'), 'x');
    const markerPath = path.join(tmp, 'marker');
    const logs: string[] = [];
    const space: SyncSpace = { id: 'project:demo', kind: 'project', root };
    const job = new DailyBackup({ markerPath });

    await job.runIfDue([space], [{ type: 'icloud', base }], m => logs.push(m));

    // Read the dated folder back from the marker so a run that straddles UTC
    // midnight can't flake the test.
    const marker = fs.readFileSync(markerPath, 'utf8');
    expect(marker).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const dest = path.join(base, 'Backup', 'spaces', marker, 'project-demo');
    expect(fs.readFileSync(path.join(dest, 'notes.md'), 'utf8')).toBe('hello');
    expect(fs.existsSync(path.join(dest, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'node_modules'))).toBe(false);
    expect(logs.some(m => m.includes('spaces-backup completed'))).toBe(true);

    // Same UTC day → second call must no-op (marker gate), so a file added
    // after the backup does not appear in the dated folder.
    fs.writeFileSync(path.join(root, 'later.md'), 'x');
    await job.runIfDue([space], [{ type: 'icloud', base }], m => logs.push(m));
    expect(fs.existsSync(path.join(dest, 'later.md'))).toBe(false);
  });
});

describe('DailyBackup.runIfDue failure handling', () => {
  let tmp: string;
  afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const mkSpace = (name: string): SyncSpace => {
    const root = path.join(tmp, name);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'notes.md'), name);
    return { id: `project:${name}`, kind: 'project', root };
  };
  const today = () => datedFolderName(new Date());

  it('a failed copy keeps old snapshots and the day open, then retries only what failed', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-backup-'));
    const base = path.join(tmp, 'icloud');
    const old = path.join(base, 'Backup', 'spaces', '2020-01-01', 'project-a');
    fs.mkdirSync(old, { recursive: true });
    const good = mkSpace('good');
    const bad = mkSpace('bad');
    const markerPath = path.join(tmp, 'marker');
    const job = new DailyBackup({ markerPath });
    // WHY an injected failure (backup fixes 2026-11-18, D-7): this used to make `bad` fail by pointing it
    // at a folder that does not exist — but a missing folder is now skipped, not failed (see below).
    const realCopy = (job as any).copySpace.bind(job);
    let badFails = true;
    vi.spyOn(job as any, 'copySpace').mockImplementation((async (sp: SyncSpace, ...rest: any[]) => {
      if (sp.id === 'project:bad' && badFails) throw new Error('disk said no');
      return realCopy(sp, ...rest);
    }) as any);
    const logs: string[] = [];
    await job.runIfDue([good, bad], [{ type: 'icloud', base }], m => logs.push(m));
    // WHY: with no fresh snapshot, pruning would only shrink the recovery set.
    expect(fs.existsSync(old)).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(logs.some(m => m.includes('spaces-backup completed'))).toBe(false);

    badFails = false;
    fs.writeFileSync(path.join(bad.root, 'notes.md'), 'bad');
    fs.writeFileSync(path.join(good.root, 'later.md'), 'x');
    await job.runIfDue([good, bad], [{ type: 'icloud', base }], m => logs.push(m));
    const day = path.join(base, 'Backup', 'spaces', today());
    expect(fs.readFileSync(path.join(day, 'project-bad', 'notes.md'), 'utf8')).toBe('bad');
    expect(fs.existsSync(path.join(day, 'project-good', 'later.md'))).toBe(false); // not redone
    expect(fs.readFileSync(markerPath, 'utf8')).toBe(today());
    expect(fs.existsSync(old)).toBe(false); // pruned once today's snapshot landed
  });

  // D-7: one space whose folder is gone used to block pruning and the day's marker for the whole destination.
  it('a space whose folder is missing is skipped — the others still land, old snapshots prune, the day closes', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-backup-'));
    const base = path.join(tmp, 'icloud');
    const old = path.join(base, 'Backup', 'spaces', '2020-01-01', 'project-a');
    fs.mkdirSync(old, { recursive: true });
    const good = mkSpace('good');
    const gone: SyncSpace = { id: 'project:gone', kind: 'project', root: path.join(tmp, 'deleted-project') };
    const markerPath = path.join(tmp, 'marker');
    const logs: string[] = [];
    await new DailyBackup({ markerPath }).runIfDue([good, gone], [{ type: 'icloud', base }], m => logs.push(m));
    expect(fs.readFileSync(path.join(base, 'Backup', 'spaces', today(), 'project-good', 'notes.md'), 'utf8')).toBe('good');
    expect(fs.readFileSync(markerPath, 'utf8')).toBe(today());
    expect(fs.existsSync(old)).toBe(false);
    expect(logs.some(m => m.includes('project:gone') && m.includes('missing'))).toBe(true);
  });

  it("one destination's success does not end another destination's retries", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-backup-'));
    const space = mkSpace('s');
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    fs.writeFileSync(b, 'a file where the folder should be');
    const markerPath = path.join(tmp, 'marker');
    const job = new DailyBackup({ markerPath });
    const targets = [{ type: 'icloud' as const, base: a }, { type: 'icloud' as const, base: b }];
    await job.runIfDue([space], targets, () => {});
    expect(fs.existsSync(markerPath)).toBe(false);
    fs.rmSync(b);
    await job.runIfDue([space], targets, () => {});
    expect(fs.readFileSync(path.join(b, 'Backup', 'spaces', today(), 'project-s', 'notes.md'), 'utf8')).toBe('s');
    expect(fs.readFileSync(markerPath, 'utf8')).toBe(today());
  });

  it("an older device's copy never replaces a newer file in the shared dated folder", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-backup-'));
    const base = path.join(tmp, 'icloud');
    const newer = mkSpace('laptop/s');
    const older = mkSpace('desktop/s');
    fs.writeFileSync(path.join(older.root, 'notes.md'), 'stale');
    const past = new Date(Date.now() - 3_600_000);
    fs.utimesSync(path.join(older.root, 'notes.md'), past, past);
    newer.id = older.id = 'project:s';
    await new DailyBackup({ markerPath: path.join(tmp, 'm1') }).runIfDue([newer], [{ type: 'icloud', base }], () => {});
    await new DailyBackup({ markerPath: path.join(tmp, 'm2') }).runIfDue([older], [{ type: 'icloud', base }], () => {});
    expect(fs.readFileSync(path.join(base, 'Backup', 'spaces', today(), 'project-s', 'notes.md'), 'utf8')).toBe('laptop/s');
  });
});

describe('foldersToPrune keeps the newest snapshot', () => {
  it('never returns the newest dated folder, however old', () => {
    expect(foldersToPrune(['2020-01-01', '2020-02-01'], new Date('2026-07-03T00:00:00Z'), 30)).toEqual(['2020-01-01']);
  });
});

// "Back up now" must copy conversations and project files too (backup fixes 2026-11-18, item 3).
describe('DailyBackup.runNow', () => {
  let tmp: string;
  afterEach(() => { vi.restoreAllMocks(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const today = () => datedFolderName(new Date());
  const setup = () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-backup-now-'));
    const root = path.join(tmp, 'space');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'notes.md'), 'v1');
    const space: SyncSpace = { id: 'project:demo', kind: 'project', root };
    return { space, root, base: path.join(tmp, 'icloud'), markerPath: path.join(tmp, 'marker') };
  };

  it('copies even though today\'s marker says the day is done, and leaves the marker alone', async () => {
    const { space, root, base, markerPath } = setup();
    fs.writeFileSync(markerPath, today()); // the daily timer already finished today
    const job = new DailyBackup({ markerPath });
    await job.runIfDue([space], [{ type: 'icloud', base }], () => {});
    expect(fs.existsSync(path.join(base, 'Backup'))).toBe(false); // the timer correctly did nothing
    const res = await job.runNow([space], [{ type: 'icloud', base }], () => {});
    expect(res).toEqual({ ok: true, failures: [] });
    expect(fs.readFileSync(path.join(base, 'Backup', 'spaces', today(), 'project-demo', 'notes.md'), 'utf8')).toBe('v1');
    expect(fs.readFileSync(markerPath, 'utf8')).toBe(today()); // unchanged value, not rewritten by runNow
  });

  it('picks up changes made since an earlier run the same day', async () => {
    const { space, root, base, markerPath } = setup();
    const job = new DailyBackup({ markerPath });
    await job.runNow([space], [{ type: 'icloud', base }], () => {});
    await new Promise(r => setTimeout(r, 20)); // a later mtime than the first copy
    fs.writeFileSync(path.join(root, 'notes.md'), 'v2');
    fs.writeFileSync(path.join(root, 'added.md'), 'new');
    await job.runNow([space], [{ type: 'icloud', base }], () => {});
    const dest = path.join(base, 'Backup', 'spaces', today(), 'project-demo');
    expect(fs.readFileSync(path.join(dest, 'added.md'), 'utf8')).toBe('new');
  });

  it('does NOT close the day: with no marker before, there is still none after (one destination must not close it for the rest)', async () => {
    const { space, base, markerPath } = setup();
    const job = new DailyBackup({ markerPath });
    await job.runNow([space], [{ type: 'icloud', base }], () => {});
    expect(fs.existsSync(markerPath)).toBe(false);
    // ...and the next hourly check only has to finish the day (nothing is copied again).
    const copy = vi.spyOn(job as any, 'copySpace');
    await job.runIfDue([space], [{ type: 'icloud', base }], () => {});
    expect(copy).not.toHaveBeenCalled();
    expect(fs.readFileSync(markerPath, 'utf8')).toBe(today());
  });

  it('uses the destinations it is given, so a paused one the person asked for by name is included', async () => {
    const { space, base, markerPath } = setup();
    // The timer's own list (loadSpaceBackupTargets) leaves paused destinations out; runNow takes what it is handed.
    await new DailyBackup({ markerPath }).runNow([space], [{ type: 'icloud', base }], () => {});
    expect(fs.existsSync(path.join(base, 'Backup', 'spaces', today(), 'project-demo', 'notes.md'))).toBe(true);
  });

  it('reports a failed copy with the tool\'s own words, and does not prune on it', async () => {
    const { space, base, markerPath } = setup();
    const old = path.join(base, 'Backup', 'spaces', '2020-01-01', 'project-a');
    fs.mkdirSync(old, { recursive: true });
    const job = new DailyBackup({ markerPath });
    vi.spyOn(job as any, 'copySpace').mockRejectedValue(Object.assign(new Error('x'), { stderr: 'token expired' }));
    const res = await job.runNow([space], [{ type: 'icloud', base }], () => {});
    expect(res.ok).toBe(false);
    expect(res.failures).toEqual([{ target: { type: 'icloud', base }, message: 'token expired' }]);
    expect(fs.existsSync(old)).toBe(true);
  });

  it('says which destination is being copied to while a copy runs, and nothing before or after (B-1)', async () => {
    const { space, base, markerPath } = setup();
    const job = new DailyBackup({ markerPath });
    expect(job.copyingTargets()).toEqual([]);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let seen: string[] = [];
    vi.spyOn(job as any, 'copySpace').mockImplementation(async () => { seen = job.copyingTargets(); await gate; });
    const run = job.runNow([space], [{ type: 'icloud', base }], () => {});
    await vi.waitFor(() => expect(seen).toEqual([`icloud|${base}`]));
    release();
    await run;
    expect(job.copyingTargets()).toEqual([]);
  });

  it('stops saying a copy is running when it failed too', async () => {
    const { space, base, markerPath } = setup();
    const job = new DailyBackup({ markerPath });
    vi.spyOn(job as any, 'copySpace').mockRejectedValue(new Error('x'));
    await job.runNow([space], [{ type: 'icloud', base }], () => {});
    expect(job.copyingTargets()).toEqual([]);
  });

  it('never overlaps itself or the hourly timer: a second run waits, a duplicate tap joins, the timer skips', async () => {
    const { space, base, markerPath } = setup();
    const job = new DailyBackup({ markerPath });
    let inFlight = 0; let maxInFlight = 0; let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    vi.spyOn(job as any, 'copySpace').mockImplementation(async () => {
      calls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await gate; inFlight--;
    });
    const target = { type: 'icloud' as const, base };
    const first = job.runNow([space], [target], () => {});
    const duplicate = job.runNow([space], [target], () => {});          // same button tapped again
    const other = job.runNow([space], [{ type: 'icloud', base: base + '2' }], () => {}); // a different destination
    const logs: string[] = [];
    await job.runIfDue([space], [target], m => logs.push(m));            // the hourly timer fires meanwhile
    expect(logs.some(m => m.includes('already running'))).toBe(true);
    release();
    await Promise.all([first, duplicate, other]);
    expect(maxInFlight).toBe(1);
    expect(calls).toBe(2); // the duplicate joined the first run instead of copying again
  });

  // Review M4: a manual run that arrives while the hourly timer is mid-copy waits for it; they never copy at once.
  it('a "Back up now" tapped while the hourly timer is copying waits for the timer to finish', async () => {
    const { space, base, markerPath } = setup();
    const job = new DailyBackup({ markerPath });
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let first = true;
    vi.spyOn(job as any, 'copySpace').mockImplementation(async () => {
      const who = first ? 'timer' : 'manual'; first = false;
      events.push(`${who} start`);
      if (who === 'timer') await gate;
      events.push(`${who} end`);
    });
    const target = { type: 'icloud' as const, base };
    const timer = job.runIfDue([space], [target], () => {});
    await new Promise(r => setTimeout(r, 10)); // the timer is now inside its copy
    const manual = job.runNow([space], [target], () => {});
    await new Promise(r => setTimeout(r, 30));
    expect(events).toEqual(['timer start']); // the manual run has not started
    release();
    await Promise.all([timer, manual]);
    expect(events).toEqual(['timer start', 'timer end', 'manual start', 'manual end']);
  });

  it('the hourly timer cannot start a second copy on top of itself either', async () => {
    const { space, base, markerPath } = setup();
    const job = new DailyBackup({ markerPath });
    let inFlight = 0; let maxInFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    vi.spyOn(job as any, 'copySpace').mockImplementation(async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await gate; inFlight--;
    });
    const t = [{ type: 'icloud' as const, base }];
    const a = job.runIfDue([space], t, () => {});
    const b = job.runIfDue([space], t, () => {});
    await new Promise(r => setTimeout(r, 10));
    release();
    await Promise.all([a, b]);
    expect(maxInFlight).toBe(1);
  });
});
