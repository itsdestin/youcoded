import type { SyncWarning } from '../../main/sync-state';

export type SyncDisplayState =
  | { kind: 'unconfigured' }
  | { kind: 'syncing' }
  | { kind: 'failing'; warningCount: number }
  | { kind: 'attention'; warningCount: number; lastSyncEpoch: number | null }
  | { kind: 'synced'; lastSyncEpoch: number }
  | { kind: 'stale'; lastSyncEpoch: number | null };

export interface DeriveSyncStateInput {
  hasBackends: boolean;
  syncInProgress: boolean;
  lastSyncEpoch: number | null;
  warnings: SyncWarning[];
  /** When provided, only warnings whose `backendId` matches are considered. */
  scope?: { backendId: string };
}

const TWENTY_FOUR_HOURS_SECONDS = 86400;

/** True when a sync warning should look like an alarm: red, and a red dot on Settings. WHY "never set up" is not one
 *  (Destin, 2026-11-07, picked "Grey, no dot"): someone who simply hasn't turned sync on is not broken, so a new user
 *  was greeted with red on day one. That warning stays (it explains how to set up sync) but is drawn calm and grey. */
export function isSyncAlarm(w: { level?: string; code?: string } | null | undefined): boolean {
  return w?.level === 'danger' && w.code !== 'PERSONAL_NOT_CONFIGURED';
}

export function deriveSyncState(input: DeriveSyncStateInput): SyncDisplayState {
  const { hasBackends, syncInProgress, lastSyncEpoch, warnings, scope } = input;

  if (!hasBackends) return { kind: 'unconfigured' };
  if (syncInProgress) return { kind: 'syncing' };

  // Filter warnings to the requested scope (panel-wide vs per-backend).
  const relevantWarnings = scope
    ? warnings.filter(w => w.backendId === scope.backendId)
    : warnings;

  const dangerCount = relevantWarnings.filter(w => w.level === 'danger').length;
  if (dangerCount > 0) {
    return { kind: 'failing', warningCount: relevantWarnings.length };
  }

  if (relevantWarnings.length > 0) {
    return { kind: 'attention', warningCount: relevantWarnings.length, lastSyncEpoch };
  }

  if (lastSyncEpoch !== null) {
    const ageSeconds = Math.floor(Date.now() / 1000) - lastSyncEpoch;
    if (ageSeconds < TWENTY_FOUR_HOURS_SECONDS) {
      return { kind: 'synced', lastSyncEpoch };
    }
  }

  return { kind: 'stale', lastSyncEpoch };
}

/**
 * Sync-spaces input for the Settings row derivation below. `box` is the
 * pinned deriveSyncBoxState ladder output (sync-dot-state.ts) computed by the
 * caller; `lastSyncAt` is the most recent per-space persisted marker (MS
 * epoch — note the legacy fields are SECONDS).
 */
export interface SpacesRowInput {
  enabled: boolean;
  box: 'setup' | 'off' | 'waiting-github' | 'error' | 'hydrating' | 'syncing' | 'synced';
  lastSyncAt: number | null;
}

/**
 * Compact Settings-row state MERGING both sync systems (2026-07-22 fix).
 *
 * WHY: the row was keyed on the legacy rclone status alone — `hasBackends`
 * counts only Drive/iCloud backends — so a device running ONLY sync-spaces
 * (the primary GitHub sync, on and green in the popup) read "Not configured"
 * with a gray dot. Sync-spaces now leads when enabled; the legacy derivation
 * is the fallback for legacy-only setups.
 *
 * Precedence (the "row must never read Synced while warnings are active"
 * invariant extends across BOTH systems):
 *   1. legacy danger warnings        → failing
 *   2. sync-spaces error             → failing (the +1 in the badge count)
 *   3. legacy warn-level warnings    → attention
 *   4. sync-spaces setup/hydrating/syncing → syncing
 *   5. sync-spaces synced            → synced/stale from ITS recency marker
 *   6. sync-spaces disabled          → the unchanged legacy derivation
 */
export function deriveSettingsRowState(
  legacy: DeriveSyncStateInput,
  spaces: SpacesRowInput | null,
): SyncDisplayState {
  if (!spaces?.enabled) return deriveSyncState(legacy);

  const severity = deriveWarningSeverity(legacy.warnings);
  if (severity === 'failing') return { kind: 'failing', warningCount: legacy.warnings.length };
  // waiting-github can only occur while DISABLED (ladder contract), but if it
  // ever leaks through treat it like error — it is "sync cannot run".
  if (spaces.box === 'error' || spaces.box === 'waiting-github') {
    return { kind: 'failing', warningCount: legacy.warnings.length + 1 };
  }
  if (severity === 'attention') {
    return {
      kind: 'attention',
      warningCount: legacy.warnings.length,
      lastSyncEpoch: spaces.lastSyncAt != null ? Math.floor(spaces.lastSyncAt / 1000) : legacy.lastSyncEpoch,
    };
  }
  if (spaces.box === 'setup' || spaces.box === 'hydrating' || spaces.box === 'syncing') {
    return { kind: 'syncing' };
  }
  // box === 'synced' (or 'off', unreachable while enabled): green is
  // evidence-gated upstream, so a recency marker exists — reuse the legacy
  // synced/stale staleness logic on sync-spaces' own marker.
  return deriveSyncState({
    hasBackends: true,
    syncInProgress: false,
    lastSyncEpoch: spaces.lastSyncAt != null ? Math.floor(spaces.lastSyncAt / 1000) : legacy.lastSyncEpoch,
    warnings: [],
  });
}

/**
 * Severity classification for surfaces that only see warnings (not full sync state).
 * Used by the StatusBar pill, where backend list and last-sync timestamp aren't available.
 *
 * Returns:
 *  - 'failing'   if any warning is danger-level
 *  - 'attention' if there are only warn-level warnings
 *  - null        if there are no warnings
 *
 * Optional `scope` filters by backendId, mirroring `deriveSyncState`.
 */
export function deriveWarningSeverity(
  warnings: SyncWarning[],
  scope?: { backendId: string },
): 'failing' | 'attention' | null {
  const relevant = scope
    ? warnings.filter(w => w.backendId === scope.backendId)
    : warnings;
  if (relevant.length === 0) return null;
  if (relevant.some(w => w.level === 'danger')) return 'failing';
  return 'attention';
}
