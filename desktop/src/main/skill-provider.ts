import fs from 'fs';
import path from 'path';
import os from 'os';
import { scanSkills } from './skill-scanner';
import { SkillConfigStore } from './skill-config-store';
import { encodeSkillLink, decodeSkillLink } from './skill-share';
import { installPlugin, uninstallPlugin, upgradePluginFromLocal, refreshLocalMarketplaceCache, readPluginVersion, isPluginInstalled, marketplaceCacheDir, sweepStaleUpgradeDirs, type InstallResult, upgradePluginFromGit } from './plugin-installer';
import { pluginInstallDir, YOUCODED_PLUGINS_DIR, listInstalledPluginDirs } from './claude-code-registry';
import { getConfig as getMarketplaceConfig } from './marketplace-config-store';
import { reconcileHooks } from './hook-reconciler';
import { reconcileMcp } from './mcp-reconciler';
import { log } from './logger';
import { BUNDLED_PLUGIN_IDS } from '../shared/bundled-plugins';
import { isNewerVersion } from '../shared/version-compare';
import { getManagedRoots } from './sync-spaces/service';
import { NativeHome } from './native-home';
import { markPluginRemoved } from './project-extensions/store';
// Marketplace overhaul Task 16: the Worker host the catalog is served from.
// Main already imports this module (install-reconcile.ts, marketplace-api-handlers.ts).
import { MARKETPLACE_API_HOST } from '../renderer/state/marketplace-api-client';
import type {
  SkillEntry, SkillDetailView, SkillFilters, ChipConfig,
  MetadataOverride,
} from '../shared/types';

const CLAUDE_PLUGINS_ROOT = path.join(os.homedir(), '.claude', 'plugins');

/**
 * Resolve a plugin id to its on-disk directory. Checks the top-level toolkit
 * clone path first (for the core `youcoded-core` id cloned by install.sh)
 * and falls back to the marketplace subtree (for plugin-installer packages).
 */
function resolvePluginDir(id: string): string | null {
  const topLevel = path.join(CLAUDE_PLUGINS_ROOT, id);
  if (fs.existsSync(topLevel)) return topLevel;
  const marketplace = path.join(YOUCODED_PLUGINS_DIR, id);
  if (fs.existsSync(marketplace)) return marketplace;
  return null;
}

// Fix (Track B final review, Finding F3): readPluginVersion() returning null
// is ambiguous — no plugin.json exists, one exists but fails to parse, or one
// exists and parses but has no "version" key (exactly what
// plugin-installer.ts's ensurePluginJson() writes). docs/error-message-standards.md
// forbids guessing an unverified cause, so this inspects the same two
// candidate paths readPluginVersion() checks and reports which specific
// state was actually observed, never a blanket "unreadable".
function describeManifestVersionState(dir: string): string {
  const candidates = [
    path.join(dir, 'plugin.json'),
    path.join(dir, '.claude-plugin', 'plugin.json'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (typeof parsed.version !== 'string') return `${p} has no "version" field`;
      // Has a string version — readPluginVersion() would have returned it,
      // so this function is never called on this path in practice.
      return `${p} has version "${parsed.version}"`;
    } catch (err: any) {
      return `${p} exists but failed to parse: ${err?.message || String(err)}`;
    }
  }
  return `no plugin.json found at ${dir}/plugin.json or ${dir}/.claude-plugin/plugin.json`;
}

// Patterns that indicate sensitive content — stripped before upload
const SENSITIVE_PATTERNS = [
  /\.env$/i,
  /\.env\..*/i,
  /credentials\.json$/i,
  /secrets?\.(json|ya?ml|toml)$/i,
  /\.pem$/i,
  /\.key$/i,
  /token(s)?\.(json|txt)$/i,
];

const CACHE_DIR = path.join(os.homedir(), '.claude', 'youcoded-marketplace-cache');
const INDEX_CACHE = path.join(CACHE_DIR, 'index.json');
const DEFAULTS_CACHE = path.join(CACHE_DIR, 'curated-defaults.json');
const FEATURED_CACHE = path.join(CACHE_DIR, 'featured.json');

// GitHub raw content base URL — set this to your marketplace repo
// YOUCODED_MARKETPLACE_BRANCH overrides the branch for test harnesses.
const REGISTRY_BASE = `https://raw.githubusercontent.com/itsdestin/wecoded-marketplace/${process.env.YOUCODED_MARKETPLACE_BRANCH || 'master'}`;

const INDEX_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Marketplace overhaul: the Worker's catalog is the source of truth — it carries
// the type / origin / scan / capabilities block the redesigned UI renders, and CI
// refreshes it hourly. index.json on GitHub stays as the fallback so a Worker
// outage (or an old Worker) degrades to today's behaviour, not to an empty grid.
// YOUCODED_CATALOG_URL: tests point it at a fake; "" disables the catalog step.
const CATALOG_URL = process.env.YOUCODED_CATALOG_URL ?? `${MARKETPLACE_API_HOST}/catalog`;
const CATALOG_CACHE = path.join(CACHE_DIR, 'catalog.json');
// 1h, not 24h: the Worker already caches 5 min and CI refreshes hourly, so a newly
// published item shows up within the hour instead of the next day.
const CATALOG_TTL = 60 * 60 * 1000;

// `etag` is optional: only the catalog cache stores one, every other cache omits it.
interface CacheMeta { fetchedAt: number; etag?: string; }

// The class IS the type: ipc-handlers.ts and remote-server.ts take a
// `LocalSkillProvider` directly (the one-implementation `SkillProvider`
// interface was deleted — simplification audit M7).
export class LocalSkillProvider {
  // Phase 3a: made public so ThemeMarketplaceProvider can share the same
  // youcoded-skills.json packages map and marketplace IPC can read it
  public configStore = new SkillConfigStore();
  private installedCache: SkillEntry[] | null = null;
  private onCacheInvalidated?: () => void;
  // Review fix (Finding 3): guards the "a bundled id is missing from the
  // index" refetch in reconcileBundledPlugins() so it can fire at most once
  // per process. Without it, a bundled id that's PERMANENTLY missing (its
  // marketplace entry hasn't merged yet) would retrigger the refetch on every
  // call in this process — there is only ever one call in production
  // (main.ts, at boot), but the guard is here so a future second call can't
  // silently reintroduce the repeated-invalidate behavior this finding flagged.
  private bundledIndexRefetchDone = false;

  setCacheInvalidationListener(cb: () => void): void {
    this.onCacheInvalidated = cb;
  }

  constructor() {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  // --- Discovery ---

  async listMarketplace(filters?: SkillFilters): Promise<SkillEntry[]> {
    let entries = await this.fetchIndex();
    // Stats (installs, rating, ratingCount) are now served by the live
    // /stats endpoint via MarketplaceStatsProvider in the renderer.
    // skill-provider.ts no longer fetches or merges static stats.json.

    // Apply filters
    if (filters?.type) entries = entries.filter(e => e.type === filters.type);
    if (filters?.category) entries = entries.filter(e => e.category === filters.category);
    if (filters?.query) {
      const q = filters.query.toLowerCase();
      entries = entries.filter(e =>
        e.displayName.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q)
      );
    }

    // Sort
    switch (filters?.sort) {
      case 'popular': entries.sort((a, b) => (b.installs || 0) - (a.installs || 0)); break;
      case 'newest': entries.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')); break;
      case 'rating': entries.sort((a, b) => (b.rating || 0) - (a.rating || 0)); break;
      case 'name': entries.sort((a, b) => a.displayName.localeCompare(b.displayName)); break;
      default: entries.sort((a, b) => (b.installs || 0) - (a.installs || 0)); break;
    }

    // Mark installed
    const installedMap = new Map((await this.getInstalled()).map(s => [s.id, s]));
    for (const entry of entries) {
      const local = installedMap.get(entry.id);
      if (local) {
        entry.installedAt = local.installedAt || new Date().toISOString();
      }
    }

    return entries;
  }

  async getSkillDetail(id: string): Promise<SkillDetailView> {
    const index = await this.fetchIndex();
    const entry = index.find(e => e.id === id);
    const installed = (await this.getInstalled()).find(s => s.id === id);
    const base = entry || installed;
    if (!base) throw new Error(`Skill not found: ${id}`);

    // Stats are now served live from the renderer via MarketplaceStatsProvider.
    // Default to undefined here — callers can layer in live stats from context.
    const override = this.configStore.getOverride(id);

    return {
      ...base,
      ...(override || {}),
      installs: undefined,
      rating: undefined,
      ratingCount: undefined,
    } as SkillDetailView;
  }

  async search(query: string): Promise<SkillEntry[]> {
    // Search installed skills first (always works offline), then merge marketplace results
    const q = query.toLowerCase();
    const installed = (await this.getInstalled()).filter(s =>
      s.displayName.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    );
    const marketplace = await this.listMarketplace({ query }).catch(() => [] as SkillEntry[]);

    const seen = new Set(installed.map(s => s.id));
    const marketplaceOnly = marketplace.filter(s => !seen.has(s.id));
    return [...installed, ...marketplaceOnly];
  }

  // --- Local state ---

  async getInstalled(): Promise<SkillEntry[]> {
    if (!this.installedCache) {
      const scanned = scanSkills();
      const privateSkills = this.configStore.getPrivateSkills();

      // Fix: scanSkills() only discovers YouCoded skills and Claude Code's
      // installed_plugins.json entries. Plugins installed via the YouCoded
      // marketplace are tracked in configStore packages — merge them so the UI
      // marks them as "Installed" and fetchAll() sees them right after install.
      //
      // Skip plugin-level placeholders for plugins whose individual skills
      // are already in `scanned` — otherwise the drawer shows both the real
      // skills AND a duplicate plugin-level card (e.g. a generic
      // "Youcoded Encyclopedia" placeholder alongside its 5 bundled skills).
      // Match on pluginName emitted by skill-scanner, which carries the
      // plugin id for each scanned skill.
      const installedPackages = this.configStore.getInstalledPlugins();
      const alreadyFoundIds = new Set([...scanned.map(s => s.id), ...privateSkills.map(s => s.id)]);
      const pluginsWithScannedSkills = new Set(
        scanned
          .map(s => s.pluginName)
          .filter((n): n is string => typeof n === 'string'),
      );
      const packageSkills: SkillEntry[] = [];
      for (const [id, pkg] of Object.entries(installedPackages) as Array<[string, any]>) {
        if (alreadyFoundIds.has(id)) continue;
        if (pluginsWithScannedSkills.has(id)) continue;
        packageSkills.push({
          id,
          displayName: id.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
          description: '',
          category: 'other',
          prompt: `/${id}`,
          source: 'marketplace',
          type: 'plugin',
          visibility: 'published',
          installedAt: pkg.installedAt,
        });
      }

      this.installedCache = [...scanned, ...privateSkills, ...packageSkills];
    }

    const overrides = this.configStore.getOverrides();
    return this.installedCache.map(skill => {
      const o = overrides[skill.id];
      if (!o) return skill;
      return { ...skill, ...o };
    });
  }

  async getFavorites(): Promise<string[]> {
    return this.configStore.getFavorites();
  }

  async getChips(): Promise<ChipConfig[]> {
    return this.configStore.getChips();
  }

  async getOverrides(): Promise<Record<string, MetadataOverride>> {
    return this.configStore.getOverrides();
  }

  // --- Mutations ---

  async install(id: string): Promise<InstallResult> {
    const index = await this.fetchIndex();
    const entry = index.find(e => e.id === id);
    if (!entry) return { status: 'failed', error: `Skill not found in marketplace: ${id}` };

    // Marketplace overhaul (spec §1.4): a skill / specialist / connection that
    // lives INSIDE a bundle is installed by installing the bundle — installing
    // one member on its own is a ROADMAP follow-up. The UI already shows a
    // member as installed once its bundle is.
    // The `parent !== id` check is a cycle guard, not paranoia: `partOf` comes
    // from a catalog built by a background job we do not control, and a row
    // pointing at itself (or a two-row loop) would recurse until the process
    // dies. One hop only — a bundle is never itself a member of something.
    const parent = entry.catalog?.partOf?.id;
    if (parent && parent !== id) {
      const bundle = index.find(e => e.id === parent);
      if (!bundle?.catalog?.partOf) return this.install(parent);
      return { status: 'failed', error: `catalog error: ${id} and ${parent} both claim to be inside another item` };
    }

    if (entry.type === 'prompt') {
      const created = this.configStore.createPromptSkill({
        ...entry,
        source: 'marketplace',
        visibility: 'published',
        installedAt: new Date().toISOString(),
      });
      // Record a package exactly as the plugin branch below does. Without this
      // packages[id] stays undefined, marketplace-context's update check hits
      // `if (!pkg) continue`, and an installed prompt could NEVER be flagged
      // out of date — the Update badge was unreachable for this whole type.
      this.configStore.recordPackageInstall(created.id, {
        version: entry.version || '1.0.0',
        source: 'marketplace',
        installedAt: new Date().toISOString(),
        removable: true,
        // A prompt lives inside youcoded-skills.json, not in a plugin
        // directory, so there is no path to record.
        components: [],
      });
      this.installedCache = null;
      this.onCacheInvalidated?.();
      return { status: 'installed', type: 'prompt' };
    }

    // Plugin install — delegate to PluginInstaller
    const marketplaceEntry = entry as any;
    const result = await installPlugin({
      id: marketplaceEntry.id,
      sourceType: marketplaceEntry.sourceType || 'unknown',
      sourceRef: marketplaceEntry.sourceRef || '',
      sourceSubdir: marketplaceEntry.sourceSubdir,
      sourceMarketplace: marketplaceEntry.sourceMarketplace,
      // Marketplace overhaul: pin to the commit the catalog scanned — and ONLY
      // that. Deliberately no `?? sourceSha` fallback: that field is a stale
      // snapshot from whenever the registry's sync job last ran (236 of the 302
      // live entries carry one), so falling back to it would freeze those
      // plugins at an old version forever and make Update a no-op that claims
      // success. No catalog block → today's behaviour (install latest).
      sourceCommit: marketplaceEntry.catalog?.sourceCommit,
      description: marketplaceEntry.description,
      author: marketplaceEntry.author,
      // WHY: this was never wired through, which left installFromLocal's
      // version-mismatch cache refresh as dead code — the cache could only
      // ever refresh on the 1 h timer, never because the marketplace index
      // bumped a version mid-window. entry.version lets a fresh install pick
      // up a just-released fix immediately instead of waiting out the gate.
      version: marketplaceEntry.version,
      // Decomposition v3 §9.5: pass through postInstall + recommends so
      // installer can run trusted-org-gated scripts / surface soft deps
      postInstall: marketplaceEntry.postInstall,
      recommends: marketplaceEntry.recommends,
    });

    if (result.status === 'installed') {
      // Phase 3a: record install as a PackageInfo with version from the marketplace
      // entry so the update flow can detect when a newer version is available.
      this.configStore.recordPackageInstall(id, {
        version: marketplaceEntry.version || '1.0.0',
        source: 'marketplace',
        installedAt: new Date().toISOString(),
        removable: true,
        // The sha the installer actually checked out (absent unless the catalog
        // pinned one). This is the installed half of the marketplace's commit
        // comparison — without it that check has no data and stays silent.
        ...(result.status === 'installed' && result.commit ? { commit: result.commit } : {}),
        components: [{
          type: 'plugin',
          // New install location under our Claude Code marketplace root —
          // required for non-cache plugin loads (/reload-plugins) to resolve.
          path: pluginInstallDir(id),
        }],
      });
      this.installedCache = null;
      this.onCacheInvalidated?.();
      // Also reconcile hooks — the newly-installed plugin may declare
      // required hooks that need to land in settings.json before the user's
      // next Claude session starts.
      try { await reconcileHooks(); } catch (e) { log('ERROR', 'SkillProvider', 'hook reconcile after install failed', { error: String(e) }); }
      // Also reconcile MCP servers — packages like youcoded-core-messaging
      // declare MCP servers that need to land in .claude.json on install.
      // reconcileMcp() is async (registry secrets decrypt via safeStorage);
      // awaited so a rejection is caught here, not left as an unhandled
      // promise rejection (install() is already async, so this is free).
      try { await reconcileMcp(); } catch (e) { log('ERROR', 'SkillProvider', 'MCP reconcile after install failed', { error: String(e) }); }
    }

    // Tag result so callers know a plugin (not prompt) was installed
    return { ...result, type: 'plugin' };
  }

  /**
   * Phase 3b: update an installed plugin by re-running the install logic with
   * the latest marketplace entry, overwriting files at the same path. Config
   * in ~/.claude/youcoded-config/<id>.json is NOT touched.
   */
  async update(id: string): Promise<{ ok: boolean; newVersion?: string; error?: string; missingRequiredFields?: string[] }> {
    const index = await this.fetchIndex();
    const entry = index.find(e => e.id === id);
    if (!entry) return { ok: false, error: `Skill not found in marketplace: ${id}` };

    const marketplaceEntry = entry as any;

    if (entry.type === 'prompt') {
      // Prompt update: overwrite the private skill entry with new content.
      // The miss used to fall straight through to updatePackageVersion and
      // return { ok: true } having rewritten nothing — a success the app had
      // not performed. Say what actually happened instead, and only move the
      // recorded version after the content really changed on disk.
      const written = this.configStore.updatePromptSkill(id, entry);
      if (!written) return { ok: false, error: `${id} is not installed as a prompt` };
      this.configStore.updatePackageVersion(id, entry.version || '1.0.0');
      this.installedCache = null;
      this.onCacheInvalidated?.();
      return { ok: true, newVersion: entry.version };
    }

    // Plugin update: re-install at the same path, overwriting files
    const result = await installPlugin({
      id: marketplaceEntry.id,
      sourceType: marketplaceEntry.sourceType || 'unknown',
      sourceRef: marketplaceEntry.sourceRef || '',
      sourceSubdir: marketplaceEntry.sourceSubdir,
      sourceMarketplace: marketplaceEntry.sourceMarketplace,
      // Same pin as install() — see the comment there for why there is no
      // `?? sourceSha` fallback.
      sourceCommit: marketplaceEntry.catalog?.sourceCommit,
      description: marketplaceEntry.description,
      author: marketplaceEntry.author,
      // Decomposition v3 §9.5: pass through postInstall + recommends so
      // installer can run trusted-org-gated scripts / surface soft deps
      postInstall: marketplaceEntry.postInstall,
      recommends: marketplaceEntry.recommends,
    });

    // Review fix (Finding 1): installPlugin's 'already_installed' status covers
    // TWO different situations that must not be treated the same. `via:
    // 'YouCoded'` means our own registry already has this plugin — safe to
    // upgrade in place. `via: 'Claude Code'` means the id exists in Claude
    // Code's installed_plugins.json under a marketplace YouCoded doesn't own —
    // we must not touch it. Before this check, the local-source branch below
    // unconditionally wrote a SECOND copy into YOUCODED_PLUGINS_DIR and
    // recorded a second registry entry for the same id (the exact ambiguity
    // SkillAmbiguous exists to complain about); the non-local branches instead
    // silently bumped the recorded version while never touching a file. Both
    // reported success for a plugin YouCoded does not manage.
    // Fix (Track B final review, Finding F4): this cast used to be `(result
    // as any).via`, which discards the discriminated-union narrowing that
    // `result.status === 'already_installed'` establishes above — InstallResult
    // already types `via` on that branch (plugin-installer.ts). With the
    // cast, renaming `via` compiled clean and `!== 'YouCoded'` silently
    // became true for EVERY already-installed plugin, refusing every
    // Settings "Update" with a message about Claude Code. Deleting the cast
    // makes tsc the guard again.
    if (result.status === 'already_installed' && result.via !== 'YouCoded') {
      return {
        ok: false,
        error: `"${id}" was installed through Claude Code, not YouCoded. YouCoded does not manage that install and will not overwrite or version-track it.`,
      };
    }

    if (result.status === 'installed' || result.status === 'already_installed') {
      const installDir = pluginInstallDir(id);
      // WHY: installPlugin's local-source path refuses to overwrite an existing
      // install (returns 'already_installed' without touching a single file —
      // see plugin-installer.ts's "Guard: already installed via YouCoded").
      // Without this, the Settings "Update" button recorded a bumped version
      // number while the on-disk plugin was untouched — a silent no-op that
      // reported success. upgradePluginFromLocal actually replaces the tree.
      // `via` is guaranteed 'YouCoded' here — the 'Claude Code' case returned above.
      let gitUpgradeCommit: string | undefined;
      if (result.status === 'already_installed' && marketplaceEntry.sourceType === 'local') {
        const upgradeResult = await upgradePluginFromLocal(id, marketplaceEntry.sourceRef || id, marketplaceEntry.sourceMarketplace);
        if (upgradeResult.status !== 'installed') {
          return { ok: false, error: (upgradeResult as any).error ?? 'Update failed' };
        }
      } else if (result.status === 'already_installed'
                 && (marketplaceEntry.sourceType === 'url' || marketplaceEntry.sourceType === 'git-subdir')) {
        // WHY: installPlugin returns 'already_installed' before it reaches any clone,
        // so without this branch Update rewrote nothing for a git-sourced plugin — 237
        // of the 302 live registry entries (measured 2026-08-31), i.e. most of the
        // store. upgradePluginFromGit clones into staging and only swaps on success,
        // so a failed update leaves the working install exactly as it was.
        const upgradeResult = await upgradePluginFromGit(marketplaceEntry);
        if (upgradeResult.status !== 'installed') {
          return { ok: false, error: (upgradeResult as any).error ?? 'Update failed' };
        }
        gitUpgradeCommit = upgradeResult.commit;
      }
      // WHY plugin.json's version, not the index's: B7 makes the index copy
      // plugin.json, so the renderer's "Update available" compare (package
      // record vs index) stays in one number space.
      const newVersion = readPluginVersion(installDir) ?? entry.version;
      // Record the new commit ONLY when installPlugin actually re-cloned
      // ('installed'). On 'already_installed' it touched no files, so writing the
      // catalog's newer sha here would clear the update badge for code that never
      // changed. (Known gap: for url / git-subdir sources 'already_installed' is
      // the normal outcome, so those updates still do nothing on disk — that is a
      // pre-existing bug tracked separately, not something this line introduces.)
      // The commit we actually landed on: from the fresh install, or from the git
      // upgrade above. Still undefined when nothing was rewritten, so a no-op can
      // never clear the update badge by recording a commit it did not check out.
      const landedCommit = result.status === 'installed' ? result.commit : gitUpgradeCommit;
      this.configStore.updatePackageVersion(id, newVersion || '1.0.0', landedCommit);
      this.installedCache = null;
      this.onCacheInvalidated?.();

      // Phase 3c: check if the new configSchema has required fields missing
      // from the existing user config. Don't block the update — just surface
      // the field names so the renderer can prompt the user.
      const missingRequiredFields = this.checkMissingConfigFields(id, entry);
      return { ok: true, newVersion, ...(missingRequiredFields.length > 0 ? { missingRequiredFields } : {}) };
    }

    return { ok: false, error: result.status === 'failed' ? (result as any).error : 'Update failed' };
  }

  /**
   * Phase 3c: compare the entry's configSchema against the user's saved config.
   * Returns names of required fields that are missing from the saved config.
   */
  private checkMissingConfigFields(id: string, entry: SkillEntry): string[] {
    const schema = (entry as any).configSchema;
    if (!schema?.fields?.length) return [];
    try {
      const config = getMarketplaceConfig(id);
      return schema.fields
        .filter((f: { required?: boolean; name: string }) => f.required && (config[f.name] === undefined || config[f.name] === ''))
        .map((f: { name: string }) => f.name);
    } catch {
      return [];
    }
  }

  /**
   * Project skills & tools uninstall cascade (technical design 2026-09-24
   * §2): write `{on:false, removed:true}` into every project record that
   * has an entry for this plugin, so "needs setup" never offers to reinstall
   * something the user deliberately removed. Best-effort and NEVER allowed
   * to fail the uninstall itself — sync-spaces may not have started yet
   * (getManagedRoots() null before startEngine runs), and a write hiccup
   * here is far less bad than an uninstall that silently didn't happen.
   */
  private async cascadePluginRemoval(pluginId: string): Promise<void> {
    const roots = getManagedRoots();
    if (!roots) return;
    try {
      await markPluginRemoved({ personalRoot: roots.personalRoot, home: new NativeHome() }, pluginId);
    } catch (e) {
      log('WARN', 'project-extensions', `markPluginRemoved(${pluginId}) failed`, { error: String((e as Error)?.message ?? e) });
    }
  }

  async uninstall(id: string): Promise<{ type: 'plugin' | 'prompt' }> {
    const installed = this.configStore.getInstalledPlugins();

    // Direct plugin-id match (e.g. marketplace card calling uninstall with
    // the plugin id).
    if (installed[id]) {
      await uninstallPlugin(id);
      this.configStore.removePluginInstall(id);
      await this.cascadePluginRemoval(id);
      this.installedCache = null;
      this.onCacheInvalidated?.();
      return { type: 'plugin' };
    }

    // Skill-granular ids like `superpowers:brainstorming` come from Library
    // skill cards. Resolve them to the parent plugin id by
    // looking up the skill in the installed cache (which carries pluginName)
    // and then uninstall that plugin. This matches the user's expectation
    // that "Uninstall" on a skill card removes the plugin shipping the skill.
    const scanned = await this.getInstalled();
    const skill = scanned.find(s => s.id === id);
    const parentPluginId = skill?.pluginName;
    if (parentPluginId && installed[parentPluginId]) {
      await uninstallPlugin(parentPluginId);
      this.configStore.removePluginInstall(parentPluginId);
      await this.cascadePluginRemoval(parentPluginId);
      this.installedCache = null;
      this.onCacheInvalidated?.();
      return { type: 'plugin' };
    }

    // Fallback: treat as a user-authored prompt skill.
    this.configStore.deletePromptSkill(id);
    this.installedCache = null;
    this.onCacheInvalidated?.();
    return { type: 'prompt' };
  }

  async setFavorite(id: string, favorited: boolean): Promise<void> {
    this.configStore.setFavorite(id, favorited);
  }

  async setChips(chips: ChipConfig[]): Promise<void> {
    this.configStore.setChips(chips);
  }

  async setOverride(id: string, override: MetadataOverride): Promise<void> {
    this.configStore.setOverride(id, override);
    this.installedCache = null;
    this.onCacheInvalidated?.();
  }

  async createPromptSkill(skill: Omit<SkillEntry, 'id'>): Promise<SkillEntry> {
    const entry = this.configStore.createPromptSkill(skill);
    this.installedCache = null;
    this.onCacheInvalidated?.();
    return entry;
  }

  async deletePromptSkill(id: string): Promise<void> {
    this.configStore.deletePromptSkill(id);
    this.installedCache = null;
    this.onCacheInvalidated?.();
  }

  // --- Sharing ---

  /**
   * Phase 4a: Publish a user-created plugin to the wecoded-marketplace repo
   * via GitHub PR. Mirrors the theme publish flow in theme-marketplace-provider.ts.
   *
   * Flow:
   * 1. Verify gh CLI auth
   * 2. Verify the skill is user-created (source 'self' or visibility 'private')
   * 3. Fork itsdestin/wecoded-marketplace (idempotent)
   * 4. Create branch, upload plugin files via GitHub Contents API
   * 5. Open PR with auto-populated description
   */
  async publish(id: string): Promise<{ prUrl: string }> {
    // Locate the plugin on disk — could be top-level (core toolkit clone)
    // or under the marketplace subtree (plugin-installer packages).
    const pluginDir = resolvePluginDir(id);
    if (!pluginDir) {
      throw new Error(`Plugin directory not found: ${id}`);
    }

    // Phase 4a: only allow publishing user-created items
    const installed = await this.getInstalled();
    const skill = installed.find(s => s.id === id);
    if (!skill) {
      throw new Error(`Skill not found: ${id}`);
    }
    if (skill.source !== 'self' && skill.visibility !== 'private') {
      throw new Error('Only user-created skills can be published to the marketplace');
    }

    const UPSTREAM_REPO = 'itsdestin/wecoded-marketplace';
    const branchName = `plugin/${id}`;

    // 1. Collect plugin files, filtering out sensitive content
    const filesToUpload: { repoPath: string; localPath: string }[] = [];
    const allFiles = await this.walkPluginDirectory(pluginDir);

    for (const absPath of allFiles) {
      const relativePath = path.relative(pluginDir, absPath).replace(/\\/g, '/');

      // Phase 4a: strip sensitive files before upload
      if (SENSITIVE_PATTERNS.some(re => re.test(relativePath))) {
        console.log(`[SkillProvider] Skipping sensitive file: ${relativePath}`);
        continue;
      }
      // Skip node_modules and .git
      if (relativePath.startsWith('node_modules/') || relativePath.startsWith('.git/')) {
        continue;
      }

      filesToUpload.push({
        repoPath: `plugins/${id}/${relativePath}`,
        localPath: absPath,
      });
    }

    if (filesToUpload.length === 0) {
      throw new Error('No files to upload (all files were filtered as sensitive)');
    }

    // 2. Base64 the contents up front. Bodies ride the REST request (Phase 3,
    // 2026-07-22) — the old `gh api -f content=<base64>` argv form silently
    // broke on Windows's ~32 KB command-line limit for any file past a few KB.
    const publishFiles: import('./github-fork-publish').PublishFile[] = [];
    for (const file of filesToUpload) {
      const raw = await fs.promises.readFile(file.localPath);
      publishFiles.push({ repoPath: file.repoPath, contentBase64: raw.toString('base64') });
    }

    // 6. Create the PR
    // 3. Fork → branch → upload → PR through the shared github-client pipeline
    // (Phase 3, 2026-07-22 — no gh CLI required; its plain-language coded
    // errors surface verbatim in the publish UI). The Author line prefers the
    // skill's own author and falls back to the authed login forkPublish
    // resolves — same behavior as the old `gh api user` call.
    const { forkPublish } = await import('./github-fork-publish');
    const result = await forkPublish({
      upstreamRepo: UPSTREAM_REPO,
      branchName,
      files: publishFiles,
      prTitle: `[Plugin] ${skill.displayName || id}`,
      prBody: (username) => [
        `## New Plugin: ${skill.displayName || id}`,
        '',
        skill.description ? `> ${skill.description}` : '',
        '',
        `- **Author:** ${skill.author || username}`,
        `- **Type:** ${skill.type || 'plugin'}`,
        `- **Category:** ${skill.category || 'other'}`,
        `- **Plugin ID:** \`${id}\``,
        '',
        `### What it does`,
        skill.description || '_No description provided_',
        '',
        `### Files`,
        filesToUpload.map(f => `- \`${f.repoPath}\``).join('\n'),
        '',
        '_Submitted via YouCoded Marketplace_',
      ].join('\n'),
    });
    return { prUrl: result.prUrl };
  }

  /** Recursively walk a plugin directory and return all file paths. */
  private async walkPluginDirectory(dir: string): Promise<string[]> {
    const results: string[] = [];
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip .git and node_modules directories
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        results.push(...await this.walkPluginDirectory(fullPath));
      } else {
        results.push(fullPath);
      }
    }
    return results;
  }

  async generateShareLink(id: string): Promise<string> {
    const installed = await this.getInstalled();
    const skill = installed.find(s => s.id === id);
    if (!skill) throw new Error(`Skill not found: ${id}`);
    if (skill.visibility === 'private') throw new Error('Cannot share a private skill');

    if (skill.type === 'prompt') {
      return encodeSkillLink({
        v: 1,
        type: 'prompt',
        displayName: skill.displayName,
        description: skill.description,
        prompt: skill.prompt,
        category: skill.category,
        author: skill.author,
      });
    } else {
      return encodeSkillLink({
        v: 1,
        type: 'plugin',
        name: skill.id,
        displayName: skill.displayName,
        description: skill.description,
        repoUrl: skill.repoUrl,
        author: skill.author,
      });
    }
  }

  async importFromLink(url: string): Promise<SkillEntry> {
    const payload = decodeSkillLink(url);
    if (!payload) throw new Error('Invalid share link');

    if (payload.type === 'prompt') {
      // Validate and sanitize input from untrusted URL
      const validCategories = ['personal', 'work', 'development', 'admin', 'other'] as const;
      const category = validCategories.includes(payload.category as typeof validCategories[number])
        ? (payload.category as SkillEntry['category'])
        : 'other';
      const displayName = String(payload.displayName || 'Imported Skill').slice(0, 100);
      const description = String(payload.description || '').slice(0, 500);
      const prompt = String(payload.prompt || '').slice(0, 2000);
      if (!prompt) throw new Error('Share link contains no prompt');

      return this.configStore.createPromptSkill({
        displayName,
        description,
        prompt,
        category,
        source: 'marketplace',
        type: 'prompt',
        visibility: 'shared',
        author: String(payload.author || '').slice(0, 100) || undefined,
        installedAt: new Date().toISOString(),
      } as Omit<SkillEntry, 'id'>);
    } else {
      throw new Error('Plugin import from link not yet implemented');
    }
  }

  // --- Migration ---

  ensureMigrated(): void {
    if (!this.configStore.configExists()) {
      const scanned = scanSkills();
      this.configStore.migrate(scanned.map(s => s.id));
    }
  }

  // Phase 4: force-refresh cached registry data. Deletes the 24h-TTL JSON
  // caches so the next fetchIndex/getFeatured call hits the network. Used
  // right after /feature curation lands — skips the 24h wait.
  async invalidateCache(): Promise<void> {
    for (const file of [CATALOG_CACHE, INDEX_CACHE, DEFAULTS_CACHE, FEATURED_CACHE]) {
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* best-effort */ }
    }
  }

  // Review fix (Finding 3): reconcileBundledPlugins() previously called the
  // broad invalidateCache() above to refetch a stale index, which also wipes
  // the marketplace's featured-rail and curated-defaults caches — unrelated
  // subsystems with their own 24h TTL. If a bundled id is ever permanently
  // absent from the index (e.g. its marketplace entry hasn't merged yet),
  // that ran on every launch, forcing a cold network fetch for the featured
  // rail and defaults on every launch too. This narrower version clears only
  // the index cache.
  async invalidateIndexCache(): Promise<void> {
    // Both listing caches, because fetchIndex reads the catalog FIRST: clearing
    // index.json alone would leave the stale catalog copy answering and the
    // refetch this method exists to force would never reach the network.
    for (const file of [CATALOG_CACHE, INDEX_CACHE]) {
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* best-effort */ }
    }
  }

  // Marketplace redesign Phase 1: new `hero` + `rails` fields drive the
  // redesigned discovery UI. Old `skills`/`themes` fields are passed through
  // unchanged so older clients keep working. 24h cache mirrors fetchIndex.
  async getFeatured(): Promise<{ hero?: any[]; rails?: any[]; skills?: any[]; themes?: any[] }> {
    try {
      const cached = this.readCache<any>(FEATURED_CACHE, INDEX_TTL);
      if (cached) return cached;
      const resp = await fetch(`${REGISTRY_BASE}/featured.json`);
      if (!resp.ok) {
        return this.readCache<any>(FEATURED_CACHE, Infinity) ?? { hero: [], rails: [] };
      }
      const data = await resp.json() as any;
      this.writeCache(FEATURED_CACHE, data);
      return data;
    } catch {
      return this.readCache<any>(FEATURED_CACHE, Infinity) ?? { hero: [], rails: [] };
    }
  }

  async getCuratedDefaults(): Promise<string[]> {
    try {
      const cached = this.readCache<string[]>(DEFAULTS_CACHE, INDEX_TTL);
      if (cached) return cached;
      const resp = await fetch(`${REGISTRY_BASE}/curated-defaults.json`);
      if (!resp.ok) {
        // Stale cache beats nothing — first-run seeding is better with slightly
        // outdated defaults than with an empty list.
        return this.readCache<string[]>(DEFAULTS_CACHE, Infinity) ?? [];
      }
      // Registry uses "skills" key (not "defaults") — see curated-defaults.json
      const data = await resp.json() as { skills: string[] };
      const list = data.skills ?? [];
      this.writeCache(DEFAULTS_CACHE, list);
      return list;
    } catch {
      return this.readCache<string[]>(DEFAULTS_CACHE, Infinity) ?? [];
    }
  }

  // --- Fetch helpers ---

  private async fetchIndex(): Promise<SkillEntry[]> {
    // 1. Fresh catalog cache.
    const cachedCatalog = this.readCache<SkillEntry[]>(CATALOG_CACHE, CATALOG_TTL);
    if (cachedCatalog) return cachedCatalog;
    // 2. The Worker's catalog. The ETag matters: this response is several MB and we
    //    ask for it every hour, so on the ~23 hours out of 24 when nothing changed
    //    the Worker answers 304 with an empty body and we keep what we already have.
    //    A 503 here is the CATALOG_ENABLED kill switch — treat it as any other failure.
    if (CATALOG_URL) {
      try {
        const prevTag = this.readCacheEtag(CATALOG_CACHE);
        const resp = await fetch(CATALOG_URL, prevTag ? { headers: { 'If-None-Match': prevTag } } : undefined);
        if (resp.status === 304) {
          const stale = this.readCache<SkillEntry[]>(CATALOG_CACHE, Infinity);
          if (stale) { this.touchCache(CATALOG_CACHE, prevTag); return stale; }
        } else if (resp.ok) {
          const body = await resp.json() as { entries?: SkillEntry[] };
          if (Array.isArray(body.entries)) {
            this.writeCache(CATALOG_CACHE, body.entries, resp.headers.get('ETag') ?? undefined);
            return body.entries;
          }
        }
      } catch { /* fall through to index.json */ }
    }
    // 3. Raw index.json on GitHub (pre-overhaul path, unchanged).
    const cached = this.readCache<SkillEntry[]>(INDEX_CACHE, INDEX_TTL);
    if (cached) return cached;
    try {
      const resp = await fetch(`${REGISTRY_BASE}/index.json`);
      if (resp.ok) {
        const data = await resp.json() as SkillEntry[];
        this.writeCache(INDEX_CACHE, data);
        return data;
      }
    } catch { /* fall through to the stale caches below */ }
    // 4. Anything stale, newest source first. Stale beats the bundled
    //    skill-registry.json — those ids are `<plugin>:<skill>` sub-skills with no
    //    sourceRef, so "Get" buttons on them wouldn't actually install anything. An
    //    empty list on a true first-run offline is the honest answer; the UI already
    //    renders "No skills found".
    return this.readCache<SkillEntry[]>(CATALOG_CACHE, Infinity)
      ?? this.readCache<SkillEntry[]>(INDEX_CACHE, Infinity)
      ?? [];
  }

  private readCache<T>(filePath: string, ttl: number): T | null {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const { fetchedAt, data } = JSON.parse(raw) as CacheMeta & { data: T };
      if (Date.now() - fetchedAt > ttl) return null;
      return data;
    } catch {
      return null;
    }
  }

  private writeCache(filePath: string, data: unknown, etag?: string): void {
    try {
      fs.writeFileSync(filePath, JSON.stringify({ fetchedAt: Date.now(), etag, data }), 'utf8');
    } catch { /* best-effort cache */ }
  }

  /** The ETag stored beside a cached body, regardless of how old the body is —
   *  a stale body is exactly when we want to ask the server "still this one?". */
  private readCacheEtag(filePath: string): string | undefined {
    try {
      return (JSON.parse(fs.readFileSync(filePath, 'utf8')) as CacheMeta).etag;
    } catch {
      return undefined;
    }
  }

  /** Reset a cache's TTL after a 304 without re-serialising megabytes of body. */
  private touchCache(filePath: string, etag?: string): void {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as CacheMeta & { data: unknown };
      fs.writeFileSync(filePath, JSON.stringify({ ...raw, fetchedAt: Date.now(), etag: etag ?? raw.etag }), 'utf8');
    } catch { /* best-effort cache */ }
  }

  /**
   * Decomposition v3 §9.9: return integration metadata for a skill id.
   *
   * For installed plugins: read plugin.json from disk (most up-to-date).
   * For non-installed skills: fall back to marketplace entry fields.
   *
   * For each optionalIntegrations entry, cross-reference against currently
   * installed `provides` so the UI can render "Integrates with X (installed)"
   * vs "Integrates with Y (not installed — install?)".
   */
  async getIntegrationInfo(id: string): Promise<{
    optionalIntegrations: Array<{
      capability: string;
      installed: boolean;
      providerPackageId?: string;
      whenAvailable?: string;
      whenUnavailable?: string;
    }>;
    provides: Array<{ capability: string; description: string; skill: string }>;
  }> {
    // Build a map of capability → providing package by scanning all installed plugin manifests.
    const providerMap = new Map<string, string>();
    for (const pluginDir of listInstalledPluginDirs()) {
      const manifest = this.readPluginManifest(pluginDir);
      if (!manifest?.provides) continue;
      for (const cap of Object.keys(manifest.provides)) {
        if (!providerMap.has(cap)) providerMap.set(cap, manifest.name);
      }
    }

    // Try installed manifest first; fall back to marketplace entry fields
    let rawProvides: Record<string, { description: string; skill: string }> = {};
    let rawOptional: Record<string, { whenAvailable: string; whenUnavailable: string }> = {};
    const pluginDir = resolvePluginDir(id);
    const manifest = pluginDir ? this.readPluginManifest(pluginDir) : null;
    if (manifest) {
      rawProvides = manifest.provides ?? {};
      rawOptional = manifest.optionalIntegrations ?? {};
    } else {
      const index = await this.fetchIndex();
      const entry = index.find(e => e.id === id) as any;
      if (entry) {
        rawProvides = entry.provides ?? {};
        rawOptional = entry.optionalIntegrations ?? {};
      }
    }

    return {
      provides: Object.entries(rawProvides).map(([capability, spec]) => ({
        capability,
        description: spec.description,
        skill: spec.skill,
      })),
      optionalIntegrations: Object.entries(rawOptional).map(([capability, spec]) => {
        const provider = providerMap.get(capability);
        return {
          capability,
          installed: !!provider,
          providerPackageId: provider,
          whenAvailable: spec.whenAvailable,
          whenUnavailable: spec.whenUnavailable,
        };
      }),
    };
  }

  private readPluginManifest(pluginDir: string): { name: string; provides?: Record<string, { description: string; skill: string }>; optionalIntegrations?: Record<string, { whenAvailable: string; whenUnavailable: string }> } | null {
    const candidates = [
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      path.join(pluginDir, 'plugin.json'),
    ];
    for (const p of candidates) {
      try {
        if (!fs.existsSync(p)) continue;
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch { continue; }
    }
    return null;
  }

  /**
   * Decomposition v3 §9.10: apply an output style by writing its id to
   * ~/.claude/youcoded-config/youcoded-core-output-styles.json. Session-start
   * reads this file and injects the corresponding style markdown into the
   * preamble. Onboarding calls this with "casual" after first-run install.
   */
  applyOutputStyle(styleId: string): void {
    const configDir = path.join(os.homedir(), '.claude', 'youcoded-config');
    fs.mkdirSync(configDir, { recursive: true });
    const configFile = path.join(configDir, 'youcoded-core-output-styles.json');
    fs.writeFileSync(configFile, JSON.stringify({ activeStyle: styleId }, null, 2));
  }

  /**
   * Decomposition v3 §9.10: bulk install for onboarding "install curated
   * defaults" button. Runs sequentially (not in parallel) to avoid git lock
   * contention on the marketplace cache clone. Continues past individual
   * failures so one broken entry doesn't block the rest.
   */
  async installMany(ids: string[]): Promise<Array<{ id: string; status: string; error?: string }>> {
    const results: Array<{ id: string; status: string; error?: string }> = [];
    for (const id of ids) {
      try {
        const r = await this.install(id);
        results.push({ id, status: r.status, error: (r as any).error });
      } catch (e: any) {
        results.push({ id, status: 'failed', error: e?.message || String(e) });
      }
    }
    return results;
  }

  /**
   * Reconcile every bundled plugin against the marketplace cache: install it
   * if missing, upgrade it if the cached plugin.json version is newer than
   * the installed one, otherwise leave it alone. Runs on every app launch —
   * unlike the old installMany()-only path, an already-installed bundled
   * plugin that ships a fix now actually reaches users who already have it.
   */
  async reconcileBundledPlugins(): Promise<Array<{ id: string; action: 'installed' | 'upgraded' | 'unchanged' | 'skipped-dev' | 'failed'; from?: string; to?: string; error?: string; via?: string }>> {
    type ReconcileAction = 'installed' | 'upgraded' | 'unchanged' | 'skipped-dev' | 'failed';
    const ids = [...BUNDLED_PLUGIN_IDS];

    // WHY: ~/.claude is shared with the live app; a run-dev.sh copy must never rewrite the real install.
    if (process.env.YOUCODED_PROFILE && process.env.YOUCODED_BUNDLED_UPGRADE !== '1') {
      return ids.map((id) => ({ id, action: 'skipped-dev' as const }));
    }

    // Fix (Track B final review, Finding F1): a real process kill mid-swap in
    // upgradePluginFromLocal() can leave `.upgrade-<id>-<pid>` (a staged copy)
    // or `.old-<id>-<pid>` (the retired tree) behind in the marketplace
    // plugins dir. listInstalledPluginDirs() no longer scans them, but
    // nothing else clears them either — sweep on every launch so a crash's
    // litter is cleared on the next launch, not left indefinitely. Placed
    // AFTER the dev-instance guard above so a dev-mode launch never mutates
    // the shared real ~/.claude install. Matches Android's
    // LocalSkillProvider.sweepStaleUpgradeDirs() call site (Task B5 review
    // round 2, Finding 1b).
    sweepStaleUpgradeDirs();

    let index = await this.fetchIndex();
    // Review fix (Finding 3): refetch the index at most once per process,
    // and invalidate only the index cache — not the broad invalidateCache().
    // A bundled id can be PERMANENTLY missing (its marketplace entry hasn't
    // merged yet), and this method runs once per launch: the old code would
    // re-invalidate every launch and wipe the marketplace's featured-rail and
    // curated-defaults caches too (unrelated subsystems, own 24h TTL),
    // forcing a cold network refetch of both on every single launch.
    if (!this.bundledIndexRefetchDone && ids.some((id) => !index.find((e) => e.id === id))) {
      this.bundledIndexRefetchDone = true;
      // WHY: a newly bundled plugin isn't in a day-old cached index; refetch once, only for this case.
      await this.invalidateIndexCache();
      index = await this.fetchIndex();
    }

    // Review fix (Finding 2): refresh once per DISTINCT marketplace among the
    // bundled entries actually found in the index, reading sourceMarketplace
    // off each entry instead of hardcoding 'youcoded'. Today every bundled id
    // happens to share one marketplace, so this is one call — but the compare
    // below (marketplaceCacheDir) now also reads the entry's own marketplace,
    // so a future entry from a different marketplace needs ITS cache
    // refreshed too, not just 'youcoded'. Per-distinct-marketplace (not
    // per-id) avoids refreshing the same repo N times in one pass; the 1h
    // gate inside refreshLocalMarketplaceCache would make a per-id call cheap
    // too, but grouping is one fewer thing to reason about.
    const marketplaces = new Set(ids.map((id) => index.find((e) => e.id === id)?.sourceMarketplace ?? 'youcoded'));
    for (const mp of marketplaces) {
      const refreshed = await refreshLocalMarketplaceCache(mp);
      if (!refreshed.ok) {
        log('WARN', 'bundled-plugins', 'marketplace cache refresh failed; comparing against the last copy', { marketplace: mp, error: refreshed.error });
      }
    }

    const out: Array<{ id: string; action: ReconcileAction; from?: string; to?: string; error?: string; via?: string }> = [];
    for (const id of ids) {
      const entry = index.find((e) => e.id === id);
      if (!entry) {
        out.push({ id, action: 'failed', error: `not in the marketplace index (${index.length} entries)` });
        continue;
      }

      const sourceRef = entry.sourceRef || id;
      const mp = entry.sourceMarketplace ?? 'youcoded';
      const installDir = pluginInstallDir(id);

      if (!isPluginInstalled(id)) {
        // Review fix (Finding 6): install() (above) also passes sourceSubdir,
        // postInstall, and recommends through to installPlugin. This call was
        // missing all three — a fresh bundled install silently skipped the
        // trusted-org postInstall script, and would have broken outright for
        // a git-subdir-sourced bundled entry (sourceSubdir dropped).
        const r = await installPlugin({
          id,
          sourceType: entry.sourceType || 'local',
          sourceRef,
          sourceSubdir: entry.sourceSubdir,
          sourceMarketplace: mp,
          description: entry.description,
          author: entry.author,
          version: entry.version,
          // Not on the SkillEntry type (they're PluginManifest/index-runtime
          // fields, not declared on the marketplace-entry shape) — install()
          // above reaches them the same way, via an `any` cast.
          postInstall: (entry as any).postInstall,
          recommends: (entry as any).recommends,
        });
        if (r.status !== 'installed') {
          // Review fix (Finding 8): r.status is a status token ('installing'),
          // not a message — fall back to a readable sentence, not the token.
          //
          // Fix (Track B final review, Finding F9): guard order is identical
          // to update()'s (hasConflict() before the disk-install guard), so a
          // Claude-Code-owned bundled id lands here on EVERY launch with
          // status: 'already_installed', via: 'Claude Code' — a permanent,
          // expected, non-actionable state, not a bug in our reconcile. The
          // old code reported the raw status token as a generic failure and
          // logged it at ERROR forever. Carry `via` through so
          // ensureBundledPluginsInstalled (below) can log this case at WARN
          // with the same real-cause sentence update() already states.
          const via = r.status === 'already_installed' ? r.via : undefined;
          out.push({
            id,
            action: 'failed',
            via,
            error: via === 'Claude Code'
              ? `"${id}" was installed through Claude Code, not YouCoded. YouCoded does not manage that install and will not overwrite or version-track it.`
              : (r as any).error ?? `install did not complete (status: ${r.status})`,
          });
          continue;
        }

        // WHY plugin.json's version, not the index's: B7 makes the index copy
        // plugin.json, so the renderer's "Update available" compare (package
        // record vs index) stays in one number space.
        //
        // Fix (Track B final review, Finding F3): readPluginVersion() returning
        // null does NOT only mean an unreadable manifest — ensurePluginJson()
        // (plugin-installer.ts, run inside installPlugin() just above) writes
        // a synthetic manifest with {name, description, author} and NO
        // version field whenever the plugin's own tree ships neither
        // plugin.json nor .claude-plugin/plugin.json. That is a perfectly
        // readable manifest that legitimately has no version. The old code
        // reported 'failed' here regardless — which skipped
        // recordPackageInstall, which in turn made reconcileBundledPlugins
        // gate `results.some(installed || upgraded)` false, so
        // reconcileHooks()/reconcileMcp() never ran for a plugin that WAS on
        // disk and registered. On the next launch isPluginInstalled(id) is
        // true and `installed` reads as undefined forever, so
        // isNewerVersion() never fires — the plugin becomes silently
        // unmanaged. Fall back to the marketplace entry's version (the same
        // fallback installPlugin()'s own registerPluginInstall call already
        // uses), record the install, and log which specific manifest state
        // was observed instead of guessing.
        const diskVersion = readPluginVersion(installDir);
        const version = diskVersion ?? entry.version;
        if (!version) {
          // Neither the manifest nor the marketplace entry has a version —
          // nothing to fall back to. This IS a real failure.
          out.push({ id, action: 'failed', error: `installed, but no version is available: ${describeManifestVersionState(installDir)}, and the marketplace entry has none either` });
          continue;
        }
        if (!diskVersion) {
          log('WARN', 'bundled-plugins', `falling back to the marketplace entry's version — ${describeManifestVersionState(installDir)}`, { id, installDir, fallbackVersion: version });
        }

        this.configStore.recordPackageInstall(id, {
          version,
          source: 'marketplace',
          installedAt: new Date().toISOString(),
          removable: true,
          components: [{ type: 'plugin', path: installDir }],
        });
        this.installedCache = null;
        this.onCacheInvalidated?.();
        out.push({ id, action: 'installed', to: version });
        continue;
      }

      // Review fix (Finding 2): read the cache copy through the same helper
      // plugin-installer.ts itself uses (marketplaceCacheDir), instead of
      // hand-building the path. The hand-built path hardcoded
      // 'wecoded-marketplace' — for any entry whose sourceMarketplace ever
      // differed, this would have silently pointed at a directory that
      // doesn't exist, `available` would come back null, and this id would
      // report 'unchanged' forever with no error at all.
      const installed = readPluginVersion(installDir);
      const available = readPluginVersion(marketplaceCacheDir(mp, sourceRef));
      if (!isNewerVersion(installed ?? undefined, available ?? undefined)) {
        out.push({ id, action: 'unchanged', from: installed ?? undefined });
        continue;
      }

      const r = await upgradePluginFromLocal(id, sourceRef, mp);
      if (r.status !== 'installed') {
        out.push({ id, action: 'failed', from: installed ?? undefined, to: available ?? undefined, error: (r as any).error ?? `upgrade did not complete (status: ${r.status})` });
        continue;
      }

      // `available` is guaranteed a real version string by this point:
      // isNewerVersion() above only returns true when both `installed` and
      // `available` are non-empty strings — so recording it here can't fall
      // through to a synthetic '1.0.0' (Finding 9's same anti-pattern).
      this.configStore.updatePackageVersion(id, available as string);
      this.installedCache = null;
      this.onCacheInvalidated?.();
      out.push({ id, action: 'upgraded', from: installed ?? undefined, to: available ?? undefined });
    }
    return out;
  }

  /**
   * Reconcile bundled plugins on every app launch: install missing ones,
   * upgrade stale ones. Never rejects — main.ts calls this fire-and-forget
   * at boot and a thrown error here must not block startup.
   */
  async ensureBundledPluginsInstalled(): Promise<void> {
    try {
      const results = await this.reconcileBundledPlugins();
      for (const r of results) {
        if (r.action !== 'unchanged' && r.action !== 'skipped-dev') {
          // Fix (Track B final review, Finding F9): a Claude-Code-owned
          // bundled id (via: 'Claude Code') is an expected, permanent,
          // non-actionable conflict — not a defect in our reconcile — so it
          // logs at WARN, not ERROR every single launch.
          const level = r.action === 'failed' ? (r.via === 'Claude Code' ? 'WARN' : 'ERROR') : 'INFO';
          log(level, 'bundled-plugins', r.action, r);
        }
      }
      if (results.some((r) => r.action === 'installed' || r.action === 'upgraded')) {
        // Review fix (Finding 5): these were `catch {}`. The identical
        // failures ARE logged at ERROR everywhere else install() reconciles
        // hooks/MCP (see install(), above). As written, a bundled plugin
        // could be upgraded on disk while its hooks/MCP config never lands in
        // settings.json, with nothing in the log to say so — reusing those
        // catch bodies verbatim here.
        try {
          await reconcileHooks();
        } catch (e) {
          log('ERROR', 'SkillProvider', 'hook reconcile after install failed', { error: String(e) });
        }
        try {
          await reconcileMcp();
        } catch (e) {
          log('ERROR', 'SkillProvider', 'MCP reconcile after install failed', { error: String(e) });
        }
      }
    } catch (err) {
      log('ERROR', 'bundled-plugins', 'reconcile failed', { error: String(err) });
    }
  }

  /**
   * Fix (Track B final review, Finding F2): B7 made the marketplace index
   * copy each entry's own plugin.json version instead of a separately
   * maintained index-only number, so the renderer's "Update available"
   * badge compares one number space. On the first rebuild after B7 every
   * in-repo `local` plugin's index version moved DOWN to match its real
   * plugin.json (e.g. civic-report 1.0.2 -> 0.1.0) — correct, and no false
   * "Update available" badge appears.
   *
   * The cost is the mirror image: reconcileBundledPlugins() only walks the
   * THREE bundled ids, so only their package records get rewritten to the
   * disk version on launch. Every OTHER tracked package (nine in-repo
   * plugins today) keeps its old, now-permanently-stale, HIGHER recorded
   * version forever — the next real version bump can never look newer than
   * that stale number, so isNewerVersion() never fires and the user is never
   * told an update exists.
   *
   * Disk is the source of truth for this entire branch — this repairs every
   * tracked package's record to match its on-disk plugin.json once per
   * launch, not just the bundled three. Idempotent (a no-op once the record
   * already matches disk), so running it every launch is cheap and safe.
   * Guarded end-to-end and per-package so one bad record can't throw out of
   * the launch path or block the rest.
   */
  async repairPackageVersions(): Promise<Array<{ id: string; from: string; to: string }>> {
    // WHY: this.configStore writes to ~/.claude/youcoded-skills.json — the
    // SAME real, shared file reconcileBundledPlugins()'s dev-instance guard
    // above exists to protect. Without this guard, a run-dev.sh copy would
    // silently rewrite package-version records in Destin's live app's config
    // the moment this runs, for every tracked package (not just the three
    // bundled ones the other guard limits itself to) — reusing the same
    // escape hatch (YOUCODED_BUNDLED_UPGRADE=1) rather than inventing a
    // second one for what is the same class of shared-state write.
    if (process.env.YOUCODED_PROFILE && process.env.YOUCODED_BUNDLED_UPGRADE !== '1') {
      return [];
    }
    const repaired: Array<{ id: string; from: string; to: string }> = [];
    try {
      const packages = this.configStore.getPackages();
      for (const [id, pkg] of Object.entries(packages)) {
        try {
          // Non-plugin packages (prompt skills, themes) have no plugin.json
          // to compare against — nothing to repair.
          const pluginComponent = pkg.components.find((c) => c.type === 'plugin');
          if (!pluginComponent) continue;
          let diskVersion = readPluginVersion(pluginComponent.path);
          // WHY: the legacy v1->v2 migration writer (skill-config-store.ts's
          // migrateV1toV2) defaults a record's component path to
          // ~/.claude/plugins/<id> when the old config had no installPath —
          // a path that does not exist for a marketplace-installed plugin.
          // Without this fallback such a record's diskVersion reads null
          // forever, so it hits the `continue` below and stays stale
          // permanently — exactly the case this function exists to fix.
          // resolvePluginDir also checks the marketplace subtree, so this
          // recovers the real on-disk version for those legacy records.
          if (!diskVersion) {
            const fallbackDir = resolvePluginDir(id);
            if (fallbackDir) diskVersion = readPluginVersion(fallbackDir);
          }
          if (!diskVersion || diskVersion === pkg.version) continue;
          // WHY: getPackages() hands back the LIVE config objects, and
          // updatePackageVersion mutates pkg.version in place — so reading
          // pkg.version after the write reports the new value as the old one,
          // and the log's "from" would always equal its "to". Capture it first
          // or the repair log silently claims nothing changed.
          const from = pkg.version;
          this.configStore.updatePackageVersion(id, diskVersion);
          repaired.push({ id, from, to: diskVersion });
        } catch (err) {
          log('WARN', 'bundled-plugins', 'package version repair failed for one package', { id, error: String(err) });
        }
      }
      if (repaired.length > 0) {
        log('INFO', 'bundled-plugins', 'repaired stale package-record versions from disk', { repaired });
      }
    } catch (err) {
      // WHY: called fire-and-forget at boot alongside ensureBundledPluginsInstalled()
      // — must never throw out of the launch path.
      log('ERROR', 'bundled-plugins', 'package version repair failed', { error: String(err) });
    }
    return repaired;
  }
}
