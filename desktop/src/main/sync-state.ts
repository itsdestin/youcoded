/**
 * sync-state.ts — Shared sync state reader for the Sync Management UI.
 *
 * Reads state files written by the native SyncService and toolkit hooks,
 * and exposes them as typed objects. Also provides config writes and
 * force-sync triggering (delegates to SyncService).
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

// --- Types ---

export interface SyncBackendInfo {
  name: 'drive' | 'github' | 'icloud';
  configured: boolean;
  detail: string; // e.g., "gdrive:Claude/Backup/personal" or repo URL
}

export interface SyncStatus {
  backends: SyncBackendInfo[];
  lastSyncEpoch: number | null;
  backupMeta: {
    last_backup: string;
    platform: string;
    toolkit_version: string;
  } | null;
  warnings: string[];
  syncInProgress: boolean;
  syncedCategories: string[];
}

export interface SyncConfig {
  PERSONAL_SYNC_BACKEND: string;
  DRIVE_ROOT: string;
  PERSONAL_SYNC_REPO: string;
  ICLOUD_PATH: string;
}

// --- Paths ---

const claudeDir = path.join(os.homedir(), '.claude');
const configPath = path.join(claudeDir, 'toolkit-state', 'config.json');
const syncMarkerPath = path.join(claudeDir, 'toolkit-state', '.sync-marker');
const backupMetaPath = path.join(claudeDir, 'backup-meta.json');
const syncWarningsPath = path.join(claudeDir, '.sync-warnings');
const syncLockDir = path.join(claudeDir, 'toolkit-state', '.sync-lock');
const backupLogPath = path.join(claudeDir, 'backup.log');

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

// --- Public API ---

/**
 * Read all sync state files and return a unified status object.
 * This is the primary data source for the Sync Management UI.
 */
export async function getSyncStatus(): Promise<SyncStatus> {
  const [config, markerText, meta, warningsText, lockExists] =
    await Promise.all([
      readJson(configPath),
      readText(syncMarkerPath),
      readJson(backupMetaPath),
      readText(syncWarningsPath),
      dirExists(syncLockDir),
    ]);

  // Parse backends from comma-separated config
  const backendStr: string =
    config?.PERSONAL_SYNC_BACKEND || 'none';
  const driveRoot: string = config?.DRIVE_ROOT || 'Claude';
  const syncRepo: string = config?.PERSONAL_SYNC_REPO || '';
  const icloudPath: string = config?.ICLOUD_PATH || '';

  const backends: SyncBackendInfo[] = [];
  const activeBackends = backendStr
    .split(',')
    .map((b: string) => b.trim().toLowerCase())
    .filter((b: string) => b && b !== 'none');

  // Drive backend
  backends.push({
    name: 'drive',
    configured: activeBackends.includes('drive'),
    detail: activeBackends.includes('drive')
      ? `gdrive:${driveRoot}/Backup/personal`
      : 'Not configured',
  });

  // GitHub backend
  backends.push({
    name: 'github',
    configured: activeBackends.includes('github'),
    detail: activeBackends.includes('github') && syncRepo
      ? syncRepo
      : 'Not configured',
  });

  // iCloud backend
  backends.push({
    name: 'icloud',
    configured: activeBackends.includes('icloud'),
    detail: activeBackends.includes('icloud') && icloudPath
      ? icloudPath
      : 'Not configured',
  });

  // Parse last sync epoch from marker file
  const lastSyncEpoch = markerText ? parseInt(markerText, 10) || null : null;

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
    backends,
    lastSyncEpoch,
    backupMeta,
    warnings,
    syncInProgress: lockExists,
    syncedCategories,
  };
}

/**
 * Read backend configuration from config.json.
 */
export async function getSyncConfig(): Promise<SyncConfig> {
  const config = (await readJson(configPath)) || {};
  return {
    PERSONAL_SYNC_BACKEND: config.PERSONAL_SYNC_BACKEND || 'none',
    DRIVE_ROOT: config.DRIVE_ROOT || 'Claude',
    PERSONAL_SYNC_REPO: config.PERSONAL_SYNC_REPO || '',
    ICLOUD_PATH: config.ICLOUD_PATH || '',
  };
}

/**
 * Merge sync config updates into config.json.
 * Preserves all other keys (toolkit_root, etc.).
 */
export async function setSyncConfig(
  updates: Partial<SyncConfig>
): Promise<SyncConfig> {
  const existing = (await readJson(configPath)) || {};
  const merged = { ...existing, ...updates };

  // Atomic write: write to temp file, then rename
  const tmpPath = configPath + '.tmp.' + process.pid;
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(tmpPath, JSON.stringify(merged, null, 2), 'utf8');
  await fs.promises.rename(tmpPath, configPath);

  return {
    PERSONAL_SYNC_BACKEND: merged.PERSONAL_SYNC_BACKEND || 'none',
    DRIVE_ROOT: merged.DRIVE_ROOT || 'Claude',
    PERSONAL_SYNC_REPO: merged.PERSONAL_SYNC_REPO || '',
    ICLOUD_PATH: merged.ICLOUD_PATH || '',
  };
}

/**
 * Trigger a force sync. Delegates to the native SyncService.
 * The legacy fallback to sync.sh was removed — sync.sh no longer exists
 * after the toolkit sync decoupling (backup-system-spec.md v6.0).
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
