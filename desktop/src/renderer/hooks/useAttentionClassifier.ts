import { useEffect, useRef } from 'react';
import { useChatDispatch } from '../state/chat-context';
import { getScreenText } from './terminal-registry';
import {
  classifyBuffer,
  BufferClass,
  ClassifierContext,
} from '../state/attention-classifier';
import type { AttentionState } from '../state/chat-types';

// How long to treat 'unknown' as normal silence before escalating to 'stuck'.
const UNKNOWN_GRACE_MS = 60_000;

// How often the classifier re-reads the buffer while active.
const TICK_MS = 1000;

interface HookArgs {
  /** isThinking from reducer — gates the whole classifier. */
  isThinking: boolean;
  /** Don't classify while a tool is running (Claude is busy, not stuck). */
  hasRunningTools: boolean;
  /** Don't classify while awaiting approval (user is the blocker). */
  hasAwaitingApproval: boolean;
  /** Chat view must be visible (no point classifying a hidden view). */
  visible: boolean;
  /** Current reducer attentionState — used for dispatch-suppression. */
  currentAttentionState: AttentionState;
}

function bufferClassToAttention(
  cls: BufferClass,
  runStartedAt: number,
): AttentionState {
  switch (cls) {
    case 'thinking-active':
      return 'ok';
    case 'thinking-stalled':
      return 'stuck';
    case 'awaiting-input':
      return 'awaiting-input';
    case 'shell-idle':
      return 'shell-idle';
    case 'error':
      return 'error';
    case 'unknown': {
      // Grace window — brief silence is normal (typing pause, network hop).
      // Only call it 'stuck' after sustained unknown-ness.
      const elapsed = Date.now() - runStartedAt;
      return elapsed > UNKNOWN_GRACE_MS ? 'stuck' : 'ok';
    }
  }
}

/**
 * Periodically classify the PTY buffer and dispatch ATTENTION_STATE_CHANGED
 * when the mapped state differs from the current reducer state.
 *
 * Replaces the legacy 30s thinkingTimedOut watchdog. See docs/chat-reducer.md
 * "Attention classifier" and src/renderer/state/attention-classifier.ts for
 * the signal-to-state mapping.
 */
export function useAttentionClassifier(sessionId: string, args: HookArgs): void {
  const dispatch = useChatDispatch();
  const {
    isThinking,
    hasRunningTools,
    hasAwaitingApproval,
    visible,
    currentAttentionState,
  } = args;

  // Mutable refs avoid restarting the interval when these change mid-run.
  const currentAttentionStateRef = useRef(currentAttentionState);
  currentAttentionStateRef.current = currentAttentionState;

  const active = isThinking && !hasRunningTools && !hasAwaitingApproval && visible;

  useEffect(() => {
    if (!active) {
      // Clean up: if we left any non-ok state hanging, reset to 'ok' so the
      // banner disappears when Claude resumes or the user switches views.
      if (currentAttentionStateRef.current !== 'ok') {
        dispatch({ type: 'ATTENTION_STATE_CHANGED', sessionId, state: 'ok' });
      }
      return;
    }

    // Per-run state: when the spinner counter last advanced, and when the
    // run itself started (used for the 'unknown' grace window).
    const runStartedAt = Date.now();
    let previousSpinnerSeconds: number | null = null;
    let previousSpinnerAt: number = runStartedAt;

    const tick = () => {
      const raw = getScreenText(sessionId);
      if (raw === null) return;
      const lines = raw.split('\n');
      const tail = lines.slice(-40);

      const ctx: ClassifierContext = {
        bufferTail: tail,
        previousSpinnerSeconds,
        secondsSincePreviousSpinner: (Date.now() - previousSpinnerAt) / 1000,
      };
      const result = classifyBuffer(ctx);

      // Track spinner progression for the next tick.
      if (result.spinnerSeconds !== null) {
        if (result.spinnerSeconds !== previousSpinnerSeconds) {
          previousSpinnerSeconds = result.spinnerSeconds;
          previousSpinnerAt = Date.now();
        }
      }

      const mapped = bufferClassToAttention(result.class, runStartedAt);
      if (mapped !== currentAttentionStateRef.current) {
        dispatch({ type: 'ATTENTION_STATE_CHANGED', sessionId, state: mapped });
      }
    };

    const interval = setInterval(tick, TICK_MS);
    // Run once immediately so short-lived stuck states surface inside 1s.
    tick();

    return () => {
      clearInterval(interval);
      // Reset to 'ok' on teardown so a stale banner doesn't persist.
      if (currentAttentionStateRef.current !== 'ok') {
        dispatch({ type: 'ATTENTION_STATE_CHANGED', sessionId, state: 'ok' });
      }
    };
    // Intentionally excludes currentAttentionState — accessed via ref to avoid
    // re-starting the classifier on every reducer dispatch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionId, dispatch]);
}
