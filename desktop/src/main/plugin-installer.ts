import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import {
  YOUCODED_PLUGINS_DIR,
  pluginInstallDir,
  registerPluginInstall,
  unregisterPluginInstall,
} from './claude-code-registry';

/**
 * Installs Claude Code plugins under our own marketplace root at
 * ~/.claude/marketplaces/youcoded/plugins/<name>/ and wires them into all
 * four Claude Code registries (settings.json, installed_plugins.json,
 * known_marketplaces.json, marketplace.json) so /reload-plugins picks them
 * up as first-class plugins.
 *
 * Prior versions of this file installed to ~/.claude/plugins/<name>/ and
 * relied on filesystem auto-discovery. Claude Code v2.1+ does NOT scan the
 * filesystem — plugins must be registered in the four files above or they
 * are invisible to the loader. See claude-code-registry.ts for details.
 *
 * Three source types:
 * - "local": copy from a cached clone of the marketplace repo
 * - "url": git clone an external repository
 * - "git-subdir": git clone + sparse checkout a subdirectory
 */

// All YouCoded-installed plugins now live under the marketplace root so
// Claude Code's non-cache plugin loader (t71) can resolve `<marketplace>/<source>`.
const PLUGINS_DIR = YOUCODED_PLUGINS_DIR;
const CACHE_DIR = path.join(os.homedir(), '.claude', 'youcoded-marketplace-cache');
const MARKETPLACE_REPO = 'https://github.com/anthropics/claude-plugins-official.git';
// 5 min — large skill repos (themes with bundled assets, plugins with vendored
// binaries) can take well over 2 min on a slow connection. The previous 2 min
// value would silently SIGTERM mid-clone and surface as a generic install
// failure with no diagnostic context.
const GIT_TIMEOUT = 5 * 60 * 1000;
// Hoisted from installFromLocal so refreshLocalMarketplaceCache (Task B2) and
// installFromLocal share ONE read of the env var instead of two call sites
// that could theoretically disagree mid-process.
const marketplaceBranch = process.env.YOUCODED_MARKETPLACE_BRANCH || 'master';

// Security: only allow safe characters in plugin IDs to prevent path traversal
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** Validate that a resolved path stays within an expected base directory. */
function isContainedIn(child: string, parent: string): boolean {
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  return resolvedChild.startsWith(resolvedParent + path.sep) || resolvedChild === resolvedParent;
}

/**
 * Phase 3a: Map sourceMarketplace to its git repo URL.
 * YouCoded/YouCoded local entries live in the itsdestin/wecoded-marketplace
 * repo, while Anthropic upstream entries live in anthropics/claude-plugins-official.
 */
function getMarketplaceRepo(sourceMarketplace?: string): string {
  if (sourceMarketplace === 'youcoded' || sourceMarketplace === 'youcoded-core') {
    return 'https://github.com/itsdestin/wecoded-marketplace.git';
  }
  return MARKETPLACE_REPO;
}

function getCacheRepoName(sourceMarketplace?: string): string {
  if (sourceMarketplace === 'youcoded' || sourceMarketplace === 'youcoded-core') {
    return 'wecoded-marketplace';
  }
  return 'claude-plugins-official';
}

// Task B3 review fix (Finding 2): the launch-time reconciler in skill-provider.ts
// was hand-building this same path with 'wecoded-marketplace' hardcoded, which
// silently disagreed with getCacheRepoName() the moment a bundled entry ever
// carried a different sourceMarketplace. Exporting the single source of truth
// both installFromLocal/upgradePluginFromLocal and the reconciler now share.
export function marketplaceCacheDir(sourceMarketplace: string | undefined, sourceRef: string): string {
  return path.join(CACHE_DIR, getCacheRepoName(sourceMarketplace), sourceRef);
}

export interface InstallMeta {
  installedAt: string;
  installedFrom: string;
  installPath: string;
  sourceType: string;
  sourceRef: string;
  sourceSubdir?: string;
}

export type InstallResult =
  // `commit` is the exact upstream sha the install landed on, present only when
  // the catalog listed one (see pinToCommit). The package record stores it so the
  // Update check can tell "the repo moved" from "the author bumped the version".
  | { status: 'installed'; type?: 'plugin' | 'prompt'; commit?: string }
  | { status: 'already_installed'; via: string; type?: 'plugin' | 'prompt' }
  | { status: 'failed'; error: string; type?: 'plugin' | 'prompt' }
  | { status: 'installing'; type?: 'plugin' | 'prompt' };

interface MarketplaceEntry {
  id: string;
  sourceType: string;
  sourceRef: string;
  sourceSubdir?: string;
  sourceMarketplace?: string;
  // Marketplace overhaul: the exact upstream commit the catalog listed — the
  // files that were actually scanned. Absent for local (our own repo) sources
  // and for any entry with no catalog block, which keeps installing latest.
  sourceCommit?: string;
  description?: string;
  author?: string;
  // Used to detect when a cached local-source package has drifted from the
  // marketplace index (see installFromLocal). Optional — missing version
  // falls through to pure time-based cache refresh.
  version?: string;
  // Decomposition v3: shell command run after install. Only executed when
  // sourceRef URL points to a trusted GitHub org — see installPlugin().
  postInstall?: string;
  // Decomposition v3: soft recommendations (surfaced in marketplace UI, not
  // enforced). `provides` / `optionalIntegrations` are read from the installed
  // plugin.json by the integration reconciler, not from the marketplace entry.
  recommends?: string[];
}

// Decomposition v3 §9.5: postInstall scripts run arbitrary shell — restrict
// to entries whose sourceRef URL points to a trusted GitHub org. Do NOT trust
// `sourceMarketplace` alone; it comes from fetchable JSON and can be spoofed
// if the registry is compromised. This is an allowlist on the canonical
// repo URL the code was actually fetched from.
const TRUSTED_POSTINSTALL_ORGS = ['itsdestin/', 'destinationunknown/'];

function isPostInstallTrusted(entry: MarketplaceEntry): boolean {
  if (!entry.postInstall || !entry.sourceRef) return false;
  return TRUSTED_POSTINSTALL_ORGS.some(org =>
    entry.sourceRef.includes(`github.com/${org}`),
  );
}

function runShell(command: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile('bash', ['-c', command], {
      cwd,
      timeout: GIT_TIMEOUT,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, output: `${stderr}\n${stdout}`.trim() });
      } else {
        resolve({ ok: true, output: stdout.trim() });
      }
    });
  });
}

const installsInProgress = new Set<string>();

function runGit(...args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { timeout: GIT_TIMEOUT, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // WHY: when git itself never ran (e.g. not installed), stderr/stdout
        // are both empty and `printed` collapses to '' — the caller's message
        // becomes "fetch failed: " with nothing after it. Fall back to the OS
        // error (err.message, e.g. "spawn git ENOENT") so the user sees why.
        const printed = `${stderr}\n${stdout}`.trim();
        resolve({ ok: false, output: printed || err.message });
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

/** Check if a plugin is already installed via Claude Code's /plugin install.
 * Claude Code's plugin cache dir (`tW()` in the CLI) is `~/.claude/plugins/`,
 * so `installed_plugins.json` lives there — not at `~/.claude/`. Skip keys
 * ending in `@youcoded` since those are ours, not a foreign conflict. */
function hasConflict(id: string): boolean {
  try {
    const installedPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
    if (!fs.existsSync(installedPath)) return false;
    const data = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
    const plugins = data.plugins || {};
    return Object.keys(plugins).some(key =>
      key.startsWith(`${id}@`) && !key.endsWith('@youcoded')
    );
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

// Decomposition v3 §9.4: cache refresh rate-limit window. Local-source packages
// (encyclopedia, inbox, etc.) live in the marketplace repo as subdirs — without
// a periodic `git pull` the cached copy diverges from master and users never
// see updates. 1 hour is frequent enough for iteration, low-volume enough to
// avoid hammering GitHub.
const CACHE_REFRESH_MS = 60 * 60 * 1000; // 1 hour

function getCacheTimestamp(cacheRepo: string): number {
  try {
    const stampFile = path.join(cacheRepo, '.youcoded-last-pull');
    if (!fs.existsSync(stampFile)) return 0;
    return parseInt(fs.readFileSync(stampFile, 'utf8'), 10) || 0;
  } catch { return 0; }
}

function setCacheTimestamp(cacheRepo: string): void {
  try {
    fs.writeFileSync(path.join(cacheRepo, '.youcoded-last-pull'), String(Date.now()));
  } catch { /* non-fatal — just means we'll retry next install */ }
}

// Renamed from readCachedPluginVersion + exported: Task B3's launch-time
// reconciler needs this to read the REAL installed version off disk (not
// the hardcoded '1.0.0' installPlugin used to write), and to read the
// cache's version to decide whether an upgrade is available.
export function readPluginVersion(dir: string): string | null {
  // Check both standard plugin.json layouts.
  const candidates = [
    path.join(dir, 'plugin.json'),
    path.join(dir, '.claude-plugin', 'plugin.json'),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
      if (typeof v === 'string') return v;
    } catch { /* corrupt manifest — treat as missing */ }
  }
  return null;
}
// Private alias so the existing call sites below compile unchanged.
const readCachedPluginVersion = readPluginVersion;

async function installFromLocal(id: string, sourceRef: string, sourceMarketplace?: string, expectedVersion?: string): Promise<InstallResult> {
  // Phase 3a: source-aware repo selection — YouCoded entries clone from
  // itsdestin/wecoded-marketplace, not the Anthropic upstream repo.
  // YOUCODED_MARKETPLACE_BRANCH overrides the branch for test harnesses
  // (e.g., running the decomposition-v3 branch on a scratch machine).
  const cacheRepo = path.join(CACHE_DIR, getCacheRepoName(sourceMarketplace));
  const repoUrl = getMarketplaceRepo(sourceMarketplace);

  // Ensure marketplace repo is cloned, or refresh it if:
  //   (a) it's been >1h since the last pull (time-based refresh), OR
  //   (b) the cached copy's plugin.json version doesn't match the version
  //       declared in the marketplace index (version-based refresh).
  // (b) catches the case where a critical fix bumped a package version within
  // the 1h time window — without it, users would stay on the old copy until
  // their timer elapsed. Pull failures fall back to the cached copy
  // (offline-safe) and skip updating the timestamp so the next install retries.
  let shouldRefresh = false;
  if (!fs.existsSync(cacheRepo)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const { ok, output } = await runGit('clone', '--depth', '1', '--branch', marketplaceBranch, repoUrl, cacheRepo);
    if (!ok) return { status: 'failed', error: `Failed to clone marketplace repo: ${output.slice(0, 200)}` };
    setCacheTimestamp(cacheRepo);
  } else {
    shouldRefresh = Date.now() - getCacheTimestamp(cacheRepo) > CACHE_REFRESH_MS;
    if (!shouldRefresh && expectedVersion) {
      const cachedVersion = readCachedPluginVersion(path.join(cacheRepo, sourceRef));
      // Version present and mismatched → refresh. Missing version → fall back
      // to time-based refresh only (don't thrash the cache on manifests that
      // never declare a version).
      if (cachedVersion && cachedVersion !== expectedVersion) shouldRefresh = true;
    }
  }

  if (shouldRefresh) {
    const fetchResult = await runGit('-C', cacheRepo, 'fetch', 'origin');
    if (fetchResult.ok) {
      // Default branch is master per workspace convention; YOUCODED_MARKETPLACE_BRANCH
      // overrides. If a marketplace repo later standardizes on `main`, detect
      // origin/HEAD here.
      const resetResult = await runGit('-C', cacheRepo, 'reset', '--hard', `origin/${marketplaceBranch}`);
      if (resetResult.ok) setCacheTimestamp(cacheRepo);
      // Reset failure → proceed with cached copy, don't bump stamp
    }
    // Fetch failure (offline, rate-limited) → proceed with cached copy
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

/**
 * Task B2: refresh the marketplace cache clone on its own, independent of
 * an install. Task B3's launch-time reconciler calls this before comparing
 * versions, so a bundled plugin's upgrade can be detected without the user
 * ever re-running the install flow. Clones if the cache is missing; otherwise
 * only fetches/resets once the 1 h gate (CACHE_REFRESH_MS) has elapsed —
 * reconcile runs on EVERY launch, so without the gate that's a GitHub
 * round-trip on every app start.
 *
 * `opts.force` bypasses that gate for the one launch after an app version
 * change (see reconcileBundledPlugins). Deliberately an opt-in rather than a
 * shorter TTL: the gate exists to keep launches cheap, and only the app-update
 * case has a reason to spend a round-trip outside it.
 */
/**
 * Which app version last ran the bundled-plugin reconcile.
 *
 * WHY a file and not a config key: the reconcile is a boot chore that may run
 * before the config store is ready, and this marker is throwaway state — losing
 * it costs one extra cache refresh, never a correctness problem. Sits in
 * CACHE_DIR (the marketplace cache root), NOT in ~/.claude/plugins/, so it is
 * never mistaken for plugin content by listInstalledPluginDirs().
 *
 * Returns null when absent or unreadable, which callers treat as "no version
 * seen yet" — the first launch after this feature ships forces one refresh.
 */
function appVersionMarkerPath(): string {
  return path.join(CACHE_DIR, '.youcoded-last-reconciled-app-version');
}

export function readLastReconciledAppVersion(): string | null {
  try {
    const v = fs.readFileSync(appVersionMarkerPath(), 'utf8').trim();
    return v || null;
  } catch {
    return null;
  }
}

export function writeLastReconciledAppVersion(version: string): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(appVersionMarkerPath(), version);
  } catch { /* non-fatal — worst case is one extra forced refresh next launch */ }
}

export async function refreshLocalMarketplaceCache(sourceMarketplace?: string, opts?: { force?: boolean }): Promise<{ ok: boolean; refreshed: boolean; error?: string }> {
  const cacheRepo = path.join(CACHE_DIR, getCacheRepoName(sourceMarketplace));
  const repoUrl = getMarketplaceRepo(sourceMarketplace);
  if (!fs.existsSync(cacheRepo)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const { ok, output } = await runGit('clone', '--depth', '1', '--branch', marketplaceBranch, repoUrl, cacheRepo);
    if (!ok) return { ok: false, refreshed: false, error: `clone failed: ${output.slice(0, 200)}` };
    setCacheTimestamp(cacheRepo);
    return { ok: true, refreshed: true };
  }
  if (!opts?.force && Date.now() - getCacheTimestamp(cacheRepo) < CACHE_REFRESH_MS) return { ok: true, refreshed: false };
  const f = await runGit('-C', cacheRepo, 'fetch', 'origin');
  if (!f.ok) return { ok: false, refreshed: false, error: `fetch failed: ${f.output.slice(0, 200)}` };
  const r = await runGit('-C', cacheRepo, 'reset', '--hard', `origin/${marketplaceBranch}`);
  if (!r.ok) return { ok: false, refreshed: false, error: `reset failed: ${r.output.slice(0, 200)}` };
  setCacheTimestamp(cacheRepo);
  return { ok: true, refreshed: true };
}

/**
 * Task B2: replace an already-installed plugin's tree with the cache
 * clone's copy, in place. Never deletes the live install directory before
 * the new copy is staged — a crash mid-copy must not leave the user with no
 * plugin at all. The old tree is parked under `.old-<id>-<pid>` until the
 * swap fully succeeds, and is put BACK if anything throws in between.
 */
/** Update a plugin that came from git (`url` or `git-subdir`).
 *
 *  WHY THIS EXISTS: `update()` re-runs `installPlugin`, which returns
 *  `already_installed` as soon as the plugin directory exists — before it reaches any
 *  clone. Only `local` sources had a real upgrade path, so pressing Update on a git
 *  plugin rewrote nothing at all. That was 237 of the 302 live registry entries
 *  (measured 2026-08-31): the large majority of the store.
 *
 *  The order is deliberate and is the whole safety story: clone into a STAGING
 *  directory, and only once the clone AND the pin have both succeeded swap it into
 *  place — retiring the old tree first so it can be put back if the swap dies
 *  half-way. A failed update therefore leaves the working install exactly as it was,
 *  which a plain "delete then re-clone" could not promise. Mirrors
 *  upgradePluginFromLocal's staging/retire/rollback dance.
 */
export async function upgradePluginFromGit(entry: MarketplaceEntry): Promise<InstallResult> {
  const { id, sourceType, sourceRef } = entry;
  if (!SAFE_ID_RE.test(id)) return { status: 'failed', error: 'Invalid plugin id' };
  if (sourceType !== 'url' && sourceType !== 'git-subdir') {
    return { status: 'failed', error: `upgradePluginFromGit does not handle source type "${sourceType}"` };
  }
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  const targetDir = path.join(PLUGINS_DIR, id);
  const staging = path.join(PLUGINS_DIR, `.upgrade-${id}-${process.pid}`);
  const retired = path.join(PLUGINS_DIR, `.old-${id}-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });

  const fetched = sourceType === 'url'
    ? await installFromUrl(id, sourceRef, entry.sourceCommit, staging)
    : await installFromGitSubdir(id, sourceRef, entry.sourceSubdir || '', entry.sourceCommit, staging);

  // Nothing on disk has been touched yet — return the real git message untouched.
  if (fetched.status !== 'installed') {
    fs.rmSync(staging, { recursive: true, force: true });
    return fetched;
  }

  try {
    if (fs.existsSync(targetDir)) fs.renameSync(targetDir, retired);
    fs.renameSync(staging, targetDir);
  } catch (err: unknown) {
    // Put the old tree back if the swap died half-way — a user must never end up
    // with the plugin directory entirely gone.
    if (!fs.existsSync(targetDir) && fs.existsSync(retired)) {
      try { fs.renameSync(retired, targetDir); } catch { /* nothing better to do */ }
    }
    fs.rmSync(staging, { recursive: true, force: true });
    return { status: 'failed', error: `upgrade swap failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  // Cleanup AFTER the swap already succeeded; a failure here is not an upgrade failure.
  fs.rmSync(retired, { recursive: true, force: true });
  return { status: 'installed', commit: fetched.commit };
}

export async function upgradePluginFromLocal(id: string, sourceRef: string, sourceMarketplace?: string): Promise<InstallResult> {
  if (!SAFE_ID_RE.test(id)) return { status: 'failed', error: 'Invalid plugin id' };
  const cacheRepo = path.join(CACHE_DIR, getCacheRepoName(sourceMarketplace));
  const sourceDir = path.join(cacheRepo, sourceRef);
  // Security: prevent sourceRef from escaping the cache directory (e.g. "../../.ssh")
  if (!isContainedIn(sourceDir, cacheRepo)) return { status: 'failed', error: 'Invalid source ref (path traversal blocked)' };
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) return { status: 'failed', error: `Source not found in cache: ${sourceRef}` };
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  const targetDir = path.join(PLUGINS_DIR, id);
  const staging = path.join(PLUGINS_DIR, `.upgrade-${id}-${process.pid}`);
  const retired = path.join(PLUGINS_DIR, `.old-${id}-${process.pid}`);
  try {
    // Stale leftovers from a killed prior attempt (same id, same pid never
    // recurs in practice, but be defensive) must not make copyDirSync merge
    // into a half-written staging dir.
    fs.rmSync(staging, { recursive: true, force: true });
    copyDirSync(sourceDir, staging);
    if (fs.existsSync(targetDir)) fs.renameSync(targetDir, retired);
    fs.renameSync(staging, targetDir);
  } catch (err: any) {
    // WHY: put the old tree back if the swap died half-way — a user must
    // never end up with the plugin directory entirely gone.
    if (!fs.existsSync(targetDir) && fs.existsSync(retired)) {
      try { fs.renameSync(retired, targetDir); } catch { /* nothing better to do */ }
    }
    fs.rmSync(staging, { recursive: true, force: true });
    return { status: 'failed', error: `upgrade copy failed: ${err?.message || String(err)}` };
  }
  // WHY: deleting the retired tree is cleanup AFTER the swap already
  // succeeded — the new files are live at targetDir at this point. A
  // failure here (e.g. Windows still holding a file in the old tree open)
  // must not be reported as an upgrade failure: the upgrade DID work, and
  // reporting 'failed' would both lie about what's on disk and skip
  // registerPluginInstall below, leaving installed_plugins.json stuck on
  // the old version forever (the app would retry the "upgrade" every
  // launch). Leaving `.old-<id>-<pid>` behind is harmless clutter, not a
  // correctness problem, so this is swallowed rather than surfaced.
  try {
    fs.rmSync(retired, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup only — see WHY above */
  }
  // Register with the REAL version read off the newly-swapped-in disk copy,
  // not a hardcoded '1.0.0' — this is the whole point of the upgrade path.
  const version = readPluginVersion(targetDir) ?? '1.0.0';
  try {
    await registerPluginInstall({ id, installPath: targetDir, version });
  } catch (err: any) {
    return { status: 'failed', error: `Registry write failed: ${err?.message || String(err)}` };
  }
  return { status: 'installed' };
}

/**
 * Fix (Track B final review, Finding F1): remove stale `.old-<id>-<pid>` /
 * `.upgrade-<id>-<pid>` directories left behind by an upgradePluginFromLocal()
 * that was killed mid-swap. Name-PREFIX match only (`.old-` / `.upgrade-`,
 * not the full name) — desktop's staging names carry a `-<pid>` suffix that
 * a kill leaves permanently mismatched with the current process's pid, so an
 * exact-name check would never find it. Deliberately narrow so a real
 * plugin id — which SAFE_ID_RE forbids from starting with "." — can never be
 * swept by mistake. Matches Android's LocalSkillProvider.sweepStaleUpgradeDirs()
 * (Task B5 review round 2, Finding 1b).
 */
export function sweepStaleUpgradeDirs(): void {
  let children: fs.Dirent[];
  try {
    children = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
  } catch {
    return; // directory doesn't exist yet — nothing to sweep
  }
  for (const child of children) {
    if (!child.isDirectory()) continue;
    if (!child.name.startsWith('.old-') && !child.name.startsWith('.upgrade-')) continue;
    const target = path.join(PLUGINS_DIR, child.name);
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (err: any) {
      console.warn(`[plugin-installer] could not fully sweep stale ${child.name}: ${err?.message || String(err)}`);
    }
  }
}

// After a `--depth 1` clone, HEAD is whatever the default branch is right now;
// the catalog listed (and scanned) one specific commit. GitHub serves any
// reachable sha to a shallow fetch, so fetch that sha and detach onto it.
// On failure git's own output is returned untouched — "unknown sha" and
// "network is down" read completely differently and the user must see which.
export async function pinToCommit(dir: string, commit: string): Promise<{ ok: boolean; output: string; commit?: string }> {
  const fetched = await runGit('-C', dir, 'fetch', '--depth', '1', 'origin', commit);
  if (!fetched.ok) return fetched;
  const checked = await runGit('-C', dir, 'checkout', '--detach', commit);
  if (!checked.ok) return checked;
  // Report the FULL sha we landed on: the package record stores it and the
  // marketplace's Update check reads it back against the catalog's sourceCommit,
  // which is a full sha — comparing a short sha to a full one never matches.
  const head = await runGit('-C', dir, 'rev-parse', 'HEAD');
  return { ok: true, output: checked.output, commit: head.ok ? head.output.trim() : commit };
}

async function installFromUrl(id: string, url: string, commit?: string, targetOverride?: string): Promise<InstallResult> {
  // Security: only allow HTTPS git URLs to prevent ext::, file://, ssh:// attacks
  if (!url.startsWith('https://')) {
    return { status: 'failed', error: 'Only HTTPS git URLs are supported' };
  }
  // targetOverride lets upgradePluginFromGit clone into a STAGING directory so a
  // failed update never touches the copy the user already has installed.
  const targetDir = targetOverride ?? path.join(PLUGINS_DIR, id);
  if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });

  const { ok, output } = await runGit('clone', '--depth', '1', url, targetDir);
  if (!ok) return { status: 'failed', error: `git clone failed: ${output.slice(0, 200)}` };
  if (commit) {
    const pinned = await pinToCommit(targetDir, commit);
    if (!pinned.ok) return { status: 'failed', error: `could not check out the listed version ${commit}: ${pinned.output.slice(0, 200)}` };
    return { status: 'installed', commit: pinned.commit };
  }
  return { status: 'installed' };
}

async function installFromGitSubdir(id: string, repoUrl: string, subdir: string, commit?: string, targetOverride?: string): Promise<InstallResult> {
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

    // Pin AFTER the sparse paths are configured, never before: `checkout --detach`
    // materialises whatever the sparse config allows at that moment, so pinning
    // first would defeat the sparse clone and pull down the whole tree.
    let pinnedCommit: string | undefined;
    if (commit) {
      const pinned = await pinToCommit(tmpDir, commit);
      if (!pinned.ok) return { status: 'failed', error: `could not check out the listed version ${commit}: ${pinned.output.slice(0, 200)}` };
      pinnedCommit = pinned.commit;
    }

    const sourceDir = path.join(tmpDir, subdir);
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      return { status: 'failed', error: `Subdirectory not found after checkout: ${subdir}` };
    }

    // See installFromUrl: targetOverride is the staging path used by upgrades.
    const targetDir = targetOverride ?? path.join(PLUGINS_DIR, id);
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
    copyDirSync(sourceDir, targetDir);
    return { status: 'installed', commit: pinnedCommit };
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

    // Ensure the marketplace plugins dir exists — git clone and sparse checkout
    // both fail if parent dirs are missing.
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });

    // Guard: already installed via YouCoded
    const targetDir = path.join(PLUGINS_DIR, id);
    const dotJson = path.join(targetDir, '.claude-plugin', 'plugin.json');
    if (fs.existsSync(targetDir) && (fs.existsSync(dotJson) || fs.existsSync(path.join(targetDir, 'plugin.json')))) {
      return { status: 'already_installed', via: 'YouCoded' };
    }

    let result: InstallResult;
    switch (sourceType) {
      case 'local':
        // Phase 3a: pass sourceMarketplace so the installer clones the right repo.
        // Pass entry.version so the cache refreshes when a package bumped mid-TTL.
        result = await installFromLocal(id, sourceRef, entry.sourceMarketplace, entry.version);
        break;
      case 'url':
        result = await installFromUrl(id, sourceRef, entry.sourceCommit);
        break;
      case 'git-subdir':
        result = await installFromGitSubdir(id, sourceRef, entry.sourceSubdir || '', entry.sourceCommit);
        break;
      default:
        result = { status: 'failed', error: `Unknown source type: ${sourceType}` };
    }

    if (result.status === 'installed') {
      ensurePluginJson(id, entry);
      // Wire the plugin into Claude Code's four registries. Without this,
      // /reload-plugins reports "0 new plugins" because the loader never scans
      // the filesystem — it only iterates enabledPlugins from settings.json.
      try {
        await registerPluginInstall({
          id,
          installPath: path.join(PLUGINS_DIR, id),
          // WHY: read the version that just landed on disk first — installFromLocal
          // may have refreshed the cache to a newer copy than entry.version knew
          // about. Fall back to the marketplace entry, then a static default,
          // so Task B3's reconciler always has a real number to compare against
          // instead of a permanent, never-updating '1.0.0'.
          version: readPluginVersion(path.join(PLUGINS_DIR, id)) ?? entry.version ?? '1.0.0',
          description: entry.description,
          author: entry.author,
        });
      } catch (err: any) {
        return { status: 'failed', error: `Registry write failed: ${err?.message || String(err)}` };
      }
      // Decomposition v3 §9.5: run postInstall AFTER registry wiring so a
      // failing script never leaves orphan registry entries pointing at a
      // half-installed plugin. Gated on the trusted-org allowlist. Failures
      // log but don't fail the install — files and registry are already in
      // place.
      if (isPostInstallTrusted(entry)) {
        const { ok, output } = await runShell(entry.postInstall!, path.join(PLUGINS_DIR, id));
        if (!ok) {
          console.warn(`[plugin-installer] postInstall failed for ${id}: ${output.slice(0, 200)}`);
        }
      }
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
    // Remove from all four Claude Code registries first so /reload-plugins
    // stops trying to load a directory we're about to delete.
    try { await unregisterPluginInstall(id); } catch {}

    const targetDir = pluginInstallDir(id);
    // Double-check: resolved path must stay within plugins directory
    if (!isContainedIn(targetDir, PLUGINS_DIR)) return false;
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    // Clean up stale install locations from earlier YouCoded versions:
    //   (a) ~/.claude/plugins/<id>/                         (pre-registry)
    //   (b) ~/.claude/marketplaces/youcoded/plugins/<id>/ (first registry fix, wrong path)
    const legacyDirs = [
      path.join(os.homedir(), '.claude', 'plugins', id),
      path.join(os.homedir(), '.claude', 'marketplaces', 'youcoded', 'plugins', id),
    ];
    for (const legacyDir of legacyDirs) {
      const parent = path.dirname(legacyDir);
      if (fs.existsSync(legacyDir) && isContainedIn(legacyDir, parent)) {
        fs.rmSync(legacyDir, { recursive: true, force: true });
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function isPluginInstalled(id: string): boolean {
  if (!SAFE_ID_RE.test(id)) return false; // Security: reject invalid IDs
  const targetDir = pluginInstallDir(id);
  return fs.existsSync(targetDir) && (
    fs.existsSync(path.join(targetDir, '.claude-plugin', 'plugin.json')) ||
    fs.existsSync(path.join(targetDir, 'plugin.json'))
  );
}
