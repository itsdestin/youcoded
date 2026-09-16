// src/renderer/state/usage-snapshot.ts
//
// Everything the /usage and /cost card is made of, in one pure function.
//
// WHY it lives here rather than in App.tsx: this derivation used to be a
// `useCallback` inside AppInner, and nothing tested it — no test imports
// App.tsx at all. A reviewer deleted the native-totals fallback (the entire
// point of the commit that added it) and all 5,820 tests stayed green, because
// only the card's PRESENTATION was guarded. The fallback is also load-bearing
// in a way the card cannot express: returning null here makes the slash-command
// dispatcher treat /usage as unhandled, so the literal text "/usage" is sent to
// the model as a chat message. Same reasoning, same shape as
// components/model-chip.ts — a derivation extracted out of AppInner precisely
// so it can be pinned without rendering App.
import { selectNativeStatusChips } from '../components/StatusBar';
import type { SessionTotals } from './session-totals';
import type { TurnUsage, UsageSnapshot } from './chat-types';

/** The Claude Code statusline's figures for one session. Minimal structural
 *  shape (like model-chip.ts's ModelChipSession) so this module needs neither
 *  App's private interface nor the IPC types. */
export interface StatuslineStats {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  contextTokens: number | null;
  duration: number | null;
  apiDuration: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
}

/** Account-wide Claude subscription utilization, as read from the usage cache. */
export interface SubscriptionUsage {
  five_hour?: { utilization: number; resets_at: string };
  seven_day?: { utilization: number; resets_at: string };
  /** Windows that are neither 5 hours nor 7 days long, tagged with their
   *  length in minutes. Only the ChatGPT plan reports these today (a free
   *  account has ONE 30-day window and nothing else — Phase 0, 2026-09-05);
   *  Claude's cache never writes the key. Mirrors `ChatGptUsage.other`
   *  (shared/chatgpt-types.ts). Words deck W-2 = a: the screens draw each of
   *  these labelled by its real length, after the 5h and 7d bars. */
  other?: Array<{ utilization: number; resets_at: string; minutes: number }>;
}

/** Drop any usage window whose reset time has already passed.
 *
 *  WHY: ~/.claude/.usage-cache.json is now written only by statusline.sh while
 *  a Claude Code session is live (the old 5-minute background refresher read
 *  the user's OAuth token, which Anthropic forbids third-party apps from
 *  doing, so it was removed). Between sessions nothing refreshes the file, so
 *  without this an exhausted "5h 95%" bar from last night would still be
 *  showing this morning. Pruning on arrival covers every consumer — the status
 *  bar chips and the /usage card — on desktop, Android and remote browsers in
 *  one place. `now` is injectable for tests. */
export function pruneExpiredUsage(
  usage: SubscriptionUsage | null | undefined,
  now: number = Date.now(),
): SubscriptionUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const out: SubscriptionUsage = {};
  // One rule for every window: gone once its reset time is behind us; kept
  // when the reset is unknown or unparseable (guessing "expired" would hide a
  // real number).
  const live = (win: { utilization: number; resets_at: string } | null | undefined) => {
    if (!win || win.utilization == null) return false;
    const t = win.resets_at ? Date.parse(win.resets_at) : NaN;
    return !(Number.isFinite(t) && t <= now);
  };
  for (const key of ['five_hour', 'seven_day'] as const) {
    const win = usage[key];
    if (live(win)) out[key] = win!;
  }
  // The odd-length windows (W-2 = a) age out the same way; the key is dropped
  // outright when none survive so `other: []` never reads as "has windows".
  if (Array.isArray(usage.other)) {
    // Number.isFinite, not `typeof === 'number'`: NaN is a number, and a
    // window whose length failed to parse used to survive pruning and paint a
    // chip reading "NaNh".
    const rest = usage.other.filter((w) => w && Number.isFinite(w.minutes) && w.minutes > 0 && live(w));
    if (rest.length) out.other = rest;
  }
  return Object.keys(out).length ? out : null;
}

/** The bit of a session's chat state this derivation reads. */
export interface UsageSnapshotSession {
  timeline: ReadonlyArray<{ kind: string; turnId?: string }>;
  assistantTurns: ReadonlyMap<string, { usage?: TurnUsage | null }>;
  totals?: SessionTotals;
}

export interface UsageSnapshotInput {
  sessionId: string;
  /** When the snapshot was taken. Passed in rather than read from the clock so
   *  the result is a pure function of its inputs. */
  now: number;
  /** Claude Code's statusline figures, if it has written any. */
  stats: StatuslineStats | null | undefined;
  /** Claude Code's context reading (percent REMAINING), if any. */
  contextPercent: number | null;
  usage: SubscriptionUsage | null;
  /** Which plan `usage` belongs to. Absent → 'claude' (every caller before
   *  Sign in with ChatGPT). App picks the ChatGPT windows for a session bound
   *  to a 'chatgpt' provider (hooks/use-provider-type.ts). */
  subscriptionPlan?: 'claude' | 'chatgpt';
  /** True for a YouCoded-runtime session. Gates every native fallback below. */
  isNative: boolean;
  session: UsageSnapshotSession | undefined;
}

/** The most recent completed assistant turn's usage, walking backward.
 *  Mirrors hooks/useNativeSessionUsage — the status bar's source for the same
 *  numbers — so the bar and the card cannot read different turns. */
export function lastTurnUsage(session: UsageSnapshotSession | undefined): TurnUsage | null {
  if (!session) return null;
  for (let i = session.timeline.length - 1; i >= 0; i--) {
    const entry = session.timeline[i];
    if (entry.kind !== 'assistant-turn' || !entry.turnId) continue;
    const usage = session.assistantTurns.get(entry.turnId)?.usage;
    if (usage) return usage;
  }
  return null;
}

/**
 * Freeze the session's live figures into the point-in-time snapshot /usage and
 * /cost render. Returns null when there is genuinely nothing to describe —
 * the statusline hook runs after each command, so a brand-new Claude Code
 * session may have no data for a few seconds.
 */
export function buildUsageSnapshot(input: UsageSnapshotInput): UsageSnapshot | null {
  const { sessionId, now, stats, contextPercent: ctx, usage, isNative, session, subscriptionPlan } = input;

  // Native fallback (spec §10). The statusline is written by Claude Code, which
  // a native session never runs — so without this every session figure below
  // was null and /usage was a page of "--" in exactly the sessions the status
  // bar now sends people here for (it hides the 5h and 7d chips there, and the
  // Customize menu points at this card).
  //
  // Same precedence as the bar: the statusline wins where it exists, session
  // totals fill in where it doesn't, so the two surfaces cannot disagree about
  // the same session.
  //
  // Scoped to NATIVE sessions for exactly the same reason the bar scopes its
  // own totals that way (StatusBar.tsx: `useNativeSessionTotals(isNativeSession
  // ? sessionId : null)`). A Claude Code session's numbers are Claude Code's
  // own, and its line count in particular covers edits this app never sees
  // (shell commands); the derived count is a DIFFERENT measurement, so
  // substituting it under the same label would make the card contradict the bar.
  // Fix (2026-09-03): was gated on isNative. Claude Code turns accumulate into
  // session.totals too, and since the transcript watcher started summing every
  // request of a turn (not only its last), those totals are real — where the
  // statusline's token fields describe one request. Ungated so the card and the
  // status bar read the same numbers; see the matching note in App.tsx.
  const totals = session?.totals ?? null;
  // Context, from the same selector the status bar's native pill uses, fed the
  // same last-completed-turn usage. Two surfaces, one formula: a native session
  // at 61% used to show a pill on the bar and NO context row on the card.
  const nativeUsage = isNative ? lastTurnUsage(session) : null;
  const nativeChips = selectNativeStatusChips(nativeUsage, nativeUsage?.contextLength);

  // `totals` is now present for EVERY session (it used to be native-only), and
  // a brand-new session's is emptyTotals() — all zeros. Its mere existence is
  // therefore no longer evidence of anything, so the bail asks whether it has
  // actually recorded something. Without this, a Claude Code session that has
  // run no turn opens the card on a page of nulls.
  const totalsHaveContent = !!totals && (
    totals.inputTokens > 0 || totals.outputTokens > 0 || totals.costUsd > 0
    || totals.linesAdded > 0 || totals.linesRemoved > 0 || totals.specialistRuns > 0
    || totals.anyPriced || totals.anyUnpriced || totals.anyFree
  );
  // Native keeps the old rule — the harness OWNS a native session's numbers, so
  // its totals object existing is itself the signal to open the card, which then
  // reads "working but empty" rather than broken. For Claude Code the object now
  // exists from birth and says nothing on its own, so it has to have recorded
  // something first.
  const totalsCountAsPresent = isNative ? !!totals : totalsHaveContent;
  if (!stats && ctx == null && !usage && !totalsCountAsPresent) return null;

  // A brand-new native session starts at emptyTotals() — every field ZERO
  // before a single turn has run — so a zero here means "nothing measured yet",
  // not "measured zero", and must read as absent so the card omits the row
  // instead of printing a 0 it did not measure. A statusline zero is a REAL
  // measurement and is never collapsed (it wins via ?? below).
  // This mirrors StatusBar.tsx's inTokens/outTokens derivation exactly.
  //
  // Fix (2026-09-03): the per-field version of this could not tell a cold prompt
  // cache (a real reading of 0 cache reads) from a session that has run no turn.
  // "Has anything been counted?" is now asked ONCE, of inputTokens — every
  // billed request has a prompt, so inputTokens > 0 is exactly "at least one
  // turn counted". A zero in any other token field is then a real measurement
  // and passes through. Byte-for-byte the status bar's `measured` rule; the two
  // surfaces disagreeing about one session is the failure this mirrors away.
  const measured = !!totals && totals.inputTokens > 0;
  const fromTotals = (v: number | undefined) => (measured ? v ?? null : null);
  // Line counts keep the old per-field rule: they come from patch events, not
  // from a request, so inputTokens says nothing about whether they were seen.
  const fromTotalLines = (v: number | undefined) => (v != null && v > 0 ? v : null);

  return {
    entryId: `usage-${sessionId}-${now}`,
    timestamp: now,
    // anyPriced gate: work with no published price contributes nothing to
    // totals.costUsd, so showing that 0 would be a false zero — the card drops
    // the figure instead (docs/error-message-standards.md).
    costUsd: stats?.costUsd ?? (totals?.anyPriced ? totals.costUsd : null),
    // "Some counted work is METERED but has no published rate", which is NOT
    // the same as "free to run" (totals.anyFree) and must never be worded as one.
    costIsPartial: stats?.costUsd == null && !!totals?.anyUnpriced,
    countsFromSessionTotals: !stats && !!totals,
    specialistRuns: totals?.specialistRuns ?? 0,
    inputTokens: fromTotals(totals?.inputTokens),
    outputTokens: fromTotals(totals?.outputTokens),
    cacheReadTokens: fromTotals(totals?.cacheReadTokens),
    cacheCreationTokens: fromTotals(totals?.cacheCreationTokens),
    contextTokens: stats?.contextTokens ?? null,
    // Byte-for-byte the bar's own precedence (StatusBar.tsx's ContextPopup:
    // `contextPercent ?? nativeChips?.contextPct ?? null`). Written as one
    // expression on purpose — the bar and the card resolving context two
    // different ways is how they ended up disagreeing in the first place.
    contextPercent: ctx ?? nativeChips?.contextPct ?? null,
    // Deliberately NOT filled from totals: the harness does not report turn
    // wall-time or thinking-time at all (spec §15), so there is no native
    // number to fall back to. The card omits both rows rather than invent one.
    duration: stats?.duration ?? null,
    apiDuration: stats?.apiDuration ?? null,
    linesAdded: stats?.linesAdded ?? fromTotalLines(totals?.linesAdded),
    linesRemoved: stats?.linesRemoved ?? fromTotalLines(totals?.linesRemoved),
    fiveHourUtilization: usage?.five_hour?.utilization ?? null,
    fiveHourResetsAt: usage?.five_hour?.resets_at ?? null,
    sevenDayUtilization: usage?.seven_day?.utilization ?? null,
    sevenDayResetsAt: usage?.seven_day?.resets_at ?? null,
    // The plan's odd-length windows (a free ChatGPT plan's single 30-day one),
    // carried whole so the card can draw them after the two above. Left
    // undefined — not an empty list — when there are none, so every snapshot
    // built before this field existed compares equal to one built now.
    ...(usage?.other?.length ? { otherWindows: usage.other } : {}),
    subscriptionPlan: subscriptionPlan ?? 'claude',
  };
}
