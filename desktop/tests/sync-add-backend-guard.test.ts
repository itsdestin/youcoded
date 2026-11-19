// The phone gate for ADDING a backup lives in the backend, not only in the screens (backup fixes 2026-11-18,
// review F2): sync:add-backend is open to a phone and to a remote browser, so a hand-made request must be refused too.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn(), openPath: vi.fn() }, app: { getPath: vi.fn(() => '/tmp') }, BrowserWindow: { getAllWindows: () => [] } }));

import { syncChannels } from '../src/main/ipc/sync';
import { IPC } from '../src/shared/backend-contract';
import * as state from '../src/main/sync-state';
import { setRunningOnPhone } from '../src/main/backup-platform';

let home: string;
const add = (payload: any) => (syncChannels.find((c) => c.name === IPC.SYNC_ADD_BACKEND) as any).handler(payload, { door: 'remote' });
const saved = () => {
  try { return JSON.parse(fs.readFileSync(path.join(home, '.claude', 'toolkit-state', 'config.json'), 'utf8')).storage_backends ?? []; } catch { return []; }
};

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'add-guard-')); state.setClaudeDirForTests(home); });
afterEach(() => { setRunningOnPhone(false); fs.rmSync(home, { recursive: true, force: true }); });

describe('sync:add-backend', () => {
  it('refuses a GitHub backup everywhere, with plain words, and saves nothing', async () => {
    await expect(add({ type: 'github', label: 'GH', syncEnabled: true, config: {} })).rejects.toThrow('GitHub backups are no longer supported.');
    expect(saved()).toEqual([]);
  });

  it('refuses a Google Drive backup on a phone running its own backend', async () => {
    setRunningOnPhone(true);
    await expect(add({ type: 'drive', label: 'D', syncEnabled: true, config: {} })).rejects.toThrow("Google Drive backup isn't available on this phone.");
    expect(saved()).toEqual([]);
  });

  it('still adds Google Drive on a computer (and iCloud on a phone is left to its own checks)', async () => {
    const d = await add({ type: 'drive', label: 'D', syncEnabled: true, config: {} });
    expect(saved().map((b: any) => b.id)).toEqual([d.id]);
  });
});
