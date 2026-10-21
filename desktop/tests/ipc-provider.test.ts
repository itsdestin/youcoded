import { describe, it, expect, vi } from 'vitest';
import { providerListWithCounts } from '../src/main/ipc/provider';

const row = (id: string, type: string) => ({ id, type, label: id, enabled: true, builtIn: false, hasKey: true, ready: true });

describe('the Providers screen list carries model counts from cached data', () => {
  it('adds a count where the catalog has one and leaves the rest unknown', async () => {
    const rt = {
      providerRegistry: { list: async () => [row('a', 'openai'), row('b', 'openai-compatible')] },
      modelCatalog: { cachedCounts: vi.fn(() => new Map([['a', { count: 17, source: 'catalog' as const }]])), get: vi.fn(async () => []) },
    };
    const out = await providerListWithCounts(rt as any);
    expect(out[0]).toMatchObject({ id: 'a', models: { count: 17, source: 'catalog' } });
    expect(out[1].models).toBeUndefined();
  });
  it('warms the catalog in the background when a counted provider has no number yet, without waiting for it', async () => {
    let finish!: () => void;
    const get = vi.fn(() => new Promise<never[]>((r) => { finish = () => r([]); }));
    const rt = {
      providerRegistry: { list: async () => [row('b', 'openai-compatible'), row('local', 'local-engine')] },
      modelCatalog: { cachedCounts: () => new Map(), get },
    };
    // Resolves although get() has not: the screen never waits on the network.
    expect(await providerListWithCounts(rt as any)).toHaveLength(2);
    expect(get).toHaveBeenCalledWith([row('b', 'openai-compatible')]);
    finish();
  });
  it('does not warm anything when every counted provider already has a number', async () => {
    const get = vi.fn(async () => []);
    const rt = {
      providerRegistry: { list: async () => [row('a', 'openai'), row('local', 'local-engine')] },
      modelCatalog: { cachedCounts: () => new Map([['a', { count: 1, source: 'catalog' as const }]]), get },
    };
    await providerListWithCounts(rt as any);
    expect(get).not.toHaveBeenCalled();
  });
  it('a failing count read still returns the list', async () => {
    const rt = {
      providerRegistry: { list: async () => [row('a', 'openai')] },
      modelCatalog: { cachedCounts: () => { throw new Error('boom'); }, get: vi.fn(async () => []) },
    };
    expect(await providerListWithCounts(rt as any)).toEqual([row('a', 'openai')]);
  });
});
