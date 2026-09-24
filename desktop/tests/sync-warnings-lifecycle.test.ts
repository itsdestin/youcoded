import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Fake sync-spaces "this device" evidence for the getSyncStatus() tests below.
// vi.mock factories are hoisted above imports, so the mutable state they close
// over must go through vi.hoisted. Real service.ts pulls in the sync engine,
// chokidar, and electron (see sync-service.ts's comment on the same point) —
// far too heavy for a unit test that only needs to control two return values.
const svcMock = vi.hoisted(() => ({
  selfLastSyncMs: null as number | null,
  syncing: false,
  lastSyncByDevice: {} as Record<string, number>,
}));
vi.mock('../src/main/sync-spaces/service', () => ({
  getSelfLastSyncEpochMs: () => svcMock.selfLastSyncMs,
  isSyncSpacesSyncing: () => svcMock.syncing,
  getLastSyncByDevice: () => svcMock.lastSyncByDevice,
}));

import {
  readWarnings,
  writeWarnings,
  addOrReplaceWarning,
  clearWarningsByBackend,
  clearWarningsByCode,
  dismissWarning,
  setClaudeDirForTests,
  getSyncStatus,
} from '../src/main/sync-state';
import type { SyncWarning } from '../src/main/sync-state';

// A throwaway home for this suite. The old header claimed HOME was redirected
// "before the module is imported" — it never was: nothing assigned HOME, and a
// static import is hoisted above any assignment anyway. So every assertion here
// ran against the developer's REAL ~/.claude/.sync-warnings.json, which
// writeWarnings([]) deletes.
//
// That is what made 'clearWarningsByCode removes only matching code' flaky
// (ROADMAP :130): SyncService.runHealthCheck() writes an OFFLINE warning to
// that exact file when a YouCoded instance launches, and this suite asserts no
// OFFLINE warning survives. It was never module-load ORDER — no other suite
// writes warnings — it was a second process sharing one real file.
const tmpHome = path.join(os.tmpdir(), `sync-warnings-test-${Date.now()}`);
const claudeDir = path.join(tmpHome, '.claude');
const warningsPath = path.join(claudeDir, '.sync-warnings.json');

setClaudeDirForTests(tmpHome);

beforeEach(() => {
  fs.mkdirSync(claudeDir, { recursive: true });
  try { fs.unlinkSync(warningsPath); } catch {}
  svcMock.selfLastSyncMs = null;
  svcMock.syncing = false;
  svcMock.lastSyncByDevice = {};
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
  // These run against the throwaway home wired up at the top of the file, so
  // no other process can write the file underneath them.

  it('readWarnings returns [] when file missing', async () => {
    // Now assertable exactly: with a private home there is no leftover state
    // from a previous run or from a live app.
    expect(await readWarnings()).toEqual([]);
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

describe('dismissWarning', () => {
  it('removes a dismissible warning', async () => {
    await writeWarnings([mkWarning({ code: 'PERSONAL_STALE', dismissible: true })]);
    await dismissWarning('PERSONAL_STALE');
    const out = await readWarnings();
    expect(out.find((w) => w.code === 'PERSONAL_STALE')).toBeUndefined();
  });

  it('refuses to remove a non-dismissible warning', async () => {
    await writeWarnings([mkWarning({ code: 'CONFIG_MISSING', dismissible: false })]);
    await dismissWarning('CONFIG_MISSING');
    const out = await readWarnings();
    expect(out.find((w) => w.code === 'CONFIG_MISSING')).toBeDefined();
    await writeWarnings([]);
  });
});

describe('cleanupStaleBackendErrorFiles', () => {
  it('removes leftover .sync-error-* files', async () => {
    // Uses the same throwaway home as the rest of the file. This previously
    // wrote .sync-error-* files into the developer's REAL ~/.claude/
    // toolkit-state/ — harmless in effect, but it is a live app's directory.
    const toolkitStateDir = path.join(tmpHome, '.claude', 'toolkit-state');
    fs.mkdirSync(toolkitStateDir, { recursive: true });

    const staleA = path.join(toolkitStateDir, '.sync-error-drive-test-stale-a');
    const staleB = path.join(toolkitStateDir, '.sync-error-github-test-stale-b');
    fs.writeFileSync(staleA, 'old error');
    fs.writeFileSync(staleB, 'another old error');
    expect(fs.existsSync(staleA)).toBe(true);
    expect(fs.existsSync(staleB)).toBe(true);

    // Call the migration helper directly rather than invoking start(), which
    // would also kick off a network pull and timeout the test.
    const { SyncService } = await import('../src/main/sync-service');
    const svc = new SyncService(tmpHome);
    try {
      svc.cleanupStaleBackendErrorFiles();
      expect(fs.existsSync(staleA)).toBe(false);
      expect(fs.existsSync(staleB)).toBe(false);
    } finally {
      try { fs.unlinkSync(staleA); } catch {}
      try { fs.unlinkSync(staleB); } catch {}
    }
  });
});

// getSyncStatus() is the SyncPanel's on-mount snapshot read (the OTHER path
// besides buildStatusData()'s 10s status:data push — Task 7 only rewired the
// latter). Without this fix, a GitHub-era install (no legacy .sync-marker)
// shows the wrong self "last seen" on every panel open until the first push
// overwrites it ~10s later (2026-07-30 spec §4 gap). svcMock stands in for
// the real sync-spaces service (see the vi.mock above) so these tests don't
// need to boot the real engine/chokidar/electron just to control two values.
describe('getSyncStatus — self recency and sync-in-progress', () => {
  const toolkitStateDir = path.join(tmpHome, '.claude', 'toolkit-state');
  const markerPath = path.join(toolkitStateDir, '.sync-marker');
  const lockDir = path.join(toolkitStateDir, '.sync-lock');

  beforeEach(() => {
    fs.mkdirSync(toolkitStateDir, { recursive: true });
    try { fs.unlinkSync(markerPath); } catch {}
    try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
  });

  it('prefers sync-spaces evidence over the legacy marker, converting ms to wire seconds', async () => {
    // Spaces evidence is NEWER than the marker. Old code read ONLY the marker
    // (parseInt(markerText) || null), so it would return markerEpoch here —
    // this assertion fails against that code because the two values differ.
    const spacesMs = 1_785_446_434_842;
    const markerEpoch = 1_700_000_000; // much older, in seconds
    svcMock.selfLastSyncMs = spacesMs;
    fs.writeFileSync(markerPath, String(markerEpoch));

    const status = await getSyncStatus();
    expect(status.lastSyncEpoch).toBe(Math.floor(spacesMs / 1000));
  });

  it('falls back to the legacy marker when sync-spaces has no evidence for this device', async () => {
    // Guards the fallback path itself: if a future edit hard-codes
    // deriveSelfLastSyncEpochSec's second argument to null instead of passing
    // markerText through, this returns null instead of markerEpoch and fails.
    const markerEpoch = 1_700_000_000;
    svcMock.selfLastSyncMs = null;
    fs.writeFileSync(markerPath, String(markerEpoch));

    const status = await getSyncStatus();
    expect(status.lastSyncEpoch).toBe(markerEpoch);
  });

  it('syncInProgress reflects live sync-spaces activity even with no legacy lock directory', async () => {
    // No .sync-lock on disk. Old code (`syncInProgress: lockExists`) would
    // return false here — this fails against that code.
    svcMock.syncing = true;
    expect(fs.existsSync(lockDir)).toBe(false);

    const status = await getSyncStatus();
    expect(status.syncInProgress).toBe(true);
  });

  it('syncInProgress ORs the legacy lock directory in, rather than being overwritten by it', async () => {
    // sync-spaces reports NOT syncing but the legacy lock dir exists (an
    // extra-backups push in flight). A common wrong fix is
    // `syncInProgress: isSyncSpacesSyncing()` — assigning instead of ORing —
    // which drops the legacy signal and would return false here.
    svcMock.syncing = false;
    fs.mkdirSync(lockDir, { recursive: true });

    const status = await getSyncStatus();
    expect(status.syncInProgress).toBe(true);
  });

  it('is falsy and does not throw when sync is off / sync-spaces is uninitialized', async () => {
    // No marker file, no lock dir, service reports no evidence — the
    // "sync never configured" state. Confirms the wiring doesn't coerce
    // null/undefined into NaN or a truthy value, and doesn't throw.
    svcMock.selfLastSyncMs = null;
    svcMock.syncing = false;
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.existsSync(lockDir)).toBe(false);

    const status = await getSyncStatus();
    expect(status.lastSyncEpoch).toBeNull();
    expect(status.syncInProgress).toBe(false);
  });
});
