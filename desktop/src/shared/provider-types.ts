// Provider-layer shapes — Phase 1 Plan A (spec 2026-07-10-phase1-engine-providers-design.md §2.2).
// Shared between main and renderer; keep free of Node/Electron imports.

export type ProviderType =
  | 'local-engine'        // supervised llama-server (registered in Plan B; entry exists from day one)
  | 'openai-compatible'   // Ollama, LM Studio, custom endpoints
  | 'openrouter'
  | 'anthropic' | 'openai' | 'google'   // direct-key providers
  // Sign in with ChatGPT: the user's own plan, reached through OpenAI's sign-in
  // rather than a key. Keyless like 'local-engine' — `ready` means signed in.
  // shared/chatgpt-types.ts carries the account state.
  | 'chatgpt';

/** OpenRouter's add-credit page. One constant because the Settings card's My
 *  Account button and the chat's "Add credit" button must land in the same
 *  place — there is no purchase API, so adding credit is always this link. */
export const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/settings/credits';

/** What the app last learned about a stored key by asking the provider
 *  (connection-trust design 2026-08-31, re-based 2026-09-18, §3.1). WHY it
 *  exists: "a key is saved" is not "the key works" — a dead key used to read
 *  Connected. Only OpenRouter reports one today. */
export interface ProviderHealth {
  /** verified: the provider accepted the key. rejected: it refused it (see
   *  reason). unchecked: the provider could not be reached, so nothing is known. */
  verdict: 'verified' | 'rejected' | 'unchecked';
  reason?: 'openrouter-key-rejected' | 'openrouter-key-expired' | 'openrouter-forbidden' | 'openrouter-wrong-key-type';
  /** ISO date the key stops working, when the provider reported one. */
  expiresAt?: string;
  /** Epoch ms of the check this verdict came from. */
  checkedAt: number;
}

/** Sign in with OpenRouter (connection-trust design §3.5): a browser
 *  round-trip that ends with OpenRouter handing the app a key. What the card
 *  polls while the browser is open. The key itself never crosses to the screen.
 *  WHY `failed` carries a message: the card says what went wrong in plain
 *  words, then offers the button again. */
export interface OpenRouterSignInStatus {
  state: 'idle' | 'waiting' | 'failed';
  message?: string;
}

export interface ProviderConfig {
  id: string;             // 'local' | 'openrouter' | ulid for user-created entries
  type: ProviderType;
  label: string;
  baseUrl?: string;       // openai-compatible + overrides
  secretRef?: string;     // pointer into the userData secrets store; never the key itself
  enabled: boolean;
}

/** True when a custom endpoint's address points at this computer — Ollama,
 *  LM Studio and the like. The only signal the app has to file a custom
 *  endpoint under Local Models rather than Cloud Models (Destin, 2026-09-05:
 *  "wouldn't that be local?"); a server elsewhere keeps its cloud placement. */
export function isLocalEndpoint(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1'
      || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

/** What a native session is bound to: one model on one provider. */
export interface ModelBinding { providerId: string; modelId: string; }

export interface CatalogModel {
  id: string;             // provider-native model id (what the API expects)
  providerId: string;
  label: string;
  contextLength?: number;
  /** ChatGPT's advertised opt-in maximum, distinct from its default window.
   *  WHY separate: merely listing a model must not opt a plan into long context. */
  maxContextLength?: number;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  // Whether this catalog row's model accepts image input, per the SOURCE's own
  // modality data. Two sources publish it, both under the same name
  // `architecture.input_modalities`: OpenRouter's /models (see
  // model-catalog.ts's openrouterModels()) and llama-server's own /models for a
  // LOCAL model (see EngineManager.catalogModels — `["text","image"]` exactly
  // when the engine paired a vision projector beside the weights).
  // `undefined` means "this source does not know" (models.dev rows, a local row
  // read off the disk scan because the engine is stopped, or a malformed row)
  // — a caller must NOT read that as `false`. Only an actual `false` means the
  // source affirmatively says the model can't see images.
  supportsVision?: boolean;
  // USD per 1M tokens — terse to mirror per-1M-token convention; `in` is a JS
  // keyword — destructure as `{ in: input }`.
  /** USD per 1,000,000 tokens. `cacheRead`/`cacheWrite` are optional because
   *  not every provider publishes them; absent means "not published", never
   *  "free" (see the catalog's never-guess rule). Modelling them is what keeps
   *  the session-cost chip from over-reporting a cached session (spec §5). */
  pricing?: { in: number; out: number; cacheRead?: number; cacheWrite?: number };
  // Local-engine models only (Plan B/C). fit is Plan C's estimator; Plan B
  // fills sizeBytes/quant('unknown')/installed(true) from the cache scan.
  local?: { sizeBytes: number; quant: string; installed: boolean; fit?: 'fits' | 'tight' | 'too-large';
            state?: import('./engine-types').EngineModelState };
}

/** provider:list row — config + derived status, never the key.
 *  Do NOT pass a status row back into provider:upsert — handlers must pick
 *  ProviderConfig keys only, or the derived fields (builtIn/hasKey/ready)
 *  get persisted. */
export interface ProviderStatus extends ProviderConfig {
  builtIn: boolean;       // 'local' and 'openrouter' cannot be removed
  hasKey: boolean;        // a secret exists for secretRef
  ready: boolean;         // enabled AND (keyless type OR hasKey); 'local' stays false until Plan B
  /** Read-only: the last check of this profile's key (§3.1). Absent until a
   *  check has run. Never sent back to provider:upsert. */
  health?: ProviderHealth;
}
