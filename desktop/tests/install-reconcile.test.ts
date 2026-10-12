import { describe, it, expect, vi, beforeEach } from 'vitest';

const listInstalledPluginDirs = vi.fn<() => string[]>();
const postInstalls = vi.fn();

vi.mock('../src/main/claude-code-registry', () => ({ listInstalledPluginDirs: () => listInstalledPluginDirs() }));
vi.mock('../src/renderer/state/marketplace-api-client', () => ({
  MARKETPLACE_API_HOST: 'https://example.invalid',
  createMarketplaceApiClient: () => ({ postInstalls }),
}));

import { installedPluginIds, installedMarketplaceIds, reconcileInstalls } from '../src/main/install-reconcile';

const store = (token: string | null) => ({ getToken: () => token }) as never;
const skillSource = (ids: string[]) => ({ getInstalled: async () => ids.map((id) => ({ id })) });

beforeEach(() => {
  listInstalledPluginDirs.mockReset().mockReturnValue([]);
  postInstalls.mockReset().mockResolvedValue({ ok: true, recorded: 0 });
});

describe('installedPluginIds', () => {
  it('takes the directory name as the id, from BOTH roots', () => {
    listInstalledPluginDirs.mockReturnValue([
      '/home/u/.claude/plugins/marketplaces/youcoded/plugins/civic-report',
      '/home/u/.claude/plugins/youcoded-core',
    ]);
    expect(installedPluginIds()).toEqual(['civic-report', 'youcoded-core']);
  });

  it('deduplicates an id that appears under both roots', () => {
    // listInstalledPluginDirs scans two roots; the pre-decomposition clone can
    // surface the same plugin twice. Sending it twice is harmless but wasteful.
    listInstalledPluginDirs.mockReturnValue(['/a/plugins/dup', '/b/youcoded/dup']);
    expect(installedPluginIds()).toEqual(['dup']);
  });

  it('includes BUNDLED plugins — the whole reason this exists', () => {
    listInstalledPluginDirs.mockReturnValue(['/p/wecoded-themes-plugin', '/p/youcoded-chatsearch']);
    expect(installedPluginIds()).toContain('wecoded-themes-plugin');
  });

  it('drops ids the server would reject, rather than failing the whole batch', () => {
    listInstalledPluginDirs.mockReturnValue([`/p/${'x'.repeat(129)}`, '/p/ok']);
    expect(installedPluginIds()).toEqual(['ok']);
  });
});

describe('reconcileInstalls', () => {
  it('reports every installed id in ONE call', async () => {
    listInstalledPluginDirs.mockReturnValue(['/p/a', '/p/b', '/p/wecoded-themes-plugin']);
    await reconcileInstalls(store('tok'));
    expect(postInstalls).toHaveBeenCalledTimes(1);
    expect(postInstalls).toHaveBeenCalledWith(['a', 'b', 'wecoded-themes-plugin']);
  });

  it('reports SKILL-level ids too — each has its own page and its own vote', async () => {
    // The bug this pins: reporting only plugin directories left every
    // `superpowers:brainstorming` page voting on an id with no install row, so
    // the gate refused a vote on a skill the user plainly has.
    listInstalledPluginDirs.mockReturnValue(['/p/superpowers']);
    await reconcileInstalls(store('tok'), skillSource(['superpowers:brainstorming', 'superpowers:writing-plans']));
    expect(postInstalls).toHaveBeenCalledWith([
      'superpowers', 'superpowers:brainstorming', 'superpowers:writing-plans',
    ]);
  });

  it('keeps the directory ids when the skill provider throws', async () => {
    listInstalledPluginDirs.mockReturnValue(['/p/a']);
    await reconcileInstalls(store('tok'), { getInstalled: async () => { throw new Error('scan failed'); } });
    expect(postInstalls).toHaveBeenCalledWith(['a']);
  });

  it('deduplicates when a skill id equals its plugin id', async () => {
    listInstalledPluginDirs.mockReturnValue(['/p/solo']);
    await reconcileInstalls(store('tok'), skillSource(['solo']));
    expect(postInstalls).toHaveBeenCalledWith(['solo']);
  });

  it('does nothing when signed out', async () => {
    listInstalledPluginDirs.mockReturnValue(['/p/a']);
    await reconcileInstalls(store(null));
    expect(postInstalls).not.toHaveBeenCalled();
  });

  it('does not call the server with an empty list', async () => {
    await reconcileInstalls(store('tok'));
    expect(postInstalls).not.toHaveBeenCalled();
  });

  it('NEVER throws — a failure must not break sign-in or startup', async () => {
    listInstalledPluginDirs.mockReturnValue(['/p/a']);
    postInstalls.mockRejectedValue(new Error('offline'));
    await expect(reconcileInstalls(store('tok'))).resolves.toBeUndefined();
  });

  it('survives the filesystem read itself throwing', async () => {
    listInstalledPluginDirs.mockImplementation(() => { throw new Error('EACCES'); });
    await expect(reconcileInstalls(store('tok'))).resolves.toBeUndefined();
    expect(postInstalls).not.toHaveBeenCalled();
  });

  it('caps the batch at the server limit', async () => {
    listInstalledPluginDirs.mockReturnValue(Array.from({ length: 250 }, (_, i) => `/p/p${i}`));
    await reconcileInstalls(store('tok'));
    expect(postInstalls.mock.calls[0]![0]).toHaveLength(200);
  });
});

describe('installedMarketplaceIds', () => {
  it('is plugin ids first, then skills, with no duplicates', async () => {
    listInstalledPluginDirs.mockReturnValue(['/p/superpowers', '/p/wecoded-themes-plugin']);
    expect(await installedMarketplaceIds(skillSource(['superpowers:brainstorming', 'superpowers']))).toEqual([
      'superpowers', 'wecoded-themes-plugin', 'superpowers:brainstorming',
    ]);
  });

  it('tolerates no skill source at all', async () => {
    listInstalledPluginDirs.mockReturnValue(['/p/a']);
    expect(await installedMarketplaceIds(null)).toEqual(['a']);
  });

  it('drops oversized skill ids rather than failing the batch', async () => {
    listInstalledPluginDirs.mockReturnValue([]);
    expect(await installedMarketplaceIds(skillSource(['ok', 'y'.repeat(129)]))).toEqual(['ok']);
  });
});
