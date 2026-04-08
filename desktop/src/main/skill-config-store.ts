import fs from 'fs';
import path from 'path';
import os from 'os';
import type { UserSkillConfig, ChipConfig, MetadataOverride, SkillEntry, PackageInfo } from '../shared/types';

const CONFIG_PATH = path.join(os.homedir(), '.claude', 'destincode-skills.json');

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
        return this.config;
      }

      this.config = parsed as UserSkillConfig;
      // Ensure packages field exists even on v2 configs created before this field
      if (!this.config.packages) this.config.packages = {};
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
    // Atomic write: write to temp file then rename to prevent corruption on crash
    const tmpPath = CONFIG_PATH + '.tmp';
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

  createPromptSkill(skill: Omit<SkillEntry, 'id'>): SkillEntry {
    const config = this.load();
    if (config.privateSkills.length >= 100) {
      throw new Error('Maximum of 100 private prompt shortcuts reached');
    }
    const id = `user:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry: SkillEntry = { id, ...skill };
    config.privateSkills.push(entry);
    this.save();
    return entry;
  }

  deletePromptSkill(id: string): void {
    const config = this.load();
    config.privateSkills = config.privateSkills.filter(s => s.id !== id);
    // Also remove from favorites and chips
    config.favorites = config.favorites.filter(f => f !== id);
    config.chips = config.chips.filter(c => c.skillId !== id);
    delete config.overrides[id];
    this.save();
  }

  // --- Packages (unified marketplace tracking, replaces installed_plugins) ---

  getPackages(): Record<string, PackageInfo> {
    return this.load().packages || {};
  }

  getPackage(id: string): PackageInfo | null {
    return this.getPackages()[id] || null;
  }

  recordPackageInstall(id: string, pkg: PackageInfo): void {
    const config = this.load();
    if (!config.packages) config.packages = {};
    config.packages[id] = pkg;
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
