import fs from 'fs';
import path from 'path';
import os from 'os';
import type { UserSkillConfig, ChipConfig, MetadataOverride, SkillEntry } from '../shared/types';

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
    version: 1,
    favorites: existingSkillIds,
    chips: DEFAULT_CHIPS,
    overrides: {},
    privateSkills: [],
  };
}

export class SkillConfigStore {
  private config: UserSkillConfig | null = null;

  load(): UserSkillConfig {
    if (this.config) return this.config;
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      this.config = JSON.parse(raw) as UserSkillConfig;
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

  // --- Installed Plugins (marketplace) ---

  getInstalledPlugins(): Record<string, any> {
    const config = this.load() as any;
    return config.installed_plugins || {};
  }

  recordPluginInstall(id: string, meta: Record<string, any>): void {
    const config = this.load() as any;
    if (!config.installed_plugins) config.installed_plugins = {};
    config.installed_plugins[id] = meta;
    this.save();
  }

  removePluginInstall(id: string): void {
    const config = this.load() as any;
    if (config.installed_plugins) {
      delete config.installed_plugins[id];
    }
    // Cascade cleanup
    config.favorites = config.favorites.filter((f: string) => f !== id);
    config.chips = config.chips.filter((c: any) => c.skillId !== id);
    delete config.overrides[id];
    this.save();
  }

  /** Force reload from disk (useful after external changes) */
  reload(): UserSkillConfig {
    this.config = null;
    return this.load();
  }
}
