import React from 'react';
import type { AttentionState } from '../state/chat-types';
import BrailleSpinner from './BrailleSpinner';
import { Button } from './ui';
import { isChatGptLimitMessage } from '../../shared/chatgpt-types';

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
  /** Stalled card only: re-run the parked step. NOT a re-send of the user's
   *  message — every completed tool call earlier in the turn stays put. */
  onRetry?: () => void;
  /** Opens Settings → Model Providers. When the provider error is a
   *  configuration problem (missing/disabled key), the bubble shows an
   *  "Open Settings" button that calls this so the user can fix it in one hop. */
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
   *  providers. Shown only for a plan-limit error, like Switch Providers. */
  onUpgradePlan?: () => void;
}

// Provider-CONFIGURATION errors (missing API key, disabled provider, no endpoint)
// all originate in main/providers/provider-registry.ts and deterministically end
// with "Settings → Providers." — the one place that phrase is emitted. We match
// that phrase rather than threading a structured `action` field through the event
// data → NATIVE_SESSION_ERROR → SessionChatState → serialization → here (~8 files),
// because the message has a single origin and is stable. Runtime/stream failures
// ("502…", "The model request failed.") don't contain it, so they won't match.
function isProviderConfigError(message: string | null | undefined): boolean {
  return !!message && /Settings → Providers/.test(message);
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

export default function AttentionBanner({ state, anthropicRequestId, errorMessage, onRetry, onOpenProviderSettings, stalledSince, onStop, onSwitchProviders, onUpgradePlan }: Props) {
  // Ticks once a second while parked. `stalledSince` IS serialized to the host
  // (chat-types.ts) so a reconnecting phone can still see the card — see that
  // field's own comment for why the elapsed number is only approximate there.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (state !== 'stalled' || stalledSince == null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state, stalledSince]);

  const destructive = DESTRUCTIVE.includes(state);
  const bubbleBase = 'flex items-center gap-2 bg-inset rounded-2xl rounded-bl-sm px-4 py-2.5';
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
      : COPY[state];
  // The 'error' banner's Try again button is UNCHANGED below (same element,
  // same classes) — Task 11 reserves it and nothing here may alter it.
  // Stalled gets its own Retry/Stop pair rather than reusing showRetry, so a
  // future Task-11 wire-up of error's onRetry can't accidentally pick up
  // stalled's styling (or vice versa) through a shared flag.
  const showRetry = state === 'error' && !!onRetry;
  const showStalledRetry = state === 'stalled' && !!onRetry;
  const showStop = state === 'stalled' && !!onStop;
  // Provider-CONFIG errors get a direct "Open Settings" jump to Model Providers.
  const showOpenSettings =
    state === 'error' && !!onOpenProviderSettings && isProviderConfigError(errorMessage);
  // A used-up ChatGPT plan window is not a failure to retry — the message
  // already names when it resets — so Try again is withheld and the one useful
  // action is offered instead: carry on with another connected provider.
  const planLimit = state === 'error' && isChatGptLimitMessage(errorMessage);
  const showSwitch = planLimit && !!onSwitchProviders;
  const showUpgrade = planLimit && !!onUpgradePlan;

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
            Retry
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
          // label AND style: transparent (secondary), left of Switch Providers.
          <Button size="sm" variant="secondary" onClick={onUpgradePlan} className="ml-auto shrink-0">
            Upgrade plan
          </Button>
        )}
        {showSwitch && (
          // P-9 (round 3): the message in Destin's words and one button that
          // opens the model picker — the picker is where every provider and
          // its models already are, so the choice is the user's, not a guess.
          // Stays the green (primary) action, right of Upgrade plan.
          <Button size="sm" onClick={onSwitchProviders} className="shrink-0">
            Switch Providers
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
            Open Settings
          </Button>
        )}
      </div>
      {showRequestId && (
        <div className="text-[10.5px] text-fg-muted font-mono mt-1 select-text">
          Request ID: {anthropicRequestId}
        </div>
      )}
    </div>
  );
}
