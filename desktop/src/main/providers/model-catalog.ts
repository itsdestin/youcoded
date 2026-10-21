// Merged, disk-cached model catalog (spec §2.2): OpenRouter /api/v1/models for
// the openrouter provider; models.dev api.json metadata for direct-key
// providers (anthropic/openai/google). openai-compatible custom endpoints get
// models.dev rows when their address matches a published provider address
// (custom-providers spec). External schemas are recorded
// in docs/provider-dependencies.md — parse DEFENSIVELY; absent fields are
// omitted, never guessed.
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { CatalogModel, ModelBinding, ProviderModelInfo, ProviderStatus, ServiceEntry } from '../../shared/provider-types';
import { DEFAULT_CONTEXT_PREFERENCES, type ContextPreferences } from '../../shared/context-preferences';
import { cloudContextLength } from './cloud-context';
import { normalizeEndpoint } from '../../shared/endpoint-address';
import { isLocalEndpoint } from '../../shared/provider-types';

const CACHE_FILE = 'provider-catalog-cache.json';
const TTL_MS = 24 * 60 * 60 * 1000; // 24h, marketplace-cache precedent
// Model lists are big but not huge; a slow fetch should not hang the picker.
const FETCH_TIMEOUT_MS = 15_000;
// A custom endpoint's own /models: one server, a short list — 8 s is plenty and keeps the picker responsive.
const ENDPOINT_TIMEOUT_MS = 8_000;
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

/** Whether any of these providers can use the internet catalogs (OpenRouter / models.dev). */
function needsNetwork(providers: ProviderStatus[]): boolean {
  return providers.some((p) => p.enabled && (
    p.type === 'openrouter' || !!MODELSDEV_KEY[p.type]
    // A custom endpoint elsewhere can be matched by address (models.dev). One on THIS computer
    // (Ollama, LM Studio) never is, so a purely local user still pays nothing — see the WHY in get().
    || (p.type === 'openai-compatible' && !!p.baseUrl && !isLocalEndpoint(p.baseUrl))));
}

/** One OpenRouter-shaped row → CatalogModel, or null when malformed. Shared with a custom
 *  endpoint's own /models, which many servers answer in the same shape. */
function openrouterRow(row: unknown, providerId: string): CatalogModel | null {
  if (!isObj(row) || typeof row.id !== 'string') return null; // skip malformed
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
    if (Number.isFinite(prompt) && Number.isFinite(completion)) {
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
  return m;
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
  // The saved key for a custom endpoint (ProviderRegistry.endpointKey), for its own /models ask.
  private readonly endpointKey: ((id: string) => Promise<string | undefined>) | null;
  // A custom endpoint's own /models answers, in memory only (see endpointModels).
  private endpointCache = new Map<string, { at: number; rows: CatalogModel[] }>();
  private endpointInflight = new Map<string, Promise<{ rows: CatalogModel[]; ok: boolean }>>();
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
  // The one upstream fetch in flight, shared by every caller (see ensureFresh).
  private fetching: Promise<{ shape: CacheShape; failed: string[] }> | null = null;
  // The one "Check for new models" run in flight; a second press joins it.
  private refreshing: Promise<{ added: number; failed: string[] }> | null = null;
  // services() answers, per models.dev payload object — the payload is replaced, never mutated.
  private servicesMemo = new WeakMap<object, ServiceEntry[]>();
  private readonly refreshChatgpt: (() => Promise<void>) | null;
  constructor(cacheDir: string, private fetchImpl: FetchLike = fetch as any,
              // opts.ttlMs is TEST-ONLY (same convention as SecretsStore's
              // maxRetries) — lets the stale-fallback tests force expiry
              // without poking private fields. Production callers omit it.
              opts?: {
                ttlMs?: number;
                localModels?: () => Promise<CatalogModel[]>;
                chatgptModels?: () => Promise<CatalogModel[]>;
                contextPreferences?: () => ContextPreferences;
                endpointKey?: (providerId: string) => Promise<string | undefined>;
                refreshChatgpt?: () => Promise<void>;
              }) {
    this.cachePath = path.join(cacheDir, CACHE_FILE);
    this.ttlMs = opts?.ttlMs ?? TTL_MS;
    this.localModels = opts?.localModels ?? null;
    this.chatgptModels = opts?.chatgptModels ?? null;
    this.contextPreferences = opts?.contextPreferences ?? (() => DEFAULT_CONTEXT_PREFERENCES);
    this.endpointKey = opts?.endpointKey ?? null;
    this.refreshChatgpt = opts?.refreshChatgpt ?? null;
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

  /** Fresh-or-refetched cache, plus which upstream sources failed on THIS call (empty when it was
   *  served from cache). NEVER throws — a dead network degrades to the stale cache, or to an empty
   *  catalog when there is no cache at all.
   *  `force` (Check for new models) skips both freshness checks.
   *  Single-flight: while a fetch runs, every caller — forced or not — shares it. WHY: a refresh click
   *  and a picker read landing together must not double the upstream traffic, and an answer that
   *  started after nothing was cached is as new as a forced one would be.
   *  The cache-file write stays IN this function: the main-blocking allowlist names it. */
  private async ensureFresh(opts?: { force?: boolean }): Promise<{ shape: CacheShape; failed: string[] }> {
    if (!opts?.force && this.memo && Date.now() - this.memo.fetchedAt < this.ttlMs) return { shape: this.memo, failed: [] };
    if (this.fetching) return this.fetching;
    // A forced refresh with a memo already in hand need not read the disk: the memo is the newest copy.
    const stale = opts?.force && this.memo ? this.memo : (this.readCache() ?? this.memo);
    if (!opts?.force && stale && Date.now() - stale.fetchedAt < this.ttlMs) { this.memo = stale; return { shape: stale, failed: [] }; }
    const run = this.fetchBoth(stale).then((r) => {
      if (r.write) {
        // Plain write, no tmp+rename: single consumer and fully rebuildable — a torn file just reads
        // as corrupt → refetch on the next call. Write failures (read-only disk) are absorbed.
        try {
          fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
          fs.writeFileSync(this.cachePath, JSON.stringify(r.shape));
        } catch { /* cache write is best-effort */ }
        // Memoize unconditionally — the serve-path TTL check above decides whether this shape is fresh
        // enough to reuse (a partial refresh from cold carries an expired stamp and re-fetches next call).
        this.memo = r.shape;
      }
      return { shape: r.shape, failed: r.failed };
    }).finally(() => { if (this.fetching === run) this.fetching = null; });
    this.fetching = run;
    return run;
  }

  /** Both upstream lists in parallel. Per-source failure keeps that source's stale data (one dead
   *  upstream must not blank the other's models).
   *  - both succeed → stamped now;
   *  - exactly one succeeds → the good payload replaces its half and the OLD stamp is kept, so a
   *    cold-start partial (stamp 0) retries both next call — otherwise one source being down on the very
   *    first fetch would leave that provider's picker empty for a full TTL; `write: true`;
   *  - both fail → the stale shape as-is (or empty), NOT re-stamped and not written (`write: false`).
   *  `failed` names the sources that failed on this call. */
  private async fetchBoth(stale: CacheShape | null): Promise<{ shape: CacheShape; write: boolean; failed: string[] }> {
    let openrouter: any | null = stale?.openrouter ?? null;
    let modelsdev: any | null = stale?.modelsdev ?? null;
    let orSuccess = false;
    let mdSuccess = false;
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
    const failed = [...(orSuccess ? [] : ['OpenRouter']), ...(mdSuccess ? [] : ['models.dev'])];
    if (!orSuccess && !mdSuccess) return { shape: stale ?? EMPTY_CACHE, write: false, failed };
    const fetchedAt = orSuccess && mdSuccess ? Date.now() : stale?.fetchedAt ?? 0;
    return { shape: { fetchedAt, openrouter, modelsdev }, write: true, failed };
  }

  /** OpenRouter /api/v1/models rows → CatalogModel. Schema coupling recorded
   *  in docs/provider-dependencies.md; skip anything malformed. */
  private openrouterModels(payload: any, providerId: string): CatalogModel[] {
    const rows = isObj(payload) && Array.isArray(payload.data) ? payload.data : [];
    const out: CatalogModel[] = [];
    for (const row of rows) {
      const m = openrouterRow(row, providerId);
      if (m) out.push(m);
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

  /** The models.dev key whose published address is this endpoint's, or null.
   *  WHY only OpenAI-compatible entries: those are the ones this app can talk to at an arbitrary
   *  address. WHY "most models, then key name": models.dev publishes some addresses twice (a gateway
   *  and its "providers" view); the choice must not depend on JSON key order. */
  private modelsdevKeyForAddress(payload: any, baseUrl: string | undefined): string | null {
    const want = baseUrl ? normalizeEndpoint(baseUrl) : null;
    if (!want || !isObj(payload)) return null;
    let best: { key: string; count: number } | null = null;
    for (const [key, entry] of Object.entries(payload)) {
      if (!isObj(entry) || entry.npm !== '@ai-sdk/openai-compatible' || typeof entry.api !== 'string') continue;
      if (normalizeEndpoint(entry.api) !== want) continue;
      const count = isObj(entry.models) ? Object.keys(entry.models).length : 0;
      if (!best || count > best.count || (count === best.count && key < best.key)) best = { key, count };
    }
    return best?.key ?? null;
  }

  /** A custom endpoint's own GET /models, for an address models.dev does not know.
   *  `ok` is false when the ask failed (network, timeout, non-2xx, bad JSON) — `rows` then holds the
   *  previous answer for the same provider + address + key, else []. `refresh()` reports `ok`.
   *  `cacheOnly`: never ask; answer only what is cached (session-start paths, plan C-1).
   *  WHY keyed by key fingerprint and normalized address: an edited address or a replaced key must
   *  never be served another one's list. WHY memory only: the list is cheap to re-ask, and a file write
   *  here would block the main process (rule: main never blocks). Never throws. */
  private async endpointModels(p: ProviderStatus, opts?: { force?: boolean; cacheOnly?: boolean }): Promise<{ rows: CatalogModel[]; ok: boolean }> {
    const base = p.baseUrl ? normalizeEndpoint(p.baseUrl) : null;
    if (!base || !p.baseUrl) return { rows: [], ok: true };
    let key: string | undefined;
    try { key = (await this.endpointKey?.(p.id)) || undefined; } catch { key = undefined; }
    const fp = key ? createHash('sha256').update(key).digest('hex').slice(0, 16) : 'none';
    const cacheKey = `${p.id}\0${base}\0${fp}`;
    const hit = this.endpointCache.get(cacheKey);
    if (opts?.cacheOnly) return { rows: hit?.rows ?? [], ok: true };
    if (hit && !opts?.force && Date.now() - hit.at < this.ttlMs) return { rows: hit.rows, ok: true };
    // WHY share a running ask even when forced: a refresh that joins an ask already in flight gets
    // an answer at least as new as the click — a second request would add nothing.
    const running = this.endpointInflight.get(cacheKey);
    if (running) return running;
    const url = `${p.baseUrl.replace(/\/+$/, '')}/models`;
    const ask = (async () => {
      try {
        const res = await this.fetchImpl(url, {
          headers: key ? { Authorization: `Bearer ${key}` } : undefined,
          signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error('not ok');
        const body = await res.json();
        const list = Array.isArray(body) ? body : isObj(body) && Array.isArray(body.data) ? body.data : null;
        if (!list) throw new Error('no list');
        const rows = list.map((r: unknown) => openrouterRow(r, p.id)).filter((r: CatalogModel | null): r is CatalogModel => r !== null);
        this.endpointCache.set(cacheKey, { at: Date.now(), rows });
        return { rows, ok: true };
      } catch {
        return { rows: hit?.rows ?? [], ok: false };
      } finally {
        this.endpointInflight.delete(cacheKey);
      }
    })();
    this.endpointInflight.set(cacheKey, ask);
    return ask;
  }

  /** Catalog rows scoped to the ENABLED providers passed in. Never throws.
   *  `cacheOnly`: answer from what is already in memory — never read the disk, never fetch. WHY: the
   *  session-start closures in create-runtime ask about a custom endpoint on every create/resume/swap;
   *  widening the network gate to custom endpoints must not put two 15 s fetches in front of a chat. */
  async get(providers: ProviderStatus[], opts?: { cacheOnly?: boolean }): Promise<CatalogModel[]> {
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
    const cache = !needsNetwork(providers) ? EMPTY_CACHE : opts?.cacheOnly ? (this.memo ?? EMPTY_CACHE) : (await this.ensureFresh()).shape;
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
      } else if (p.type === 'openai-compatible') {
        // Matched by address to a models.dev provider first.
        const key = this.modelsdevKeyForAddress(cache.modelsdev, p.baseUrl);
        if (key) out.push(...this.modelsdevModels(cache.modelsdev, key, p.id));
        // Otherwise the endpoint's own list (Ollama, LM Studio, a proxy, a service models.dev lacks).
        // A local address is asked too: that is the user's own computer, not the internet.
        else out.push(...(await this.endpointModels(p, { cacheOnly: opts?.cacheOnly })).rows);
      }
    }
    return out;
  }

  /** The services Add provider can search: every models.dev provider this app can reach at an
   *  address (OpenAI-compatible), with at least one model, not on this computer. One entry per address
   *  — the one get() would match. Offline with nothing cached → []. Never throws. */
  async services(): Promise<ServiceEntry[]> {
    const payload = (await this.ensureFresh()).shape.modelsdev;
    if (!isObj(payload)) return [];
    const memo = this.servicesMemo.get(payload);
    if (memo) return memo;
    const out: ServiceEntry[] = [];
    for (const [key, entry] of Object.entries(payload)) {
      if (!isObj(entry) || entry.npm !== '@ai-sdk/openai-compatible' || typeof entry.api !== 'string') continue;
      if (!normalizeEndpoint(entry.api) || isLocalEndpoint(entry.api)) continue;
      // Only the entry the catalog would match for this address (WHY: never list a service whose
      // models the picker would then not show).
      if (this.modelsdevKeyForAddress(payload, entry.api) !== key) continue;
      const models = isObj(entry.models) ? Object.entries(entry.models).filter(([, r]) => isObj(r)) as [string, Record<string, any>][] : [];
      if (models.length === 0) continue;
      const rows = models.map(([id, r]) => {
        const m: NonNullable<ServiceEntry['models']>[number] = { id, label: typeof r.name === 'string' && r.name ? r.name : id };
        if (isObj(r.limit) && typeof r.limit.context === 'number') m.contextLength = r.limit.context;
        if (isObj(r.cost) && typeof r.cost.input === 'number' && typeof r.cost.output === 'number') { m.priceIn = r.cost.input; m.priceOut = r.cost.output; }
        if (typeof r.tool_call === 'boolean') m.tools = r.tool_call;
        return m;
      });
      rows.sort((a, b) => (b.contextLength ?? -1) - (a.contextLength ?? -1));
      out.push({
        id: key,
        label: typeof entry.name === 'string' && entry.name.trim() ? entry.name : key,
        baseUrl: entry.api.replace(/\/+$/, ''),
        modelCount: models.length,
        // WHY at most 50: ~190 services × up to hundreds of models would send megabytes to a phone;
        // the Models fold shows a handful.
        models: rows.slice(0, 50),
      });
    }
    out.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
    this.servicesMemo.set(payload, out);
    return out;
  }

  /** "Check for new models": re-download every model list now, skipping the daily cache.
   *  `added` = models present after that were not before; `failed` = the sources and custom endpoints
   *  that could not be reached (their previous lists are kept). A second press while one runs joins it.
   *  Never throws. */
  refresh(providers: ProviderStatus[]): Promise<{ added: number; failed: string[] }> {
    if (this.refreshing) return this.refreshing;
    const keys = (rows: CatalogModel[]) => new Set(rows.map((m) => `${m.providerId}\0${m.id}`));
    const run = (async () => {
      try {
        // "Before" = what is already in memory, so measuring it never starts a fetch of its own.
        const before = keys(await this.get(providers, { cacheOnly: true }));
        const failed: string[] = [];
        let modelsdev: any = this.memo?.modelsdev ?? null;
        if (needsNetwork(providers)) {
          const r = await this.ensureFresh({ force: true });
          failed.push(...r.failed);
          modelsdev = r.shape.modelsdev;
        }
        for (const p of providers) {
          if (!p.enabled || p.type !== 'openai-compatible') continue;
          if (this.modelsdevKeyForAddress(modelsdev, p.baseUrl)) continue;
          const r = await this.endpointModels(p, { force: true });
          if (!r.ok) failed.push(p.label);
        }
        // The plan's own manifest; its retry spacing may make this a no-op, which is fine.
        try { await this.refreshChatgpt?.(); } catch { /* reported nowhere: the plan keeps its list */ }
        const after = keys(await this.get(providers, { cacheOnly: true }));
        let added = 0;
        for (const k of after) if (!before.has(k)) added++;
        return { added, failed: [...new Set(failed)] };
      } catch {
        return { added: 0, failed: [] };
      }
    })().finally(() => { if (this.refreshing === run) this.refreshing = null; });
    this.refreshing = run;
    return run;
  }

  /** How many models each provider brings, from data ALREADY IN MEMORY — no disk read, no fetch, no
   *  ask (WHY memory only: this runs on every Providers-screen open, and readCache is a blocking read
   *  of a multi-MB file on the main process). For the Providers screen's cards only
   *  (ipc/provider.ts providerListWithCounts). A provider with nothing cached is left out, so the
   *  card shows no number rather than "0 models". Only key-based cloud types count: ChatGPT and the
   *  local engine have their own cards. */
  cachedCounts(providers: ProviderStatus[]): Map<string, ProviderModelInfo> {
    const out = new Map<string, ProviderModelInfo>();
    const cache = this.memo;
    for (const p of providers) {
      if (!p.enabled) continue;
      let rows: CatalogModel[] = [];
      let source: ProviderModelInfo['source'] = 'catalog';
      if (p.type === 'openrouter') { if (cache) rows = this.openrouterModels(cache.openrouter, p.id); }
      else if (MODELSDEV_KEY[p.type]) { if (cache) rows = this.modelsdevModels(cache.modelsdev, MODELSDEV_KEY[p.type], p.id); }
      else if (p.type === 'openai-compatible') {
        const key = cache ? this.modelsdevKeyForAddress(cache.modelsdev, p.baseUrl) : null;
        if (key && cache) rows = this.modelsdevModels(cache.modelsdev, key, p.id);
        else {
          const base = p.baseUrl ? normalizeEndpoint(p.baseUrl) : null;
          // Any cached list for this provider and address, whichever key fingerprint it was asked with
          // — a count is not a secret, and the newest one is the best guess.
          const hit = base ? [...this.endpointCache.entries()].filter(([k]) => k.startsWith(`${p.id}\0${base}\0`))
            .sort((a, b) => b[1].at - a[1].at)[0]?.[1] : undefined;
          if (hit) { rows = hit.rows; source = 'endpoint'; }
        }
      }
      if (rows.length > 0) out.set(p.id, { count: rows.length, source });
    }
    return out;
  }

  /** HarnessSession asks this for context-window sizing. null when the model
   *  isn't in the catalog (custom endpoints, stale cache) — caller decides. */
  async contextLengthFor(binding: ModelBinding, providers: ProviderStatus[], opts?: { cacheOnly?: boolean }): Promise<number | null> {
    const models = await this.get(providers, opts);
    const hit = models.find((m) => m.providerId === binding.providerId && m.id === binding.modelId);
    // WHY resolve here, not in get(): catalog metadata describes capability;
    // the saved preference limits only the session's operating budget. Read it
    // afresh on create/resume/model switch without invalidating the model cache.
    const type = providers.find((p) => p.id === binding.providerId)?.type;
    return cloudContextLength(type, hit, this.contextPreferences());
  }
}
