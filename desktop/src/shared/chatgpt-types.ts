// Sign in with ChatGPT — the account state the renderer shows and the channels
// it calls. Shared between main and renderer; keep free of Node/Electron imports.
//
// Design: docs/active/design/2026-09-04-chatgpt-signin/ (workspace repo) and
// docs/active/investigations/2026-09-04-chatgpt-subscription-paths.md.
//
// WHY a state machine rather than a boolean: the sign-in is a browser round-trip
// the app does not control, so "waiting" is a real, visible state the user sits
// in for a while — the Settings row and the first-run screen both draw it.

import { formatTime12, formatDayLong, formatMonthDay } from './time-format';

/** Where a used-up ChatGPT plan sends the user to raise the window: OpenAI's
 *  own upgrade page, the URL the Codex CLI's own limit error names when it
 *  says "Upgrade to Pro (https://chatgpt.com/explore/pro)". The plan-limit
 *  card's "Upgrade plan" button opens this. */
export const CHATGPT_UPGRADE_URL = 'https://chatgpt.com/explore/pro';

/** One rolling usage window of the ChatGPT plan, as OpenAI reports it. Same
 *  shape as the Claude subscription windows (`SubscriptionUsage` in
 *  usage-snapshot.ts) on purpose, so the /usage card and the status-bar chips
 *  draw either plan with one recipe. */
export interface ChatGptUsageWindow { utilization: number; resets_at: string }

export interface ChatGptUsage {
  five_hour?: ChatGptUsageWindow;
  seven_day?: ChatGptUsageWindow;
  /** Windows that are neither 5 hours nor 7 days long, each tagged with its
   *  length in minutes. WHY this exists: Phase 0 (2026-09-05, a free account)
   *  showed OpenAI reports ONE 30-day window on the free plan and nothing
   *  else, so drawing only the two keys above would show two empty bars.
   *  The parser files anything that is not 300 or 10080 minutes here; whether
   *  the renderer draws these bars (labelled by length) or drops them is the
   *  words-deck W-2 decision, and `five_hour` / `seven_day` are untouched.
   *  The renderer's pruneExpiredUsage (state/usage-snapshot.ts) ages these
   *  out on the same rule as `five_hour` / `seven_day`. */
  other?: Array<ChatGptUsageWindow & { minutes: number }>;
}

export type ChatGptAccountStatus =
  | { state: 'signed-out' }
  /** The browser tab is open; we are waiting for OpenAI's callback. */
  | { state: 'waiting' }
  | {
      state: 'signed-in';
      email: string;
      /** OpenAI's plan name as reported at sign-in ('plus', 'pro', 'team', 'free', …).
       *  Free-form on purpose — OpenAI renames plans; the UI title-cases it. */
      plan: string;
      usage?: ChatGptUsage | null;
    }
  /** Signed in, but requests are refused — the specific reason OpenAI gave
   *  (a workspace admin disabled it, the plan has no Codex access, …). Per
   *  docs/error-message-standards.md the text is OpenAI's own, never a guess. */
  | { state: 'blocked'; email: string; reason: string };

/** The one sentence the provider layer emits when a plan window is exhausted.
 *  OpenAI answers with a specific `usage_limit_reached` code and a reset time,
 *  so this is specific-and-accurate per docs/error-message-standards.md — and
 *  the renderer's plan-limit card keys on it (isChatGptLimitMessage), the same
 *  way the provider-config bubble keys on "Settings → Providers".
 *
 *  `windowLabel` is whatever `windowLabel()` in main/providers/chatgpt-oauth.ts
 *  produced: '5-hour', 'weekly', or '<n>-day' (a free plan has one 30-day
 *  window — Phase 0, 2026-09-05). It used to be typed as just the first two;
 *  it is a plain string now so a window OpenAI adds later still reads as a
 *  sentence rather than failing to compile.
 *
 *  How the reset is written (words deck W-1, answer a, 2026-09-05):
 *  - 5-hour: the clock time only — "Resets @ 6:43pm". This is Destin's exact
 *    approved wording and must stay byte-identical.
 *  - weekly (and any window up to 7 days): the day too — "Resets Tuesday @
 *    6:43pm", because a clock time alone for a reset that is next Tuesday would
 *    have the user waiting until 6:43pm today. The day is SPELLED OUT to match
 *    the 7-day chip beside it: the W-1 deck showed "Tue" and said the chip
 *    already agreed, which was wrong — the chip has always said "Tuesday", and
 *    Destin chose the long form on 2026-09-05 rather than change a string every
 *    existing Claude subscriber already sees.
 *  - longer than 7 days (the free plan's 30-day window): month and day —
 *    "Resets Oct 3 @ 6:43pm" — since a weekday name is ambiguous over a month. */
export function chatGptLimitMessage(windowLabel: string, resetsAt: string): string {
  const t = Date.parse(resetsAt);
  // "6:43pm" from the SAME hand-rolled formatter as the status bar chip, so the
  // card and the chip agree on every machine. (A locale-following call printed
  // "18:43" on UK/EU/JP machines — T1 review, 2026-09-05.)
  const when = Number.isFinite(t) ? formatTime12(new Date(t)) : 'later';
  // Wording is Destin's (review round 2, P-9).
  return `You have reached ChatGPT's ${windowLabel} session limit (Resets ${resetDayPrefix(windowLabel, t)}@ ${when}).`;
}

/** The "Tuesday " / "Oct 3 " part in front of "@ 6:43pm", or '' for the 5-hour
 *  window and for an unparsable reset (where "Resets Tuesday @ later" would be
 *  nonsense). Kept separate so the 5-hour path above is literally the old code.
 *
 *  WHY the day is spelled out in full: the 7-day CHIP in the status bar has
 *  always said "Resets Thursday", and this card sits right beside it. The W-1
 *  deck said the two already matched and they did not — Destin chose the long
 *  form on 2026-09-05, so the chip is left exactly as every existing Claude
 *  subscriber already sees it and the card comes into line with it instead. */
function resetDayPrefix(windowLabel: string, t: number): string {
  if (windowLabel === '5-hour' || !Number.isFinite(t)) return '';
  const d = new Date(t);
  const days = /^(\d+)-day$/.exec(windowLabel);
  if (days && Number(days[1]) > 7) return `${formatMonthDay(d)} `;
  return `${formatDayLong(d)} `;
}

export function isChatGptLimitMessage(message: string | null | undefined): boolean {
  return !!message && /ChatGPT's .* session limit/.test(message);
}

/** Human plan label: 'plus' → 'ChatGPT Plus'. Unknown strings pass through
 *  title-cased so a renamed plan still reads as a name, not as a code. */
export function chatGptPlanLabel(plan: string): string {
  const p = plan.trim();
  if (!p) return 'ChatGPT';
  return `ChatGPT ${p.charAt(0).toUpperCase()}${p.slice(1)}`;
}
