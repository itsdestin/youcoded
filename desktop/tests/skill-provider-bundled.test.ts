import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BUNDLED_PLUGIN_IDS } from '../src/shared/bundled-plugins';

const inst = vi.hoisted(() => ({
  installPlugin: vi.fn(), upgradePluginFromLocal: vi.fn(), refreshLocalMarketplaceCache: vi.fn(),
  // update() now routes url / git-subdir sources to the git upgrade path — without
  // the export here the real call throws "not a function".
  upgradePluginFromGit: vi.fn(),
  readPluginVersion: vi.fn(), isPluginInstalled: vi.fn(),
  // Fix (Track B final review, Finding F1): reconcileBundledPlugins() now
  // sweeps stale .old-/.upgrade- litter at the top of every run — the mock
  // module needs the export or the real call throws "not a function".
  sweepStaleUpgradeDirs: vi.fn(),
  // Review fix (Finding 2): skill-provider.ts now imports marketplaceCacheDir
  // from plugin-installer instead of hand-building the cache path. Mirror the
  // real helper's shape (contains 'youcoded-marketplace-cache' + the source
  // ref) so the readPluginVersion mock below — which switches on that
  // substring — still tells an installed-tree read from a cache-clone read.
  marketplaceCacheDir: vi.fn((mp: string, sourceRef: string) => `/home/test/.claude/youcoded-marketplace-cache/${mp}/${sourceRef}`),
  // reconcileBundledPlugins() now reads/writes the app-version marker so the
  // first launch of a new app version forces a cache refresh. The mock module
  // needs both exports or the real call throws "not a function".
  // Explicit return type: `vi.fn(() => null)` infers `null`, which makes
  // mockReturnValue('1.2.0') a type error in the tests below.
  readLastReconciledAppVersion: vi.fn((): string | null => null),
  writeLastReconciledAppVersion: vi.fn(),
}));
vi.mock('../src/main/plugin-installer', () => inst);
// Mocked so F3/F9 tests can assert on log LEVEL (WARN vs ERROR) without the
// real logger's fire-and-forget fs.promises.appendFile touching the actual
// user's ~/.claude/desktop.log from the test process.
const loggerMock = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock('../src/main/logger', () => loggerMock);
import { LocalSkillProvider } from '../src/main/skill-provider';

const entry = (id: string, version: string) => ({ id, type: 'plugin', version, sourceType: 'local', sourceRef: id, sourceMarketplace: 'youcoded' });

describe('LocalSkillProvider.reconcileBundledPlugins', () => {
  let p: LocalSkillProvider; const versions: Record<string, string> = {};
  beforeEach(() => {
    vi.clearAllMocks(); delete process.env.YOUCODED_PROFILE; delete process.env.YOUCODED_BUNDLED_UPGRADE;
    p = new LocalSkillProvider();
    for (const k of Object.keys(versions)) delete versions[k];
    vi.spyOn(p as any, 'fetchIndex').mockResolvedValue(BUNDLED_PLUGIN_IDS.map((id) => entry(id, '1.0.0')));
    vi.spyOn(p.configStore, 'updatePackageVersion').mockImplementation((id: string, v: string) => { versions[id] = v; });
    inst.refreshLocalMarketplaceCache.mockResolvedValue({ ok: true, refreshed: true });
    inst.isPluginInstalled.mockReturnValue(true);
    inst.readPluginVersion.mockImplementation((dir: string) => dir.includes('youcoded-marketplace-cache') ? '0.2.0' : '0.1.0');
    inst.upgradePluginFromLocal.mockResolvedValue({ status: 'installed' });
    inst.installPlugin.mockResolvedValue({ status: 'installed' });
    inst.readLastReconciledAppVersion.mockReturnValue(null);
  });
  it('is a no-op on a dev instance unless overridden', async () => {
    process.env.YOUCODED_PROFILE = 'dev';
    expect((await p.reconcileBundledPlugins()).every((r) => r.action === 'skipped-dev')).toBe(true);
    expect(inst.refreshLocalMarketplaceCache).not.toHaveBeenCalled();
    process.env.YOUCODED_BUNDLED_UPGRADE = '1';
    expect((await p.reconcileBundledPlugins()).some((r) => r.action === 'upgraded')).toBe(true);
  });
  it('upgrades when the cache copy is newer and records the plugin.json version', async () => {
    const r = await p.reconcileBundledPlugins();
    expect(r.find((x) => x.id === 'youcoded-chatsearch')).toMatchObject({ action: 'upgraded', from: '0.1.0', to: '0.2.0' });
    expect(inst.upgradePluginFromLocal).toHaveBeenCalledWith('youcoded-chatsearch', 'youcoded-chatsearch', 'youcoded');
    expect(versions['youcoded-chatsearch']).toBe('0.2.0');
  });
  it('leaves an equal version alone', async () => {
    inst.readPluginVersion.mockReturnValue('0.2.0');
    expect((await p.reconcileBundledPlugins()).every((r) => r.action === 'unchanged')).toBe(true);
    expect(inst.upgradePluginFromLocal).not.toHaveBeenCalled();
  });
  it('forces a cache refresh on the first launch of a new app version, and records it', async () => {
    inst.readLastReconciledAppVersion.mockReturnValue('1.2.0');
    await p.reconcileBundledPlugins({ appVersion: '1.3.0' });
    expect(inst.refreshLocalMarketplaceCache).toHaveBeenCalledWith('youcoded', { force: true });
    expect(inst.writeLastReconciledAppVersion).toHaveBeenCalledWith('1.3.0');
  });
  it('does not force a refresh when the app version is unchanged', async () => {
    inst.readLastReconciledAppVersion.mockReturnValue('1.3.0');
    await p.reconcileBundledPlugins({ appVersion: '1.3.0' });
    expect(inst.refreshLocalMarketplaceCache).toHaveBeenCalledWith('youcoded', { force: false });
    expect(inst.writeLastReconciledAppVersion).not.toHaveBeenCalled();
  });
  it('records the app version even when the forced refresh fails, so it retries once not every launch', async () => {
    inst.readLastReconciledAppVersion.mockReturnValue('1.2.0');
    inst.refreshLocalMarketplaceCache.mockResolvedValue({ ok: false, refreshed: false, error: 'fetch failed: offline' });
    await p.reconcileBundledPlugins({ appVersion: '1.3.0' });
    expect(inst.writeLastReconciledAppVersion).toHaveBeenCalledWith('1.3.0');
  });
  it('never forces a refresh when no app version is supplied', async () => {
    await p.reconcileBundledPlugins();
    expect(inst.refreshLocalMarketplaceCache).toHaveBeenCalledWith('youcoded', { force: false });
    expect(inst.writeLastReconciledAppVersion).not.toHaveBeenCalled();
  });
  it('still compares against the last cache copy when the refresh fails', async () => {
    inst.refreshLocalMarketplaceCache.mockResolvedValue({ ok: false, refreshed: false, error: 'fetch failed: offline' });
    expect((await p.reconcileBundledPlugins()).find((x) => x.id === 'youcoded-chatsearch')?.action).toBe('upgraded');
  });
  it('installs a bundled id that is not installed, refetching the index once when it is absent', async () => {
    inst.isPluginInstalled.mockImplementation((id: string) => id !== 'youcoded-chatsearch');
    const fetchIndex = vi.spyOn(p as any, 'fetchIndex')
      .mockResolvedValueOnce(BUNDLED_PLUGIN_IDS.filter((id) => id !== 'youcoded-chatsearch').map((id) => entry(id, '1.0.0')))
      .mockResolvedValueOnce(BUNDLED_PLUGIN_IDS.map((id) => entry(id, '1.0.0')));
    // Review fix (Finding 3): the missing-id refetch now clears only the
    // index cache (invalidateIndexCache), not the broad invalidateCache —
    // which also wipes the marketplace's featured-rail and curated-defaults
    // caches. Assert the narrow method fires once, and the broad one never does.
    const invalidateIndex = vi.spyOn(p, 'invalidateIndexCache').mockResolvedValue();
    const invalidateBroad = vi.spyOn(p, 'invalidateCache').mockResolvedValue();
    const r = await p.reconcileBundledPlugins();
    expect(invalidateIndex).toHaveBeenCalledTimes(1);
    expect(invalidateBroad).not.toHaveBeenCalled();
    expect(fetchIndex).toHaveBeenCalledTimes(2);
    expect(r.find((x) => x.id === 'youcoded-chatsearch')?.action).toBe('installed');
  });
  it('refetches the missing-index at most once per process, even across two reconcile calls', async () => {
    // Review fix (Finding 3): a bundled id that is PERMANENTLY missing from
    // the index (its marketplace entry hasn't merged yet) must not
    // re-invalidate on every call in this process — only the first.
    inst.isPluginInstalled.mockImplementation((id: string) => id !== 'youcoded-chatsearch');
    vi.spyOn(p as any, 'fetchIndex').mockResolvedValue(
      BUNDLED_PLUGIN_IDS.filter((id) => id !== 'youcoded-chatsearch').map((id) => entry(id, '1.0.0')),
    );
    const invalidateIndex = vi.spyOn(p, 'invalidateIndexCache').mockResolvedValue();
    await p.reconcileBundledPlugins();
    await p.reconcileBundledPlugins();
    expect(invalidateIndex).toHaveBeenCalledTimes(1);
  });
  it('reports install failures instead of swallowing them', async () => {
    inst.isPluginInstalled.mockReturnValue(false);
    inst.installPlugin.mockResolvedValue({ status: 'failed', error: 'clone failed: boom' });
    expect((await p.reconcileBundledPlugins())[0]).toMatchObject({ action: 'failed', error: 'clone failed: boom' });
  });
  it('ensureBundledPluginsInstalled resolves even when reconcile throws', async () => {
    vi.spyOn(p, 'reconcileBundledPlugins').mockRejectedValue(new Error('network'));
    await expect(p.ensureBundledPluginsInstalled()).resolves.toBeUndefined();
  });

  // Fix (Track B final review, Finding F1): sweep runs for a real reconcile,
  // but never on the dev-instance skip path — a dev-mode launch must not
  // mutate the shared real ~/.claude install at all.
  it('sweeps stale upgrade dirs on a real reconcile, but not on the dev-instance skip path', async () => {
    await p.reconcileBundledPlugins();
    expect(inst.sweepStaleUpgradeDirs).toHaveBeenCalledTimes(1);

    inst.sweepStaleUpgradeDirs.mockClear();
    process.env.YOUCODED_PROFILE = 'dev';
    await p.reconcileBundledPlugins();
    expect(inst.sweepStaleUpgradeDirs).not.toHaveBeenCalled();
  });

  // Fix (Track B final review, Finding F3): readPluginVersion() returning
  // null after a successful install does not only mean an unreadable
  // manifest — ensurePluginJson() legitimately writes a manifest with no
  // version field. Falls back to the marketplace entry's version, records
  // the install, and reports 'installed' rather than a false 'failed'.
  it('falls back to the marketplace entry version and still records the install when plugin.json has no version field', async () => {
    inst.isPluginInstalled.mockReturnValue(false);
    inst.installPlugin.mockResolvedValue({ status: 'installed' });
    // Simulates ensurePluginJson()'s synthetic manifest — readable, no version key.
    inst.readPluginVersion.mockReturnValue(null);
    const recordPackageInstall = vi.spyOn(p.configStore, 'recordPackageInstall').mockImplementation(() => {});

    const r = await p.reconcileBundledPlugins();
    const row = r.find((x) => x.id === 'youcoded-chatsearch');
    expect(row).toMatchObject({ action: 'installed', to: '1.0.0' }); // entry(id, '1.0.0') from beforeEach
    expect(recordPackageInstall).toHaveBeenCalledWith('youcoded-chatsearch', expect.objectContaining({ version: '1.0.0' }));
    // Falling back is a warning, not a silent success and not an error.
    expect(loggerMock.log).toHaveBeenCalledWith('WARN', 'bundled-plugins', expect.stringContaining('falling back'), expect.anything());
  });

  it('reports a real failure when neither plugin.json nor the marketplace entry has a version', async () => {
    inst.isPluginInstalled.mockReturnValue(false);
    inst.installPlugin.mockResolvedValue({ status: 'installed' });
    inst.readPluginVersion.mockReturnValue(null);
    vi.spyOn(p as any, 'fetchIndex').mockResolvedValue(
      BUNDLED_PLUGIN_IDS.map((id) => ({ id, type: 'plugin', sourceType: 'local', sourceRef: id, sourceMarketplace: 'youcoded' })), // no version field at all
    );
    const recordPackageInstall = vi.spyOn(p.configStore, 'recordPackageInstall').mockImplementation(() => {});

    const r = await p.reconcileBundledPlugins();
    expect(r.find((x) => x.id === 'youcoded-chatsearch')).toMatchObject({ action: 'failed' });
    expect(recordPackageInstall).not.toHaveBeenCalled();
  });

  // Fix (Track B final review, Finding F9): guard order matches update()'s —
  // a Claude-Code-owned bundled id gets already_installed/via: 'Claude Code'
  // in the install branch too. This is a permanent, expected, non-actionable
  // conflict, not a bug in our own reconcile, so it must log at WARN, never
  // the ERROR every other 'failed' action gets.
  it('reports a Claude-Code-owned bundled id as failed with via carried through, and logs it at WARN not ERROR', async () => {
    inst.isPluginInstalled.mockReturnValue(false);
    inst.installPlugin.mockResolvedValue({ status: 'already_installed', via: 'Claude Code' });

    const results = await p.reconcileBundledPlugins();
    const row = results.find((x) => x.id === 'youcoded-chatsearch');
    expect(row).toMatchObject({ action: 'failed', via: 'Claude Code' });
    expect(row?.error).toMatch(/Claude Code/);

    vi.spyOn(p, 'reconcileBundledPlugins').mockResolvedValue(results);
    await p.ensureBundledPluginsInstalled();
    expect(loggerMock.log).toHaveBeenCalledWith('WARN', 'bundled-plugins', 'failed', expect.objectContaining({ via: 'Claude Code' }));
    expect(loggerMock.log).not.toHaveBeenCalledWith('ERROR', 'bundled-plugins', 'failed', expect.anything());
  });

  it('still logs a genuine install failure at ERROR, not WARN', async () => {
    inst.isPluginInstalled.mockReturnValue(false);
    inst.installPlugin.mockResolvedValue({ status: 'failed', error: 'clone failed: boom' });
    const results = await p.reconcileBundledPlugins();
    vi.spyOn(p, 'reconcileBundledPlugins').mockResolvedValue(results);
    await p.ensureBundledPluginsInstalled();
    expect(loggerMock.log).toHaveBeenCalledWith('ERROR', 'bundled-plugins', 'failed', expect.objectContaining({ error: 'clone failed: boom' }));
  });
});

// Fix (Track B final review, Finding F2): the launch reconcile only rewrites
// the three bundled ids' package records to the disk version — every other
// tracked package keeps a stale, permanently-wrong recorded version forever.
// repairPackageVersions() is the one-time-per-launch fix: disk is the source
// of truth for every tracked package, not just the bundled three.
describe('LocalSkillProvider.repairPackageVersions', () => {
  let p: LocalSkillProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    // A prior test in this file (or a prior run of this describe) may leave
    // YOUCODED_PROFILE set — reset it so these tests don't depend on run order.
    delete process.env.YOUCODED_PROFILE; delete process.env.YOUCODED_BUNDLED_UPGRADE;
    p = new LocalSkillProvider();
  });

  it('is a no-op on a dev instance unless overridden — shares configStore\'s real ~/.claude with the live app', async () => {
    process.env.YOUCODED_PROFILE = 'dev';
    const getPackages = vi.spyOn(p.configStore, 'getPackages');
    const updatePackageVersion = vi.spyOn(p.configStore, 'updatePackageVersion').mockImplementation(() => {});
    expect(await p.repairPackageVersions()).toEqual([]);
    expect(getPackages).not.toHaveBeenCalled();
    expect(updatePackageVersion).not.toHaveBeenCalled();
  });

  it('rewrites a package record whose recorded version disagrees with disk', async () => {
    vi.spyOn(p.configStore, 'getPackages').mockReturnValue({
      'civic-report': {
        version: '1.0.2', source: 'marketplace', installedAt: '2026-01-01T00:00:00.000Z', removable: true,
        components: [{ type: 'plugin', path: '/home/test/.claude/plugins/marketplaces/youcoded/plugins/civic-report' }],
      },
    });
    inst.readPluginVersion.mockReturnValue('0.1.0'); // real plugin.json version, per the reviewer's example
    const updatePackageVersion = vi.spyOn(p.configStore, 'updatePackageVersion').mockImplementation(() => {});

    const repaired = await p.repairPackageVersions();
    expect(updatePackageVersion).toHaveBeenCalledWith('civic-report', '0.1.0');
    expect(repaired).toEqual([{ id: 'civic-report', from: '1.0.2', to: '0.1.0' }]);
  });

  it('leaves a package alone when the recorded version already matches disk', async () => {
    vi.spyOn(p.configStore, 'getPackages').mockReturnValue({
      'youcoded-encyclopedia': {
        version: '1.0.1', source: 'marketplace', installedAt: '2026-01-01T00:00:00.000Z', removable: true,
        components: [{ type: 'plugin', path: '/home/test/.claude/plugins/marketplaces/youcoded/plugins/youcoded-encyclopedia' }],
      },
    });
    inst.readPluginVersion.mockReturnValue('1.0.1');
    const updatePackageVersion = vi.spyOn(p.configStore, 'updatePackageVersion').mockImplementation(() => {});

    const repaired = await p.repairPackageVersions();
    expect(updatePackageVersion).not.toHaveBeenCalled();
    expect(repaired).toEqual([]);
  });

  it('skips a non-plugin package (no plugin component) without touching it', async () => {
    vi.spyOn(p.configStore, 'getPackages').mockReturnValue({
      'theme:midnight': {
        version: '1.0.0', source: 'marketplace', installedAt: '2026-01-01T00:00:00.000Z', removable: true,
        components: [{ type: 'theme', path: '/home/test/.claude/themes/midnight' }],
      },
    });
    const updatePackageVersion = vi.spyOn(p.configStore, 'updatePackageVersion').mockImplementation(() => {});

    const repaired = await p.repairPackageVersions();
    expect(updatePackageVersion).not.toHaveBeenCalled();
    expect(repaired).toEqual([]);
  });

  it('never throws out of the launch path, even when configStore explodes', async () => {
    vi.spyOn(p.configStore, 'getPackages').mockImplementation(() => { throw new Error('disk error'); });
    await expect(p.repairPackageVersions()).resolves.toEqual([]);
  });

  it('repairs one package and keeps going even when another package throws mid-loop', async () => {
    vi.spyOn(p.configStore, 'getPackages').mockReturnValue({
      broken: {
        version: '1.0.0', source: 'marketplace', installedAt: '2026-01-01T00:00:00.000Z', removable: true,
        components: [{ type: 'plugin', path: '/broken' }],
      },
      'civic-report': {
        version: '1.0.2', source: 'marketplace', installedAt: '2026-01-01T00:00:00.000Z', removable: true,
        components: [{ type: 'plugin', path: '/civic-report' }],
      },
    });
    inst.readPluginVersion.mockImplementation((dir: string) => {
      if (dir === '/broken') throw new Error('EACCES');
      return '0.1.0';
    });
    const updatePackageVersion = vi.spyOn(p.configStore, 'updatePackageVersion').mockImplementation(() => {});

    const repaired = await p.repairPackageVersions();
    expect(updatePackageVersion).toHaveBeenCalledTimes(1);
    expect(updatePackageVersion).toHaveBeenCalledWith('civic-report', '0.1.0');
    expect(repaired).toEqual([{ id: 'civic-report', from: '1.0.2', to: '0.1.0' }]);
  });

  // Fix (Track B minor hardening review): a record written by the legacy
  // v1->v2 migration (skill-config-store.ts's migrateV1toV2) defaults its
  // component path to ~/.claude/plugins/<id> when the old config had no
  // installPath — a path that does not exist for a marketplace-installed
  // plugin. Before this fix, readPluginVersion(pluginComponent.path) on that
  // dead path returned null and the record was skipped forever. It must
  // fall back to resolvePluginDir(id), which also checks the marketplace
  // subtree (~/.claude/plugins/marketplaces/youcoded/plugins/<id>) where the
  // plugin is actually installed.
  //
  // resolvePluginDir() calls the real fs.existsSync against a real HOME dir
  // (it isn't routed through the mocked plugin-installer module), so this
  // test uses a real tmp HOME + real files, matching the pattern in
  // claude-code-registry-listing.test.ts, rather than mocking 'fs' (vitest
  // can't spy on an ESM module's named export — "Module namespace is not
  // configurable in ESM").
  it('falls back to resolvePluginDir when the recorded component path is a dead legacy path', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-repair-legacy-path-'));
    try {
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      // WHY: skill-provider.ts computes CLAUDE_PLUGINS_ROOT from os.homedir()
      // at import time — resetModules() + a dynamic re-import is required to
      // pick up the fake HOME, same as claude-code-registry-listing.test.ts.
      vi.resetModules();
      const { LocalSkillProvider: FreshProvider } = await import('../src/main/skill-provider');
      const fresh = new FreshProvider();

      // Real marketplace-subtree install — the only place the plugin
      // actually exists on disk. Nothing is created at the legacy path
      // (~/.claude/plugins/legacy-plugin), which is also resolvePluginDir's
      // own first ("top-level toolkit") candidate, so both miss.
      const marketplacePath = path.join(home, '.claude', 'plugins', 'marketplaces', 'youcoded', 'plugins', 'legacy-plugin');
      fs.mkdirSync(marketplacePath, { recursive: true });
      const legacyPath = path.join(home, '.claude', 'plugins', 'legacy-plugin');

      vi.spyOn(fresh.configStore, 'getPackages').mockReturnValue({
        'legacy-plugin': {
          version: '1.0.0', source: 'marketplace', installedAt: '2026-01-01T00:00:00.000Z', removable: true,
          components: [{ type: 'plugin', path: legacyPath }],
        },
      });
      inst.readPluginVersion.mockImplementation((dir: string) => (dir === marketplacePath ? '2.0.0' : null));
      const updatePackageVersion = vi.spyOn(fresh.configStore, 'updatePackageVersion').mockImplementation(() => {});

      const repaired = await fresh.repairPackageVersions();
      expect(updatePackageVersion).toHaveBeenCalledWith('legacy-plugin', '2.0.0');
      expect(repaired).toEqual([{ id: 'legacy-plugin', from: '1.0.0', to: '2.0.0' }]);
    } finally {
      process.env.HOME = origHome;
      if (origUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUserProfile;
      fs.rmSync(home, { recursive: true, force: true });
      vi.resetModules();
    }
  });
});

// Review fix (Finding 4): update() had zero test coverage — Finding 1 (a
// missing via check that could create a duplicate install) is exactly the
// kind of bug that gap let through.
describe('LocalSkillProvider.update', () => {
  let p: LocalSkillProvider;
  const versions: Record<string, string> = {};
  beforeEach(() => {
    vi.clearAllMocks();
    p = new LocalSkillProvider();
    for (const k of Object.keys(versions)) delete versions[k];
    vi.spyOn(p.configStore, 'updatePackageVersion').mockImplementation((id: string, v: string) => { versions[id] = v; });
    inst.readPluginVersion.mockReturnValue('2.0.0');
  });

  it('replaces the tree and records the disk version when already_installed via YouCoded on a local source', async () => {
    vi.spyOn(p as any, 'fetchIndex').mockResolvedValue([entry('youcoded-chatsearch', '1.0.0')]);
    inst.installPlugin.mockResolvedValue({ status: 'already_installed', via: 'YouCoded' });
    inst.upgradePluginFromLocal.mockResolvedValue({ status: 'installed' });
    const r = await p.update('youcoded-chatsearch');
    expect(inst.upgradePluginFromLocal).toHaveBeenCalledWith('youcoded-chatsearch', 'youcoded-chatsearch', 'youcoded');
    expect(r).toMatchObject({ ok: true, newVersion: '2.0.0' });
    expect(versions['youcoded-chatsearch']).toBe('2.0.0');
  });

  it('does not call upgradePluginFromLocal for a url-sourced plugin', async () => {
    const urlEntry = { id: 'ext-plugin', type: 'plugin', version: '1.0.0', sourceType: 'url', sourceRef: 'https://example.com/ext.git', sourceMarketplace: 'youcoded' };
    vi.spyOn(p as any, 'fetchIndex').mockResolvedValue([urlEntry]);
    inst.installPlugin.mockResolvedValue({ status: 'already_installed', via: 'YouCoded' });
    inst.upgradePluginFromGit.mockResolvedValue({ status: 'installed', commit: 'f'.repeat(40) });
    const r = await p.update('ext-plugin');
    expect(inst.upgradePluginFromLocal).not.toHaveBeenCalled();
    // …but the GIT upgrade must fire. installPlugin answers 'already_installed'
    // before it reaches any clone, so without this the update rewrote nothing —
    // the case that covers 237 of the 302 live registry entries.
    expect(inst.upgradePluginFromGit).toHaveBeenCalled();
    expect(r.ok).toBe(true);
  });

  it('does not call upgradePluginFromLocal for a git-subdir-sourced plugin', async () => {
    const subdirEntry = { id: 'ext-plugin', type: 'plugin', version: '1.0.0', sourceType: 'git-subdir', sourceRef: 'https://example.com/ext.git', sourceSubdir: 'sub', sourceMarketplace: 'youcoded' };
    vi.spyOn(p as any, 'fetchIndex').mockResolvedValue([subdirEntry]);
    inst.installPlugin.mockResolvedValue({ status: 'already_installed', via: 'YouCoded' });
    inst.upgradePluginFromGit.mockResolvedValue({ status: 'installed', commit: 'f'.repeat(40) });
    const r = await p.update('ext-plugin');
    expect(inst.upgradePluginFromLocal).not.toHaveBeenCalled();
    expect(inst.upgradePluginFromGit).toHaveBeenCalled();
    expect(r.ok).toBe(true);
  });

  it('a failed git upgrade reports the real error and does NOT claim success', async () => {
    const urlEntry = { id: 'ext-plugin', type: 'plugin', version: '1.0.0', sourceType: 'url', sourceRef: 'https://example.com/ext.git', sourceMarketplace: 'youcoded' };
    vi.spyOn(p as any, 'fetchIndex').mockResolvedValue([urlEntry]);
    inst.installPlugin.mockResolvedValue({ status: 'already_installed', via: 'YouCoded' });
    inst.upgradePluginFromGit.mockResolvedValue({ status: 'failed', error: 'fatal: could not read from remote repository' });
    const r = await p.update('ext-plugin');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('could not read from remote repository');
  });

  it('reports a failure, not success, when the plugin is installed via Claude Code', async () => {
    // Finding 1: this is the regression itself — installPlugin's local-source
    // branch would otherwise fall through and write a SECOND copy under
    // YOUCODED_PLUGINS_DIR for an id Claude Code already owns.
    vi.spyOn(p as any, 'fetchIndex').mockResolvedValue([entry('youcoded-chatsearch', '1.0.0')]);
    inst.installPlugin.mockResolvedValue({ status: 'already_installed', via: 'Claude Code' });
    const r = await p.update('youcoded-chatsearch');
    expect(inst.upgradePluginFromLocal).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Claude Code/);
    expect(p.configStore.updatePackageVersion).not.toHaveBeenCalled();
  });

  it('returns a failure without bumping the recorded version when the upgrade fails', async () => {
    vi.spyOn(p as any, 'fetchIndex').mockResolvedValue([entry('youcoded-chatsearch', '1.0.0')]);
    inst.installPlugin.mockResolvedValue({ status: 'already_installed', via: 'YouCoded' });
    inst.upgradePluginFromLocal.mockResolvedValue({ status: 'failed', error: 'disk full' });
    const r = await p.update('youcoded-chatsearch');
    expect(r).toMatchObject({ ok: false, error: 'disk full' });
    expect(p.configStore.updatePackageVersion).not.toHaveBeenCalled();
  });

  it('records the version read off disk, not the marketplace index version', async () => {
    vi.spyOn(p as any, 'fetchIndex').mockResolvedValue([entry('youcoded-chatsearch', '1.0.0')]);
    inst.installPlugin.mockResolvedValue({ status: 'already_installed', via: 'YouCoded' });
    inst.upgradePluginFromLocal.mockResolvedValue({ status: 'installed' });
    inst.readPluginVersion.mockReturnValue('1.5.2');
    const r = await p.update('youcoded-chatsearch');
    expect(r.newVersion).toBe('1.5.2');
    expect(versions['youcoded-chatsearch']).toBe('1.5.2');
  });
});
