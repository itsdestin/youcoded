// Merged, disk-cached model catalog (spec §2.2): OpenRouter /api/v1/models for
// the openrouter provider; models.dev api.json metadata for direct-key
// providers (anthropic/openai/google). openai-compatible custom endpoints get
// no catalog in Plan A (users type a model id). External schemas are recorded
// in docs/provider-dependencies.md — parse DEFENSIVELY; absent fields are
// omitted, never guessed.
import * as fs from 'fs';
import * as path from 'path';
import type { CatalogModel, ModelBinding, ProviderStatus } from '../../shared/provider-types';
import { DEFAULT_CONTEXT_PREFERENCES, type ContextPreferences } from '../../shared/context-preferences';
import { cloudContextLength } from './cloud-context';

const CACHE_FILE = 'provider-catalog-cache.json';
const TTL_MS = 24 * 60 * 60 * 1000; // 24h, marketplace-cache precedent
// Model lists are big but not huge; a slow fetch should not hang the picker.
const FETCH_TIMEOUT_MS = 15_000;
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const MODELSDEV_URL = 'https://models.dev/api.json';

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; json: () => Promise<any> }>;
interface CacheShape { fetchedAt: number; openrouter: any | null; modelsdev: any | null; }

// models.dev provider keys for our direct-key ProviderTypes.
const MODELSDEV_KEY: Record<string, string> = { anthropic: 'anthropic', openai: 'openai', google: 'google' };

const EMPTY_CACHE: CacheShape = { fetchedAt: 0, openrouter: null, modelsdev: null };

/** Plain-object check — upstream rows can be null / strings / arrays; every
 *  field access below goes through this gate first. */
function isObj(x: unknown): x is Record<string, any> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export class ModelCatalog {
  private readonly ttlMs: number;
  private readonly cachePath: string;
  // Plan B: injected by ipc-handlers as () => engineManager.catalogModels().
  private readonly localModels: (() => Promise<CatalogModel[]>) | null;
  // Sign in with ChatGPT (backend design §4.3): injected as
  // () => chatgptAuth.models(). That function is cache-first and never waits
  // on the network — get() runs in front of sessions on EVERY provider, so a
  // stale hourly stamp kicks a background refresh and the cached rows come
  // back now. Null under the kill switch or in tests without it.
  private readonly chatgptModels: (() => Promise<CatalogModel[]>) | null;
  private readonly contextPreferences: () => ContextPreferences;
  // In-memory copy of the last cache we returned (ROADMAP 2026-08-11: every
  // ensureFresh() re-read + re-parsed the whole catalog file from disk, twice
  // per session start). SERVED only while its own fetchedAt is inside the TTL
  // — a stale-but-served cache (partial refresh / total failure keep an OLD
  // stamp on purpose) fails that check and still retries the network next
  // call, so the retry semantics those branches were built for survive.
  // Two accepted trade-offs (final branch review, 2026-08-22): (1) the raw
  // upstream payloads stay resident on the main process for the TTL instead
  // of being parsed transiently — the payload is a few MB and there is one
  // instance app-wide; (2) deleting the cache FILE no longer forces a refetch
  // until restart or TTL expiry, because the memo is consulted before disk.
  // No in-app "refresh models" control depends on file deletion today.
  private memo: CacheShape | null = null;
  constructor(cacheDir: string, private fetchImpl: FetchLike = fetch as any,
              // opts.ttlMs is TEST-ONLY (same convention as SecretsStore's
              // maxRetries) — lets the stale-fallback tests force expiry
              // without poking private fields. Production callers omit it.
              opts?: {
                ttlMs?: number;
                localModels?: () => Promise<CatalogModel[]>;
                chatgptModels?: () => Promise<CatalogModel[]>;
                contextPreferences?: () => ContextPreferences;
              }) {
    this.cachePath = path.join(cacheDir, CACHE_FILE);
    this.ttlMs = opts?.ttlMs ?? TTL_MS;
    this.localModels = opts?.localModels ?? null;
    this.chatgptModels = opts?.chatgptModels ?? null;
    this.contextPreferences = opts?.contextPreferences ?? (() => DEFAULT_CONTEXT_PREFERENCES);
  }

  /** null on missing/corrupt. Unlike providers.json (user data — read errors
   *  must surface), this cache is fully rebuildable from the network, so
   *  absorbing ALL read errors and refetching is the correct behavior. */
  private readCache(): CacheShape | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      if (!isObj(parsed) || typeof parsed.fetchedAt !== 'number') return null;
      return {
        fetchedAt: parsed.fetchedAt,
        openrouter: parsed.openrouter ?? null,
        modelsdev: parsed.modelsdev ?? null,
      };
    } catch {
      return null;
    }
  }

  /** Fresh-or-refetched cache. NEVER throws — a dead network degrades to the
   *  stale cache, or to an empty catalog when there is no cache at all. */
  private async ensureFresh(): Promise<CacheShape> {
    if (this.memo && Date.now() - this.memo.fetchedAt < this.ttlMs) return this.memo;

    const stale = this.readCache();
    if (stale && Date.now() - stale.fetchedAt < this.ttlMs) { this.memo = stale; return stale; }

    let openrouter: any | null = stale?.openrouter ?? null;
    let modelsdev: any | null = stale?.modelsdev ?? null;
    let orSuccess = false;
    let mdSuccess = false;
    // Both sources in parallel; per-source failure keeps that source's stale
    // data (allSettled — one dead upstream must not blank the other's models).
    const [orRes, mdRes] = await Promise.allSettled([
      this.fetchImpl(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
      this.fetchImpl(MODELSDEV_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
    ]);
    if (orRes.status === 'fulfilled' && orRes.value.ok) {
      // json() can also reject (truncated body) — treat like a failed fetch.
      try { openrouter = await orRes.value.json(); orSuccess = true; } catch { /* keep stale */ }
    }
    if (mdRes.status === 'fulfilled' && mdRes.value.ok) {
      try { modelsdev = await mdRes.value.json(); mdSuccess = true; } catch { /* keep stale */ }
    }

    if (!orSuccess && !mdSuccess) {
      // Total failure: serve the stale cache entirely if we have one (don't
      // re-stamp fetchedAt — the next call should retry the network), else
      // an empty shape so get() yields [] rather than throwing.
      return stale ?? EMPTY_CACHE;
    }

    // Only stamp "fresh" when BOTH sources succeeded. A partial success keeps
    // the good source's new payload on disk but carries the OLD (expired)
    // stamp, so the next call retries both — otherwise one source being down
    // on the very first fetch would leave that provider's picker empty for a
    // full TTL. Same principle as the total-failure branch above.
    const fetchedAt = orSuccess && mdSuccess ? Date.now() : stale?.fetchedAt ?? 0;
    const fresh: CacheShape = { fetchedAt, openrouter, modelsdev };
    // Plain write, no tmp+rename: single consumer and fully rebuildable — a
    // torn file just reads as corrupt → refetch on the next call. Write
    // failures (read-only disk) are absorbed: the in-memory data still serves.
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(this.cachePath, JSON.stringify(fresh));
    } catch { /* cache write is best-effort */ }
    // Memoize unconditionally — the serve-path TTL check above is what decides
    // whether this shape is fresh enough to reuse (a partial refresh carries an
    // expired stamp and will be re-fetched next call regardless).
    this.memo = fresh;
    return fresh;
  }

  /** OpenRouter /api/v1/models rows → CatalogModel. Schema coupling recorded
   *  in docs/provider-dependencies.md; skip anything malformed. */
  private openrouterModels(payload: any, providerId: string): CatalogModel[] {
    const rows = isObj(payload) && Array.isArray(payload.data) ? payload.data : [];
    const out: CatalogModel[] = [];
    for (const row of rows) {
      if (!isObj(row) || typeof row.id !== 'string') continue; // skip malformed
      const m: CatalogModel = {
        id: row.id,
        providerId,
        label: typeof row.name === 'string' ? row.name : row.id,
      };
      if (typeof row.context_length === 'number') m.contextLength = row.context_length;
      if (Array.isArray(row.supported_parameters)) m.supportsTools = row.supported_parameters.includes('tools');
      // Vision support: OpenRouter is a TRANSPORT (one endpoint serves vision and
      // text-only models), so unlike the direct-key providers this is the one
      // catalog source that can actually answer "does THIS model accept images"
      // from data rather than a hand-maintained guess. `architecture` and its
      // `input_modalities` array are both optional per OpenRouter's schema and
      // rows are untrusted JSON — isObj + Array.isArray gate every access, and a
      // missing/malformed shape leaves supportsVision unset (undefined = "don't
      // know"), never a guessed `false` (see CatalogModel's field comment).
      // A row without input_modalities may still carry the older single-string
      // `architecture.modality` field (e.g. "text+image->text") — the fallback
      // branch below reads that instead of giving up, with the same
      // never-guess-false posture.
      const architecture = isObj(row.architecture) ? row.architecture : null;
      if (architecture && Array.isArray(architecture.input_modalities)) {
        m.supportsVision = architecture.input_modalities.includes('image');
      } else if (architecture && typeof architecture.modality === 'string' && architecture.modality.includes('->')) {
        // Legacy OpenRouter shape, predating input_modalities: a single string
        // like "text+image->text" ("<input>-><output>"). Only trust it when
        // the '->' delimiter is actually present — a modality string without
        // one gives no reliable way to isolate the input side, so that case
        // (and a non-string modality) falls through to "don't know" below,
        // same defensive posture as the input_modalities branch above.
        const inputSide = architecture.modality.split('->')[0];
        m.supportsVision = inputSide.includes('image');
      }
      // OpenRouter pricing is USD-per-TOKEN strings; CatalogModel.pricing is
      // USD per 1M tokens, hence the *1e6. Require strings with NON-WHITESPACE
      // CONTENT before Number(): Number(null), Number('') and Number('  ') are
      // all 0, which would map a JSON null — or a field the upstream padded
      // with spaces — to "free", violating "absent fields are omitted, never
      // guessed" (header comment). The .trim() is the load-bearing part: a
      // padded field must read as "not published", NOT as a real rate of zero,
      // which would silently bill the user's cached reads at $0. Matches the
      // sibling parser in harness/eval/estimate.ts (isNumeric).
      const pricing = isObj(row.pricing) ? row.pricing : null;
      if (pricing
          && typeof pricing.prompt === 'string' && pricing.prompt.trim() !== ''
          && typeof pricing.completion === 'string' && pricing.completion.trim() !== '') {
        const prompt = Number(pricing.prompt);
        const completion = Number(pricing.completion);
        // Zero TOKEN rates are only "free" when nothing else is charged either.
        // OpenRouter also publishes per-request, per-image and per-search fees;
        // a model billed that way and 0/0 per token is billed in a unit this
        // app does not model, which is "not published", never "$0". It matters
        // beyond the cost chip: a specialists plan freezes an all-zero price
        // list as `free` and then runs with NO dollar limit at all.
        const billedOtherwise = ['request', 'image', 'web_search', 'internal_reasoning']
          .some((k) => Number(typeof pricing[k] === 'string' ? pricing[k] : 0) > 0);
        if (Number.isFinite(prompt) && Number.isFinite(completion) && !(prompt === 0 && completion === 0 && billedOtherwise)) {
          m.pricing = { in: prompt * 1e6, out: completion * 1e6 };
          // Cache rates ride the same payload and the same never-guess rule:
          // a model that doesn't publish them leaves them UNSET, so the cost
          // chip falls back to the full input rate rather than pricing a
          // cached read at $0.
          const cr = typeof pricing.input_cache_read === 'string' && pricing.input_cache_read.trim() !== ''
            ? Number(pricing.input_cache_read) : NaN;
          const cw = typeof pricing.input_cache_write === 'string' && pricing.input_cache_write.trim() !== ''
            ? Number(pricing.input_cache_write) : NaN;
          if (Number.isFinite(cr)) m.pricing.cacheRead = cr * 1e6;
          if (Number.isFinite(cw)) m.pricing.cacheWrite = cw * 1e6;
        }
      }
      out.push(m);
    }
    return out;
  }

  /** models.dev api.json rows for one provider key → CatalogModel. */
  private modelsdevModels(payload: any, key: string, providerId: string): CatalogModel[] {
    const models = isObj(payload) && isObj(payload[key]) && isObj(payload[key].models)
      ? payload[key].models : null;
    if (!models) return [];
    const out: CatalogModel[] = [];
    for (const [id, row] of Object.entries(models)) {
      if (!isObj(row)) continue; // skip malformed
      const m: CatalogModel = {
        id,
        providerId,
        label: typeof row.name === 'string' ? row.name : id,
      };
      if (isObj(row.limit) && typeof row.limit.context === 'number') m.contextLength = row.limit.context;
      if (typeof row.tool_call === 'boolean') m.supportsTools = row.tool_call;
      if (typeof row.reasoning === 'boolean') m.supportsReasoning = row.reasoning;
      // models.dev cost is already USD per 1M tokens — no scaling.
      if (isObj(row.cost) && typeof row.cost.input === 'number' && typeof row.cost.output === 'number') {
        m.pricing = { in: row.cost.input, out: row.cost.output };
        // Same never-guess rule as the OpenRouter mapper: only carry a cache
        // rate the source actually published.
        if (typeof row.cost.cache_read === 'number') m.pricing.cacheRead = row.cost.cache_read;
        if (typeof row.cost.cache_write === 'number') m.pricing.cacheWrite = row.cost.cache_write;
      }
      out.push(m);
    }
    return out;
  }

  /** Catalog rows scoped to the ENABLED providers passed in. Never throws. */
  async get(providers: ProviderStatus[]): Promise<CatalogModel[]> {
    // ensureFresh() IS the network — it fetches OpenRouter and models.dev
    // unconditionally, 15 s abort apiece, and on a total failure it returns
    // WITHOUT memoizing, so the next call pays the same price again. Only two
    // provider families can consume what it fetches; a call that has none of
    // them must not pay for it.
    //
    // WHY this matters more than it looks: a purely LOCAL, offline user — the
    // exact person the bundled engine exists for — has one enabled provider,
    // 'local'. Before this gate, every session create, resume and model swap
    // stalled inside the profile resolver on two doomed fetches. MEASURED
    // 2026-09-05 against a network that accepts and never answers: 4 fetches
    // and 15.1 s per get(), repeated on every single call. With the gate: 0
    // fetches, 0 ms.
    //
    // Reads `p.enabled` because the loop below does: a DISABLED OpenRouter row
    // contributes no models, so it must not drag the network in either.
    const needsNetwork = providers.some((p) => p.enabled && (p.type === 'openrouter' || MODELSDEV_KEY[p.type]));
    const cache = needsNetwork ? await this.ensureFresh() : EMPTY_CACHE;
    const out: CatalogModel[] = [];
    for (const p of providers) {
      if (!p.enabled) continue; // disabled providers contribute nothing
      if (p.type === 'openrouter') {
        out.push(...this.openrouterModels(cache.openrouter, p.id));
      } else if (MODELSDEV_KEY[p.type]) {
        out.push(...this.modelsdevModels(cache.modelsdev, MODELSDEV_KEY[p.type], p.id));
      } else if (p.type === 'local-engine' && this.localModels) {
        // Plan B: rows come from the engine manager (GET /models when the
        // engine runs, cache scan when stopped). Failure degrades to "no
        // local rows" — get() keeps its never-throws contract.
        try { out.push(...await this.localModels()); } catch { /* engine unavailable */ }
      } else if (p.type === 'chatgpt' && p.ready && this.chatgptModels) {
        // `ready` here, not just `enabled` (§4.6): when OpenAI blocks the
        // account the cached model list is deliberately kept (so the card can
        // still say who is signed in), but those models must leave the
        // catalog. The two pickers filter on ready themselves; the app's own
        // ModelSearch tool does not — without this gate the assistant is
        // offered plan models it cannot use, hands a task to one, and the user
        // gets "Codex is disabled for this workspace." instead of an answer.
        // Rows are the plan's own manifest, parsed and cached by ChatGptAuth
        // (id = slug, no pricing — the plan is not per-token, and an absent
        // price must read as absent, never $0). A throwing source degrades
        // to no ChatGPT rows; get() keeps its never-throws contract.
        try { out.push(...await this.chatgptModels()); } catch { /* account unavailable */ }
      }
      // openai-compatible custom endpoints still have no catalog (user types a model id).
    }
    return out;
  }

  /** HarnessSession asks this for context-window sizing. null when the model
   *  isn't in the catalog (custom endpoints, stale cache) — caller decides. */
  async contextLengthFor(binding: ModelBinding, providers: ProviderStatus[]): Promise<number | null> {
    const models = await this.get(providers);
    const hit = models.find((m) => m.providerId === binding.providerId && m.id === binding.modelId);
    // WHY resolve here, not in get(): catalog metadata describes capability;
    // the saved preference limits only the session's operating budget. Read it
    // afresh on create/resume/model switch without invalidating the model cache.
    const type = providers.find((p) => p.id === binding.providerId)?.type;
    return cloudContextLength(type, hit, this.contextPreferences());
  }
}
