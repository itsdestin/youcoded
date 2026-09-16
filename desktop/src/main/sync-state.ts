/**
 * sync-state.ts — Shared sync state reader for the Sync Management UI.
 *
 * Reads state files written by the native SyncService and toolkit hooks,
 * and exposes them as typed objects. Also provides config writes and
 * force-sync triggering (delegates to SyncService).
 *
 * V2 (2026-04): Supports multiple named backend instances with per-instance
 * sync/storage mode. The old flat-key config (PERSONAL_SYNC_BACKEND, etc.)
 * is auto-migrated to a storage_backends array on first read, and legacy
 * keys are kept in sync on every write so bash hooks still work.
 *
 * Used by: ipc-handlers.ts, remote-server.ts
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { SyncService } from './sync-service';
// Per-device sync recency lives in the sync-spaces service (it owns the SyncHub
// socket that receives it). Surfaced here so getSyncStatus() — the SyncPanel's
// full-snapshot source — carries it alongside the other sync fields. No cycle:
// sync-spaces/service.ts does not import sync-state.ts.
// getSelfLastSyncEpochMs/isSyncSpacesSyncing are the same "this device" evidence
// buildStatusData() in ipc-handlers.ts reads (Task 7) — getSyncStatus() is the
// SyncPanel's OTHER read path (on-mount snapshot vs. the 10s status:data push),
// and was still reading the legacy marker alone, so the self row showed the
// stale value until the first push overwrote it (2026-07-30 spec §4 gap).
import { getLastSyncByDevice, getSelfLastSyncEpochMs, isSyncSpacesSyncing } from './sync-spaces/service';
// Same pure derivation buildStatusData() uses — reused, not duplicated, so the
// two read paths can't drift on the ms→wire-seconds conversion or the
// sync-spaces-vs-legacy-marker precedence rule.
import { deriveSelfLastSyncEpochSec } from './sync-spaces/self-sync-status';

// --- SyncService delegation ---
// When the SyncService is running, forceSync() delegates to it instead
// of shelling out to sync.sh. This is set by main.ts on startup.
let syncServiceInstance: SyncService | null = null;

export function setSyncService(service: SyncService | null): void {
  // Stop the old service if replacing
  if (syncServiceInstance && service !== syncServiceInstance) {
    syncServiceInstance.stop();
  }
  syncServiceInstance = service;
}

// --- V2 Types: Multi-instance backend model ---

/** The three cloud service types the sync system supports. */
export type BackendType = 'drive' | 'github' | 'icloud';

/** A user-facing sync warning. Written to .sync-warnings.json. */
export interface SyncWarning {
  code: string;
  level: 'danger' | 'warn';
  backendId?: string;
  title: string;
  body: string;
  fixAction?: SyncFixAction;
  dismissible: boolean;
  stderr?: string;
  createdEpoch: number;
}

export type SyncFixAction =
  | { label: string; kind: 'open-sync-setup'; payload?: { backendId?: string } }
  | { label: string; kind: 'open-external'; payload: { url: string } }
  | { label: string; kind: 'retry'; payload: { backendId: string } }
  | { label: string; kind: 'dismiss' };

/**
 * A single connected cloud backend instance.
 * Users can have multiple instances of the same type (e.g., two Drive accounts).
 * "syncEnabled" controls whether this instance participates in the automatic
 * 15-minute backup loop. When false, the backend is "storage only" —
 * files can be manually uploaded/downloaded but no auto-sync runs.
 */
export interface BackendInstance {
  id: string;                          // Stable slug, e.g. "drive-personal"
  type: BackendType;
  label: string;                       // User-visible name, e.g. "Personal Drive"
  syncEnabled: boolean;                // true = auto-sync; false = storage only
  config: Record<string, string>;      // Type-specific connection details
}

/**
 * Runtime status of a single backend instance (returned by getSyncStatus).
 * Extends BackendInstance with health information read from per-backend markers.
 */
export interface BackendInstanceStatus extends BackendInstance {
  connected: boolean;                  // Whether the backend was reachable on last attempt
  lastPushEpoch: number | null;        // Per-backend last push timestamp
  lastError: string | null;            // Last error message, null if healthy
}

/** Full sync status returned to the UI. */
export interface SyncStatus {
  backends: BackendInstanceStatus[];
  lastSyncEpoch: number | null;        // Global last-sync (any backend)
  backupMeta: {
    last_backup: string;
    platform: string;
    toolkit_version: string;
  } | null;
  warnings: SyncWarning[];
  syncInProgress: boolean;
  syncingBackendId: string | null;     // Which backend is currently syncing
  syncedCategories: string[];
  // Per-device sync recency (machineId → epoch-ms of that device's most recent
  // successful sync), carried over the SyncHub. Keyed by the same machineId the
  // "Your devices" rows use, so the UI reads `lastSyncByDevice[d.id]`. Empty when
  // the hub is down / never connected — rows then fall back to their launch value.
  lastSyncByDevice: Record<string, number>;
}

/** Config shape for the multi-instance model. */
export interface SyncConfig {
  backends: BackendInstance[];
  // Legacy fields kept for backward compat with bash hooks and old UI
  PERSONAL_SYNC_BACKEND: string;
  DRIVE_ROOT: string;
  PERSONAL_SYNC_REPO: string;
  ICLOUD_PATH: string;
  SYNC_WIFI_ONLY?: string;             // Android only — "true"/"false"
}

// --- Legacy types (kept for old UI compatibility during transition) ---
// The old SyncBackendInfo/SyncStatus/SyncConfig types are no longer exported
// directly — the new types are a superset that the UI can consume.

// --- Paths ---

// `let`, not `const`, so setClaudeDirForTests() can re-point them. These are
// still resolved once at module load in production — behavior is unchanged.
let claudeDir: string;
let configPath: string;
let syncMarkerPath: string;
let backupMetaPath: string;
// WHY: the plain `.sync-warnings` path was v1 of the warning store; the JSON
// sibling (`.sync-warnings.json`) replaced it in 2a11feb9. The old path was
// assigned but never read — removed in the 2026-08-06 sweep.
let syncWarningsJsonPath: string;
let syncLockDir: string;
let backupLogPath: string;

function resolvePaths(home: string): void {
  claudeDir = path.join(home, '.claude');
  configPath = path.join(claudeDir, 'toolkit-state', 'config.json');
  syncMarkerPath = path.join(claudeDir, 'toolkit-state', '.sync-marker');
  backupMetaPath = path.join(claudeDir, 'backup-meta.json');
  syncWarningsJsonPath = path.join(claudeDir, '.sync-warnings.json');
  syncLockDir = path.join(claudeDir, 'toolkit-state', '.sync-lock');
  backupLogPath = path.join(claudeDir, 'backup.log');
}
resolvePaths(os.homedir());

/**
 * TEST-ONLY seam. Re-points this module's paths at a throwaway home.
 *
 * Without it these paths are frozen from os.homedir() at module load, so
 * sync-warnings-lifecycle.test.ts read and wrote the developer's REAL
 * ~/.claude/.sync-warnings.json — writeWarnings([]) deletes that file. That is
 * both a live-app hazard (a running YouCoded owns it) and the actual source of
 * the intermittent failure: SyncService.runHealthCheck() writes an OFFLINE
 * warning to the same path at app launch, and the suite asserts no OFFLINE
 * warning survives. Setting process.env.HOME does NOT work here — the static
 * import is hoisted above any assignment, and os.homedir() reads USERPROFILE
 * rather than HOME on Windows.
 */
export function setClaudeDirForTests(home: string): void {
  resolvePaths(home);
  // Module state, so it survives between test files in the same worker —
  // clear it with the paths or a dismissal leaks into the next suite.
  dismissedThisRun.clear();
}

/** Per-backend sync marker path, used for tracking individual push times. */
function perBackendMarkerPath(backendId: string): string {
  return path.join(claudeDir, 'toolkit-state', `.sync-marker-${backendId}`);
}

// --- Helpers ---

async function readText(filePath: string): Promise<string> {
  try {
    return (await fs.promises.readFile(filePath, 'utf8')).trim();
  } catch {
    return '';
  }
}

async function readJson(filePath: string): Promise<any> {
  const text = await readText(filePath);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// WHY a per-call counter on top of the pid: `.tmp.<pid>` alone is the SAME name
// for every write in this process, so two overlapping atomicWrites to one target
// (the 60s health check's writeWarnings racing a push-failure warning write, or
// an in-flight check leaking across tests) both write the same tmp path — the
// first rename moves it away and the second rename throws ENOENT. This was the
// cross-OS CI flake in sync-warning-self-clear.test.ts. pid keeps the dev
// instance and the built app apart; the counter keeps calls apart.
let atomicWriteSeq = 0;

/** Atomic write via temp file + rename (same directory to ensure same filesystem). */
async function atomicWrite(target: string, content: string): Promise<void> {
  const tmpPath = `${target}.tmp.${process.pid}.${atomicWriteSeq++}`;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(tmpPath, content, 'utf8');
  await fs.promises.rename(tmpPath, target);
}

// --- Config Migration: V1 (flat keys) → V2 (storage_backends array) ---

/**
 * Generate a URL-safe slug from a backend type and user-assigned label.
 * Used as the stable ID for a backend instance.
 */
function generateBackendId(type: string, label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')   // Replace non-alphanumeric with dashes
    .replace(/^-+|-+$/g, '');       // Trim leading/trailing dashes
  return `${type}-${slug || 'default'}`;
}

/**
 * Migrate legacy flat-key config to the new storage_backends array.
 * Called automatically when config.json lacks a storage_backends key.
 * Each previously-active backend becomes a sync-enabled instance;
 * inactive ones are omitted (they weren't configured before).
 */
export function migrateConfigToV2(config: any): BackendInstance[] {
  const backends: BackendInstance[] = [];
  const backendStr: string = config?.PERSONAL_SYNC_BACKEND || 'none';
  const activeBackends = backendStr
    .split(',')
    .map((b: string) => b.trim().toLowerCase())
    .filter((b: string) => b && b !== 'none');

  // Drive — was active in old config = auto-sync on
  if (activeBackends.includes('drive')) {
    backends.push({
      id: 'drive-default',
      type: 'drive',
      label: 'Google Drive',
      syncEnabled: true,
      config: {
        DRIVE_ROOT: config?.DRIVE_ROOT || 'Claude',
        rcloneRemote: 'gdrive',  // Default rclone remote name
      },
    });
  }

  // GitHub
  if (activeBackends.includes('github')) {
    backends.push({
      id: 'github-default',
      type: 'github',
      label: 'GitHub',
      syncEnabled: true,
      config: {
        PERSONAL_SYNC_REPO: config?.PERSONAL_SYNC_REPO || '',
      },
    });
  }

  // iCloud
  if (activeBackends.includes('icloud')) {
    backends.push({
      id: 'icloud-default',
      type: 'icloud',
      label: 'iCloud',
      syncEnabled: true,
      config: {
        ICLOUD_PATH: config?.ICLOUD_PATH || '',
      },
    });
  }

  return backends;
}

/**
 * Regenerate legacy flat keys from the storage_backends array.
 * Called on every config write so bash hooks (sync.sh, session-start.sh)
 * that still read the flat keys continue to work. Uses the first instance
 * of each type for the flat key values.
 */
export function syncLegacyKeys(config: any): void {
  const backends: BackendInstance[] = config.storage_backends || [];

  // PERSONAL_SYNC_BACKEND = comma-separated list of sync-enabled types
  const syncEnabledTypes = [...new Set(
    backends.filter(b => b.syncEnabled).map(b => b.type)
  )];
  config.PERSONAL_SYNC_BACKEND = syncEnabledTypes.length > 0
    ? syncEnabledTypes.join(',')
    : 'none';

  // Use the first instance of each type for the flat config keys
  const firstDrive = backends.find(b => b.type === 'drive');
  const firstGithub = backends.find(b => b.type === 'github');
  const firstIcloud = backends.find(b => b.type === 'icloud');

  config.DRIVE_ROOT = firstDrive?.config.DRIVE_ROOT || 'Claude';
  config.PERSONAL_SYNC_REPO = firstGithub?.config.PERSONAL_SYNC_REPO || '';
  config.ICLOUD_PATH = firstIcloud?.config.ICLOUD_PATH || '';
}

/**
 * Read backend instances from config, auto-migrating if needed.
 * This is the single source of truth for what backends exist.
 */
async function readBackendInstances(): Promise<BackendInstance[]> {
  const config = (await readJson(configPath)) || {};

  if (config.storage_backends && Array.isArray(config.storage_backends)) {
    return config.storage_backends;
  }

  // Auto-migrate from flat keys on first read
  const migrated = migrateConfigToV2(config);
  config.storage_backends = migrated;
  syncLegacyKeys(config);
  await atomicWrite(configPath, JSON.stringify(config, null, 2));
  return migrated;
}

// --- Warning store ---

/** Read .sync-warnings.json. Returns [] if missing or unparseable. */
export async function readWarnings(): Promise<SyncWarning[]> {
  const text = await readText(syncWarningsJsonPath);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Write warnings array atomically. Empty array → unlink the file. */
export async function writeWarnings(warnings: SyncWarning[]): Promise<void> {
  if (warnings.length === 0) {
    try { await fs.promises.unlink(syncWarningsJsonPath); } catch {}
    return;
  }
  await atomicWrite(syncWarningsJsonPath, JSON.stringify(warnings, null, 2));
}

/**
 * Add or replace a warning. De-dupes by (code, backendId) — only one warning
 * per (code, backendId) pair exists at a time, so repeated push failures
 * don't stack up.
 */
export async function addOrReplaceWarning(w: SyncWarning): Promise<void> {
  const all = await readWarnings();
  const filtered = all.filter(
    (x) => !(x.code === w.code && x.backendId === w.backendId),
  );
  filtered.push(w);
  await writeWarnings(filtered);
}

/** Remove all warnings with a given backendId (e.g., on successful push). */
export async function clearWarningsByBackend(backendId: string): Promise<void> {
  const all = await readWarnings();
  const filtered = all.filter((x) => x.backendId !== backendId);
  if (filtered.length !== all.length) await writeWarnings(filtered);
}

/**
 * Remove a warning by code (used by runHealthCheck to clear resolved codes).
 * Only call for global (non-backendId-scoped) codes like OFFLINE/PERSONAL_STALE.
 * For backend-specific push failures, use clearWarningsByBackend instead — this
 * function would wipe UNKNOWN/CONFIG_MISSING across every backend simultaneously.
 */
export async function clearWarningsByCode(code: string): Promise<void> {
  const all = await readWarnings();
  const filtered = all.filter((x) => x.code !== code);
  if (filtered.length !== all.length) await writeWarnings(filtered);
}

// --- Public API ---

/**
 * Read all sync state files and return a unified status object.
 * This is the primary data source for the Sync Management UI.
 */
export async function getSyncStatus(): Promise<SyncStatus> {
  const [backends, markerText, meta, warnings, lockExists] =
    await Promise.all([
      readBackendInstances(),
      readText(syncMarkerPath),
      readJson(backupMetaPath),
      readWarnings(),
      dirExists(syncLockDir),
    ]);

  const backendStatuses: BackendInstanceStatus[] = await Promise.all(
    backends.map(async (b) => {
      const bMarkerText = await readText(perBackendMarkerPath(b.id));
      const lastPushEpoch = bMarkerText ? parseInt(bMarkerText, 10) || null : null;

      // lastError is now derived from warnings scoped to this backend id.
      // Takes the first danger-level warning's title for backwards compat
      // with UI paths that still read lastError.
      const pushFailure = warnings.find((w) => w.backendId === b.id && w.level === 'danger');
      const lastError = pushFailure ? pushFailure.title : null;
      const connected = !lastError;

      return { ...b, connected, lastPushEpoch, lastError };
    }),
  );

  // Self recency: sync-spaces evidence first, legacy .sync-marker as
  // fallback/max — same precedence buildStatusData() uses (Task 7). WHY this
  // isn't `markerText ? parseInt(...) : null` alone: that only ever reflects
  // the LEGACY Drive/iCloud push path, which GitHub-era installs never stamp.
  const lastSyncEpoch = deriveSelfLastSyncEpochSec(getSelfLastSyncEpochMs(), markerText || null);

  const backupMeta = meta
    ? {
        last_backup: meta.last_backup || meta.timestamp || '',
        platform: meta.platform || '',
        toolkit_version: meta.toolkit_version || '',
      }
    : null;

  // Detect synced data categories by checking directory/file existence
  const categoryChecks = await Promise.all([
    dirExists(path.join(claudeDir, 'projects')).then((exists) =>
      exists ? 'memory' : null,
    ),
    dirExists(path.join(claudeDir, 'projects')).then((exists) =>
      exists ? 'conversations' : null,
    ),
    dirExists(path.join(claudeDir, 'encyclopedia')).then((exists) =>
      exists ? 'encyclopedia' : null,
    ),
    dirExists(path.join(claudeDir, 'skills')).then((exists) =>
      exists ? 'skills' : null,
    ),
    fileExists(path.join(claudeDir, 'settings.json')).then((exists) =>
      exists ? 'system-config' : null,
    ),
    dirExists(path.join(claudeDir, 'plans')).then((exists) =>
      exists ? 'plans' : null,
    ),
    dirExists(path.join(claudeDir, 'specs')).then((exists) =>
      exists ? 'specs' : null,
    ),
  ]);

  return {
    backends: backendStatuses,
    lastSyncEpoch,
    backupMeta,
    warnings,
    // OR, not assign: live sync-spaces activity and the legacy .sync-lock
    // directory (extra-backups pushes) are independent signals — either one
    // syncing means "in progress". Assigning would drop whichever ran second.
    syncInProgress: isSyncSpacesSyncing() || lockExists,
    syncingBackendId: null, // Set by SyncService at runtime via event
    syncedCategories: categoryChecks.filter(Boolean) as string[],
    // Snapshot the SyncHub-carried per-device recency map (see interface note).
    lastSyncByDevice: getLastSyncByDevice(),
  };
}

/**
 * Read backend configuration from config.json.
 * Returns the new multi-instance format with legacy keys for compat.
 */
export async function getSyncConfig(): Promise<SyncConfig> {
  const config = (await readJson(configPath)) || {};
  const backends = config.storage_backends && Array.isArray(config.storage_backends)
    ? config.storage_backends
    : migrateConfigToV2(config);

  return {
    backends,
    PERSONAL_SYNC_BACKEND: config.PERSONAL_SYNC_BACKEND || 'none',
    DRIVE_ROOT: config.DRIVE_ROOT || 'Claude',
    PERSONAL_SYNC_REPO: config.PERSONAL_SYNC_REPO || '',
    ICLOUD_PATH: config.ICLOUD_PATH || '',
    SYNC_WIFI_ONLY: config.SYNC_WIFI_ONLY,
  };
}

/**
 * Merge sync config updates into config.json.
 * If updates.backends is provided, uses the new model and regenerates
 * legacy keys. Otherwise falls back to legacy flat-key updates.
 * Preserves all other keys (toolkit_root, etc.).
 */
export async function setSyncConfig(
  updates: Partial<SyncConfig>
): Promise<SyncConfig> {
  const existing = (await readJson(configPath)) || {};

  if (updates.backends) {
    // New model: replace the backends array and regenerate legacy keys
    existing.storage_backends = updates.backends;
    syncLegacyKeys(existing);
  } else {
    // Legacy flat-key update (old UI path) — merge and rebuild backends array
    if (updates.PERSONAL_SYNC_BACKEND !== undefined) existing.PERSONAL_SYNC_BACKEND = updates.PERSONAL_SYNC_BACKEND;
    if (updates.DRIVE_ROOT !== undefined) existing.DRIVE_ROOT = updates.DRIVE_ROOT;
    if (updates.PERSONAL_SYNC_REPO !== undefined) existing.PERSONAL_SYNC_REPO = updates.PERSONAL_SYNC_REPO;
    if (updates.ICLOUD_PATH !== undefined) existing.ICLOUD_PATH = updates.ICLOUD_PATH;
    // Re-derive storage_backends from flat keys so they stay in sync
    existing.storage_backends = migrateConfigToV2(existing);
  }

  if (updates.SYNC_WIFI_ONLY !== undefined) {
    existing.SYNC_WIFI_ONLY = updates.SYNC_WIFI_ONLY;
  }

  await atomicWrite(configPath, JSON.stringify(existing, null, 2));

  const backends: BackendInstance[] = existing.storage_backends || [];
  return {
    backends,
    PERSONAL_SYNC_BACKEND: existing.PERSONAL_SYNC_BACKEND || 'none',
    DRIVE_ROOT: existing.DRIVE_ROOT || 'Claude',
    PERSONAL_SYNC_REPO: existing.PERSONAL_SYNC_REPO || '',
    ICLOUD_PATH: existing.ICLOUD_PATH || '',
    SYNC_WIFI_ONLY: existing.SYNC_WIFI_ONLY,
  };
}

// --- Backend Instance CRUD ---

/**
 * Add a new backend instance. Auto-generates the id from type + label.
 * Returns the created instance. Writes to config.json immediately.
 */
export async function addBackend(
  instance: Omit<BackendInstance, 'id'>
): Promise<BackendInstance> {
  const config = (await readJson(configPath)) || {};
  const backends: BackendInstance[] = config.storage_backends || migrateConfigToV2(config);

  const id = generateBackendId(instance.type, instance.label);

  // Ensure ID uniqueness — append a counter if needed
  let finalId = id;
  let counter = 2;
  while (backends.some(b => b.id === finalId)) {
    finalId = `${id}-${counter}`;
    counter++;
  }

  const newInstance: BackendInstance = { ...instance, id: finalId };
  backends.push(newInstance);

  config.storage_backends = backends;
  syncLegacyKeys(config);
  await atomicWrite(configPath, JSON.stringify(config, null, 2));

  return newInstance;
}

/**
 * Remove a backend instance by id. Cleans up per-backend state files.
 */
export async function removeBackend(id: string): Promise<void> {
  const config = (await readJson(configPath)) || {};
  const backends: BackendInstance[] = config.storage_backends || [];

  config.storage_backends = backends.filter(b => b.id !== id);
  syncLegacyKeys(config);
  await atomicWrite(configPath, JSON.stringify(config, null, 2));

  // Clean up per-backend marker file. The legacy .sync-error-<id> file is
  // retired as of the sync-warnings refactor — startup cleanup handles it.
  const markerPath = path.join(claudeDir, 'toolkit-state', `.sync-marker-${id}`);
  try { await fs.promises.unlink(markerPath); } catch { /* may not exist */ }

  // Clear any outstanding warnings scoped to this backend so a removed backend
  // doesn't leave a phantom red dot forever.
  await clearWarningsByBackend(id);
}

/**
 * Update a backend instance's label, syncEnabled, or config fields.
 * Returns the updated instance.
 */
export async function updateBackend(
  id: string,
  updates: Partial<Omit<BackendInstance, 'id' | 'type'>>
): Promise<BackendInstance | null> {
  const config = (await readJson(configPath)) || {};
  const backends: BackendInstance[] = config.storage_backends || [];

  const index = backends.findIndex(b => b.id === id);
  if (index === -1) return null;

  // Merge updates into the existing instance
  const existing = backends[index];
  if (updates.label !== undefined) existing.label = updates.label;
  if (updates.syncEnabled !== undefined) existing.syncEnabled = updates.syncEnabled;
  if (updates.config !== undefined) existing.config = { ...existing.config, ...updates.config };

  config.storage_backends = backends;
  syncLegacyKeys(config);
  await atomicWrite(configPath, JSON.stringify(config, null, 2));

  return existing;
}

// --- Force Sync & Per-Backend Sync ---

/**
 * Trigger a force sync of all sync-enabled backends.
 * Delegates to the native SyncService.
 */
export async function forceSync(): Promise<{
  success: boolean;
  output: string;
  error: string;
}> {
  if (!syncServiceInstance) {
    return { success: false, output: '', error: 'SyncService not initialized' };
  }

  try {
    const result = await syncServiceInstance.push({ force: true });
    return {
      success: result.success,
      output: result.backends.join(', ') || 'No backends configured',
      // Shown to the user as the reason (Backup & Sync row, setup wizard) — plain words, no ids.
      error: result.errors > 0 ? "Some backups didn't finish." : '',
    };
  } catch (e: any) {
    return { success: false, output: '', error: e.message || 'SyncService push failed' };
  }
}

/**
 * Push to a single specific backend (manual upsync).
 */
export async function pushBackend(id: string): Promise<{
  success: boolean;
  error: string;
}> {
  if (!syncServiceInstance) {
    return { success: false, error: 'SyncService not initialized' };
  }

  try {
    const result = await syncServiceInstance.push({ force: true, backendId: id });
    return {
      success: result.success,
      // Shown to the user as the reason (Backup & Sync row, setup wizard) — plain words, no ids.
      error: result.errors > 0 ? "Some files didn't upload." : '',
    };
  } catch (e: any) {
    return { success: false, error: e.message || `Push to ${id} failed` };
  }
}

// pullBackend (manual "Download now" downsync) was removed in
// sync-legacy-demolition along with SyncService.pull() — the flat backup paths
// it read are orphaned and restore is gone.

/**
 * Read the last N lines of backup.log.
 * Parses JSON lines where possible for structured display.
 */
export async function getSyncLog(
  lines: number = 30
): Promise<string[]> {
  const content = await readText(backupLogPath);
  if (!content) return [];
  const allLines = content.split('\n').filter((l: string) => l.trim());
  return allLines.slice(-lines);
}

/**
 * Codes the user dismissed during THIS app run.
 *
 * WHY: the health check re-runs on a timer now (so a resolved condition clears
 * itself instead of hanging around until the next launch — see
 * SyncService.runHealthCheck). Without this set, dismissing a still-true
 * warning would only silence it until the next tick re-added it. Deliberately
 * in-memory: a dismissal lasts the app session, matching the old behavior
 * where the check simply never ran again.
 */
const dismissedThisRun = new Set<string>();

/** True if the user dismissed this code during this app run. */
export function wasDismissedThisRun(code: string): boolean {
  return dismissedThisRun.has(code);
}

/**
 * Remove a warning by code. No-op if the warning has dismissible: false
 * (enforced server-side so UI bugs can't silence danger-level push failures).
 */
export async function dismissWarning(code: string): Promise<void> {
  const all = await readWarnings();
  const target = all.find((w) => w.code === code);
  if (!target || !target.dismissible) return;
  dismissedThisRun.add(code);
  const filtered = all.filter((w) => w !== target);
  await writeWarnings(filtered);
}
