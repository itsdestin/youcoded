// ProviderRegistry — CRUD over ~/.youcoded/providers.json + key management +
// the ONE factory the harness calls: languageModel(binding) -> AI SDK handle.
// (Spec §2.2. providers.json never holds keys — only secretRef pointers into
// the safeStorage-encrypted SecretsStore.)
//
// Thrown error messages here surface DIRECTLY in the UI error banner, so they
// are written as plain language telling the user what to do — not debug codes.
import { ulid } from 'ulid';
import { app } from 'electron';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { bindOpenAIContinuationModel } from '../harness/openai-continuation';
import { ChatGptRequestDiagnostics } from './chatgpt-request-diagnostics';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { openRouterCostExtractor } from '../harness/pricing';
import { withPrefillProgress, type PrefillProgress } from './prefill-progress';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import type { ProviderConfig, ProviderStatus, ModelBinding } from '../../shared/provider-types';
import type { LocalEngineHook } from '../engine/engine-manager';
import { NativeHome } from '../native-home';
import { SecretsStore } from './secrets-store';
import type { ChatGptAuth } from './chatgpt-auth';
import { CHATGPT_CODEX_BASE_URL, CHATGPT_SIGN_IN_REQUIRED_MESSAGE } from './chatgpt-oauth';
import { chatGptMiddleware } from './chatgpt-model';
import { promptCacheMiddleware, type PromptCacheProvider } from './prompt-cache';

const FILE = 'providers.json';
const BUILT_INS: ProviderConfig[] = [
  // 'local' exists from day one so the Providers panel can show it as
  // "coming with the local engine" — Plan B flips it ready.
  { id: 'local', type: 'local-engine', label: 'Local models (llama.cpp)', enabled: true },
  { id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true },
];
const BUILT_IN_IDS = new Set(BUILT_INS.map((b) => b.id));
// Sign in with ChatGPT (backend design §2). This row is VIRTUAL: it is
// appended to what readAll() returns and is NEVER in BUILT_INS, because init()
// writes every BUILT_INS entry to ~/.youcoded/providers.json — a file shared
// by every instance on this machine, including Destin's built app and older
// builds, whose Providers panel would render a persisted 'chatgpt' row as a
// stray API-key card with a Remove button. Nothing on disk means nothing for
// an older build to misread and nothing for the kill switch to migrate.
const CHATGPT_ROW: ProviderConfig = { id: 'chatgpt', type: 'chatgpt', label: 'ChatGPT Plan', enabled: true };
const VIRTUAL_IDS = new Set([CHATGPT_ROW.id]);
// The one sentence upsert/remove/setKey answer for the virtual row: there is no
// key to save and no entry to delete — the card's Sign out is the only control.
const CHATGPT_NOT_A_KEY_MESSAGE =
  'ChatGPT is signed in through OpenAI, not with a key — use Sign out on its card.';
// Kill switch (§6): the registry is constructed with chatgpt = null, the row
// is not appended, and a session already bound to a ChatGPT model fails its
// next turn with this.
const CHATGPT_TURNED_OFF_MESSAGE = 'ChatGPT sign-in is turned off in this build.';
// The Codex endpoint wants to know which app is talking; 'youcoded' is us,
// never the Codex CLI's own string (the investigation's rule: identify honestly).
const CHATGPT_ORIGINATOR = 'youcoded';
// OpenRouter asks apps to identify themselves (provider-dependencies.md entry).
// OpenRouter shows these on its app leaderboard. youcoded.ai is the real domain
// (bought 2026-09-03); the earlier youcoded.app placeholder was never ours.
const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://youcoded.ai', 'X-Title': 'YouCoded' };
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
// Connection probes should fail fast, not hang the Providers panel.
const TEST_TIMEOUT_MS = 10_000;

interface ProvidersFile { v: 1; providers: ProviderConfig[]; }

export class ProviderRegistry {
  private diagnostics?: ChatGptRequestDiagnostics;
  constructor(private home: NativeHome, private secrets: SecretsStore,
              /** Plan B injects the EngineManager hook; null keeps the Plan A
               *  "coming in a later update" behavior (also what unit tests
               *  without an engine use). */
              private localEngine: LocalEngineHook | null = null,
              /** Sign in with ChatGPT. null = the kill switch (YOUCODED_CHATGPT=0)
               *  or a unit test without it: the virtual row is not listed and a
               *  ChatGPT binding is refused with a plain sentence. */
              private chatgpt: ChatGptAuth | null = null) {}

  /** Seed the built-in entries. Runs under the file lock so two processes
   *  (dev instance + built app share ~/.youcoded) can't double-seed. */
  async init(): Promise<void> {
    await this.home.mutateJson(FILE, (cur) => {
      const file = (cur as ProvidersFile | null) ?? { v: 1 as const, providers: [] };
      for (const b of BUILT_INS) {
        // Idempotent: only add a built-in that isn't already on disk, and never
        // overwrite one that is — the user may have disabled it or set a key.
        if (!file.providers.some((p) => p.id === b.id)) file.providers.push({ ...b });
      }
      return file;
    });
  }

  private readAll(): ProviderConfig[] {
    const onDisk = ((this.home.readJson(FILE) as ProvidersFile | null)?.providers) ?? [];
    if (!this.chatgpt) return onDisk;
    // The virtual row goes LAST, and that position is load-bearing. The
    // new-session form defaults to the FIRST ready provider, and ChatGPT's
    // model list is cache-first: for the first seconds after signing in — and
    // indefinitely while the manifest fetch keeps failing (offline, or a 401)
    // — the plan is "ready" with zero models. First position would make that
    // the default pick, and Create would sit greyed out with nothing said,
    // even though the user's OpenRouter models are one dropdown away. Last
    // means the user only lands on the plan by choosing it.
    // (It used to go first so an id-only model lookup would prefer the plan's
    // row when an OpenAI-key provider lists the same id. That is handled on
    // its own in the renderer's resolveProviderType, which explicitly prefers
    // providerId === 'chatgpt' before any first-match fallback.)
    // Any on-disk row with the virtual id is dropped, so a file written by a
    // buggy build can never shadow the live one or list it twice.
    return [...onDisk.filter((p) => !VIRTUAL_IDS.has(p.id)), CHATGPT_ROW];
  }

  /**
   * Status rows for the Providers panel: config + derived booleans, never the
   * key itself (only the opaque secretRef pointer rides along).
   */
  async list(): Promise<ProviderStatus[]> {
    return this.readAll().map((p) => {
      // The virtual ChatGPT row reports builtIn so the panel never offers Remove.
      const builtIn = BUILT_IN_IDS.has(p.id) || VIRTUAL_IDS.has(p.id);
      const hasKey = this.secrets.has(p.secretRef);
      // "Keyless" = a type that can work without an API key: the local engine
      // never needs one, ChatGPT signs in instead of keying, and an
      // openai-compatible endpoint (Ollama, LM Studio) only needs one when the
      // user saved one.
      const keyless = p.type === 'local-engine' || p.type === 'chatgpt'
        || (p.type === 'openai-compatible' && !p.secretRef);
      const ready =
        p.enabled &&
        (p.type === 'local-engine'
          ? (this.localEngine?.installed() ?? false) // ready = engine installed (running is lazy)
          : p.type === 'chatgpt'
            // ready = signed in and not blocked (§4.6: a blocked account stays
            // listed with ready:false, so the card keeps its Sign out while the
            // plan's models leave the picker).
            ? (this.chatgpt?.isSignedIn() ?? false)
            : keyless || hasKey);
      return { ...p, builtIn, hasKey, ready };
    });
  }

  /**
   * Create or update a provider entry. Returns the entry's id.
   *
   * IMPORTANT: picks ProviderConfig keys EXPLICITLY (id/type/label/baseUrl/
   * secretRef/enabled). A renderer may hand back a ProviderStatus row from
   * list(); spreading it would persist the derived fields (builtIn/hasKey/
   * ready) into providers.json — the exact bug the ProviderStatus doc warns
   * about. Pinned by tests/provider-registry.test.ts.
   */
  async upsert(input: Omit<ProviderConfig, 'id'> & { id?: string }): Promise<string> {
    const id = input.id ?? ulid();
    // The virtual row is never written to disk (see CHATGPT_ROW) — neither by
    // its id nor by its type, which would be the same stray-card bug.
    if (VIRTUAL_IDS.has(id) || input.type === 'chatgpt') throw new Error(CHATGPT_NOT_A_KEY_MESSAGE);
    await this.home.mutateJson(FILE, (cur) => {
      const file = (cur as ProvidersFile | null) ?? { v: 1 as const, providers: [] };
      const existing = file.providers.find((p) => p.id === id);
      // The IPC boundary makes this input untrusted at runtime — the TS types
      // can't stop a renderer from sending a bare `{ enabled: true }`.
      if (!existing && (!input.type || !input.label)) {
        throw new Error('A new provider needs at least a type and a label.');
      }
      // Field-by-field merge: an omitted field keeps the on-disk value, so a
      // partial update (e.g. a label-only edit from the Providers panel) can't
      // wipe the baseUrl or secretRef.
      const next: ProviderConfig = {
        id,
        type: input.type ?? existing?.type,
        label: input.label ?? existing?.label,
        baseUrl: input.baseUrl ?? existing?.baseUrl,
        secretRef: input.secretRef ?? existing?.secretRef,
        enabled: input.enabled ?? existing?.enabled ?? true,
      };
      if (existing) {
        file.providers = file.providers.map((p) => (p.id === id ? next : p));
      } else {
        file.providers.push(next);
      }
      return file;
    });
    return id;
  }

  async remove(id: string): Promise<void> {
    if (VIRTUAL_IDS.has(id)) throw new Error(CHATGPT_NOT_A_KEY_MESSAGE);
    const builtIn = BUILT_INS.find((b) => b.id === id);
    if (builtIn) {
      throw new Error(`${builtIn.label} is a built-in provider and cannot be removed.`);
    }
    // Delete the secret FIRST: if the entry filter succeeded but the secret
    // delete failed, we'd have an orphaned ciphertext blob with no pointer to
    // it — unreachable forever. The other order just leaves a re-deletable row.
    // Residual TOCTOU window: the secret store and providers.json are two
    // stores with two separate locks, so a concurrent setKey between the
    // delete and the filter below can still orphan a blob. Accepted for
    // Plan A — the cost is one dead ciphertext entry, never a wrong key.
    const entry = this.readAll().find((p) => p.id === id);
    if (entry?.secretRef) await this.secrets.delete(entry.secretRef);
    await this.home.mutateJson(FILE, (cur) => {
      const file = (cur as ProvidersFile | null) ?? { v: 1 as const, providers: [] };
      file.providers = file.providers.filter((p) => p.id !== id);
      return file;
    });
  }

  /** Save (or rotate) a provider's API key. Rotation reuses the existing
   *  secretRef so the providers.json pointer never needs rewriting. */
  async setKey(id: string, plaintext: string): Promise<void> {
    if (VIRTUAL_IDS.has(id)) throw new Error(CHATGPT_NOT_A_KEY_MESSAGE);
    const entry = this.readAll().find((p) => p.id === id);
    if (!entry) {
      throw new Error(`Provider '${id}' is not configured.`);
    }
    const ref = await this.secrets.set(plaintext, entry.secretRef);
    // Persist the pointer by mutating the LIVE entry inside the file lock —
    // NOT by writing back the snapshot read above. A snapshot write would
    // silently undo any concurrent edit (label change, disable) that landed
    // between our read and this write (classic TOCTOU).
    let found = false;
    await this.home.mutateJson(FILE, (cur) => {
      const file = (cur as ProvidersFile | null) ?? { v: 1 as const, providers: [] };
      const live = file.providers.find((p) => p.id === id);
      if (live) {
        live.secretRef = ref;
        found = true;
      }
      return file;
    });
    if (!found) {
      // The entry was removed concurrently. Clean up the secret we just wrote
      // so it doesn't become an orphaned ciphertext blob — best-effort only,
      // the user-facing error below is what matters.
      try { await this.secrets.delete(ref); } catch { /* best effort */ }
      throw new Error(`Provider '${id}' is not configured.`);
    }
  }

  private async keyFor(p: ProviderConfig): Promise<string | undefined> {
    if (!p.secretRef) return undefined;
    // SecretsStore.get returns null for missing/undecryptable — normalize to
    // undefined so the AI SDK factories treat it as "no key configured".
    return (await this.secrets.get(p.secretRef)) ?? undefined;
  }

  /** THE factory (spec §2.2). Throws plain-language errors — they surface in the UI error banner.
   *  `opts.serialToolCalls` (spec §4.2) is honored ONLY on the local-engine branch —
   *  cloud providers handle parallel tool calls fine and ignore it.
   *  `opts.cacheKey` (the harness session id) is honored on three branches:
   *  chatgpt (the endpoint's prompt_cache_key), anthropic (cache_control
   *  markers) and openrouter (session_id pin + cache_control for Claude
   *  models) — see prompt-cache.ts. A caller without one gets none of them. */
  async languageModel(
    binding: ModelBinding,
    opts?: { serialToolCalls?: boolean; onPrefillProgress?: (p: PrefillProgress) => void; cacheKey?: string },
  ): Promise<LanguageModel> {
    // WHY wrap only with a cacheKey: the registry's structural tests reach the
    // inner SDK model's `config` (metadataExtractor, transformRequestBody) on
    // the unwrapped handle, and the one caller without a key — session naming —
    // is exactly the one-shot request that must carry no cache marker.
    const cached = (provider: PromptCacheProvider, model: Parameters<typeof wrapLanguageModel>[0]['model']): LanguageModel =>
      opts?.cacheKey
        ? wrapLanguageModel({ model, middleware: promptCacheMiddleware({ provider, modelId: binding.modelId, cacheKey: opts.cacheKey }) })
        : model;
    const p = this.readAll().find((x) => x.id === binding.providerId);
    // Kill switch (§6): with chatgpt null the virtual row is not in readAll(),
    // so a session still bound to it would otherwise read "not configured" —
    // say what actually happened instead.
    if (!p && VIRTUAL_IDS.has(binding.providerId)) throw new Error(CHATGPT_TURNED_OFF_MESSAGE);
    if (!p) throw new Error(`Provider '${binding.providerId}' is not configured.`);
    if (!p.enabled) throw new Error(`${p.label} is disabled in Settings → Providers.`);

    switch (p.type) {
      case 'local-engine': {
        if (!this.localEngine) {
          throw new Error('Local models are not available yet — the local engine ships in a later update.');
        }
        // ensureRunning boots the engine on demand (idle-stopped or first use)
        // and its trackedFetch keeps the idle timer honest for every request.
        const base = await this.localEngine.ensureRunning();
        // The router discovers GGUFs at BOOT and re-scans only when asked, so a
        // model downloaded since then is a selectable picker row (K2's listing
        // union) that the router has never heard of — the send 400s with
        // "model not found", which reads as "your download is corrupt". This is
        // the ONE chokepoint every local send crosses (create, mid-session swap,
        // remote, retry): ensureServable re-scans once and only reports false on
        // a positive "the router listed its models and yours was not among
        // them". A localhost GET against a multi-second generation is free.
        if (!(await this.localEngine.ensureServable(binding.modelId))) {
          throw new Error(
            `The local engine could not find the model file for '${binding.modelId}'. `
            + 'It may have been deleted, moved, or renamed — re-download it in Settings → Providers → Local models.',
          );
        }
        // The local stream tap does two jobs off ONE tee'd copy: live prefill
        // progress (llama.cpp `return_progress`, only when someone is watching
        // it) and the finished reply's speed, which is read off the final frame
        // and pushed to the engine card's fact line. The second consumer is
        // always present, so unlike before this wraps on every local send —
        // that is the cost of the card knowing how fast the last reply ran. See
        // prefill-progress.ts for why this rides a fetch wrapper rather than the
        // SDK's stream.
        const engine = this.localEngine;
        const localFetch = withPrefillProgress(
          engine.fetchImpl(),
          opts?.onPrefillProgress,
          (timings) => engine.recordReply(timings),
        );
        return createOpenAICompatible({
          name: 'local',
          baseURL: base,
          fetch: localFetch,
          // Fix: without this the SDK omits `stream_options:{include_usage:true}`
          // and an OpenAI-compatible STREAMING response carries no usage block at
          // all — every turn reported inputTokens:0 and fell back to a chars/4
          // guess for output. That silently starved both the context chip and the
          // compaction trigger, which is fed the same number (Destin, 2026-07-28).
          includeUsage: true,
          // Serial-only for small local models (spec §4.2): llama-server honors
          // parallel_tool_calls:false; --jinja already grammar-constrains the args.
          // NEVER a top-level json_schema — that would force JSON on every reply.
          // Only attach the hook when serialToolCalls is requested so unconstrained
          // local models keep the SDK's default (parallel-capable) body untouched.
          // ONE transformRequestBody for BOTH hooks — the SDK accepts a single
          // function, so two `...(cond ? {transformRequestBody} : {})` spreads
          // would silently overwrite each other. Still attached only when
          // something actually needs it: with neither flag set the request body
          // must stay byte-identical to the SDK's default (pinned by
          // provider-registry.test.ts).
          ...(opts?.serialToolCalls || opts?.onPrefillProgress
            ? {
              transformRequestBody: (b: Record<string, any>) => ({
                ...b,
                // llama-server honors parallel_tool_calls:false; --jinja already
                // grammar-constrains the args. NEVER a top-level json_schema —
                // that would force JSON on every reply.
                ...(opts?.serialToolCalls ? { parallel_tool_calls: false } : {}),
                // llama.cpp-specific. An OpenAI-compatible server that doesn't
                // know it (LM Studio, a remote endpoint) ignores unknown body
                // keys, so this degrades to "no progress reported" rather than
                // failing the request.
                ...(opts?.onPrefillProgress ? { return_progress: true } : {}),
              }),
            }
            : {}),
        })(binding.modelId);
      }
      case 'openrouter': {
        const apiKey = await this.keyFor(p);
        if (!apiKey) throw new Error('OpenRouter needs an API key — add one in Settings → Providers.');
        return cached('openrouter', createOpenAICompatible({
          name: 'openrouter',
          baseURL: p.baseUrl ?? OPENROUTER_BASE_URL,
          apiKey,
          headers: OPENROUTER_HEADERS,
          // NO `includeUsage: true` here, unlike the local-engine and generic
          // openai-compatible branches (where it stays necessary). The SDK
          // compiles that flag to `stream_options: { include_usage: true }` —
          // the exact parameter the comment below quotes OpenRouter calling
          // deprecated and inert. Harmless on the wire, but it made this branch
          // argue both sides of its own claim. OpenRouter includes full usage
          // details on every response without being asked; the captured request
          // body is pinned in provider-cost-check.test.ts.
          // Lets the harness check its own arithmetic: OpenRouter reports the
          // real, authoritative dollar figure it charged for each request, and
          // `costForUsage` only ever computed an estimate from a rate card.
          // Reads `usage.cost` off the raw wire response — a field the AI SDK's
          // own stream parts do not model, so without this hook it is gone by
          // the time a chunk reaches us. Attached ONLY here: no other provider
          // reports a cost, and pricing.ts is emphatic that a provider which
          // reports nothing must read as nothing, never as $0.
          //
          // NOT paired with a `usage: { include: true }` request body, which the
          // plan expected. OpenRouter's own Usage Accounting docs (fetched
          // 2026-08-27) say that parameter "and `stream_options: {include_usage:
          // true}` are deprecated and have no effect. Full usage details are now
          // always included automatically in every response." Sending a
          // documented no-op would be code that claims to do something it does
          // not. If OpenRouter ever stops volunteering the field, the metadata
          // simply comes back absent — which is already the handled case.
          metadataExtractor: openRouterCostExtractor,
        })(binding.modelId));
      }
      case 'openai-compatible': {
        if (!p.baseUrl) throw new Error(`${p.label} has no endpoint URL configured.`);
        // Key is OPTIONAL here: Ollama / LM Studio run keyless; a hosted
        // compatible endpoint may have one saved.
        const apiKey = await this.keyFor(p);
        // includeUsage: same reason as the local-engine branch. A server that
        // doesn't understand stream_options ignores it (it's standard OpenAI), so
        // this degrades to the previous no-usage behavior rather than failing.
        return createOpenAICompatible({ name: p.label, baseURL: p.baseUrl, apiKey, includeUsage: true })(binding.modelId);
      }
      case 'anthropic': {
        const apiKey = await this.keyFor(p);
        if (!apiKey) throw new Error(`${p.label} needs an API key — add one in Settings → Providers.`);
        return cached('anthropic', createAnthropic({ apiKey })(binding.modelId));
      }
      case 'openai': {
        const apiKey = await this.keyFor(p);
        if (!apiKey) throw new Error(`${p.label} needs an API key — add one in Settings → Providers.`);
        return createOpenAI({ apiKey })(binding.modelId);
      }
      case 'google': {
        const apiKey = await this.keyFor(p);
        if (!apiKey) throw new Error(`${p.label} needs an API key — add one in Settings → Providers.`);
        return createGoogleGenerativeAI({ apiKey })(binding.modelId);
      }
      case 'chatgpt': {
        // Backend design §4.1. A row of this type only reaches here through
        // the virtual row, but a corrupt providers.json could carry one too —
        // the null check covers both.
        if (!this.chatgpt) throw new Error(CHATGPT_TURNED_OFF_MESSAGE);
        // Throws the sign-in-required sentence when signed out, or OpenAI's own
        // refusal when the account is blocked — both render on the card as-is.
        const acct = this.chatgpt.signedInAccount();
        const provider = createOpenAI({
          // PLACEHOLDER, never a credential. modelFactory runs once per turn
          // and a turn is many steps; the SDK freezes apiKey into its header
          // closure at construction, so the real bearer is never given to it.
          // ChatGptAuth.fetch() REPLACES the authorization header on every
          // request with the live token (refreshing when needed) — pinned:
          // 'Bearer chatgpt' never reaches the network.
          apiKey: 'chatgpt',
          baseURL: CHATGPT_CODEX_BASE_URL,
          headers: {
            'chatgpt-account-id': acct.accountId,
            originator: CHATGPT_ORIGINATOR,
            'OpenAI-Beta': 'responses=experimental',
          },
          // Bind the SDK model to the account generation whose continuation
          // passed the harness check; auth rechecks after async serialization.
          fetch: this.chatgpt.fetch(acct),
        });
        // The middleware (chatgpt-model.ts) owns the request shape the endpoint
        // insists on: store:false, instructions, encrypted reasoning, the cache
        // key, and streaming for the one caller that would not.
        // WHY: profile-private diagnostics must never enter synced NativeHome.
        // Even profile-path lookup failure must not prevent model construction.
        try {
          this.diagnostics ??= new ChatGptRequestDiagnostics({
            directory: join(app.getPath('userData'), 'private-diagnostics', 'chatgpt-cache'),
          });
        } catch { /* diagnostics are optional; never log a sensitive exception */ }
        const model = wrapLanguageModel({
          model: provider.responses(binding.modelId),
          middleware: chatGptMiddleware(opts?.cacheKey, this.diagnostics),
        });
        // WHY: continuationIdentity() is the ONE place this string is built
        // (cache-stage4-architecture.md "Identity strings") — read live state
        // on every dispatch/acceptance, not only once when this turn's model
        // was constructed, so a same-account reauth or an account switch is
        // never missed. The future restore path calls the same method, so
        // the two can never disagree.
        const continuationOwner = () => this.continuationIdentity(binding);
        return bindOpenAIContinuationModel(model, continuationOwner);
      }
      default:
        // Unreachable with the current ProviderType union, but a corrupt
        // providers.json could hold anything — fail with a real message.
        throw new Error(`${p.label} has an unknown type and cannot be used.`);
    }
  }

  /**
   * THE one durable identity string for OpenAI continuation state (cache
   * stage 4, Task 1). Non-ChatGPT bindings need no account context: provider
   * + model IS the identity. ChatGPT additionally needs to know WHICH signed
   * -in account and credential era produced the ciphertext, so a restored
   * manifest is never applied against a different account's tokens — but the
   * raw account id must never leave this process (it would be a stable,
   * unhashed identifier sitting in a private-but-not-secret file), so only
   * its hash travels. `credentialEpoch` (durable, minted per sign-in) — NOT
   * `authGeneration` (in-memory, restarts at 0 every process) — is what
   * still changes this string on a same-account reauth; see
   * `ChatGptAuth.signedInAccount()`.
   */
  continuationIdentity(binding: ModelBinding): string {
    if (!VIRTUAL_IDS.has(binding.providerId)) return `${binding.providerId}\0${binding.modelId}`;
    if (!this.chatgpt) throw new Error(CHATGPT_TURNED_OFF_MESSAGE);
    // Throws the sign-in-required sentence when signed out, or OpenAI's own
    // refusal when blocked — both are real states the caller (a dispatch, or
    // a restore) must see, not swallow.
    const live = this.chatgpt.signedInAccount();
    const accountFingerprint = createHash('sha256').update(live.accountId).digest('hex');
    return `${binding.providerId}\0${binding.modelId}\0${accountFingerprint}\0${live.credentialEpoch}`;
  }

  /**
   * Connection test: the cheapest real call per type — a models-list fetch.
   * NEVER throws — always resolves { ok, message } so the Providers panel can
   * render the outcome without a try/catch on every call site.
   */
  async testConnection(id: string): Promise<{ ok: boolean; message: string }> {
    // Everything — including the providers.json read and the localBaseUrl()
    // callback — lives inside the try, so no code path can throw past the
    // never-throws contract. (readAll rethrows non-ENOENT I/O errors, and
    // localBaseUrl is injected code we don't control.)
    let p: ProviderConfig | undefined;
    try {
      p = this.readAll().find((x) => x.id === id);
      // Kill switch (§6), the same guard languageModel() has: with chatgpt null
      // the virtual row is not in readAll(), so a Test on a leftover ChatGPT
      // card would read "not configured" — which sounds like the user forgot to
      // set something up. Say what actually happened, in the same words the
      // send path uses, so one state never gets two explanations.
      if (!p && VIRTUAL_IDS.has(id)) return { ok: false, message: CHATGPT_TURNED_OFF_MESSAGE };
      if (!p) return { ok: false, message: `Provider '${id}' is not configured.` };
      // Bare trailing slashes 404 on strict routers (`/v1//models`) —
      // createOpenAICompatible normalizes internally, but these hand-built
      // probe URLs don't get that treatment.
      const stripSlash = (u: string) => u.replace(/\/+$/, '');
      const needsKey = { ok: false, message: `${p.label} needs an API key — add one in Settings → Providers.` };
      const signal = AbortSignal.timeout(TEST_TIMEOUT_MS);
      let res: Response;
      switch (p.type) {
        case 'local-engine': {
          if (!this.localEngine?.installed()) {
            return { ok: false, message: 'The local engine is not installed yet.' };
          }
          // Boots the engine if needed — a connection test SHOULD prove the
          // whole path, and idle shutdown reaps it afterwards. A thrown
          // ensureRunning is caught by the outer try/catch → {ok:false,message}.
          const base = await this.localEngine.ensureRunning();
          res = await fetch(`${stripSlash(base)}/models`, { signal });
          break;
        }
        case 'openrouter': {
          const key = await this.keyFor(p);
          if (!key) return needsKey;
          // CAVEAT: OpenRouter's /models endpoint is PUBLIC, so a 200 here
          // proves reachability, NOT that the key is valid. (`GET /api/v1/key`
          // would validate the key; deferred.) Don't present the green check
          // as key validation in the UI.
          res = await fetch(`${stripSlash(p.baseUrl ?? OPENROUTER_BASE_URL)}/models`, {
            headers: { Authorization: `Bearer ${key}`, ...OPENROUTER_HEADERS },
            signal,
          });
          break;
        }
        case 'openai-compatible': {
          if (!p.baseUrl) return { ok: false, message: `${p.label} has no endpoint URL configured.` };
          // A saved secretRef whose key can't be read back (deleted store,
          // keychain mismatch) means the user THINKS a key is set — say so
          // instead of probing with no credential and reporting a confusing 401.
          let key: string | undefined;
          if (p.secretRef) {
            key = await this.keyFor(p);
            if (!key) return needsKey;
          }
          res = await fetch(`${stripSlash(p.baseUrl)}/models`, {
            headers: key ? { Authorization: `Bearer ${key}` } : undefined,
            signal,
          });
          break;
        }
        case 'anthropic': {
          const key = await this.keyFor(p);
          if (!key) return needsKey;
          res = await fetch('https://api.anthropic.com/v1/models', {
            // Anthropic uses x-api-key (not a bearer header) and requires a
            // version header on every request.
            headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
            signal,
          });
          break;
        }
        case 'openai': {
          const key = await this.keyFor(p);
          if (!key) return needsKey;
          res = await fetch('https://api.openai.com/v1/models', {
            headers: { Authorization: `Bearer ${key}` },
            signal,
          });
          break;
        }
        case 'google': {
          const key = await this.keyFor(p);
          if (!key) return needsKey;
          // Google's API takes the key as a query param, not a header.
          res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
            { signal }
          );
          break;
        }
        case 'chatgpt': {
          // No network on purpose (§2): a probe would spend the user's plan,
          // and the account file already knows the answer. `ok` is exactly
          // isSignedIn(); the message says which state the card is in.
          if (!this.chatgpt) return { ok: false, message: CHATGPT_TURNED_OFF_MESSAGE };
          const st = this.chatgpt.status();
          const ok = this.chatgpt.isSignedIn();
          const message =
            st.state === 'signed-in' ? `Signed in as ${st.email}.`
            : st.state === 'blocked' ? st.reason
            : st.state === 'waiting' ? 'Sign-in is still in progress.'
            : CHATGPT_SIGN_IN_REQUIRED_MESSAGE;
          return { ok, message };
        }
        default:
          return { ok: false, message: `${p.label} has an unknown type and cannot be tested.` };
      }
      if (res.ok) return { ok: true, message: 'Connected.' };
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: 'The API key was rejected — check it and try again.' };
      }
      return { ok: false, message: `The provider responded with HTTP ${res.status}.` };
    } catch (e: any) {
      // Network failure / timeout / DNS / store I/O — return, never throw
      // (UI contract). p may be unset if the read itself threw.
      return { ok: false, message: `Could not reach ${p?.label ?? id}: ${e?.message ?? String(e)}` };
    }
  }
}
