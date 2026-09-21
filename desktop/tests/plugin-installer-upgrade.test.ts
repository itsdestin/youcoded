import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

let home: string; let origHome: string | undefined;
const w = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
// The cache ROOT (holds the per-marketplace clones and the app-version marker).
const cacheRoot = () => path.join(home, '.claude', 'youcoded-marketplace-cache');
const cacheDir = () => path.join(cacheRoot(), 'wecoded-marketplace');
const pluginsDir = () => path.join(home, '.claude', 'plugins', 'marketplaces', 'youcoded', 'plugins');

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-upgrade-')); origHome = process.env.HOME;
  process.env.HOME = home; process.env.USERPROFILE = home; vi.resetModules();
});
afterEach(() => { process.env.HOME = origHome; delete process.env.USERPROFILE; fs.rmSync(home, { recursive: true, force: true }); });

describe('plugin-installer upgrade primitives', () => {
  it('readPluginVersion reads root or .claude-plugin manifests', async () => {
    const { readPluginVersion } = await import('../src/main/plugin-installer');
    w(path.join(home, 'a', 'plugin.json'), '{"version":"0.2.0"}');
    w(path.join(home, 'b', '.claude-plugin', 'plugin.json'), '{"version":"3.0.0"}');
    expect(readPluginVersion(path.join(home, 'a'))).toBe('0.2.0');
    expect(readPluginVersion(path.join(home, 'b'))).toBe('3.0.0');
    expect(readPluginVersion(path.join(home, 'c'))).toBeNull();
  });
  it('refreshLocalMarketplaceCache skips the network inside the 1 h gate', async () => {
    const { refreshLocalMarketplaceCache } = await import('../src/main/plugin-installer');
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(path.join(cacheDir(), '.youcoded-last-pull'), String(Date.now())); // the file setCacheTimestamp writes (:218)
    expect(await refreshLocalMarketplaceCache('youcoded')).toEqual({ ok: true, refreshed: false });
  });
  it('refreshLocalMarketplaceCache force bypasses the 1 h gate', async () => {
    const { refreshLocalMarketplaceCache } = await import('../src/main/plugin-installer');
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(path.join(cacheDir(), '.youcoded-last-pull'), String(Date.now()));
    // Force must NOT short-circuit on the fresh timestamp. There is no git repo
    // at this path, so the fetch fails — which is the point: reaching `fetch`
    // at all is what proves the gate was bypassed, and the failure is reported
    // honestly rather than swallowed.
    const r = await refreshLocalMarketplaceCache('youcoded', { force: true });
    expect(r.refreshed).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/fetch failed/);
  });
  it('the app-version marker round-trips and is null when absent', async () => {
    const mod = await import('../src/main/plugin-installer');
    expect(mod.readLastReconciledAppVersion()).toBeNull();
    mod.writeLastReconciledAppVersion('1.3.0');
    expect(mod.readLastReconciledAppVersion()).toBe('1.3.0');
    // Lives in the cache root, never under the plugins dir — otherwise
    // listInstalledPluginDirs() would read it as plugin content.
    expect(fs.existsSync(path.join(cacheRoot(), '.youcoded-last-reconciled-app-version'))).toBe(true);
    expect(fs.existsSync(path.join(pluginsDir(), '.youcoded-last-reconciled-app-version'))).toBe(false);
  });
  it('upgradePluginFromLocal swaps the tree and registers the real version', async () => {
    const mod = await import('../src/main/plugin-installer');
    w(path.join(cacheDir(), 'youcoded-chatsearch', 'plugin.json'), '{"name":"youcoded-chatsearch","version":"0.2.0"}');
    w(path.join(cacheDir(), 'youcoded-chatsearch', 'skills', 'x', 'SKILL.md'), 'new');
    w(path.join(pluginsDir(), 'youcoded-chatsearch', 'plugin.json'), '{"name":"youcoded-chatsearch","version":"0.1.0"}');
    w(path.join(pluginsDir(), 'youcoded-chatsearch', 'stale.txt'), 'gone after upgrade');
    const r = await mod.upgradePluginFromLocal('youcoded-chatsearch', 'youcoded-chatsearch', 'youcoded');
    expect(r.status).toBe('installed');
    expect(fs.existsSync(path.join(pluginsDir(), 'youcoded-chatsearch', 'stale.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(pluginsDir(), 'youcoded-chatsearch', 'skills', 'x', 'SKILL.md'), 'utf8')).toBe('new');
    const db = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    expect(db.plugins['youcoded-chatsearch@youcoded'][0].version).toBe('0.2.0');
    expect(fs.readdirSync(pluginsDir()).filter((n) => n.startsWith('.'))).toEqual([]);
  });
  it('upgradePluginFromLocal fails honestly when the cache has no such plugin', async () => {
    const mod = await import('../src/main/plugin-installer');
    fs.mkdirSync(cacheDir(), { recursive: true });
    const r = await mod.upgradePluginFromLocal('nope', 'nope', 'youcoded');
    expect(r.status).toBe('failed'); if (r.status === 'failed') expect(r.error).toMatch(/Source not found in cache: nope/);
  });
  // Review finding 2: the "never leave the user with no plugin" guarantee is
  // the entire reason upgradePluginFromLocal stages into a temp dir instead
  // of deleting-then-copying — nothing exercised the actual crash-mid-swap
  // restore path until this test.
  it('restores the old tree, reports failed, and cleans up staging when the swap dies mid-rename', async () => {
    const mod = await import('../src/main/plugin-installer');
    w(path.join(cacheDir(), 'youcoded-chatsearch', 'plugin.json'), '{"name":"youcoded-chatsearch","version":"0.2.0"}');
    w(path.join(cacheDir(), 'youcoded-chatsearch', 'skills', 'x', 'SKILL.md'), 'new');
    w(path.join(pluginsDir(), 'youcoded-chatsearch', 'plugin.json'), '{"name":"youcoded-chatsearch","version":"0.1.0"}');
    w(path.join(pluginsDir(), 'youcoded-chatsearch', 'original.txt'), 'still here');

    const realRename = fs.renameSync;
    let renameCalls = 0;
    // First renameSync call (live tree -> retired) must go through for real so
    // the retired copy actually exists to restore from; the SECOND call
    // (staging -> live) is the one that throws, simulating e.g. a Windows
    // handle still open on a file in the tree being replaced.
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      renameCalls += 1;
      if (renameCalls === 2) throw new Error('EPERM: simulated rename failure mid-swap');
      return (realRename as (f: fs.PathLike, t: fs.PathLike) => void)(from, to);
    }) as typeof fs.renameSync);

    try {
      const r = await mod.upgradePluginFromLocal('youcoded-chatsearch', 'youcoded-chatsearch', 'youcoded');
      expect(r.status).toBe('failed');
      if (r.status === 'failed') expect(r.error).toMatch(/EPERM: simulated rename failure mid-swap/);
      // Old plugin tree is back at its original path with its original contents.
      expect(fs.existsSync(path.join(pluginsDir(), 'youcoded-chatsearch', 'original.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(pluginsDir(), 'youcoded-chatsearch', 'plugin.json'), 'utf8')).toBe(
        '{"name":"youcoded-chatsearch","version":"0.1.0"}',
      );
      // Staging directory was cleaned up, and no retired dir left behind either.
      expect(fs.readdirSync(pluginsDir()).filter((n) => n.startsWith('.'))).toEqual([]);
    } finally {
      renameSpy.mockRestore();
    }
  });
  // Review finding 1: cleanup of the retired (old) tree happens AFTER the
  // swap already succeeded, so a failure there must not be reported as an
  // upgrade failure, and must not skip registering the new version.
  it('still reports installed with the new version when only retired-tree cleanup fails', async () => {
    const mod = await import('../src/main/plugin-installer');
    w(path.join(cacheDir(), 'youcoded-chatsearch', 'plugin.json'), '{"name":"youcoded-chatsearch","version":"0.2.0"}');
    w(path.join(pluginsDir(), 'youcoded-chatsearch', 'plugin.json'), '{"name":"youcoded-chatsearch","version":"0.1.0"}');

    const realRm = fs.rmSync;
    // Only the retired-tree removal (`.old-<id>-<pid>`) throws; the staging
    // cleanup at the top of the function must still run for real, or this
    // test can't tell the two rmSync call sites apart.
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(((target: fs.PathLike, opts?: fs.RmOptions) => {
      if (String(target).includes(`${path.sep}.old-youcoded-chatsearch-`)) {
        throw new Error('EBUSY: simulated retired-tree cleanup failure');
      }
      return (realRm as (t: fs.PathLike, o?: fs.RmOptions) => void)(target, opts);
    }) as typeof fs.rmSync);

    try {
      const r = await mod.upgradePluginFromLocal('youcoded-chatsearch', 'youcoded-chatsearch', 'youcoded');
      expect(r.status).toBe('installed');
      expect(fs.readFileSync(path.join(pluginsDir(), 'youcoded-chatsearch', 'plugin.json'), 'utf8')).toBe(
        '{"name":"youcoded-chatsearch","version":"0.2.0"}',
      );
      const db = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
      expect(db.plugins['youcoded-chatsearch@youcoded'][0].version).toBe('0.2.0');
    } finally {
      rmSpy.mockRestore();
    }
  });

  // Fix (Track B final review, Finding F1): sweepStaleUpgradeDirs() clears
  // litter a killed mid-swap upgradePluginFromLocal() leaves behind. Mirrors
  // Android's LocalSkillProvider.sweepStaleUpgradeDirs() tests.
  it('sweepStaleUpgradeDirs removes stale .old-/.upgrade- dirs, leaving the real plugin and a same-prefix decoy untouched', async () => {
    const { sweepStaleUpgradeDirs } = await import('../src/main/plugin-installer');
    w(path.join(pluginsDir(), 'youcoded-chatsearch', 'plugin.json'), '{"name":"youcoded-chatsearch","version":"0.2.0"}');
    w(path.join(pluginsDir(), '.old-youcoded-chatsearch-4242', 'plugin.json'), '{"name":"youcoded-chatsearch","version":"0.1.0"}');
    w(path.join(pluginsDir(), '.upgrade-youcoded-chatsearch-4242', 'plugin.json'), '{"name":"youcoded-chatsearch","version":"0.2.0"}');
    // A real plugin legitimately named "old-fashioned-plugin" — no leading
    // dot, so name-PREFIX matching on ".old-" must not touch it.
    w(path.join(pluginsDir(), 'old-fashioned-plugin', 'plugin.json'), '{"name":"old-fashioned-plugin","version":"1.0.0"}');

    sweepStaleUpgradeDirs();

    const remaining = fs.readdirSync(pluginsDir()).sort();
    expect(remaining).toEqual(['old-fashioned-plugin', 'youcoded-chatsearch']);
  });

  it('sweepStaleUpgradeDirs is a no-op when the plugins dir does not exist yet', async () => {
    const { sweepStaleUpgradeDirs } = await import('../src/main/plugin-installer');
    expect(() => sweepStaleUpgradeDirs()).not.toThrow();
  });
});
