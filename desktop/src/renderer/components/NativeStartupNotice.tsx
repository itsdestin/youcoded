import { useEffect, useRef, useState } from 'react';
import type { NativeStartupAction, NativeStartupState } from '../../shared/native-startup';
import { useNativeStartup } from '../hooks/use-native-startup';
import { getNativeStartup, setNativeStartup } from '../state/native-startup-store';
import { useOnScreen } from '../state/on-screen-context';
import { StatusStrip } from './ui/StatusStrip';
import { ErrorState } from './ui/states';
import { ScreenMark } from '../shoot-mode';

/** Same status/error recipes as setup downloads and other composer bands. */
export function StartupStatus({ state, onAction, busy = false, actionError = false }: {
  state: NativeStartupState; onAction: (action: NativeStartupAction) => void; busy?: boolean; actionError?: boolean;
}) {
  if (state.phase === 'ready') return null;
  if (state.phase === 'opening' || state.phase === 'connecting') return (
    <StatusStrip tone="busy" detail="You can read or draft a message while this finishes.">
      {state.phase === 'opening' ? 'Opening chat…' : 'Connecting tools…'}
    </StatusStrip>
  );
  const message = actionError ? "Couldn't confirm that choice."
    : state.cause === 'preparation' ? "This conversation couldn't finish starting."
    : state.issues.length ? "Some tools couldn't connect." : "Tool connections couldn't be prepared.";
  return <ErrorState
    message={message}
    details={state.issues.length ? state.issues.map(issue => `${issue.label}: ${issue.error}`).join('\n') : undefined}
    busy={busy}
    onRetry={() => onAction('retry')}
    moreActions={state.canContinue ? [{ label: 'Continue without these tools', onClick: () => onAction('continue') }] : undefined}
  />;
}

export function NativeStartupNotice({ sessionId, enabled = true }: { sessionId: string | null; enabled?: boolean }) {
  const onScreen = useOnScreen();
  const state = useNativeStartup(enabled && onScreen ? sessionId : null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    ++generation.current; setBusy(false); setActionError(false);
    return () => { ++generation.current; };
  }, [sessionId, state?.hostId, state?.generation]);
  if (!state || state.phase === 'ready' || !sessionId) return null;
  const act = (action: NativeStartupAction) => {
    const latest = getNativeStartup(sessionId);
    if (busy || latest?.phase !== 'failed' || state.phase !== 'failed' || latest.attemptId !== state.attemptId) return;
    const ticket = ++generation.current;
    setBusy(true); setActionError(false);
    // WHY: the exact failed attempt owns this consent. A retry/close/new generation
    // cannot apply an old Continue choice, and neither choice ever submits a draft.
    void window.claude.native.startupAction(sessionId, state.attemptId, action).then(result => {
      if (generation.current !== ticket) return;
      if (result.state) setNativeStartup(sessionId, result.state);
      if (!result.ok && !result.state) setActionError(true);
    }).catch(() => {
      if (generation.current === ticket) setActionError(true);
    }).finally(() => { if (generation.current === ticket) setBusy(false); });
  };
  return <div className="px-2 sm:px-3 pb-1.5">
    {/* WHY: captures must prove the requested readiness notice, not just the chat underneath. */}
    <ScreenMark name={`chat/native-startup-${state.phase}`} />
    <StartupStatus state={state} onAction={act} busy={busy} actionError={actionError} />
  </div>;
}
