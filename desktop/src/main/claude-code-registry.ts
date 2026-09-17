import fs from 'fs';
import path from 'path';
import os from 'os';
import { mutateSettings } from './claude-settings';

/**
 * Claude Code Registry Integration.
 *
 * Claude Code (v2.1.x) does NOT filesystem-scan `~/.claude/plugins/` to find
 * plugins. Instead, its plugin loader (`GD_` in the CLI binary) iterates the
 * `enabledPlugins` map from `~/.claude/settings.json` and resolves each entry
 * through four on-disk registries:
 *
 *   1. ~/.claude/settings.json           → enabledPlugins: { "id@marketplace": true }
 *   2. ~/.claude/installed_plugins.json  → v2: { plugins: { "id@marketplace": [{ installPath, ... }] } }
 *   3. ~/.claude/known_marketplaces.json → { "marketplace": { source, installLocation, ... } }
 *   4. <installLocation>/.claude-plugin/marketplace.json → { name, owner, plugins: [{ name, source, ... }] }
 *
 * If any of these are missing, /reload-plugins silently fails to pick the
 * plugin up (reporting "0 new plugins"). This module writes all four so
 * YouCoded-marketplace installs surface inside Claude Code as real plugins
 * with live slash-command support.
 *
 * The non-cache code path (`t71`) used by /reload-plugins requires the actual
 * plugin directory to live at `<marketplaceInstallLocation>/<source>` — it
 * will NOT fall back to just `installPath`. So plugins are installed under
 * the marketplace's own plugins/ subtree, not the legacy ~/.claude/plugins/<id>/.
 */

// --- Paths ---
//
// IMPORTANT: Claude Code's "plugin cache dir" (`tW()` in the binary) is
// `~/.claude/plugins/`, NOT `~/.claude/`. `installed_plugins.json`,
// `known_marketplaces.json`, and the `marketplaces/` subtree all live under
// that cache dir. Only `settings.json` (which carries `enabledPlugins`) is
// at `~/.claude/settings.json` — it's read via a scan across all home dirs.
// A previous fix wrote these to `~/.claude/` one level too high; that
// produced files the CLI never read.

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PLUGIN_CACHE_DIR = path.join(CLAUDE_DIR, 'plugins'); // tW() in the CLI

const YOUCODED_MARKETPLACE_ID = 'youcoded';
const YOUCODED_MARKETPLACE_ROOT = path.join(PLUGIN_CACHE_DIR, 'marketplaces', YOUCODED_MARKETPLACE_ID);
export const YOUCODED_PLUGINS_DIR = path.join(YOUCODED_MARKETPLACE_ROOT, 'plugins');

/** Does this directory carry a plugin.json manifest, in either standard layout? */
export function hasPluginManifest(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, 'plugin.json')) ||
    fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))
  );
}

/**
 * Enumerate every directory that should be treated as an "installed plugin"
 * by reconcilers and skill-provider introspection.
 *
 * Two sources produce installed plugins:
 *   1. `bootstrap/install.sh` clones the core toolkit to
 *      `~/.claude/plugins/youcoded-core/` directly (not via plugin-installer),
 *      so top-level children of PLUGIN_CACHE_DIR with a plugin.json count.
 *   2. `plugin-installer.ts` writes marketplace-installed packages to
 *      `YOUCODED_PLUGINS_DIR` — every direct child there is a plugin.
 *
 * PLUGIN_CACHE_DIR also contains `installed_plugins.json`,
 * `known_marketplaces.json`, and the `marketplaces/` subtree. The plugin.json
 * check filters those out — they have no manifest. Scanning both sources
 * handles the pre-decomposition toolkit clone AND the marketplace packages
 * it split into without duplicating anything (the two roots don't overlap).
 *
 * Fix (Track B final review, Finding F1): the marketplace-subtree loop used
 * to add EVERY child directory unconditionally — no dot-prefix skip, no
 * manifest check. plugin-installer.ts's upgradePluginFromLocal() stages an
 * upgrade at `.upgrade-<id>-<pid>` and parks the retired tree at
 * `.old-<id>-<pid>`, both inside this same marketplace subtree — if the
 * process dies mid-swap (or Windows holds a file open, the documented
 * expected case for the retired-tree cleanup), that leftover directory (a
 * full copy of the plugin, complete with its own plugin.json) got scanned
 * here as a SECOND installed plugin and fed into hook-reconciler.ts /
 * mcp-reconciler.ts, registering duplicate hooks/MCP servers and making
 * every skill it provides ambiguous. A plugin id can never start with "."
 * (plugin-installer.ts's SAFE_ID_RE forbids it), so the dot-skip can never
 * hide a real plugin. Matches Android's ClaudeCodeRegistry.kt
 * hasPluginManifest + dot-skip fix (Task B5 review round 2).
 */
export function listInstalledPluginDirs(): string[] {
  const dirs: string[] = [];

  if (fs.existsSync(PLUGIN_CACHE_DIR)) {
    for (const entry of fs.readdirSync(PLUGIN_CACHE_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'marketplaces') continue;
      const candidate = path.join(PLUGIN_CACHE_DIR, entry.name);
      if (hasPluginManifest(candidate)) {
        dirs.push(candidate);
      }
    }
  }

  if (fs.existsSync(YOUCODED_PLUGINS_DIR)) {
    for (const entry of fs.readdirSync(YOUCODED_PLUGINS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      const candidate = path.join(YOUCODED_PLUGINS_DIR, entry.name);
      if (hasPluginManifest(candidate)) {
        dirs.push(candidate);
      }
    }
  }

  return dirs;
}

const MARKETPLACE_MANIFEST = path.join(YOUCODED_MARKETPLACE_ROOT, '.claude-plugin', 'marketplace.json');
const KNOWN_MARKETPLACES = path.join(PLUGIN_CACHE_DIR, 'known_marketplaces.json');
const INSTALLED_PLUGINS = path.join(PLUGIN_CACHE_DIR, 'installed_plugins.json');

// --- Key helpers ---

/** The @-qualified key Claude Code uses in enabledPlugins & installed_plugins.json. */
function pluginKey(id: string): string {
  return `${id}@${YOUCODED_MARKETPLACE_ID}`;
}

/** Absolute install dir for a plugin under our marketplace. */
export function pluginInstallDir(id: string): string {
  return path.join(YOUCODED_PLUGINS_DIR, id);
}

// --- JSON file helpers (tolerant, atomic-ish) ---

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, data: any): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // pid-suffixed temp name: two processes sharing ~/.claude must not race the same .tmp
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// --- known_marketplaces.json ---

interface KnownMarketplaceEntry {
  source: any;
  installLocation: string;
  lastUpdated: string;
  autoUpdate?: boolean;
}

/**
 * Ensures our marketplace is listed in known_marketplaces.json. Preserves any
 * other marketplaces the user has added via Claude Code's native /plugin flow.
 */
function ensureMarketplaceRegistered(): void {
  const now = new Date().toISOString();
  const existing: Record<string, KnownMarketplaceEntry> = readJson(KNOWN_MARKETPLACES) || {};

  // Only write if missing or the installLocation has drifted (e.g. different OS home)
  const current = existing[YOUCODED_MARKETPLACE_ID];
  if (current && current.installLocation === YOUCODED_MARKETPLACE_ROOT) return;

  existing[YOUCODED_MARKETPLACE_ID] = {
    // `autoUpdate: false` — we manage marketplace.json ourselves, don't let
    // Claude Code try to refetch it over the network.
    source: { source: 'github', repo: 'itsdestin/wecoded-marketplace' },
    installLocation: YOUCODED_MARKETPLACE_ROOT,
    lastUpdated: now,
    autoUpdate: false,
  };

  writeJsonAtomic(KNOWN_MARKETPLACES, existing);
}

// --- marketplace.json (our marketplace's own manifest) ---

interface MarketplacePluginEntry {
  name: string;
  source: string;
  description?: string;
  version?: string;
  category?: string;
  author?: { name: string };
  strict?: boolean;
}

interface MarketplaceManifest {
  name: string;
  owner: { name: string; url?: string };
  plugins: MarketplacePluginEntry[];
  metadata?: { version?: string };
}

function readMarketplaceManifest(): MarketplaceManifest {
  const existing = readJson(MARKETPLACE_MANIFEST);
  if (existing && Array.isArray(existing.plugins)) return existing;
  return {
    name: YOUCODED_MARKETPLACE_ID,
    owner: { name: 'YouCoded', url: 'https://github.com/itsdestin/youcoded' },
    plugins: [],
  };
}

function upsertPluginInManifest(entry: MarketplacePluginEntry): void {
  const manifest = readMarketplaceManifest();
  const idx = manifest.plugins.findIndex(p => p.name === entry.name);
  if (idx >= 0) manifest.plugins[idx] = entry;
  else manifest.plugins.push(entry);
  writeJsonAtomic(MARKETPLACE_MANIFEST, manifest);
}

function removePluginFromManifest(id: string): void {
  const manifest = readMarketplaceManifest();
  const next = manifest.plugins.filter(p => p.name !== id);
  if (next.length === manifest.plugins.length) return;
  manifest.plugins = next;
  writeJsonAtomic(MARKETPLACE_MANIFEST, manifest);
}

// --- installed_plugins.json ---

interface InstalledEntry {
  scope: 'user' | 'project' | 'local' | 'managed';
  projectPath?: string;
  installPath: string;
  version?: string;
  installedAt?: string;
  lastUpdated?: string;
  gitCommitSha?: string;
}

interface InstalledPluginsFile {
  version: 2;
  plugins: Record<string, InstalledEntry[]>;
}

function readInstalledPlugins(): InstalledPluginsFile {
  const existing = readJson(INSTALLED_PLUGINS);
  if (existing && existing.version === 2 && existing.plugins) return existing;
  return { version: 2, plugins: {} };
}

function writeInstalledPlugin(id: string, installPath: string, version: string): void {
  const db = readInstalledPlugins();
  const now = new Date().toISOString();
  const key = pluginKey(id);
  db.plugins[key] = [{
    scope: 'user',
    installPath,
    version,
    installedAt: now,
    lastUpdated: now,
  }];
  writeJsonAtomic(INSTALLED_PLUGINS, db);
}

function removeInstalledPlugin(id: string): void {
  const db = readInstalledPlugins();
  const key = pluginKey(id);
  if (!db.plugins[key]) return;
  delete db.plugins[key];
  writeJsonAtomic(INSTALLED_PLUGINS, db);
}

// --- settings.json enabledPlugins ---
//
// WHY (2026-09-16 audit D5): settings.json is read and written ONLY by
// claude-settings.ts — under the cross-process lock, atomically, and never
// over a file that does not parse (this module used to treat an unparseable
// file as empty and write a fresh one over it). The mutators below edit the
// object they are handed; the module decides whether anything changed.

async function enablePluginInSettings(id: string): Promise<void> {
  const key = pluginKey(id);
  await mutateSettings((settings) => {
    if (!settings.enabledPlugins || typeof settings.enabledPlugins !== 'object') {
      settings.enabledPlugins = {};
    }
    (settings.enabledPlugins as Record<string, unknown>)[key] = true;
  });
}

async function disablePluginInSettings(id: string): Promise<void> {
  const key = pluginKey(id);
  await mutateSettings((settings) => {
    const enabled = settings.enabledPlugins;
    if (enabled && typeof enabled === 'object') delete (enabled as Record<string, unknown>)[key];
  });
}

// --- Public API ---

export interface RegisterInstallInput {
  id: string;
  installPath: string;
  version?: string;
  description?: string;
  author?: string;
  category?: string;
}

/**
 * Wires a YouCoded-installed plugin into all four Claude Code registries
 * so /reload-plugins (and session start) loads it as a first-class plugin.
 */
export async function registerPluginInstall(input: RegisterInstallInput): Promise<void> {
  const { id, installPath, version, description, author, category } = input;
  ensureMarketplaceRegistered();
  upsertPluginInManifest({
    name: id,
    // Source is relative to marketplace root; `t71` computes
    // `<installLocation>/<source>` when loading without the cache.
    source: `./plugins/${id}`,
    description,
    version,
    category,
    author: author ? { name: author } : undefined,
    strict: true,
  });
  writeInstalledPlugin(id, installPath, version || '1.0.0');
  await enablePluginInSettings(id);
}

/**
 * Removes the plugin from all four registries. Does NOT delete the plugin
 * directory — that's the caller's job (plugin-installer.ts).
 */
export async function unregisterPluginInstall(id: string): Promise<void> {
  removePluginFromManifest(id);
  removeInstalledPlugin(id);
  await disablePluginInSettings(id);
}

