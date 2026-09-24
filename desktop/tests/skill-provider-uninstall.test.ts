// LocalSkillProvider.uninstall()'s project-extensions cascade (technical
// design 2026-09-24 §2): removing a plugin must tombstone it in every
// project record that has it, so "needs setup" never offers to reinstall
// something the user deliberately removed. Mocked at the module boundary —
// the cascade's OWN correctness is pinned by project-extensions-store.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const inst = vi.hoisted(() => ({
  installPlugin: vi.fn(), upgradePluginFromLocal: vi.fn(), refreshLocalMarketplaceCache: vi.fn(),
  upgradePluginFromGit: vi.fn(), readPluginVersion: vi.fn(), isPluginInstalled: vi.fn(),
  sweepStaleUpgradeDirs: vi.fn(), marketplaceCacheDir: vi.fn(),
  uninstallPlugin: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/main/plugin-installer', () => inst);

const loggerMock = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock('../src/main/logger', () => loggerMock);

const rootsMock = vi.hoisted(() => ({ getManagedRoots: vi.fn() }));
vi.mock('../src/main/sync-spaces/service', () => rootsMock);

const storeMock = vi.hoisted(() => ({ markPluginRemoved: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/main/project-extensions/store', () => storeMock);

import { LocalSkillProvider } from '../src/main/skill-provider';

describe('LocalSkillProvider.uninstall — project-extensions cascade', () => {
  let p: LocalSkillProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    p = new LocalSkillProvider();
    vi.spyOn(p.configStore, 'getInstalledPlugins').mockReturnValue({ 'civic-report': {} });
    vi.spyOn(p.configStore, 'removePluginInstall').mockImplementation(() => {});
  });

  it('cascades into project-extensions when sync-spaces has started', async () => {
    rootsMock.getManagedRoots.mockReturnValue({ personalRoot: '/fake/Personal' });
    await p.uninstall('civic-report');
    expect(storeMock.markPluginRemoved).toHaveBeenCalledTimes(1);
    const [stores, pluginId] = storeMock.markPluginRemoved.mock.calls[0];
    expect(pluginId).toBe('civic-report');
    expect(stores.personalRoot).toBe('/fake/Personal');
  });

  it('skips the cascade (without failing the uninstall) when sync-spaces has not started yet', async () => {
    rootsMock.getManagedRoots.mockReturnValue(null);
    const result = await p.uninstall('civic-report');
    expect(result).toEqual({ type: 'plugin' });
    expect(storeMock.markPluginRemoved).not.toHaveBeenCalled();
  });

  it('never fails the uninstall when the cascade write throws', async () => {
    rootsMock.getManagedRoots.mockReturnValue({ personalRoot: '/fake/Personal' });
    storeMock.markPluginRemoved.mockRejectedValueOnce(new Error('lock timeout'));
    const result = await p.uninstall('civic-report');
    expect(result).toEqual({ type: 'plugin' });
    expect(loggerMock.log).toHaveBeenCalledWith('WARN', 'project-extensions', expect.stringContaining('civic-report'), expect.anything());
  });
});
