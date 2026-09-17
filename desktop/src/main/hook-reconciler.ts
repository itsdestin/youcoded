import fs from 'fs';
import path from 'path';
import os from 'os';
import { listInstalledPluginDirs } from './claude-code-registry';
import { mutateSettings } from './claude-settings';

/**
 * Hook Reconciler (decomposition v3, §9.2)
 *
 * Reads hooks-manifest.json from each installed plugin and reconciles
 * ~/.claude/settings.json. Rules:
 *   - Add missing required hooks
 *   - For existing entries, enforce MAX(user_timeout, manifest_timeout)
 *   - Update stale command paths (e.g., old core/hooks/ → hooks/ after
 *     decomposition flattens the core directory)
 *   - Prune plugin-owned entries whose target file no longer exists on disk
 *     (e.g., hooks dropped from the manifest in phase-3 flatten: sync.sh,
 *     title-update.sh, done-sound.sh, etc.), plus entries under the deleted
 *     legacy youcoded-core clone (see ownedLegacyRoots). Never touches
 *     entries whose command path is outside every one of those roots —
 *     those are user-added and preserved.
 *
 * Triggered on app launch and after core install/update.
 *
 * Note: this reconciler is intentionally separate from install-hooks.js
 * which manages the app's OWN hooks (relay.js, title-update.sh, etc).
 * Those belong to the desktop app; this one belongs to plugins.
 *
 * WHY two entry points (2026-09-16 audit D5/W4): reconcileHooksInto() edits a
 * settings object it is handed, so the launch path can run it as one callback
 * in a single locked read/write of settings.json alongside the other launch
 * chores; reconcileHooks() is the standalone form (after a plugin install)
 * that opens its own cycle. All reading and writing of the file lives in
 * claude-settings.ts.
 */

interface ManifestHookSpec {
  command: string;
  timeout?: number;
  matcher?: string;
  required?: boolean;
}

interface PluginHooksManifest {
  hooks: Record<string, ManifestHookSpec[]>;
}

interface SettingsHookEntry {
  matcher?: string;
  hooks: Array<{ type: 'command'; command: string; timeout?: number }>;
}

interface Settings {
  hooks?: Record<string, SettingsHookEntry[]>;
  [k: string]: unknown;
}

/**
 * Extract the last path component (basename) from a hook command so we can
 * identify the same logical hook even if the full path changed. For
 * `bash ~/.claude/plugins/youcoded-core/hooks/session-start.sh` the
 * identity is `session-start.sh`.
 */
function extractScriptBasename(command: string): string | null {
  // Match .sh, .js, .py, .ts, etc. after any path separator
  const m = command.match(/[\/\\]([^\/\\\s]+\.(sh|js|py|ts|bash))(?:\s|$|")/);
  return m ? m[1] : null;
}

function readPluginManifest(pluginDir: string): PluginHooksManifest | null {
  // Decomposed core ships at <plugin>/hooks/hooks-manifest.json; some older
  // layouts put it at the root. Try both.
  const candidates = [
    path.join(pluginDir, 'hooks', 'hooks-manifest.json'),
    path.join(pluginDir, 'hooks-manifest.json'),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      return JSON.parse(fs.readFileSync(p, 'utf8')) as PluginHooksManifest;
    } catch { continue; }
  }
  return null;
}

function listPluginManifests(): PluginHooksManifest[] {
  // Walk both the top-level toolkit clone and the marketplace subtree.
  // See listInstalledPluginDirs() for why both are needed.
  const manifests: PluginHooksManifest[] = [];
  for (const pluginDir of listInstalledPluginDirs()) {
    const m = readPluginManifest(pluginDir);
    if (m && m.hooks) manifests.push(m);
  }
  return manifests;
}

export interface ReconcileHooksResult {
  added: number;
  updatedPath: number;
  updatedTimeout: number;
  pruned: number;
  manifestCount: number;
}

/**
 * Extract the script path from a hook command so we can check it against
 * the filesystem. Handles `bash ~/...`, `node ~/...`, plain paths, and
 * commands with trailing args. Expands ~ to homedir.
 */
function extractScriptPath(command: string): string | null {
  const m = command.match(/(\S+\.(sh|js|py|ts|bash))(?:\s|$|")/);
  if (!m) return null;
  let p = m[1];
  // Strip surrounding quotes if present
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1);
  }
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  return p;
}

/**
 * Roots the app owns for prune purposes even when they no longer exist on
 * disk. The youcoded-core clone is deleted at launch by legacy-cleanup.ts, so
 * by the time reconcileHooks() runs it is NOT returned by
 * listInstalledPluginDirs() (that function only walks directories that
 * exist). Without this, its orphaned settings.json entries look user-added
 * and are preserved forever — which is why every new Claude Code session
 * opened with "No such file or directory". The app created that directory and
 * the app deleted it, so nothing a user wrote can legitimately live there.
 */
function ownedLegacyRoots(): string[] {
  return [path.join(os.homedir(), '.claude', 'plugins', 'youcoded-core')];
}

/**
 * Prune plugin-owned hook entries whose target file no longer exists. An
 * entry is considered plugin-owned if its script path resolves under any
 * installed plugin dir. User-added hooks (paths outside every plugin root)
 * are left alone, preserving the "never remove user-added hooks" guarantee.
 */
function pruneDeadPluginHooks(settings: Settings, pluginRoots: string[]): number {
  if (!settings.hooks) return 0;
  let pruned = 0;
  for (const event of Object.keys(settings.hooks)) {
    const entries = settings.hooks[event];
    if (!entries) continue;
    for (const entry of entries) {
      entry.hooks = entry.hooks.filter((h) => {
        const scriptPath = extractScriptPath(h.command);
        if (!scriptPath) return true;
        const normalized = path.normalize(scriptPath);
        const ownedByPlugin = pluginRoots.some((root) =>
          normalized.startsWith(path.normalize(root) + path.sep),
        );
        if (!ownedByPlugin) return true;
        // Plugin-owned: prune only if the file is actually missing.
        if (fs.existsSync(scriptPath)) return true;
        pruned++;
        return false;
      });
    }
    // Drop matcher entries that have no hooks left
    settings.hooks[event] = entries.filter((e) => e.hooks.length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  return pruned;
}

/**
 * Find an existing settings.hooks[event] entry whose inner hook command
 * references the same script basename as the manifest spec. Matching on
 * basename tolerates path changes across plugin reorganizations.
 */
function findMatchingEntry(
  existing: SettingsHookEntry[] | undefined,
  spec: ManifestHookSpec,
): { entryIdx: number; hookIdx: number } | null {
  if (!existing) return null;
  const targetBasename = extractScriptBasename(spec.command);
  if (!targetBasename) return null;
  for (let i = 0; i < existing.length; i++) {
    const entry = existing[i];
    // Matcher must also align — a hook tied to Write|Edit is different from
    // a hook tied to Bash|Agent even if the script name is the same
    if ((entry.matcher ?? '') !== (spec.matcher ?? '')) continue;
    for (let j = 0; j < entry.hooks.length; j++) {
      const h = entry.hooks[j];
      if (extractScriptBasename(h.command) === targetBasename) {
        return { entryIdx: i, hookIdx: j };
      }
    }
  }
  return null;
}

/** Reconcile plugin manifests into `settings` in place. The caller owns the
 *  read and the write (see the header). */
export function reconcileHooksInto(settings: Settings): ReconcileHooksResult {
  const manifests = listPluginManifests();
  settings.hooks = settings.hooks || {};

  let added = 0;
  let updatedPath = 0;
  let updatedTimeout = 0;

  for (const manifest of manifests) {
    for (const [event, specs] of Object.entries(manifest.hooks)) {
      settings.hooks[event] = settings.hooks[event] || [];
      const list = settings.hooks[event];

      for (const spec of specs) {
        const match = findMatchingEntry(list, spec);

        if (match) {
          const existingHook = list[match.entryIdx].hooks[match.hookIdx];
          // Update stale command path (the basename matched, so this is the
          // same logical hook — safe to rewrite the full command)
          if (existingHook.command !== spec.command) {
            existingHook.command = spec.command;
            updatedPath++;
          }
          // Enforce MAX timeout — never shorten a user-raised timeout
          const manifestTimeout = spec.timeout ?? 0;
          const existingTimeout = existingHook.timeout ?? 0;
          const maxTimeout = Math.max(manifestTimeout, existingTimeout);
          if (maxTimeout !== existingTimeout) {
            existingHook.timeout = maxTimeout;
            updatedTimeout++;
          }
        } else if (spec.required) {
          // Add a new matcher entry for required hooks the user doesn't have yet
          list.push({
            matcher: spec.matcher ?? '',
            hooks: [{
              type: 'command',
              command: spec.command,
              timeout: spec.timeout ?? 10,
            }],
          });
          added++;
        }
        // Non-required hooks that are missing stay missing — user may have
        // intentionally removed them.
      }
    }
  }

  // Prune pass — remove plugin-owned entries whose script file is gone.
  // Runs last so any path-rewrite from the loop above gets a chance to
  // "save" an entry whose basename still appears in a manifest.
  // Deleted-but-app-owned roots go in alongside the live ones so an orphan
  // left by legacy-cleanup.ts is still recognised as ours to remove.
  const pluginRoots = [...listInstalledPluginDirs(), ...ownedLegacyRoots()];
  const pruned = pruneDeadPluginHooks(settings, pluginRoots);

  return { added, updatedPath, updatedTimeout, pruned, manifestCount: manifests.length };
}

/** Standalone form: one locked read/write cycle of settings.json. */
export async function reconcileHooks(): Promise<ReconcileHooksResult> {
  let result: ReconcileHooksResult = { added: 0, updatedPath: 0, updatedTimeout: 0, pruned: 0, manifestCount: 0 };
  await mutateSettings((settings) => { result = reconcileHooksInto(settings as Settings); });
  return result;
}

// Exposed for tests
export const __test = {
  extractScriptBasename,
  extractScriptPath,
  findMatchingEntry,
  pruneDeadPluginHooks,
};
