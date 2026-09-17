//
// The one place that answers "can this session show this widget at all?".
// Both the status bar and its Customize popup read it, so the bar can never
// hide a chip the menu still offers, or vice versa (spec §9).
//
// WHY a separate module rather than a helper inside StatusBar.tsx: the popup is
// rendered from StatusBar but the ANSWER is also needed by tests and, later, by
// the /usage card. A shared module keeps one definition; a local helper would
// have grown a second copy the first time something else needed it.

/** Every toggleable widget in WIDGET_CATEGORIES (StatusBar.tsx). Moved here so
 *  the relevance rules and the registry can reference one union. */
export type WidgetId =
  | 'usage-5h' | 'usage-7d' | 'context' | 'git-branch' | 'sync-warnings' | 'theme' | 'version'
  | 'session-cost' | 'tokens-in' | 'tokens-out' | 'cache-stats' | 'code-changes' | 'session-time'
  | 'cache-hit-rate' | 'active-ratio' | 'output-speed'
  | 'announcement'
  | 'open-tasks'
  | 'session-tags';

/** The session's runtime — NOT its provider type. Known the instant a session
 *  exists and never absent, which is why the gate below can never flicker. */
export type SessionRuntime = 'claude' | 'native';

export interface RelevanceContext {
  runtime: SessionRuntime;
  /** Has any counted work in this session had a published price? Drives the
   *  cost chip's reason line only. */
  hasPricedWork: boolean;
  /** Did any counted work run on a METERED model whose price is not published?
   *  The bar draws a `Cost: not listed` chip for this, so the menu has to know
   *  about it — see the session-cost branch below. Rides the totals from main
   *  as `anyUnpriced`. */
  anyUnpriced: boolean;
  /** Did any counted work run on a model that costs nothing to run (a local
   *  engine)? A local model and a metered model with no published rate BOTH
   *  produce no cost figure, but they are opposite situations and must not
   *  share a sentence — "no published price" reads like a shop listing that is
   *  merely missing, when in fact there is nothing to charge (checkpoint #9).
   *  The renderer cannot tell them apart on its own (SessionInfo carries no
   *  provider type), so this rides the totals from main as `anyFree`. */
  runsLocally: boolean;
  /** A ChatGPT-plan native session has its own rolling 5h/7d windows (its
   *  OpenAI plan's, not a Claude subscription's), fed into the bar as real
   *  numbers — StatusBar.tsx's `show()` already draws the chip for exactly
   *  this case (`chatgptWindows`). Without this the menu judged the row on
   *  `runtime` alone, so a session whose chip was ON SCREEN with a real
   *  number still read "Claude Code sessions only" in Customize — a reason
   *  that was false for the one session drawing the chip. */
  chatgptWindows: boolean;
}

/** Widgets that describe the Claude SUBSCRIPTION — an account a native session
 *  neither spends nor is limited by. These are the only widgets gated on the
 *  runtime; everything else is gated on whether it has a value to show. */
const CLAUDE_ONLY: ReadonlySet<WidgetId> = new Set<WidgetId>(['usage-5h', 'usage-7d']);

/** Chips a native session has no measurement for. NOT a relevance judgment —
 *  the harness simply does not report turn wall-time (spec §15). */
const UNMEASURED_IN_NATIVE: ReadonlySet<WidgetId> = new Set<WidgetId>(['session-time', 'active-ratio']);

export function widgetApplies(id: WidgetId, runtime: SessionRuntime): boolean {
  return runtime === 'claude' || !CLAUDE_ONLY.has(id);
}

/** One line for the Customize menu explaining why a row can't be turned on
 *  here, or null when there is nothing to explain.
 *
 *  git-branch is deliberately absent: it is missing because nothing feeds it,
 *  not because it doesn't apply, and "Claude Code sessions only" would be a
 *  false sentence — the exact defect this work removes (spec §4). */
export function widgetUnavailableReason(id: WidgetId, ctx: RelevanceContext): string | null {
  if (ctx.runtime === 'claude') return null;
  // No "— see /usage" pointer: it is not a link here, and a path a user has to
  // retype is worse than not mentioning it (checkpoint #8).
  // Mirrors StatusBar.tsx's `show()` override for the same two widgets: a
  // ChatGPT-plan session applies here too, so the row must stay a switch.
  if (CLAUDE_ONLY.has(id)) return ctx.chatgptWindows ? null : 'Claude Code sessions only';
  // "yet" promised a feature that is not on the roadmap (checkpoint #7).
  if (UNMEASURED_IN_NATIVE.has(id)) return 'Not available in this kind of session';
  // Cost is the one row whose availability the BAR also decides, so this
  // condition deliberately mirrors the chip's render condition in
  // StatusBar.tsx (the `show('session-cost')` block): the chip draws a figure
  // when some work was priced, and draws "Cost: not listed" when nothing was
  // priced but the provider bills anyway. In both cases the chip is on screen,
  // so the row must stay a switch the user can actually turn off — a visible
  // chip whose switch looks unavailable is the exact disagreement this module
  // exists to prevent (spec §9). THE TWO ARE ONE RULE WRITTEN IN TWO PLACES:
  // change this branch and the chip block together, or the bar/menu agreement
  // table in statusbar-widget-menu.test.tsx will say so.
  if (id === 'session-cost' && !ctx.hasPricedWork && !ctx.anyUnpriced) {
    // Only a session that is genuinely free to run gets a sentence. A session
    // that has simply not run anything yet gets NONE: "No published price for
    // this model" was false there — nothing had been priced because nothing had
    // happened — and a reason must be true or absent (spec §4). git-branch is
    // the precedent: a widget can be empty without being unavailable.
    // Checking anyUnpriced first also settles the delegation case, where a free
    // local parent used a metered specialist: metered work ran, so the row is
    // offered rather than told it costs nothing (spec §5).
    return ctx.runsLocally ? "Models on your own machine don't cost anything to run" : null;
  }
  return null;
}
