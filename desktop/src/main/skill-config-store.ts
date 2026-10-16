import fs from 'fs';
import path from 'path';
import os from 'os';
import type { UserSkillConfig, ChipConfig, MetadataOverride, SkillEntry, PackageInfo } from '../shared/types';

const CONFIG_PATH = path.join(os.homedir(), '.claude', 'youcoded-skills.json');

// Per-writer counter for save()'s temp filename — see the comment there.
let tmpSeq = 0;

// The built-in theme slugs (YouCoded pair first), seeded as favorites on first-read so a new user
// sees a populated Appearance panel. Mirrors the skill-favorites seeding in
// createDefaultConfig. Must stay in sync with BUILTIN_THEMES in theme-context.tsx.
const DEFAULT_THEME_FAVORITES = ['youcoded', 'youcoded-night', 'light', 'dark', 'midnight', 'creme'];

const DEFAULT_CHIPS: ChipConfig[] = [
  { skillId: 'journaling-assistant', label: 'Journal', prompt: "let's journal" },
  { skillId: 'claudes-inbox', label: 'Inbox', prompt: 'check my inbox' },
  { label: 'Git Status', prompt: "run git status and summarize what's changed" },
  { label: 'Review PR', prompt: 'review the latest PR on this repo' },
  { label: 'Fix Tests', prompt: 'run the tests and fix any failures' },
  { skillId: 'encyclopedia-librarian', label: 'Briefing', prompt: 'brief me on ' },
  { label: 'Draft Text', prompt: 'help me draft a text to ' },
];

function createDefaultConfig(existingSkillIds: string[]): UserSkillConfig {
  return {
    version: 2,
    favorites: existingSkillIds,
    chips: DEFAULT_CHIPS,
    overrides: {},
    privateSkills: [],
    packages: {},
  };
}

// Migrate v1 config to v2: convert installed_plugins to packages
function migrateV1toV2(config: any): UserSkillConfig {
  const installed = config.installed_plugins || {};
  const packages: Record<string, PackageInfo> = {};

  for (const [id, meta] of Object.entries(installed)) {
    const m = meta as any;
    packages[id] = {
      version: '1.0.0',
      source: 'marketplace',
      installedAt: m.installedAt || new Date().toISOString(),
      removable: true,
      components: [{
        type: 'plugin',
        path: m.installPath || path.join(os.homedir(), '.claude', 'plugins', id),
      }],
    };
  }

  // Remove old field, set new version
  delete config.installed_plugins;
  config.version = 2;
  config.packages = packages;
  return config as UserSkillConfig;
}

// Favourite ids that never named anything and were only ever written by a
// registry mistake. `curated-defaults.json` once listed `theme-builder`; the
// real id is `wecoded-themes-plugin` (`theme-builder` is a skill INSIDE it,
// keyed `wecoded-themes-plugin:theme-builder`). First-run seeding wrote the
// bare string straight into `favorites[]`, where it resolves to nothing — an
// invisible favourite that survives every launch. The registry is fixed; this
// is the one-time cleanup of profiles that already carry it.
const DEAD_FAVORITE_IDS = ['theme-builder'];

/** Drop a dead favourite from an existing profile. Returns true when something
 *  was removed, so the caller can persist exactly once and never rewrite a
 *  clean file (idempotent: a second load finds nothing to do).
 *
 *  Deliberately narrow: only the listed ids, only from `favorites`, and NOT
 *  when the id is something the user actually has — a package or a private
 *  skill by that name is theirs, not the registry's typo. */
function pruneDeadFavorites(config: UserSkillConfig): boolean {
  if (!Array.isArray(config.favorites)) return false;
  const owned = new Set<string>([
    ...Object.keys(config.packages ?? {}),
    ...(config.privateSkills ?? []).map((s) => s?.id).filter((id): id is string => typeof id === 'string'),
  ]);
  const dead = DEAD_FAVORITE_IDS.filter((id) => !owned.has(id));
  const kept = config.favorites.filter((f) => !dead.includes(f));
  if (kept.length === config.favorites.length) return false;
  config.favorites = kept;
  return true;
}

export class SkillConfigStore {
  private config: UserSkillConfig | null = null;

  load(): UserSkillConfig {
    if (this.config) return this.config;
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      let parsed = JSON.parse(raw);

      // Auto-migrate v1 → v2: convert installed_plugins to packages
      if (!parsed.version || parsed.version === 1) {
        parsed = migrateV1toV2(parsed);
        this.config = parsed as UserSkillConfig;
        this.save(); // Persist the migration
      } else {
        this.config = parsed as UserSkillConfig;
        // Ensure packages field exists even on v2 configs created before this field
        if (!this.config.packages) this.config.packages = {};
      }

      // Phase 6 monolith-layer migration removed: decomposition-v3 is a clean
      // break (plan §9.1). The packages map is now authoritative; hook-,
      // integration-, and mcp-reconciler populate runtime state from
      // filesystem manifests on launch instead of a one-time migration.

      if (pruneDeadFavorites(this.config)) this.save();

      return this.config;
    } catch (err) {
      // If file exists but is corrupt, back it up before resetting
      if (fs.existsSync(CONFIG_PATH)) {
        console.error('[SkillConfigStore] Corrupt config, backing up:', err);
        try {
          fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak');
        } catch { /* best-effort backup */ }
      }
      return this.migrate([]);
    }
  }

  /** First-run migration: create config with all existing skills as favorites */
  migrate(existingSkillIds: string[]): UserSkillConfig {
    this.config = createDefaultConfig(existingSkillIds);
    this.save();
    return this.config;
  }

  private save(): void {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Atomic write: write to a temp file, then rename over the target.
    //
    // The temp name must be UNIQUE PER WRITER, not a fixed `<file>.tmp`.
    // A shared name is atomic against a crash but NOT against a second writer:
    // both write the same temp path, the first rename consumes it, and the
    // second throws ENOENT renaming a file that no longer exists. That is
    // reachable in production because `~/.claude/` is shared — run-dev.sh
    // isolates userData and ports but NOT the home dir, so a dev instance and
    // the installed app are two live writers of this exact file. It first
    // showed up as a cross-file failure in the test suite, whose parallel
    // workers are the same shape.
    // Matches the convention already used by mcp-reconciler.ts,
    // hook-reconciler.ts, saved-folders.ts, and transcript-mirror.ts. The
    // counter covers workers that share a pid (vitest's thread pool).
    const tmpPath = `${CONFIG_PATH}.${process.pid}.${++tmpSeq}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.config, null, 2), 'utf8');
    fs.renameSync(tmpPath, CONFIG_PATH);
  }

  configExists(): boolean {
    return fs.existsSync(CONFIG_PATH);
  }

  getFavorites(): string[] {
    return this.load().favorites;
  }

  setFavorite(id: string, favorited: boolean): void {
    const config = this.load();
    const set = new Set(config.favorites);
    if (favorited) set.add(id); else set.delete(id);
    config.favorites = [...set];
    this.save();
  }

  getThemeFavorites(): string[] {
    const config = this.load();
    // Lazy seed on first access. Config written back in the same call so the
    // seed survives even if the caller never mutates. We only seed when the
    // key is missing — an empty array is a legitimate user state (they
    // unstarred everything) and must be preserved.
    if (config.themeFavorites === undefined) {
      config.themeFavorites = [...DEFAULT_THEME_FAVORITES];
      this.save();
    }
    return config.themeFavorites;
  }

  setThemeFavorite(slug: string, favorited: boolean): void {
    const config = this.load();
    const current = config.themeFavorites ?? [...DEFAULT_THEME_FAVORITES];
    const set = new Set(current);
    if (favorited) set.add(slug); else set.delete(slug);
    config.themeFavorites = [...set];
    this.save();
  }

  getChips(): ChipConfig[] {
    return this.load().chips;
  }

  setChips(chips: ChipConfig[]): void {
    const config = this.load();
    config.chips = chips.slice(0, 10); // max 10 chips
    this.save();
  }

  getOverrides(): Record<string, MetadataOverride> {
    return this.load().overrides;
  }

  getOverride(id: string): MetadataOverride | null {
    return this.load().overrides[id] || null;
  }

  setOverride(id: string, override: MetadataOverride): void {
    const config = this.load();
    config.overrides[id] = override;
    this.save();
  }

  getPrivateSkills(): SkillEntry[] {
    return this.load().privateSkills;
  }

  // A marketplace prompt must keep its MARKETPLACE id: update() looks the row
  // up by that id, so a minted `user:` one would make every refresh a no-op.
  // That already happened to work — `{ id, ...skill }` spread the caller's id
  // last, so it silently won — but only by accident of property order, which a
  // tidy-up would have quietly broken. It is deliberate now. Hand-made prompts
  // (Settings, share links) pass no id and keep the generated one.
  createPromptSkill(skill: Omit<SkillEntry, 'id'> & { id?: string }): SkillEntry {
    const config = this.load();
    if (config.privateSkills.length >= 100) {
      throw new Error('Maximum of 100 private prompt shortcuts reached');
    }
    const id = skill.id ?? `user:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry: SkillEntry = { ...skill, id };
    config.privateSkills.push(entry);
    this.save();
    return entry;
  }

  /** Overwrite an installed prompt's content in place, keeping its id.
   *  Returns false when no row with that id exists — the caller MUST NOT
   *  report success in that case (see LocalSkillProvider.update). */
  updatePromptSkill(id: string, patch: Partial<SkillEntry>): boolean {
    const config = this.load();
    const idx = config.privateSkills.findIndex(s => s.id === id);
    if (idx < 0) return false;
    config.privateSkills[idx] = { ...config.privateSkills[idx], ...patch, id };
    this.save();
    return true;
  }

  deletePromptSkill(id: string): void {
    const config = this.load();
    config.privateSkills = config.privateSkills.filter(s => s.id !== id);
    // Also remove from favorites and chips
    config.favorites = config.favorites.filter(f => f !== id);
    config.chips = config.chips.filter(c => c.skillId !== id);
    delete config.overrides[id];
    // …and the package record. A marketplace-installed prompt now records one
    // (so the Update badge can light); leaving it behind after an uninstall
    // would keep counting a ghost item in the Library's "Updates" tab.
    if (config.packages) delete config.packages[id];
    this.save();
  }

  // --- Packages (unified marketplace tracking, replaces installed_plugins) ---

  getPackages(): Record<string, PackageInfo> {
    return this.load().packages || {};
  }

  getPackage(id: string): PackageInfo | null {
    return this.getPackages()[id] || null;
  }

  /**
   * Decomposition v3 §9.8: after cross-device sync, a package may be tracked
   * in config but not yet present on disk (e.g., Android just pulled a
   * desktop config). Return packages with status computed against actual
   * disk presence — "installed" when the plugin directory exists, "pending"
   * when only config references it. Lets the UI show an Install CTA for
   * pending packages without lying about what's actually available.
   */
  getPackagesWithStatus(): Record<string, PackageInfo> {
    const packages = this.getPackages();
    const result: Record<string, PackageInfo> = {};
    for (const [id, pkg] of Object.entries(packages)) {
      const pluginComponent = pkg.components.find(c => c.type === 'plugin');
      let onDisk = true;
      if (pluginComponent) {
        try { onDisk = fs.existsSync(pluginComponent.path); } catch { onDisk = false; }
      }
      result[id] = { ...pkg, status: onDisk ? 'installed' : 'pending' };
    }
    return result;
  }

  recordPackageInstall(id: string, pkg: PackageInfo): void {
    const config = this.load();
    if (!config.packages) config.packages = {};
    config.packages[id] = pkg;
    this.save();
  }

  // Phase 3b: update just the version field after a successful update.
  // Does NOT touch components, config, or other metadata.
  // Marketplace overhaul Task 17: `commit` moves with it, but ONLY when the
  // caller actually replaced the files on disk. Recording a new commit for an
  // update that changed nothing would clear the "update available" badge while
  // the old code is still installed — the same silent lie the local-source
  // upgrade path was fixed for. Omitting the argument leaves the stored commit
  // untouched rather than erasing it.
  updatePackageVersion(id: string, newVersion: string, commit?: string): void {
    const config = this.load();
    const pkg = config.packages?.[id];
    if (!pkg) return;
    pkg.version = newVersion;
    if (commit) pkg.commit = commit;
    this.save();
  }

  removePackage(id: string): void {
    const config = this.load();
    if (config.packages) {
      delete config.packages[id];
    }
    // Cascade cleanup — remove from favorites, chips, overrides
    config.favorites = config.favorites.filter(f => f !== id);
    config.chips = config.chips.filter(c => c.skillId !== id);
    delete config.overrides[id];
    // Built-in theme slugs (light/dark/midnight/creme) cannot be uninstalled via
    // marketplace, so no package key like `theme:light` will ever arrive here.
    // If that invariant changes (e.g., built-ins become uninstallable), revisit
    // whether we want to strip seeded defaults from favorites on uninstall.
    if (id.startsWith('theme:') && config.themeFavorites) {
      const slug = id.slice('theme:'.length);
      config.themeFavorites = config.themeFavorites.filter(s => s !== slug);
    }
    this.save();
  }

  // --- Legacy API (wraps packages for backwards compat with callers) ---

  getInstalledPlugins(): Record<string, any> {
    // Return packages that have a plugin component, shaped like old installed_plugins
    const packages = this.getPackages();
    const result: Record<string, any> = {};
    for (const [id, pkg] of Object.entries(packages)) {
      const pluginComponent = pkg.components.find(c => c.type === 'plugin');
      if (pluginComponent) {
        result[id] = {
          ...pkg,
          installPath: pluginComponent.path,
        };
      }
    }
    return result;
  }

  recordPluginInstall(id: string, meta: Record<string, any>): void {
    // Bridge old callers to new packages API
    this.recordPackageInstall(id, {
      version: '1.0.0',
      source: 'marketplace',
      installedAt: meta.installedAt || new Date().toISOString(),
      removable: true,
      components: [{
        type: 'plugin',
        path: meta.installPath || path.join(os.homedir(), '.claude', 'plugins', id),
      }],
    });
  }

  removePluginInstall(id: string): void {
    this.removePackage(id);
  }

  /** Force reload from disk (useful after external changes) */
  reload(): UserSkillConfig {
    this.config = null;
    return this.load();
  }
}
