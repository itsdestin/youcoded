import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { BackendInstance } from '../src/main/sync-state';

const backend = (id: string, type: BackendInstance['type'], syncEnabled = true,
  config: Record<string, string> = {}): BackendInstance => ({ id, label: id, type, syncEnabled, config });

// WHY: execute the production selector without importing Electron startup or transports.
const select = async (backends: BackendInstance[]) => {
  const { selectSpaceBackupTargets } = await import('../src/main/sync-spaces/backup-targets');
  return selectSpaceBackupTargets(backends);
};

describe('selectSpaceBackupTargets', () => {
  it('selects enabled Drive and iCloud accounts in order, excluding paused accounts and GitHub', async () => {
    expect(await select([
      backend('drive-a', 'drive', true, { rcloneRemote: 'personal', DRIVE_ROOT: 'My Files' }),
      backend('drive-paused', 'drive', false),
      backend('icloud-a', 'icloud', true, { ICLOUD_PATH: '/fixtures/cloud-a' }),
      backend('github', 'github'),
      backend('icloud-paused', 'icloud', false, { ICLOUD_PATH: '/fixtures/paused' }),
      backend('drive-b', 'drive', true, { rcloneRemote: 'work', DRIVE_ROOT: 'Work' }),
      backend('icloud-b', 'icloud', true, { ICLOUD_PATH: '/fixtures/cloud-b' }),
    ])).toEqual([
      { type: 'drive', base: 'personal:My Files' },
      { type: 'icloud', base: '/fixtures/cloud-a' },
      { type: 'drive', base: 'work:Work' },
      { type: 'icloud', base: '/fixtures/cloud-b' },
    ]);
  });

  it('returns exactly no targets for empty or wholly ineligible lists', async () => {
    expect(await select([])).toEqual([]);
    expect(await select([
      backend('drive', 'drive', false),
      backend('icloud', 'icloud', false, { ICLOUD_PATH: '/fixtures/cloud' }),
      backend('github', 'github'),
      backend('missing-path', 'icloud'),
      backend('empty-path', 'icloud', true, { ICLOUD_PATH: '' }),
    ])).toEqual([]);
  });

  it.each([false, undefined, null, 0, 1, '', 'false', 'true'])('rejects non-true boundary flag %s', async (flag) => {
    // WHY: persisted malformed input can lack the typed flag; only literal true is consent.
    const entries = ['drive', 'icloud'].map(type => ({
      id: type, label: type, type, config: { ICLOUD_PATH: '/fixtures/cloud' },
      ...(flag === undefined ? {} : { syncEnabled: flag }),
    })) as unknown as BackendInstance[];
    expect(await select(entries)).toEqual([]);
  });

  it('preserves nullish Drive defaults and explicit empty strings', async () => {
    expect(await select([
      backend('defaults', 'drive'),
      backend('remote-only', 'drive', true, { rcloneRemote: 'custom' }),
      backend('root-only', 'drive', true, { DRIVE_ROOT: 'Custom' }),
      backend('empty-remote', 'drive', true, { rcloneRemote: '' }),
      backend('empty-root', 'drive', true, { DRIVE_ROOT: '' }),
      backend('both-empty', 'drive', true, { rcloneRemote: '', DRIVE_ROOT: '' }),
    ])).toEqual([
      { type: 'drive', base: 'gdrive:Claude' },
      { type: 'drive', base: 'custom:Claude' },
      { type: 'drive', base: 'gdrive:Custom' },
      { type: 'drive', base: ':Claude' },
      { type: 'drive', base: 'gdrive:' },
      { type: 'drive', base: ':' },
    ]);
  });

  it('does not mutate the input array, entries or config', async () => {
    const entries = [backend('a', 'drive'), backend('b', 'icloud', false, { ICLOUD_PATH: '/fixtures/cloud' })];
    const before = structuredClone(entries);
    entries.forEach(entry => { Object.freeze(entry.config); Object.freeze(entry); });
    Object.freeze(entries);
    expect(await select(entries)).toEqual([{ type: 'drive', base: 'gdrive:Claude' }]);
    expect(entries).toEqual(before);
  });
});

it('wires the selector inside startSyncSpaces with freshly read config', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.ts'), 'utf8');
  expect(main).toMatch(/import\s*\{\s*selectSpaceBackupTargets\s*\}\s*from\s*['"]\.\/sync-spaces\/backup-targets['"]/);
  // WHY: anchor the actual callback, not an unrelated mention elsewhere; tolerate CRLF.
  const callback = main.match(/\bstartSyncSpaces\(\s*async\s*\(\s*\)\s*=>\s*\{([\s\S]*?)\}\s*,\s*\(m\)\s*=>/);
  expect(callback).not.toBeNull();
  expect(callback?.[1].trim()).toBeTruthy();
  expect(callback?.[1]).toMatch(/const\s+cfg\s*=\s*await\s+getSyncConfig\(\s*\)\s*;\s*return\s+selectSpaceBackupTargets\(\s*cfg\?\.backends\s*\?\?\s*\[\s*\]\s*\)\s*;/);
});
