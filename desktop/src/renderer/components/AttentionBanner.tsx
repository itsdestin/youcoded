import React from 'react';
import type { AttentionState } from '../state/chat-types';
import BrailleSpinner from './BrailleSpinner';
import { Button } from './ui';
import { isChatGptAppLimitMessage, isChatGptLimitMessage } from '../../shared/chatgpt-types';
import { useSecondsTick } from '../hooks/useSecondsTick';
import { FoldRow } from './ui/FoldRow';
import { errorCardCopy, billingUrl, type ErrorCardAction } from './error-card-copy';
import { BugReportPopup } from './development/BugReportPopup';

// Banner shown in place of ThinkingIndicator when the classifier (or a
// process-exit event) concludes chat view is out of sync with what the user
// would see in Terminal view. Copy is keyed off AttentionState — keep it
// short and point the user at Terminal view when the state is ambiguous.

interface Props {
  state: Exclude<AttentionState, 'ok'>;
  /** Anthropic API request ID for the last assistant turn, if any.
   *  Rendered only when state is 'error' or 'session-died' for support correlation. */
  anthropicRequestId?: string | null;
  /** Provider error text (native runtime). When state==='error' this takes
   *  precedence over the generic COPY line. */
  errorMessage?: string | null;
  /** Which known failure errorMessage is, when main could tell — picks the
   *  card's action button (see OPEN_SETTINGS_CODES / the Add credit case). */
  errorCode?: string | null;
  /** Stalled card only: re-run the parked step. NOT a re-send of the user's
   *  message — every completed tool call earlier in the turn stays put. */
  onRetry?: () => void;
  /** Opens Settings → Model Providers. When the provider error is a
   *  configuration problem (missing/disabled key), the bubble shows an
   *  "Open settings" button that calls this so the user can fix it in one hop. */
  onOpenProviderSettings?: () => void;
  /** When the turn parked, on this client's clock. Drives the count-up. */
  stalledSince?: number | null;
  /** Stalled card only: end the turn, keeping everything written so far.
   *  Identical to ESC — see ChatView, which wires it to the same handler. */
  onStop?: () => void;
  /** Plan-limit card (Sign in with ChatGPT; review round 2, P-9): the Switch
   *  Providers button opens the model picker for THIS conversation. */
  onSwitchProviders?: () => void;
  /** Plan-limit card: opens OpenAI's upgrade page (chatgpt.com/explore/pro) so
   *  the user can raise the exhausted window, side by side with switching
   *  providers. Shown only for a plan-limit error, like Switch providers. */
  onUpgradePlan?: () => void;
  /** Official-route limit card: opens ChatGPT's usage page, where the user sees
   *  what is left and can raise YouCoded's share of the plan. */
  onManageUsage?: () => void;
  /** OpenRouter "not enough credit" card: opens OpenRouter's add-credit page. */
  onAddCredit?: () => void;
  /** What KIND of failure the native error was (provider-failure.ts). With it the
   *  card says one plain sentence and offers that kind's way forward
   *  (error-card-copy.ts); without it (an older host) it renders as before. */
  errorKind?: string | null;
  /** The session's provider type, for the provider's name and billing page. */
  providerType?: string | null;
  /** Too-long card: summarise older messages, then try the reply again. */
  onSummarise?: () => void;
  /** Which runtime the session runs. Only 'native' changes anything: the
   *  'stuck' line drops its "check Terminal view" pointer, because a native
   *  session has no Terminal view. Anything else keeps the pointer. */
  provider?: 'claude' | 'native';
}

// Which failures get which button. Since 2026-09-18 the session-error event
// can carry an `errorCode`, and the banner reads THAT — the earlier choice was
// to pattern-match the sentence rather than thread a field through ~8 files,
// on the reasoning that the sentence had one stable origin. It stopped being
// true: a key OpenRouter refuses, an expired ChatGPT sign-in and a key that
// can't be decrypted all needed the same button and none carried the phrase,
// so each ended as raw text with no way out. The field is optional, so a
// message without a code falls back to the phrase match below exactly as before.
const OPEN_SETTINGS_CODES = new Set([
  'openrouter-key-rejected', 'openrouter-key-expired',
  'chatgpt-signin-expired', 'chatgpt-signin-required',
]);

// The fallback: provider-CONFIGURATION errors (missing key, disabled provider,
// no endpoint) from main/providers/provider-registry.ts name where to fix them.
// The screen was renamed twice, so every name it has had still matches — an
// older main process must still get its button. Runtime/stream failures
// ("502…", "The model request failed.") name no screen, so they never match.
function isProviderConfigError(message: string | null | undefined): boolean {
  return !!message && /Settings → (Providers|Model Providers)|Assistant settings → Cloud providers/.test(message);
}

const COPY: Record<Props['state'], string> = {
  'stuck': 'Still waiting on your assistant — check Terminal view if this persists.',
  'session-died': 'Session ended unexpectedly.',
  // 'error' is native-runtime only (dispatcher: NATIVE_SESSION_ERROR, added in
  // Phase 1 Plan A). The detailed provider message rides the 'session-error'
  // transcript event; this banner copy stays generic.
  'error': 'The model provider returned an error — this turn has ended.',
  // Deliberately non-committal: a hung upstream and a dead socket are
  // indistinguishable from inside the app and always will be, so the copy
  // states the observation and pairs it with two actions rather than guessing
  // a cause (docs/error-message-standards.md).
  'stalled': 'Provider may have stalled',
};

// WHY: a native session has no Terminal view to check, so the Claude Code
// pointer above would send the user looking for something that isn't there.
// No button is added: a native 'stuck' always moves on within ~15s — to the
// red 'stalled' card (Retry/Stop), a silent auto-retry, or the 'error' card
// (harness-session.ts armWatchdog). Destin chose copy-only, 2026-09-16.
const NATIVE_STUCK_COPY = 'Still waiting on your assistant.';

// Destructive states pick up the L3 destructive ring tokens so they read as
// "something went wrong" rather than just a nudge. Other states reuse the
// neutral bubble styling to stay consistent with ThinkingIndicator.
const DESTRUCTIVE: Props['state'][] = ['session-died', 'error', 'stalled'];

/** "45s" / "2m 14s" / "1h 3m". Whole seconds only — a stalled turn is measured
 *  in minutes and a jittering decimal reads as broken. */
function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m ${total % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default function AttentionBanner({ state, anthropicRequestId, errorMessage, errorCode, errorKind, providerType, onRetry, onOpenProviderSettings, stalledSince, onStop, onSwitchProviders, onUpgradePlan, onManageUsage, onAddCredit, onSummarise, provider }: Props) {
  // Rides the shared seconds clock while parked. `stalledSince` IS serialized
  // to the host (chat-types.ts) so a reconnecting phone can still see the card
  // — see that field's own comment for why the elapsed number is only
  // approximate there.
  const now = useSecondsTick(state === 'stalled' && stalledSince != null);

  // The sorted error card (error-card.questions Q-1…Q-4): when main says what kind
  // of failure this was, one plain sentence, the provider's words under Details,
  // and that kind's buttons. Cards that already had their own (OpenRouter key and
  // credit, ChatGPT sign-in and plan limits) return null here and render below as before.
  const sorted = state === 'error' ? errorCardCopy(errorKind, errorCode, errorMessage ?? '', providerType) : null;
  if (sorted) return <SortedErrorCard copy={sorted} providerType={providerType ?? null} anthropicRequestId={anthropicRequestId}
    rawError={errorMessage ?? ''} handlers={{ onRetry, onOpenProviderSettings, onSwitchProviders, onSummarise }} />;

  const destructive = DESTRUCTIVE.includes(state);
  // attention-bubble: a hook for the buddy's small window, which wraps the buttons under the sentence (buddy.css).
  const bubbleBase = 'attention-bubble flex items-center gap-2 bg-inset rounded-2xl rounded-bl-sm px-4 py-2.5';
  const bubbleClasses = destructive
    ? `${bubbleBase} ring-1 ring-[var(--destructive)]`
    : bubbleBase;
  const textClasses = destructive
    ? 'text-sm text-fg-2'
    : 'text-sm text-fg-muted italic';
  // Show the spinner while Claude might still be working ('stuck') AND while a
  // turn is parked — a parked turn's stream is still open and the model may yet
  // answer, which is exactly what the spinner means. session-died and error are
  // endings, so they stay still.
  const showSpinner = state === 'stuck' || state === 'stalled';
  // Surface the request ID on terminal failures only (session-died / error):
  // it's strictly a support-correlation aid, so we hide it during the benign
  // 'stuck' banner where Claude is likely still working. Matches the Props
  // doc comment above.
  const showRequestId = (state === 'session-died' || state === 'error') && !!anthropicRequestId;
  // Parked turns append a live count-up to the copy — see the `stalledSince`
  // field comment above for the serialization/skew note.
  const line = state === 'error' && errorMessage
    ? errorMessage
    : state === 'stalled' && stalledSince != null
      ? `${COPY.stalled} — no response for ${elapsedLabel(now - stalledSince)}`
      : state === 'stuck' && provider === 'native'
        ? NATIVE_STUCK_COPY
        : COPY[state];
  // The 'error' banner's Try again button is UNCHANGED below (same element,
  // same classes) — Task 11 reserves it and nothing here may alter it.
  // Stalled gets its own Retry/Stop pair rather than reusing showRetry, so a
  // future Task-11 wire-up of error's onRetry can't accidentally pick up
  // stalled's styling (or vice versa) through a shared flag.
  const showRetry = state === 'error' && !!onRetry;
  const showStalledRetry = state === 'stalled' && !!onRetry;
  const showStop = state === 'stalled' && !!onStop;
  // A fixable key/sign-in problem gets a direct jump to Cloud providers. With a
  // code, the code decides — an OpenRouter moderation refusal names no screen
  // and must NOT offer Settings (the key is fine). Without one, the phrase does.
  const showOpenSettings =
    state === 'error' && !!onOpenProviderSettings
    && (errorCode ? OPEN_SETTINGS_CODES.has(errorCode) : isProviderConfigError(errorMessage));
  // Not enough OpenRouter credit for THIS request: the fix is on OpenRouter's
  // site, not in Settings — so this card's one action is Add credit.
  const showAddCredit = state === 'error' && errorCode === 'openrouter-credit-short' && !!onAddCredit;
  // A used-up ChatGPT plan window is not a failure to retry — the message
  // already names when it resets — so Try again is withheld and the one useful
  // action is offered instead: carry on with another connected provider.
  const codexLimit = state === 'error' && isChatGptLimitMessage(errorMessage);
  // The official route's limit names no reset time (OpenAI does not say), so
  // its way out is ChatGPT's own usage page rather than an upgrade link — the
  // cap may be YouCoded's share, which the user can raise there.
  const appLimit = state === 'error' && isChatGptAppLimitMessage(errorMessage);
  const planLimit = codexLimit || appLimit;
  const showSwitch = planLimit && !!onSwitchProviders;
  const showUpgrade = codexLimit && !!onUpgradePlan;
  const showManageUsage = appLimit && !!onManageUsage;

  return (
    // in-view: opts the bubble into wallpaper-driven bubble glassmorphism
    // (theme-engine targets `.in-view .bg-inset`), matching ThinkingIndicator.
    // Column layout lets the Request ID stack beneath the bubble while staying
    // inside the same banner container (consistent padding + glass treatment).
    <div className="flex flex-col items-start gap-1 px-4 py-1.5 in-view">
      <div className={bubbleClasses}>
        {showSpinner && <BrailleSpinner size="base" />}
        <span className={textClasses}>{line}</span>
        {showRetry && !planLimit && (
          <button
            type="button"
            onClick={onRetry}
            className="text-xs underline text-fg-dim hover:text-fg"
          >
            Try again
          </button>
        )}
        {showStalledRetry && (
          <Button
            size="sm"
            onClick={onRetry}
            className="ml-auto shrink-0"
          >
            Try again
          </Button>
        )}
        {showStop && (
          // Stop is ESC in visible form. Secondary, because "wait for it" and
          // "retry" are the hopeful answers and this is the one that gives up —
          // but it is a real button, because against a dead provider Retry as
          // the only option costs a full conversation re-send per press.
          <Button size="sm" variant="secondary" onClick={onStop} className="shrink-0">
            Stop
          </Button>
        )}
        {showUpgrade && (
          // Upgrade path for the exhausted plan: OpenAI's own upgrade page
          // (the URL the Codex CLI's limit error names). Destin's requested
          // label AND style: transparent (secondary), left of Switch providers.
          <Button size="sm" variant="secondary" onClick={onUpgradePlan} className="ml-auto shrink-0">
            Upgrade plan
          </Button>
        )}
        {showManageUsage && (
          // Same place and style as Upgrade plan on the other route's card.
          <Button size="sm" variant="secondary" onClick={onManageUsage} className="ml-auto shrink-0">
            Manage usage
          </Button>
        )}
        {showSwitch && (
          // P-9 (round 3): the message in Destin's words and one button that
          // opens the model picker — the picker is where every provider and
          // its models already are, so the choice is the user's, not a guess.
          // Stays the green (primary) action, right of Upgrade plan.
          <Button size="sm" onClick={onSwitchProviders} className="shrink-0">
            Switch providers
          </Button>
        )}
        {showAddCredit && (
          <Button size="sm" onClick={onAddCredit} className="ml-auto shrink-0">
            Add credit
          </Button>
        )}
        {showOpenSettings && (
          // ml-auto pushes the CTA to the right edge of the bubble, past the
          // message text. Plain-words label (no glyph) per standing preference.
          <Button
            size="sm"
            onClick={onOpenProviderSettings}
            className="ml-auto shrink-0"
          >
            Open settings
          </Button>
        )}
      </div>
      {showRequestId && (
        <div className="text-3xs text-fg-muted font-mono mt-1 select-text">
          Request ID: {anthropicRequestId}
        </div>
      )}
    </div>
  );
}

const ACTION_LABEL: Record<ErrorCardAction, string> = {
  'open-settings': 'Open settings', 'add-credit': 'Add credit', 'billing': 'Open billing',
  'switch-model': 'Switch model', 'summarise': 'Summarise and continue', 'report-bug': 'Report bug', 'try-again': 'Try again',
};

/** The red card for a native error with a known kind. Same bubble and ring as the
 *  card above (it replaces the reply in the same spot); buttons sit at the right,
 *  the last one filled — the card's main action (guide: Status and notices). */
function SortedErrorCard({ copy, providerType, anthropicRequestId, rawError, handlers }: {
  copy: ReturnType<typeof errorCardCopy> & object; providerType: string | null; anthropicRequestId?: string | null; rawError: string;
  handlers: { onRetry?: () => void; onOpenProviderSettings?: () => void; onSwitchProviders?: () => void; onSummarise?: () => void };
}) {
  const billing = billingUrl(providerType);
  // The card opens its own bug report, carrying the provider's exact words (as
  // EngineCard does) — so App, held at its line budget, wires nothing new.
  const [reporting, setReporting] = React.useState(false);
  const press: Partial<Record<ErrorCardAction, (() => void) | undefined>> = {
    'try-again': handlers.onRetry, 'open-settings': handlers.onOpenProviderSettings, 'switch-model': handlers.onSwitchProviders,
    'summarise': handlers.onSummarise, 'report-bug': () => setReporting(true),
    'billing': billing ? () => { void window.claude.shell.openExternal(billing); } : undefined,
  };
  // An action whose handler this screen lacks (a phone without the picker, say) is left out, never a dead button.
  const actions = copy.actions.filter((a) => press[a]);
  const buttons = actions.length > 0 && (
    <div className="ml-auto flex items-center justify-end gap-2 shrink-0">
      {actions.map((a, i) => (
        <Button key={a} size="sm" variant={i === actions.length - 1 ? 'primary' : 'secondary'} onClick={press[a]}>
          {ACTION_LABEL[a]}
        </Button>
      ))}
    </div>
  );
  return (
    <div className="flex flex-col items-start gap-1 px-4 py-1.5 in-view">
      <div className="flex flex-col gap-2 bg-inset rounded-2xl rounded-bl-sm px-4 py-2.5 ring-1 ring-[var(--destructive)] max-w-full">
        {/* Guide (Status and notices, gt-r1#E-2/#E-3): the box reads top to bottom —
            what happened, the provider's own words if you want them, then what you can
            do. So with a Details fold the buttons sit BELOW it, at the right; without
            one they sit beside the sentence. */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-fg-2 min-w-0">{copy.line}</span>
          {!copy.details && buttons}
        </div>
        {copy.details && (
          <FoldRow title="Details" flush>
            <p className="text-2xs text-fg-2 font-mono break-all select-text">{copy.details}</p>
          </FoldRow>
        )}
        {copy.details && buttons}
      </div>
      {anthropicRequestId && (
        <div className="text-3xs text-fg-muted font-mono mt-1 select-text">Request ID: {anthropicRequestId}</div>
      )}
      <BugReportPopup open={reporting} onClose={() => setReporting(false)} context={{ surface: 'Chat', error: rawError }} />
    </div>
  );
}
