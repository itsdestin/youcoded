import React from 'react';
import type { UsageSnapshot } from '../state/chat-types';

// Permanent inline card rendered when user types /cost or /usage. Snapshot-only —
// we deliberately don't subscribe to live stats here; the status bar handles the
// live view. This matches how Claude Code's own /cost prints a point-in-time table.

interface Props {
  snapshot: UsageSnapshot;
}

function formatCost(v: number | null): string {
  if (v == null) return '--';
  if (v < 0.01) return '<$0.01';
  return `$${v.toFixed(2)}`;
}

function formatTokens(v: number | null): string {
  if (v == null) return '--';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return `${v}`;
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return '--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function formatResetsAt(iso: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diff = d.getTime() - now;
    if (diff <= 0) return 'resetting';
    const hours = Math.floor(diff / 3_600_000);
    const mins = Math.floor((diff % 3_600_000) / 60_000);
    if (hours === 0) return `resets in ${mins}m`;
    if (hours < 24) return `resets in ${hours}h ${mins}m`;
    const days = Math.floor(hours / 24);
    return `resets in ${days}d`;
  } catch {
    return '';
  }
}

// Status bar color logic: green <50%, amber 50-80%, red ≥80%.
// Kept in sync with StatusBar.tsx — hardcoded hex so colors survive theme changes.
function utilizationColor(pct: number | null): string {
  if (pct == null) return 'var(--fg-muted)';
  if (pct >= 0.8) return '#ef4444';
  if (pct >= 0.5) return '#f59e0b';
  return '#10b981';
}

function UsageBar({ pct, color }: { pct: number | null; color: string }) {
  const width = pct == null ? 0 : Math.min(100, Math.max(0, pct * 100));
  return (
    <div className="h-1.5 w-full rounded-full bg-inset overflow-hidden">
      <div className="h-full rounded-full transition-all" style={{ width: `${width}%`, backgroundColor: color }} />
    </div>
  );
}

export default function UsageCard({ snapshot: s }: Props) {
  const cacheTotal = (s.cacheReadTokens ?? 0) + (s.cacheCreationTokens ?? 0);
  const cacheHitRate =
    cacheTotal > 0 && s.cacheReadTokens != null
      ? s.cacheReadTokens / cacheTotal
      : null;

  const fiveHourColor = utilizationColor(s.fiveHourUtilization);
  const sevenDayColor = utilizationColor(s.sevenDayUtilization);
  const contextFrac = s.contextPercent != null ? s.contextPercent / 100 : null;
  const contextColor = utilizationColor(contextFrac);

  return (
    <div className="flex justify-start px-4 py-1">
      <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-inset border border-edge-dim px-5 py-4 text-fg">
        <div className="flex items-baseline justify-between mb-3">
          <div className="text-xs uppercase tracking-wider text-fg-muted font-medium">Session Usage</div>
          <div className="text-xs text-fg-faint">{new Date(s.timestamp).toLocaleTimeString()}</div>
        </div>

        {/* Headline: cost + duration */}
        <div className="flex items-end gap-6 mb-4">
          <div>
            <div className="text-2xl font-semibold tabular-nums">{formatCost(s.costUsd)}</div>
            <div className="text-xs text-fg-muted">session cost</div>
          </div>
          <div>
            <div className="text-lg font-medium tabular-nums">{formatDuration(s.duration)}</div>
            <div className="text-xs text-fg-muted">
              {s.apiDuration != null && s.duration != null && s.duration > 0
                ? `${Math.round((s.apiDuration / s.duration) * 100)}% active`
                : 'elapsed'}
            </div>
          </div>
        </div>

        {/* Tokens row */}
        <div className="grid grid-cols-3 gap-3 mb-4 text-sm">
          <div>
            <div className="text-fg-muted text-xs mb-0.5">Input</div>
            <div className="tabular-nums">{formatTokens(s.inputTokens)}</div>
          </div>
          <div>
            <div className="text-fg-muted text-xs mb-0.5">Output</div>
            <div className="tabular-nums">{formatTokens(s.outputTokens)}</div>
          </div>
          <div>
            <div className="text-fg-muted text-xs mb-0.5">
              Cache{cacheHitRate != null && ` · ${Math.round(cacheHitRate * 100)}% hit`}
            </div>
            <div className="tabular-nums">{formatTokens(cacheTotal || null)}</div>
          </div>
        </div>

        {/* Context usage */}
        {s.contextPercent != null && (
          <div className="mb-3">
            <div className="flex justify-between text-xs mb-1">
              <span className="text-fg-muted">Context used</span>
              <span className="tabular-nums" style={{ color: contextColor }}>
                {Math.round(s.contextPercent)}%
              </span>
            </div>
            <UsageBar pct={contextFrac} color={contextColor} />
          </div>
        )}

        {/* Rate limits */}
        {(s.fiveHourUtilization != null || s.sevenDayUtilization != null) && (
          <div className="space-y-2 pt-3 border-t border-edge-dim">
            {s.fiveHourUtilization != null && (
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-fg-muted">5-hour limit · {formatResetsAt(s.fiveHourResetsAt)}</span>
                  <span className="tabular-nums" style={{ color: fiveHourColor }}>
                    {Math.round(s.fiveHourUtilization * 100)}%
                  </span>
                </div>
                <UsageBar pct={s.fiveHourUtilization} color={fiveHourColor} />
              </div>
            )}
            {s.sevenDayUtilization != null && (
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-fg-muted">7-day limit · {formatResetsAt(s.sevenDayResetsAt)}</span>
                  <span className="tabular-nums" style={{ color: sevenDayColor }}>
                    {Math.round(s.sevenDayUtilization * 100)}%
                  </span>
                </div>
                <UsageBar pct={s.sevenDayUtilization} color={sevenDayColor} />
              </div>
            )}
          </div>
        )}

        {/* Lines changed — only if non-zero, to avoid clutter on conversational sessions */}
        {(s.linesAdded || s.linesRemoved) && (
          <div className="mt-3 pt-3 border-t border-edge-dim text-xs text-fg-muted">
            <span className="text-green-500 tabular-nums">+{s.linesAdded ?? 0}</span>
            {' / '}
            <span className="text-red-500 tabular-nums">−{s.linesRemoved ?? 0}</span>
            {' lines changed'}
          </div>
        )}
      </div>
    </div>
  );
}
