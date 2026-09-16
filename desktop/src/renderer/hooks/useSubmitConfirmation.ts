import type { SessionProvider } from '../../shared/types';
import { useCallback, useEffect, useRef } from 'react';
import { useChatStore } from '../state/chat-context';
import { canRetrySubmit } from '../state/pty-input-gate';

// First-attempt retry threshold. After this long with the optimistic bubble
// still in pending state, if the session is observably idle, we send a
// follow-up '\r' to nudge submission. Sized against two observed CC delays:
//
// 1) Spinner-render latency: in test-conpty harness traces (CC v2.1.119, cold
//    session), 7-8s elapsed between an input write and "Forming…" appearing.
//    Production warm-cache sessions are presumably faster but not zero.
// 2) JSONL flush latency: CC writes the user-message entry to the transcript
//    JSONL only after the assistant turn has begun streaming, not on submit.
//    On a slow first token (cold prompt cache, network hiccup, long context),
//    `pending` can legitimately stay set for 5+ s on a successful send.
//
// 8s is a compromise: long enough to outlast typical first-token delay while
// staying short enough to feel responsive when recovery IS needed. The busy
// gate (canRetrySubmit) defers the retry while anything is observably in
// flight. Residual race: a successful submit that has produced NO observable
// state at 8s (no spinner, no transcript turn, no tool) would trigger a
// spurious bare-\r that submits an empty message. Acceptable given CC
// ignores empty input bar submits — and canRetrySubmit guarantees no Ink
// select menu is up, so the stray \r cannot answer a prompt.
const RETRY_DELAY_MS = 8000;

// When the retry timer fires but Claude is still busy, recheck after this
// shorter delay. The busy gate is what avoids double-submitting while
// Claude's own pending-message queue is still draining.
const RECHECK_DELAY_MS = 1000;

interface TrackedSubmit {
  sessionId: string;
  retried: boolean;
  timer: ReturnType<typeof setTimeout>;
}

interface UseSubmitConfirmationArgs {
  // Active session id + its view mode. Used to suppress the `\r` retry while
  // the user is actively in the pending session's terminal view — see the
  // view-mode gate inside attemptRetry for the rationale.
  activeSessionId: string | null;
  activeViewMode: 'chat' | 'terminal';
  // Resolves a session's runtime backend. Native sessions have no PTY and no
  // lost-byte failure mode — the whole `\r` recovery mechanism is
  // Claude/PTY-specific — so their pending bubbles are never tracked here. A
  // stray `\r` would be a nonsense write for a native session anyway. Optional
  // for callers that only ever run claude sessions.
  providerForSession?: (sessionId: string) => SessionProvider | undefined;
}

/**
 * Recovers chat→PTY submits that didn't reach Claude.
 *
 * On Windows ConPTY, when Claude is busy rendering, the worker's 600ms gap
 * between body and `\r` writes can collapse — both bytes arrive at Claude in
 * the same kernel read, Ink treats `\r` as paste content (literal newline)
 * instead of a submit keystroke, and the message sits in Claude's input bar
 * without submitting. See
 * docs/superpowers/investigations/2026-04-24-chat-to-pty-submit-reliability.md
 * for the full mechanism + why every worker-side protocol fix was ruled out.
 *
 * Strategy: don't try to prevent the failure (we can't, from the worker side).
 * Detect it. The optimistic bubble's `pending` flag is the authoritative
 * "did Claude actually receive this" signal — TRANSCRIPT_USER_MESSAGE clears
 * it on success. If the flag stays set and Claude is observably idle, the
 * submit was lost; send a single `\r` (body bytes are already in Claude's
 * input bar from the failed first attempt) to trigger submission.
 *
 * Busy gate (canRetrySubmit in pty-input-gate.ts) is what prevents both
 * double-submits while Claude's own queue is still draining AND stray Enter
 * presses landing on a live permission/AskUserQuestion menu — only retry
 * when Claude is observably idle with no prompt awaiting the user.
 */
export function useSubmitConfirmation(args: UseSubmitConfirmationArgs) {
  // Store handle so the timer callback always reads the latest state, not the
  // snapshot from when the timer was scheduled.
  const store = useChatStore();
  // Same pattern for the active session/view inputs: timers must observe
  // current values when they fire, not the values that were live when the
  // timer was scheduled.
  const argsRef = useRef(args);
  argsRef.current = args;

  const trackedRef = useRef<Map<string, TrackedSubmit>>(new Map());

  const attemptRetry = useCallback((messageId: string) => {
    const tracked = trackedRef.current;
    const info = tracked.get(messageId);
    if (!info) return;

    const session = store.getState().get(info.sessionId);
    if (!session) {
      tracked.delete(messageId);
      return;
    }

    const stillPending = session.timeline.some(
      (e) => e.kind === 'user' && e.message.id === messageId && e.pending,
    );
    if (!stillPending) {
      tracked.delete(messageId);
      return;
    }

    // View-mode gate: don't fire `\r` while the user is actively in this
    // session's terminal view. On desktop, xterm.onData routes each keystroke
    // straight to the PTY (TerminalView.tsx), so injecting `\r` would commit
    // whatever partial line they're typing into Claude's input bar. The
    // pending bubble stays visible; recovery resumes the moment they switch
    // back to chat (RECHECK_DELAY_MS reschedule below). Symmetric with the
    // ESC-passthrough gate in App.tsx — both refuse to write to the PTY when
    // the user is operating it directly via xterm.
    if (
      info.sessionId === argsRef.current.activeSessionId &&
      argsRef.current.activeViewMode === 'terminal'
    ) {
      info.timer = setTimeout(() => attemptRetry(messageId), RECHECK_DELAY_MS);
      return;
    }

    // Busy gate: canRetrySubmit requires attentionState 'ok' AND no
    // in-flight turn, no running tools, and — critically — no pending
    // permission/AskUserQuestion/plan approval or interactive prompt. While
    // one of those is pending, CC's native Ink select menu is LIVE in the
    // PTY (the chat card answers via the hook socket, but the menu still
    // listens for keys), so a bare `\r` here would press Enter on the
    // highlighted option and silently auto-answer it. That exact failure
    // shipped: attentionState alone was the old gate, and 'ok' is ALSO the
    // normal state mid-turn and while a menu is up — see pty-input-gate.ts.
    //
    // isThinking is deliberately not consulted (it stays true forever in the
    // lost-message state this hook recovers from) — rationale lives in
    // canRetrySubmit's doc comment.
    if (!canRetrySubmit(session)) {
      // CC is observably busy (turn in flight, tool running, or a prompt is
      // awaiting the user). Don't retry yet; recheck shortly. By the time
      // the session is idle, TRANSCRIPT_USER_MESSAGE will likely have
      // cleared `pending` already and the early-return above will fire.
      info.timer = setTimeout(() => attemptRetry(messageId), RECHECK_DELAY_MS);
      return;
    }

    if (info.retried) {
      // Already retried once and still no transcript confirmation. Stop.
      // Bubble stays pending (matches pre-fix behavior). A future iteration
      // could mark this 'failed' in the UI with a manual retry button.
      tracked.delete(messageId);
      return;
    }

    // Bare 1-byte write — pty-worker's case 'input' branches `length > 1 &&
    // endsWith('\r')` skip; this lands in the passthrough `else` and reaches
    // ConPTY as a single byte. With nothing else queued ahead of it, it
    // arrives at Claude as a clean keystroke instead of paste content.
    window.claude.session.sendInput(info.sessionId, '\r');
    info.retried = true;
    info.timer = setTimeout(() => attemptRetry(messageId), RETRY_DELAY_MS);
  }, []);

  // Track new pending bubbles; clean up confirmed/removed ones.
  // Perf (tranche 1): store subscription instead of a [chatState] effect.
  // Tracking/cleanup semantics are unchanged — only the read path moved.
  useEffect(() => {
    const track = () => {
      const tracked = trackedRef.current;
      const seen = new Set<string>();
      for (const [sessionId, session] of store.getState()) {
        // Native sessions send in-process (native:send) — no lost-byte failure
        // mode, so never track their pending bubbles for the PTY `\r` retry.
        // Edge: during teardown the resolver may transiently return undefined
        // (the SessionInfo already removed while chat state lingers). undefined is
        // treated as claude/tracked — safe by default (a bare `\r` to a dead
        // session is a harmless no-op); a native session caught mid-teardown is a
        // low residual risk, not a correctness bug.
        // A shell session is skipped for the opposite reason: it HAS a PTY, and
        // the retry's bare `\r` would press Enter in the user's own shell.
        const trackProvider = argsRef.current.providerForSession?.(sessionId);
        if (trackProvider === 'native' || trackProvider === 'shell') continue;
        for (const entry of session.timeline) {
          if (entry.kind !== 'user' || !entry.pending) continue;
          const messageId = entry.message.id;
          seen.add(messageId);
          if (tracked.has(messageId)) continue;
          tracked.set(messageId, {
            sessionId,
            retried: false,
            timer: setTimeout(() => attemptRetry(messageId), RETRY_DELAY_MS),
          });
        }
      }
      for (const [id, info] of tracked) {
        if (!seen.has(id)) {
          clearTimeout(info.timer);
          tracked.delete(id);
        }
      }
    };
    track();
    return store.subscribeAll(track);
  }, [store, attemptRetry]);

  // Clear all timers on unmount only — empty deps so this cleanup doesn't
  // fire on every chatState change (which would defeat the purpose).
  useEffect(
    () => () => {
      for (const info of trackedRef.current.values()) clearTimeout(info.timer);
      trackedRef.current.clear();
    },
    [],
  );
}
