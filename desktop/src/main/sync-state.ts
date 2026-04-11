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
  warnings: string[];
  syncInProgress: boolean;
  syncingBackendId: string | null;     // Which backend is currently syncing
  syncedCategories: string[];
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

const claudeDir = path.join(os.homedir(), '.claude');
const configPath = path.join(claudeDir, 'toolkit-state', 'config.json');
const syncMarkerPath = path.join(claudeDir, 'toolkit-state', '.sync-marker');
const backupMetaPath = path.join(claudeDir, 'backup-meta.json');
const syncWarningsPath = path.join(claudeDir, '.sync-warnings');
const syncLockDir = path.join(claudeDir, 'toolkit-state', '.sync-lock');
const backupLogPath = path.join(claudeDir, 'backup.log');

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

/** Atomic write via temp file + rename (same directory to ensure same filesystem). */
async function atomicWrite(target: string, content: string): Promise<void> {
  const tmpPath = target + '.tmp.' + process.pid;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(tmpPath, content, 'utf8');
  await fs.promises.rename(tmpPath, target);
}

// --- Config Migration: V1 (flat keys) → V2 (storage_backends array) ---

/**
 * Generate a URL-safe slug from a backend type and user-assigned label.
 * Used as the stable ID for a backend instance.
 */
export function generateBackendId(type: string, label: string): string {
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

// --- Public API ---

/**
 * Read all sync state files and return a unified status object.
 * This is the primary data source for the Sync Management UI.
 */
export async function getSyncStatus(): Promise<SyncStatus> {
  const [backends, markerText, meta, warningsText, lockExists] =
    await Promise.all([
      readBackendInstances(),
      readText(syncMarkerPath),
      readJson(backupMetaPath),
      readText(syncWarningsPath),
      dirExists(syncLockDir),
    ]);

  // Enrich each backend with per-instance runtime status
  const backendStatuses: BackendInstanceStatus[] = await Promise.all(
    backends.map(async (b) => {
      const bMarkerText = await readText(perBackendMarkerPath(b.id));
      const lastPushEpoch = bMarkerText ? parseInt(bMarkerText, 10) || null : null;

      // Read per-backend error file if it exists (written by SyncService)
      const errorPath = path.join(claudeDir, 'toolkit-state', `.sync-error-${b.id}`);
      const lastError = await readText(errorPath) || null;

      // A backend is "connected" if it's configured with valid details
      // and hasn't had a persistent error on its last attempt
      const connected = !lastError;

      return { ...b, connected, lastPushEpoch, lastError };
    })
  );

  // Global last sync = most recent push across all backends
  const globalMarkerEpoch = markerText ? parseInt(markerText, 10) || null : null;

  // Parse backup metadata
  const backupMeta = meta
    ? {
        last_backup: meta.last_backup || meta.timestamp || '',
        platform: meta.platform || '',
        toolkit_version: meta.toolkit_version || '',
      }
    : null;

  // Parse warnings (newline-separated codes)
  const warnings = warningsText
    ? warningsText.split('\n').filter((l: string) => l.trim())
    : [];

  // Detect synced data categories by checking directory/file existence
  const categoryChecks = await Promise.all([
    dirExists(path.join(claudeDir, 'projects')).then((exists) =>
      exists ? 'memory' : null
    ),
    dirExists(path.join(claudeDir, 'projects')).then((exists) =>
      exists ? 'conversations' : null
    ),
    dirExists(path.join(claudeDir, 'encyclopedia')).then((exists) =>
      exists ? 'encyclopedia' : null
    ),
    dirExists(path.join(claudeDir, 'skills')).then((exists) =>
      exists ? 'skills' : null
    ),
    fileExists(path.join(claudeDir, 'settings.json')).then((exists) =>
      exists ? 'system-config' : null
    ),
    dirExists(path.join(claudeDir, 'plans')).then((exists) =>
      exists ? 'plans' : null
    ),
    dirExists(path.join(claudeDir, 'specs')).then((exists) =>
      exists ? 'specs' : null
    ),
  ]);
  const syncedCategories = categoryChecks.filter(Boolean) as string[];

  return {
    backends: backendStatuses,
    lastSyncEpoch: globalMarkerEpoch,
    backupMeta,
    warnings,
    syncInProgress: lockExists,
    syncingBackendId: null, // Set by SyncService at runtime via event
    syncedCategories,
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

  // Clean up per-backend marker and error files
  for (const suffix of [`.sync-marker-${id}`, `.sync-error-${id}`]) {
    const filePath = path.join(claudeDir, 'toolkit-state', suffix);
    try { await fs.promises.unlink(filePath); } catch { /* may not exist */ }
  }
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
      error: result.errors > 0 ? `${result.errors} backend(s) had errors` : '',
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
      error: result.errors > 0 ? `Push to ${id} had errors` : '',
    };
  } catch (e: any) {
    return { success: false, error: e.message || `Push to ${id} failed` };
  }
}

/**
 * Pull from a single specific backend (manual downsync).
 */
export async function pullBackend(id: string): Promise<{
  success: boolean;
  error: string;
}> {
  if (!syncServiceInstance) {
    return { success: false, error: 'SyncService not initialized' };
  }

  try {
    await syncServiceInstance.pull({ backendId: id });
    return { success: true, error: '' };
  } catch (e: any) {
    return { success: false, error: e.message || `Pull from ${id} failed` };
  }
}

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
 * Remove a specific warning code from .sync-warnings.
 */
export async function dismissWarning(warning: string): Promise<void> {
  const content = await readText(syncWarningsPath);
  if (!content) return;
  const remaining = content
    .split('\n')
    .filter((l: string) => l.trim() && l.trim() !== warning.trim())
    .join('\n');
  if (remaining) {
    await fs.promises.writeFile(syncWarningsPath, remaining + '\n', 'utf8');
  } else {
    // No warnings left — remove the file
    try {
      await fs.promises.unlink(syncWarningsPath);
    } catch {
      // File may already be gone
    }
  }
}
