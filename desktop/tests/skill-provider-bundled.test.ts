import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalSkillProvider } from '../src/main/skill-provider';
import { BUNDLED_PLUGIN_IDS } from '../src/shared/bundled-plugins';

describe('LocalSkillProvider.ensureBundledPluginsInstalled', () => {
  let provider: LocalSkillProvider;

  beforeEach(() => {
    provider = new LocalSkillProvider();
  });

  it('calls installMany with the bundled IDs', async () => {
    const installMany = vi.spyOn(provider, 'installMany').mockResolvedValue([]);
    await provider.ensureBundledPluginsInstalled();
    expect(installMany).toHaveBeenCalledWith([...BUNDLED_PLUGIN_IDS]);
  });

  it('swallows errors from installMany and resolves void', async () => {
    vi.spyOn(provider, 'installMany').mockRejectedValue(new Error('network'));
    await expect(provider.ensureBundledPluginsInstalled()).resolves.toBeUndefined();
  });
});
