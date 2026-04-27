import { useEffect, useRef } from 'react';
import { useChatDispatch } from '../state/chat-context';
import {
  classifyBuffer,
  BufferClass,
  ClassifierContext,
} from '../state/attention-classifier';
import type { AttentionState } from '../state/chat-types';

// How often the classifier re-reads the buffer while active.
const TICK_MS = 1000;

// A non-ok classification must hold for this many consecutive ticks before we
// dispatch. Suppresses transient false positives during spinner-render gaps.
const STABILITY_TICKS = 5;

// If no Claude Code spinner has been observed in the buffer for this long
// while the classifier is active (isThinking + no tool running/awaiting),
// escalate to 'stuck'. The gate conditions already rule out "busy with a
// tool" and "waiting on user", so sustained spinner-absence really does mean
// the CLI is silent in a way we should surface. Acts as the safety net for
// genuine stalls where the spinner has been removed entirely from the buffer
// (e.g. CC crashed mid-render or output scrolled the spinner off-screen).
const NO_SPINNER_STUCK_MS = 20_000;

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

function bufferClassToAttention(cls: BufferClass): AttentionState {
  // Classifier now only distinguishes spinner states. Anything else ('unknown')
  // maps to 'ok' — we don't trust content-based heuristics to flag attention.
  // See attention-classifier.ts header for why.
  switch (cls) {
    case 'thinking-stalled':
      return 'stuck';
    case 'thinking-active':
    case 'unknown':
      return 'ok';
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

    // Per-run spinner tracking — glyph rotation drives active vs. stalled.
    let previousSpinnerGlyph: string | null = null;
    // When the glyph last CHANGED. While the glyph stays the same we measure
    // age against this timestamp; after ≥10s without rotation the classifier
    // returns thinking-stalled (mapped to 'stuck').
    let previousSpinnerGlyphAt: number = Date.now();
    // When we last saw any spinner glyph in the buffer. Seeded to run-start
    // so the 20s no-spinner-stuck timer begins counting immediately.
    let lastSpinnerSeenAt: number = Date.now();
    // Debounce: count how many consecutive ticks have mapped to the same
    // non-ok state. Only dispatch once it sticks — transitions back to 'ok'
    // fire immediately so the banner clears fast when Claude resumes.
    let pendingState: AttentionState = 'ok';
    let pendingStreak = 0;

    // Async: the facade (window.claude.terminal.getScreenText) resolves via IPC
    // on desktop and via WebSocket on Android — same classifyBuffer call either
    // way. The original terminal-registry.getScreenText was synchronous and
    // returned string | null; the facade always resolves to string (empty string
    // when no terminal is registered, matching null-guard behavior since an empty
    // buffer produces 'unknown' → 'ok', which is harmless to dispatch).
    const tick = async () => {
      let raw: string;
      try {
        raw = await window.claude.terminal.getScreenText(sessionId);
      } catch {
        // Network/IPC failure (Android WebSocket disconnect, etc.) — treat as
        // empty buffer rather than crashing the tick. Mirrors the desktop IPC
        // handler's try/catch defaulting to ''.
        raw = '';
      }
      const lines = raw.split('\n');
      const tail = lines.slice(-40);

      const ctx: ClassifierContext = {
        bufferTail: tail,
        previousSpinnerGlyph,
        secondsSincePreviousGlyph: (Date.now() - previousSpinnerGlyphAt) / 1000,
      };
      const result = classifyBuffer(ctx);

      // Track spinner glyph for the next tick.
      if (result.spinnerGlyph !== null) {
        lastSpinnerSeenAt = Date.now();
        if (result.spinnerGlyph !== previousSpinnerGlyph) {
          previousSpinnerGlyph = result.spinnerGlyph;
          previousSpinnerGlyphAt = Date.now();
        }
      }

      let mapped = bufferClassToAttention(result.class);

      // Escalate sustained spinner-absence to 'stuck'. Gate already rules out
      // running tools / awaiting approval, so a missing spinner for 20s means
      // the CLI is genuinely quiet while we thought it was thinking.
      if (
        mapped === 'ok' &&
        result.class === 'unknown' &&
        Date.now() - lastSpinnerSeenAt >= NO_SPINNER_STUCK_MS
      ) {
        mapped = 'stuck';
      }

      // Track how long the mapped state has held across ticks.
      if (mapped === pendingState) {
        pendingStreak += 1;
      } else {
        pendingState = mapped;
        pendingStreak = 1;
      }

      // 'ok' clears the banner immediately — only escalations are debounced.
      const shouldDispatch =
        mapped === 'ok' || pendingStreak >= STABILITY_TICKS;

      if (shouldDispatch && mapped !== currentAttentionStateRef.current) {
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
