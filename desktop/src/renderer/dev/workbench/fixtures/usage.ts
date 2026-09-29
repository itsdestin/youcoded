// Fake usage history for the usage view (design 2026-09-29). 90 days of made-up
// but plausible numbers across the four kinds of provider, so the chart, the
// breakdowns and every range have something to draw. Deterministic: the same
// day always gets the same numbers, so review pictures do not churn.
import type { UsageAccounts, UsageDay, UsageEntry } from '../../../../shared/usage-types';

/** Small seeded generator — a hash of the day index, 0..1. */
function rand(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// provider · model · typical millions of tokens on a busy day · $ per million
// (billed for OpenRouter, the pay-per-use estimate for a plan, 0 for local).
const MODELS: Array<[UsageEntry['provider'], string, number, number]> = [
  ['claude-code', 'Claude Opus 5.5', 140, 0.6],
  ['claude-code', 'Claude Sonnet 5', 90, 0.35],
  ['chatgpt', 'GPT-6 Sol', 70, 0.2],
  ['chatgpt', 'GPT-6 Astra', 30, 0.12],
  ['openrouter', 'DeepSeek V4', 9, 0.09],
  ['openrouter', 'Gemini 3.5 Flash', 4, 0.12],
  ['local', 'Qwen 3.6 27B', 3, 0],
];

export function usageHistoryFixture(empty: boolean): UsageDay[] {
  if (empty) return [];
  const days: UsageDay[] = [];
  const today = new Date();
  for (let i = 89; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const entries: UsageEntry[] = [];
    MODELS.forEach(([provider, model, busy, perM], m) => {
      const r = rand(i * 11 + m);
      // Some days a model is not used at all; weekends are quieter.
      if (r < 0.18) return;
      const tokens = Math.round(busy * 1_000_000 * (weekend ? 0.35 : 1) * (0.3 + r));
      const money = Math.round((tokens / 1_000_000) * perM * 100) / 100;
      const plan = provider === 'claude-code' || provider === 'chatgpt';
      entries.push({
        provider, model, tokens,
        costUsd: plan || provider === 'local' ? null : money,
        estimateUsd: plan ? money : null,
      });
    });
    days.push({ date: isoDate(d), entries });
  }
  return days;
}

export function usageAccountsFixture(empty: boolean): UsageAccounts {
  if (empty) return {};
  // UX review U1: a balance is read only for a key that works, so the fake
  // follows the `?openrouter=` pin — without a verified key there is no line.
  const orVerified = typeof location !== 'undefined' && new URLSearchParams(location.search).get('openrouter') === 'verified';
  return {
    chatgpt: {
      credits: { balance: 1250, unlimited: false },
      modelLimits: [{ model: 'GPT-6 Sol', utilization: 41, resets_at: new Date(Date.now() + 3 * 86_400_000).toISOString() }],
    },
    ...(orVerified ? { openrouter: { balanceUsd: 12.4, checkedAt: Date.now() - 90_000 } } : {}),
  };
}
