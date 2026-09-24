import { describe, it, expect, afterEach } from 'vitest';
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
