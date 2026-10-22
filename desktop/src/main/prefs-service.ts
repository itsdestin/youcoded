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
import { atomicWrite } from './atomic-write';

// ─── Session defaults (~/.claude/youcoded-defaults.json) ─────────────────────

function defaultsFilePath(): string {
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

// WHY a cache (2026-10-22 freeze hunt): `defaults:get` used to readFileSync on every call, and on a
// nearly-full btrfs disk that read stalled the whole main thread for seconds. The read is now async
// and its parsed result is cached per file. The cache is validated by an (async) stat signature
// instead of trusted blindly, because other code still writes this file directly
// (migrate-permission-overrides, the dev tools, a hand edit): a changed signature means re-read.
// An atomic write replaces the inode, so the signature also changes on every save of ours.
interface DefaultsCacheEntry { sig: string; value: Record<string, any> }
const defaultsCache = new Map<string, DefaultsCacheEntry>();

function withOverrideDefaults(parsed: Record<string, any>): Record<string, any> {
  return {
    ...defaultsInitial(), ...parsed,
    permissionOverrides: { ...PERMISSION_OVERRIDES_DEFAULT, ...parsed.permissionOverrides },
  };
}

/** Hand out a copy so a caller mutating its result can never corrupt the cache. */
function cloneDefaults(v: Record<string, any>): Record<string, any> {
  return { ...v, permissionOverrides: { ...v.permissionOverrides } };
}

/** The saved defaults over the built-in ones, overrides merged key by key. Refreshes the
 *  enforcement cache as a side effect, as the desktop handler always did. */
export async function readDefaults(file = defaultsFilePath()): Promise<Record<string, any>> {
  try {
    const st = await fs.promises.stat(file);
    const sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
    const hit = defaultsCache.get(file);
    if (hit && hit.sig === sig) {
      syncPermissionOverrides(hit.value);
      return cloneDefaults(hit.value);
    }
    const parsed = JSON.parse(await fs.promises.readFile(file, 'utf-8'));
    const result = withOverrideDefaults(parsed);
    defaultsCache.set(file, { sig, value: result });
    syncPermissionOverrides(result);
    return cloneDefaults(result);
  } catch {
    defaultsCache.delete(file);
    return defaultsInitial();
  }
}

// WHY a queue: writeDefaults is read-merge-write. It was safe while it was synchronous; now that it
// awaits, two overlapping saves would both read the old file and the second would drop the first's
// keys. Saves for one file run one at a time, in the order asked.
const writeQueues = new Map<string, Promise<unknown>>();

/** Merge `updates` into the saved defaults (the override block merged INTO, never replaced),
 *  write atomically, refresh the enforcement cache, and answer the result — or null when it
 *  could not be written. */
export function writeDefaults(updates: Record<string, any>, file = defaultsFilePath()): Promise<Record<string, any> | null> {
  const run = (writeQueues.get(file) ?? Promise.resolve()).then(() => writeDefaultsNow(updates, file));
  const tail = run.catch(() => {});
  writeQueues.set(file, tail);
  void tail.then(() => { if (writeQueues.get(file) === tail) writeQueues.delete(file); });
  return run;
}

async function writeDefaultsNow(updates: Record<string, any>, file: string): Promise<Record<string, any> | null> {
  try {
    let current: Record<string, any> = defaultsInitial();
    try {
      current = withOverrideDefaults(JSON.parse(await fs.promises.readFile(file, 'utf-8')));
    } catch { /* no file yet, or unreadable: start from the built-in defaults */ }
    const merged = { ...current, ...updates };
    if (updates && updates.permissionOverrides) {
      merged.permissionOverrides = { ...current.permissionOverrides, ...updates.permissionOverrides };
    }
    // atomicWrite makes the folder, writes a temp file and renames it over the target, so a reader
    // (or a crash mid-save) sees the old whole file or the new one — never half.
    await atomicWrite(file, JSON.stringify(merged, null, 2));
    // WHY drop the cached copy: the next read must see what was just saved (its stat signature
    // changes anyway; this makes the invalidation explicit rather than dependent on timestamps).
    defaultsCache.delete(file);
    syncPermissionOverrides(merged);
    return merged;
  } catch {
    return null;
  }
}

// ─── Game favorites + presence incognito (~/.claude/youcoded-favorites.json) ──

function gamePrefsFilePath(): string {
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
