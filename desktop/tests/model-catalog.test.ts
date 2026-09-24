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

describe('ModelCatalog', () => {
  let dir: string; let fetchMock: any; let cat: ModelCatalog;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-catalog-'));
    fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.includes('openrouter') ? OPENROUTER_PAYLOAD : MODELSDEV_PAYLOAD,
    }));
    cat = new ModelCatalog(dir, fetchMock);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('merges OpenRouter + models.dev into CatalogModel rows scoped to enabled providers', async () => {
    const models = await cat.get([
      { id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true, builtIn: true, hasKey: true, ready: true },
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

  // The COST property, pinned in both directions. Nothing guarded it before,
  // which is how a local-only session start silently acquired two internet
  // fetches when the vision resolver started reading the catalog for local
  // models (T18): ensureFresh() runs before get() looks at WHICH providers it
  // was handed, so a call that cannot consume either source still paid for
  // both. MEASURED 2026-09-05 on a network that accepts and never answers:
  // 4 fetches, 15.1 s per get(), and no memoization, so it repeated on every
  // create / resume / model swap.
  describe('does not touch the network for a provider list no catalog source can serve', () => {
    const LOCAL = { id: 'local', type: 'local-engine', label: 'Local models', enabled: true, builtIn: true, hasKey: false, ready: true };
    const CUSTOM = { id: 'ollama', type: 'openai-compatible', label: 'Ollama', enabled: true, builtIn: false, hasKey: false, ready: true };

    it('local-engine alone: zero fetches, and the local rows still come back', async () => {
      const local = new ModelCatalog(dir, fetchMock, {
        localModels: async () => [{ id: 'tiny-Q4_K_M', providerId: 'local', label: 'tiny-Q4_K_M' }],
      });
      const models = await local.get([LOCAL] as any);
      // Both halves matter: zero fetches is the fix, and the rows still
      // arriving is proof the fix did not just short-circuit get() itself.
      expect(fetchMock).not.toHaveBeenCalled();
      expect(models.map((m) => m.id)).toEqual(['tiny-Q4_K_M']);
    });

    it('openai-compatible alone: zero fetches (it has no catalog at all)', async () => {
      expect(await cat.get([CUSTOM] as any)).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a DISABLED OpenRouter beside a local provider still costs nothing', async () => {
      // A disabled provider contributes no models, so it must not drag the
      // network in either — the gate reads `enabled` exactly as the loop does.
      await cat.get([LOCAL, { id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: false, builtIn: true, hasKey: true, ready: false }] as any);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('but an ENABLED OpenRouter beside the local provider DOES fetch — the gate is not over-broad', async () => {
      const models = await cat.get([LOCAL, { id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true, builtIn: true, hasKey: true, ready: true }] as any);
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
    const providers = [{ id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true, builtIn: true, hasKey: true, ready: true }] as any;
    await cat.get(providers);
    const callsAfterFirst = fetchMock.mock.calls.length;
    await cat.get(providers);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst); // cache hit — no new fetches
  });

  it('serves repeat calls from the in-memory memo — no disk or network after a fresh fetch', async () => {
    // Session start calls contextLengthFor + get back-to-back; before the memo
    // each call re-read and re-parsed the whole cache file synchronously on
    // the main process. Deleting the file between calls proves the second
    // call was served from memory: without the memo it would refetch.
    const providers = [{ id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true, builtIn: true, hasKey: true, ready: true }] as any;
    await cat.get(providers);                       // fetches, writes cache, sets memo
    const fetchCallsAfterPrime = fetchMock.mock.calls.length;
    fs.rmSync(path.join(dir, 'provider-catalog-cache.json'));
    const models = await cat.get(providers);        // must come from the memo
    expect(fetchMock.mock.calls.length).toBe(fetchCallsAfterPrime);
    expect(models.length).toBeGreaterThan(0);
  });

  it('a failed fetch falls back to stale cache instead of throwing', async () => {
    const providers = [{ id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true, builtIn: true, hasKey: true, ready: true }] as any;
    await cat.get(providers);                    // primes cache
    // Second instance over the same dir with the TEST-ONLY ttlMs knob makes
    // the on-disk cache read as expired.
    const expired = new ModelCatalog(dir, fetchMock, { ttlMs: -1 });
    fetchMock.mockRejectedValue(new Error('offline'));
    const models = await expired.get(providers);
    expect(models.length).toBeGreaterThan(0);    // stale data served
  });

  it('no cache + failed fetch yields an empty catalog, never a throw', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const models = await cat.get([{ id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true, builtIn: true, hasKey: true, ready: true }] as any);
    expect(models).toEqual([]);
  });

  it('contextLengthFor answers from the merged catalog', async () => {
    const providers = [{ id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true, builtIn: true, hasKey: true, ready: true }] as any;
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

  it('uses lower cloud defaults with no preference getter and preserves local-model windows', async () => {
    const cloud = { id: 'openrouter', type: 'openrouter', label: 'Router', enabled: true, builtIn: true, hasKey: true, ready: true } as const;
    const local = { id: 'local', type: 'local-engine', label: 'Local', enabled: true, builtIn: true, hasKey: false, ready: true } as const;
    const catalog = new ModelCatalog(dir, async () => ({ ok: true, json: async () => ({ data: [{ id: 'large', context_length: 2000000 }] }) }), {
      localModels: async () => [{ id: 'local-model', label: 'Local model', providerId: 'local', contextLength: 2000000 }],
    });
    expect(await catalog.contextLengthFor({ providerId: 'openrouter', modelId: 'large' }, [cloud])).toBe(272000);
    expect(await catalog.contextLengthFor({ providerId: 'local', modelId: 'local-model' }, [local])).toBe(2000000);
  });

  it('malformed upstream rows are skipped, not crashed on', async () => {
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => url.includes('openrouter')
        ? { data: [{ id: 'good-model', name: 'Good' }, { name: 'no id — skip me' }, null, 'garbage'] }
        : { weird: 'shape' },
    }));
    const models = await cat.get([{ id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true, builtIn: true, hasKey: true, ready: true }] as any);
    expect(models.map((m) => m.id)).toEqual(['good-model']);
  });

  it('converts OpenRouter per-token string pricing to USD per 1M tokens (×1e6)', async () => {
    const models = await cat.get([
      { id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true, builtIn: true, hasKey: true, ready: true },
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
      { id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true, builtIn: true, hasKey: true, ready: true },
    ] as any);
    // Number(null) and Number('') are 0 — without the string gate these rows
    // would all read as "free". Pinned here so the guard can't regress.
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
      { id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true, builtIn: true, hasKey: true, ready: true },
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

  describe('OpenRouter vision detection (architecture.input_modalities)', () => {
    const providers = [{ id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true, builtIn: true, hasKey: true, ready: true }] as any;

    it('sets supportsVision: true when input_modalities includes "image"', async () => {
      fetchMock.mockImplementation(async (url: string) => ({
        ok: true,
        json: async () => url.includes('openrouter')
          ? { data: [{ id: 'vision-model', name: 'Vision', architecture: { input_modalities: ['text', 'image'] } }] }
          : {},
      }));
      const models = await cat.get(providers);
      expect(models.find((m) => m.id === 'vision-model')?.supportsVision).toBe(true);
    });

    it('sets supportsVision: false when input_modalities is present without "image"', async () => {
      fetchMock.mockImplementation(async (url: string) => ({
        ok: true,
        json: async () => url.includes('openrouter')
          ? { data: [{ id: 'text-model', name: 'Text', architecture: { input_modalities: ['text'] } }] }
          : {},
      }));
      const models = await cat.get(providers);
      expect(models.find((m) => m.id === 'text-model')?.supportsVision).toBe(false);
    });

    it('leaves supportsVision undefined when architecture is missing entirely', async () => {
      fetchMock.mockImplementation(async (url: string) => ({
        ok: true,
        json: async () => url.includes('openrouter')
          ? { data: [{ id: 'no-architecture', name: 'None' }] }
          : {},
      }));
      const models = await cat.get(providers);
      expect(models.find((m) => m.id === 'no-architecture')?.supportsVision).toBeUndefined();
    });

    it.each([
      ['architecture: null', { architecture: null }],
      ['architecture: a string', { architecture: 'image' }],
      ['architecture with neither input_modalities nor modality', { architecture: {} }],
      ['input_modalities: not an array', { architecture: { input_modalities: 'image' } }],
      // Legacy `modality` fallback (below) is only trusted with a string that
      // contains the '->' delimiter — these two stay "don't know" instead.
      ['modality: not a string', { architecture: { modality: 123 } }],
      ['modality: a string with no "->"', { architecture: { modality: 'text' } }],
    ])('leaves supportsVision undefined for malformed shape: %s', async (_label, extra) => {
      fetchMock.mockImplementation(async (url: string) => ({
        ok: true,
        json: async () => url.includes('openrouter')
          ? { data: [{ id: 'malformed', name: 'Malformed', ...extra }] }
          : {},
      }));
      const models = await cat.get(providers);
      expect(models.find((m) => m.id === 'malformed')?.supportsVision).toBeUndefined();
    });

    // Legacy `architecture.modality` string, predating input_modalities
    // (e.g. still served for some older OpenRouter catalog rows).
    it('sets supportsVision: true from legacy modality string "text+image->text" when input_modalities is absent', async () => {
      fetchMock.mockImplementation(async (url: string) => ({
        ok: true,
        json: async () => url.includes('openrouter')
          ? { data: [{ id: 'legacy-vision', name: 'Legacy Vision', architecture: { modality: 'text+image->text' } }] }
          : {},
      }));
      const models = await cat.get(providers);
      expect(models.find((m) => m.id === 'legacy-vision')?.supportsVision).toBe(true);
    });

    it('sets supportsVision: false from legacy modality string "text->text" when input_modalities is absent', async () => {
      fetchMock.mockImplementation(async (url: string) => ({
        ok: true,
        json: async () => url.includes('openrouter')
          ? { data: [{ id: 'legacy-text', name: 'Legacy Text', architecture: { modality: 'text->text' } }] }
          : {},
      }));
      const models = await cat.get(providers);
      expect(models.find((m) => m.id === 'legacy-text')?.supportsVision).toBe(false);
    });

    it('prefers input_modalities over a conflicting legacy modality string when both are present', async () => {
      fetchMock.mockImplementation(async (url: string) => ({
        ok: true,
        json: async () => url.includes('openrouter')
          ? { data: [{ id: 'both-fields', name: 'Both', architecture: { input_modalities: ['text'], modality: 'text+image->text' } }] }
          : {},
      }));
      const models = await cat.get(providers);
      // input_modalities says no image -> that wins, even though the legacy
      // string alone would have said true.
      expect(models.find((m) => m.id === 'both-fields')?.supportsVision).toBe(false);
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

    // §4.6: when OpenAI blocks the account the registry keeps the row listed
    // (ready: false) so the card can still show who is signed in and offer Sign
    // out — but the models must leave the catalog. ChatGptAuth deliberately
    // keeps its cached list through a block, so `enabled` alone would still
    // hand them out. The two pickers filter on ready themselves; the app's own
    // ModelSearch tool reads the catalog raw, so without this gate the
    // assistant would be offered plan models it cannot use and the user would
    // get "Codex is disabled for this workspace." instead of an answer.
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

// ── Catalog pricing ──────────────────────────────────────────────────────────
// The app's copy of the price list used to drop the cache rates, which forced
// the session-cost chip to over-report and apologise for it in a tooltip. The
// rates are in the payload; carry them (spec §5).
describe('catalog pricing', () => {
  it('maps OpenRouter per-token strings to per-1M, cache rates included', () => {
    const rows = (ModelCatalog as any).prototype.openrouterModels.call({}, {
      data: [{
        id: 'vendor/model',
        pricing: {
          prompt: '0.000003', completion: '0.000015',
          input_cache_read: '0.0000003', input_cache_write: '0.00000375',
        },
      }],
    }, 'openrouter');
    expect(rows[0].pricing).toEqual({ in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  });

  it('omits cache rates that are absent or malformed rather than guessing zero', () => {
    const rows = (ModelCatalog as any).prototype.openrouterModels.call({}, {
      data: [{ id: 'vendor/model', pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '' } }],
    }, 'openrouter');
    expect(rows[0].pricing).toEqual({ in: 3, out: 15 });
  });

  // A plan freezes a `free` price snapshot from all-zero token rates and then
  // runs with no dollar limit at all. A model that charges per REQUEST (or per
  // image, or per web search) and publishes 0/0 for tokens is not free — it is
  // billed in a unit this app does not model, which is "not published", never
  // "$0". Same never-guess rule as the padded-field gate below.
  it('a model with zero token rates but a positive per-request fee is not published as free', () => {
    const map = (pricing: Record<string, string>) => (ModelCatalog as any).prototype.openrouterModels.call({}, {
      data: [{ id: 'vendor/model', pricing }],
    }, 'openrouter')[0].pricing;
    expect(map({ prompt: '0', completion: '0', request: '0.01' })).toBeUndefined();
    expect(map({ prompt: '0', completion: '0', image: '0.004' })).toBeUndefined();
    expect(map({ prompt: '0', completion: '0', web_search: '0.008' })).toBeUndefined();
    // A genuinely free model still reads free: every fee published as zero.
    expect(map({ prompt: '0', completion: '0', request: '0' })).toEqual({ in: 0, out: 0 });
    expect(map({ prompt: '0', completion: '0' })).toEqual({ in: 0, out: 0 });
    // A per-request fee alongside REAL token rates changes nothing: the token
    // rates are published and the app prices what it can.
    expect(map({ prompt: '0.000003', completion: '0.000015', request: '0.01' })).toEqual({ in: 3, out: 15 });
  });

  it('maps models.dev cost fields, which are already per-1M', () => {
    const rows = (ModelCatalog as any).prototype.modelsdevModels.call({}, {
      anthropic: { models: { 'x': { id: 'x', cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } } },
    }, 'anthropic', 'anthropic');
    expect(rows[0].pricing).toEqual({ in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  });

  // A field of pure whitespace ('  ', '\t') is a published-nothing, same as ''.
  // Number('  ') is 0 and '  ' !== '', so a bare non-empty-string gate turns a
  // padded field into a REAL rate of zero — cached reads billed at $0, or the
  // whole model priced free. These pin the trim.
  it('treats a whitespace-only cache rate as "not published", never as free', () => {
    const rows = (ModelCatalog as any).prototype.openrouterModels.call({}, {
      data: [{
        id: 'vendor/model',
        pricing: {
          prompt: '0.000003', completion: '0.000015',
          input_cache_read: '  ', input_cache_write: '\t',
        },
      }],
    }, 'openrouter');
    expect(rows[0].pricing).toEqual({ in: 3, out: 15 });
  });

  it('treats a whitespace-only base rate as "not published", never as free', () => {
    const rows = (ModelCatalog as any).prototype.openrouterModels.call({}, {
      data: [{ id: 'vendor/model', pricing: { prompt: '  ', completion: '  ' } }],
    }, 'openrouter');
    expect(rows[0].pricing).toBeUndefined();
  });

  // models.dev half of the never-guess rule (the OpenRouter half is pinned
  // above). cost.cache_read/cache_write must be NUMBERS to be carried; absent,
  // null, or string-shaped means the source published no cache rate, and the
  // cost chip must fall back to the full input rate rather than bill $0.
  it('omits models.dev cache rates that are absent, null, or non-numeric', () => {
    const call = (models: any) => (ModelCatalog as any).prototype.modelsdevModels.call(
      {}, { anthropic: { models } }, 'anthropic', 'anthropic');

    expect(call({ absent: { cost: { input: 3, output: 15 } } })[0].pricing)
      .toEqual({ in: 3, out: 15 });
    expect(call({ nulled: { cost: { input: 3, output: 15, cache_read: null, cache_write: null } } })[0].pricing)
      .toEqual({ in: 3, out: 15 });
    expect(call({ stringy: { cost: { input: 3, output: 15, cache_read: '0.3', cache_write: '3.75' } } })[0].pricing)
      .toEqual({ in: 3, out: 15 });
  });
});
