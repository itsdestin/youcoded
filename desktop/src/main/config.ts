/**
 * config.ts — DestinCode local desktop config, distinct from the sync layer.
 *
 * Used for experimental feature flags and other desktop-local settings that
 * should NOT be synced to cloud backends (the whole point of experimental
 * flags is they're opt-in per machine while we iterate).
 *
 * Lives at ~/.claude/destincode-local.json. Reads/writes are synchronous
 * because callers already operate on the main process startup / IPC thread
 * and the file is tiny.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_PATH = path.join(os.homedir(), '.claude', 'destincode-local.json');

export interface LocalConfig {
  experimental?: {
    /** Gates the restore-from-backup UI surface (wizard, snapshots, onboarding probe). */
    restoreFlow?: boolean;
  };
}

function readConfig(): LocalConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw) as LocalConfig;
  } catch {
    return {};
  }
}

function writeConfig(cfg: LocalConfig): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    // Non-fatal — the next read will just see stale state. Surfacing an error
    // to the user for a dot-file write is worse than the flag misbehaving.
  }
}

export function getLocalConfig(): LocalConfig {
  return readConfig();
}

export function setExperimentalFlag(name: keyof NonNullable<LocalConfig['experimental']>, value: boolean): void {
  const cfg = readConfig();
  cfg.experimental = { ...(cfg.experimental || {}), [name]: value };
  writeConfig(cfg);
}

/** Convenience: is the restore-from-backup flow enabled? Default false. */
export function isRestoreFlowEnabled(): boolean {
  return readConfig().experimental?.restoreFlow === true;
}
