import { describe, it, expect } from 'vitest';
import { deriveSyncState, deriveWarningSeverity } from './sync-display-state';
import type { SyncWarning } from '../../main/sync-state';

const NOW_EPOCH = Math.floor(Date.now() / 1000);

const warn = (overrides: Partial<SyncWarning> = {}): SyncWarning => ({
  code: 'TEST',
  level: 'warn',
  title: 't',
  body: 'b',
  dismissible: true,
  createdEpoch: NOW_EPOCH,
  ...overrides,
});

describe('deriveSyncState', () => {
  it('returns unconfigured when there are no backends', () => {
    const result = deriveSyncState({
      hasBackends: false,
      syncInProgress: false,
      lastSyncEpoch: null,
      warnings: [],
    });
    expect(result).toEqual({ kind: 'unconfigured' });
  });

  it('returns syncing whenever syncInProgress is true, even with active warnings', () => {
    const result = deriveSyncState({
      hasBackends: true,
      syncInProgress: true,
      lastSyncEpoch: NOW_EPOCH - 30,
      warnings: [warn({ level: 'danger' })],
    });
    expect(result).toEqual({ kind: 'syncing' });
  });

  it('returns failing when any danger warning is present', () => {
    const warnings = [warn({ level: 'warn' }), warn({ code: 'AUTH_EXPIRED', level: 'danger' })];
    const result = deriveSyncState({
      hasBackends: true,
      syncInProgress: false,
      lastSyncEpoch: NOW_EPOCH - 30,
      warnings,
    });
    expect(result).toEqual({ kind: 'failing', warningCount: 2 });
  });

  it('returns attention when only warn-level warnings are present', () => {
    const warnings = [warn({ code: 'PROJECTS_UNSYNCED' }), warn({ code: 'SKILLS_UNROUTED' })];
    const result = deriveSyncState({
      hasBackends: true,
      syncInProgress: false,
      lastSyncEpoch: NOW_EPOCH - 30,
      warnings,
    });
    expect(result).toEqual({
      kind: 'attention',
      warningCount: 2,
      lastSyncEpoch: NOW_EPOCH - 30,
    });
  });

  it('returns synced when no warnings and last sync was within 24h', () => {
    const result = deriveSyncState({
      hasBackends: true,
      syncInProgress: false,
      lastSyncEpoch: NOW_EPOCH - 3600,
      warnings: [],
    });
    expect(result).toEqual({ kind: 'synced', lastSyncEpoch: NOW_EPOCH - 3600 });
  });

  it('returns stale when no warnings and last sync was over 24h ago', () => {
    const oldEpoch = NOW_EPOCH - 90000;
    const result = deriveSyncState({
      hasBackends: true,
      syncInProgress: false,
      lastSyncEpoch: oldEpoch,
      warnings: [],
    });
    expect(result).toEqual({ kind: 'stale', lastSyncEpoch: oldEpoch });
  });

  it('returns stale when there is no last sync recorded', () => {
    const result = deriveSyncState({
      hasBackends: true,
      syncInProgress: false,
      lastSyncEpoch: null,
      warnings: [],
    });
    expect(result).toEqual({ kind: 'stale', lastSyncEpoch: null });
  });

  describe('scoped to backendId', () => {
    it('only considers warnings whose backendId matches the scope', () => {
      const warnings = [
        warn({ level: 'danger', backendId: 'drive-1' }),
        warn({ level: 'warn', backendId: 'github-1' }),
      ];
      const driveResult = deriveSyncState({
        hasBackends: true,
        syncInProgress: false,
        lastSyncEpoch: NOW_EPOCH - 30,
        warnings,
        scope: { backendId: 'drive-1' },
      });
      expect(driveResult.kind).toBe('failing');

      const githubResult = deriveSyncState({
        hasBackends: true,
        syncInProgress: false,
        lastSyncEpoch: NOW_EPOCH - 30,
        warnings,
        scope: { backendId: 'github-1' },
      });
      expect(githubResult.kind).toBe('attention');
    });

    it('ignores warnings without a backendId when scoped', () => {
      const warnings = [warn({ level: 'danger', backendId: undefined })];
      const result = deriveSyncState({
        hasBackends: true,
        syncInProgress: false,
        lastSyncEpoch: NOW_EPOCH - 30,
        warnings,
        scope: { backendId: 'drive-1' },
      });
      expect(result.kind).toBe('synced');
    });
  });
});

describe('deriveWarningSeverity', () => {
  it('returns null when warnings is empty', () => {
    expect(deriveWarningSeverity([])).toBeNull();
  });

  it('returns failing when any danger-level warning exists', () => {
    expect(deriveWarningSeverity([
      warn({ level: 'warn' }),
      warn({ level: 'danger' }),
    ])).toBe('failing');
  });

  it('returns attention when only warn-level warnings exist', () => {
    expect(deriveWarningSeverity([
      warn({ level: 'warn' }),
      warn({ level: 'warn' }),
    ])).toBe('attention');
  });

  it('returns null when scoped to a backendId with no matching warnings', () => {
    expect(deriveWarningSeverity(
      [warn({ level: 'danger', backendId: 'drive-1' })],
      { backendId: 'github-1' },
    )).toBeNull();
  });

  it('returns failing when scoped to a backendId with a matching danger warning', () => {
    expect(deriveWarningSeverity(
      [
        warn({ level: 'danger', backendId: 'drive-1' }),
        warn({ level: 'warn', backendId: 'github-1' }),
      ],
      { backendId: 'drive-1' },
    )).toBe('failing');
  });
});
