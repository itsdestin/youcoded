//
// The ONE place tokens become dollars (spec §5). Lives in main because main is
// where the binding — and therefore the price — is known; the renderer only
// ever adds up figures it was handed.
//
// Rates are USD per 1,000,000 tokens (CatalogModel.pricing), hence every /1e6.

export type ModelPricing = { in: number; out: number; cacheRead?: number; cacheWrite?: number };

export interface PricedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** True when a published rate card charges nothing for ANY of the four things
 *  a turn can consume — so the model is FREE, not "priced at zero".
 *
 *  WHY this exists at all: OpenRouter publishes its `:free` model variants with
 *  a price of the string "0", and the catalog mapper (model-catalog.ts) maps
 *  that faithfully to a real rate of 0. Without this check, a free model would
 *  report a priced session cost of exactly $0.00 — the false zero
 *  docs/error-message-standards.md forbids, and worse than an absent chip.
 *
 *  WHY all four rates and not just in/out: an absent cache rate falls back to
 *  the input rate below, so with in = 0 an absent cacheRead genuinely costs
 *  nothing — but a PUBLISHED non-zero cache rate does not. Checking all four
 *  makes this predicate exactly "cost is zero for every possible turn", which
 *  is what "free" has to mean if the two states are never to be confused.
 *
 *  A missing rate card is NOT free — it means "no published price", a
 *  different state with different wording in the status bar. */
export function isFreePricing(pricing: ModelPricing | null | undefined): boolean {
  if (!pricing) return false;
  return pricing.in === 0 && pricing.out === 0
    && (pricing.cacheRead ?? 0) === 0 && (pricing.cacheWrite ?? 0) === 0;
}

/** USD for one turn, or null when the model has no published price.
 *
 *  null, never 0: a zero would render as "$0.00", which claims the turn was
 *  free. An absent chip is the honest output (docs/error-message-standards.md).
 *  A genuinely free model (isFreePricing) also returns null here and is
 *  reported through the separate `free` flag instead.
 *
 *  WHY cached reads are subtracted from the prompt: providers report
 *  inputTokens as the WHOLE prompt and cacheReadTokens as the part served from
 *  cache. Charging both at the full input rate is exactly the over-reporting
 *  this modelling removes. When no cache rate is published, the cached portion
 *  stays at the full input rate — the honest fallback, since we don't know the
 *  discount. */
export function costForUsage(usage: PricedUsage, pricing: ModelPricing | null | undefined): number | null {
  if (!pricing) return null;
  if (isFreePricing(pricing)) return null;   // free to run — not a $0.00 bill
  const cachedRead = pricing.cacheRead != null ? Math.min(usage.cacheReadTokens, usage.inputTokens) : 0;
  const uncachedIn = Math.max(0, usage.inputTokens - cachedRead);
  const cost =
    (uncachedIn / 1e6) * pricing.in
    + (cachedRead / 1e6) * (pricing.cacheRead ?? pricing.in)
    + (usage.outputTokens / 1e6) * pricing.out
    + (pricing.cacheWrite != null ? (usage.cacheCreationTokens / 1e6) * pricing.cacheWrite : 0);
  return Math.max(0, cost);
}

// ---------------------------------------------------------------------------
// Checking our arithmetic against the provider's own bill (plan Task 27).
//
// Everything above turns tokens into dollars from a published rate card.
// Nothing checked that answer against the only authority that matters — what
// the provider actually charged. OpenRouter reports its own per-request figure
// in the usage block of every response, so we can now compare continuously.
//
// The whole design rests on ONE distinction, the same one drawn above between
// `null` and absent: a provider that reports NOTHING must never read as zero,
// and never as agreement. Only OpenRouter-shaped providers report a cost at
// all — a local model, an Anthropic key and a plain OpenAI-compatible endpoint
// all report nothing, which is by far the common case.
// ---------------------------------------------------------------------------

/** Provider-metadata key the extractor writes under. Matches the provider name
 *  passed to createOpenAICompatible, which is where the AI SDK namespaces
 *  provider-specific metadata. */
const OPENROUTER_METADATA_KEY = 'openrouter';

/** Reads `usage.cost` off one parsed response body or SSE chunk.
 *  undefined — never 0 — for anything that is not a finite number, because
 *  "the field was not there" and "the provider charged nothing" are different
 *  facts and a `:free` model genuinely reports 0. */
function readCost(parsed: unknown): number | undefined {
  const cost = (parsed as any)?.usage?.cost;
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : undefined;
}

/** The `metadataExtractor` handed to createOpenAICompatible for OpenRouter.
 *
 *  WHY a metadata extractor and not a stream reader: `usage.cost` is a RAW
 *  field on OpenRouter's wire response. The AI SDK's own stream parts model
 *  token counts only, so by the time a chunk reaches our harness the cost is
 *  already gone. This hook is the SDK's supported way to reach the raw JSON —
 *  its `processChunk` runs on every parsed chunk, including OpenRouter's final
 *  usage-only chunk (whose `choices` array is empty).
 *
 *  Verified against @ai-sdk/openai-compatible@3.0.14: processChunk is called
 *  for every successfully-parsed chunk before any choices handling, and
 *  buildMetadata()'s return value is spread into the finish part's
 *  providerMetadata — which streamText resolves as `result.providerMetadata`. */
export const openRouterCostExtractor = {
  async extractMetadata({ parsedBody }: { parsedBody: unknown }) {
    return openRouterMetadata(readCost(parsedBody), readCacheWrite(parsedBody));
  },
  createStreamExtractor() {
    let cost: number | undefined;
    let cacheWrite: number | undefined;
    return {
      processChunk(parsedChunk: unknown) {
        const c = readCost(parsedChunk);
        // Last one wins, but only a real reading overwrites: a later chunk
        // WITHOUT the field must not erase the figure an earlier one carried.
        if (c !== undefined) cost = c;
        const w = readCacheWrite(parsedChunk);
        if (w !== undefined) cacheWrite = w;
      },
      buildMetadata() {
        // undefined, not { costUsd: 0 } — see the section header.
        return openRouterMetadata(cost, cacheWrite);
      },
    };
  },
};

/** Cache follow-ups item 8 (2026-09-10): OpenRouter reports cache WRITES as
 *  `prompt_tokens_details.cache_write_tokens` for explicit-cache models (Claude).
 *  @ai-sdk/openai-compatible maps only `cached_tokens` (reads), so without this
 *  every OpenRouter write read as 0 and the Reuse chip could not tell a fresh
 *  cache write from a request that simply had nothing to cache. Same
 *  present-vs-absent discipline as the cost: undefined when not reported. */
function readCacheWrite(parsed: unknown): number | undefined {
  const w = (parsed as any)?.usage?.prompt_tokens_details?.cache_write_tokens;
  return typeof w === 'number' && Number.isFinite(w) ? w : undefined;
}
function openRouterMetadata(cost: number | undefined, cacheWrite: number | undefined) {
  if (cost === undefined && cacheWrite === undefined) return undefined;
  return {
    [OPENROUTER_METADATA_KEY]: {
      ...(cost === undefined ? {} : { costUsd: cost }),
      ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    },
  };
}

/** The `metadataExtractor` for the LOCAL llama.cpp branch (cache follow-ups
 *  item 8, 2026-09-10). llama-server puts `timings.cache_n` — the number of
 *  prompt tokens it reused from its KV cache — on the final frame (the same
 *  block prefill-progress.ts reads speeds from). It is the only ground truth
 *  for "did the local prefix stay still", and the SDK's usage never sees it.
 *  A zero IS a reading (a cold prompt); only an absent block reports nothing. */
export const localTimingsExtractor = {
  async extractMetadata({ parsedBody }: { parsedBody: unknown }) {
    return localMetadata(readCacheN(parsedBody));
  },
  createStreamExtractor() {
    let cacheN: number | undefined;
    return {
      processChunk(parsedChunk: unknown) {
        const n = readCacheN(parsedChunk);
        if (n !== undefined) cacheN = n;
      },
      buildMetadata() { return localMetadata(cacheN); },
    };
  },
};
function readCacheN(parsed: unknown): number | undefined {
  const n = (parsed as any)?.timings?.cache_n;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}
function localMetadata(cacheN: number | undefined) {
  return cacheN === undefined ? undefined : { local: { cacheReadTokens: cacheN } };
}

/** The provider's own USD figure for one request, or undefined when it did not
 *  report one (every non-OpenRouter provider, and OpenRouter itself if it ever
 *  omits the field). Never coerces a missing figure to 0. */
export function providerCostFromMetadata(
  meta: Record<string, Record<string, unknown>> | undefined | null,
): number | undefined {
  const cost = meta?.[OPENROUTER_METADATA_KEY]?.costUsd;
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : undefined;
}

/** Below this the provider's own rounding is a large fraction of the figure, so
 *  the ratio below says more about rounding than about our arithmetic. A tenth
 *  of a cent. */
export const COST_COMPARE_FLOOR_USD = 0.001;

/** How far apart the two figures may drift before it is worth a diagnostic line.
 *
 *  CHOSEN, NOT MEASURED. Two things can make an honest gap: per-model price
 *  overrides (some models charge more above a very large prompt) are not
 *  modelled here, and providers round. The design spec expects a few percent
 *  from those; 5% sits above that band, so crossing it means something
 *  structural rather than rounding. Nobody has yet compared these two numbers
 *  on a real billed turn — when someone does, this is the constant to revisit. */
export const COST_DISAGREEMENT_THRESHOLD = 0.05;

/** How far our figure sits from the provider's, as a fraction of the
 *  provider's — or `null` when there is nothing honest to compare.
 *
 *  null covers three genuinely different situations, and NONE of them is
 *  agreement: the provider reported nothing (every non-OpenRouter provider),
 *  we have no figure of our own (no published rate, or a free model), or the
 *  bill is below the rounding floor. A caller that treats null as "matched"
 *  has the bug this function exists to prevent.
 *
 *  Denominator is the PROVIDER's figure because it is the authority; ours is
 *  the number on trial. Symmetric in direction — over-reporting is as wrong as
 *  under-reporting. */
export function costDisagreement(
  ours: number | null | undefined,
  theirs: number | undefined,
): number | null {
  if (theirs === undefined || ours == null) return null;
  if (theirs < COST_COMPARE_FLOOR_USD) return null;
  return Math.abs(theirs - ours) / theirs;
}

// ---------------------------------------------------------------------------
// The same check, over the whole SESSION (plan Task 30 item 1).
//
// COST_COMPARE_FLOOR_USD is right in itself — below a tenth of a cent the
// provider's own rounding is a large fraction of the figure, so the ratio would
// say more about rounding than about our arithmetic. But applied ONLY per turn
// it means the check never fires at all on a cheap model: a 3k-in / 100-out
// turn on a Gemini-Flash-class rate card (~$0.10 per 1M in) costs about
// $0.00034, a third of the floor, forever. A 50% systematic pricing error on
// such a model is invisible per turn — and those turns still add up into the
// figure the status bar shows the user.
//
// A running total crosses the floor long before any single turn does, so the
// session keeps one and compares it too. The per-turn check stays: it localises
// a fault to ONE turn, which a session total cannot.
//
// THE PAIR IS THE WHOLE POINT. The step-vs-turn trap above repeats here one
// level up: a session where SOME turns published a provider figure and some did
// not must never put a PARTIAL provider total next to a COMPLETE cost total —
// that reads as a disagreement, silently, always in the direction that says we
// over-charge. So a turn enters BOTH sums or NEITHER, and the two sums always
// cover exactly the same turns.
//
// WHY this pairs where the turn level had to be all-or-nothing: costForUsage
// prices a whole TURN off summed token counts and cannot be split back into per
// step figures, so a turn with a half-reporting set of steps has nothing to pair
// WITH. A turn does have its own figure, so it can be paired or dropped one at
// a time — which is strictly better, since one silent turn no longer blinds the
// whole session.
// ---------------------------------------------------------------------------

export interface SessionCostTotals {
  /** Our figure, summed over ONLY the turns the provider also reported one for. */
  ourUsd: number;
  /** The provider's figure, over exactly those same turns. */
  theirUsd: number;
  /** How many turns are in the pair. 0 means nothing has been comparable yet,
   *  which is NOT the same fact as two totals of zero that happened to agree. */
  turns: number;
}

/** A session that has compared nothing yet. Frozen: every session starts from
 *  this one shared object, so an accidental mutation would leak across all of
 *  them. */
export const NO_SESSION_COST_TOTALS: SessionCostTotals =
  Object.freeze({ ourUsd: 0, theirUsd: 0, turns: 0 });

/** Folds one finished turn into the running pair — or returns the pair
 *  untouched when the turn is not comparable (the provider reported nothing, or
 *  we have no figure of our own because the model is free or has no published
 *  rate). Never mutates its argument.
 *
 *  A reported 0 on either side IS a reading and counts: a `:free` model that
 *  genuinely billed nothing told us something. Only `undefined`/`null` is
 *  silence. */
export function addComparableTurn(
  totals: SessionCostTotals,
  ours: number | null | undefined,
  theirs: number | undefined,
): SessionCostTotals {
  if (ours == null || theirs === undefined) return totals;
  return {
    ourUsd: totals.ourUsd + ours,
    theirUsd: totals.theirUsd + theirs,
    turns: totals.turns + 1,
  };
}

/** How much WORSE the session gap must get before it is worth saying again.
 *
 *  CHOSEN, NOT MEASURED — and chosen to sit between two failure modes rather
 *  than from any observation of real bills.
 *
 *  A line every turn would bury the finding: once the sums disagree they keep
 *  disagreeing, so the log would fill with identical warnings carrying nothing
 *  new. But a strict one-shot goes permanently DEAF on exactly the models this
 *  session check exists for. On an expensive model the per-turn line keeps
 *  firing, so later divergence is still reported; on a cheap one every turn is
 *  below the comparison floor forever, so after that single session line no
 *  further divergence is ever reported however much worse it gets — a rate-card
 *  regression at turn 300 that triples the gap would be silent.
 *
 *  A TRIPLING is the smallest step that plainly is not the reported fault
 *  drifting: rounding and unmodelled price overrides move a gap by a few
 *  percent, not by 200%. And because the bar multiplies each time it is met,
 *  the ladder from the 5% threshold is 15%, 45%, 135%, … — a handful of lines
 *  at most in the worst session imaginable, never one per turn. */
export const COST_GAP_RELOG_FACTOR = 3;

/** How far our running total sits from the provider's, as a fraction of the
 *  provider's — or `null` when there is nothing honest to compare yet.
 *
 *  null, never 0, for a session that has paired no turns at all: a 0 would read
 *  as "we checked the whole session and it matched", which is the exact
 *  confusion this module exists to prevent. Below the floor it is null for the
 *  same reason the per-turn check is. */
export function sessionCostDisagreement(totals: SessionCostTotals): number | null {
  if (totals.turns === 0) return null;
  return costDisagreement(totals.ourUsd, totals.theirUsd);
}
