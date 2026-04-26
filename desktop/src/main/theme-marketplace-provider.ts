import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import type {
  ThemeRegistryIndex,
  ThemeRegistryEntry,
  ThemeMarketplaceFilters,
  ThemeRegistryEntryWithStatus,
} from '../shared/theme-marketplace-types';
import { THEMES_DIR, listUserThemes, userThemeManifest } from './theme-watcher';
import { synthesizeLocalThemeEntries, type LocalThemeRecord } from './local-theme-synthesizer';
import { generateThemePreview } from './theme-preview-generator';
import { SkillConfigStore } from './skill-config-store';

const execFileAsync = promisify(execFile);

// Resolve gh CLI path at module load
let ghPath = 'gh';
try { const w = require('which'); ghPath = w.sync('gh'); } catch { /* use bare 'gh' */ }

// Registry is fetched from this URL (GitHub Pages or raw GitHub)
const REGISTRY_URL =
  'https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/registry/theme-registry.json';

// Local cache for offline use
const CACHE_DIR = path.join(os.homedir(), '.claude', 'youcoded-cache');
const CACHE_PATH = path.join(CACHE_DIR, 'theme-registry.json');
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Max total download size per theme (10 MB)
const MAX_THEME_SIZE_BYTES = 10 * 1024 * 1024;

// Max size per individual file when publishing. Matches the wecoded-themes
// CI rule — any file over this will be rejected at PR review anyway, so we
// surface it as a clear pre-flight error instead of a cryptic mid-upload failure.
const MAX_PUBLISH_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Invoke `gh api ... --input -` with a JSON body piped via stdin.
 *
 * Why: passing large base64 asset content as `-f content=<base64>` args blows
 * past Windows's ~32 KB argv limit for any file more than a few KB, and the
 * failure surfaces as an opaque "Failed to upload". Stdin has no length limit,
 * so this bypasses the whole class of argv-length bugs.
 */
function ghApiWithBody(ghBin: string, args: string[], body: string, timeoutMs = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ghBin, [...args, '--input', '-'], { timeout: timeoutMs });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`gh api exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
    proc.stdin?.end(body);
  });
}

// Slug must be kebab-case: lowercase letters, digits, hyphens only
const SAFE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** True when the theme's preview.png exists and was last modified at or
 * after the manifest.json was last modified. Used by publishTheme() to
 * avoid regenerating a preview that the /theme-builder skill (or a
 * previous publisher run) just produced. The mtime comparison is `>=`
 * not `>` because manifest and preview can be written close enough in
 * time to land on the same millisecond — strict greater-than would
 * needlessly regenerate in that case. */
export function isPreviewFresh(themeDir: string): boolean {
  const previewPath = path.join(themeDir, 'preview.png');
  const manifestPath = path.join(themeDir, 'manifest.json');
  try {
    if (!fs.existsSync(previewPath) || !fs.existsSync(manifestPath)) return false;
    return fs.statSync(previewPath).mtimeMs >= fs.statSync(manifestPath).mtimeMs;
  } catch {
    return false;
  }
}

export class ThemeMarketplaceProvider {
  private cachedIndex: ThemeRegistryIndex | null = null;
  private cacheTimestamp = 0;
  // Phase 3a: optional config store for unified package tracking across
  // skills + themes. Passed by ipc-handlers so we write to the same
  // youcoded-skills.json "packages" map.
  private configStore: SkillConfigStore | null = null;

  constructor(configStore?: SkillConfigStore) {
    this.configStore = configStore ?? null;
  }

  /** Drop the in-memory registry cache so the next list/detail call refetches. */
  invalidateRegistryCache(): void {
    this.cachedIndex = null;
    this.cacheTimestamp = 0;
  }

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
    const marketplaceEntries = themes.map(t => ({
      ...t,
      installed: this.isInstalled(t.slug),
    }));

    // Merge in local user themes (built via /theme-builder, never published).
    // Any on-disk theme not in the marketplace list becomes a synthesized local entry.
    // listUserThemes() returns slug strings only — we read each manifest here.
    const localRecords: LocalThemeRecord[] = [];
    try {
      for (const slug of listUserThemes()) {
        try {
          const manifestPath = userThemeManifest(slug);
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          const previewPath = path.join(THEMES_DIR, slug, 'preview.png');
          localRecords.push({
            slug,
            manifest,
            hasPreview: fs.existsSync(previewPath),
          });
        } catch (err) {
          console.warn(`[ThemeMarketplace] Skipping local theme ${slug}: failed to read manifest:`, err);
        }
      }
    } catch (err) {
      console.warn('[ThemeMarketplace] Failed to enumerate local themes:', err);
    }

    return synthesizeLocalThemeEntries(marketplaceEntries, localRecords);
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

      // Phase 3a: record install in unified packages map for version tracking.
      // Key by slug so the marketplace UI can look up install state alongside
      // skill packages. Theme ids in the unified packages map are prefixed
      // "theme:" to avoid collisions with skill ids.
      if (this.configStore) {
        try {
          this.configStore.recordPackageInstall(`theme:${slug}`, {
            version: entry.version || '1.0.0',
            source: 'marketplace',
            installedAt: new Date().toISOString(),
            removable: true,
            components: [{
              type: 'theme',
              path: themeDir,
            }],
          });
        } catch (recordErr) {
          // Non-fatal — log and continue. The theme is still on disk.
          console.warn('[ThemeMarketplace] Failed to record package install:', recordErr);
        }
      }

      return { status: 'installed' };
    } catch (err: any) {
      return { status: 'failed', error: err?.message ?? 'Unknown error' };
    }
  }

  /**
   * Phase 3b: update a theme by re-downloading from registry, overwriting
   * files at the same slug path. Config in ~/.claude/youcoded-config/ is
   * NOT touched. Returns the new version on success.
   */
  async updateTheme(slug: string): Promise<{ ok: boolean; newVersion?: string; error?: string }> {
    // Re-install overwrites everything at the same path
    const result = await this.installTheme(slug);
    if (result.status === 'failed') {
      return { ok: false, error: result.error };
    }
    // installTheme already called recordPackageInstall with the latest version.
    // Read back the version from registry for the response.
    const index = await this.fetchRegistry();
    const entry = index.themes.find(t => t.slug === slug);
    return { ok: true, newVersion: entry?.version };
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

      // Phase 3a: mirror install — remove package entry when uninstalling
      if (this.configStore) {
        try {
          this.configStore.removePackage(`theme:${slug}`);
        } catch (removeErr) {
          console.warn('[ThemeMarketplace] Failed to remove package entry:', removeErr);
        }
      }

      return { status: 'uninstalled' };
    } catch (err: any) {
      return { status: 'failed', error: err?.message ?? 'Unknown error' };
    }
  }

  /**
   * Publish a user theme to the wecoded-themes repo via GitHub PR.
   * Requires `gh` CLI to be authenticated.
   *
   * Flow:
   * 1. Verify gh auth
   * 2. Fork itsdestin/wecoded-themes (idempotent — gh handles existing forks)
   * 3. Create a branch, commit theme files, push, and open a PR
   */
  async publishTheme(
    slug: string,
    opts: { existingEntry?: ThemeRegistryEntry } = {},
  ): Promise<{ prUrl: string; prNumber: number }> {
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

    const UPSTREAM_REPO = 'itsdestin/wecoded-themes';
    const isUpdate = !!opts.existingEntry;
    const branchName = isUpdate
      ? `update-theme/${slug}-${Date.now()}`
      : `theme/${slug}`;

    // 2. Fork the themes repo (idempotent — gh returns existing fork)
    try {
      await execFileAsync(ghPath, ['repo', 'fork', UPSTREAM_REPO, '--clone=false'], { timeout: 30000 });
    } catch (err: any) {
      // gh repo fork returns exit code 0 even if fork exists; only throw on real errors
      if (err.code === 'ENOENT') throw new Error('gh CLI not found');
    }

    const FORK_REPO = `${username}/wecoded-themes`;

    // 3. Use the GitHub API to create/update files on a branch
    // First, get the default branch SHA
    let baseSha: string;
    try {
      const { stdout } = await execFileAsync(ghPath, [
        'api', `repos/${UPSTREAM_REPO}/git/ref/heads/main`, '--jq', '.object.sha',
      ]);
      baseSha = stdout.trim();
    } catch {
      throw new Error('Failed to read upstream repo. Does itsdestin/wecoded-themes exist?');
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
          '-f', `sha=${baseSha}`, '-F', 'force=true',
        ]);
      } catch (err: any) {
        throw new Error(`Failed to create branch: ${err.message}`);
      }
    }

    // 4. Use the local preview.png if it's already fresh (theme-builder generates
    //    it via wecoded-themes/scripts/generate-previews.js at finalize). Falling
    //    back to BrowserWindow capture only when the local file is missing or
    //    stale keeps the canonical Playwright-rendered preview as the source
    //    of truth instead of letting the publisher's variant overwrite it.
    if (!isPreviewFresh(themeDir)) {
      try {
        await generateThemePreview(themeDir, manifest);
      } catch (err: any) {
        console.warn('[ThemeMarketplace] Preview generation failed (continuing without):', err.message);
      }
    } else {
      console.log('[ThemeMarketplace] Using existing fresh preview.png from theme-builder');
    }

    // 5. Collect all theme files (manifest + assets + preview)
    const filesToUpload: { repoPath: string; localPath: string; binary: boolean }[] = [];

    // Compute a stable content hash of manifest + assets (excluding preview.png
    // and the three ephemeral fields stripped below). Baked into the manifest so
    // wecoded-themes CI can copy it into the registry entry without
    // recomputing — this is what lets the app later detect local drift.
    const { computeThemeContentHash } = await import('./theme-content-hash');
    const contentHash = await computeThemeContentHash(themeDir);

    // Strip ephemeral fields, then bake in the content hash.
    const cleanManifest = { ...manifest };
    delete cleanManifest.source;
    delete cleanManifest.basePath;
    cleanManifest.contentHash = contentHash;

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

    // 5b. Pre-flight size validation — reject oversized files before any API
    // call so the user gets a specific actionable error instead of discovering
    // the problem halfway through the upload (leaving a half-populated branch).
    const oversized: { repoPath: string; bytes: number }[] = [];
    for (const file of filesToUpload) {
      // Skip the cleaned manifest — its size is computed at upload time, but
      // it's always small enough that this doesn't matter.
      if (file.repoPath.endsWith('manifest.json') && file.localPath === manifestPath) continue;
      try {
        const stat = await fs.promises.stat(file.localPath);
        if (stat.size > MAX_PUBLISH_FILE_BYTES) {
          oversized.push({ repoPath: file.repoPath, bytes: stat.size });
        }
      } catch {
        // File disappeared between collection and stat — let the upload loop report it
      }
    }
    if (oversized.length > 0) {
      const fmt = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;
      const list = oversized.map(f => `  • ${f.repoPath} (${fmt(f.bytes)})`).join('\n');
      throw new Error(
        `Cannot publish — the following files exceed the 10 MB registry limit:\n${list}\n\nResize or recompress them, then try again.`
      );
    }

    // 6. Upload files via GitHub Contents API.
    // Content is piped as a JSON body via stdin (not argv) to avoid Windows's
    // ~32 KB command-line limit — see ghApiWithBody() comment.
    for (const file of filesToUpload) {
      let content: string;
      if (file.repoPath.endsWith('manifest.json') && file.localPath === manifestPath) {
        content = Buffer.from(JSON.stringify(cleanManifest, null, 2)).toString('base64');
      } else {
        const raw = await fs.promises.readFile(file.localPath);
        content = raw.toString('base64');
      }

      const putArgs = ['api', `repos/${FORK_REPO}/contents/${file.repoPath}`, '-X', 'PUT'];
      const createBody = JSON.stringify({
        message: `Add ${file.repoPath}`,
        content,
        branch: branchName,
      });

      try {
        await ghApiWithBody(ghPath, putArgs, createBody);
      } catch {
        // File may already exist on the branch — fetch its sha and update.
        try {
          const { stdout: existingFile } = await execFileAsync(ghPath, [
            'api', `repos/${FORK_REPO}/contents/${file.repoPath}`,
            '-q', '.sha', '-H', 'Accept: application/vnd.github.v3+json',
            '--method', 'GET', '-f', `ref=${branchName}`,
          ]);
          const updateBody = JSON.stringify({
            message: `Update ${file.repoPath}`,
            content,
            sha: existingFile.trim(),
            branch: branchName,
          });
          await ghApiWithBody(ghPath, putArgs, updateBody);
        } catch (err: any) {
          throw new Error(`Failed to upload ${file.repoPath}: ${err?.message || 'unknown error'}`);
        }
      }
    }

    // 6. Create the PR
    const prTitle = isUpdate
      ? `[Theme Update] ${manifest.name || slug}`
      : `[Theme] ${manifest.name || slug}`;

    const prBody = [
      isUpdate
        ? `## Theme Update: ${manifest.name || slug}`
        : `## New Theme: ${manifest.name || slug}`,
      '',
      manifest.description ? `> ${manifest.description}` : '',
      '',
      `- **Author:** ${manifest.author || username}`,
      `- **Mode:** ${manifest.dark ? 'Dark' : 'Light'}`,
      `- **Slug:** \`${slug}\``,
      `- **Content hash:** \`${contentHash}\``,
      '',
      isUpdate
        ? '_Update submitted via YouCoded Theme Marketplace_'
        : '_Submitted via YouCoded Theme Marketplace_',
    ].join('\n');

    try {
      const { stdout: prUrlRaw } = await execFileAsync(ghPath, [
        'pr', 'create',
        '--repo', UPSTREAM_REPO,
        '--head', `${username}:${branchName}`,
        '--title', prTitle,
        '--body', prBody,
      ], { timeout: 30000 });
      const prUrl = prUrlRaw.trim();
      this.invalidatePRStatus(slug, username);
      this.invalidateRegistryCache();
      return { prUrl, prNumber: extractPRNumber(prUrl) };
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
            const prUrl = existingPr.trim();
            this.invalidatePRStatus(slug, username);
            this.invalidateRegistryCache();
            return { prUrl, prNumber: extractPRNumber(prUrl) };
          }
        } catch { /* fall through */ }
      }
      throw new Error(`Failed to create PR: ${err.stderr || err.message}`);
    }
  }

  // Lazily-constructed PR lookup — initialized on first use so the module is
  // not required at class instantiation time (which breaks Vitest's CommonJS
  // transform boundary). Tests that need to stub ThemePRLookup can do so
  // before calling resolvePublishStateForSlug or invalidatePRStatus.
  private _prLookup: InstanceType<typeof import('./theme-pr-lookup').ThemePRLookup> | null = null;

  private get prLookup(): InstanceType<typeof import('./theme-pr-lookup').ThemePRLookup> {
    if (!this._prLookup) {
      // Why require() not import(): this file is in main process (CommonJS).
      // The existing file already uses require('which') at module scope for
      // the same reason. Using require() here keeps the instantiation lazy
      // (deferred to first method call) without hoisting concerns.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ThemePRLookup } = require('./theme-pr-lookup');
      this._prLookup = new ThemePRLookup();
    }
    return this._prLookup!;
  }

  /**
   * Resolve the publish-state for a local user theme. Combines the registry
   * fetch, gh PR lookups (open + recently merged), and a fresh local content
   * hash into a discriminated `PublishState`. Errors degrade to
   * `{ kind: 'unknown', reason }` rather than throwing — callers render a
   * degraded-mode warning instead of a crash.
   */
  async resolvePublishStateForSlug(
    slug: string,
  ): Promise<import('../shared/theme-marketplace-types').PublishState> {
    // Hard cap on the whole operation — if registry fetch OR any gh call hangs
    // (slow network, gh prompting for auth, dead DNS), we still return a state
    // the UI can render instead of leaving the user stuck on "Checking publish
    // status…". 10s is well past the normal ~200ms happy path.
    const TIMEOUT_MS = 10_000;
    const timeout = new Promise<import('../shared/theme-marketplace-types').PublishState>(
      (resolve) => setTimeout(
        () => resolve({ kind: 'unknown', reason: 'lookup timed out — check network or gh auth' }),
        TIMEOUT_MS,
      ),
    );
    return Promise.race([this.resolvePublishStateInner(slug), timeout]);
  }

  private async resolvePublishStateInner(
    slug: string,
  ): Promise<import('../shared/theme-marketplace-types').PublishState> {
    const { resolvePublishState } = await import('../renderer/state/publish-state-resolver');
    const { computeThemeContentHash } = await import('./theme-content-hash');

    if (!SAFE_SLUG_RE.test(slug)) {
      return { kind: 'unknown', reason: 'invalid slug' };
    }

    const themeDir = path.join(THEMES_DIR, slug);
    const manifestPath = path.join(themeDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return { kind: 'unknown', reason: 'theme not found on disk' };
    }

    // Resolve author: prefer the local manifest (it's the source of truth for
    // who authored the theme). Fall back to gh auth so a manifest with no
    // author still gets a reasonable answer.
    let author: string;
    try {
      const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));
      if (typeof manifest.author === 'string' && manifest.author.length > 0) {
        author = manifest.author;
      } else {
        const { stdout } = await execFileAsync(ghPath, ['api', 'user', '--jq', '.login'], { timeout: 5000 });
        author = stdout.trim();
      }
    } catch {
      return { kind: 'unknown', reason: 'gh not authenticated' };
    }

    // All four lookups are independent — parallelize.
    const [index, openPR, recentlyMergedPR, localHash] = await Promise.all([
      this.fetchRegistry().catch(() => null),
      this.prLookup.findOpenPR(slug, author),
      this.prLookup.findRecentlyMergedPR(slug, author),
      computeThemeContentHash(themeDir),
    ]);

    const registryEntry = index?.themes.find(t => t.slug === slug && t.author === author) ?? null;

    return resolvePublishState({ registryEntry, openPR, recentlyMergedPR, localHash });
  }

  /** Invalidate PR-status cache for a given (slug, author). */
  invalidatePRStatus(slug: string, author: string): void {
    this.prLookup.invalidate(slug, author);
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

    // Try fetching from remote with a 5s timeout so a dead/slow network falls
    // through to the disk cache instead of hanging the resolver.
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(REGISTRY_URL, { signal: ctrl.signal }).finally(() => clearTimeout(t));
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

/** Pull the numeric PR id out of a github.com PR url. Throws on malformed input. */
function extractPRNumber(url: string): number {
  const m = url.match(/\/pull\/(\d+)/);
  if (!m) throw new Error(`Could not parse PR number from ${url}`);
  return Number(m[1]);
}
