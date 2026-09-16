// Capability profiles (spec §4.1, decisions 2/9). Resolved in THREE layers so a
// known model gets curated tuning, an unknown one gets a safe fallback, and the
// harness NEVER branches on a model-name string (only the registry matcher does).
import { KNOWN_MODELS, matchKnownModel, type KnownModelEntry } from './known-models';
import { HOSTED_MAX_CONCURRENT_SPECIALISTS } from './specialists/limits';
// Type-only: the app-wide list of provider kinds, used below ONLY to check that
// this file's own copy of that list has not fallen behind it.
import type { ProviderType } from '../../shared/provider-types';

export type ToolPresentation = 'full' | 'simplified';
export type PromptVariant = 'anthropic' | 'gpt' | 'default' | 'local-small';

export interface CapabilityProfile {
  maxToolPresentation: ToolPresentation;   // simplified = compact descriptions + serial calls
  promptVariant: PromptVariant;            // which steering overlay to append
  doomLoopThreshold: number;               // identical-call repeats that trip the ask (2 for small)
  supportsParallelToolCalls: boolean;      // may the model emit >1 tool call per step?
  constrainToolArgs: boolean;              // inject the llama.cpp serial/grammar hook (local only)
  supportsTools: boolean;                  // false → run as plain chat (no tools attached)
  /** May the model-invoked Skill tool be attached? Its description carries every
   *  installed skill's id + one-liner on EVERY turn (~1–2k tokens with a normal
   *  install), so a small window cannot afford it — those sessions reach skills
   *  through the user-invoked /skill-name path instead. */
  exposeSkillCatalog: boolean;
  /** Ceiling for content injected as messages mid-session (skill bodies, rule
   *  text, nested project instructions). Sized from the REAL window, not the
   *  provider: a 128k local model has more room than a 32k hosted one. */
  injectionBudgetTokens: number;
  /** Ceiling for MCP tool schemas attached to a session (Task 6, spec §6).
   *  Sized from the window like injectionBudgetTokens, but deliberately
   *  WITHOUT the frontier-provider "assume roomy" shortcut those use: an
   *  attached tool schema rides the request on EVERY turn, so it is a hard
   *  token cost regardless of which provider serves the model — a hosted
   *  model with a genuinely small MEASURED window (e.g. an 8k OpenRouter
   *  model) must be gated exactly like a local one. Only a truly UNMEASURED
   *  window falls back to the conservative default. */
  mcpToolBudgetTokens: number;
  /** May a user message carry image parts to this model? Gates attachment
   *  delivery on the native send path. Sourced like the sizing fields — from
   *  the provider and the registry, never from a model-name guess at the call
   *  site. Conservative by construction: a wrong `true` fails the whole turn
   *  with a provider error, a wrong `false` only means the model is told it
   *  cannot view the image. Full metadata sourcing is M6 item 2. */
  supportsVision: boolean;
  /** Provider can carry an image INSIDE a tool result (Anthropic tool_result
   *  blocks). Everything else gets the wire-adapter split. Provider-type fact,
   *  not a model fact — the registry never overrides it. */
  nativeImageToolResults: boolean;
  /** May the model-invoked Task tool (Task 6, spec decision 4) be attached, to
   *  spawn a specialist subagent? Spec decision 4: a weak/unverified
   *  orchestrator does not actually parallelize delegated work — it
   *  serial-collapses back into doing the specialist's job itself turn by
   *  turn, paying the child's system-prompt overhead for nothing. So THIS
   *  gates whether the tool is attached at all; it never gates
   *  NativeSessionHost.createChild directly — a session that cannot delegate
   *  simply never sees the option on its tool schema. */
  canDelegate: boolean;
  /** Task 13 — the per-parent specialist CONCURRENCY ceiling
   *  NativeSessionHost.maxSpecialistsFor reads off the parent's resolved
   *  profile. Distinct from canDelegate: that gates whether the Task tool is
   *  attached AT ALL; this gates how many children may run AT ONCE once it
   *  is. Hosted/cloud sessions get the spec's flat constant
   *  (HOSTED_MAX_CONCURRENT_SPECIALISTS) — there is no engine to measure. A
   *  local session's ceiling instead comes from the ENGINE's own measured
   *  parallel-slot count (llama-server's total_slots), because a local machine's
   *  real concurrency ceiling is hardware-bound, not spec-bound — see
   *  localFallback / the known-model overlay below for how each layer
   *  resolves it. */
  maxConcurrentSpecialists: number;
  /** May this session tell the user the model is READING the prompt — the
   *  "Reading your prompt — N tokens" heartbeat (and the live percentage the
   *  local engine upgrades it to)? PROVIDER-TYPE fact, never a model fact, so
   *  the registry never overrides it.
   *
   *  True only where the model runs on the user's OWN hardware. That affordance
   *  exists because llama.cpp prefill scales with prompt size and can run for
   *  minutes with nothing on screen — a silence indistinguishable from a hang,
   *  which is exactly what it was built to explain. A hosted model's
   *  time-to-first-token is seconds; announcing it there is noise at best and
   *  actively misleading at worst, since no cloud provider reports prefill
   *  progress so the notice can never upgrade past its opening estimate
   *  (Destin, 2026-08-16: the notice was showing on OpenRouter sessions).
   *
   *  'openai-compatible' counts as local for the same reason FRONTIER_PROVIDERS
   *  below excludes it: provider-registry documents that type as the Ollama /
   *  LM Studio shape, i.e. a local model in disguise. */
  announcePrefill: boolean;
}

export type ProfileProviderType =
  | 'local-engine' | 'openrouter' | 'openai-compatible'
  | 'anthropic' | 'openai' | 'google'
  // Sign in with ChatGPT (design §4.8): the user's own ChatGPT plan, reached
  // through OpenAI's sign-in instead of a key. The models behind it are the
  // GPT-5.x family, so everywhere below it is treated exactly like the
  // direct 'openai' provider — same prompt flavour, same "roomy hosted
  // window" sizing, same vision default. It was missing from this list for
  // one review round, and the effect was silent: a plan model fell through
  // to the "unmeasured local model" path and got a 2k injection budget, no
  // skill catalog, the generic prompt and no images (review R3-1).
  | 'chatgpt';

// Guard against that ever happening again. The app has TWO lists of provider
// kinds: ProviderType in shared/provider-types.ts (what the settings screen
// and the provider registry use) and ProfileProviderType just above (what
// the harness sizes sessions from). The host passes a registry row's type
// straight into resolveProfile, so the two lists must name the SAME
// providers. The two lines below are pure type arithmetic — they add no
// code to the built app — and `tsc` refuses to compile the moment a name
// exists in one list but not the other. Its error names the stray member,
// e.g. `Type '"chatgpt"' does not satisfy the constraint 'never'`. Adding a
// provider to the shared union therefore FORCES a visit to this file, which
// is the point: every set below (FRONTIER_PROVIDERS, VISION_PROVIDERS,
// cloudVariant, …) needs a deliberate yes/no for a new provider.
type AssertNever<T extends never> = T;
type _HarnessKnowsEveryProvider = AssertNever<Exclude<ProviderType, ProfileProviderType>>;
type _SharedKnowsEveryHarnessProvider = AssertNever<Exclude<ProfileProviderType, ProviderType>>;

// LAYER 1 — discovered truth (a later task fills contextLength from the real engine).
export interface DiscoveredModel {
  providerType: ProfileProviderType; modelId: string; contextLength: number | null;
  /** Per-model vision fact sourced from a catalog that can actually answer it:
   *  OpenRouter's architecture.input_modalities (see model-catalog.ts), and —
   *  since design §E5 — the identically-named field llama-server reports for a
   *  LOCAL model it paired a vision projector with (see
   *  EngineManager.catalogModels). Optional because most construction sites
   *  cannot answer this (no catalog lookup wired at the call site) —
   *  `undefined` here means "not discovered", not "no". visionFor() treats it
   *  as the middle precedence layer: below the KNOWN_MODELS registry, above the
   *  provider-type default. */
  supportsVision?: boolean;
  /** Task 13 — the engine's live parallel-slot count (llama-server's
   *  `total_slots`; `n_slots` on older builds), read from the SAME
   *  `/props?model=<id>` call that already supplies contextLength — a call
   *  the app makes only once the model is already `loaded`, because naming
   *  a model in /props autoloads it on b10665; until then the model-less
   *  /props carries no slot field and this stays unknown (see
   *  docs/engine-dependencies.md § "Parallel slots" — the 2026-08-12 probe
   *  that measured 4 slots batching cleanly at ~1.7-1.85x single-request
   *  latency, the largest tested N that still cleared that bar).
   *  engine-manager.ts's effectiveContextWindow() reads it off that same
   *  /props call and threads it through
   *  ipc-handlers.ts's contextAndSlotsFor closure into
   *  NativeSessionHost.resolveContextAndProfile() — so, unlike when this
   *  comment first landed, a construction site DOES wire a live reading
   *  through. Still optional: resolveContextAndProfile coalesces
   *  contextAndSlotsFor's `null` (no running engine instance, a model not
   *  yet loaded — the model-less /props has no slot field — an older
   *  llama.cpp build with neither `total_slots` nor `n_slots` in its /props
   *  response, or a
   *  non-local-engine binding, which never queries the engine at all) into
   *  `undefined` before calling resolveProfile — so in production this
   *  field is either a real discovered count or `undefined`, never the
   *  explicit `null` the type also allows for a lower-level caller (the
   *  resolveProfile unit tests exercise `null` directly). Either absent form
   *  reaches the same fallback in the known-model overlay below:
   *  conservative 1, never "one slot confirmed". */
  totalSlots?: number | null;
}

const SMALL_LOCAL_CONTEXT = 32_768;

export const CLOUD_DEFAULT: CapabilityProfile = {
  maxToolPresentation: 'full', promptVariant: 'default',
  doomLoopThreshold: 3, supportsParallelToolCalls: true,
  constrainToolArgs: false, supportsTools: true,
  exposeSkillCatalog: true, injectionBudgetTokens: 20_000,
  mcpToolBudgetTokens: 20_000,
  // Frontier/cloud models default true (spec decision 4) — they're the
  // verified-capable orchestrator case the Task tool exists for.
  canDelegate: true,
  // Task 13 — hosted/cloud sessions keep the flat spec constant: there is no
  // local engine to measure. Imported rather than repeated as a literal `4`
  // so this and HOSTED_MAX_CONCURRENT_SPECIALISTS (specialists/limits.ts,
  // still the value tools/task.ts's at-capacity refusal falls back to when no
  // live profile is available) can never silently drift apart.
  maxConcurrentSpecialists: HOSTED_MAX_CONCURRENT_SPECIALISTS,
  // Conservative placeholder only: resolveProfile ALWAYS spreads the real
  // visionFor() result over this. It is false rather than true so a direct use
  // of CLOUD_DEFAULT (tests, future call sites) cannot accidentally claim a
  // capability the model may not have.
  supportsVision: false,
  // Placeholder like supportsVision above: resolveProfile ALWAYS spreads the
  // real `d.providerType === 'anthropic'` check over this. False by default so
  // a direct use of CLOUD_DEFAULT can't accidentally claim the one capability
  // that is exclusive to a single provider.
  nativeImageToolResults: false,
  // Placeholder in the same shape as the two above: resolveProfile ALWAYS
  // spreads the real provider-type answer over this. False is also the honest
  // value for a session that genuinely IS this default — a hosted model.
  announcePrefill: false,
};

function cloudVariant(t: ProfileProviderType): PromptVariant {
  if (t === 'anthropic') return 'anthropic';
  // 'chatgpt' serves the same GPT-5.x models as a direct OpenAI key (design
  // §4.8: gpt-5.6-terra / gpt-5.6-luna / gpt-5.5 / gpt-5.4-mini), so it gets
  // the one prompt overlay written for GPT models — not the generic one.
  if (t === 'openai' || t === 'chatgpt') return 'gpt';
  return 'default';
}

// Hosted providers whose window is large by construction. We never DISCOVER their
// context length, so `contextLength: null` from one of these means "not measured",
// not "small" — sizing them down would starve the primary use case.
//
// 'openai-compatible' is deliberately NOT here: provider-registry documents it as
// the Ollama / LM Studio shape, so an unmeasured one is a local model in disguise
// and gets the conservative treatment.
//
// 'chatgpt' IS here: it is OpenAI's own hosted service, and every model the plan
// offers has a 272k window (Phase 0 findings, youcoded-dev
// docs/active/investigations/2026-09-05-chatgpt-phase0-findings.md — every listed
// manifest row carries context_window). A null here must still mean "not measured", exactly
// as it does for 'openai' — otherwise a GPT-5.6 on the plan would be sized as a
// 2k-budget local model while the same GPT-5.6 over OpenRouter got 20k.
const FRONTIER_PROVIDERS: ReadonlySet<ProfileProviderType> = new Set(['anthropic', 'openai', 'google', 'openrouter', 'chatgpt']);

/** M3 item 5 — how much may be injected, and may the skill catalog ride at all.
 *  A function of the WINDOW rather than the provider, so a 128k local model is
 *  treated as roomier than a 32k hosted one. An unmeasured window is small: we
 *  never assume room we could not verify (the same conservative posture the rest
 *  of the three-layer resolution takes). */
/** The tool presentation this model will actually run with — registry overlay
 *  first, then the window-tiered fallback. Extracted because injectionSizing
 *  needs it BEFORE the profile object is assembled, and duplicating the
 *  precedence here would be a second place for it to drift. */
function presentationFor(d: DiscoveredModel, registry: KnownModelEntry[]): ToolPresentation {
  if (d.providerType !== 'local-engine') return CLOUD_DEFAULT.maxToolPresentation;
  const known = matchKnownModel(d.modelId, registry);
  return known?.maxToolPresentation ?? localFallback(d.contextLength).maxToolPresentation;
}

function injectionSizing(d: DiscoveredModel, registry: KnownModelEntry[]): Pick<CapabilityProfile, 'exposeSkillCatalog' | 'injectionBudgetTokens'> {
  if (FRONTIER_PROVIDERS.has(d.providerType)) {
    return { exposeSkillCatalog: true, injectionBudgetTokens: CLOUD_DEFAULT.injectionBudgetTokens };
  }
  // The EFFECTIVE window, not the raw one — a small model loaded at a large -c
  // must not be judged roomy just because llama-server was told a big number.
  const window = effectiveContextForModel(d.contextLength, d.modelId, registry);
  // Two DIFFERENT questions, and the window only answers one of them.
  //
  //   "can it AFFORD the catalog?" -> window size.
  //   "should it be CHOOSING skills on its own?" -> model capability.
  //
  // Gating on window alone conflated them: a Qwen 3.5 2B launched with
  // `-c 128000` has ample room, got the full catalog, and spent its turn
  // reciting all twelve skills instead of doing anything (Destin, 2026-07-28).
  // `maxToolPresentation` is the capability signal the profile already carries —
  // 'simplified' is exactly "this model needs the schema kept small and simple" —
  // so a model marked simplified never gets autonomous skill selection, whatever
  // its window. Those sessions still reach every skill through /skill-name.
  const capable = presentationFor(d, registry) === 'full';
  return {
    exposeSkillCatalog: capable && window != null && window >= SMALL_LOCAL_CONTEXT,
    injectionBudgetTokens: window == null ? 2_000
      : window >= 100_000 ? 20_000
      : window >= SMALL_LOCAL_CONTEXT ? 6_000
      : 2_000,
  };
}

/** Task 6 — how many tokens of MCP tool schema this session may attach.
 *  Shares injectionSizing's window boundaries (100k / SMALL_LOCAL_CONTEXT) —
 *  no invented breakpoints — but deliberately does NOT reuse its blanket
 *  FRONTIER-provider shortcut or its absolute numbers: a skill-catalog
 *  description competes for a model's ATTENTION (a capability concern the
 *  harness already trusts frontier providers to have regardless of window),
 *  but an MCP tool schema competes for raw REQUEST BYTES on every single
 *  turn — a hard technical limit no provider is exempt from. So a genuinely
 *  MEASURED small window (a real 8k OpenRouter model, say) is gated exactly
 *  like a local one, at smaller amounts than injectionBudgetTokens: a
 *  handful of attached MCP servers should never be able to crowd out the
 *  conversation itself. The ONE thing this keeps from injectionSizing's
 *  FRONTIER treatment is what an UNMEASURED window means for those
 *  providers — null there is "not measured" (we frequently never discover
 *  it), not "small" — the identical justification injectionSizing already
 *  documents, so it stays generous rather than starving the primary cloud
 *  use case on a measurement gap. */
function mcpBudgetSizing(d: DiscoveredModel, registry: KnownModelEntry[]): number {
  if (FRONTIER_PROVIDERS.has(d.providerType) && d.contextLength == null) {
    return CLOUD_DEFAULT.mcpToolBudgetTokens;
  }
  // Fix pass 1 / Finding 1: use the SAME effective-window expression
  // injectionSizing (`:89`) uses, for every non-frontier provider — not just
  // 'local-engine'. Gating the clamp on providerType made 'openai-compatible'
  // (the Ollama/LM Studio shape, deliberately excluded from FRONTIER_PROVIDERS
  // above because "an unmeasured one is a local model in disguise") skip the
  // registry-ceiling clamp entirely: a model launched with a large declared
  // `num_ctx` whose id happened to match a small registry entry got the
  // 20,000-token tier here while injectionBudgetTokens correctly clamped it to
  // 6,000 — twenty thousand tokens of tool schema on a model whose real window
  // is far smaller. There is no separate "hosted model matching a local
  // registry family" concern to protect here (that's resolveContextAndProfile's
  // job, one layer up, for the CONTEXT WINDOW itself) — this function only
  // ever sees a window that's already been resolved for THIS provider type, so
  // clamping it again to a matching registry family's ceiling is exactly
  // right for every provider, matching injectionSizing's own reasoning.
  const window = effectiveContextForModel(d.contextLength, d.modelId, registry);
  return window == null ? 750
    : window >= 100_000 ? 20_000
    : window >= SMALL_LOCAL_CONTEXT ? 4_000
    : 750;
}

// LAYER 3 — conservative fallback for an UNKNOWN local model, tiered by the REAL
// context window. Constrained args + serial-only are the safe llama-server default
// at every size; presentation/variant/doom-loop tighten for a small window.
// Returns the BEHAVIORAL layers only. Sizing (exposeSkillCatalog /
// injectionBudgetTokens / mcpToolBudgetTokens) is computed separately by
// injectionSizing / mcpBudgetSizing and spread on by resolveProfile, because
// it depends on the window rather than on which layer won. Typing that
// honestly keeps tsc able to catch a missing field at every construction site
// instead of letting a spread paper over it.
type BehavioralProfile = Omit<CapabilityProfile, 'exposeSkillCatalog' | 'injectionBudgetTokens' | 'mcpToolBudgetTokens' | 'supportsVision'>;

// Task 13 — the local engine's REAL parallel-slot ceiling this app trusts,
// per the 2026-08-12 probe recorded in docs/engine-dependencies.md
// § "Parallel slots": at N=4, average per-request latency (~939-1188ms) was
// still <=2x the single-request baseline in both measured runs — the largest
// tested N that cleared that bar (N=4 batches partially, not serially).
// Deliberately its OWN constant, not reused from HOSTED_MAX_CONCURRENT_SPECIALISTS
// even though both happen to be 4 today: one is a hardware/engine-measured
// ceiling, the other is the spec's flat hosted number — they must be free to
// diverge later (e.g. a beefier dev box measuring a higher ceiling) without
// dragging the hosted constant along for no reason.
const LOCAL_SLOT_CLAMP_CEILING = 4;

/** Task 13 — clamp a live engine slot reading into the concurrency ceiling a
 *  KNOWN local model's profile uses. `totalSlots` is null/undefined on any
 *  build that hasn't reported a slot count yet (or hasn't been read at all)
 *  — that is UNKNOWN slot behavior, not "one slot confirmed", so it degrades
 *  to the same conservative 1 the Layer-3 fallback uses below, never to the
 *  clamp ceiling. */
function localSlotCap(totalSlots: number | null | undefined): number {
  if (totalSlots == null) return 1;
  return Math.max(1, Math.min(LOCAL_SLOT_CLAMP_CEILING, totalSlots));
}

function localFallback(ctx: number | null): BehavioralProfile {
  const small = ctx == null || ctx <= SMALL_LOCAL_CONTEXT;
  return {
    maxToolPresentation: small ? 'simplified' : 'full',
    promptVariant: small ? 'local-small' : 'default',
    doomLoopThreshold: small ? 2 : 3,
    supportsParallelToolCalls: false,
    constrainToolArgs: true,
    supportsTools: true,   // assume yes; the registry marks known tool-less models false
    // Always false for local-engine — this is a PROVIDER-TYPE fact (only direct
    // Anthropic can carry an image inside a tool result), never a model fact, so
    // there is no local model, known or unknown, for which this could be true.
    nativeImageToolResults: false,
    // Conservative default (spec decision 4): an UNKNOWN local model has not
    // been vetted as a capable orchestrator, however large its window — a weak
    // model handed the Task tool serial-collapses back into doing the
    // specialist's own job itself instead of actually delegating. Unlike
    // maxToolPresentation/promptVariant/doomLoopThreshold above, this is NOT
    // tiered by context window: only a FRONTIER/cloud default, or a registry
    // entry the maintainers explicitly reviewed and tuned to 'full' (see
    // resolveProfile's known-model branch below), earns delegation.
    canDelegate: false,
    // Task 13 — an UNKNOWN local model gets the conservative floor
    // UNCONDITIONALLY, same posture as canDelegate just above: even if a live
    // slot reading happened to be available, an unvetted model's real
    // behavior under concurrent load is unknown, so this does not consult
    // totalSlots at all (unlike the known-model overlay's localSlotCap
    // below). canDelegate is already false here, so the Task tool is never
    // attached anyway — this value only matters if that ever changes.
    maxConcurrentSpecialists: 1,
    // Always true here: localFallback is only ever reached for 'local-engine',
    // whose prefill IS the minutes-long silence the notice explains. Like
    // nativeImageToolResults above, resolveProfile also spreads the computed
    // provider-type answer over this, so the two can never disagree.
    announcePrefill: true,
  };
}

// The context window a session should ACTUALLY use: the real loaded window (from
// the engine, Task 4) further clamped to a KNOWN model's documented trained ceiling
// (the registry's maxContextWindow). Without this, a small model loaded at a large
// -c would be sized past its real ceiling and silently degrade — the GGUF-header
// reader that would catch this generically isn't built, so the registry ceiling is
// the pragmatic stand-in for known models. Unknown models / cloud models (no
// registry match) pass through unchanged.
export function effectiveContextForModel(loadedContext: number | null, modelId: string, registry: KnownModelEntry[] = KNOWN_MODELS): number | null {
  const ceiling = matchKnownModel(modelId, registry)?.maxContextWindow;
  if (loadedContext == null) return ceiling ?? null;
  return ceiling ? Math.min(loadedContext, ceiling) : loadedContext;
}

// Providers we reach through their OWN SDK, whose current flagship models are all
// multimodal. openrouter / openai-compatible / local-engine are deliberately NOT
// here: they are transports, not models — the same endpoint serves vision and
// text-only models — so those resolve from the registry, then a DISCOVERED
// per-model fact (openrouter's catalog supplies one, and so does the local
// engine's own /models — see DiscoveredModel's supportsVision comment), and
// only then this provider-type default.
//
// 'chatgpt' joins: unlike openrouter it is NOT a transport that could serve any
// model — it only ever serves the plan's GPT-5.x models, all of which accept
// text + image input (Phase 0 findings, the manifest's input_modalities). Without it here, images could not
// be sent to a GPT-5.6 on the plan at all: there is no registry row for these
// ids and the host only discovers per-model vision facts for openrouter.
const VISION_PROVIDERS = new Set<ProfileProviderType>(['anthropic', 'openai', 'google', 'chatgpt']);

/** NOTE for anyone tracing the catalog's careful "don't know" (undefined)
 *  posture: it ends HERE. This returns a boolean, because the harness has no
 *  third thing to do with an unknown — so an undiscovered answer becomes
 *  `false` via the provider-type default below. That is deliberate and it is
 *  the safe direction: a wrong `false` only means the model is told the picture
 *  cannot be delivered, while a wrong `true` fails the entire turn with a
 *  provider error. Preserving `undefined` all the way up the catalog is still
 *  what makes THAT choice available here rather than being made by accident
 *  three layers down. */
function visionFor(d: DiscoveredModel, registry: KnownModelEntry[]): boolean {
  const known = matchKnownModel(d.modelId, registry);
  // Registry wins wherever it has an opinion — it is the one place a modelId is
  // allowed to be inspected, and it can see through a transport provider.
  if (known?.supportsVision !== undefined) return known.supportsVision;
  // Next, a DISCOVERED per-model fact (e.g. OpenRouter's own modality data),
  // when the call site could supply one. Still beats the provider-type
  // default because it is model-specific, not a blanket transport guess.
  if (d.supportsVision !== undefined) return d.supportsVision;
  return VISION_PROVIDERS.has(d.providerType);
}

export function resolveProfile(d: DiscoveredModel, registry: KnownModelEntry[] = KNOWN_MODELS): CapabilityProfile {
  // Sizing is orthogonal to the behavioral layers below — it depends only on the
  // window — so it is computed once and spread onto whichever base is returned.
  const sizing = injectionSizing(d, registry);
  // mcpToolBudgetTokens is computed SEPARATELY from `sizing` (not folded into
  // injectionSizing itself) because it deliberately skips that function's
  // FRONTIER-provider shortcut — see mcpBudgetSizing's header comment.
  const mcpToolBudgetTokens = mcpBudgetSizing(d, registry);
  const supportsVision = visionFor(d, registry);
  // PROVIDER-TYPE fact, not a model fact: only the direct-Anthropic wire can
  // carry an image inside a tool_result block. Computed here (not read off
  // any base/registry object) and spread onto every return site below so the
  // known-model registry — which has no field for this — can never override
  // it either way.
  // 'chatgpt' is deliberately NOT included: its wire is OpenAI's, which has no
  // image-inside-a-tool-result block, so it takes the same adapter split as
  // 'openai'.
  const nativeImageToolResults = d.providerType === 'anthropic';
  // PROVIDER-TYPE fact like nativeImageToolResults, computed once here and
  // spread onto every return below so no registry entry or layer can override
  // it: only a model running on the user's own machine gets the prompt-reading
  // notice. See the field's doc comment for why 'openai-compatible' counts.
  // 'chatgpt' is deliberately NOT included: it is a hosted service, and the
  // notice exists to explain a minutes-long local prefill that hosted models
  // never have.
  const announcePrefill = d.providerType === 'local-engine' || d.providerType === 'openai-compatible';
  if (d.providerType !== 'local-engine') {
    return { ...CLOUD_DEFAULT, promptVariant: cloudVariant(d.providerType), ...sizing, mcpToolBudgetTokens, supportsVision, nativeImageToolResults, announcePrefill };
  }
  const base = localFallback(d.contextLength);
  const known = matchKnownModel(d.modelId, registry);   // LAYER 2 overlay
  if (!known) return { ...base, ...sizing, mcpToolBudgetTokens, supportsVision, nativeImageToolResults, announcePrefill };
  return {
    maxToolPresentation: known.maxToolPresentation ?? base.maxToolPresentation,
    promptVariant: known.promptVariant ?? base.promptVariant,
    doomLoopThreshold: known.doomLoopThreshold ?? base.doomLoopThreshold,
    supportsParallelToolCalls: known.supportsParallelToolCalls ?? base.supportsParallelToolCalls,
    constrainToolArgs: base.constrainToolArgs,           // always true for local
    supportsTools: known.supportsTools ?? base.supportsTools,
    // A KNOWN local model earns delegation only when it resolves to FULL
    // presentation — the same signal injectionSizing's `capable` check reuses
    // (maxToolPresentation is already "this model can be trusted with a full
    // schema and autonomous choices"; delegating IS one of those choices).
    // `base.maxToolPresentation` (never base.canDelegate, which is always
    // false) is the fallback so an entry that overlays maxToolPresentation
    // without opining on canDelegate still reads its OWN presentation tier,
    // not the conservative fallback's blanket false.
    canDelegate: (known.maxToolPresentation ?? base.maxToolPresentation) === 'full',
    // Task 13 — a KNOWN local model earns a REAL concurrency ceiling derived
    // from the engine's own measured slot count (d.totalSlots), clamped to
    // [1, 4] by localSlotCap — unlike the flat conservative 1 an unknown
    // model gets (base.maxConcurrentSpecialists, never read here): the
    // registry match is what marks a model "vetted enough" to trust with
    // more than the floor, mirroring canDelegate's own reasoning just above.
    maxConcurrentSpecialists: localSlotCap(d.totalSlots),
    ...sizing,
    mcpToolBudgetTokens,
    supportsVision,
    nativeImageToolResults,
    announcePrefill,
  };
}
