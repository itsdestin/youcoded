// desktop/src/shared/model-facts.ts
//
// What the model list knows about a model beyond its name: what it costs, how
// capable it is, and (for models on this computer) how fast it writes.
//
// WHY THIS FILE EXISTS (Destin, questions decks 2026-09-11,
// docs/active/design/2026-09-11-model-picker-tags/): every row in the model list
// gets three tags — value, intelligence, speed — so choosing a model stops meaning
// knowing the names. Shared, not renderer-only, because the numbers are worked out
// where the whole catalogue is visible (value compares a model with its peers), and
// the list only draws them.
//
// Decisions this shape encodes, each an answered deck step:
//   · cost is VALUE (intelligence against price, judged within the model's own
//     intelligence level) — questions-2 F-1 "same-level";
//   · a priced model with no score gets a price level instead — F-3;
//   · plan and local models say so instead of a price — Q-2 "FREE - LOCAL",
//     Q-3 "SUBSCRIPTION PLAN";
//   · intelligence is 0-100 where 100 is today's top model — S-4;
//   · speed is for models on this computer only — Q-9 "none";
//   · a price that can't be found is left off, never shown as free — S-1.

/** Value against models at the same intelligence level. */
export type ValueLevel = 'great' | 'fair' | 'poor';

/** Price alone, for a priced model with no intelligence score. */
export type PriceLevel = 'low' | 'mid' | 'high';

/** The three-colour judgement every tag reduces to. */
export type Band = 'good' | 'middling' | 'poor';

export interface ModelBenchmarks {
  /** DeepSWE: share of long, original programming tasks passed, 0-1. */
  coding?: number;
  /** GPQA Diamond: PhD-level science questions answered correctly, 0-1. */
  science?: number;
  /** SimpleQA Verified: short facts stated correctly, 0-1. */
  facts?: number;
  /** LMArena's instruction-following ranking. */
  instructions?: { rank: number; of: number };
}

export interface ModelFacts {
  /** Listed price, US dollars per million tokens. Absent means no price was
   *  found — never "free" (S-1). */
  price?: { in: number; out: number };
  /** Set when the model is not paid for per use. */
  billing?: 'subscription' | 'local';
  intelligence?: {
    /** 0-100; 100 is the top model on the snapshot's date. */
    score: number;
    /** The model the score belongs to, when it is not this row's own name — a
     *  Claude plan alias ("Sonnet" is scored as Claude Sonnet 5) or a downloaded
     *  copy borrowing its original's score (Q-13). */
    scoredAs?: string;
    /** True when the score is an original model's, borrowed by a smaller
     *  downloaded copy that may do somewhat worse (Q-13). */
    borrowed?: boolean;
    benchmarks?: ModelBenchmarks;
  };
  /** Needs both a price and a score. */
  value?: ValueLevel;
  /** Only when there is a price and no score (F-3). */
  priceLevel?: PriceLevel;
  /** Models on this computer only. */
  speed?: { wordsPerSecond: number; estimated: boolean };
}

export interface ModelFactsSnapshot {
  /** Keyed by `factsKey()`. */
  models: Record<string, ModelFacts>;
  /** The model scored 100. */
  topModel: string;
  /** Date the scores were taken, YYYY-MM-DD. */
  asOf: string;
}

/** The key a row's facts are stored under. Provider TYPE rather than provider id,
 *  because a provider's id is a per-device ULID and the facts are not. */
export function factsKey(choice: { runtime: 'claude'; alias: string } | { runtime: 'native'; providerType?: string; modelId: string }): string {
  return choice.runtime === 'claude' ? `claude:${choice.alias}` : `${choice.providerType ?? 'unknown'}:${choice.modelId}`;
}

/** Intelligence level lines — the same lines value is judged within (F-1). */
export function intelligenceBand(score: number): Band {
  return score >= 80 ? 'good' : score >= 50 ? 'middling' : 'poor';
}

/** Speed lines fixed by how the wait feels, the same on every computer (Q-7):
 *  red under about 7 words a second (slower than you read), green above 22. */
export function speedBand(wordsPerSecond: number): Band {
  return wordsPerSecond > 22 ? 'good' : wordsPerSecond >= 7 ? 'middling' : 'poor';
}

export const VALUE_BAND: Record<ValueLevel, Band> = { great: 'good', fair: 'middling', poor: 'poor' };
