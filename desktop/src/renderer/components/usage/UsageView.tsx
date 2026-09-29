// The usage view (design 2026-09-29, round 2). Review round 1 called the first
// version "very cluttered" and asked to "see how my token use aligns with my
// plan limits over time", so this shows ONE account at a time: its limits now,
// then two strips on one timeline — how full the plan window was (a drop is a
// reset) above the tokens used in each slot — then what each model used. One
// component, drawn in the status-bar popup and at the bottom of Settings →
// Cloud providers, so the two can never disagree.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AnchorTip, Button, EmptyState, ErrorState, LoadingState, SegmentedTabs, Tooltip } from '../ui';
import { PlanWindows, WindowRow, type PlanUsage } from '../plan-windows';
import { OPENROUTER_CREDITS_URL } from '../../../shared/provider-types';
import type { LimitSeries, UsageAccounts, UsageHistory, UsageProviderId, UsageSlot } from '../../../shared/usage-types';
import { usePlanWindows, useUsageAccounts } from './usage-live';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const NAME: Record<UsageProviderId, string> = {
  'claude-code': 'Claude Code',
  chatgpt: 'ChatGPT',
  openrouter: 'OpenRouter',
  api: 'API keys',
  local: 'Local',
};

const SITE: Partial<Record<UsageProviderId, { url: string; label: string }>> = {
  'claude-code': { url: 'https://claude.ai/settings/usage', label: 'claude.ai ↗' },
  chatgpt: { url: 'https://chatgpt.com/#settings/Account', label: 'chatgpt.com ↗' },
  openrouter: { url: OPENROUTER_CREDITS_URL, label: 'Add credit ↗' },
};

export type UsageRange = '24h' | '2w' | '3m';
type Range = UsageRange;
const RANGES = [
  { id: '24h', label: '24 hours' },
  { id: '2w', label: '2 weeks' },
  { id: '3m', label: '3 months' },
] as const;

const isPlan = (p: UsageProviderId): p is 'claude-code' | 'chatgpt' => p === 'claude-code' || p === 'chatgpt';

/** 1234 → "1.2k", 3_400_000 → "3.4M", 1.2e9 → "1.2B". */
export function formatTokenCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${n}`;
}

/** Dollars, never a false "$0.00"; whole dollars from $10 up. */
function formatUsd(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01';
  if (n >= 10) return `$${Math.round(n).toLocaleString()}`;
  return `$${n.toFixed(2)}`;
}

function slotLabel(start: number, range: Range): string {
  const d = new Date(start);
  return range === '24h'
    ? d.toLocaleTimeString(undefined, { hour: 'numeric' })
    : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function hasWindows(u: PlanUsage | null): boolean {
  return !!(u?.five_hour || u?.seven_day || u?.other?.length);
}

function historyApi(): { history: () => Promise<UsageHistory> } {
  return (window as any).claude.usage;
}

const INFO = (
  <>
    <p>
      <strong>Tokens</strong> are how AI providers measure work — about three quarters of a word each. Every
      step your assistant takes re-reads the conversation so far, so long chats add up fast.
    </p>
    <p>
      The top line is how full your plan's limit was at each moment; it drops to zero when the limit resets.
      The bars under it are the tokens used in that hour or day.
    </p>
    <p>Kept for 90 days, on this computer only.</p>
  </>
);

/** The whole view. `initial` picks the account it opens on (the popup passes
 *  the current chat's); `onManage` adds the "Manage accounts" button. */
export function UsageView({ initial, initialRange, onManage }: {
  initial?: UsageProviderId; initialRange?: UsageRange; onManage?: () => void;
}) {
  const [history, setHistory] = useState<UsageHistory | null>(null);
  const [failed, setFailed] = useState(false);
  const windows = usePlanWindows();
  const accounts = useUsageAccounts();

  const load = useCallback(() => {
    setFailed(false);
    setHistory(null);
    historyApi().history().then(setHistory, () => setFailed(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  // An account gets a tab when it has something to show: a live limit or
  // balance, or any recorded work.
  const present = useMemo(() => {
    const used = new Set<UsageProviderId>();
    for (const s of history?.days ?? []) for (const e of s.entries) used.add(e.provider);
    const order: UsageProviderId[] = ['claude-code', 'chatgpt', 'openrouter', 'api', 'local'];
    return order.filter((p) => used.has(p)
      || (p === 'claude-code' && hasWindows(windows.claude))
      || (p === 'chatgpt' && hasWindows(windows.chatgpt))
      || (p === 'openrouter' && accounts?.openrouter != null));
  }, [history, windows, accounts]);

  const [picked, setPicked] = useState<UsageProviderId | null>(initial ?? null);
  const account = picked && present.includes(picked) ? picked : present[0];

  if (failed) return <ErrorState message="Your usage history couldn't be read." onRetry={load} />;
  if (!history) return <LoadingState what="usage" />;
  if (!account) {
    return <EmptyState message="No usage yet. Your limits and totals appear here after your first conversation." />;
  }

  const site = SITE[account];
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <SegmentedTabs
          tabs={present.map((p) => ({ id: p, label: NAME[p] }))}
          value={account}
          onChange={(id) => setPicked(id as UsageProviderId)}
          aria-label="Account"
        />
        <AnchorTip label="About these numbers" title="About these numbers">{INFO}</AnchorTip>
      </div>

      <AccountBody
        key={account}
        account={account}
        history={history}
        now={account === 'claude-code' ? windows.claude : account === 'chatgpt' ? windows.chatgpt : null}
        accounts={accounts}
        initialRange={initialRange}
      />

      {(site || onManage) && (
        <div className="flex justify-end gap-1.5">
          {site && (
            <Button variant="secondary" size="sm" onClick={() => void (window as any).claude.shell.openExternal(site.url)}>
              {site.label}
            </Button>
          )}
          {onManage && <Button variant="secondary" size="sm" onClick={onManage}>Manage accounts</Button>}
        </div>
      )}
    </div>
  );
}

function AccountBody({ account, history, now, accounts, initialRange }: {
  account: UsageProviderId; history: UsageHistory; now: PlanUsage | null; accounts: UsageAccounts | null;
  initialRange?: UsageRange;
}) {
  const [range, setRange] = useState<Range>(initialRange ?? '2w');
  const slots = useMemo(() => {
    const src = range === '24h' ? history.hours : history.days.slice(range === '2w' ? -14 : -90);
    return src.map((s) => ({ start: s.start, entries: s.entries.filter((e) => e.provider === account) }));
  }, [history, range, account]);
  const span = range === '24h' ? HOUR : DAY;
  const limit = isPlan(account)
    ? history.limits.find((l) => l.provider === account && l.window === (range === '24h' ? 'five_hour' : 'seven_day'))
    : undefined;
  const money = account === 'openrouter' || account === 'api';

  const models = useMemo(() => {
    const m = new Map<string, { tokens: number; usd: number }>();
    for (const s of slots) for (const e of s.entries) {
      const v = m.get(e.model) ?? { tokens: 0, usd: 0 };
      v.tokens += e.tokens;
      v.usd += (money ? e.costUsd : e.estimateUsd) ?? 0;
      m.set(e.model, v);
    }
    return [...m.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
  }, [slots, money]);
  const total = models.reduce((n, [, v]) => n + v.tokens, 0);
  const totalUsd = models.reduce((n, [, v]) => n + v.usd, 0);

  return (
    <div className="space-y-3">
      {/* Right now. The bars are the app's one recipe for a plan window. */}
      {hasWindows(now) && <PlanWindows usage={now} />}
      {account === 'chatgpt' && accounts?.chatgpt?.modelLimits?.map((l) => (
        <WindowRow key={l.model} label={`${l.model}'s own limit`} win={{ utilization: l.utilization, resets_at: l.resets_at }} />
      ))}
      {account === 'chatgpt' && accounts?.chatgpt?.credits && (
        <Line label="Extra credits" value={accounts.chatgpt.credits.unlimited ? 'Unlimited' : `${accounts.chatgpt.credits.balance.toLocaleString()} credits left`} />
      )}
      {account === 'openrouter' && accounts?.openrouter && (
        <Line label="Credit left" value={`$${accounts.openrouter.balanceUsd.toFixed(2)}`} />
      )}

      {/* The range sits on its own "Over time" line, right-aligned, so it
          never reads as a second copy of the account tabs above. */}
      <div className="flex items-center justify-between gap-2 pt-2 border-t border-edge-dim">
        <span className="text-xs font-medium text-fg">Over time</span>
        <SegmentedTabs tabs={RANGES} value={range} onChange={(id) => setRange(id as Range)} aria-label="Time range" />
      </div>

      <Timeline slots={slots} span={span} range={range} limit={limit} money={money} />

      {/* What used it, over the same range as the chart. */}
      {models.length > 0 && (
        <div className="space-y-1">
          {models.map(([name, v]) => (
            <div key={name} className="flex items-baseline gap-2 text-xs">
              <span className="flex-1 min-w-0 truncate text-fg">{name}</span>
              <span className="tabular-nums text-fg-2">{money ? formatUsd(v.usd) : formatTokenCount(v.tokens)}</span>
              <span className="w-9 text-right tabular-nums text-fg-muted">{total > 0 ? Math.round((v.tokens / total) * 100) : 0}%</span>
            </div>
          ))}
          <p className="text-2xs text-fg-muted pt-1">
            {money
              ? `${formatUsd(totalUsd)} spent · ${formatTokenCount(total)} tokens`
              : isPlan(account) && totalUsd > 0
                ? `${formatTokenCount(total)} tokens · worth ≈ ${formatUsd(totalUsd)} at pay-per-use prices`
                : `${formatTokenCount(total)} tokens`}
          </p>
        </div>
      )}
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex justify-between text-xs">
      <span className="text-fg-muted">{label}</span>
      <span className="text-fg-2 tabular-nums">{value}</span>
    </p>
  );
}

/** Two strips on one timeline (never two scales on one chart): the plan
 *  window's fill as a line, and the tokens (or dollars) per slot as bars.
 *  Hovering a column names both numbers for that hour or day. */
function Timeline({ slots, span, range, limit, money }: {
  slots: UsageSlot[]; span: number; range: Range; limit?: LimitSeries; money: boolean;
}) {
  if (slots.length === 0) return null;
  const t0 = slots[0].start;
  const t1 = slots[slots.length - 1].start + span;
  const values = slots.map((s) => s.entries.reduce((n, e) => n + (money ? e.costUsd ?? 0 : e.tokens), 0));
  const max = Math.max(...values, 0);
  const pts = (limit?.points ?? []).filter((p) => p.t >= t0 && p.t <= t1);
  const x = (t: number) => ((t - t0) / (t1 - t0)) * 1000;
  // Each point holds its value until the next one (a step line), so a reset
  // reads as a straight drop, not a slope.
  let path = '';
  pts.forEach((p, i) => {
    const y = 100 - p.pct;
    path += i === 0 ? `M${x(p.t)},${y}` : `H${x(p.t)}V${y}`;
  });
  if (pts.length) path += `H${x(Math.min(Date.now(), t1))}`;
  const pctAt = (t: number) => {
    let v: number | null = null;
    for (const p of pts) { if (p.t <= t) v = p.pct; else break; }
    return v;
  };
  const windowName = range === '24h' ? '5-hour limit' : '7-day limit';
  const fmt = (v: number) => (money ? formatUsd(v) : formatTokenCount(v));

  return (
    <div>
      {limit && (
        <>
          <p className="flex justify-between text-2xs text-fg-muted"><span>{windowName}</span><span>100%</span></p>
          <svg viewBox="0 0 1000 100" preserveAspectRatio="none" className="w-full h-12 overflow-visible" aria-hidden>
            <line x1="0" x2="1000" y1="100" y2="100" stroke="var(--edge-dim)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <path d={path} fill="none" stroke="var(--fg-2)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </svg>
        </>
      )}
      <p className={`flex justify-between text-2xs text-fg-muted ${limit ? 'mt-2' : ''}`}>
        <span>{money ? 'Spent' : 'Tokens'}</span><span>{fmt(max)}</span>
      </p>
      <div className="relative h-14 flex items-end gap-px" role="img"
        aria-label={`${money ? 'Spending' : 'Tokens'} per ${range === '24h' ? 'hour' : 'day'}, highest ${fmt(max)}`}>
        {slots.map((s, i) => {
          const pct = limit ? pctAt(s.start + span - 1) : null;
          const tip = `${slotLabel(s.start, range)} · ${fmt(values[i])}${money ? '' : ' tokens'}${pct != null ? ` · ${windowName} ${pct}%` : ''}`;
          return (
            <Tooltip key={s.start} text={tip}>
              <div className="flex-1 h-full flex items-end group">
                <div
                  className="w-full rounded-t-sm bg-fg-muted/50 group-hover:bg-fg-2 transition-colors"
                  style={{ height: `${max > 0 ? Math.max(values[i] > 0 ? 3 : 0, (values[i] / max) * 100) : 0}%` }}
                />
              </div>
            </Tooltip>
          );
        })}
      </div>
      <p className="flex justify-between text-2xs text-fg-muted mt-1">
        <span>{slotLabel(t0, range)}</span>
        <span>Now</span>
      </p>
    </div>
  );
}
