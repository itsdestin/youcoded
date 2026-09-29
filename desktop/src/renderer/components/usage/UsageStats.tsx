// Usage history across every provider (design 2026-09-29, questions deck
// usage-stats-questions: Q-2 by day / provider / model, Q-3 Claude Code
// included, Q-4 plans show both their share and a pay-per-use estimate,
// Q-8 90 days). One component, drawn in two places (Q-1 "both"): compact in
// the status-bar usage popup, roomy on Settings → Cloud providers — so the two
// can never disagree about a number.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AnchorTip, EmptyState, ErrorState, LoadingState, ProgressBar, SegmentedTabs, Tooltip } from '../ui';
import type { UsageDay, UsageEntry, UsageProviderId } from '../../../shared/usage-types';

type Range = '1' | '7' | '30' | '90';
const RANGES = [
  { id: '1', label: 'Today' },
  { id: '7', label: '7 days' },
  { id: '30', label: '30 days' },
  { id: '90', label: '90 days' },
] as const;

type Breakdown = 'provider' | 'model';
const BREAKDOWNS = [
  { id: 'provider', label: 'By provider' },
  { id: 'model', label: 'By model' },
] as const;

export const PROVIDER_LABEL: Record<UsageProviderId, string> = {
  'claude-code': 'Claude Code',
  chatgpt: 'ChatGPT',
  openrouter: 'OpenRouter',
  api: 'Your API keys',
  local: 'Local models',
};

/** 1234 → "1.2k", 3_400_000 → "3.4M", 1.2e9 → "1.2B". */
export function formatTokenCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${n}`;
}

/** Dollars, never a false "$0.00" (same rule as the status bar's cost chip). */
function formatUsd(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01';
  // Whole dollars from $10 up: cents on a large figure (or an estimate) are noise.
  if (n >= 10) return `$${Math.round(n).toLocaleString()}`;
  return `$${n.toFixed(2)}`;
}

function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

interface Group {
  key: string;
  label: string;
  /** Provider name under a model row; empty on a provider row. */
  sub: string;
  provider: UsageProviderId;
  tokens: number;
  costUsd: number;
  estimateUsd: number;
}

function groupBy(entries: UsageEntry[], by: Breakdown): Group[] {
  const map = new Map<string, Group>();
  for (const e of entries) {
    const key = by === 'provider' ? e.provider : `${e.provider}:${e.model}`;
    const g = map.get(key) ?? {
      key, provider: e.provider,
      label: by === 'provider' ? PROVIDER_LABEL[e.provider] : e.model,
      sub: by === 'provider' ? '' : PROVIDER_LABEL[e.provider],
      tokens: 0, costUsd: 0, estimateUsd: 0,
    };
    g.tokens += e.tokens;
    g.costUsd += e.costUsd ?? 0;
    g.estimateUsd += e.estimateUsd ?? 0;
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => b.tokens - a.tokens);
}

/** The money half of a row, in the words Q-4 settled: what was billed, or —
 *  on a plan — what it would have cost, labelled as an estimate. */
function moneyLine(g: Group): string {
  if (g.provider === 'local') return 'Free';
  if (g.provider === 'claude-code' || g.provider === 'chatgpt') {
    return g.estimateUsd > 0 ? `worth ≈ ${formatUsd(g.estimateUsd)}` : 'Included in your plan';
  }
  return `${formatUsd(g.costUsd)} spent`;
}

function usageApi(): { history: () => Promise<UsageDay[]> } {
  return (window as any).claude.usage;
}

const INFO = (
  <>
    <p>
      <strong>Tokens</strong> are how AI providers measure work — about three quarters of a word each. Every
      step your assistant takes re-reads the conversation so far, so long chats add up fast.
    </p>
    <p>
      For monthly plans (Claude, ChatGPT) the dollar figure is an <strong>estimate</strong> of what the same
      work would cost at pay-per-use prices. You are not charged it. OpenRouter and API-key figures are what
      you were actually billed.
    </p>
    <p>Kept for 90 days, on this computer only.</p>
  </>
);

export function UsageStats({ compact = false }: { compact?: boolean }) {
  const [days, setDays] = useState<UsageDay[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [range, setRange] = useState<Range>('7');
  const [breakdown, setBreakdown] = useState<Breakdown>('provider');

  const load = useCallback(() => {
    setFailed(false);
    setDays(null);
    usageApi().history().then(setDays, () => setFailed(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => (days ?? []).slice(-Number(range)), [days, range]);
  const entries = useMemo(() => shown.flatMap((d) => d.entries), [shown]);
  const groups = useMemo(() => groupBy(entries, breakdown), [entries, breakdown]);
  const total = entries.reduce((n, e) => n + e.tokens, 0);
  const spent = entries.reduce((n, e) => n + (e.costUsd ?? 0), 0);
  const worth = entries.reduce((n, e) => n + (e.estimateUsd ?? 0), 0);

  if (failed) {
    return <ErrorState message="Your usage history couldn't be read." onRetry={load} />;
  }
  if (!days) return <LoadingState what="usage" />;
  if (days.length === 0) {
    return <EmptyState message="No usage yet. Your totals appear here after your first conversation." />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <SegmentedTabs tabs={RANGES} value={range} onChange={(id) => setRange(id as Range)} aria-label="Time range" />
        <AnchorTip label="About these numbers" title="About these numbers">{INFO}</AnchorTip>
      </div>

      {/* The three headline figures. Money is split in two on purpose (Q-4):
          a bill you pay and an estimate you do not are never one number. */}
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Tokens" value={formatTokenCount(total)} />
        <Stat label="Spent" value={spent > 0 ? formatUsd(spent) : '$0'} hint="Billed to you" />
        <Stat label="Plan worth" value={worth > 0 ? `≈ ${formatUsd(worth)}` : '—'} hint="At pay-per-use prices" />
      </div>

      {/* By day (Q-2). A single day has no shape to draw. */}
      {shown.length > 1 && <DayBars days={shown} height={compact ? 56 : 88} />}

      <div className="space-y-2">
        <SegmentedTabs tabs={BREAKDOWNS} value={breakdown} onChange={(id) => setBreakdown(id as Breakdown)} aria-label="Break down by" />
        {groups.length === 0 ? (
          <EmptyState variant="inline" message="Nothing used in this range." />
        ) : (
          <ul className="space-y-2">
            {groups.map((g) => <GroupRow key={g.key} g={g} total={total} />)}
          </ul>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-inset/50 rounded-lg px-3 py-2 min-w-0">
      <p className="text-2xs text-fg-muted uppercase tracking-wide">{label}</p>
      <p className="text-base font-medium text-fg tabular-nums truncate">{value}</p>
      {hint && <p className="text-2xs text-fg-muted truncate">{hint}</p>}
    </div>
  );
}

function GroupRow({ g, total }: { g: Group; total: number }) {
  const share = total > 0 ? (g.tokens / total) * 100 : 0;
  return (
    <li>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="min-w-0 truncate text-fg">
          {g.label}
          {g.sub && <span className="text-fg-muted"> · {g.sub}</span>}
        </span>
        <span className="shrink-0 tabular-nums text-fg-2">{formatTokenCount(g.tokens)}</span>
      </div>
      <ProgressBar percent={share} color="var(--fg-2)" className="w-full my-1" aria-label={`${g.label} share of usage`} />
      <div className="flex justify-between gap-2 text-2xs text-fg-muted">
        <span>{Math.round(share)}% of your use</span>
        <span className="tabular-nums">{moneyLine(g)}</span>
      </div>
    </li>
  );
}

/** One bar per day, one series (the total), so identity never rides on a
 *  colour a theme could repaint. The per-provider split is in the hover. */
function DayBars({ days, height }: { days: UsageDay[]; height: number }) {
  const totals = days.map((d) => d.entries.reduce((n, e) => n + e.tokens, 0));
  const max = Math.max(1, ...totals);
  const peak = totals.indexOf(max);
  return (
    <div>
      <p className="text-2xs text-fg-muted mb-1">Busiest day {formatTokenCount(max)} · {dayLabel(days[peak].date)}</p>
      <div className="flex items-end gap-0.5" style={{ height }} role="img"
        aria-label={`Tokens per day, highest ${formatTokenCount(max)} on ${dayLabel(days[peak].date)}`}>
        {days.map((d, i) => {
          const parts = groupBy(d.entries, 'provider').map((g) => `${g.label} ${formatTokenCount(g.tokens)}`).join(', ');
          return (
            <Tooltip key={d.date} text={`${dayLabel(d.date)} · ${formatTokenCount(totals[i])} tokens${parts ? ` — ${parts}` : ''}`}>
              <div className="flex-1 h-full flex items-end group">
                <div
                  className="w-full rounded-t-sm bg-fg-muted/60 group-hover:bg-fg-2 transition-colors"
                  style={{ height: `${Math.max(totals[i] > 0 ? 3 : 0, (totals[i] / max) * 100)}%` }}
                />
              </div>
            </Tooltip>
          );
        })}
      </div>
      {/* UX review U9: a week names every bar; a month or more names its ends. */}
      {days.length <= 7 ? (
        <div className="flex gap-0.5 text-2xs text-fg-muted mt-1">
          {days.map((d, i) => (
            <span key={d.date} className="flex-1 text-center truncate">
              {i === days.length - 1 ? 'Today' : dayLabel(d.date).split(',')[0]}
            </span>
          ))}
        </div>
      ) : (
        <div className="flex justify-between text-2xs text-fg-muted mt-1">
          <span>{dayLabel(days[0].date)}</span>
          <span>Today</span>
        </div>
      )}
    </div>
  );
}
