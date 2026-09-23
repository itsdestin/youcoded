// Preference files that a desktop window AND a remote device read and write, one owner each.
//
// WHY this module exists (remote-access roadmap, "Settings read over remote access can
// disagree with what the desktop shows for the same file"): remote-server.ts carried its own
// hand-copied defaults:* and favorites/incognito handlers, and they had drifted. The remote
// defaults:get dropped the permission-override defaults the desktop fills in, its
// defaults:set replaced the whole overrides block instead of merging into it, and neither
// refreshed what the app ENFORCES (main.ts's in-memory override cache) — so a permission
// setting saved from a phone was not acted on until something on the desktop re-read the
// file. favorites:get answered the whole file over remote but a list on the desktop.
// ipc-handlers.ts / main.ts and remote-server.ts are now callers of these functions — the
// same pattern as folders-service.ts. Pinned by tests/prefs-service.test.ts.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PERMISSION_OVERRIDES_DEFAULT } from '../shared/types';

// ─── Session defaults (~/.claude/youcoded-defaults.json) ─────────────────────

export function defaultsFilePath(): string {
  return path.join(os.homedir(), '.claude', 'youcoded-defaults.json');
}

function defaultsInitial(): Record<string, any> {
  return {
    skipPermissions: false,
    model: 'sonnet',
    projectFolder: '',
    permissionOverrides: { ...PERMISSION_OVERRIDES_DEFAULT },
  };
}

/** Where a changed override block goes: main.ts's enforcement cache. Set once by ipc-handlers
 *  (main.ts cannot be imported from here — it runs the app at module scope). */
let permissionOverridesSink: ((overrides: Record<string, any>) => void) | null = null;
export function setPermissionOverridesSink(sink: (overrides: Record<string, any>) => void): void {
  permissionOverridesSink = sink;
}

function syncPermissionOverrides(defaults: Record<string, any>): void {
  const overrides = defaults.permissionOverrides;
  if (overrides && typeof overrides === 'object') permissionOverridesSink?.(overrides);
}

/** The saved defaults over the built-in ones, overrides merged key by key. Refreshes the
 *  enforcement cache as a side effect, as the desktop handler always did. */
export function readDefaults(file = defaultsFilePath()): Record<string, any> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const result = {
      ...defaultsInitial(), ...parsed,
      permissionOverrides: { ...PERMISSION_OVERRIDES_DEFAULT, ...parsed.permissionOverrides },
    };
    syncPermissionOverrides(result);
    return result;
  } catch {
    return defaultsInitial();
  }
}

/** Merge `updates` into the saved defaults (the override block merged INTO, never replaced),
 *  write, refresh the enforcement cache, and answer the result — or null when it could not
 *  be written. */
export function writeDefaults(updates: Record<string, any>, file = defaultsFilePath()): Record<string, any> | null {
  try {
    let current: Record<string, any> = defaultsInitial();
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      current = {
        ...current, ...parsed,
        permissionOverrides: { ...PERMISSION_OVERRIDES_DEFAULT, ...parsed.permissionOverrides },
      };
    } catch { /* no file yet, or unreadable: start from the built-in defaults */ }
    const merged = { ...current, ...updates };
    if (updates && updates.permissionOverrides) {
      merged.permissionOverrides = { ...current.permissionOverrides, ...updates.permissionOverrides };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(merged, null, 2));
    syncPermissionOverrides(merged);
    return merged;
  } catch {
    return null;
  }
}

// ─── Game favorites + presence incognito (~/.claude/youcoded-favorites.json) ──

export function gamePrefsFilePath(): string {
  return path.join(os.homedir(), '.claude', 'youcoded-favorites.json');
}

function readGamePrefs(file: string): Record<string, any> {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return {}; }
}

function writeGamePrefs(data: Record<string, any>, file: string): boolean {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); return true; }
  catch { return false; }
}

export function getFavorites(file = gamePrefsFilePath()): unknown[] {
  return readGamePrefs(file).favorites ?? [];
}

export function setFavorites(favorites: unknown, file = gamePrefsFilePath()): boolean {
  const data = readGamePrefs(file);
  data.favorites = favorites;
  return writeGamePrefs(data, file);
}

export function getIncognito(file = gamePrefsFilePath()): boolean {
  return readGamePrefs(file).incognito ?? false;
}

export function setIncognito(incognito: unknown, file = gamePrefsFilePath()): boolean {
  const data = readGamePrefs(file);
  data.incognito = incognito;
  return writeGamePrefs(data, file);
}
