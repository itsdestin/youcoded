import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { scanSkills } from './skill-scanner';
import { SkillConfigStore } from './skill-config-store';
import { encodeSkillLink, decodeSkillLink } from './skill-share';
import { installPlugin, uninstallPlugin, isPluginInstalled, type InstallResult } from './plugin-installer';
import { getConfig as getMarketplaceConfig } from './marketplace-config-store';
import type {
  SkillEntry, SkillDetailView, SkillFilters, ChipConfig,
  MetadataOverride, SkillProvider,
} from '../shared/types';

const execFileAsync = promisify(execFile);

// Resolve gh CLI path at module load (mirrors theme-marketplace-provider.ts)
let ghPath = 'gh';
try { const w = require('which'); ghPath = w.sync('gh'); } catch { /* use bare 'gh' */ }

const PLUGINS_DIR = path.join(os.homedir(), '.claude', 'plugins');

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
  // Phase 3a: made public so ThemeMarketplaceProvider can share the same
  // destincode-skills.json packages map and marketplace IPC can read it
  public configStore = new SkillConfigStore();
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

      // Fix: scanSkills() only discovers DestinClaude skills and Claude Code's
      // installed_plugins.json entries. Plugins installed via the DestinCode
      // marketplace are tracked in configStore packages — merge them so the UI
      // marks them as "Installed" and fetchAll() sees them right after install.
      const installedPackages = this.configStore.getInstalledPlugins();
      const alreadyFound = new Set([...scanned.map(s => s.id), ...privateSkills.map(s => s.id)]);
      const packageSkills: SkillEntry[] = [];
      for (const [id, pkg] of Object.entries(installedPackages) as Array<[string, any]>) {
        if (alreadyFound.has(id)) continue;
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

    if (entry.type === 'prompt') {
      this.configStore.createPromptSkill({
        ...entry,
        source: 'marketplace',
        visibility: 'published',
        installedAt: new Date().toISOString(),
      });
      this.installedCache = null;
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
      description: marketplaceEntry.description,
      author: marketplaceEntry.author,
    });

    if (result.status === 'installed') {
      // Phase 3a: record install as a PackageInfo with version from the marketplace
      // entry so the update flow can detect when a newer version is available.
      this.configStore.recordPackageInstall(id, {
        version: marketplaceEntry.version || '1.0.0',
        source: 'marketplace',
        installedAt: new Date().toISOString(),
        removable: true,
        components: [{
          type: 'plugin',
          path: path.join(os.homedir(), '.claude', 'plugins', id),
        }],
      });
      this.installedCache = null;
    }

    // Tag result so callers know a plugin (not prompt) was installed
    return { ...result, type: 'plugin' };
  }

  /**
   * Phase 3b: update an installed plugin by re-running the install logic with
   * the latest marketplace entry, overwriting files at the same path. Config
   * in ~/.claude/destincode-config/<id>.json is NOT touched.
   */
  async update(id: string): Promise<{ ok: boolean; newVersion?: string; error?: string; missingRequiredFields?: string[] }> {
    const index = await this.fetchIndex();
    const entry = index.find(e => e.id === id);
    if (!entry) return { ok: false, error: `Skill not found in marketplace: ${id}` };

    const marketplaceEntry = entry as any;

    if (entry.type === 'prompt') {
      // Prompt update: overwrite the private skill entry with new content
      const config = this.configStore.load();
      const idx = config.privateSkills.findIndex(s => s.id === id);
      if (idx >= 0) {
        config.privateSkills[idx] = { ...config.privateSkills[idx], ...entry, id };
      }
      this.configStore.updatePackageVersion(id, entry.version || '1.0.0');
      this.installedCache = null;
      return { ok: true, newVersion: entry.version };
    }

    // Plugin update: re-install at the same path, overwriting files
    const result = await installPlugin({
      id: marketplaceEntry.id,
      sourceType: marketplaceEntry.sourceType || 'unknown',
      sourceRef: marketplaceEntry.sourceRef || '',
      sourceSubdir: marketplaceEntry.sourceSubdir,
      sourceMarketplace: marketplaceEntry.sourceMarketplace,
      description: marketplaceEntry.description,
      author: marketplaceEntry.author,
    });

    if (result.status === 'installed' || result.status === 'already_installed') {
      this.configStore.updatePackageVersion(id, entry.version || '1.0.0');
      this.installedCache = null;

      // Phase 3c: check if the new configSchema has required fields missing
      // from the existing user config. Don't block the update — just surface
      // the field names so the renderer can prompt the user.
      const missingRequiredFields = this.checkMissingConfigFields(id, entry);
      return { ok: true, newVersion: entry.version, ...(missingRequiredFields.length > 0 ? { missingRequiredFields } : {}) };
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

  async uninstall(id: string): Promise<{ type: 'plugin' | 'prompt' }> {
    // Check if this is a marketplace-installed plugin
    const installed = this.configStore.getInstalledPlugins();
    if (installed[id]) {
      await uninstallPlugin(id);
      this.configStore.removePluginInstall(id);
      this.installedCache = null;
      return { type: 'plugin' };
    } else {
      this.configStore.deletePromptSkill(id);
      this.installedCache = null;
      return { type: 'prompt' };
    }
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

  /**
   * Phase 4a: Publish a user-created plugin to the destincode-marketplace repo
   * via GitHub PR. Mirrors the theme publish flow in theme-marketplace-provider.ts.
   *
   * Flow:
   * 1. Verify gh CLI auth
   * 2. Verify the skill is user-created (source 'self' or visibility 'private')
   * 3. Fork itsdestin/destincode-marketplace (idempotent)
   * 4. Create branch, upload plugin files via GitHub Contents API
   * 5. Open PR with auto-populated description
   */
  async publish(id: string): Promise<{ prUrl: string }> {
    // Locate the plugin on disk
    const pluginDir = path.join(PLUGINS_DIR, id);
    if (!fs.existsSync(pluginDir)) {
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

    // 1. Verify gh CLI auth
    let username: string;
    try {
      const { stdout } = await execFileAsync(ghPath, ['api', 'user', '--jq', '.login']);
      username = stdout.trim();
      if (!username) throw new Error('Empty username');
    } catch {
      throw new Error('GitHub CLI not authenticated. Run `gh auth login` first.');
    }

    const UPSTREAM_REPO = 'itsdestin/destincode-marketplace';
    const branchName = `plugin/${id}`;

    // 2. Fork the marketplace repo (idempotent — gh returns existing fork)
    try {
      await execFileAsync(ghPath, ['repo', 'fork', UPSTREAM_REPO, '--clone=false'], { timeout: 30000 });
    } catch (err: any) {
      if (err.code === 'ENOENT') throw new Error('gh CLI not found');
      // gh repo fork returns exit 0 even if fork exists; only throw on real errors
    }

    const FORK_REPO = `${username}/destincode-marketplace`;

    // 3. Get the default branch SHA from upstream
    let baseSha: string;
    try {
      const { stdout } = await execFileAsync(ghPath, [
        'api', `repos/${UPSTREAM_REPO}/git/ref/heads/main`, '--jq', '.object.sha',
      ]);
      baseSha = stdout.trim();
    } catch {
      throw new Error('Failed to read upstream repo. Does itsdestin/destincode-marketplace exist?');
    }

    // Create branch on the fork (or update if it already exists)
    try {
      await execFileAsync(ghPath, [
        'api', `repos/${FORK_REPO}/git/refs`, '-X', 'POST',
        '-f', `ref=refs/heads/${branchName}`,
        '-f', `sha=${baseSha}`,
      ]);
    } catch {
      try {
        await execFileAsync(ghPath, [
          'api', `repos/${FORK_REPO}/git/refs/heads/${branchName}`, '-X', 'PATCH',
          '-f', `sha=${baseSha}`, '-f', 'force=true',
        ]);
      } catch (err: any) {
        throw new Error(`Failed to create branch: ${err.message}`);
      }
    }

    // 4. Collect plugin files, filtering out sensitive content
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

    // 5. Upload files via GitHub Contents API
    for (const file of filesToUpload) {
      const raw = await fs.promises.readFile(file.localPath);
      const content = raw.toString('base64');

      try {
        await execFileAsync(ghPath, [
          'api', `repos/${FORK_REPO}/contents/${file.repoPath}`, '-X', 'PUT',
          '-f', `message=Add ${file.repoPath}`,
          '-f', `content=${content}`,
          '-f', `branch=${branchName}`,
        ], { timeout: 30000 });
      } catch {
        // File may already exist — update it (need the sha)
        try {
          const { stdout: existingFile } = await execFileAsync(ghPath, [
            'api', `repos/${FORK_REPO}/contents/${file.repoPath}`,
            '-q', '.sha', '-H', 'Accept: application/vnd.github.v3+json',
            '--method', 'GET', '-f', `ref=${branchName}`,
          ]);
          await execFileAsync(ghPath, [
            'api', `repos/${FORK_REPO}/contents/${file.repoPath}`, '-X', 'PUT',
            '-f', `message=Update ${file.repoPath}`,
            '-f', `content=${content}`,
            '-f', `sha=${existingFile.trim()}`,
            '-f', `branch=${branchName}`,
          ], { timeout: 30000 });
        } catch {
          throw new Error(`Failed to upload ${file.repoPath}`);
        }
      }
    }

    // 6. Create the PR
    const prTitle = `[Plugin] ${skill.displayName || id}`;
    const prBody = [
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
      '_Submitted via DestinCode Marketplace_',
    ].join('\n');

    try {
      const { stdout: prUrlRaw } = await execFileAsync(ghPath, [
        'pr', 'create',
        '--repo', UPSTREAM_REPO,
        '--head', `${username}:${branchName}`,
        '--title', prTitle,
        '--body', prBody,
      ], { timeout: 30000 });
      return { prUrl: prUrlRaw.trim() };
    } catch (err: any) {
      // If PR already exists, try to get its URL
      if (err.stderr?.includes('already exists')) {
        try {
          const { stdout: existingPr } = await execFileAsync(ghPath, [
            'pr', 'list',
            '--repo', UPSTREAM_REPO,
            '--head', `${username}:${branchName}`,
            '--json', 'url', '--jq', '.[0].url',
          ]);
          if (existingPr.trim()) {
            return { prUrl: existingPr.trim() };
          }
        } catch { /* fall through */ }
      }
      throw new Error(`Failed to create PR: ${err.stderr || err.message}`);
    }
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
