// "Back up now" / "Upload now" must copy conversations and project files too, and must never say
// "finished" for a backup that copied nothing (backup fixes 2026-11-18, items 1 and 3).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// sync-state reads from the spaces service; replace it so no engine, timer or git is involved.
const backupNow = vi.fn();
vi.mock('../src/main/sync-spaces/service', () => ({
  getLastSyncByDevice: () => ({}),
  getSelfLastSyncEpochMs: () => null,
  isSyncSpacesSyncing: () => false,
  syncSpacesBackupNow: (...a: any[]) => backupNow(...a),
}));

import * as state from '../src/main/sync-state';
import { setRunningOnPhone } from '../src/main/backup-platform';

const drive = { id: 'drive-1', type: 'drive', label: 'My Drive', syncEnabled: true, config: { rcloneRemote: 'gdrive', DRIVE_ROOT: 'Claude' } };
const pausedIcloud = { id: 'icloud-1', type: 'icloud', label: 'iCloud', syncEnabled: false, config: { ICLOUD_PATH: '/icloud/YouCoded' } };
const github = { id: 'github-1', type: 'github', label: 'GitHub', syncEnabled: true, config: { PERSONAL_SYNC_REPO: 'https://github.com/me/x' } };

let home: string;
const push = vi.fn();
const fakeService: any = { push: (...a: any[]) => push(...a), stop() {}, setHealthCheckGate() {} };

function writeBackends(list: any[]) {
  fs.mkdirSync(path.join(home, '.claude', 'toolkit-state'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'toolkit-state', 'config.json'), JSON.stringify({ storage_backends: list }));
}
const warnings = () => state.readWarnings();

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-state-now-'));
  state.setClaudeDirForTests(home);
  state.setSyncService(fakeService);
  push.mockReset(); backupNow.mockReset();
  push.mockResolvedValue({ success: true, errors: 0, backends: ['drive-1'] });
  backupNow.mockResolvedValue({ ok: true, failures: [] });
});
afterEach(() => {
  setRunningOnPhone(false);
  state.setSyncService(null);
  fs.rmSync(home, { recursive: true, force: true });
});

describe('forceSync ("Back up all now")', () => {
  it('also copies conversations and project files to every auto-backup destination', async () => {
    writeBackends([drive, pausedIcloud, github]);
    const res = await state.forceSync();
    expect(res.success).toBe(true);
    expect(push).toHaveBeenCalledWith({ force: true });
    // Only the destinations that are switched on: the paused iCloud and the GitHub entry are not targets.
    expect(backupNow).toHaveBeenCalledWith([{ type: 'drive', base: 'gdrive:Claude' }]);
  });

  it('is NOT finished when only the conversations half fails — and the failure reaches the red box', async () => {
    writeBackends([drive]);
    backupNow.mockResolvedValue({ ok: false, failures: [{ target: { type: 'drive', base: 'gdrive:Claude' }, message: 'invalid_grant: token expired' }] });
    const res = await state.forceSync();
    expect(res.success).toBe(false);
    expect(res.error).toBe("Some backups didn't finish.");
    const w = await warnings();
    expect(w).toHaveLength(1);
    expect(w[0].backendId).toBe('drive-1');
    expect(w[0].dismissible).toBe(false);
  });

  it('is NOT finished when only the settings half fails', async () => {
    writeBackends([drive]);
    push.mockResolvedValue({ success: false, errors: 2, backends: ['drive-1'] });
    expect((await state.forceSync()).success).toBe(false);
  });

  it('does not start a conversations copy when nothing is switched on', async () => {
    writeBackends([github, pausedIcloud]);
    push.mockResolvedValue({ success: true, errors: 0, backends: [] });
    await state.forceSync();
    expect(backupNow).not.toHaveBeenCalled();
  });

  // Review F6: never "finished" when every switched-on entry is one that cannot run on this device.
  it('answers "nothing was copied" when the only switched-on backups cannot run here (GitHub; Drive on a phone)', async () => {
    writeBackends([github]);
    push.mockResolvedValue({ success: true, errors: 0, backends: [] });
    expect(await state.forceSync()).toMatchObject({ success: false, error: 'Nothing was copied.' });
    writeBackends([drive]);
    setRunningOnPhone(true);
    expect(await state.forceSync()).toMatchObject({ success: false, error: 'Nothing was copied.' });
  });

  it('with no backups switched on at all, keeps its earlier plain answer', async () => {
    writeBackends([{ ...drive, syncEnabled: false }]);
    push.mockResolvedValue({ success: true, errors: 0, backends: [] });
    expect(await state.forceSync()).toMatchObject({ success: true, output: 'No backends configured' });
  });

  it('on a phone leaves Drive out of the conversations copy', async () => {
    writeBackends([drive]);
    setRunningOnPhone(true);
    await state.forceSync();
    expect(backupNow).not.toHaveBeenCalled();
  });
});

describe('pushBackend ("Upload now" on one row)', () => {
  it('copies the personal set AND conversations/project files to that one destination', async () => {
    writeBackends([drive, pausedIcloud]);
    expect(await state.pushBackend('drive-1')).toEqual({ success: true, error: '' });
    expect(push).toHaveBeenCalledWith({ force: true, backendId: 'drive-1' });
    expect(backupNow).toHaveBeenCalledWith([{ type: 'drive', base: 'gdrive:Claude' }]);
  });

  it('includes a paused destination when the person asks for it by name', async () => {
    writeBackends([pausedIcloud]);
    push.mockResolvedValue({ success: true, errors: 0, backends: ['icloud-1'] });
    await state.pushBackend('icloud-1');
    expect(backupNow).toHaveBeenCalledWith([{ type: 'icloud', base: '/icloud/YouCoded' }]);
  });

  it('reports failure when only the conversations half fails', async () => {
    writeBackends([drive]);
    backupNow.mockResolvedValue({ ok: false, failures: [{ target: { type: 'drive', base: 'gdrive:Claude' }, message: 'boom' }] });
    const res = await state.pushBackend('drive-1');
    expect(res.success).toBe(false);
    expect(res.error).toBe("Some files didn't upload.");
  });

  // Item 1: a skipped backup must never read as "finished".
  it('says so, instead of "finished", for a GitHub backup (nothing is copied)', async () => {
    writeBackends([github]);
    push.mockResolvedValue({ success: true, errors: 0, backends: [] }); // what SyncService.push answers (pinned)
    const res = await state.pushBackend('github-1');
    expect(res.success).toBe(false);
    expect(res.error).toBe('GitHub backups are no longer supported, so nothing was copied.');
    expect(backupNow).not.toHaveBeenCalled();
  });

  it('says so for a Drive backup on a phone', async () => {
    writeBackends([drive]);
    setRunningOnPhone(true);
    const res = await state.pushBackend('drive-1');
    expect(res).toEqual({ success: false, error: "Google Drive backup isn't available on this phone, so nothing was copied." });
    expect(push).not.toHaveBeenCalled();
  });

  it('says so for a backup that no longer exists (a stale button)', async () => {
    writeBackends([drive]);
    push.mockResolvedValue({ success: true, errors: 0, backends: [] });
    const res = await state.pushBackend('gone');
    expect(res.success).toBe(false);
    expect(res.error).toBe('That backup was not found.');
  });

  it('never answers success when the push skipped this backup for another reason', async () => {
    writeBackends([drive]);
    push.mockResolvedValue({ success: true, errors: 0, backends: [] });
    expect((await state.pushBackend('drive-1')).success).toBe(false);
  });

  it('stays an empty (unspecific) failure when another backup is running', async () => {
    writeBackends([drive]);
    push.mockResolvedValue({ success: false, errors: 0, backends: [] });
    expect(await state.pushBackend('drive-1')).toEqual({ success: false, error: '' });
  });
});

// Review F7: a warning from the conversations/project-files half is cleared only when THAT half next succeeds — not by the
// settings half succeeding. (Failures of the daily timer's own run still only go to the log: no new warning.)
describe('warnings raised by the conversations half of "Back up now"', () => {
  const fail = { ok: false, failures: [{ target: { type: 'drive', base: 'gdrive:Claude' }, message: 'quotaExceeded: storage full' }] };

  it('survive a later success of the settings half', async () => {
    writeBackends([drive]);
    backupNow.mockResolvedValue(fail);
    await state.forceSync();
    expect((await warnings()).map((w) => w.backendId)).toEqual(['drive-1']);
    // What SyncService does when its own half succeeds:
    await state.clearWarningsByBackend('drive-1', 'personal');
    expect((await warnings()).map((w) => w.backendId)).toEqual(['drive-1']);
  });

  it('go away when the conversations half next succeeds', async () => {
    writeBackends([drive]);
    backupNow.mockResolvedValue(fail);
    await state.forceSync();
    backupNow.mockResolvedValue({ ok: true, failures: [] });
    await state.forceSync();
    expect(await warnings()).toEqual([]);
  });

  it('stay a single warning while that half keeps failing, and do not hide a failure of the settings half', async () => {
    writeBackends([drive]);
    backupNow.mockResolvedValue(fail);
    await state.forceSync(); await state.forceSync();
    expect(await warnings()).toHaveLength(1);
    await state.addOrReplaceWarning({ code: 'UNKNOWN', level: 'danger', backendId: 'drive-1', title: 'personal', body: '', dismissible: false, createdEpoch: 1 });
    await state.clearWarningsByBackend('drive-1', 'spaces');
    expect((await warnings()).map((w) => w.title)).toEqual(['personal']);
  });
});
