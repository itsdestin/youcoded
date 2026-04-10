import fs from 'fs';
import path from 'path';
import os from 'os';
import { scanSkills } from './skill-scanner';
import { SkillConfigStore } from './skill-config-store';
import { encodeSkillLink, decodeSkillLink } from './skill-share';
import { installPlugin, uninstallPlugin, isPluginInstalled, type InstallResult } from './plugin-installer';
import type {
  SkillEntry, SkillDetailView, SkillFilters, ChipConfig,
  MetadataOverride, SkillProvider,
} from '../shared/types';

const CACHE_DIR = path.join(os.homedir(), '.claude', 'destincode-marketplace-cache');
const INDEX_CACHE = path.join(CACHE_DIR, 'index.json');
const STATS_CACHE = path.join(CACHE_DIR, 'stats.json');
const DEFAULTS_CACHE = path.join(CACHE_DIR, 'curated-defaults.json');

// GitHub raw content base URL — set this to your marketplace repo
const REGISTRY_BASE = 'https://raw.githubusercontent.com/itsdestin/destincode-marketplace/master';

const STATS_TTL = 60 * 60 * 1000;    // 1 hour
const INDEX_TTL = 24 * 60 * 60 * 1000; // 24 hours

interface CacheMeta { fetchedAt: number; }

export class LocalSkillProvider implements SkillProvider {
  private configStore = new SkillConfigStore();
  private installedCache: SkillEntry[] | null = null;

  constructor() {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  // --- Discovery ---

  async listMarketplace(filters?: SkillFilters): Promise<SkillEntry[]> {
    let entries = await this.fetchIndex();
    const stats = await this.fetchStats();

    // Merge stats
    for (const entry of entries) {
      const s = stats[entry.id];
      if (s) {
        entry.installs = s.installs;
        entry.rating = s.rating;
        entry.ratingCount = s.ratingCount;
      }
    }

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

    const stats = await this.fetchStats();
    const s = stats[id];

    const override = this.configStore.getOverride(id);

    return {
      ...base,
      ...(override || {}),
      installs: s?.installs,
      rating: s?.rating,
      ratingCount: s?.ratingCount,
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
      this.installedCache = [...scanned, ...privateSkills];
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

    if (entry.type === 'prompt') {
      this.configStore.createPromptSkill({
        ...entry,
        source: 'marketplace',
        visibility: 'published',
        installedAt: new Date().toISOString(),
      });
      this.installedCache = null;
      return { status: 'installed' };
    }

    // Plugin install — delegate to PluginInstaller
    const marketplaceEntry = entry as any;
    const result = await installPlugin({
      id: marketplaceEntry.id,
      sourceType: marketplaceEntry.sourceType || 'unknown',
      sourceRef: marketplaceEntry.sourceRef || '',
      sourceSubdir: marketplaceEntry.sourceSubdir,
      sourceMarketplace: marketplaceEntry.sourceMarketplace,
      description: marketplaceEntry.description,
      author: marketplaceEntry.author,
    });

    if (result.status === 'installed') {
      // Record in config store
      this.configStore.recordPluginInstall(id, {
        installedAt: new Date().toISOString(),
        installedFrom: marketplaceEntry.sourceMarketplace || 'unknown',
        installPath: path.join(os.homedir(), '.claude', 'plugins', id),
        sourceType: marketplaceEntry.sourceType,
        sourceRef: marketplaceEntry.sourceRef,
      });
      this.installedCache = null;
    }

    return result;
  }

  async uninstall(id: string): Promise<void> {
    // Check if this is a marketplace-installed plugin
    const installed = this.configStore.getInstalledPlugins();
    if (installed[id]) {
      await uninstallPlugin(id);
      this.configStore.removePluginInstall(id);
    } else {
      this.configStore.deletePromptSkill(id);
    }
    this.installedCache = null;
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
  }

  async createPromptSkill(skill: Omit<SkillEntry, 'id'>): Promise<SkillEntry> {
    const entry = this.configStore.createPromptSkill(skill);
    this.installedCache = null;
    return entry;
  }

  async deletePromptSkill(id: string): Promise<void> {
    this.configStore.deletePromptSkill(id);
    this.installedCache = null;
  }

  // --- Sharing ---

  async publish(_id: string): Promise<{ prUrl: string }> {
    throw new Error('Publishing not yet implemented — requires GitHub auth');
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

  async getCuratedDefaults(): Promise<string[]> {
    try {
      const cached = this.readCache<string[]>(DEFAULTS_CACHE, INDEX_TTL);
      if (cached) return cached;
      const resp = await fetch(`${REGISTRY_BASE}/curated-defaults.json`);
      if (!resp.ok) return this.getFallbackDefaults();
      // Registry uses "skills" key (not "defaults") — see curated-defaults.json
      const data = await resp.json() as { skills: string[] };
      const list = data.skills ?? [];
      this.writeCache(DEFAULTS_CACHE, list);
      return list;
    } catch {
      return this.getFallbackDefaults();
    }
  }

  private getFallbackDefaults(): string[] {
    try {
      const registryPath = path.join(__dirname, '..', 'renderer', 'data', 'skill-registry.json');
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      return Object.keys(registry);
    } catch {
      return [];
    }
  }

  // --- Fetch helpers ---

  private async fetchIndex(): Promise<SkillEntry[]> {
    const cached = this.readCache<SkillEntry[]>(INDEX_CACHE, INDEX_TTL);
    if (cached) return cached;
    try {
      const resp = await fetch(`${REGISTRY_BASE}/index.json`);
      if (!resp.ok) return this.readCache<SkillEntry[]>(INDEX_CACHE, Infinity) || this.getBundledIndex();
      const data = await resp.json() as SkillEntry[];
      this.writeCache(INDEX_CACHE, data);
      return data;
    } catch {
      return this.readCache<SkillEntry[]>(INDEX_CACHE, Infinity) || this.getBundledIndex();
    }
  }

  /** Convert bundled skill-registry.json into SkillEntry[] for offline marketplace fallback */
  private getBundledIndex(): SkillEntry[] {
    try {
      const registryPath = path.join(__dirname, '..', 'renderer', 'data', 'skill-registry.json');
      const registry: Record<string, Omit<SkillEntry, 'id'>> = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      return Object.entries(registry).map(([id, meta]) => ({
        id,
        ...meta,
        type: (meta as any).type || 'plugin',
        visibility: (meta as any).visibility || 'published',
      } as SkillEntry));
    } catch {
      return [];
    }
  }

  private async fetchStats(): Promise<Record<string, { installs?: number; rating?: number; ratingCount?: number }>> {
    const cached = this.readCache<Record<string, { installs?: number; rating?: number; ratingCount?: number }>>(STATS_CACHE, STATS_TTL);
    if (cached) return cached;
    try {
      const resp = await fetch(`${REGISTRY_BASE}/stats.json`);
      if (!resp.ok) return {};
      const data = await resp.json() as { skills: Record<string, { installs?: number; rating?: number; ratingCount?: number }> };
      this.writeCache(STATS_CACHE, data.skills);
      return data.skills;
    } catch {
      return this.readCache<Record<string, { installs?: number; rating?: number; ratingCount?: number }>>(STATS_CACHE, Infinity) || {};
    }
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

  private writeCache(filePath: string, data: unknown): void {
    try {
      fs.writeFileSync(filePath, JSON.stringify({ fetchedAt: Date.now(), data }), 'utf8');
    } catch { /* best-effort cache */ }
  }
}
