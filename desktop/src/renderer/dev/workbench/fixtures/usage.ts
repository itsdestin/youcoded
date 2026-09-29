// Fake usage history for the usage view (design 2026-09-29). Made-up but
// plausible: hourly slots for a day, daily slots for 90 days, and each plan
// window's fill over time rising with the work and dropping at its reset.
// Deterministic — the same slot always gets the same numbers — so review
// pictures do not churn between shots.
import type { LimitSeries, UsageAccounts, UsageEntry, UsageHistory, UsageSlot } from '../../../../shared/usage-types';

/** Small seeded generator, 0..1. */
function rand(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// provider · model · millions of tokens on a busy day · $ per million
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

function slot(start: number, seed: number, scale: number, quiet: boolean): UsageSlot {
  const entries: UsageEntry[] = [];
  MODELS.forEach(([provider, model, busy, perM], m) => {
    const r = rand(seed * 13 + m);
    if (r < 0.2) return;
    const tokens = Math.round(busy * 1_000_000 * scale * (quiet ? 0.3 : 1) * (0.3 + r));
    const money = Math.round((tokens / 1_000_000) * perM * 100) / 100;
    const plan = provider === 'claude-code' || provider === 'chatgpt';
    entries.push({
      provider, model, tokens,
      costUsd: plan || provider === 'local' ? null : money,
      estimateUsd: plan ? money : null,
    });
  });
  return { start, entries };
}

/** A window's fill over time: it climbs with the provider's own tokens and
 *  falls to zero at each reset. Scaled so a busy stretch gets near the top. */
function limitSeries(
  provider: 'claude-code' | 'chatgpt', window: 'five_hour' | 'seven_day',
  slots: UsageSlot[], period: number, capTokens: number, phase: number, target: number,
): LimitSeries {
  const points: LimitSeries['points'] = [];
  let used = 0;
  let windowStart = slots[0].start - phase;
  for (const s of slots) {
    while (s.start >= windowStart + period) { windowStart += period; points.push({ t: windowStart, pct: 0 }); used = 0; }
    used += s.entries.filter((e) => e.provider === provider).reduce((n, e) => n + e.tokens, 0);
    points.push({ t: s.start, pct: Math.min(100, Math.round((used / capTokens) * 100)) });
  }
  // End where the live bar stands, so the chart and the bar above it agree.
  const last = points[points.length - 1]?.pct || 1;
  const peak = Math.max(1, ...points.map((p) => p.pct));
  // Never scale an earlier window past 95%, or the line sits pinned at the top.
  const k = Math.min(target / last, 95 / peak);
  return { provider, window, points: points.map((p) => ({ t: p.t, pct: Math.min(100, Math.round(p.pct * k)) })) };
}

export function usageHistoryFixture(empty: boolean): UsageHistory {
  if (empty) return { hours: [], days: [], limits: [] };
  const now = Date.now();
  const thisHour = Math.floor(now / HOUR) * HOUR;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const hours: UsageSlot[] = [];
  for (let i = 23; i >= 0; i--) {
    const start = thisHour - i * HOUR;
    const h = new Date(start).getHours();
    hours.push(slot(start, 1000 + i, 1 / 10, h < 8 || h > 22));
  }
  const days: UsageSlot[] = [];
  for (let i = 89; i >= 0; i--) {
    const start = today.getTime() - i * DAY;
    const wd = new Date(start).getDay();
    days.push(slot(start, i, 1, wd === 0 || wd === 6));
  }
  return {
    hours,
    days,
    limits: [
      limitSeries('claude-code', 'five_hour', hours, 5 * HOUR, 60_000_000, 1 * HOUR, 42),
      limitSeries('chatgpt', 'five_hour', hours, 5 * HOUR, 30_000_000, 2 * HOUR, 34),
      limitSeries('claude-code', 'seven_day', days, 7 * DAY, 1_250_000_000, 3 * DAY, 61),
      limitSeries('chatgpt', 'seven_day', days, 7 * DAY, 1_100_000_000, 4 * DAY, 12),
    ],
  };
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
