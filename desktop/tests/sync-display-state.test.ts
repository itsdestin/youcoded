import { describe, it, expect } from 'vitest';
import {
  deriveSettingsRowState, deriveSyncState, deriveWarningSeverity, isSyncAlarm,
  type DeriveSyncStateInput, type SpacesRowInput,
} from '../src/renderer/state/sync-display-state';
import type { SyncWarning } from '../src/main/sync-state';

const NOW_EPOCH = Math.floor(Date.now() / 1000);

const warn = (overrides: Partial<SyncWarning> = {}): SyncWarning => ({
  code: 'TEST', level: 'warn', title: 't', body: 'b', dismissible: true, createdEpoch: NOW_EPOCH, ...overrides,
});

// A configured, idle backend that synced 30s ago; each test overrides only what it is about.
const derive = (over: Partial<DeriveSyncStateInput> = {}) =>
  deriveSyncState({ hasBackends: true, syncInProgress: false, lastSyncEpoch: NOW_EPOCH - 30, warnings: [], ...over });

describe('deriveSyncState', () => {
  it('returns unconfigured when there are no backends', () => {
    expect(derive({ hasBackends: false, lastSyncEpoch: null })).toEqual({ kind: 'unconfigured' });
  });

  it('returns syncing whenever syncInProgress is true, even with active warnings', () => {
    expect(derive({ syncInProgress: true, warnings: [warn({ level: 'danger' })] })).toEqual({ kind: 'syncing' });
  });

  it('returns failing when any danger warning is present', () => {
    const warnings = [warn({ level: 'warn' }), warn({ code: 'AUTH_EXPIRED', level: 'danger' })];
    expect(derive({ warnings })).toEqual({ kind: 'failing', warningCount: 2 });
  });

  it('returns attention when only warn-level warnings are present', () => {
    const warnings = [warn({ code: 'PERSONAL_STALE' }), warn({ code: 'OFFLINE' })];
    expect(derive({ warnings })).toEqual({ kind: 'attention', warningCount: 2, lastSyncEpoch: NOW_EPOCH - 30 });
  });

  it.each([
    ['within 24h', NOW_EPOCH - 3600, 'synced'],
    ['over 24h ago', NOW_EPOCH - 90000, 'stale'],
    ['never recorded', null, 'stale'],
  ] as const)('with no warnings and last sync %s → %s', (_when, lastSyncEpoch, kind) => {
    expect(derive({ lastSyncEpoch })).toEqual({ kind, lastSyncEpoch });
  });

  describe('scoped to backendId', () => {
    it('only considers warnings whose backendId matches the scope', () => {
      const warnings = [warn({ level: 'danger', backendId: 'drive-1' }), warn({ level: 'warn', backendId: 'github-1' })];
      expect(derive({ warnings, scope: { backendId: 'drive-1' } }).kind).toBe('failing');
      expect(derive({ warnings, scope: { backendId: 'github-1' } }).kind).toBe('attention');
    });

    it('ignores warnings without a backendId when scoped', () => {
      const warnings = [warn({ level: 'danger', backendId: undefined })];
      expect(derive({ warnings, scope: { backendId: 'drive-1' } }).kind).toBe('synced');
    });
  });
});

describe('deriveWarningSeverity', () => {
  it('returns null when warnings is empty', () => {
    expect(deriveWarningSeverity([])).toBeNull();
  });

  it('returns failing when any danger-level warning exists', () => {
    expect(deriveWarningSeverity([warn({ level: 'warn' }), warn({ level: 'danger' })])).toBe('failing');
  });

  it('returns attention when only warn-level warnings exist', () => {
    expect(deriveWarningSeverity([warn({ level: 'warn' }), warn({ level: 'warn' })])).toBe('attention');
  });

  it('is scoped to a backendId: no match → null, matching danger → failing', () => {
    const warnings = [warn({ level: 'danger', backendId: 'drive-1' }), warn({ level: 'warn', backendId: 'github-1' })];
    expect(deriveWarningSeverity([warnings[0]], { backendId: 'github-1' })).toBeNull();
    expect(deriveWarningSeverity(warnings, { backendId: 'drive-1' })).toBe('failing');
  });
});

// The settings row spans BOTH sync systems: it once keyed on the legacy rclone status alone, so a device
// running only the primary GitHub sync (green in the popup) read "Not configured".
const NO_LEGACY: DeriveSyncStateInput = { hasBackends: false, syncInProgress: false, lastSyncEpoch: null, warnings: [] };
const legacyWarn = (level: 'warn' | 'danger') => ({ id: 'w', backendId: 'b', level, code: 'X', message: 'm' } as any);
const spaces = (box: SpacesRowInput['box'], lastSyncAt: number | null = Date.now() - 60_000): SpacesRowInput =>
  ({ enabled: true, box, lastSyncAt });

describe('deriveSettingsRowState', () => {
  it('sync-spaces enabled + green, zero legacy backends → synced, never "unconfigured"', () => {
    expect(deriveSettingsRowState(NO_LEGACY, spaces('synced')).kind).toBe('synced');
  });

  it('sync-spaces disabled (or absent) → unchanged legacy derivation', () => {
    expect(deriveSettingsRowState(NO_LEGACY, null)).toEqual({ kind: 'unconfigured' });
    expect(deriveSettingsRowState(NO_LEGACY, { enabled: false, box: 'off', lastSyncAt: null })).toEqual({ kind: 'unconfigured' });
  });

  it('sync-spaces error → failing (red row), even with no legacy warnings', () => {
    expect(deriveSettingsRowState(NO_LEGACY, spaces('error'))).toEqual({ kind: 'failing', warningCount: 1 });
  });

  it.each(['setup', 'hydrating', 'syncing'] as const)('%s box reads as the syncing row state', (box) => {
    expect(deriveSettingsRowState(NO_LEGACY, spaces(box)).kind).toBe('syncing');
  });

  it('legacy DANGER warnings outrank a green sync-spaces state (never green over active warnings)', () => {
    const legacy = { ...NO_LEGACY, hasBackends: true, warnings: [legacyWarn('danger')] };
    expect(deriveSettingsRowState(legacy, spaces('synced'))).toEqual({ kind: 'failing', warningCount: 1 });
  });

  it('legacy warn-level warnings surface as attention over a green sync-spaces state', () => {
    const legacy = { ...NO_LEGACY, hasBackends: true, warnings: [legacyWarn('warn')] };
    expect(deriveSettingsRowState(legacy, spaces('synced')).kind).toBe('attention');
  });

  it('recency comes from sync-spaces (ms → s) and goes stale past 24h', () => {
    expect(deriveSettingsRowState(NO_LEGACY, spaces('synced', Date.now() - 5 * 60_000)).kind).toBe('synced');
    expect(deriveSettingsRowState(NO_LEGACY, spaces('synced', Date.now() - 48 * 3600_000)).kind).toBe('stale');
  });
});

// Destin, 2026-11-07 ("Grey, no dot"): never having set up sync is not an alarm, so it gets no red and no Settings dot;
// a real failure still does. (Ported from master's copy of the old src/renderer/state/sync-display-state.test.ts.)
describe('isSyncAlarm', () => {
  it('treats "no sync configured" as calm and a real danger warning as an alarm', () => {
    expect(isSyncAlarm({ level: 'danger', code: 'PERSONAL_NOT_CONFIGURED' })).toBe(false);
    expect(isSyncAlarm({ level: 'danger', code: 'AUTH_FAILED' })).toBe(true);
    expect(isSyncAlarm({ level: 'warn', code: 'PERSONAL_STALE' })).toBe(false);
  });
});
