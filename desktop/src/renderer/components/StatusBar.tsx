import { useState, useCallback } from 'react';
import { useEscClose } from '../hooks/use-esc-close';
import { createPortal } from 'react-dom';
import { useTheme, type ContextDisplay } from '../state/theme-context';
import type { PermissionMode } from '../../shared/types';
import type { NativePermissionMode } from '../../shared/permission-types';
import { isExpired } from '../../shared/announcement';
import type { SyncWarning } from '../../main/sync-state';
import { deriveWarningSeverity } from '../state/sync-display-state';
import { type WidgetId, type SessionRuntime, type RelevanceContext, widgetApplies, widgetUnavailableReason } from '../state/status-widgets';
import { FastIcon } from './Icons';
import UpdatePanel from './UpdatePanel';
import ContextPopup from './ContextPopup';
import OpenTasksChip from './OpenTasksChip';
import { isAndroid } from '../platform';
import { SessionTagsChip } from './tags/SessionTagsChip';
import SpecialistsChip from './SpecialistsChip';
import { AnchorTip, Dialog, Tooltip } from './ui';
import { resolveModelBrand, type ProviderIconKey } from './provider-brand';
import { ProviderIcon } from './ProviderIcon';
import type { SessionTotals } from '../state/session-totals';
import { selectCacheReuse, selectReuseDisplay } from '../state/cache-reuse';
import { CLAUDE_ALIASES, CLAUDE_ALIAS_LABELS, type ClaudeAlias } from '../../shared/model-ids';
import { formatTime12, formatDayLong, formatMonthDay } from '../../shared/time-format';
import { usableOtherWindows, windowLengthLabel } from './plan-windows';

// --- Session stats shape (written by statusline.sh to .session-stats-{id}.json) ---

interface SessionStats {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  contextTokens: number | null;
  duration: number | null;       // seconds (converted from ms in statusline.sh)
  apiDuration: number | null;    // seconds (converted from ms in statusline.sh)
  linesAdded: number | null;
  linesRemoved: number | null;
}

interface StatusData {
  usage: {
    five_hour?: { utilization: number; resets_at: string };
    seven_day?: { utilization: number; resets_at: string };
    /** Plan windows of any other length, with their length in minutes (a free
     *  ChatGPT plan has one 30-day window and nothing else — W-2 = a). */
    other?: Array<{ utilization: number; resets_at: string; minutes: number }>;
  } | null;
  updateStatus: {
    current: string;
    latest: string;
    update_available: boolean;
    download_url: string | null;
  } | null;
  announcement: { message: string; expires?: string | null } | null;
  contextPercent: number | null;
  gitBranch: string | null;
  sessionStats: SessionStats | null;
  syncWarnings: SyncWarning[] | null;
}

// Model aliases sent to the CC CLI via `/model <alias>`. Canonical list lives
// in shared/model-ids.ts alongside claudeAliasForModelId, the alias→transcript
// matcher every surface now shares; re-exported here because this module has
// been the import site for both since before the shared module existed.
// Labels are model-class only (no version numbers) by design.
const MODELS = CLAUDE_ALIASES;
type ModelAlias = ClaudeAlias;

const MODEL_DISPLAY: Record<ModelAlias | 'unknown', { label: string; color: string; border: string; icon?: ProviderIconKey }> = {
  // Restyle: chips now use the standard `bg-panel` surface (set via className
  // in the JSX, not here) like every other status-bar chip, with brand-colored
  // TEXT + a matching tinted BORDER.
  // CC sessions use the official Claude Code CLI mascot and adaptive brand token.
  sonnet:      { label: CLAUDE_ALIAS_LABELS.sonnet,     color: 'var(--brand-claude)', border: 'color-mix(in srgb, var(--brand-claude) 35%, transparent)',  icon: 'claudecode' },
  'opus[1m]':  { label: CLAUDE_ALIAS_LABELS['opus[1m]'], color: 'var(--brand-claude)', border: 'color-mix(in srgb, var(--brand-claude) 35%, transparent)',  icon: 'claudecode' },
  haiku:       { label: CLAUDE_ALIAS_LABELS.haiku,      color: 'var(--brand-claude)', border: 'color-mix(in srgb, var(--brand-claude) 35%, transparent)',  icon: 'claudecode' },
  // Fable 5 — most capable. Fuchsia text keeps it as the top/premium tier,
  // distinct from the Anthropic-orange aliases and the amber reserved for AUTO.
  fable:       { label: CLAUDE_ALIAS_LABELS.fable,      color: '#E879F9', border: 'rgba(232,121,249,0.35)',  icon: 'claudecode' },
  // Error state, not a real model — red like the high-danger usage threshold
  // (utilizationColor/contextColor) so it reads as "wrong", never as a normal pill.
  unknown:     { label: 'Model Unknown', color: '#DD4444', border: 'rgba(221,68,68,0.3)' },
};

/**
 * What the model chip should render. A display-only union — see the `model`
 * prop comment for why native models are NOT folded into ModelAlias.
 *  - 'alias'   Claude Code session on a recognized model
 *  - 'native'  native-runtime session; label is a prettified SessionInfo.model
 *  - 'unknown' Claude Code session whose model couldn't be confirmed (error)
 */
export type ModelChip =
  | { kind: 'alias'; alias: ModelAlias }
  | { kind: 'native'; label: string; modelId: string }
  | { kind: 'unknown' };

/** MODEL_DISPLAY row for the two Claude Code chip states. */
function ccChipDisplay(model: Exclude<ModelChip, { kind: 'native' }>) {
  return MODEL_DISPLAY[model.kind === 'unknown' ? 'unknown' : model.alias];
}

/**
 * Native chip style. Resolves a brand color from the model id (and the
 * provider type as a fallback) so OpenAI models get OpenAI green, Claude
 * models get Anthropic orange, Qwen gets its purple, Google gets its blue,
 * and anything unrecognized falls back to --tag-blue (the old default).
 *
 * The style now uses `bg-panel` (set via className in the JSX, same as the
 * CC alias chips and every other status-bar chip) with brand-colored text +
 * a matching tinted border. The old transparent-tint background is gone.
 */
function nativeChipStyle(modelId: string, providerType?: string | null): {
  color: string;
  borderColor: string;
  icon?: ProviderIconKey;
} {
  const brand = resolveModelBrand(modelId, providerType);
  if (brand) {
    return {
      color: brand.color,
      borderColor: `color-mix(in srgb, ${brand.color} 35%, transparent)`,
      icon: brand.icon,
    };
  }
  // Fallback: the old --tag-blue default for unrecognized models.
  const fallback = 'var(--tag-blue)';
  return {
    color: fallback,
    borderColor: `color-mix(in srgb, ${fallback} 35%, transparent)`,
  };
}

// Amber (#F2B33D) for AUTO matches CC's own banner color and visually sits
// between 'auto-accept' (theme accent, mostly safe) and 'bypass' (salmon, no
// safety checks) — increasing autonomy = warmer color.
// Keyed by both CC's PermissionMode and the native runtime's NativePermissionMode.
// The two unions share no string values, so one map serves both; App decides
// which value (and which cycle handler) to pass based on the session's provider.
// Native labels are plain words (no glyphs — standing user preference) and reuse
// the same "increasing autonomy = warmer color" convention: ask ≈ normal (muted),
// auto-edit ≈ auto-accept (accent, mostly safe), full-auto = amber (autonomous,
// but still deny-list-guarded so not the salmon reserved for CC's bypass).
// Exported: ToolCard's full-auto safety-stop footer paints with the SAME chip
// colors, so the band and the status-bar chip can never drift apart.
export const PERMISSION_DISPLAY: Record<PermissionMode | NativePermissionMode | 'unknown', { label: string; shortLabel: string; color: string; bg: string; border: string }> = {
  normal:        { label: 'NORMAL',             shortLabel: 'NORMAL',  color: 'var(--fg-muted)', bg: 'var(--panel)', border: 'var(--edge-dim)' },
  'auto-accept': { label: 'ACCEPT CHANGES',     shortLabel: 'ACCEPT',  color: 'var(--accent)',   bg: 'var(--panel)', border: 'var(--edge)' },
  plan:          { label: 'PLAN MODE',           shortLabel: 'PLAN',    color: 'var(--fg-2)',     bg: 'var(--panel)', border: 'var(--edge)' },
  auto:          { label: 'AUTO MODE',           shortLabel: 'AUTO',    color: 'var(--status-auto)', bg: 'var(--panel)', border: 'color-mix(in srgb, var(--status-auto) 35%, transparent)' },
  bypass:        { label: 'BYPASS PERMISSIONS',  shortLabel: 'BYPASS',  color: 'var(--status-bypass)', bg: 'var(--panel)', border: 'color-mix(in srgb, var(--status-bypass) 35%, transparent)' },
  // Native runtime modes (Task 13).
  ask:           { label: 'ASK FIRST',          shortLabel: 'ASK',     color: 'var(--fg-muted)', bg: 'var(--panel)', border: 'var(--edge-dim)' },
  'auto-edit':   { label: 'AUTO EDIT',          shortLabel: 'EDIT',    color: 'var(--accent)',   bg: 'var(--panel)', border: 'var(--edge)' },
  'full-auto':   { label: 'FULL AUTO',          shortLabel: 'FULL',    color: 'var(--status-auto)', bg: 'var(--panel)', border: 'color-mix(in srgb, var(--status-auto) 35%, transparent)' },
  // Error state — App.tsx passes this when the real mode can't be confirmed
  // (unrecognized value, missing data on resume/reconnect) rather than guessing
  // 'normal'/'ask', which would misrepresent what's actually enforced.
  unknown:       { label: 'PERMISSION UNKNOWN',  shortLabel: 'UNKNOWN', color: '#DD4444', bg: 'var(--panel)', border: 'rgba(221,68,68,0.3)' },
};

// --- Native (local-model) StatusBar chips (Task 12) ---
// Native-runtime sessions have no CC statusline writing .usage-cache.json, so
// their context/tokens/speed chips are derived directly from the per-turn usage
// stamped on turn-complete (see chat-reducer TRANSCRIPT_TURN_COMPLETE). This is
// a small PURE function so the derivation is unit-tested in isolation.
//
// v1 limitation (spec decision 7): chips reflect the LAST COMPLETED turn, not
// mid-turn progress — during a long agentic turn the context chip lags until the
// turn completes. Mid-turn liveness is a deliberate follow-up, not this task.

/** Usage payload shape the selector accepts. Superset-tolerant: only in/out
 *  tokens are required; tokensPerSecond + cache fields are optional so both the
 *  full turn-complete payload and a trimmed test fixture satisfy it. */
export interface NativeUsageInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  tokensPerSecond?: number;
  /** How full the window is: the LAST step's prompt + its output. Distinct from
   *  inputTokens, which sums every step and so re-counts history once per step.
   *  Absent on records written before 2026-07-28. */
  contextUsedTokens?: number;
}

export interface NativeStatusChips {
  /** Percent of the model's context window REMAINING (100 = empty, 0 = full).
   *  null when the real context window is unknown — the other chips still show. */
  contextPct: number | null;
  /** Tokens OCCUPYING the window (what the pill shows in "tokens" mode). */
  contextUsedTokens: number;
  inputTokens: number;
  outputTokens: number;
  tokensPerSecond: number;
  /** Cache tokens for the Cached/Hit chips. null (NOT 0) when the provider sent
   *  none — 0 reads is a real 0% hit rate and must render as such, while absent
   *  must stay '--'. Collapsing the two would invent a statistic. */
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

/** Derive the native context/in/out/speed chips from a turn's usage + the
 *  session's REAL context window (resolved in main, Task 4/5). Returns null when
 *  there's no usage yet so CC / idle sessions render nothing extra. */
export function selectNativeStatusChips(
  usage: NativeUsageInput | undefined | null,
  contextLength: number | undefined | null,
): NativeStatusChips | null {
  if (!usage) return null;
  const tokensPerSecond = usage.tokensPerSecond ?? 0;
  // Fix: the gauge asks "how close is the user to filling the window?", which is
  // OCCUPANCY — the last prompt plus its reply. It used to sum in+out across
  // every step of the turn, which both re-counted history per step AND reset to
  // near-zero each turn (Destin, 2026-07-28). Older records carry no
  // contextUsedTokens; the in+out sum is the closest thing they have.
  const contextUsedTokens = usage.contextUsedTokens ?? (usage.inputTokens + usage.outputTokens);
  // contextPct is REMAINING context. Falsy contextLength (unknown window) → null
  // so we never fabricate a percentage; the token + speed chips remain valid.
  let contextPct: number | null = null;
  if (contextLength) {
    const remaining = Math.round(((contextLength - contextUsedTokens) / contextLength) * 100);
    contextPct = Math.max(0, Math.min(100, remaining)); // clamp to [0,100]
  }
  return {
    contextPct,
    contextUsedTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    tokensPerSecond,
    // ?? null, not ?? 0 — see the field docs. The harness ships these on every
    // turn-complete; they were simply never read on the way to the chips.
    cacheReadTokens: usage.cacheReadTokens ?? null,
    cacheCreationTokens: usage.cacheCreationTokens ?? null,
  };
}

function utilizationColor(pct: number): string {
  if (pct >= 80) return 'text-[#DD4444]';
  if (pct >= 50) return 'text-[#FF9800]';
  return 'text-[#4CAF50]';
}

function contextColor(pct: number): string {
  if (pct < 20) return 'text-[#DD4444]';
  if (pct < 50) return 'text-[#FF9800]';
  return 'text-[#4CAF50]';
}

// formatTime12 / formatDayLong moved to shared/time-format.ts (2026-09-05) so
// the ChatGPT limit card formats its reset with the SAME hand-rolled clock as
// these chips — it used to call toLocaleTimeString, which prints "18:43" on a
// UK/EU machine while the chip beside it said "6:43pm". Chip output unchanged.

function format5hReset(iso: string): string {
  try {
    const d = new Date(iso);
    return `Resets @ ${formatTime12(d)}`;
  } catch {
    return '';
  }
}

function format7dReset(iso: string): string {
  try {
    const d = new Date(iso);
    return `Resets ${formatDayLong(d)} @ ${formatTime12(d)}`;
  } catch {
    return '';
  }
}

/** The reset line for a window of any length (words deck W-2 = a): shorter
 *  than a day reads like the 5h chip (time only); up to a week reads like the
 *  7d chip (weekday and time); longer than a week — the free ChatGPT plan's
 *  30-day window — names the month and day, since a weekday alone is
 *  ambiguous over a month ("Resets Oct 3 @ 6:43pm", the limit card's form). */
function formatWindowReset(minutes: number, iso: string): string {
  if (minutes < 1440) return format5hReset(iso);
  if (minutes <= 7 * 1440) return format7dReset(iso);
  try {
    const d = new Date(iso);
    return `Resets ${formatMonthDay(d)} @ ${formatTime12(d)}`;
  } catch {
    return '';
  }
}

/** One plan-window chip — "5h: 42% Resets @ 6:43pm". Exactly the markup the
 *  5h and 7d chips have always had, lifted into one function so the odd-length
 *  windows (W-2 = a) draw the same way without a third copy. */
function UsageChip({ label, utilization, reset, onClick, title }: {
  label: string; utilization: number; reset: string; onClick: () => void; title: string;
}) {
  return (
    <Tooltip text={title}>
    <button
      onClick={onClick}
      className="flex items-center gap-1 sm:gap-1.5 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim cursor-pointer hover:bg-inset transition-colors"
    >
      <span>{label}:</span>
      <span className={utilizationColor(utilization)}>
        {utilization}%
      </span>
      <span className="text-fg-muted hidden sm:inline">{reset}</span>
    </button>
    </Tooltip>
  );
}

/** Format token count as human-readable (e.g. 1234 -> "1.2k", 1234567 -> "1.2M") */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

/** What the context pill renders, for a given display mode. `value` is the part
 *  that carries the color band; `suffix` is the trailing word (empty in tokens
 *  mode, where "35.2k / 64k" already reads as a quantity).
 *
 *  WHY this is pure + exported: the two callers below (the Claude Code chip and
 *  the native chip) must render IDENTICALLY for the same inputs — they are the
 *  same conceptual pill fed from different sources. Keeping the decision here
 *  instead of inline in both branches is what stops them drifting apart, and
 *  lets the formatting be tested without mounting a StatusBar.
 *
 *  The color is ALWAYS derived from `pct` by the caller, in both modes, so
 *  switching display never changes what green/amber/red mean.
 *
 *  Falls back to percent whenever the token figures aren't both known — a pill
 *  reading "null / null" (or a blank) would be worse than the percentage the
 *  user already trusts. */
export function formatContextPill(
  pct: number,
  usedTokens: number | null | undefined,
  windowTokens: number | null | undefined,
  mode: ContextDisplay,
): { value: string; suffix: string } {
  if (mode === 'tokens' && usedTokens != null && windowTokens != null && windowTokens > 0) {
    return { value: `${formatTokens(usedTokens)} / ${formatTokens(windowTokens)}`, suffix: '' };
  }
  return { value: `${pct}%`, suffix: 'Remaining' };
}

/** Tokens CONSUMED, derived from a percent-remaining reading and the window size.
 *  Used by the Claude Code chip, which is told the window and the percentage but
 *  never the raw used count (statusline.sh exposes `context_window_size` +
 *  `contextPercent`, not consumption). The native chip does NOT use this — it has
 *  a real measured used-token count and passes that straight through.
 *
 *  Necessarily APPROXIMATE: `pct` arrives already rounded to a whole number, so
 *  the result carries up to half a percent of the window as error. Fine for a
 *  glanceable pill; do not reuse it anywhere a token count must be exact. */
export function derivedUsedTokens(pct: number, windowTokens: number | null | undefined): number | null {
  if (windowTokens == null || windowTokens <= 0) return null;
  const clamped = Math.max(0, Math.min(100, pct));
  return Math.round(windowTokens * (1 - clamped / 100));
}

/** Format seconds as human-readable duration (e.g. 125 -> "2m 5s", 3700 -> "1h 1m") */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

interface Props {
  statusData: StatusData;
  onRunSync?: () => void;
  onOpenSync?: () => void;
  // Display-only view of the session's model. 'unknown' renders a distinct
  // error-styled chip — App.tsx passes it whenever it can't confidently
  // determine a CLAUDE CODE session's real model (unrecognized model id,
  // missing/invalid data on resume or reconnect) instead of silently guessing a
  // default, which would misrepresent what's actually running.
  //
  // Native-runtime sessions never reach 'unknown': their bound model id is
  // authoritative on SessionInfo.model, so App passes {kind:'native'} with a
  // label. Keeping this a display-only union (rather than widening ModelAlias)
  // is deliberate — ModelAlias also drives cycleModel, the `auto` permission
  // gate, and the persisted model preference, none of which a third-party
  // model id may leak into.
  model?: ModelChip;
  /** Native sessions only: the provider type from ProviderType (e.g. 'openai',
   *  'anthropic', 'openrouter', 'local-engine'). Used by the model chip to
   *  auto-detect the brand color when the model id alone is ambiguous. Unused
   *  for CC sessions (they use MODEL_DISPLAY keyed on the alias). */
  modelProviderType?: string | null;
  /** Whose windows `statusData.usage` holds. 'chatgpt' (a native session bound
   *  to a Sign-in-with-ChatGPT provider, 2026-09-04) un-hides the two usage
   *  chips that are otherwise Claude-Code-only and points them at Model
   *  Providers instead of claude.ai. Absent → 'claude'. */
  usagePlan?: 'claude' | 'chatgpt';
  /** The session's runtime. Gates the two Claude-subscription chips and the
   *  Fast toggle — see status-widgets.ts. Absent → treated as 'claude', so a
   *  caller that hasn't been wired yet hides nothing (spec §11). */
  provider?: SessionRuntime;
  // No onCycleModel: the model chip opens the picker (onOpenModelPicker) and
  // click-to-cycle now lives on Shift+Space in App.tsx. The prop was still declared
  // and passed but never called, so it read as a working affordance that did nothing.
  // CC sessions pass a PermissionMode; native sessions pass a NativePermissionMode.
  // The chip renders identically for both — only the value + cycle handler differ.
  permissionMode?: PermissionMode | NativePermissionMode | 'unknown';
  onCyclePermission?: () => void;
  // Fast + effort state and opener. When non-default, chips render next to the model
  // chip. Clicking either (or the model chip directly) opens the ModelPickerPopup.
  fast?: boolean;
  effort?: string;
  onOpenModelPicker?: () => void;
  // Context popup: session and a dispatcher wrapper threaded from App.tsx.
  sessionId?: string | null;
  onDispatch?: (input: string) => void;
  /** Open-tasks counts for the chip — derived at App root from a single
   *  useSessionTasks instance so the chip and popup share inactiveMap state. */
  openTasksCounts?: { running: number; pending: number };
  /** Fired when the user clicks the Open Tasks chip. */
  onOpenOpenTasks?: () => void;
  /** Native-runtime sessions only (Task 12): the active session's most-recent
   *  turn-complete usage. null/absent for CC + idle sessions (chips stay hidden). */
  nativeUsage?: NativeUsageInput | null;
  /** Native-runtime sessions only: the session's REAL context window (resolved in
   *  main, Task 4/5) carried on the same usage payload. null when unknown → the
   *  context % chip is omitted but tokens + speed still render. */
  nativeContextLength?: number | null;
  /** Completed turns carrying usage, saturating at 2 (any provider). Lets the
   *  reuse chip say "New" on a session's first turn instead of a red 0%, which
   *  is the same number meaning two very different things. Absent → treated as
   *  a first turn, so an unwired caller errs toward the calm reading. */
  turnsWithUsage?: 0 | 1 | 2;
  /** Native sessions only: session-so-far totals (spec §2) — tokens, cost and
   *  edited lines, specialists included. Absent for CC sessions, which take the
   *  same numbers from the statusline instead. */
  nativeTotals?: SessionTotals | null;
}


const warnStyles = {
  danger: 'bg-[#DD4444]/15 text-[#DD4444] border-[#DD4444]/25',
  warn: 'bg-[#FF9800]/15 text-[#FF9800] border-[#FF9800]/25',
};

// --- Widget visibility system ---

// Widget categories and definitions with info tooltips
// defaultVisible: true = shown for new installs, false = opt-in only
interface WidgetDef {
  id: WidgetId;
  label: string;
  defaultVisible: boolean;
  locked?: boolean;     // core control — always on, non-toggleable in the config menu
  description: string;  // Shown in (i) tooltip in config popup
  bestFor: string;      // Who benefits most from this widget
}

interface WidgetCategory {
  name: string;
  widgets: WidgetDef[];
}

const WIDGET_CATEGORIES: WidgetCategory[] = [
  {
    name: 'Rate Limits',
    widgets: [
      {
        id: 'usage-5h',
        label: '5h Usage',
        defaultVisible: true,
        description: 'Shows how much of your 5-hour rate limit you\'ve used. Resets on a rolling window.',
        bestFor: 'Everyone. Helps you pace usage and avoid hitting rate limits during heavy sessions.',
      },
      {
        id: 'usage-7d',
        label: '7d Usage',
        defaultVisible: true,
        description: 'Shows how much of your 7-day rate limit you\'ve used. Resets on a rolling window.',
        bestFor: 'Everyone. Track your weekly usage pattern so you don\'t run out mid-week.',
      },
    ],
  },
  {
    name: 'Session',
    widgets: [
      {
        id: 'session-tags',
        label: 'Tags & Note',
        defaultVisible: true,
        locked: true,
        description: 'Tag the current session and attach a freeform note. Always shown next to the model and permission controls.',
        bestFor: 'Everyone. Organize and annotate sessions so they\'re easy to find and resume later.',
      },
      {
        id: 'context',
        label: 'Context %',
        defaultVisible: true,
        description: 'How much of Claude\'s conversation memory remains. Lower means Claude may forget earlier context.',
        bestFor: 'Everyone. When this drops below 20%, consider starting a new session to avoid lost context.',
      },
      {
        id: 'session-cost',
        label: 'Session Cost',
        defaultVisible: false,
        description: 'Estimated cost of this session in USD. For Pro/Max subscribers this is informational only (you\'re not billed per-token).',
        bestFor: 'API users tracking spend. Also useful for Pro/Max users curious about what their session would cost on the API.',
      },
      {
        id: 'session-time',
        label: 'Session Duration',
        defaultVisible: false,
        description: 'Total session time and how much of it Claude spent thinking (API time). Helps you understand your workflow pace.',
        bestFor: 'Power users who want to see how much of a session is active Claude work vs your own thinking/typing time.',
      },
      {
        id: 'active-ratio',
        label: 'Active Ratio',
        defaultVisible: false,
        description: 'What percentage of the session was Claude actively thinking (API time / wall time). Low means you\'re mostly reading; high means Claude is doing heavy lifting.',
        bestFor: 'Understanding your workflow rhythm. A 5% ratio on a long session means you\'re mostly reviewing; 50%+ means Claude is cranking.',
      },
    ],
  },
  {
    name: 'Tokens',
    widgets: [
      {
        id: 'tokens-in',
        label: 'Input Tokens',
        defaultVisible: false,
        description: 'Cumulative input tokens sent to Claude this session. Includes your messages, files, and system context.',
        bestFor: 'Power users monitoring how much context is being sent. Helpful for optimizing large-file workflows.',
      },
      {
        id: 'tokens-out',
        label: 'Output Tokens',
        defaultVisible: false,
        description: 'Cumulative output tokens Claude has generated this session. Higher means more verbose responses.',
        bestFor: 'Users who want to understand how much Claude is writing. Useful for gauging response verbosity.',
      },
      {
        id: 'cache-stats',
        label: 'Cache Efficiency',
        defaultVisible: false,
        description: 'Tokens read from the prompt cache vs created. Higher cached reads mean faster, cheaper requests.',
        bestFor: 'API users and power users. Shows how effectively prompt caching is working in your conversation.',
      },
      {
        // The id stays 'cache-hit-rate' on purpose — it is the persisted key for
        // everyone who already turned this chip on. Only what it MEASURES and
        // what it is CALLED changed; renaming the id would silently reset them.
        id: 'cache-hit-rate',
        label: 'Context Reuse',
        defaultVisible: false,
        description: 'How much of each prompt was reused from cache instead of re-read. Reused context is cheaper and much faster.',
        bestFor: 'Long conversations. A sudden drop means the cache stopped working — usually an idle gap, or a change of model.',
      },
      {
        id: 'output-speed',
        label: 'Output Speed',
        defaultVisible: false,
        description: 'Average output tokens per second across the session. Varies by model — Haiku is fastest, Opus is slowest.',
        bestFor: 'Comparing model performance. Useful when deciding whether to switch models for faster iteration.',
      },
    ],
  },
  {
    name: 'Code',
    widgets: [
      {
        id: 'code-changes',
        label: 'Code Changes',
        defaultVisible: false,
        description: 'Lines of code added and removed this session. A quick productivity snapshot.',
        bestFor: 'Developers using Claude for coding tasks. See at a glance how much code Claude has written.',
      },
      {
        id: 'git-branch',
        label: 'Git Branch',
        defaultVisible: true,
        description: 'The current git repository and branch for your working directory.',
        bestFor: 'Developers working across multiple branches or repos.',
      },
    ],
  },
  {
    name: 'Tasks',
    widgets: [
      {
        id: 'open-tasks',
        label: 'Open Tasks',
        defaultVisible: true,
        description: 'Chip showing tasks Claude is tracking in the current session (running + pending counts). Hides when there are no open tasks. Click to see the full list.',
        bestFor: 'Everyone who uses sessions where Claude juggles multiple tasks. Lets you see what\'s in flight without scrolling the chat.',
      },
    ],
  },
  {
    name: 'App',
    widgets: [
      {
        id: 'sync-warnings',
        label: 'Sync Warnings',
        defaultVisible: true,
        description: 'Alerts when sync isn\'t working (no internet, stale data, unsynced skills).',
        bestFor: 'YouCoded toolkit users. Keeps you aware of sync issues that could cause data loss.',
      },
      {
        id: 'theme',
        label: 'Theme',
        defaultVisible: true,
        description: 'Shows the active theme. Click to cycle through your configured themes.',
        bestFor: 'Anyone who uses multiple themes or wants quick access to theme switching.',
      },
      {
        id: 'version',
        label: 'Version',
        defaultVisible: true,
        description: 'Current YouCoded version. Glows when an update is available.',
        bestFor: 'Everyone. Stay up to date with the latest features and fixes.',
      },
    ],
  },
  {
    name: 'Updates',
    widgets: [
      {
        id: 'announcement',
        label: 'Announcement',
        defaultVisible: true,
        description: 'Platform announcements from the YouCoded team — new releases, outages, tips. Pulled every hour from the announcement cache.',
        bestFor: 'Everyone. Hides automatically when there is no active announcement.',
      },
    ],
  },
];

// Flat list for iteration
const ALL_WIDGET_DEFS = WIDGET_CATEGORIES.flatMap((c) => c.widgets);
const DEFAULT_VISIBLE = new Set<WidgetId>(ALL_WIDGET_DEFS.filter((w) => w.defaultVisible).map((w) => w.id));

const STORAGE_KEY = 'youcoded-statusbar-widgets';

function loadVisibility(): Set<WidgetId> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const arr = JSON.parse(stored) as WidgetId[];
      // Only keep IDs that still exist in our definitions
      return new Set(arr.filter((id) => ALL_WIDGET_DEFS.some((w) => w.id === id)));
    }
  } catch { /* ignore */ }
  // Fresh install — use defaultVisible flags, not ALL
  return new Set(DEFAULT_VISIBLE);
}

function saveVisibility(visible: Set<WidgetId>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...visible]));
  } catch { /* ignore */ }
}

function useWidgetVisibility() {
  const [visible, setVisible] = useState<Set<WidgetId>>(loadVisibility);

  const toggle = useCallback((id: WidgetId) => {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveVisibility(next);
      return next;
    });
  }, []);

  return { visible, toggle };
}

// --- Icons ---

// Pencil SVG icon (inline to avoid extra dependencies)
function PencilIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M12.146.854a.5.5 0 0 1 .708 0l2.292 2.292a.5.5 0 0 1 0 .708l-9.5 9.5a.5.5 0 0 1-.168.11l-4 1.5a.5.5 0 0 1-.638-.638l1.5-4a.5.5 0 0 1 .11-.168l9.5-9.5zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5z"/>
    </svg>
  );
}

// Info (i) icon for widget descriptions
function InfoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
      <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
    </svg>
  );
}


// --- Config Popup ---
// Centered modal (matches SettingsPanel popup style) for customizing status bar widgets

function WidgetConfigPopup({ open, onClose, visible, toggle, relevance }: {
  open: boolean;
  onClose: () => void;
  visible: Set<WidgetId>;
  toggle: (id: WidgetId) => void;
  /** What this session can actually show — the SAME values the bar itself
   *  gates on, so the menu can never offer a chip the bar refuses to draw. */
  relevance: RelevanceContext;
}) {
  useEscClose(open, onClose);
  // Track which widget's (i) tooltip is expanded
  const [expandedInfo, setExpandedInfo] = useState<WidgetId | null>(null);
  // Track whether the Theme widget's cycle editor is expanded. Separate from
  // expandedInfo because the cycle editor is Theme-specific and collapses the
  // info panel when opened (and vice-versa) — they're mutually exclusive rows.
  const [cycleEditorOpen, setCycleEditorOpen] = useState(false);
  // Theme list + cycle membership come from the theme context, consumed here
  // so the Theme pill's cycle can be edited without leaving the widget popup.
  const { allThemes, cycleList, setCycleList } = useTheme();
  // Scroll-fade: hide scrollbar, fade edges to signal hidden scroll room.

  if (!open) return null;

  const toggleCycle = (slug: string) => {
    if (cycleList.includes(slug)) {
      // Keep at least one theme in the cycle — otherwise the pill has nothing to rotate to.
      const next = cycleList.filter(s => s !== slug);
      if (next.length > 0) setCycleList(next);
    } else {
      setCycleList([...cycleList, slug]);
    }
  };

  return createPortal(
    <>
      {/* This popup already used the outer-flex-wrapper centering that Dialog
          now owns -- it was one of the two places that had independently
          discovered transform centering breaks a bounded scroll region. Its
          "No flex-1" workaround is gone too: that was needed because its body
          was a bare overflow-y-auto div with no min-height:0, which .scroll-fade
          supplies. */}
      <Dialog open onClose={onClose} title="Status Bar Widgets" size="panel">
            {WIDGET_CATEGORIES.map((cat) => (
              <section key={cat.name}>
                <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2">
                  {cat.name}
                </h3>
                <div className="space-y-0.5">
                  {cat.widgets.map((w) => {
                    const isExpanded = expandedInfo === w.id;
                    const isThemeRow = w.id === 'theme';
                    const showCycleEditor = isThemeRow && cycleEditorOpen;
                    const reason = widgetUnavailableReason(w.id, relevance);
                    return (
                      <div key={w.id}>
                        <div className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-inset transition-colors">
                          {/* Toggle checkbox — locked widgets (fixed controls)
                              render always-checked and non-interactive. When the
                              widget doesn't apply to this session's runtime,
                              swap the button for a plain, non-focusable row: it
                              is not a control here, so it must not look or
                              behave like one. The saved on/off choice is
                              untouched and returns when the user switches to a
                              session where the widget applies. */}
                          {reason ? (
                            /* Label on its own line, reason on the line beneath
                               it. WHY not side by side (how this used to read):
                               a long reason squeezed the label and wrapped
                               "Session Duration" onto two lines, so that one row
                               stood taller than every other row in the menu.
                               Stacked, each part gets a full line and every
                               dimmed row is the same height. The empty spacer
                               keeps the label's left edge on the same x as the
                               enabled rows, whose labels sit after a checkbox. */
                            <div className="flex items-start gap-2 flex-1 text-left opacity-50">
                              <span className="w-3.5 h-3.5 flex-shrink-0" />
                              <div className="flex-1 min-w-0">
                                <div className="text-2xs text-fg">{w.label}</div>
                                <div className="text-3xs text-fg-muted italic">{reason}</div>
                              </div>
                            </div>
                          ) : (
                          <button
                            onClick={() => { if (!w.locked) toggle(w.id); }}
                            disabled={w.locked}
                            className={`flex items-center gap-2 flex-1 text-left ${w.locked ? 'cursor-default' : ''}`}
                          >
                            <span
                              className={`w-3.5 h-3.5 rounded-sm border flex-shrink-0 flex items-center justify-center transition-colors ${
                                (w.locked || visible.has(w.id))
                                  ? 'bg-accent border-accent text-on-accent'
                                  : 'border-edge-dim'
                              }`}
                            >
                              {(w.locked || visible.has(w.id)) && (
                                <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor">
                                  <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z" />
                                </svg>
                              )}
                            </span>
                            <span className="text-2xs text-fg">{w.label}</span>
                            {w.locked && <span className="text-4xs text-fg-muted">always on</span>}
                          </button>
                          )}

                          {/* Pencil — Theme widget only. Opens the cycle editor
                              (which themes the pill rotates through). Moved here
                              from per-card checkmarks in the Appearance popup.
                              Gated on !reason too (belt-and-braces: 'theme' never
                              gets a reason today, but a dimmed row must never
                              carry a focusable element, full stop). */}
                          {isThemeRow && !reason && (
                            <Tooltip text="Edit theme cycle">
                            <button
                              onClick={() => {
                                setCycleEditorOpen(v => !v);
                                setExpandedInfo(null);
                              }}
                              className={`flex-shrink-0 p-0.5 rounded-sm transition-colors ${
                                showCycleEditor ? 'text-accent' : 'text-fg-faint hover:text-fg-muted'
                              }`}
                              aria-label="Edit theme cycle"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                              </svg>
                            </button>
                            </Tooltip>
                          )}

                          {/* (i) info toggle — hidden for a dimmed row. The row
                              already isn't a control (it's just explained why),
                              and the reason line itself is the info; a second
                              focusable element here would be the same defect as
                              leaving the checkbox tabbable. */}
                          {!reason && (
                            <Tooltip text="More info">
                            <button
                              onClick={() => {
                                setExpandedInfo(isExpanded ? null : w.id);
                                if (isThemeRow) setCycleEditorOpen(false);
                              }}
                              className={`flex-shrink-0 p-0.5 rounded-sm transition-colors ${
                                isExpanded ? 'text-accent' : 'text-fg-faint hover:text-fg-muted'
                              }`}
                            >
                              <InfoIcon />
                            </button>
                            </Tooltip>
                          )}
                        </div>

                        {/* Expanded info panel */}
                        {isExpanded && (
                          <div className="ml-7 mr-2 mb-1.5 px-2.5 py-2 rounded-md bg-inset border border-edge-dim text-3xs space-y-1.5">
                            <p className="text-fg-dim leading-relaxed">{w.description}</p>
                            <p className="text-fg-muted leading-relaxed">
                              <span className="font-medium text-fg-muted">Best for:</span> {w.bestFor}
                            </p>
                          </div>
                        )}

                        {/* Theme cycle editor — inline, mirrors the info-panel layout.
                            Tapping the theme pill in the status bar rotates through
                            every theme checked here. Must keep ≥1 in the cycle. */}
                        {showCycleEditor && (
                          <div className="ml-7 mr-2 mb-1.5 px-2.5 py-2 rounded-md bg-inset border border-edge-dim text-3xs space-y-1.5">
                            <p className="text-fg-dim leading-relaxed">
                              Pick which themes the pill rotates through when you tap it.
                            </p>
                            <div className="space-y-0.5 pt-1">
                              {allThemes.map(t => {
                                const inCycle = cycleList.includes(t.slug);
                                const isOnly = inCycle && cycleList.length === 1;
                                return (
                                  <Tooltip key={t.slug} text={isOnly ? 'At least one theme must stay in the cycle' : ''}>
                                  <button
                                    onClick={() => toggleCycle(t.slug)}
                                    disabled={isOnly}
                                    className={`flex items-center gap-2 w-full px-1.5 py-1 rounded-sm text-left transition-colors ${
                                      isOnly ? 'opacity-50 cursor-not-allowed' : 'hover:bg-panel'
                                    }`}
                                  >
                                    <span
                                      className={`w-3 h-3 rounded-sm border flex-shrink-0 flex items-center justify-center transition-colors ${
                                        inCycle ? 'bg-accent border-accent text-on-accent' : 'border-edge-dim'
                                      }`}
                                    >
                                      {inCycle && (
                                        <svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor">
                                          <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z" />
                                        </svg>
                                      )}
                                    </span>
                                    <span
                                      className="w-2.5 h-2.5 rounded-full flex-shrink-0 border border-edge-dim"
                                      style={{ background: `linear-gradient(135deg, ${t.tokens.canvas}, ${t.tokens.accent})` }}
                                    />
                                    <span className="text-fg truncate">{t.name}</span>
                                  </button>
                                  </Tooltip>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
      </Dialog>
    </>,
    document.body
  );
}

// --- Main StatusBar component ---

// One vocabulary for every session-scoped chip (spec §2). Repeated wording is
// the point: three chips and the /usage card must not each invent their own
// description of the same scope.
const SCOPE_NOTE = 'Counts this session so far, including specialists.';
// One money formatter for the cost chip AND its tooltip. WHY shared: toFixed(2)
// rounds anything under half a cent to "$0.00", and a bar (or a tooltip) that
// reads "$0.00" while money is being spent reads as broken — spec §5 forbids
// that false zero. Extracted when the tooltip gained a second figure (the
// specialist split): two call sites formatting money two different ways is how
// a chip and its own tooltip end up disagreeing.
const formatCostUsd = (usd: number) => (usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`);

const INPUT_NOTE = 'Input is counted per request — a long turn re-sends its history each step, and that is what you are billed for.';

export default function StatusBar({
  statusData, onRunSync, onOpenSync, model, modelProviderType, provider, usagePlan,
  permissionMode, onCyclePermission, fast, effort, onOpenModelPicker,
  sessionId, onDispatch,
  openTasksCounts, onOpenOpenTasks,
  nativeUsage, nativeContextLength, turnsWithUsage, nativeTotals,
}: Props) {
  const { usage, updateStatus, contextPercent, gitBranch, sessionStats, syncWarnings } = statusData;

  // Dev-instance label (run-dev.sh --label → preload's devLabel). Read here rather
  // than at module scope because the remote shim assigns window.claude during
  // bootstrap, which can run after this module is imported. null in the built app
  // and on remote/Android, so this renders nothing there.
  const devLabel = window.claude?.devLabel ?? null;
  const { activeTheme, cycleTheme, contextDisplay } = useTheme();
  const { visible, toggle } = useWidgetVisibility();
  const [popupOpen, setPopupOpen] = useState(false);
  // Version pill now opens the in-app UpdatePanel (changelog + update action) instead of firing external URLs.
  const [updatePanelOpen, setUpdatePanelOpen] = useState(false);
  const [contextPopupOpen, setContextPopupOpen] = useState(false);

  // Runtime gate (spec §3, Rule 2): a widget that belongs to the OTHER runtime
  // never renders here, whatever the user's saved on/off choice says. The choice
  // itself is untouched and returns the moment they switch back.
  const runtime: SessionRuntime = provider ?? 'claude';
  // A ChatGPT-plan session HAS rolling windows, so the two chips the runtime
  // gate reserves for Claude Code apply again — fed with the ChatGPT windows
  // App put in `usage` for exactly this session.
  const chatgptWindows = usagePlan === 'chatgpt';
  const show = (id: WidgetId) => visible.has(id)
    && (widgetApplies(id, runtime) || (chatgptWindows && (id === 'usage-5h' || id === 'usage-7d')));
  // Where a usage chip goes when clicked: the Claude account page, or — for a
  // ChatGPT plan — the Model Providers row that shows the plan and its windows.
  const openUsage = () => chatgptWindows
    ? window.dispatchEvent(new CustomEvent('youcoded:open-model-providers'))
    : window.claude.shell.openExternal('https://claude.ai/settings/usage');
  const usageTitle = chatgptWindows ? 'Your ChatGPT plan — click to open Model Providers' : 'View usage on claude.ai';
  const ss = sessionStats; // shorthand

  // Native-runtime chips (Task 12). Non-null only for native sessions that have
  // completed at least one turn; CC/idle sessions get null and render nothing
  // extra. Fed the session's real context window (resolved in main) so the
  // context % is accurate for the local model, not a hardcoded guess.
  const nativeChips = selectNativeStatusChips(nativeUsage, nativeContextLength);

  // In/Out are SESSION TOTALS for both runtimes. They used to come from the last
  // completed turn, which made one label mean two different measurements
  // depending on the runtime — the defect this change exists to remove
  // (spec §6). Totals include specialists; input is counted per request,
  // because that is what a provider bills for.
  //
  // Fix (2026-09-03): the precedence used to put the statusline FIRST. That was
  // the bug — the statusline's numbers are one request's, so Out: read 713 on a
  // 42-hour session and In: showed a single prompt. `nativeTotals` is now fed
  // for Claude Code sessions too and is a genuine per-request sum for both
  // runtimes, so it goes first and the statusline is no longer consulted for
  // tokens at all. Cost, duration and line counts still come from `ss`: those
  // ARE session totals (Claude Code's `cost.*` block accumulates; only its
  // `context_window.*` block does not).
  //
  // "Has anything been measured yet?" is ONE question with ONE answer, asked of
  // inputTokens: every request a provider bills has a prompt, so inputTokens > 0
  // exactly when at least one turn has been counted. Asking it per-field is what
  // the old code did, and it could not tell a cold prompt cache (a real reading
  // of 0 cache reads, which is common and must render) from a session that has
  // not run a turn (nothing to say, so no chip). Now a zero in any OTHER field
  // is always a real measurement and always renders.
  const measured = !!nativeTotals && nativeTotals.inputTokens > 0;
  const totalTokens = (v: number | undefined) => (measured ? v ?? null : null);
  const inTokens = totalTokens(nativeTotals?.inputTokens);
  const outTokens = totalTokens(nativeTotals?.outputTokens);
  // Cached/Reuse get the identical treatment: CC's statusline first (real
  // measurement, 0 included), then session totals for native (0 -> null,
  // nothing measured yet) — never the last-turn nativeChips, which would
  // blend "this session so far" and "the last turn" under one label again.
  const cacheReadTotal = totalTokens(nativeTotals?.cacheReadTokens);
  const cacheCreationTotal = totalTokens(nativeTotals?.cacheCreationTokens);
  // Speed had the identical problem: a CC chip stuck at "--" for native sessions
  // beside a native chip that duplicated it AND ignored show('output-speed'), so
  // hiding Speed in settings didn't hide it. CC derives it from the statusline's
  // apiDuration; native's provider already reports tokens/sec on turn-complete.
  //
  // Fix (2026-09-03): the Claude Code side divided `ss.outputTokens` by
  // `ss.apiDuration` — one REQUEST's output over the WHOLE SESSION's API time,
  // two different scopes either side of the slash. It rounded to 0 on every
  // real session measured (3 tokens / 55.7s, 3,495 / 7,269s), so the chip was a
  // constant zero. Both halves now come from the session: its summed output
  // tokens over its summed API seconds, which is an honest average. Native
  // keeps its provider-reported last-turn rate; the tooltip says which is which
  // rather than letting one label quietly cover two measurements.
  const speedTokPerSec = outTokens != null && ss?.apiDuration != null && ss.apiDuration > 0
    ? Math.round(outTokens / ss.apiDuration)
    : nativeChips?.tokensPerSecond ?? null;
  const speedIsSessionAverage = outTokens != null && ss?.apiDuration != null && ss.apiDuration > 0;

  return (
    <div className="status-bar flex flex-wrap items-center gap-x-2 gap-y-1 px-2 sm:px-3 py-1 text-3xs text-fg-muted">
      {/* Combined model + effort pill — clicking opens the full picker (same as /effort).
         Shift+Space still cycles models via the keyboard shortcut in App.tsx.

         Restyle: the chip now uses the standard `bg-panel border-edge-dim` surface
         (same as usage/theme/version chips) with brand-colored TEXT + matching tinted
         BORDER. Native chips auto-detect the brand from the model id/provider type. */}
      {model && (model.kind === 'native' ? (
        // Native runtime: the bound model id IS the truth, so this chip never
        // shows an error state. The full id goes in the title because the label
        // is a best-effort prettification (and CSS-truncated when long).
        (() => {
          const nStyle = nativeChipStyle(model.modelId, modelProviderType);
          return (
            <Tooltip text={`${model.modelId} — click to change model`}>
            <button
              onClick={onOpenModelPicker}
              className="flex items-center gap-1.5 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim cursor-pointer hover:border-edge hover:bg-inset transition-colors max-w-[14rem] truncate"
              style={{ color: nStyle.color, borderColor: nStyle.borderColor }}
            >
              {/* No effort segment: /effort and MAX_EFFORT_MODELS are Claude Code
                  concepts the native harness doesn't implement.
                  min-w-0 is load-bearing: a flex child defaults to min-width:auto
                  and won't shrink below its content, so `truncate` alone would let
                  a long GGUF name blow past the button's max-w instead of eliding. */}
              {nStyle.icon && <ProviderIcon icon={nStyle.icon} className="flex-shrink-0" />}
              <span className="truncate min-w-0">{model.label}</span>
            </button>
            </Tooltip>
          );
        })()
      ) : (
        (() => {
          const display = ccChipDisplay(model);
          return (
            <Tooltip text={model.kind === 'unknown'
              ? "YouCoded couldn't confirm which model this session is using — click to set one explicitly"
              : 'Click to change model and effort (Shift+Space cycles model)'}>
            <button
              onClick={onOpenModelPicker}
              className="flex items-center gap-1.5 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim cursor-pointer hover:border-edge hover:bg-inset transition-colors"
              style={{ color: display.color, borderColor: display.border }}
            >
              {display.icon && <ProviderIcon icon={display.icon} className="flex-shrink-0" />}
              <span>{display.label}</span>
              {model.kind !== 'unknown' && (
                <>
                  <span className="opacity-40">|</span>
                  <span className="capitalize">{effort || 'auto'} Effort</span>
                </>
              )}
            </button>
            </Tooltip>
          );
        })()
      ))}

      {/* Fast mode is a Claude Code toggle read from the app-wide model-modes
          file — nothing in a native session honours it, so rendering it there
          is a control that lies (spec §1). Not a registry widget, so it takes
          the runtime gate directly rather than going through show(). */}
      {fast && runtime === 'claude' && (
        <Tooltip text="Fast mode on — click to configure">
        <button
          onClick={onOpenModelPicker}
          className="flex items-center px-1.5 py-0.5 rounded-sm border border-yellow-500/40 bg-yellow-500/15 text-yellow-500 cursor-pointer hover:brightness-125 transition-colors"
          aria-label="Fast mode on"
        >
          <FastIcon className="w-3 h-3" />
        </button>
        </Tooltip>
      )}

      {/* Permission mode chip — always second */}
      {permissionMode && (
        <Tooltip text={permissionMode === 'unknown'
          ? "YouCoded couldn't confirm this session's permission mode — click to set one explicitly"
          : 'Click to cycle permission mode (Shift+Tab)'}>
        <button
          onClick={onCyclePermission}
          className="px-1.5 py-0.5 rounded-sm border cursor-pointer hover:brightness-125 transition-colors"
          style={{
            backgroundColor: PERMISSION_DISPLAY[permissionMode].bg,
            color: PERMISSION_DISPLAY[permissionMode].color,
            borderColor: PERMISSION_DISPLAY[permissionMode].border,
          }}
        >
          <span className="sm:hidden">{PERMISSION_DISPLAY[permissionMode].shortLabel}</span>
          <span className="hidden sm:inline">{PERMISSION_DISPLAY[permissionMode].label}</span>
        </button>
        </Tooltip>
      )}

      {/* Session tags & note — fixed control (design §"In-session surface").
          Hidden on Android (touch UI deferred); shown on desktop + remote. */}
      {!isAndroid() && <SessionTagsChip sessionId={sessionId ?? null} />}

      {/* Open Tasks chip — hidden when 0 open OR when widget is toggled off.
          Counts are derived at App root to share one useSessionTasks instance
          with the popup; two instances would have separate inactiveMap state
          that don't sync within the same page. */}
      {show('open-tasks') && openTasksCounts && onOpenOpenTasks && (
        <OpenTasksChip
          running={openTasksCounts.running}
          pending={openTasksCounts.pending}
          onOpen={onOpenOpenTasks}
        />
      )}

      {/* Specialists (1c) — hidden when the conversation has no helpers. */}
      <SpecialistsChip sessionId={sessionId} />

      {/* Rate limits — one chip per window the plan reports, in the order
          5h, 7d, then any other length (W-2 = a: a free ChatGPT plan shows a
          single "30d:" chip). A plan with no windows shows no chips. The chip
          markup is one recipe (UsageChip) so the approved 5h/7d output is
          byte-identical to before — pinned in plan-windows-other.test.tsx. */}
      {show('usage-5h') && usage?.five_hour != null && (
        <UsageChip label="5h" utilization={usage.five_hour.utilization}
          reset={format5hReset(usage.five_hour.resets_at)} onClick={openUsage} title={usageTitle} />
      )}
      {show('usage-7d') && usage?.seven_day != null && (
        <UsageChip label="7d" utilization={usage.seven_day.utilization}
          reset={format7dReset(usage.seven_day.resets_at)} onClick={openUsage} title={usageTitle} />
      )}
      {/* Odd-length windows ride on the Customize toggle of the approved chip
          they most resemble: a multi-day window follows "7d Usage", a
          sub-day one follows "5h Usage" — there is no per-length toggle. */}
      {usableOtherWindows(usage?.other).map((w, i) => (
        show(w.minutes >= 1440 ? 'usage-7d' : 'usage-5h') ? (
          <UsageChip key={`${w.minutes}-${i}`} label={windowLengthLabel(w.minutes)} utilization={w.utilization}
            reset={formatWindowReset(w.minutes, w.resets_at)} onClick={openUsage} title={usageTitle} />
        ) : null
      ))}

      {/* Context remaining — clickable opens ContextPopup (compact/clear actions + explainer).
          Renders as a percentage or as "used / window" per the contextDisplay pref;
          the aria-label always states the percentage so the accessible name stays
          stable and meaningful regardless of the visual mode. */}
      {show('context') && contextPercent != null && (() => {
        const pill = formatContextPill(
          contextPercent,
          derivedUsedTokens(contextPercent, sessionStats?.contextTokens),
          sessionStats?.contextTokens,
          contextDisplay,
        );
        return (
          <button
            onClick={() => setContextPopupOpen(true)}
            aria-haspopup="dialog"
            aria-label={`Context: ${contextPercent}% remaining. Click to manage context.`}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim cursor-pointer hover:border-edge hover:bg-inset transition-colors"
          >
            <span>Context:</span>
            <span className={contextColor(contextPercent)}>{pill.value}</span>
            {pill.suffix && <span>{pill.suffix}</span>}
          </button>
        );
      })()}

      {/* Native-runtime context chip (Task 12) — derived from the local model's
          last turn-complete usage. Tokens and speed no longer render here: they
          feed the shared In:/Out:/Speed: chips further down, which are otherwise
          dead in native sessions (nothing writes the CC statusline).
          The CC context chip above renders from `contextPercent`, which is always
          null for native sessions (they write no .context-* file), so there is no
          duplicate context chip. Reuses the exact CC chip markup — no restyle.

          v1 limitation: values reflect the LAST COMPLETED turn, so during a long
          agentic turn the context chip lags until the turn finishes (spec #7). */}
      {nativeChips && (
        <>
          {/* Context remaining — reuses the CC context chip's visual style. Not a
              button: the CC version opens ContextPopup (CC-only /compact + /clear
              actions); native compaction is engine-driven, so this is display-only. */}
          {show('context') && nativeChips.contextPct != null && (() => {
            // Native passes its MEASURED used-token count straight through — unlike
            // the CC chip above, which has to derive "used" from a rounded percent.
            const pill = formatContextPill(
              nativeChips.contextPct,
              nativeChips.contextUsedTokens,
              nativeContextLength,
              contextDisplay,
            );
            return (
              // Clickable since M3 item 2 (Destin's request, 2026-07-25). It was
              // deliberately a plain <span> while the popup's only two actions —
              // Compact and Clear — had no native implementation and would have
              // been dead buttons. Both are real now, so this opens the SAME
              // ContextPopup the Claude Code chip does.
              <Tooltip text={`Context: ${nativeChips.contextPct}% of the model's window remaining${
                  nativeContextLength ? ` (${nativeChips.contextUsedTokens.toLocaleString()} of ${nativeContextLength.toLocaleString()} tokens used)` : ''
                }`}>
              <button
                onClick={() => setContextPopupOpen(true)}
                aria-haspopup="dialog"
                aria-label={`Context: ${nativeChips.contextPct}% remaining. Click to manage context.`}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim cursor-pointer hover:border-edge hover:bg-inset transition-colors"
              >
                <span>Context:</span>
                <span className={contextColor(nativeChips.contextPct)}>{pill.value}</span>
                {pill.suffix && <span>{pill.suffix}</span>}
              </button>
              </Tooltip>
            );
          })()}

          {/* No "Tokens" or "Speed" chip here — native in/out/speed feed the
              shared In:/Out:/Speed: chips below (see the inTokens/outTokens/
              speedTokPerSec derivations), so each concept has exactly one chip
              and each honors its own show() toggle. */}
        </>
      )}

      {/* Session cost.
          CC sessions show Claude Code's own figure. Native sessions show the
          sum of per-turn costs priced in main, specialists included.
          The chip renders only when SOME counted work had a published price —
          not when "the session's model is metered": a free local session that
          delegated to an OpenRouter specialist really is spending money
          (spec §5). Nothing priced → no chip, never "$0.00". */}
      {show('session-cost') && (() => {
        const ccCost = ss?.costUsd ?? null;
        const nativeCost = nativeTotals?.anyPriced ? nativeTotals.costUsd : null;
        const cost = ccCost ?? nativeCost;
        if (cost == null) {
          // NEW branch (checkpoint #3). Nothing could be priced — but WHY not
          // has two opposite answers, and until now the bar gave the same
          // silent chipless row for both (verified with `magick compare`: the
          // local and unpriced review scenarios were pixel-identical). One of
          // those two is quietly spending the user's money.
          //   - anyUnpriced: the provider DOES bill, we just have no published
          //     rate for this model → say so, dimmed. Reaching here means
          //     nothing was priced at all, because a single priced turn would
          //     have made `cost` a real number above and won this slot.
          //   - anyFree only (a local model), or nothing measured at all →
          //     render nothing, exactly as before. Destin declined a "Free"
          //     chip (checkpoint #2); silence stays the answer there.
          if (ccCost == null && nativeTotals?.anyUnpriced) {
            return (
              <span
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
                // "available", not "published" (Task 22): the price lookup
                // returns nothing for ANY model missing from the catalog, and
                // a catalog that never loaded (dead network, empty cache)
                // looks identical to a model that genuinely has no rate.
                // Saying "no price is published" asserts a cause nobody
                // checked — docs/error-message-standards.md forbids that.
              >
                <span className="text-fg-muted">Cost:</span>
                {/* Muted, not accent-coloured: this is an ABSENCE of a figure,
                    not an alert. Same treatment as the Reuse chip's "New". */}
                <span className="text-fg-muted">not listed</span>
                <AnchorTip label="Why there is no cost figure" placement="top">
                  <p>{"This provider bills for usage, but no price is available for this model here, so the session cost can't be totalled."}</p>
                </AnchorTip>
              </span>
            );
          }
          return null;
        }
        // WHY the sub-cent guard (formatCostUsd): toFixed(2) rounds any real
        // cost under half a cent down to "$0.00", and a bar that reads "$0.00"
        // while money is actually being spent reads as broken — it's the false
        // zero spec §5 forbids ("Never $0.00"). The first turn of a native
        // session on a cheap metered model is a few hundred tokens ≈ $0.0004,
        // so this is the COMMON first thing a user sees, not an edge case. A
        // cost that is above zero but below a cent renders "<$0.01"; an exact
        // zero isn't a rounding artifact at all and takes the no-chip path
        // above, same as "nothing was priced".
        if (cost <= 0) return null;
        const partial = ccCost == null && nativeTotals?.anyUnpriced;
        // Checkpoint #4 — name where the money came from. Only on the NATIVE
        // figure: a Claude Code session's cost is Claude Code's own total, and
        // this app's specialist accounting is no part of it, so attributing a
        // slice of it here would be a claim we cannot back.
        const specialistCost = ccCost == null ? (nativeTotals?.specialistCostUsd ?? 0) : 0;
        const specialistRuns = ccCost == null ? (nativeTotals?.specialistRuns ?? 0) : 0;
        const title = ccCost != null
          ? 'Estimated cost of this session, as counted by Claude Code.'
          : `${SCOPE_NOTE} Priced from published rates, prompt-cache discounts included.`
            // Task 24 — "available", not "published". The price lookup returns
            // nothing both for a model that genuinely has no rate and for a
            // catalog that never loaded (dead network, empty cache), and the two
            // are indistinguishable here, so claiming nothing was PUBLISHED
            // states a cause nobody checked (docs/error-message-standards.md).
            // Byte-identical to UsageCard's PARTIAL_NOTE on purpose — the bar and
            // the card describe the same total, so they must word it the same way.
            + (partial ? ' Models with no available price are not included in this total.' : '')
            // The count is dropped rather than printed as "0 specialists" if
            // the two numbers ever disagree — a wrong sentence is worse than a
            // missing one (docs/error-message-standards.md).
            + (specialistCost > 0 && specialistRuns > 0
              ? ` ${formatCostUsd(specialistCost)} of this was spent by ${specialistRuns} specialist${specialistRuns === 1 ? '' : 's'} this session delegated to.`
              : '')
            + ' Not exact — a few models charge more above very large prompts.';
        return (
          <span
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
          >
            <span className="text-fg-muted">Cost:</span>
            <span className="text-fg-2">{formatCostUsd(cost)}</span>
            {/* Shown only when the session actually delegated: most never do,
                and this bar is already crowded. */}
            {specialistCost > 0 && <span className="text-fg-muted">· specialists</span>}
            <AnchorTip label="What the cost figure includes" placement="top">
              <p>{title}</p>
            </AnchorTip>
          </span>
        );
      })()}

      {/* Session duration — wall time and API thinking time.
          Rule 1 (spec §3): no value, no chip. This used to render a literal
          '--' — forever in a native session, where the statusline that feeds
          it never runs, and briefly in a CC session before the first stats
          arrive. An empty chip is furniture that teaches the user to ignore
          the bar. */}
      {show('session-time') && ss?.duration != null && (
        <Tooltip text={ss.apiDuration != null ? `Wall: ${formatDuration(ss.duration)} | API: ${formatDuration(ss.apiDuration)}` : 'Session duration'}>
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
        >
          <span>{formatDuration(ss.duration)}</span>
          {ss.apiDuration != null && (
            <span className="text-fg-muted hidden sm:inline">({formatDuration(ss.apiDuration)} API)</span>
          )}
        </span>
        </Tooltip>
      )}

      {/* Input tokens. Rule 1 (spec §3): no value, no chip. In a native session
          this is a SESSION TOTAL (nativeTotals), not the last turn — see the
          inTokens derivation above (spec §6). Fix: the chip's DISPLAYED value
          stays formatTokens' abbreviated "12.3k" — a session total compounds
          across many turns and grows well past the point where a raw digit
          string is glanceable, which is exactly why the abbreviation exists.
          The exact count moves to the tooltip instead, where there's room.
          Gate is `!= null`, not truthy: a native zero is already collapsed to
          null above (nothing measured yet, since createSessionChatState()
          seeds a brand-new native session's totals at emptyTotals() — all
          ZERO), so `!= null` correctly hides it — but a REAL statusline
          measurement of 0 input tokens must still render, and a truthy check
          would wrongly swallow it too. */}
      {show('tokens-in') && inTokens != null && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
        >
          <span className="text-fg-muted">In:</span>
          <span className="text-fg-2">{formatTokens(inTokens)}</span>
          <AnchorTip label="What the In figure counts" placement="top">
            <p>{`Input tokens: ${inTokens.toLocaleString()}. ${SCOPE_NOTE} ${INPUT_NOTE}`}</p>
          </AnchorTip>
        </span>
      )}

      {/* Output tokens. Rule 1 (spec §3): no value, no chip. Session total for
          native (spec §6); see the In chip above for why this stays
          abbreviated with the exact count in the tooltip.
          Gate is `!= null`, not falsy: `measured` above has already turned
          "no turn counted yet" into null, so a 0 reaching here is a real
          measurement (a turn that produced no output) and must render. */}
      {show('tokens-out') && outTokens != null && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
        >
          <span className="text-fg-muted">Out:</span>
          <span className="text-fg-2">{formatTokens(outTokens)}</span>
          <AnchorTip label="What the Out figure counts" placement="top">
            <p>{`Output tokens: ${outTokens.toLocaleString()}. ${SCOPE_NOTE}`}</p>
          </AnchorTip>
        </span>
      )}

      {/* Cache efficiency. WHY the ?? nativeTotals fallback: sessionStats is written
          by Claude Code's statusline, which native sessions never run — so these two
          chips sat at '--' forever while the harness shipped the numbers on every
          turn-complete. Native reads SESSION TOTALS here (spec §6), not the last
          turn — same reasoning as In/Out above.
          cr/cc are resolved ONCE so the title, the value and the hit-rate math can
          never disagree about which source they came from.
          Rule 1 (spec §3): no value, no chip — bail before rendering.
          Bail on null, not on falsy: a native zero is already collapsed to
          null above (a brand-new native session's cache totals start at 0,
          indistinguishable from "no turn has run yet to read from cache"),
          so bailing on null hides that case correctly — but a statusline 0
          (a real cold or expired prompt cache genuinely reading 0 cached
          tokens, which is common) is a measured value and must still render;
          bailing on falsy would wrongly hide that real 0 too. */}
      {show('cache-stats') && (() => {
        const cr = cacheReadTotal;
        if (cr == null) return null;
        const cc = cacheCreationTotal;
        return (
          <span
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
          >
            <span className="text-fg-muted">Cached:</span>
            <span className="text-[#4CAF50]">{formatTokens(cr)}</span>
            <AnchorTip label="What the Cached figure counts" placement="top">
              <p>{`Cache read: ${cr.toLocaleString()} | Cache created: ${(cc ?? 0).toLocaleString()}. ${SCOPE_NOTE}`}</p>
            </AnchorTip>
          </span>
        );
      })()}

      {/* Context reuse — how much of the prompt came from cache instead of being
          re-read. See selectCacheReuse for why this is NOT reads/(reads+writes).
          Session total for native (spec §6): reads nativeTotals, not the last
          turn's nativeChips, so this stops meaning something different from the
          In/Out/Cached chips beside it.
          Rule 1 (spec §3): 'unknown' means no data to report — bail before
          rendering. 'first-turn' is a real, known state (nothing to reuse yet)
          and keeps rendering "New", same as before. */}
      {show('cache-hit-rate') && (() => {
        // Session totals only — passing `ss` here would make Reuse describe the
        // last request while In:/Out:/Cached: beside it describe the session.
        const reuse = selectCacheReuse(null, nativeTotals);
        const display = selectReuseDisplay(reuse, turnsWithUsage);
        if (display.kind === 'unknown') return null;
        const prompt = (reuse.promptTokens ?? 0).toLocaleString();
        // Always the session scope now — see the reuse source above.
        const usingTotals = nativeTotals != null;
        // Fix: zero reuse on a session TOTAL (as opposed to a single turn)
        // reads as an accusation — "Reused 0 of X" sounds like the cache is
        // broken, when it's just as likely nothing has been reused yet.
        // Reaching this branch already means promptTokens > 0 (selectCacheReuse
        // returns ratio: null, filtered above, whenever it isn't), so
        // readTokens === 0 here is a real "read fresh" measurement, not an
        // absent one — same friendlier framing the CC per-turn path already
        // uses for its own 0% case below.
        const title = usingTotals
          ? (reuse.readTokens === 0
            ? `None of this session's prompt tokens came from cache; all ${prompt} were read fresh. ${SCOPE_NOTE}`
            : `Reused ${(reuse.readTokens ?? 0).toLocaleString()} of this session's ${prompt} prompt tokens from cache. ${SCOPE_NOTE}`)
          : display.kind === 'first-turn'
          ? `Nothing to reuse yet — this is the session's first turn, so all ${prompt} prompt tokens were read fresh.`
          : display.pct === 0
            ? `None of this turn's prompt came from cache; all ${prompt} tokens were read fresh. Caches expire after a few minutes idle, and reset when the model or tool list changes.`
            : `Reused ${(reuse.readTokens ?? 0).toLocaleString()} of this turn's ${prompt} prompt tokens from cache — that part was cheaper and faster than re-reading it.`;
        return (
          <span
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
          >
            <span className="text-fg-muted">Reuse:</span>
            {display.kind === 'first-turn' && <span className="text-fg-muted">New</span>}
            {display.kind === 'percent' && (
              <span className={display.pct >= 80 ? 'text-[#4CAF50]' : display.pct >= 50 ? 'text-[#FF9800]' : 'text-[#DD4444]'}>
                {display.pct}%
              </span>
            )}
            <AnchorTip label="What the Reuse figure means" placement="top">
              <p>{title}</p>
            </AnchorTip>
          </span>
        );
      })()}

      {/* Active ratio — derived: apiDuration / duration. Rule 1 (spec §3): no
          value, no chip. */}
      {show('active-ratio') && ss?.duration != null && ss?.apiDuration != null && ss.duration > 0 && (
        <Tooltip text={`Claude thinking: ${formatDuration(ss.apiDuration)} of ${formatDuration(ss.duration)} total`}>
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
        >
          <span className="text-fg-muted">Active:</span>
          <span className="text-fg-2">
            {Math.round((ss.apiDuration / ss.duration) * 100)}%
          </span>
        </span>
        </Tooltip>
      )}

      {/* Output speed — derived: outputTokens / apiDuration. Rule 1 (spec §3):
          no value, no chip. Deliberately stays LAST-TURN for both runtimes (see
          the speedTokPerSec comment above) — never fed by nativeTotals.
          WHY the ternary's fallback branch is NOT dead: ss (sessionStats) is
          always null in a native session, so speedTokPerSec there falls back to
          nativeChips and this chip renders with the generic string below — do
          not "simplify" this back to one branch. */}
      {show('output-speed') && speedTokPerSec != null && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
        >
          <span className="text-fg-muted">Speed:</span>
          <span className="text-fg-2">
            {speedTokPerSec} tok/s
          </span>
          <AnchorTip label="What the Speed figure measures" placement="top">
            <p>{speedIsSessionAverage ? `${outTokens!.toLocaleString()} output tokens in ${formatDuration(ss!.apiDuration!)} of model time — this session's average, not its current speed.` : 'Output tokens per second on the last turn'}</p>
          </AnchorTip>
        </span>
      )}

      {/* Code changes — lines added/removed.
          CC sessions keep the statusline count: it is Claude Code's own number
          and covers edits made through ANY path, including shell commands.
          Native sessions use the derived count (structuredPatch hunks stored on
          tool calls AND on specialist segments). The two are not comparable
          across runtimes; each is the most complete number its runtime has.
          Nothing edited yet → the chip does not render. It used to say "No
          changes", which was FALSE in every native session (spec §1). */}
      {show('code-changes') && (() => {
        const added = ss?.linesAdded ?? nativeTotals?.linesAdded ?? null;
        const removed = ss?.linesRemoved ?? nativeTotals?.linesRemoved ?? null;
        if (!added && !removed) return null;
        const title = ss?.linesAdded != null
          ? `Lines added: ${added ?? 0} | Lines removed: ${removed ?? 0}`
          : `${SCOPE_NOTE} Counts edits made through the model's editing tools; edits made by shell commands are not counted.`;
        return (
          <span
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
          >
            <span className="text-[#4CAF50]">+{added ?? 0}</span>
            <span className="text-[#DD4444]">-{removed ?? 0}</span>
            <span className="text-fg-muted hidden sm:inline">lines</span>
            <AnchorTip label="What the line counts include" placement="top">
              <p>{title}</p>
            </AnchorTip>
          </span>
        );
      })()}

      {/* Git branch — reads from statusline.sh's .gitbranch-{sessionId} file */}
      {show('git-branch') && gitBranch && (
        <Tooltip text={`Git: ${gitBranch}`}>
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border"
          style={{ color: '#0D9488', borderColor: 'rgba(13,148,136,0.35)' }}
        >
          {/* Branch icon (octicon git-branch) */}
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
            <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/>
          </svg>
          <span>{gitBranch}</span>
        </span>
        </Tooltip>
      )}

      {/* The background restore-pull chip was removed in sync-legacy-demolition —
          there is no pull/restore path feeding it anymore. */}

      {/* Sync status pill — at most one badge total.
          Red "Sync Failing" for any danger-level warning,
          orange "Sync Warning" for warn-only,
          nothing when synced. Click opens the panel where the descriptive copy lives. */}
      {show('sync-warnings') && (() => {
        const handler = onOpenSync || onRunSync;
        const severity = deriveWarningSeverity(syncWarnings ?? []);
        if (severity === null) return null;
        const isFailing = severity === 'failing';
        const label = isFailing ? 'Sync Failing' : 'Sync Warning';
        const styleClass = isFailing ? warnStyles.danger : warnStyles.warn;
        return (
          <Tooltip text={isFailing ? 'Sync is failing — click for details' : 'Sync warnings — click for details'}>
          <button
            onClick={handler}
            className={`px-1.5 py-0.5 rounded-sm border text-4xs sm:text-3xs ${styleClass} ${handler ? 'cursor-pointer hover:brightness-125 transition-all' : ''}`}
          >
            {label}
          </button>
          </Tooltip>
        );
      })()}

      {/* Theme pill */}
      {show('theme') && (
        <Tooltip text="Click to cycle theme">
        <button
          onClick={cycleTheme}
          className="px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim cursor-pointer hover:bg-inset transition-colors"
        >
          {activeTheme.name}
        </button>
        </Tooltip>
      )}

      {/* Platform announcement — ★ orange pill, truncates long copy.
          Gate on isExpired so a stale cache entry (cleared remote but
          not yet re-fetched, or a date that rolled past midnight since
          last fetch) doesn't render. Defense-in-depth alongside the
          fetch-time filter in announcement-service.ts. */}
      {show('announcement') &&
        statusData.announcement?.message &&
        !isExpired(statusData.announcement.expires) && (
        <Tooltip text={statusData.announcement.message}>
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border truncate max-w-[280px]"
          style={{
            color: '#EA580C',
            borderColor: 'rgba(234,88,12,0.35)',
          }}
        >
          <span aria-hidden>★</span>
          <span className="truncate">{statusData.announcement.message}</span>
        </span>
        </Tooltip>
      )}

      {/* Version pill — shows YouCoded app version, glows yellow when update available.
         Click opens the in-app UpdatePanel (changelog + Update Now) — no more raw URL jumps. */}
      {show('version') && updateStatus && (
        <Tooltip text={
            (devLabel ? `Dev instance: ${devLabel} — ` : '') +
            (updateStatus.update_available
              ? `Update available: v${updateStatus.latest} — click to download`
              : `YouCoded v${updateStatus.current}`)
          }>
        <button
          onClick={() => setUpdatePanelOpen(true)}
          className={`px-1.5 py-0.5 rounded-sm border cursor-pointer transition-colors hidden sm:inline-flex ${
            updateStatus.update_available
              // steps(16): this glow runs from update-detection until the user
              // actually updates — days to weeks — in always-visible chrome, and
              // Reduced Effects does not gate it. Smooth ease-in-out means
              // presenting at the panel's full refresh rate for that entire
              // period (~29-33% of a core at 180Hz). 8 shadow changes/sec on a
              // soft 4->10px blur radius is imperceptible. See the "Perf:
              // frame-budget" note in globals.css.
              ? 'bg-[rgba(234,179,8,0.12)] border-[rgba(234,179,8,0.5)] hover:bg-[rgba(234,179,8,0.22)] animate-[version-glow_2s_steps(16)_infinite]'
              : 'bg-panel border-edge-dim hover:bg-inset'
          }`}
        >
          {updateStatus.update_available ? (
            <span className="text-[#EAB308] font-medium">
              v{updateStatus.latest} — Update Available
            </span>
          ) : (
            <span>v{updateStatus.current}</span>
          )}
          {/* Dev-instance label rides the version pill: it's the one always-visible
              chip that already identifies "which build am I looking at". Accent so
              it reads at a glance across a row of otherwise-muted chips. Dev only. */}
          {devLabel && (
            <span className="text-accent font-medium ml-1">· {devLabel}</span>
          )}
        </button>
        </Tooltip>
      )}

      {/* Customize widget — pencil icon opens config popup, always last */}
      <Tooltip text="Customize Status Bar">
      <button
        onClick={() => setPopupOpen(true)}
        className="ml-auto flex items-center justify-center w-5 h-5 rounded-sm bg-panel border border-edge-dim cursor-pointer hover:bg-inset transition-colors"
      >
        <PencilIcon />
      </button>
      </Tooltip>

      {/* Config popup — centered modal with grouped widgets + (i) info */}
      <WidgetConfigPopup
        open={popupOpen}
        onClose={() => setPopupOpen(false)}
        visible={visible}
        toggle={toggle}
        // anyUnpriced rides along because the bar draws a "Cost: not listed"
        // chip for it — the menu has to offer the row whenever the chip is up.
        relevance={{ runtime, hasPricedWork: nativeTotals?.anyPriced ?? true, anyUnpriced: nativeTotals?.anyUnpriced ?? false, runsLocally: nativeTotals?.anyFree ?? false }}
      />

      {/* Update panel — opened from the version pill. Guard on updateStatus
         since the pill is only rendered when it exists, but the mount lives outside that gate. */}
      {updateStatus && (
        <UpdatePanel
          open={updatePanelOpen}
          onClose={() => setUpdatePanelOpen(false)}
          updateStatus={updateStatus}
        />
      )}

      {/* Context popup — portal-rendered; position in tree is cosmetic. */}
      {/* Native sessions have their own numbers: the CC fields (contextPercent /
          sessionStats) are always null for them, because a native session writes
          no statusline file. Feed the harness-derived figures so the popup shows
          real values instead of "--" now that the native pill can open it. */}
      <ContextPopup
        open={contextPopupOpen}
        onClose={() => setContextPopupOpen(false)}
        sessionId={sessionId ?? null}
        contextPercent={contextPercent ?? nativeChips?.contextPct ?? null}
        contextTokens={sessionStats?.contextTokens ?? nativeContextLength ?? null}
        onDispatch={onDispatch ?? (() => {})}
      />
    </div>
  );
}

export { MODELS, type ModelAlias };
