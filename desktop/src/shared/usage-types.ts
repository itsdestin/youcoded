// Usage statistics across providers (design 2026-09-29, docs/active/design/
// 2026-09-29-usage-stats/). The wire shapes the usage view reads. Designed in
// the workbench ahead of the backend — `usage.history` / `usage.accounts` are
// MOCK_ONLY until main records usage over time and reads the balances.

/** Who the work was billed to. `claude-code` and `chatgpt` are monthly plans
 *  (no per-use charge), `openrouter` and `api` bill per use, `local` is free. */
export type UsageProviderId = 'claude-code' | 'chatgpt' | 'openrouter' | 'api' | 'local';

/** One model's work within one time slot. */
export interface UsageEntry {
  provider: UsageProviderId;
  /** The model's display name, as the model picker shows it. */
  model: string;
  /** Everything the provider processed: what was sent (cached or not) plus
   *  what came back. The same count every provider reports. */
  tokens: number;
  /** Money actually billed (OpenRouter, API keys). null on a plan or local. */
  costUsd: number | null;
  /** On a plan: what the same work would cost at pay-per-use prices. An
   *  estimate, never a charge. null when no price is known, or not a plan. */
  estimateUsd: number | null;
}

/** A time slot and the work done in it. Hourly slots cover the last day;
 *  daily slots cover the last 90 (review round 1: usage has to line up with
 *  the plan windows it counts against, and those are hours and days). */
export interface UsageSlot {
  /** Epoch ms of the slot's start. */
  start: number;
  entries: UsageEntry[];
}

/** How full one plan window was over time, sampled whenever the provider
 *  reported it (every reply carries it). A drop is a reset. */
export interface LimitSeries {
  provider: 'claude-code' | 'chatgpt';
  window: 'five_hour' | 'seven_day';
  points: Array<{ t: number; pct: number }>;
}

export interface UsageHistory {
  hours: UsageSlot[];
  days: UsageSlot[];
  limits: LimitSeries[];
}

/** Live account figures that are not plan windows (those already arrive on
 *  status:data). Every field is optional: a provider that does not report a
 *  figure simply has no line. */
export interface UsageAccounts {
  chatgpt?: {
    /** Extra credits bought on top of the plan, when ChatGPT reports them. */
    credits?: { balance: number; unlimited: boolean } | null;
    /** A separate limit on one model, when ChatGPT reports one. */
    modelLimits?: Array<{ model: string; utilization: number; resets_at: string }>;
  };
  openrouter?: {
    /** Credit left, in dollars: the account's balance, capped by the key's
     *  own spending limit when it has one. */
    balanceUsd: number;
    /** Epoch ms of the last successful read. */
    checkedAt: number;
  };
}
