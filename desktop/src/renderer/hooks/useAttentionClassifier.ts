import { useEffect, useRef } from 'react';
import { useChatDispatch } from '../state/chat-context';
import {
  classifyBuffer,
  BufferClass,
  ClassifierContext,
} from '../state/attention-classifier';
import type { AttentionState } from '../state/chat-types';
import { isRemoteMode } from '../platform';

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
  /** Which runtime backend this session uses. The classifier reads the xterm
   *  PTY buffer — only meaningful for PTY sessions ('claude'). Native harness
   *  sessions have no buffer; the hook short-circuits for them. */
  provider?: 'claude' | 'native';
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
  const hasBuffer = (provider === undefined || provider === 'claude') && !isRemoteMode();
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
      // What it actually broke: `chat:hydrate` is remote-only (preload.ts:513
      // deliberately does not serve it on desktop; remote-server.ts:729 is the
      // only sender), so ordinary desktop use was unaffected — ChatView mounts
      // long before any turn parks, with the state already 'ok'. The broken
      // case is a phone or browser reconnecting over the remote WebSocket to a
      // desktop session that is ALREADY parked: hydrate correctly delivers
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

    // Per-run spinner tracking — glyph rotation drives active vs. stalled.
    let previousSpinnerGlyph: string | null = null;
    // When the glyph last CHANGED. While the glyph stays the same we measure
    // age against this timestamp; after ≥30s without rotation AND no counter
    // advancement the classifier returns thinking-stalled (mapped to 'stuck').
    let previousSpinnerGlyphAt: number = Date.now();
    // When we last saw a CC liveness signal in the buffer — either a spinner
    // glyph OR a paren-wrapped seconds counter that advanced since the prior
    // tick. Seeded to run-start so the 20s no-spinner-stuck timer begins
    // counting immediately. Broader than the old "lastSpinnerSeenAt" because
    // a ticking counter alone is enough to prove CC is alive and rendering;
    // see attention-classifier.ts header for the full rationale.
    let lastSignalSeenAt: number = Date.now();
    // Tracks the highest CC seconds-counter value observed in the prior tick
    // so the classifier can detect counter advancement across ticks. null when
    // no counter was visible in the prior tick (very first tick or pre-tool
    // phase of a turn).
    let previousCounterSeconds: number | null = null;
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
        previousCounterSeconds,
      };
      const result = classifyBuffer(ctx);

      // Track spinner glyph for the next tick.
      if (result.spinnerGlyph !== null) {
        lastSignalSeenAt = Date.now();
        if (result.spinnerGlyph !== previousSpinnerGlyph) {
          previousSpinnerGlyph = result.spinnerGlyph;
          previousSpinnerGlyphAt = Date.now();
        }
      }

      // Track counter advancement for the next tick. A counter that ticked up
      // is itself a CC liveness signal — refresh lastSignalSeenAt so the 20s
      // no-spinner escalation below doesn't fire while a counter is actively
      // running. We compare to the value we passed INTO this tick (saved in
      // a local) before overwriting previousCounterSeconds for the next one.
      const priorCounterForCompare = previousCounterSeconds;
      if (
        result.counterSeconds !== null &&
        priorCounterForCompare !== null &&
        result.counterSeconds > priorCounterForCompare
      ) {
        lastSignalSeenAt = Date.now();
      }
      previousCounterSeconds = result.counterSeconds;

      let mapped = bufferClassToAttention(result.class);

      // Escalate sustained signal-absence to 'stuck'. Gate already rules out
      // running tools / awaiting approval, so 20s without ANY liveness signal
      // (no glyph, no advancing counter) means the CLI is genuinely quiet
      // while we thought it was thinking.
      if (
        mapped === 'ok' &&
        result.class === 'unknown' &&
        Date.now() - lastSignalSeenAt >= NO_SPINNER_STUCK_MS
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
