import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';

/**
 * Installs Claude Code plugins by placing files at ~/.claude/plugins/<name>/.
 * Claude Code auto-discovers plugins via .claude-plugin/plugin.json at session start.
 *
 * Three source types:
 * - "local": copy from a cached clone of the marketplace repo
 * - "url": git clone an external repository
 * - "git-subdir": git clone + sparse checkout a subdirectory
 */

const PLUGINS_DIR = path.join(os.homedir(), '.claude', 'plugins');
const CACHE_DIR = path.join(os.homedir(), '.claude', 'destincode-marketplace-cache');
const MARKETPLACE_REPO = 'https://github.com/anthropics/claude-plugins-official.git';
const GIT_TIMEOUT = 120_000; // 2 minutes

// Security: only allow safe characters in plugin IDs to prevent path traversal
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** Validate that a resolved path stays within an expected base directory. */
function isContainedIn(child: string, parent: string): boolean {
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  return resolvedChild.startsWith(resolvedParent + path.sep) || resolvedChild === resolvedParent;
}

interface InstallMeta {
  installedAt: string;
  installedFrom: string;
  installPath: string;
  sourceType: string;
  sourceRef: string;
  sourceSubdir?: string;
}

export type InstallResult =
  | { status: 'installed' }
  | { status: 'already_installed'; via: string }
  | { status: 'failed'; error: string }
  | { status: 'installing' };

interface MarketplaceEntry {
  id: string;
  sourceType: string;
  sourceRef: string;
  sourceSubdir?: string;
  sourceMarketplace?: string;
  description?: string;
  author?: string;
}

const installsInProgress = new Set<string>();

function runGit(...args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { timeout: GIT_TIMEOUT, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, output: `${stderr}\n${stdout}`.trim() });
      } else {
        resolve({ ok: true, output: stdout.trim() });
      }
    });
  });
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** Check if a plugin is already installed via Claude Code's /plugin install. */
export function hasConflict(id: string): boolean {
  try {
    const installedPath = path.join(PLUGINS_DIR, 'installed_plugins.json');
    if (!fs.existsSync(installedPath)) return false;
    const data = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
    const plugins = data.plugins || {};
    return Object.keys(plugins).some(key => key.startsWith(`${id}@`));
  } catch {
    return false;
  }
}

/** Ensure the plugin has a .claude-plugin/plugin.json file. */
function ensurePluginJson(id: string, entry: MarketplaceEntry): void {
  const targetDir = path.join(PLUGINS_DIR, id);
  const dotDir = path.join(targetDir, '.claude-plugin');
  const dotJson = path.join(dotDir, 'plugin.json');
  if (fs.existsSync(dotJson)) return;

  const rootJson = path.join(targetDir, 'plugin.json');
  if (fs.existsSync(rootJson)) return;

  // Neither exists — create from marketplace entry
  fs.mkdirSync(dotDir, { recursive: true });
  const meta: Record<string, any> = {
    name: id,
    description: entry.description || '',
  };
  if (entry.author) meta.author = { name: entry.author };
  fs.writeFileSync(dotJson, JSON.stringify(meta, null, 2));
}

async function installFromLocal(id: string, sourceRef: string): Promise<InstallResult> {
  const cacheRepo = path.join(CACHE_DIR, 'claude-plugins-official');

  // Ensure marketplace repo is cloned
  if (!fs.existsSync(cacheRepo)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const { ok, output } = await runGit('clone', '--depth', '1', MARKETPLACE_REPO, cacheRepo);
    if (!ok) return { status: 'failed', error: `Failed to clone marketplace repo: ${output.slice(0, 200)}` };
  }

  const sourceDir = path.join(cacheRepo, sourceRef);
  // Security: prevent sourceRef from escaping the cache directory (e.g. "../../.ssh")
  if (!isContainedIn(sourceDir, cacheRepo)) {
    return { status: 'failed', error: 'Invalid source ref (path traversal blocked)' };
  }
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    return { status: 'failed', error: `Source not found in cache: ${sourceRef}` };
  }

  const targetDir = path.join(PLUGINS_DIR, id);
  if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
  copyDirSync(sourceDir, targetDir);
  return { status: 'installed' };
}

async function installFromUrl(id: string, url: string): Promise<InstallResult> {
  // Security: only allow HTTPS git URLs to prevent ext::, file://, ssh:// attacks
  if (!url.startsWith('https://')) {
    return { status: 'failed', error: 'Only HTTPS git URLs are supported' };
  }
  const targetDir = path.join(PLUGINS_DIR, id);
  if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });

  const { ok, output } = await runGit('clone', '--depth', '1', url, targetDir);
  if (!ok) return { status: 'failed', error: `git clone failed: ${output.slice(0, 200)}` };
  return { status: 'installed' };
}

async function installFromGitSubdir(id: string, repoUrl: string, subdir: string): Promise<InstallResult> {
  if (!subdir) return { status: 'failed', error: 'Missing sourceSubdir for git-subdir source' };
  // Security: only allow HTTPS git URLs
  if (!repoUrl.startsWith('https://')) {
    return { status: 'failed', error: 'Only HTTPS git URLs are supported' };
  }

  const tmpDir = path.join(os.tmpdir(), `plugin-staging-${id}-${Date.now()}`);
  try {
    const cloneResult = await runGit('clone', '--depth', '1', '--filter=blob:none', '--sparse', repoUrl, tmpDir);
    if (!cloneResult.ok) return { status: 'failed', error: `git clone failed: ${cloneResult.output.slice(0, 200)}` };

    const sparseResult = await runGit('-C', tmpDir, 'sparse-checkout', 'set', subdir);
    if (!sparseResult.ok) return { status: 'failed', error: `sparse-checkout failed: ${sparseResult.output.slice(0, 200)}` };

    const sourceDir = path.join(tmpDir, subdir);
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      return { status: 'failed', error: `Subdirectory not found after checkout: ${subdir}` };
    }

    const targetDir = path.join(PLUGINS_DIR, id);
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
    copyDirSync(sourceDir, targetDir);
    return { status: 'installed' };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

export async function installPlugin(entry: MarketplaceEntry): Promise<InstallResult> {
  const { id, sourceType, sourceRef } = entry;
  if (!id) return { status: 'failed', error: 'Missing plugin id' };
  // Security: validate plugin ID to prevent path traversal (e.g. "../../.ssh")
  if (!SAFE_ID_RE.test(id)) return { status: 'failed', error: 'Invalid plugin id' };

  // Guard: already in progress
  if (installsInProgress.has(id)) return { status: 'installing' };
  installsInProgress.add(id);

  try {
    // Guard: already installed via Claude Code
    if (hasConflict(id)) return { status: 'already_installed', via: 'Claude Code' };

    // Guard: already installed via DestinCode
    const targetDir = path.join(PLUGINS_DIR, id);
    const dotJson = path.join(targetDir, '.claude-plugin', 'plugin.json');
    if (fs.existsSync(targetDir) && (fs.existsSync(dotJson) || fs.existsSync(path.join(targetDir, 'plugin.json')))) {
      return { status: 'already_installed', via: 'DestinCode' };
    }

    let result: InstallResult;
    switch (sourceType) {
      case 'local':
        result = await installFromLocal(id, sourceRef);
        break;
      case 'url':
        result = await installFromUrl(id, sourceRef);
        break;
      case 'git-subdir':
        result = await installFromGitSubdir(id, sourceRef, entry.sourceSubdir || '');
        break;
      default:
        result = { status: 'failed', error: `Unknown source type: ${sourceType}` };
    }

    if (result.status === 'installed') {
      ensurePluginJson(id, entry);
    }

    return result;
  } catch (err: any) {
    return { status: 'failed', error: err?.message || 'Unknown error' };
  } finally {
    installsInProgress.delete(id);
  }
}

export async function uninstallPlugin(id: string): Promise<boolean> {
  // Security: validate plugin ID to prevent path traversal → arbitrary directory deletion
  if (!SAFE_ID_RE.test(id)) return false;
  try {
    const targetDir = path.join(PLUGINS_DIR, id);
    // Double-check: resolved path must stay within plugins directory
    if (!isContainedIn(targetDir, PLUGINS_DIR)) return false;
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    return true;
  } catch {
    return false;
  }
}

export function isPluginInstalled(id: string): boolean {
  if (!SAFE_ID_RE.test(id)) return false; // Security: reject invalid IDs
  const targetDir = path.join(PLUGINS_DIR, id);
  return fs.existsSync(targetDir) && (
    fs.existsSync(path.join(targetDir, '.claude-plugin', 'plugin.json')) ||
    fs.existsSync(path.join(targetDir, 'plugin.json'))
  );
}
