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
