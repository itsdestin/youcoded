import { useEffect, useRef } from 'react';
import { useChatDispatch } from '../state/chat-context';
import { StuckTracker, STUCK_TICK_MS, STUCK_TAIL_ROWS } from '../../shared/stuck-tracker';
import type { AttentionState } from '../state/chat-types';
import { getCapabilities } from '../platform';

// WHY (2026-10-01 one-core R5-4b): the decision itself (spinner glyphs, the seconds counter, the 30 s stall, the 20 s silence, the five-tick
// debounce) moved to shared/stuck-tracker.ts, because the computer's own process now runs it too (main/session-screens.ts) and both must reach the
// same answer from the same screen. This hook is what is left for a host with no record of its own: the Android app's own runtime, whose
// terminal lives in this renderer until the Android rebuild.

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
  /** Which runtime backend this session uses. The classifier reads the xterm
   *  PTY buffer — only meaningful for PTY sessions ('claude'). Native harness
   *  sessions have no buffer; the hook short-circuits for them. */
  provider?: 'claude' | 'native';
}

/**
 * Periodically classify the PTY buffer and dispatch ATTENTION_STATE_CHANGED
 * when the mapped state differs from the current reducer state. ONLY on a host with no record (the Android app's own runtime): wherever
 * `capabilities.sessionRecord` is true the computer's main process owns the "may be stuck" state and publishes it as a numbered
 * `session:live` event, so this hook is inert there (it neither sets nor clears).
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
    provider,
  } = args;

  // Mutable refs avoid restarting the interval when these change mid-run.
  const currentAttentionStateRef = useRef(currentAttentionState);
  currentAttentionStateRef.current = currentAttentionState;

  // Classifier reads the xterm PTY buffer — only PTY sessions have one. This
  // is also the OWNERSHIP test: no buffer means this hook is not the author of
  // the session's attention state and must neither set nor clear it.
  //
  // ...and a remote browser has no buffer of its OWN. The PTY lives on the desktop it is
  // paired to, and `.claude/rules/react-renderer.md` says so outright: a remote browser
  // takes attention from `status:data`'s attentionMap and must not run this classifier.
  // It was running anyway, so every phone asked the host for terminal text once a second
  // over the WebSocket, for a channel the host does not bridge — which is what put
  // "terminal:get-screen-text isn't available via remote access yet." on Destin's phone
  // (2026-09-10). Android-local is NOT this case: that WebView talks to a runtime on the
  // same device, which does have the buffer, so the test is isRemoteMode() and not the
  // platform string.
  // R4-1: the screen says whether it has a terminal buffer (`terminalScreenRead`); false for any screen watching a computer.
  const hasBuffer = (provider === undefined || provider === 'claude') && getCapabilities().terminalScreenRead && !getCapabilities().sessionRecord;
  const active = hasBuffer && isThinking && !hasRunningTools && !hasAwaitingApproval && visible;

  useEffect(() => {
    if (!active) {
      // Clean up: if we left any non-ok state hanging, reset to 'ok' so the
      // banner disappears when Claude resumes or the user switches views.
      //
      // Fix (F1, 2026-08-16): the `hasBuffer &&` guard is new. This branch used
      // to fire for EVERY session, and for a native (harness) session `active`
      // is constant-false, so it ran exactly once — at ChatView mount — and
      // threw away whatever attention state was already there. That is a state
      // this hook never set and does not own: a native session's attention is
      // owned by the harness stall heartbeat, not by the PTY buffer this
      // classifier reads. Clearing it is the classifier reaching outside its
      // own subsystem.
      //
      // What it actually broke (the snapshot a phone was filled from, `chat:hydrate`, is gone since one-core R5-2; the same state now
      // arrives through a `session:open` fill, so the case still stands): ordinary desktop use was unaffected — ChatView mounts
      // long before any turn parks, with the state already 'ok'. The broken
      // case is a phone or browser reconnecting over the remote WebSocket to a
      // desktop session that is ALREADY parked: a fill correctly delivers
      // attentionState 'stalled', and this line immediately wiped it, so the
      // phone showed a plain spinner with no red card, no Retry and no Stop.
      // Spec §11 requires remote to work.
      //
      // Claude Code behaviour is byte-identical: hasBuffer is true for every
      // PTY session (and for an unset provider), from mount onward.
      if (hasBuffer && currentAttentionStateRef.current !== 'ok') {
        dispatch({ type: 'ATTENTION_STATE_CHANGED', sessionId, state: 'ok' });
      }
      return;
    }

    // One tracker per running turn: it holds the spinner/counter history and the five-tick debounce (shared/stuck-tracker.ts).
    const tracker = new StuckTracker(Date.now());

    // Async: the facade (window.claude.terminal.getScreenText) resolves via IPC on desktop and via WebSocket on Android.
    const tick = async () => {
      let raw: string;
      try {
        raw = await window.claude.terminal.getScreenText(sessionId, STUCK_TAIL_ROWS);
      } catch {
        // Network/IPC failure — treat as an empty buffer rather than crashing the tick (an empty buffer is 'unknown' -> 'ok').
        raw = '';
      }
      // Already a STUCK_TAIL_ROWS tail: no slice needed here.
      const { state: mapped, show } = tracker.tick(raw.split('\n'), Date.now());
      if (show && mapped !== currentAttentionStateRef.current) {
        dispatch({ type: 'ATTENTION_STATE_CHANGED', sessionId, state: mapped });
      }
    };

    const interval = setInterval(tick, STUCK_TICK_MS);
    // Run once immediately so short-lived stuck states surface inside 1s.
    tick();

    return () => {
      clearInterval(interval);
      // Reset to 'ok' on teardown so a stale banner doesn't persist. Same
      // ownership guard as the branch above (F1): only a session whose buffer
      // we were actually reading may clear the banner. Unreachable-but-cheap
      // today — getting here at all requires `active`, which requires
      // hasBuffer — kept so the two dispatch sites can't drift apart.
      if (hasBuffer && currentAttentionStateRef.current !== 'ok') {
        dispatch({ type: 'ATTENTION_STATE_CHANGED', sessionId, state: 'ok' });
      }
    };
    // `hasBuffer` is a real dependency (F1) rather than a stale closure read.
    // It costs nothing: it is derived from the session's provider, which is
    // stamped once at session creation (App.tsx:2231 / :2346) and never
    // mutated, so it is constant for a session's whole life and never causes
    // an extra run. Listing it keeps the disable comment below honest — the
    // ONLY thing deliberately excluded is currentAttentionState, accessed via
    // ref to avoid re-starting the classifier on every reducer dispatch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, hasBuffer, sessionId, dispatch]);
}
