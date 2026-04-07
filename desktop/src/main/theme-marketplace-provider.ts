import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type {
  ThemeRegistryIndex,
  ThemeRegistryEntry,
  ThemeMarketplaceFilters,
  ThemeRegistryEntryWithStatus,
} from '../shared/theme-marketplace-types';
import { THEMES_DIR } from './theme-watcher';
import { generateThemePreview } from './theme-preview-generator';

const execFileAsync = promisify(execFile);

// Resolve gh CLI path at module load
let ghPath = 'gh';
try { const w = require('which'); ghPath = w.sync('gh'); } catch { /* use bare 'gh' */ }

// Registry is fetched from this URL (GitHub Pages or raw GitHub)
const REGISTRY_URL =
  'https://raw.githubusercontent.com/itsdestin/destinclaude-themes/main/registry/theme-registry.json';

// Local cache for offline use
const CACHE_DIR = path.join(os.homedir(), '.claude', 'destincode-cache');
const CACHE_PATH = path.join(CACHE_DIR, 'theme-registry.json');
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Max total download size per theme (10 MB)
const MAX_THEME_SIZE_BYTES = 10 * 1024 * 1024;

// Slug must be kebab-case: lowercase letters, digits, hyphens only
const SAFE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class ThemeMarketplaceProvider {
  private cachedIndex: ThemeRegistryIndex | null = null;
  private cacheTimestamp = 0;

  /** Fetch registry (with cache), apply filters, annotate install status. */
  async listThemes(filters?: ThemeMarketplaceFilters): Promise<ThemeRegistryEntryWithStatus[]> {
    const index = await this.fetchRegistry();
    let themes = index.themes;

    // Apply filters
    if (filters?.source && filters.source !== 'all') {
      themes = themes.filter(t => t.source === filters.source);
    }
    if (filters?.mode && filters.mode !== 'all') {
      const wantDark = filters.mode === 'dark';
      themes = themes.filter(t => t.dark === wantDark);
    }
    if (filters?.features && filters.features.length > 0) {
      const wanted = new Set(filters.features);
      themes = themes.filter(t => t.features.some(f => wanted.has(f)));
    }
    if (filters?.query) {
      const q = filters.query.toLowerCase();
      themes = themes.filter(t =>
        t.name.toLowerCase().includes(q) ||
        t.author.toLowerCase().includes(q) ||
        (t.description?.toLowerCase().includes(q) ?? false),
      );
    }

    // Sort
    if (filters?.sort === 'name') {
      themes = [...themes].sort((a, b) => a.name.localeCompare(b.name));
    } else {
      // Default: newest first
      themes = [...themes].sort((a, b) =>
        (b.created ?? '').localeCompare(a.created ?? ''),
      );
    }

    // Annotate with install status
    return themes.map(t => ({
      ...t,
      installed: this.isInstalled(t.slug),
    }));
  }

  /** Get a single theme's detail from the registry. */
  async getThemeDetail(slug: string): Promise<ThemeRegistryEntryWithStatus | null> {
    const index = await this.fetchRegistry();
    const entry = index.themes.find(t => t.slug === slug);
    if (!entry) return null;
    return { ...entry, installed: this.isInstalled(slug) };
  }

  /**
   * Install a theme from the marketplace.
   * Downloads manifest.json + assets, validates, sanitizes CSS, writes to disk.
   */
  async installTheme(slug: string): Promise<{ status: 'installed' | 'failed'; error?: string }> {
    try {
      // Validate slug
      if (!SAFE_SLUG_RE.test(slug)) {
        return { status: 'failed', error: 'Invalid theme slug' };
      }

      // Get registry entry
      const index = await this.fetchRegistry();
      const entry = index.themes.find(t => t.slug === slug);
      if (!entry) {
        return { status: 'failed', error: 'Theme not found in registry' };
      }

      // Download manifest
      const manifestRes = await fetch(entry.manifestUrl);
      if (!manifestRes.ok) {
        return { status: 'failed', error: `Failed to download manifest: ${manifestRes.status}` };
      }
      const manifestText = await manifestRes.text();

      // Validate + sanitize (imports sanitizeCSS for community themes)
      const { validateCommunityTheme } = await import('../renderer/themes/theme-validator');
      const theme = validateCommunityTheme(JSON.parse(manifestText));

      // Inject source: 'community' into the manifest
      const manifestWithSource = { ...theme, source: 'community' };

      // Create theme directory
      const themeDir = path.join(THEMES_DIR, slug);
      const assetsDir = path.join(themeDir, 'assets');
      await fs.promises.mkdir(assetsDir, { recursive: true });

      // Download assets (with size tracking)
      let totalBytes = Buffer.byteLength(JSON.stringify(manifestWithSource));

      if (entry.assetUrls) {
        for (const [relativePath, url] of Object.entries(entry.assetUrls)) {
          // Validate relative path (no path traversal)
          const resolved = path.resolve(themeDir, relativePath);
          if (!resolved.startsWith(themeDir + path.sep)) {
            return { status: 'failed', error: `Invalid asset path: ${relativePath}` };
          }

          const assetRes = await fetch(url);
          if (!assetRes.ok) {
            return { status: 'failed', error: `Failed to download asset ${relativePath}: ${assetRes.status}` };
          }

          const buffer = Buffer.from(await assetRes.arrayBuffer());
          totalBytes += buffer.length;

          if (totalBytes > MAX_THEME_SIZE_BYTES) {
            // Cleanup partial download
            await fs.promises.rm(themeDir, { recursive: true, force: true });
            return { status: 'failed', error: 'Theme exceeds 10MB size limit' };
          }

          // Ensure subdirectory exists
          await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
          await fs.promises.writeFile(resolved, buffer);
        }
      }

      // Write manifest last (theme-watcher triggers on manifest.json presence)
      await fs.promises.writeFile(
        path.join(themeDir, 'manifest.json'),
        JSON.stringify(manifestWithSource, null, 2),
        'utf-8',
      );

      return { status: 'installed' };
    } catch (err: any) {
      return { status: 'failed', error: err?.message ?? 'Unknown error' };
    }
  }

  /**
   * Uninstall a community theme. Refuses to delete user-created themes.
   */
  async uninstallTheme(slug: string): Promise<{ status: 'uninstalled' | 'failed'; error?: string }> {
    try {
      if (!SAFE_SLUG_RE.test(slug)) {
        return { status: 'failed', error: 'Invalid theme slug' };
      }

      const themeDir = path.join(THEMES_DIR, slug);
      const manifestPath = path.join(themeDir, 'manifest.json');

      if (!fs.existsSync(manifestPath)) {
        return { status: 'failed', error: 'Theme not found on disk' };
      }

      // Read manifest and verify it's a community theme
      const raw = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));
      if (raw.source !== 'community') {
        return { status: 'failed', error: 'Cannot uninstall non-community themes via marketplace' };
      }

      await fs.promises.rm(themeDir, { recursive: true, force: true });
      return { status: 'uninstalled' };
    } catch (err: any) {
      return { status: 'failed', error: err?.message ?? 'Unknown error' };
    }
  }

  /**
   * Publish a user theme to the destinclaude-themes repo via GitHub PR.
   * Requires `gh` CLI to be authenticated.
   *
   * Flow:
   * 1. Verify gh auth
   * 2. Fork itsdestin/destinclaude-themes (idempotent — gh handles existing forks)
   * 3. Create a branch, commit theme files, push, and open a PR
   */
  async publishTheme(slug: string): Promise<{ prUrl: string }> {
    if (!SAFE_SLUG_RE.test(slug)) {
      throw new Error('Invalid theme slug');
    }

    const themeDir = path.join(THEMES_DIR, slug);
    const manifestPath = path.join(themeDir, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
      throw new Error('Theme not found on disk');
    }

    // Verify the theme is a user theme (not community-installed)
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));
    if (manifest.source === 'community') {
      throw new Error('Cannot publish a theme installed from the marketplace');
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

    const UPSTREAM_REPO = 'itsdestin/destinclaude-themes';
    const branchName = `theme/${slug}`;

    // 2. Fork the themes repo (idempotent — gh returns existing fork)
    try {
      await execFileAsync(ghPath, ['repo', 'fork', UPSTREAM_REPO, '--clone=false'], { timeout: 30000 });
    } catch (err: any) {
      // gh repo fork returns exit code 0 even if fork exists; only throw on real errors
      if (err.code === 'ENOENT') throw new Error('gh CLI not found');
    }

    const FORK_REPO = `${username}/destinclaude-themes`;

    // 3. Use the GitHub API to create/update files on a branch
    // First, get the default branch SHA
    let baseSha: string;
    try {
      const { stdout } = await execFileAsync(ghPath, [
        'api', `repos/${UPSTREAM_REPO}/git/ref/heads/main`, '--jq', '.object.sha',
      ]);
      baseSha = stdout.trim();
    } catch {
      throw new Error('Failed to read upstream repo. Does itsdestin/destinclaude-themes exist?');
    }

    // Create the branch on the fork
    try {
      await execFileAsync(ghPath, [
        'api', `repos/${FORK_REPO}/git/refs`, '-X', 'POST',
        '-f', `ref=refs/heads/${branchName}`,
        '-f', `sha=${baseSha}`,
      ]);
    } catch {
      // Branch may already exist — try to update it
      try {
        await execFileAsync(ghPath, [
          'api', `repos/${FORK_REPO}/git/refs/heads/${branchName}`, '-X', 'PATCH',
          '-f', `sha=${baseSha}`, '-f', 'force=true',
        ]);
      } catch (err: any) {
        throw new Error(`Failed to create branch: ${err.message}`);
      }
    }

    // 4. Generate preview image
    try {
      await generateThemePreview(themeDir, manifest);
    } catch (err: any) {
      console.warn('[ThemeMarketplace] Preview generation failed (continuing without):', err.message);
    }

    // 5. Collect all theme files (manifest + assets + preview)
    const filesToUpload: { repoPath: string; localPath: string; binary: boolean }[] = [];

    // Add manifest.json (strip source field for the PR — reviewer decides)
    const cleanManifest = { ...manifest };
    delete cleanManifest.source;
    delete cleanManifest.basePath;
    filesToUpload.push({
      repoPath: `themes/${slug}/manifest.json`,
      localPath: manifestPath,
      binary: false,
    });

    // Add all assets
    const assetsDir = path.join(themeDir, 'assets');
    if (fs.existsSync(assetsDir)) {
      const assetFiles = await this.walkDirectory(assetsDir);
      for (const absPath of assetFiles) {
        const relativePath = path.relative(themeDir, absPath).replace(/\\/g, '/');
        filesToUpload.push({
          repoPath: `themes/${slug}/${relativePath}`,
          localPath: absPath,
          binary: !absPath.endsWith('.json') && !absPath.endsWith('.svg') && !absPath.endsWith('.css'),
        });
      }
    }

    // Add preview.png if it was generated
    const previewPath = path.join(themeDir, 'preview.png');
    if (fs.existsSync(previewPath)) {
      filesToUpload.push({
        repoPath: `themes/${slug}/preview.png`,
        localPath: previewPath,
        binary: true,
      });
    }

    // 6. Upload files via GitHub Contents API
    for (const file of filesToUpload) {
      let content: string;
      if (file.repoPath.endsWith('manifest.json') && file.localPath === manifestPath) {
        // Use the cleaned manifest
        content = Buffer.from(JSON.stringify(cleanManifest, null, 2)).toString('base64');
      } else {
        const raw = await fs.promises.readFile(file.localPath);
        content = raw.toString('base64');
      }

      try {
        await execFileAsync(ghPath, [
          'api', `repos/${FORK_REPO}/contents/${file.repoPath}`, '-X', 'PUT',
          '-f', `message=Add ${file.repoPath}`,
          '-f', `content=${content}`,
          '-f', `branch=${branchName}`,
        ], { timeout: 30000 });
      } catch (err: any) {
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
    const prTitle = `[Theme] ${manifest.name || slug}`;
    const prBody = [
      `## New Theme: ${manifest.name || slug}`,
      '',
      manifest.description ? `> ${manifest.description}` : '',
      '',
      `- **Author:** ${manifest.author || username}`,
      `- **Mode:** ${manifest.dark ? 'Dark' : 'Light'}`,
      `- **Slug:** \`${slug}\``,
      '',
      '_Submitted via DestinCode Theme Marketplace_',
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

  /** Recursively walk a directory and return all file paths. */
  private async walkDirectory(dir: string): Promise<string[]> {
    const results: string[] = [];
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...await this.walkDirectory(fullPath));
      } else {
        results.push(fullPath);
      }
    }
    return results;
  }

  /** Check if a community theme is installed locally. */
  isInstalled(slug: string): boolean {
    try {
      const manifestPath = path.join(THEMES_DIR, slug, 'manifest.json');
      return fs.existsSync(manifestPath);
    } catch {
      return false;
    }
  }

  // --- Internal ---

  private async fetchRegistry(): Promise<ThemeRegistryIndex> {
    // Return in-memory cache if fresh
    if (this.cachedIndex && Date.now() - this.cacheTimestamp < CACHE_TTL_MS) {
      return this.cachedIndex;
    }

    // Try fetching from remote
    try {
      const res = await fetch(REGISTRY_URL);
      if (res.ok) {
        const index: ThemeRegistryIndex = await res.json();
        this.cachedIndex = index;
        this.cacheTimestamp = Date.now();
        // Write to disk cache (async, fire-and-forget)
        this.writeDiskCache(index);
        return index;
      }
    } catch {
      // Network error — fall through to disk cache
    }

    // Fall back to disk cache
    const diskCache = this.readDiskCache();
    if (diskCache) {
      this.cachedIndex = diskCache;
      this.cacheTimestamp = Date.now();
      return diskCache;
    }

    // No cache at all — return empty registry
    return { version: 0, generatedAt: '', themes: [] };
  }

  private readDiskCache(): ThemeRegistryIndex | null {
    try {
      const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private async writeDiskCache(index: ThemeRegistryIndex): Promise<void> {
    try {
      await fs.promises.mkdir(CACHE_DIR, { recursive: true });
      await fs.promises.writeFile(CACHE_PATH, JSON.stringify(index), 'utf-8');
    } catch {
      // Non-critical — continue without caching
    }
  }
}
