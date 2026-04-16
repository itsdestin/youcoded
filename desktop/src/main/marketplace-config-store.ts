/**
 * Phase 3c: Per-entry config storage for marketplace packages.
 * Reads/writes ~/.claude/youcoded-config/<id>.json.
 *
 * This is separate from the plugin's own config (if any) and from the
 * unified youcoded-skills.json. Each marketplace entry that declares
 * a configSchema gets its own JSON file keyed by entry id.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.claude', 'youcoded-config');

/**
 * Get the config values for a marketplace entry.
 * Returns an empty object if no config has been saved yet.
 */
export function getConfig(id: string): Record<string, unknown> {
  try {
    const filePath = path.join(CONFIG_DIR, `${id}.json`);
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Save config values for a marketplace entry.
 * Creates the config directory if it doesn't exist.
 */
export function setConfig(id: string, values: Record<string, unknown>): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  // Atomic write: write to temp then rename
  const filePath = path.join(CONFIG_DIR, `${id}.json`);
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(values, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Delete config for a marketplace entry (used on uninstall).
 */
export function deleteConfig(id: string): void {
  try {
    const filePath = path.join(CONFIG_DIR, `${id}.json`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // best-effort
  }
}
