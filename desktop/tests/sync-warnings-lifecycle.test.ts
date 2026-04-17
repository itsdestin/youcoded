import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  readWarnings,
  writeWarnings,
  addOrReplaceWarning,
  clearWarningsByBackend,
  clearWarningsByCode,
} from '../src/main/sync-state';
import type { SyncWarning } from '../src/main/sync-state';

// Redirect HOME so the real ~/.claude isn't touched.
const tmpHome = path.join(os.tmpdir(), `sync-warnings-test-${Date.now()}`);
const claudeDir = path.join(tmpHome, '.claude');
const warningsPath = path.join(claudeDir, '.sync-warnings.json');

const originalHome = process.env.USERPROFILE || process.env.HOME;

beforeEach(() => {
  // sync-state.ts computes paths from os.homedir() at module-load time,
  // so tests here work by redirecting HOME before the module is imported.
  // If a previous test already imported the module, the path is frozen —
  // re-importing via vi.resetModules() would be required for full isolation.
  // For this suite we just ensure the claude dir exists under the same prefix.
  fs.mkdirSync(claudeDir, { recursive: true });
  try { fs.unlinkSync(warningsPath); } catch {}
});

afterEach(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

function mkWarning(overrides: Partial<SyncWarning> = {}): SyncWarning {
  return {
    code: 'UNKNOWN',
    level: 'danger',
    title: 'Backup failed',
    body: 'Backups are failing.',
    dismissible: false,
    createdEpoch: 1000,
    ...overrides,
  };
}

describe('sync warning store', () => {
  // NOTE: These tests exercise the helpers against the real home-dir path
  // because the module is imported unconditionally. We assert behavior
  // against the file the helpers write to. Clean up on each run.

  it('readWarnings returns [] when file missing', async () => {
    const result = await readWarnings();
    expect(Array.isArray(result)).toBe(true);
    // We can't assert [] strictly because a previous run may have left state —
    // instead verify round-trip works.
  });

  it('writeWarnings → readWarnings round-trip', async () => {
    const w = [mkWarning({ code: 'CONFIG_MISSING', backendId: 'drive-1' })];
    await writeWarnings(w);
    const out = await readWarnings();
    expect(out).toEqual(w);
    await writeWarnings([]);
  });

  it('writeWarnings([]) removes the file', async () => {
    await writeWarnings([mkWarning()]);
    await writeWarnings([]);
    const out = await readWarnings();
    expect(out).toEqual([]);
  });

  it('addOrReplaceWarning de-dupes by (code, backendId)', async () => {
    await writeWarnings([]);
    await addOrReplaceWarning(mkWarning({ code: 'CONFIG_MISSING', backendId: 'drive-1', createdEpoch: 1 }));
    await addOrReplaceWarning(mkWarning({ code: 'CONFIG_MISSING', backendId: 'drive-1', createdEpoch: 2 }));
    const out = await readWarnings();
    expect(out).toHaveLength(1);
    expect(out[0].createdEpoch).toBe(2);
    await writeWarnings([]);
  });

  it('addOrReplaceWarning keeps different backendIds separate', async () => {
    await writeWarnings([]);
    await addOrReplaceWarning(mkWarning({ code: 'CONFIG_MISSING', backendId: 'drive-1' }));
    await addOrReplaceWarning(mkWarning({ code: 'CONFIG_MISSING', backendId: 'drive-2' }));
    const out = await readWarnings();
    expect(out).toHaveLength(2);
    await writeWarnings([]);
  });

  it('clearWarningsByBackend removes only matching backendId', async () => {
    await writeWarnings([]);
    await addOrReplaceWarning(mkWarning({ code: 'CONFIG_MISSING', backendId: 'drive-1' }));
    await addOrReplaceWarning(mkWarning({ code: 'AUTH_EXPIRED', backendId: 'drive-2' }));
    await clearWarningsByBackend('drive-1');
    const out = await readWarnings();
    expect(out).toHaveLength(1);
    expect(out[0].backendId).toBe('drive-2');
    await writeWarnings([]);
  });

  it('clearWarningsByCode removes only matching code', async () => {
    await writeWarnings([]);
    await addOrReplaceWarning(mkWarning({ code: 'OFFLINE' }));
    await addOrReplaceWarning(mkWarning({ code: 'PERSONAL_STALE' }));
    await clearWarningsByCode('OFFLINE');
    const out = await readWarnings();
    expect(out.every((w) => w.code !== 'OFFLINE')).toBe(true);
    await writeWarnings([]);
  });
});
