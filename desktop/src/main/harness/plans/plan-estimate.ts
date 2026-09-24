// plan-estimate.ts — the proposed/re-frozen card's ONE estimate line
// (specialists plans, spending rework T5; backend design §4, decision 34
// Q-4/Q-5). Pure: no I/O, no clock — `estimatePlan` takes the plan's own
// document and frozen manifest plus a `SpecialistUsageSnapshot`
// (specialist-usage-history.ts owns reading that from disk) and returns a
// `PlanEstimate` (types.ts). Kept apart from the history file so the PRICING
// math here has no filesystem to fake in a test, and the SCAN there has no
// pricing knowledge to get wrong.
import type { PlanDocumentV1, PlanStepV1 } from './schema';
import type { ExecutionManifest, PlanEstimate } from './types';
import type { PricingSnapshot } from './plan-host-bridge';
import { billedEquivalentTokens, costForUsage, type ModelPricing, type PricedUsage } from '../pricing';
import type { SpecialistUsageEntry, SpecialistUsageSnapshot } from './specialist-usage-history';

/** Design §4: "same agentType + same provider:model IF ≥5". */
const MIN_SAME_BINDING_RUNS = 5;

const NO_PUBLISHED_PRICE = 'no published price';
const CHATGPT_NOTE = 'included in your ChatGPT plan';
const LOCAL_NOTE = 'runs on your computer';

/**
 * Design §4's built-in per-type defaults, regenerated 2026-09-24 (superseding
 * the design doc's own 2026-09-19 placeholder numbers) by running
 * `docs/active/investigations/2026-09-19-specialist-usage.py` read-only
 * against the real `~/.youcoded/sessions` data (555 youcoded specialist runs
 * at that date). Each entry is the median and p90 billed-equivalent USAGE
 * SPLIT for that specialist type — not just the token count — because
 * pricing a default needs the same {uncached, cacheRead, cacheWrite, output}
 * shape a real past run gives `costForUsage`. Per-component percentiles
 * (rather than the percentile of the summed billed-equivalent figure) —
 * close enough for an estimate that decision 34 itself calls approximate:
 *
 *   type        | n   | billed-eq p50 / p90
 *   worker      | 197 | 621k / 2.60M
 *   reviewer    | 185 | 247k / 750k
 *   explorer    | 149 | 222k / 541k
 *   researcher  |  24 |  84k / 374k
 *
 * A custom specialist with no history of its own (no agentType/binding match
 * at all) falls back to the worker default if it can write, else reviewer
 * (design §4) — never one of these two other rows, which are for the plan
 * grammar's two read-oriented/checking built-ins.
 */
const DEFAULT_USAGE_BY_TYPE: Record<string, { median: PricedUsage; p90: PricedUsage }> = {
  worker: {
    median: { inputTokens: 1_202_177, outputTokens: 6_689, cacheReadTokens: 659_968, cacheCreationTokens: 0 },
    p90: { inputTokens: 9_484_538, outputTokens: 25_856, cacheReadTokens: 7_574_554, cacheCreationTokens: 0 },
  },
  reviewer: {
    median: { inputTokens: 300_276, outputTokens: 3_056, cacheReadTokens: 65_280, cacheCreationTokens: 0 },
    p90: { inputTokens: 1_198_759, outputTokens: 8_567, cacheReadTokens: 501_888, cacheCreationTokens: 0 },
  },
  explorer: {
    median: { inputTokens: 302_582, outputTokens: 4_614, cacheReadTokens: 126_720, cacheCreationTokens: 0 },
    p90: { inputTokens: 1_314_839, outputTokens: 11_146, cacheReadTokens: 847_002, cacheCreationTokens: 0 },
  },
  researcher: {
    median: { inputTokens: 102_595, outputTokens: 3_630, cacheReadTokens: 34_304, cacheCreationTokens: 0 },
    p90: { inputTokens: 564_793, outputTokens: 9_623, cacheReadTokens: 188_413, cacheCreationTokens: 0 },
  },
};

/** A leaf step (map/verify/combine — never `repeat` itself), with the
 *  enclosing repeat's `max_iterations`, or null outside any repeat. A repeat
 *  body is one level deep (decision 33.4 forbids nesting), but this walks
 *  generally rather than assuming that depth. */
interface LeafWithContext {
  step: PlanStepV1;
  repeatMax: number | null;
}

function walkLeaves(steps: PlanStepV1[], repeatMax: number | null = null): LeafWithContext[] {
  return steps.flatMap((s) => (s.kind === 'repeat'
    ? walkLeaves(s.steps ?? [], s.max_iterations ?? 1)
    : [{ step: s, repeatMax }]));
}

/** Design §4: "Runs per step: split = items; verify/combine = 1; a repeat
 *  body counts 1 round for low and max_iterations for high." */
function runCounts(leaf: LeafWithContext): { low: number; high: number } {
  const itemCount = leaf.step.kind === 'map' ? (leaf.step.items?.length ?? 1) : 1;
  return { low: itemCount * 1, high: itemCount * (leaf.repeatMax ?? 1) };
}

/** `manifest.steps[id].pricing` is typed `unknown` on the journal record
 *  (types.ts's own WHY: an unrecognized shape must not quarantine the whole
 *  journal) — narrowed back to `PricingSnapshot` here, tolerantly: anything
 *  that doesn't match reads as "no published price", never as a crash or a
 *  guessed rate. */
function readPricingSnapshot(value: unknown): PricingSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { kind?: unknown; rates?: unknown };
  if (v.kind === 'free') return { kind: 'free' };
  if (v.kind === 'local') return { kind: 'local' };
  if (v.kind === 'priced' && v.rates && typeof v.rates === 'object') {
    const r = v.rates as { in?: unknown; out?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
    if (typeof r.in === 'number' && typeof r.out === 'number') {
      return {
        kind: 'priced',
        rates: {
          in: r.in, out: r.out,
          ...(typeof r.cacheRead === 'number' ? { cacheRead: r.cacheRead } : {}),
          ...(typeof r.cacheWrite === 'number' ? { cacheWrite: r.cacheWrite } : {}),
        },
      };
    }
  }
  return null;
}

function noteFor(snapshot: PricingSnapshot | null): string {
  if (snapshot?.kind === 'free') return CHATGPT_NOTE;
  if (snapshot?.kind === 'local') return LOCAL_NOTE;
  return NO_PUBLISHED_PRICE;
}

function toPricedUsage(e: SpecialistUsageEntry): PricedUsage {
  return {
    inputTokens: e.usage.uncached + e.usage.cacheRead + e.usage.cacheWrite,
    outputTokens: e.usage.output,
    cacheReadTokens: e.usage.cacheRead,
    cacheCreationTokens: e.usage.cacheWrite,
  };
}

/** Design §4's fallback chain, minus the built-in-default tier (handled by
 *  the caller, which alone knows the canWrite fallback). Empty = "no history
 *  at all for this agentType — use the built-in default". */
function pastRunsFor(agentType: string, providerId: string, modelId: string, history: SpecialistUsageSnapshot): PricedUsage[] {
  const sameBinding = history.entries.filter((e) => e.agentType === agentType && e.providerId === providerId && e.modelId === modelId);
  if (sameBinding.length >= MIN_SAME_BINDING_RUNS) return sameBinding.map(toPricedUsage);
  const sameType = history.entries.filter((e) => e.agentType === agentType);
  if (sameType.length > 0) return sameType.map(toPricedUsage);
  return [];
}

function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const k = (sortedAsc.length - 1) * q;
  const lo = Math.floor(k), hi = Math.min(lo + 1, sortedAsc.length - 1);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (k - lo);
}

interface RunStats {
  medianTokens: number;
  p90Tokens: number;
  /** null exactly when the step has no priced rate (unpriced) — never a
   *  guessed number, matching `costForUsage`'s own null contract. */
  medianUsd: number | null;
  p90Usd: number | null;
}

function statsFromPastRuns(usages: PricedUsage[], rates: ModelPricing | null): RunStats {
  const tokensSorted = usages.map(billedEquivalentTokens).sort((a, b) => a - b);
  const stats: RunStats = { medianTokens: percentile(tokensSorted, 0.5), p90Tokens: percentile(tokensSorted, 0.9), medianUsd: null, p90Usd: null };
  if (rates) {
    const dollarsSorted = usages.map((u) => costForUsage(u, rates)).filter((v): v is number => v != null).sort((a, b) => a - b);
    if (dollarsSorted.length > 0) { stats.medianUsd = percentile(dollarsSorted, 0.5); stats.p90Usd = percentile(dollarsSorted, 0.9); }
  }
  return stats;
}

function statsFromDefault(def: { median: PricedUsage; p90: PricedUsage }, rates: ModelPricing | null): RunStats {
  return {
    medianTokens: billedEquivalentTokens(def.median),
    p90Tokens: billedEquivalentTokens(def.p90),
    medianUsd: rates ? costForUsage(def.median, rates) : null,
    p90Usd: rates ? costForUsage(def.p90, rates) : null,
  };
}

/** Design §4: "A custom specialist with no history uses the worker default
 *  if it can write, else the reviewer default." `canWrite` is an optional
 *  lookup (never I/O — the caller closes over whatever roster it already
 *  has) rather than a 4th positional dependency the design doesn't name,
 *  because `estimatePlan` has no other way to learn a specialist's charter:
 *  the frozen manifest carries only a binding/label/pricing per step, and
 *  `PlanDocumentV1` deliberately keeps `specialist` an open string (schema.ts:
 *  "Runtime parsing stays open because a live roster can include custom
 *  ids"). Omitted entirely (the common case — most callers never see an
 *  unrecognized custom type with zero history), an unrecognized type
 *  defaults to the worker row: the conservative direction for an estimate
 *  that decision 34 already calls approximate — better to show a wide range
 *  up front than to undercount a specialist that turns out to write files.
 */
function defaultUsageFor(agentType: string, canWrite?: (specialistId: string) => boolean | undefined): { median: PricedUsage; p90: PricedUsage } {
  const known = DEFAULT_USAGE_BY_TYPE[agentType];
  if (known) return known;
  return canWrite?.(agentType) === false ? DEFAULT_USAGE_BY_TYPE.reviewer : DEFAULT_USAGE_BY_TYPE.worker;
}

function composeUnpricedNote(notes: readonly string[]): string {
  if (notes.length === 0) return NO_PUBLISHED_PRICE;
  if (notes.length === 1) return notes[0];
  return notes.join(' and ');
}

/**
 * Design §4: the proposed/re-frozen card's ONE estimate line. Dollars
 * (`{lowUsd, highUsd}`) whenever at least one leaf step is priced — a mixed
 * plan's dollar range covers the PRICED steps only (design §4 / Revision 1
 * open question 2: "dollar range over priced steps... limit counts priced
 * spend only" — an unpriced step's tokens are the card's separate line,
 * T7). Tokens (`{tokens, unpricedNote}`) only when EVERY leaf step is
 * unpriced.
 */
export function estimatePlan(
  document: PlanDocumentV1,
  manifestSteps: ExecutionManifest['steps'],
  history: SpecialistUsageSnapshot,
  canWrite?: (specialistId: string) => boolean | undefined,
): PlanEstimate {
  let lowUsd = 0;
  let highUsd = 0;
  let pricedSteps = 0;
  let unpricedTokens = 0;
  const unpricedNotes: string[] = [];

  for (const leaf of walkLeaves(document.steps)) {
    // Optional chaining even though the type says `manifestSteps` is always
    // present: a manifest gap — missing entirely, or missing this one step
    // — must never crash the estimate, only contribute nothing for that
    // step, the same tolerance the rest of this function already gives an
    // unrecognized pricing shape or an unmatched history entry.
    const manifestStep = manifestSteps?.[leaf.step.id];
    if (!manifestStep) continue;
    const { low, high } = runCounts(leaf);
    const snapshot = readPricingSnapshot(manifestStep.pricing);
    const rates = snapshot?.kind === 'priced' ? snapshot.rates : null;

    const pastUsages = pastRunsFor(leaf.step.specialist, manifestStep.binding.providerId, manifestStep.binding.modelId, history);
    const stats = pastUsages.length > 0
      ? statsFromPastRuns(pastUsages, rates)
      : statsFromDefault(defaultUsageFor(leaf.step.specialist, canWrite), rates);

    if (rates && stats.medianUsd != null && stats.p90Usd != null) {
      lowUsd += low * stats.medianUsd;
      highUsd += high * stats.p90Usd;
      pricedSteps++;
    } else {
      unpricedTokens += low * stats.medianTokens;
      const note = noteFor(snapshot);
      if (!unpricedNotes.includes(note)) unpricedNotes.push(note);
    }
  }

  if (pricedSteps === 0) {
    return { tokens: Math.round(unpricedTokens), unpricedNote: composeUnpricedNote(unpricedNotes) };
  }
  // Round to the nearest hundredth of a cent — the chip/card format to
  // cents themselves; this just keeps the stored figure free of floating
  // noise from summing many small per-run percentiles.
  const round = (v: number) => Math.round(v * 1e4) / 1e4;
  return { lowUsd: round(lowUsd), highUsd: round(highUsd) };
}
