import React, { useEffect, useState } from 'react';
import { Button } from './ui';
import { ChatNoticeBubble } from './ChatNoticeBubble';
import { useClaudeStatus } from './model/availability';
import { getCapabilities } from '../platform';
import { cancelSignIn, startSignIn, useSignInPhase, type SignInProvider } from '../state/provider-sign-in-store';
import { recheckExpiredSignIns } from '../hooks/useExpiredSignIns';

// The chat's cards for a sign-in that ran out, and for no internet (card #236).
// Decisions: claude-sign-in-expiry-questions (round 1) and -questions-2 (round 2),
// on top of offline-and-sign-in-questions (2026-09-14).

const NAME: Record<SignInProvider, string> = { claude: 'Claude', chatgpt: 'ChatGPT', openrouter: 'OpenRouter' };

/** The words and buttons for one provider's sign-in flow — shared by Claude's card
 *  and the ChatGPT/OpenRouter error card, so all three read the same way
 *  (round 2 Q-chat-button: "match Claude"). */
function useSignInCard(provider: SignInProvider, opts: {
  /** The sentence while nothing has been pressed. */
  expiredLine: string;
  /** Already signed in again (this run, or found on reopening) and not yet continued. */
  alreadyBack: boolean;
  onContinue?: () => void;
  /** OpenRouter only: the paste-a-key way back (round 2 Q-openrouter-how). */
  onPasteKey?: () => void;
  /** Main label of the sign-in button. */
  signInLabel?: string;
}) {
  const state = useSignInPhase(provider);
  const [continued, setContinued] = useState(false);
  const signIn = () => { void startSignIn(provider); };
  const back = state.phase === 'signed-in' || (state.phase === 'idle' && opts.alreadyBack);

  if (continued) return { tone: 'quiet' as const, line: `Signed in to ${NAME[provider]} again.` };
  if (back) {
    return {
      tone: 'quiet' as const,
      line: "You're signed in again.",
      // WHY Continue, not a resend (round 2 Q-continue): the message that failed is
      // still in the conversation and the assistant reads it once signed in, so the
      // one press carries on from there — nothing is sent twice.
      buttons: opts.onContinue
        ? <Button size="sm" onClick={() => { setContinued(true); opts.onContinue!(); }}>Continue</Button>
        : undefined,
    };
  }
  switch (state.phase) {
    case 'checking':
    case 'waiting':
      // While it runs, its Stop is the main action — filled (guide, Buttons). No status ring:
      // nothing has gone wrong, the person is just busy in the browser.
      return { tone: 'quiet' as const, line: 'Your browser opened. Finish signing in there.',
        buttons: <Button size="sm" onClick={() => cancelSignIn(provider)}>Cancel</Button> };
    case 'offline':
      // "No internet" only when the app's own check said so — amber (guide, Status and notices).
      return { tone: 'warning' as const, line: 'No internet connection. Connect, then try again.',
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
            <Button size="sm" onClick={signIn}>{opts.signInLabel ?? 'Sign in again'}</Button>
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
export function ClaudeSignInNotice({ sessionId, latest }: { sessionId: string; latest: boolean }) {
  if (!latest) return <ChatNoticeBubble tone="quiet" line="Your Claude sign-in expired here." />;
  // A phone or browser connected to the computer cannot sign Claude Code in: the
  // sign-in has to finish on the computer (round 1 Q-remote, "say where", no button).
  if (!getCapabilities().openExternal) {
    return <ChatNoticeBubble tone="danger" line="Your Claude sign-in has expired. Sign in again on your computer." />;
  }
  return <LiveClaudeSignInNotice sessionId={sessionId} />;
}

function LiveClaudeSignInNotice({ sessionId }: { sessionId: string }) {
  const { status, refresh } = useClaudeStatus();
  const phase = useSignInPhase('claude').phase;
  // A reply just came back "sign-in failed": the gear's dot looks again (Q-check-when: "when a message fails").
  useEffect(() => { recheckExpiredSignIns(); }, []);
  // A sign-in finished here re-reads the live status, so Settings and the model menu agree.
  useEffect(() => { if (phase === 'signed-in') refresh(); }, [phase, refresh]);
  // Signed in again since (in a terminal, or before a restart): the card offers Continue straight away.
  const alreadyBack = status?.state === 'signed-in' && status.expired !== true;
  const card = useSignInCard('claude', {
    expiredLine: 'Your Claude sign-in has expired.',
    alreadyBack,
    onContinue: () => { void (window as any).claude?.claudeCode?.continueQuietly?.(sessionId); },
  });
  return <ChatNoticeBubble tone={card.tone} line={card.line} buttons={card.buttons} details={card.details} />;
}

/** The ChatGPT / OpenRouter red card when the sign-in or key was refused. */
export function ProviderSignInCard({ provider, keyExpired, onContinue, onPasteKey }: {
  provider: 'chatgpt' | 'openrouter';
  /** OpenRouter: the key passed its own end date (rather than being refused). */
  keyExpired?: boolean;
  onContinue?: () => void;
  /** OpenRouter connections made before the app recorded how: offer both ways back. */
  onPasteKey?: () => void;
}) {
  const card = useSignInCard(provider, {
    expiredLine: provider === 'chatgpt' ? 'Your ChatGPT sign-in has expired.'
      : keyExpired ? 'Your OpenRouter key has expired.' : "OpenRouter didn't accept your key.",
    alreadyBack: false,
    onContinue,
    onPasteKey,
    signInLabel: provider === 'openrouter' ? 'Sign in with OpenRouter' : undefined,
  });
  if (!getCapabilities().openExternal) {
    return <ChatNoticeBubble tone="danger" line={`${card.line} Sign in again on your computer.`} />;
  }
  return <ChatNoticeBubble tone={card.tone} line={card.line} buttons={card.buttons} details={card.details} />;
}

/** No internet, confirmed by the app's own check (round 2 S-offline-chat). */
export function NoInternetNotice({ onRetry }: { onRetry?: () => void }) {
  return (
    <ChatNoticeBubble tone="warning" line="No internet connection."
      buttons={onRetry ? <Button size="sm" onClick={onRetry}>Try again</Button> : undefined} />
  );
}

/**
 * Claude Code's connection-error reply on the latest turn. The app checks the
 * connection itself; only when that check says offline does the reply become the
 * No internet card. Otherwise it stays Claude Code's own words (`fallback`), so a
 * problem on Anthropic's side is never blamed on the user's connection.
 */
export function ClaudeConnectionNotice({ sessionId, fallback }: { sessionId: string; fallback: React.ReactNode }) {
  const [offline, setOffline] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    Promise.resolve((window as any).claude?.network?.check?.())
      .then((r: { online?: boolean } | undefined) => { if (alive) setOffline(r?.online === false); })
      .catch(() => { /* a failed check proves nothing: keep Claude Code's own words */ });
    return () => { alive = false; };
  }, [nonce]);
  if (!offline) return <>{fallback}</>;
  return (
    <NoInternetNotice onRetry={() => {
      // Try again: check again first; still offline keeps the card, back online carries on.
      void Promise.resolve((window as any).claude?.network?.check?.()).then((r: { online?: boolean } | undefined) => {
        if (r?.online === false) { setNonce((n) => n + 1); return; }
        setOffline(false);
        void (window as any).claude?.claudeCode?.continueQuietly?.(sessionId);
      });
    }} />
  );
}
