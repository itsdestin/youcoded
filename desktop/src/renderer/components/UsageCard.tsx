import type { UsageSnapshot } from '../state/chat-types';
import { ProgressBar } from './ui';
import { PlanWindows, formatResetsAt, utilizationColor } from './plan-windows';
import { selectCacheReuse } from '../state/cache-reuse';

// Permanent inline card rendered when user types /cost or /usage. Snapshot-only —
// we deliberately don't subscribe to live stats here; the status bar handles the
// live view. This matches how Claude Code's own /cost prints a point-in-time table.
//
// This card is also the ESCAPE HATCH for the two Claude subscription numbers the
// status bar hides in a native (YouCoded-runtime) session — the Customize menu
// marks those rows "Claude Code sessions only" and this is where they still
// live. So the 5-hour and 7-day blocks below render in EVERY kind of session,
// and say out loud that they measure the whole Claude account rather than this
// one conversation (spec §10).

interface Props {
  snapshot: UsageSnapshot;
}

// The one sentence every session-scoped surface uses (spec §2). Deliberately
// word-for-word identical to StatusBar.tsx's SCOPE_NOTE: the bar's chips and
// this card describe the same measurement, and two spellings of one promise is
// how they end up disagreeing.
const SCOPE_NOTE = 'Counts this session so far, including specialists.';
// The two sentences the cost chip's tooltip uses, copied BYTE-FOR-BYTE from
// StatusBar.tsx. One session, one explanation: the bar and this card are two
// clicks apart, so two spellings of one fact read as two different facts.
//
// UNPRICED_NOTE says "available", not "published" (Task 22): the price lookup
// returns nothing for ANY model it cannot look up — including a model whose
// price exists but whose catalog never loaded (dead network, empty cache) — so
// "no price is published" asserts a cause the code never checked, which
// docs/error-message-standards.md forbids.
//
// PARTIAL_NOTE carried that SAME unchecked claim until Task 24 reworded it and
// the bar's copy (StatusBar.tsx, the cost chip's `partial` branch) together —
// the two are byte-identical and must stay that way, because the bar and the
// card are describing one total and a user who reads both must not be told two
// different things. FIX BOTH COPIES TOGETHER — searching for the sentence
// finds them both, and a test on each side pins the full sentence.
const PARTIAL_NOTE = 'Models with no available price are not included in this total.';
const UNPRICED_NOTE =
  "This provider bills for usage, but no price is available for this model here, so the session cost can't be totalled.";

function formatCost(v: number): string {
  // toFixed(2) rounds anything under half a cent to "$0.00", and a card that
  // reads "$0.00" while money is being spent reads as broken (spec §5 forbids
  // that false zero). Shared shape with the status bar's formatCostUsd.
  if (v < 0.01) return '<$0.01';
  return `$${v.toFixed(2)}`;
}

// The card has room the status bar doesn't, so it prints the exact count with
// thousands separators rather than the bar's glanceable "12.3k". Same number,
// more precision, in the place built to hold it.
function formatTokens(v: number): string {
  return v.toLocaleString();
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

// formatResetsAt and utilizationColor moved to plan-windows.tsx (2026-09-05) so the
// Model Providers rows draw the plan windows with this card's exact recipe.

// Context is REMAINING, not used — so its colour scale is the INVERSE of the
// one above. statusline.sh writes `remaining_percentage` to the file the main
// process reads ("context remaining %"), and the native figure is
// (window - used) / window too (StatusBar.tsx: "contextPct is REMAINING
// context"). Running that number through utilizationColor painted a session
// with 90% of its window still FREE bright red — the opposite of what the
// status bar's own green "90% remaining" pill said about the same number.
// Thresholds are StatusBar.tsx's contextColor (red under 20 left, amber under
// 50) so the bar and this card cannot disagree; the hues are this card's own
// palette, shared with the two utilisation bars beside it.
// Deliberately NOT a tweak to utilizationColor: the 5-hour and 7-day bars are
// utilisation, where high really IS bad.
function contextRemainingColor(pct: number | null): string {
  if (pct == null) return 'var(--fg-muted)';
  if (pct < 20) return '#ef4444';
  if (pct < 50) return '#f59e0b';
  return '#10b981';
}

// Change 46: the shared bar, keeping this card's status hue via the `color` prop
// (§1.8 explicitly preserved UsageCard's inline threshold colors — they are
// status, not theme, so rule 5 does not apply). The bar also gains
// role="progressbar" + aria-valuenow.
//
// Fix: `percent` is a PERCENT (0-100), matching ProgressBar's own contract and
// the numbers printed beside each bar. It used to be a 0-1 ratio that the
// callers multiplied by 100 — but the subscription utilization arriving from
// the usage cache is ALREADY a percent (verified: ~/.claude/.usage-cache.json
// carries "utilization": 42, and the status bar prints it with no conversion),
// so those two bars rendered "4200%" pinned to full. Every caller now passes
// one unit, and `label` names which bar a screen reader is reading.
function UsageBar({ percent, color, label }: { percent: number; color: string; label: string }) {
  return <ProgressBar percent={percent} color={color} className="w-full" aria-label={label} />;
}

export default function UsageCard({ snapshot: s }: Props) {
  const cacheTotal = (s.cacheReadTokens ?? 0) + (s.cacheCreationTokens ?? 0);
  // The zero rule, in the status bar's own words. `cacheTotal > 0` used to gate
  // this cell, which threw away a REAL Claude Code zero: a cold or expired
  // prompt cache genuinely reads 0 cached tokens, and the bar (which bails on
  // null, deliberately not on falsy) printed "Cached: 0" while this card
  // printed nothing at all about one session. A native zero never reaches here
  // — the snapshot collapses it to null upstream, because emptyTotals() starts
  // every native session at all-zero before a turn has run — so `!= null` is
  // exactly "somebody measured this".
  const cacheMeasured = s.cacheReadTokens != null || s.cacheCreationTokens != null;
  // Fix: this used to be reads/(reads+writes) — the exact "hit rate" the status
  // bar replaced in 2026-08 because it sits at 100% forever on any provider that
  // reports no cache writes (every native one). The card kept the dead formula,
  // so the two surfaces printed different percentages for one session. Both now
  // call the SAME selector, which answers the question a user actually has: how
  // much of the prompt came from cache instead of being re-read.
  const cacheReuse = selectCacheReuse(s, null);

  const contextColor = contextRemainingColor(s.contextPercent);

  // Rule 1 (spec §3): no value, no row. Every one of these used to render a
  // literal "--" — forever in a native session, where the statusline that fed
  // them never runs. A row of dashes is furniture that teaches the user to
  // ignore the card.
  //
  // A cost of exactly 0 takes the same path as "nothing was priced": an exact
  // zero is not a rounding artifact, and the status bar hides its chip on it
  // too, so the two surfaces stay in step.
  const showCost = s.costUsd != null && s.costUsd > 0;
  // Nothing could be priced, but the provider bills anyway — say that, rather
  // than leaving a silent gap that looks identical to a session that spent
  // nothing. Mirrors the bar's "Cost: not listed" chip.
  const showUnpriced = !showCost && !!s.costIsPartial;
  const showTokens = s.inputTokens != null || s.outputTokens != null || cacheMeasured;
  const showLines = !!(s.linesAdded || s.linesRemoved);
  const showSessionSection = showCost || showUnpriced || s.duration != null || showTokens || showLines;
  // Any window counts — a free ChatGPT plan has only a 30-day one (W-2 = a).
  const showSubscription = s.fiveHourUtilization != null || s.sevenDayUtilization != null || !!s.otherWindows?.length;
  // Rule 1 taken to its end: when EVERY row is omitted the card was nothing but
  // a heading and a timestamp — furniture, and the normal state of a native
  // session that has not run a turn yet and has no Claude usage cache on disk.
  // One line instead, so the card reads as working-but-empty rather than broken.
  const nothingMeasured = !showSessionSection && s.contextPercent == null && !showSubscription;

  return (
    <div className="flex justify-start px-4 py-1">
      <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-inset border border-edge-dim px-5 py-4 text-fg">
        <div className="flex items-baseline justify-between mb-3">
          <div className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Session Usage</div>
          <div className="text-xs text-fg-muted">{new Date(s.timestamp).toLocaleTimeString()}</div>
        </div>

        {/* The §2 contract sentence, once. Gated on countsFromSessionTotals
            because it is a promise about THIS app's own per-turn accounting: a
            Claude Code session's figures are Claude Code's, and claiming this
            app folded specialists into them would be a claim it cannot back
            (docs/error-message-standards.md). */}
        {showSessionSection && s.countsFromSessionTotals && (
          <p className="text-xs text-fg-muted mb-3">
            {SCOPE_NOTE}
            {/* The count is printed only when there IS one — "0 specialists"
                is noise, and a session that never delegated should not be told
                about a concept it hasn't met. */}
            {!!s.specialistRuns &&
              ` ${s.specialistRuns} specialist run${s.specialistRuns === 1 ? '' : 's'} so far.`}
          </p>
        )}

        {/* Empty state (spec §3, rule 1 taken to its end). A session that has
            measured nothing has no row to show — say that in one plain line
            rather than leaving a heading floating over blank space. */}
        {nothingMeasured && (
          <p className="text-xs text-fg-muted">
            No usage to show yet &mdash; numbers appear here after the assistant&apos;s first reply.
          </p>
        )}

        {/* Headline: cost + duration. Each half appears only if it has a value —
            a native session has no wall-time measurement at all (spec §15). */}
        {(showCost || showUnpriced || s.duration != null) && (
          <div className="flex items-end gap-6 mb-4">
            {showCost && (
              <div>
                <div className="text-2xl font-semibold tabular-nums">{formatCost(s.costUsd!)}</div>
                <div className="text-xs text-fg-muted">session cost</div>
              </div>
            )}
            {showUnpriced && (
              <div>
                {/* Muted, not accent-coloured: this is the ABSENCE of a figure,
                    not an alert. Same treatment as the status bar's chip. */}
                <div className="text-2xl font-semibold text-fg-muted">not listed</div>
                <div className="text-xs text-fg-muted">session cost</div>
              </div>
            )}
            {s.duration != null && (
              <div>
                <div className="text-lg font-medium tabular-nums">{formatDuration(s.duration)}</div>
                <div className="text-xs text-fg-muted">
                  {s.apiDuration != null && s.duration > 0
                    ? `${Math.round((s.apiDuration / s.duration) * 100)}% active`
                    : 'elapsed'}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Says what is true — that some work could not be totalled — never a
            guess at why (docs/error-message-standards.md). Word-for-word the
            cost chip's tooltip, so the bar and the card agree. */}
        {showCost && s.costIsPartial && (
          <p className="text-xs text-fg-muted -mt-3 mb-4">{PARTIAL_NOTE}</p>
        )}
        {showUnpriced && <p className="text-xs text-fg-muted -mt-3 mb-4">{UNPRICED_NOTE}</p>}

        {/* Tokens row — each cell only when it has a number of its own. */}
        {showTokens && (
          <div className="grid grid-cols-3 gap-3 mb-4 text-sm">
            {s.inputTokens != null && (
              <div>
                <div className="text-fg-muted text-xs mb-0.5">Input</div>
                <div className="tabular-nums">{formatTokens(s.inputTokens)}</div>
              </div>
            )}
            {s.outputTokens != null && (
              <div>
                <div className="text-fg-muted text-xs mb-0.5">Output</div>
                <div className="tabular-nums">{formatTokens(s.outputTokens)}</div>
              </div>
            )}
            {cacheMeasured && (
              <div>
                <div className="text-fg-muted text-xs mb-0.5">
                  Cache{cacheReuse.ratio != null && ` · ${Math.round(cacheReuse.ratio * 100)}% reused`}
                </div>
                <div className="tabular-nums">{formatTokens(cacheTotal)}</div>
              </div>
            )}
          </div>
        )}

        {/* Context left in the model's window. The figure is how much is LEFT,
            so the words, the bar's fill and the screen-reader label all have to
            say "remaining" — the status bar's pill already does, and a sighted
            user and a screen-reader user must not get opposite readings of one
            number. */}
        {s.contextPercent != null && (
          <div className="mb-3">
            <div className="flex justify-between text-xs mb-1">
              <span className="text-fg-muted">Context remaining</span>
              <span className="tabular-nums" style={{ color: contextColor }}>
                {Math.round(s.contextPercent)}%
              </span>
            </div>
            <UsageBar percent={s.contextPercent} color={contextColor} label="Context remaining" />
          </div>
        )}

        {/* Claude subscription limits. NOT gated on the kind of session — this
            card is where a native session goes to see them, because the status
            bar no longer shows them there. */}
        {showSubscription && (
          <div className="space-y-2 pt-3 border-t border-edge-dim">
            {/* One recipe for the two windows (plan-windows.tsx) — the Model
                Providers rows draw the same bars for each plan. */}
            <PlanWindows usage={{
              five_hour: s.fiveHourUtilization != null ? { utilization: s.fiveHourUtilization, resets_at: s.fiveHourResetsAt ?? '' } : null,
              seven_day: s.sevenDayUtilization != null ? { utilization: s.sevenDayUtilization, resets_at: s.sevenDayResetsAt ?? '' } : null,
              // Odd-length windows, drawn after the two above and labelled by
              // length (a free ChatGPT plan's "30-day limit"). Undefined when
              // the plan has none, so the two-bar output is unchanged.
              other: s.otherWindows ?? null,
            }} />
            {/* These two bars are ACCOUNT-wide, not session-scoped. Saying so
                here is the whole reason the status bar can drop the chips in a
                native session without leaving the user guessing (spec §10) —
                and it stops the card recreating the confusion the bar just
                shed. */}
            {/* Sign in with ChatGPT (2026-09-04): the same two bars describe the
                ChatGPT plan when the session runs on one; the scope line says
                which, because "5-hour limit" alone no longer names the plan. */}
            <p className="text-3xs text-fg-muted pt-1">
              {s.subscriptionPlan === 'chatgpt'
                ? 'Measured across your whole ChatGPT plan, not just this conversation.'
                : 'Measured across your whole Claude account, not just this conversation.'}
            </p>
          </div>
        )}

        {/* Lines changed — only if non-zero, to avoid clutter on conversational sessions */}
        {showLines && (
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
