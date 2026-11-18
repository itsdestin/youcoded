import React, { useEffect, useState } from 'react';
import BrailleSpinner from './BrailleSpinner';
import { Button } from './ui';
import { ChatNoticeBubble } from './ChatNoticeBubble';
import { useClaudeStatus } from './model/availability';
import { getCapabilities } from '../platform';
import { cancelSignIn, startSignIn, useSignInPhase, type SignInProvider } from '../state/provider-sign-in-store';
import { recheckExpiredSignIns } from '../hooks/useExpiredSignIns';

// The chat's cards for a sign-in that ran out, and for no internet (card #236).
// Decisions: claude-sign-in-expiry-questions (round 1) and -questions-2 (round 2),
// on top of offline-and-sign-in-questions (2026-09-14).

/** The words and buttons for one provider's sign-in flow — shared by Claude's card
 *  and the ChatGPT/OpenRouter error card, so all three read the same way
 *  (round 2 Q-chat-button: "match Claude"). */
function useSignInCard(provider: SignInProvider, opts: {
  /** The sentence while nothing has been pressed. */
  expiredLine: string;
  /** Already signed in again (this run, or found on reopening). */
  alreadyBack: boolean;
  /** OpenRouter only: the paste-a-key way back (round 2 Q-openrouter-how). */
  onPasteKey?: () => void;
  /** Main label of the sign-in button. */
  signInLabel?: string;
}) {
  const state = useSignInPhase(provider);
  const signIn = () => { void startSignIn(provider); };
  const back = state.phase === 'signed-in' || (state.phase === 'idle' && opts.alreadyBack);

  // WHY no Continue button (Destin, review deck R-3: "just show a sign in successful card
  // and let the user continue by sending a follow up"): the message that failed is still in
  // the conversation, so the next thing the person sends carries on from there.
  // Destin's words (review round 2, R2-3); the card leaves once that next message is sent.
  if (back) return { tone: 'success' as const, line: 'Sign in successful. Send another message to continue.' };
  switch (state.phase) {
    case 'checking':
    case 'waiting':
      // Same red-ringed card as the step before it (review R-2: the style must not jump
      // between the two), with the app's thinking spinner until the sign-in completes. While
      // it runs, its Stop is the main action — filled (guide, Buttons).
      return { tone: 'danger' as const,
        line: <span className="inline-flex items-center gap-2"><BrailleSpinner size="base" />Browser opened, please continue to sign in.</span>,
        buttons: <Button size="sm" onClick={() => cancelSignIn(provider)}>Cancel</Button> };
    case 'offline':
      // Red like the other sign-in cards (review R-4/R-9), and only after the app's own check said so.
      return { tone: 'danger' as const, line: 'No internet connection. Connect, then try again.',
        buttons: <Button size="sm" onClick={signIn}>Try again</Button> };
    case 'failed':
      return { tone: 'danger' as const, line: "Signing in didn't finish.", details: state.message,
        buttons: <Button size="sm" onClick={signIn}>Try again</Button> };
    default:
      return {
        tone: 'danger' as const,
        line: opts.expiredLine,
        buttons: (
          <>
            {opts.onPasteKey && <Button size="sm" variant="secondary" onClick={opts.onPasteKey}>Paste a new key</Button>}
            {/* "Sign in", not "Sign in again", on every device (review R-6). */}
            <Button size="sm" onClick={signIn}>{opts.signInLabel ?? 'Sign in'}</Button>
          </>
        ),
      };
  }
}

/**
 * Claude Code's "Login expired · Please run /login" reply, drawn as a card.
 *
 * Only the conversation's LATEST reply is live: an expiry further up the history
 * was fixed long ago, so it shows one quiet line and no buttons.
 */
export function ClaudeSignInNotice({ latest }: { latest: boolean }) {
  // WHY nothing (review round 2, R2-3: "the card should disappear on the next send"): once a
  // message follows it, the expiry was dealt with and the card has no job left.
  if (!latest) return null;
  // A phone or browser connected to the computer cannot sign Claude Code in: the
  // sign-in has to finish on the computer (round 1 Q-remote, "say where", no button).
  if (!getCapabilities().openExternal) {
    return <ChatNoticeBubble tone="danger" line={`Your Claude sign-in has expired. ${HOST_LINE}`} />;
  }
  return <LiveClaudeSignInNotice />;
}

function LiveClaudeSignInNotice() {
  const { status, refresh } = useClaudeStatus();
  const phase = useSignInPhase('claude').phase;
  // A reply just came back "sign-in failed": the gear's dot looks again (Q-check-when: "when a message fails").
  useEffect(() => { recheckExpiredSignIns(); }, []);
  // A sign-in finished here re-reads the live status, so Settings and the model menu agree.
  useEffect(() => { if (phase === 'signed-in') refresh(); }, [phase, refresh]);
  // Signed in again since (in a terminal, or before a restart): the card says so straight away.
  const alreadyBack = status?.state === 'signed-in' && status.expired !== true;
  const card = useSignInCard('claude', {
    expiredLine: 'Your Claude sign-in has expired.',
    alreadyBack,
  });
  return <ChatNoticeBubble tone={card.tone} line={card.line} buttons={card.buttons} details={card.details} />;
}

/** A phone or browser connected to the computer: the sign-in must finish on the computer (review R-5, Destin's words). */
const HOST_LINE = 'Sign in again from your host computer.';

/** The ChatGPT / OpenRouter red card when the sign-in or key was refused. */
export function ProviderSignInCard({ provider, keyExpired, onPasteKey }: {
  provider: 'chatgpt' | 'openrouter';
  /** OpenRouter: the key passed its own end date (rather than being refused). */
  keyExpired?: boolean;
  /** OpenRouter connections made before the app recorded how: offer both ways back. */
  onPasteKey?: () => void;
}) {
  const card = useSignInCard(provider, {
    expiredLine: provider === 'chatgpt' ? 'Your ChatGPT sign-in has expired.'
      : keyExpired ? 'Your OpenRouter key has expired.' : "OpenRouter didn't accept your key.",
    alreadyBack: false,
    onPasteKey,
    signInLabel: provider === 'openrouter' ? 'Sign in with OpenRouter' : undefined,
  });
  if (!getCapabilities().openExternal) {
    return <ChatNoticeBubble tone="danger" line={`${card.line} ${HOST_LINE}`} />;
  }
  return <ChatNoticeBubble tone={card.tone} line={card.line} buttons={card.buttons} details={card.details} />;
}

/** No internet, confirmed by the app's own check (round 2 S-offline-chat). */
export function NoInternetNotice({ onRetry }: { onRetry?: () => void }) {
  return (
    <ChatNoticeBubble tone="danger" line="No internet connection."
      buttons={onRetry ? <Button size="sm" onClick={onRetry}>Try again</Button> : undefined} />
  );
}

/**
 * Claude Code's connection-error reply on the latest turn. The app checks the
 * connection itself; only when that check says offline does the reply become the
 * No internet card. Otherwise it stays Claude Code's own words (`fallback`), so a
 * problem on Anthropic's side is never blamed on the user's connection.
 */
export function ClaudeConnectionNotice({ fallback }: { fallback: React.ReactNode }) {
  const [offline, setOffline] = useState(false);
  const [backOnline, setBackOnline] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    Promise.resolve((window as any).claude?.network?.check?.())
      .then((r: { online?: boolean } | undefined) => { if (alive) setOffline(r?.online === false); })
      .catch(() => { /* a failed check proves nothing: keep Claude Code's own words */ });
    return () => { alive = false; };
  }, [nonce]);
  // Back online after Try again: say so, and let the person carry on with their next message
  // (the same rule as a fixed sign-in — review R-3: nothing is sent for them).
  if (backOnline) return <ChatNoticeBubble tone="success" line="You're back online." />;
  if (!offline) return <>{fallback}</>;
  return (
    <NoInternetNotice onRetry={() => {
      void Promise.resolve((window as any).claude?.network?.check?.()).then((r: { online?: boolean } | undefined) => {
        if (r?.online === false) { setNonce((n) => n + 1); return; }
        setBackOnline(true);
      });
    }} />
  );
}
