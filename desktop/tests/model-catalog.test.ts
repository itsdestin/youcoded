// ModelCatalog contract tests — fetch is injected, so these run with ZERO
// network. The upstream payload shapes here mirror the schema entries in
// docs/provider-dependencies.md (models.dev api.json + OpenRouter /models).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { ModelCatalog } from '../src/main/providers/model-catalog';
import type { ContextPreferences } from '../src/shared/context-preferences';
import type { ProviderStatus } from '../src/shared/provider-types';

const OPENROUTER_PAYLOAD = { data: [
  { id: 'meta-llama/llama-3-8b', name: 'Llama 3 8B', context_length: 8192, pricing: { prompt: '0.00000005', completion: '0.0000001' } },
] };
// models.dev api.json: { [providerKey]: { models: { [modelKey]: {...} } } } —
// exact schema recorded in provider-dependencies.md; parse defensively.
const MODELSDEV_PAYLOAD = { anthropic: { models: {
  'claude-sonnet-5': { name: 'Claude Sonnet 5', limit: { context: 200000 }, tool_call: true, reasoning: true,
    cost: { input: 3, output: 15 } },
} } };

// One temp dir per test for every describe below.
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-catalog-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

const OR_PROVIDER = { id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true, builtIn: true, hasKey: true, ready: true };

describe('ModelCatalog', () => {
  let fetchMock: any; let cat: ModelCatalog;
  beforeEach(() => {
    fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.includes('openrouter') ? OPENROUTER_PAYLOAD : MODELSDEV_PAYLOAD,
    }));
    cat = new ModelCatalog(dir, fetchMock);
  });

  it('merges OpenRouter + models.dev into CatalogModel rows scoped to enabled providers', async () => {
    const models = await cat.get([
      OR_PROVIDER,
      { id: 'anth1', type: 'anthropic', label: 'Anthropic', enabled: true, builtIn: false, hasKey: true, ready: true },
    ] as any);
    const or = models.find((m) => m.providerId === 'openrouter');
    expect(or).toMatchObject({ id: 'meta-llama/llama-3-8b', contextLength: 8192 });
    const an = models.find((m) => m.providerId === 'anth1');
    expect(an).toMatchObject({ id: 'claude-sonnet-5', contextLength: 200000, supportsTools: true });
  });

  it('disabled providers contribute no models', async () => {
    const models = await cat.get([
      { id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: false, builtIn: true, hasKey: true, ready: false },
    ] as any);
    expect(models).toHaveLength(0);
  });

  // WHY: a local-only session start once paid two internet fetches (15 s per get() on a dead network)
  // because ensureFresh() ran before get() looked at which providers it was handed. Pinned both ways.
  describe('does not touch the network for a provider list no catalog source can serve', () => {
    const LOCAL = { id: 'local', type: 'local-engine', label: 'Local models', enabled: true, builtIn: true, hasKey: false, ready: true };
    const CUSTOM = { id: 'ollama', type: 'openai-compatible', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', enabled: true, builtIn: false, hasKey: false, ready: true };

    it('local-engine alone: zero fetches, and the local rows still come back', async () => {
      const local = new ModelCatalog(dir, fetchMock, {
        localModels: async () => [{ id: 'tiny-Q4_K_M', providerId: 'local', label: 'tiny-Q4_K_M' }],
      });
      const models = await local.get([LOCAL] as any);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(models.map((m) => m.id)).toEqual(['tiny-Q4_K_M']);
    });

    it('a custom endpoint on this computer alone: no internet catalog fetch (only its own /models, on this computer)', async () => {
      expect(await cat.get([CUSTOM] as any)).toEqual([]);
      expect(fetchMock.mock.calls.map(([u]: [string]) => u)).toEqual(['http://localhost:11434/v1/models']);
    });

    it('a cloud custom endpoint DOES fetch (it can now be matched by address)', async () => {
      const f = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
      await new ModelCatalog(dir, f as any).get([{ ...CUSTOM, baseUrl: 'https://api.example.com/v1' }] as any);
      expect(f).toHaveBeenCalled();
    });

    it('cacheOnly never fetches and never reads the disk, even with nothing cached', async () => {
      const f = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
      // A cache file on disk must be ignored too: reading it is a blocking read on a session path.
      fs.writeFileSync(path.join(dir, 'provider-catalog-cache.json'), JSON.stringify({ fetchedAt: Date.now(), openrouter: null,
        modelsdev: { x: { npm: '@ai-sdk/openai-compatible', api: 'https://api.example.com', models: { m: { name: 'M' } } } } }));
      const rows = await new ModelCatalog(dir, f as any).get([{ ...CUSTOM, baseUrl: 'https://api.example.com/v1' }] as any, { cacheOnly: true });
      expect(rows).toEqual([]);
      expect(f).not.toHaveBeenCalled();
    });

    it('a DISABLED OpenRouter beside a local provider still costs nothing', async () => {
      await cat.get([LOCAL, { id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: false, builtIn: true, hasKey: true, ready: false }] as any);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('but an ENABLED OpenRouter beside the local provider DOES fetch — the gate is not over-broad', async () => {
      const models = await cat.get([LOCAL, OR_PROVIDER] as any);
      expect(fetchMock).toHaveBeenCalled();
      expect(models.some((m) => m.providerId === 'openrouter')).toBe(true);
    });

    it('and a models.dev provider (anthropic) beside the local one DOES fetch', async () => {
      const models = await cat.get([LOCAL, { id: 'anth1', type: 'anthropic', label: 'Anthropic', enabled: true, builtIn: false, hasKey: true, ready: true }] as any);
      expect(fetchMock).toHaveBeenCalled();
      expect(models.some((m) => m.providerId === 'anth1')).toBe(true);
    });
  });

  it('serves from disk cache within TTL (single fetch pair across two calls)', async () => {
    const providers = [OR_PROVIDER] as any;
    await cat.get(providers);
    const callsAfterFirst = fetchMock.mock.calls.length;
    await cat.get(providers);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst); // cache hit — no new fetches
  });

  it('serves repeat calls from the in-memory memo — no disk or network after a fresh fetch', async () => {
    // WHY: session start calls contextLengthFor + get back-to-back; deleting the file proves call two came from memory.
    const providers = [OR_PROVIDER] as any;
    await cat.get(providers);                       // fetches, writes cache, sets memo
    const fetchCallsAfterPrime = fetchMock.mock.calls.length;
    fs.rmSync(path.join(dir, 'provider-catalog-cache.json'));
    const models = await cat.get(providers);        // must come from the memo
    expect(fetchMock.mock.calls.length).toBe(fetchCallsAfterPrime);
    expect(models.length).toBeGreaterThan(0);
  });

  it('a failed fetch falls back to stale cache instead of throwing', async () => {
    const providers = [OR_PROVIDER] as any;
    await cat.get(providers);                    // primes cache
    const expired = new ModelCatalog(dir, fetchMock, { ttlMs: -1 });
    fetchMock.mockRejectedValue(new Error('offline'));
    const models = await expired.get(providers);
    expect(models.length).toBeGreaterThan(0);    // stale data served
  });

  it('no cache + failed fetch yields an empty catalog, never a throw', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const models = await cat.get([OR_PROVIDER] as any);
    expect(models).toEqual([]);
  });

  it('contextLengthFor answers from the merged catalog', async () => {
    const providers = [OR_PROVIDER] as any;
    await cat.get(providers);
    expect(await cat.contextLengthFor({ providerId: 'openrouter', modelId: 'meta-llama/llama-3-8b' }, providers)).toBe(8192);
    expect(await cat.contextLengthFor({ providerId: 'openrouter', modelId: 'unknown' }, providers)).toBeNull();
  });

  it('uses current cloud preferences by provider type without rewriting or refetching catalog metadata', async () => {
    let preferences: ContextPreferences = { openrouter: 'standard', chatgpt: 'standard' };
    const providers: ProviderStatus[] = [
      { id: 'my-router', type: 'openrouter', label: 'Router', enabled: true, builtIn: false, hasKey: true, ready: true },
      { id: 'chatgpt', type: 'chatgpt', label: 'Plan', enabled: true, builtIn: true, hasKey: false, ready: true },
    ];
    const planRow = { id: 'plan-model', providerId: 'chatgpt', label: 'Plan model', contextLength: 272000, maxContextLength: 872000 };
    const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('openrouter')
      ? { data: [{ id: 'large', name: 'Large', context_length: 1048576 }] } : {} }));
    const catalog = new ModelCatalog(dir, fetch, {
      chatgptModels: async () => [planRow], contextPreferences: () => preferences,
    });
    const router = { providerId: 'my-router', modelId: 'large' };
    const plan = { providerId: 'chatgpt', modelId: 'plan-model' };
    expect(await catalog.contextLengthFor(router, providers)).toBe(272000);
    expect(await catalog.contextLengthFor(plan, providers)).toBe(272000);
    preferences = { openrouter: 'long', chatgpt: 'standard' };
    expect(await catalog.contextLengthFor(router, providers)).toBe(1048576);
    expect(await catalog.contextLengthFor(plan, providers)).toBe(272000);
    preferences = { openrouter: 'standard', chatgpt: 'long' };
    expect(await catalog.contextLengthFor(router, providers)).toBe(272000);
    expect(await catalog.contextLengthFor(plan, providers)).toBe(872000);
    expect(await catalog.get(providers)).toEqual([
      { id: 'large', providerId: 'my-router', label: 'Large', contextLength: 1048576 }, planRow,
    ]);
    expect(fetch).toHaveBeenCalledTimes(2); // Only the initial two-source discovery.
    expect(planRow.contextLength).toBe(272000);
  });

  it('uses 500k cloud defaults with no preference getter and preserves local-model windows', async () => {
    const cloud = { id: 'openrouter', type: 'openrouter', label: 'Router', enabled: true, builtIn: true, hasKey: true, ready: true } as const;
    const local = { id: 'local', type: 'local-engine', label: 'Local', enabled: true, builtIn: true, hasKey: false, ready: true } as const;
    const catalog = new ModelCatalog(dir, async () => ({ ok: true, json: async () => ({ data: [{ id: 'large', context_length: 2000000 }] }) }), {
      localModels: async () => [{ id: 'local-model', label: 'Local model', providerId: 'local', contextLength: 2000000 }],
    });
    expect(await catalog.contextLengthFor({ providerId: 'openrouter', modelId: 'large' }, [cloud])).toBe(500000);
    expect(await catalog.contextLengthFor({ providerId: 'local', modelId: 'local-model' }, [local])).toBe(2000000);
  });

  it('malformed upstream rows are skipped, not crashed on', async () => {
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => url.includes('openrouter')
        ? { data: [{ id: 'good-model', name: 'Good' }, { name: 'no id — skip me' }, null, 'garbage'] }
        : { weird: 'shape' },
    }));
    const models = await cat.get([OR_PROVIDER] as any);
    expect(models.map((m) => m.id)).toEqual(['good-model']);
  });

  it('converts OpenRouter per-token string pricing to USD per 1M tokens (×1e6)', async () => {
    const models = await cat.get([
      OR_PROVIDER,
    ] as any);
    const or = models.find((m) => m.id === 'meta-llama/llama-3-8b');
    // '0.00000005'/token → $0.05 per 1M; '0.0000001'/token → $0.10 per 1M.
    // toBeCloseTo(…, 10): the ×1e6 float product is within 1e-10 of exact.
    expect(or?.pricing?.in).toBeCloseTo(0.05, 10);
    expect(or?.pricing?.out).toBeCloseTo(0.1, 10);
  });

  it('null/absent OpenRouter pricing yields NO pricing field — never $0', async () => {
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => url.includes('openrouter')
        ? { data: [
            { id: 'null-priced', name: 'Null', pricing: { prompt: null, completion: null } },
            { id: 'empty-priced', name: 'Empty', pricing: { prompt: '', completion: '' } },
            { id: 'no-pricing', name: 'None' },
          ] }
        : {},
    }));
    const models = await cat.get([
      OR_PROVIDER,
    ] as any);
    for (const m of models) expect(m.pricing).toBeUndefined();
  });

  it('models.dev cost is already per-1M — passed through with NO scaling', async () => {
    const models = await cat.get([
      { id: 'anth1', type: 'anthropic', label: 'Anthropic', enabled: true, builtIn: false, hasKey: true, ready: true },
    ] as any);
    const an = models.find((m) => m.id === 'claude-sonnet-5');
    expect(an?.pricing).toEqual({ in: 3, out: 15 });
  });

  it('partial refresh persists the good source but retries BOTH on the next call', async () => {
    const providers = [
      OR_PROVIDER,
      { id: 'anth1', type: 'anthropic', label: 'Anthropic', enabled: true, builtIn: false, hasKey: true, ready: true },
    ] as any;
    // First call: OpenRouter up, models.dev down.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('openrouter')) return { ok: true, json: async () => OPENROUTER_PAYLOAD };
      throw new Error('models.dev offline');
    });
    const first = await cat.get(providers);
    expect(first.some((m) => m.providerId === 'openrouter')).toBe(true); // good source served
    expect(first.some((m) => m.providerId === 'anth1')).toBe(false);

    // Second call: both sources back up. The partial cache must NOT count as
    // fresh — a re-fetch must actually happen and fill the missing source.
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => url.includes('openrouter') ? OPENROUTER_PAYLOAD : MODELSDEV_PAYLOAD,
    }));
    const callsBefore = fetchMock.mock.calls.length;
    const second = await cat.get(providers);
    expect(fetchMock.mock.calls.length).toBe(callsBefore + 2); // both retried
    expect(second.some((m) => m.providerId === 'anth1')).toBe(true); // gap filled
  });

  describe('OpenRouter vision detection (architecture.input_modalities, legacy modality string)', () => {
    // undefined = "don't know"; the legacy `modality` string is trusted only when it contains '->'.
    it.each([
      ['input_modalities includes image', { architecture: { input_modalities: ['text', 'image'] } }, true],
      ['input_modalities without image', { architecture: { input_modalities: ['text'] } }, false],
      ['legacy "text+image->text"', { architecture: { modality: 'text+image->text' } }, true],
      ['legacy "text->text"', { architecture: { modality: 'text->text' } }, false],
      ['input_modalities wins over a conflicting legacy string', { architecture: { input_modalities: ['text'], modality: 'text+image->text' } }, false],
      ['no architecture at all', {}, undefined],
      ['architecture: null', { architecture: null }, undefined],
      ['architecture: a string', { architecture: 'image' }, undefined],
      ['architecture with neither field', { architecture: {} }, undefined],
      ['input_modalities: not an array', { architecture: { input_modalities: 'image' } }, undefined],
      ['modality: not a string', { architecture: { modality: 123 } }, undefined],
      ['modality: a string with no "->"', { architecture: { modality: 'text' } }, undefined],
    ])('supportsVision for %s', async (_label, extra, want) => {
      fetchMock.mockImplementation(async (url: string) => ({
        ok: true,
        json: async () => url.includes('openrouter') ? { data: [{ id: 'm', name: 'M', ...extra }] } : {},
      }));
      const models = await cat.get([OR_PROVIDER] as any);
      expect(models.find((m) => m.id === 'm')?.supportsVision).toBe(want);
    });
  });

  describe('local models source (Plan B)', () => {
    it('get(): merges injected local models for an enabled local-engine provider', async () => {
      const localRows = [{ id: 'tiny-Q4_K_M', providerId: 'local', label: 'tiny-Q4_K_M', contextLength: 8192 }];
      const cat = new ModelCatalog(dir, fetchMock, { localModels: async () => localRows });
      const models = await cat.get([
        { id: 'local', type: 'local-engine', label: 'Local', enabled: true, builtIn: true, hasKey: false, ready: true } as any,
      ]);
      expect(models).toEqual(localRows);
    });

    it('get(): a throwing local source degrades to no local rows (never rejects)', async () => {
      const cat = new ModelCatalog(dir, fetchMock, { localModels: async () => { throw new Error('boom'); } });
      const models = await cat.get([
        { id: 'local', type: 'local-engine', label: 'Local', enabled: true, builtIn: true, hasKey: false, ready: true } as any,
      ]);
      expect(models).toEqual([]);
    });
  });

  // Sign in with ChatGPT (backend design §4.3): rows come from an injected
  // source (ChatGptAuth.models(), cache-first); the catalog never prices them.
  describe('ChatGPT plan source', () => {
    const CHATGPT_ROW = { id: 'chatgpt', type: 'chatgpt', label: 'ChatGPT Plan', enabled: true, builtIn: true, hasKey: false, ready: true } as any;

    it('get(): merges the injected ChatGPT rows for an enabled chatgpt provider, with no pricing', async () => {
      const rows = [
        { id: 'gpt-5.5', providerId: 'chatgpt', label: 'GPT-5.5', contextLength: 272000, supportsTools: true, supportsReasoning: true },
        { id: 'gpt-5.4-mini', providerId: 'chatgpt', label: 'GPT-5.4 Mini', contextLength: 272000, supportsTools: true },
      ];
      const cat = new ModelCatalog(dir, fetchMock, { chatgptModels: async () => rows });
      const models = await cat.get([CHATGPT_ROW]);
      expect(models).toEqual(rows);
      // The plan is not per-token: absent means absent, never $0.
      expect(models.every((m) => m.pricing === undefined)).toBe(true);
      expect(await cat.contextLengthFor({ providerId: 'chatgpt', modelId: 'gpt-5.5' }, [CHATGPT_ROW])).toBe(272000);
    });

    it('get(): a throwing ChatGPT source degrades to no ChatGPT rows (never rejects)', async () => {
      const cat = new ModelCatalog(dir, fetchMock, { chatgptModels: async () => { throw new Error('boom'); } });
      const models = await cat.get([CHATGPT_ROW]);
      expect(models).toEqual([]);
    });

    // WHY: a blocked account keeps its cached list, but ModelSearch reads the catalog raw and would offer unusable plan models.
    it('get(): a BLOCKED plan (ready:false) contributes no models even though the cache still holds them', async () => {
      const cat = new ModelCatalog(dir, fetchMock, {
        chatgptModels: async () => [{ id: 'gpt-5.5', providerId: 'chatgpt', label: 'GPT-5.5' }],
      });
      expect(await cat.get([{ ...CHATGPT_ROW, ready: false }])).toEqual([]);
      // Sanity: the same source with ready:true DOES contribute — so the empty
      // result above is the gate, not a broken fixture.
      expect(await cat.get([CHATGPT_ROW])).toHaveLength(1);
    });

    it('get(): no source injected (kill switch) or provider disabled → nothing for the plan', async () => {
      const none = new ModelCatalog(dir, fetchMock);
      expect(await none.get([CHATGPT_ROW])).toEqual([]);
      const cat = new ModelCatalog(dir, fetchMock, { chatgptModels: async () => [{ id: 'gpt-5.5', providerId: 'chatgpt', label: 'GPT-5.5' }] });
      expect(await cat.get([{ ...CHATGPT_ROW, enabled: false }])).toEqual([]);
    });
  });
});

// Cache rates are carried so the session-cost chip does not over-report.
describe('catalog pricing', () => {
  const or = (pricing: object) => (ModelCatalog as any).prototype.openrouterModels.call({}, { data: [{ id: 'vendor/model', pricing }] }, 'openrouter');
  const md = (models: any) => (ModelCatalog as any).prototype.modelsdevModels.call({}, { anthropic: { models } }, 'anthropic', 'anthropic');
  const BASE = { prompt: '0.000003', completion: '0.000015' };

  it('maps OpenRouter per-token strings to per-1M, cache rates included; models.dev costs are already per-1M', () => {
    expect(or({ ...BASE, input_cache_read: '0.0000003', input_cache_write: '0.00000375' })[0].pricing)
      .toEqual({ in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    expect(md({ x: { id: 'x', cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } })[0].pricing)
      .toEqual({ in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  });

  // WHY: Number('  ') is 0, so an untrimmed whitespace field would become a REAL rate of zero (billed $0).
  it.each([
    ['empty', { input_cache_read: '' }],
    ['whitespace-only', { input_cache_read: '  ', input_cache_write: '\t' }],
  ])('treats an %s OpenRouter cache rate as "not published", never as free', (_n, extra) => {
    expect(or({ ...BASE, ...extra })[0].pricing).toEqual({ in: 3, out: 15 });
  });

  it('treats a whitespace-only base rate as "not published", never as free', () => {
    expect(or({ prompt: '  ', completion: '  ' })[0].pricing).toBeUndefined();
  });

  // cache_read/cache_write must be NUMBERS; otherwise the chip falls back to the input rate, not $0.
  it.each([
    ['absent', {}],
    ['null', { cache_read: null, cache_write: null }],
    ['non-numeric', { cache_read: '0.3', cache_write: '3.75' }],
  ])('omits models.dev cache rates that are %s', (_n, extra) => {
    expect(md({ m: { cost: { input: 3, output: 15, ...extra } } })[0].pricing).toEqual({ in: 3, out: 15 });
  });
});

describe('custom endpoints matched to models.dev by address', () => {
  const MD = {
    inception: { npm: '@ai-sdk/openai-compatible', api: 'https://api.inceptionlabs.ai/v1/', models: {
      'mercury-3': { name: 'Mercury 3', limit: { context: 1000000 }, tool_call: true, cost: { input: 0.1, output: 0.35, cache_read: 0.01 } },
    } },
    // Same address published twice: the larger list wins, whatever the key order.
    'gw-small': { npm: '@ai-sdk/openai-compatible', api: 'https://gw.example.com', models: { a: { name: 'A' } } },
    'gw-big': { npm: '@ai-sdk/openai-compatible', api: 'https://gw.example.com/v1', models: { a: { name: 'A' }, b: { name: 'B' } } },
    // Not OpenAI-compatible: never matched even though the address is listed.
    vendor: { npm: '@ai-sdk/anthropic', api: 'https://vendor.example.com', models: { x: { name: 'X' } } },
  };
  const custom = (baseUrl: string) => ({ id: 'c1', type: 'openai-compatible', label: 'Mine', baseUrl, enabled: true, builtIn: false, hasKey: true, ready: true });
  const make = () => new ModelCatalog(dir, vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('openrouter') ? { data: [] } : MD })) as any);

  it('a custom endpoint whose address matches gets that service’s models, prices and context', async () => {
    const rows = await make().get([custom('https://API.inceptionlabs.ai')] as any);
    expect(rows).toEqual([expect.objectContaining({ id: 'mercury-3', providerId: 'c1', contextLength: 1000000, supportsTools: true,
      pricing: { in: 0.1, out: 0.35, cacheRead: 0.01 } })]);
  });
  it('two entries on one address: the one with more models wins', async () => {
    const rows = await make().get([custom('https://gw.example.com/')] as any);
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });
  it('an entry that is not OpenAI-compatible is never matched', async () => {
    expect(await make().get([custom('https://vendor.example.com')] as any)).toEqual([]);
  });
  it('an unknown address gets no models.dev rows', async () => {
    expect(await make().get([custom('https://nobody.example.com/v1')] as any)).toEqual([]);
  });
});

describe("an unmatched custom endpoint is asked for its own /models", () => {
  const custom = (baseUrl: string, id = 'c1') => ({ id, type: 'openai-compatible', label: 'Mine', baseUrl, enabled: true, builtIn: false, hasKey: true, ready: true });

  function rig(endpointBody: unknown, opts: { ok?: boolean; key?: string } = {}) {
    const calls: { url: string; auth?: string }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: any) => {
      calls.push({ url, auth: init?.headers?.Authorization });
      if (url.includes('openrouter') || url.includes('models.dev')) return { ok: true, json: async () => ({}) };
      return { ok: opts.ok ?? true, json: async () => endpointBody };
    });
    const cat = new ModelCatalog(dir, fetchImpl as any, { endpointKey: async () => opts.key });
    return { cat, calls };
  }

  it('reads an OpenRouter-shaped list: names, context and per-token prices', async () => {
    const { cat, calls } = rig({ data: [{ id: 'm3', name: 'Mercury 3', context_length: 1000000,
      pricing: { prompt: '0.0000001', completion: '0.00000035' }, supported_parameters: ['tools'] }] }, { key: 'sk-1' });
    const rows = await cat.get([custom('https://unknown.example.com/v1/')] as any);
    expect(rows).toEqual([{ id: 'm3', providerId: 'c1', label: 'Mercury 3', contextLength: 1000000, supportsTools: true,
      pricing: { in: expect.closeTo(0.1, 10), out: expect.closeTo(0.35, 10) } }]);
    expect(calls.find((c) => c.url === 'https://unknown.example.com/v1/models')?.auth).toBe('Bearer sk-1');
  });
  it('reads an id-only list and leaves every other fact unset', async () => {
    const { cat } = rig({ object: 'list', data: [{ id: 'kimi-k2.6', object: 'model' }] });
    expect(await cat.get([custom('https://ollama.example.com/v1')] as any)).toEqual([{ id: 'kimi-k2.6', providerId: 'c1', label: 'kimi-k2.6' }]);
  });
  it('sends no Authorization header when no key is saved', async () => {
    const { cat, calls } = rig({ data: [] });
    await cat.get([custom('http://localhost:11434/v1')] as any);
    expect(calls.find((c) => c.url === 'http://localhost:11434/v1/models')?.auth).toBeUndefined();
  });
  it('a local endpoint is asked, but no internet catalog is fetched', async () => {
    const { cat, calls } = rig({ data: [{ id: 'llama3' }] });
    expect((await cat.get([custom('http://localhost:11434/v1')] as any)).map((r) => r.id)).toEqual(['llama3']);
    expect(calls.some((c) => c.url.includes('openrouter') || c.url.includes('models.dev'))).toBe(false);
  });
  it('a failing endpoint gives no rows and never throws', async () => {
    const { cat } = rig(null, { ok: false });
    expect(await cat.get([custom('https://down.example.com')] as any)).toEqual([]);
  });
  it('asks once for two callers at the same time', async () => {
    const { cat, calls } = rig({ data: [{ id: 'a' }] });
    await Promise.all([cat.get([custom('https://one.example.com')] as any), cat.get([custom('https://one.example.com')] as any)]);
    expect(calls.filter((c) => c.url === 'https://one.example.com/models')).toHaveLength(1);
  });
  it('a failed re-ask keeps the previous list for the same key', async () => {
    let up = true;
    const fetchImpl = vi.fn(async (url: string) => {
      if (!url.endsWith('/models')) return { ok: true, json: async () => ({}) };
      return { ok: up, json: async () => ({ data: [{ id: 'kept' }] }) };
    });
    // ttlMs -1: every call is past its time, so the second call really asks again.
    const cat = new ModelCatalog(dir, fetchImpl as any, { ttlMs: -1, endpointKey: async () => 'sk-1' });
    await cat.get([custom('https://flaky.example.com')] as any);
    up = false;
    expect((await cat.get([custom('https://flaky.example.com')] as any)).map((r) => r.id)).toEqual(['kept']);
    expect(fetchImpl.mock.calls.filter(([u]) => u === 'https://flaky.example.com/models')).toHaveLength(2);
  });
  it('a session-start lookup (cacheOnly) never asks the endpoint', async () => {
    const { cat, calls } = rig({ data: [{ id: 'a' }] });
    expect(await cat.get([custom('https://quiet.example.com')] as any, { cacheOnly: true })).toEqual([]);
    expect(calls).toHaveLength(0);
    await cat.get([custom('https://quiet.example.com')] as any);
    expect((await cat.get([custom('https://quiet.example.com')] as any, { cacheOnly: true })).map((r) => r.id)).toEqual(['a']);
  });
  it('a new key is never served the old key’s list', async () => {
    let key = 'sk-old';
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: any) => {
      if (!url.startsWith('https://k.example.com')) return { ok: true, json: async () => ({}) };
      seen.push(init?.headers?.Authorization);
      return { ok: true, json: async () => ({ data: [{ id: key }] }) };
    });
    const cat = new ModelCatalog(dir, fetchImpl as any, { endpointKey: async () => key });
    await cat.get([custom('https://k.example.com')] as any);
    key = 'sk-new';
    expect((await cat.get([custom('https://k.example.com')] as any)).map((r) => r.id)).toEqual(['sk-new']);
    expect(seen).toEqual(['Bearer sk-old', 'Bearer sk-new']);
  });
});

describe('services() — the providers Add provider can search', () => {
  const MD = {
    zeta: { name: 'Zeta', npm: '@ai-sdk/openai-compatible', api: 'https://zeta.example.com/v1/', models: {
      small: { name: 'Small', limit: { context: 8000 } }, big: { name: 'Big', limit: { context: 1000000 }, tool_call: false, cost: { input: 1, output: 2 } } } },
    alpha: { name: 'alpha', npm: '@ai-sdk/openai-compatible', api: 'https://alpha.example.com', models: { a: { name: 'A' } } },
    lmstudio: { name: 'LMStudio', npm: '@ai-sdk/openai-compatible', api: 'http://127.0.0.1:1234/v1', models: { l: { name: 'L' } } },
    empty: { name: 'Empty', npm: '@ai-sdk/openai-compatible', api: 'https://empty.example.com', models: {} },
    other: { name: 'Other', npm: '@ai-sdk/anthropic', api: 'https://other.example.com', models: { o: { name: 'O' } } },
    'gw-small': { name: 'GW small', npm: '@ai-sdk/openai-compatible', api: 'https://gw.example.com', models: { a: {} } },
    'gw-big': { name: 'GW big', npm: '@ai-sdk/openai-compatible', api: 'https://gw.example.com/v1', models: { a: {}, b: {} } },
  };
  const make = () => new ModelCatalog(dir, vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('openrouter') ? { data: [] } : MD })) as any);

  it('lists OpenAI-compatible, non-local services with models, sorted by name', async () => {
    expect((await make().services()).map((s) => s.label)).toEqual(['alpha', 'GW big', 'Zeta']);
  });
  it('carries the address, the count and the models largest-window first, never inventing facts', async () => {
    const zeta = (await make().services()).find((s) => s.id === 'zeta')!;
    expect(zeta).toMatchObject({ baseUrl: 'https://zeta.example.com/v1', modelCount: 2 });
    expect(zeta.models).toEqual([
      { id: 'big', label: 'Big', contextLength: 1000000, priceIn: 1, priceOut: 2, tools: false },
      { id: 'small', label: 'Small', contextLength: 8000 },
    ]);
  });
  it('is empty offline with nothing cached', async () => {
    const cat = new ModelCatalog(dir, vi.fn(async () => { throw new Error('offline'); }) as any);
    expect(await cat.services()).toEqual([]);
  });
});

describe('refresh() — "Check for new models"', () => {
  const OR = OR_PROVIDER;

  it('skips the 24-hour cache and reports what is new', async () => {
    let rows = [{ id: 'old' }];
    const f = vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('openrouter') ? { data: rows } : {} }));
    const cat = new ModelCatalog(dir, f as any);
    await cat.get([OR] as any);
    rows = [{ id: 'old' }, { id: 'inception/mercury-3' }];
    expect(await cat.refresh([OR] as any)).toEqual({ added: 1, failed: [] });
    expect((await cat.get([OR] as any)).map((m) => m.id)).toContain('inception/mercury-3');
  });
  it('names a source that could not be reached and keeps its old list', async () => {
    let down = false;
    const f = vi.fn(async (url: string) => {
      if (down && url.includes('openrouter')) throw new Error('offline');
      return { ok: true, json: async () => url.includes('openrouter') ? { data: [{ id: 'kept' }] } : {} };
    });
    const cat = new ModelCatalog(dir, f as any);
    await cat.get([OR] as any);
    down = true;
    expect(await cat.refresh([OR] as any)).toEqual({ added: 0, failed: ['OpenRouter'] });
    expect((await cat.get([OR] as any)).map((m) => m.id)).toEqual(['kept']);
  });
  it('two presses at once share one fetch', async () => {
    const f = vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('openrouter') ? { data: [] } : {} }));
    const cat = new ModelCatalog(dir, f as any);
    await Promise.all([cat.refresh([OR] as any), cat.refresh([OR] as any)]);
    expect(f.mock.calls.filter(([u]) => String(u).includes('openrouter'))).toHaveLength(1);
  });
  it('a normal read during a refresh waits for it instead of starting a second fetch', async () => {
    const f = vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('openrouter') ? { data: [{ id: 'x' }] } : {} }));
    const cat = new ModelCatalog(dir, f as any);
    await Promise.all([cat.refresh([OR] as any), cat.get([OR] as any)]);
    expect(f.mock.calls.filter(([u]) => String(u).includes('openrouter'))).toHaveLength(1);
  });
  it('names a custom endpoint that could not be reached', async () => {
    const C = { id: 'c1', type: 'openai-compatible', label: 'Home server', baseUrl: 'https://home.example.com/v1', enabled: true, builtIn: false, hasKey: false, ready: true };
    const f = vi.fn(async (url: string) => url.startsWith('https://home.example.com')
      ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => ({}) });
    expect(await new ModelCatalog(dir, f as any).refresh([C] as any)).toEqual({ added: 0, failed: ['Home server'] });
  });
  it('one source down: rows serve now, and the next ordinary read tries both again', async () => {
    let mdUp = false;
    const f = vi.fn(async (url: string) => {
      if (url.includes('models.dev') && !mdUp) throw new Error('offline');
      return { ok: true, json: async () => url.includes('openrouter') ? { data: [{ id: 'x' }] } : {} };
    });
    const cat = new ModelCatalog(dir, f as any);
    expect((await cat.get([OR] as any)).map((m) => m.id)).toEqual(['x']);
    const before = f.mock.calls.length;
    mdUp = true;
    await cat.get([OR] as any);
    expect(f.mock.calls.length).toBe(before + 2);
  });
  it('asks the ChatGPT plan to refresh, and survives it throwing', async () => {
    const refreshChatgpt = vi.fn(async () => { throw new Error('nope'); });
    const cat = new ModelCatalog(dir, vi.fn(async () => ({ ok: true, json: async () => ({}) })) as any, { refreshChatgpt });
    await expect(cat.refresh([OR] as any)).resolves.toMatchObject({ failed: [] });
    expect(refreshChatgpt).toHaveBeenCalled();
  });
});

describe('cachedCounts never fetches or reads the disk', () => {
  it('counts from what is already cached, and fetches nothing', async () => {
    const f = vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('openrouter')
      ? { data: [{ id: 'x' }, { id: 'y' }] } : { anthropic: { models: { c: { name: 'C' } } } } }));
    const cat = new ModelCatalog(dir, f as any);
    const providers = [
      { id: 'openrouter', type: 'openrouter', label: 'OR', enabled: true, builtIn: true, hasKey: true, ready: true },
      { id: 'an', type: 'anthropic', label: 'A', enabled: true, builtIn: false, hasKey: true, ready: true },
    ] as any;
    await cat.get(providers);
    f.mockClear();
    const counts = cat.cachedCounts(providers);
    expect(counts.get('openrouter')).toEqual({ count: 2, source: 'catalog' });
    expect(counts.get('an')).toEqual({ count: 1, source: 'catalog' });
    expect(f).not.toHaveBeenCalled();
  });
  it('with nothing in memory, every provider is unknown — a cache file on disk is not read', async () => {
    const f = vi.fn();
    fs.writeFileSync(path.join(dir, 'provider-catalog-cache.json'), JSON.stringify({ fetchedAt: Date.now(), openrouter: null, modelsdev: { anthropic: { models: { c: {} } } } }));
    const counts = new ModelCatalog(dir, f as any).cachedCounts([{ id: 'an', type: 'anthropic', label: 'A', enabled: true, builtIn: false, hasKey: true, ready: true }] as any);
    expect(counts.size).toBe(0);
    expect(f).not.toHaveBeenCalled();
  });
  it('an endpoint’s own list counts as "listed by this service"', async () => {
    const C = { id: 'c1', type: 'openai-compatible', label: 'Mine', baseUrl: 'http://localhost:11434/v1', enabled: true, builtIn: false, hasKey: false, ready: true } as any;
    const cat = new ModelCatalog(dir, vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }) })) as any);
    await cat.get([C]);
    expect(cat.cachedCounts([C]).get('c1')).toEqual({ count: 3, source: 'endpoint' });
  });
});
