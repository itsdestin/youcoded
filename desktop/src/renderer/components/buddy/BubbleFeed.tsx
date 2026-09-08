import React, { useEffect, useRef, useCallback, useMemo } from 'react';
import { useChatState, useChatDispatch } from '../../state/chat-context';
import { hookEventToAction } from '../../state/hook-dispatcher';
import UserMessage from '../UserMessage';
import SpecialistReportCard from '../SpecialistReportCard';
import AssistantTurnBubble from '../AssistantTurnBubble';
import { shouldRenderAssistantTurn } from '../../state/chat-types';
import { CompactToolStrip } from './CompactToolStrip';
import PromptCard from '../PromptCard';
import { sendPromptInput } from '../../state/prompt-input';
import UsageCard from '../UsageCard';
import SystemMarker from '../SystemMarker';
import CompactingCard from '../CompactingCard';
import ThinkingIndicator from '../ThinkingIndicator';
import { useTheme } from '../../state/theme-context';

interface Props {
  sessionId: string | null;
}

/**
 * Compact read-only bubble feed for the buddy chat window.
 *
 * Path B implementation: owns its own event subscriptions and feeds the
 * shared chat reducer (via ChatProvider added to BuddyChatApp). This is
 * the correct path because:
 * - The buddy window is a separate Electron BrowserWindow/renderer process
 *   and cannot share the main app's React tree or ChatProvider instance.
 * - ChatView pulls in useAttentionClassifier which must NOT run in buddy —
 *   buddy is a passive viewer (main owns classification and emits ATTENTION_REPORT).
 * - We import the same sub-components (UserMessage, AssistantTurnBubble,
 *   ToolCard, etc.) verbatim to avoid styling/behaviour drift.
 *
 * What this component does NOT do (by design):
 * - No useAttentionClassifier — buddy never classifies PTY buffer
 * - No InputBar — E5 owns that
 * - No keyboard arrow-scroll acceleration — smaller surface area
 * - No visibility-toggling — buddy feed is always "visible" when mounted
 */
export function BubbleFeed({ sessionId }: Props) {
  const dispatch = useChatDispatch();
  const state = useChatState(sessionId ?? '');
  const { showTimestamps } = useTheme();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  // Mirror state in a ref so async event handlers see fresh values
  // without needing to list state in useEffect deps (which would cause
  // the handler to re-subscribe every render).
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // ── Transcript event subscription ─────────────────────────────────────────
  // The buddy window receives transcript:event IPC for the subscribed session
  // (WindowRegistry routes to owner + all subscribers). Wire them into the
  // shared reducer exactly as App.tsx does, but filtered to sessionId.
  useEffect(() => {
    if (!sessionId) return;

    // Bootstrap the reducer's per-session state entry. Every chat-reducer
    // handler that touches session state bails with `if (!session) return
    // state` when state.get(sessionId) is undefined — so without SESSION_INIT,
    // USER_PROMPT and every TRANSCRIPT_* event is silently dropped and the
    // bubble feed never populates. Main's App.tsx dispatches SESSION_INIT via
    // the sessionCreated listener and the session-list load; buddy has
    // neither, so we initialize on-demand here for the session being viewed.
    // SESSION_INIT is idempotent (no-op if already initialized).
    dispatch({ type: 'SESSION_INIT', sessionId });

    // Batch dispatches into animation frames — mirrors App.tsx batching pattern
    // to avoid N re-renders per PTY flush.
    const pending: any[] = [];
    let rafId: number | null = null;
    let cancelled = false;

    function flush() {
      rafId = null;
      if (cancelled) return;
      const batch = pending.splice(0);
      for (const action of batch) dispatch(action);
    }

    function batchDispatch(action: any) {
      pending.push(action);
      if (rafId === null) rafId = requestAnimationFrame(flush);
    }

    const unsubTranscript = window.claude.on.transcriptEvent((event: any) => {
      // Only process events for the session this feed is watching
      if (!event?.type || event?.sessionId !== sessionId) return;

      switch (event.type) {
        case 'user-message':
          batchDispatch({
            type: 'TRANSCRIPT_USER_MESSAGE',
            sessionId: event.sessionId,
            uuid: event.uuid,
            text: event.data.text,
            timestamp: event.timestamp,
            // Host-injected turn marker + header — MUST mirror App.tsx.
            injected: event.data.injected,
            injectedMeta: event.data.injectedMeta,
            // Forward the subagent stamp so the reducer can drop subagent
            // briefings (they're already shown on the parent Agent card).
            parentAgentToolUseId: event.data.parentAgentToolUseId,
            agentId: event.data.agentId,
          });
          break;
        case 'assistant-text':
          batchDispatch({
            type: 'TRANSCRIPT_ASSISTANT_TEXT',
            sessionId: event.sessionId,
            uuid: event.uuid,
            text: event.data.text,
            timestamp: event.timestamp,
            // Forward the per-message model so the reducer can stamp
            // turn.model on the first text of each turn (mirror App.tsx).
            model: event.data.model,
            // Native runtime: per-token delta id — same partId merges into the
            // last text segment (mirror App.tsx, must stay identical).
            partId: event.data.partId,
            // Forward the subagent stamp so the reducer routes subagent
            // events into the parent Agent tool's subagentSegments instead
            // of appending them to the main timeline as separate bubbles.
            // Without this the subagent's thinking, tools, and replies all
            // appear inline as if the main Claude instance produced them.
            parentAgentToolUseId: event.data.parentAgentToolUseId,
            agentId: event.data.agentId,
          });
          break;
        case 'tool-use':
          batchDispatch({
            type: 'TRANSCRIPT_TOOL_USE',
            sessionId: event.sessionId,
            uuid: event.uuid,
            toolUseId: event.data.toolUseId,
            toolName: event.data.toolName,
            toolInput: event.data.toolInput || {},
            plan: event.data.plan,
            // Carried so a specialist's mid-run note can be placed among its
            // tool rows by time (reconcileNoteSegments) in the buddy window
            // too — without it buddy rows were unstamped and every note fell
            // to the tail. Mirror App.tsx / transcript-page-actions.ts, must
            // stay identical (pinned by transcript-event-surface-parity.test.ts).
            timestamp: event.timestamp,
            // Route subagent tool_use into the parent Agent card's
            // subagentSegments — see assistant-text comment above.
            parentAgentToolUseId: event.data.parentAgentToolUseId,
            agentId: event.data.agentId,
          });
          break;
        case 'tool-result':
          batchDispatch({
            type: 'TRANSCRIPT_TOOL_RESULT',
            sessionId: event.sessionId,
            uuid: event.uuid,
            toolUseId: event.data.toolUseId,
            result: event.data.toolResult || '',
            isError: event.data.isError || false,
            plan: event.data.plan,
            structuredPatch: event.data.structuredPatch,
            // Route subagent tool_result into the parent Agent card's
            // subagentSegments — see assistant-text comment above.
            parentAgentToolUseId: event.data.parentAgentToolUseId,
            agentId: event.data.agentId,
          });
          break;
        case 'turn-complete':
          // Forward per-turn metadata so the buddy reducer stamps stopReason,
          // model, anthropicRequestId, and usage on AssistantTurn — matches
          // App.tsx's main-window dispatch. Without this, buddy turns would
          // have these fields permanently null even though transcript-watcher
          // emits them, breaking the per-turn metadata strip / StopReasonFooter
          // / AttentionBanner request-id readout if the buddy ever surfaces
          // those UIs. Coalesce undefined → null because the action type
          // requires (string | null), not optional.
          batchDispatch({
            type: 'TRANSCRIPT_TURN_COMPLETE',
            sessionId: event.sessionId,
            uuid: event.uuid,
            timestamp: event.timestamp,
            stopReason: event.data.stopReason ?? null,
            model: event.data.model ?? null,
            anthropicRequestId: event.data.anthropicRequestId ?? null,
            usage: event.data.usage ?? null,
            // Forward the subagent stamp so the reducer can drop a sub-agent's
            // end_turn instead of polluting parent turn.model — see App.tsx mirror.
            parentAgentToolUseId: event.data.parentAgentToolUseId,
            agentId: event.data.agentId,
          });
          break;
        case 'subagent-usage':
          // Task 23 item 4 — parity with App.tsx's mirror of this case.
          // Bookkeeping only: never touches the timeline, the turn state, or a
          // subagent card's segments. It exists so the parent's totals include
          // the work it delegated (spec §2), and it arrives on the PARENT's
          // stream. Nothing in the buddy window reads `totals` today, so this
          // changes nothing a user can see — it is here for the same reason
          // turn-complete just above forwards its usage: this feed drives its
          // OWN chatReducer instance, so if the buddy ever surfaces those
          // numbers they must not silently be missing every delegated run.
          batchDispatch({
            type: 'TRANSCRIPT_SUBAGENT_USAGE',
            sessionId: event.sessionId,
            uuid: event.uuid,
            timestamp: event.timestamp,
            usage: event.data.usage ?? null,
            parentAgentToolUseId: event.data.parentAgentToolUseId,
            agentId: event.data.agentId,
          });
          break;
        case 'assistant-thinking':
          // Reasoning chunks carry a text payload (native harness / thinking
          // models); the CC transcript path is heartbeat-only. Truthiness
          // check (not typeof) so an empty-string payload stays a heartbeat —
          // MUST match App.tsx's predicate or the two windows diverge.
          if (event.data?.text) {
            batchDispatch({
              type: 'TRANSCRIPT_ASSISTANT_REASONING',
              sessionId: event.sessionId,
              uuid: event.uuid,
              text: event.data.text,
              timestamp: event.timestamp,
              partId: event.data.partId,
              // Specialists 1c — MUST mirror App.tsx.
              parentAgentToolUseId: event.data.parentAgentToolUseId,
            });
          } else {
            // Preparing tool card — the buddy feed renders tool cards too, so
            // omitting this would make it draw the card only once arguments
            // finish while the main window draws it immediately. MUST mirror
            // App.tsx or the two windows diverge.
            if (event.data?.toolPreparing) {
              batchDispatch({
                type: 'NATIVE_TOOL_PREPARING',
                sessionId: event.sessionId,
                toolCallId: event.data.toolPreparing.toolCallId,
                toolName: event.data.toolPreparing.toolName,
                chars: event.data.toolPreparing.chars,
                cleared: event.data.toolPreparing.cleared,
              });
            }
            // Fix: erase an abandoned half-written sentence BEFORE the heartbeat
            // below parks/clears the turn — must stay before it, and MUST mirror
            // App.tsx or the two windows diverge.
            if (event.data?.dropPart) {
              batchDispatch({
                type: 'NATIVE_PARTS_DROPPED',
                sessionId: event.sessionId,
                partIds: event.data.dropPart.partIds,
              });
            }
            batchDispatch({
              type: 'TRANSCRIPT_THINKING_HEARTBEAT',
              sessionId: event.sessionId,
              // Native watchdog stall countdown + parked turn — payload sets,
              // absence clears. MUST mirror App.tsx or the two windows diverge.
              stallWarning: event.data?.stallWarning,
              stalled: event.data?.stalled,
            });
          }
          break;
        case 'session-error':
          // Native runtime only: a provider/stream failure. End the turn and
          // surface the 'error' AttentionBanner (mirror App.tsx).
          batchDispatch({
            type: 'NATIVE_SESSION_ERROR',
            sessionId: event.sessionId,
            message: event.data.text ?? 'The model request failed.',
          });
          break;
        // compact-summary: buddy doesn't drive compaction UI (no /compact command),
        // but we still need to close any pending compaction spinner if it was opened
        // because the owner session triggered compaction. A native auto-compaction
        // (event.data.autoCompaction) has no pending flag but must still show a
        // marker — bypass the guard in that case (mirror App.tsx).
        case 'compact-summary':
          if (stateRef.current.compactionPending || event.data.autoCompaction) {
            batchDispatch({
              type: 'COMPACTION_COMPLETE',
              sessionId: event.sessionId,
              markerId: `compact-done-${Date.now()}`,
              afterContextTokens: null,
              // Forward summary so buddy's marker matches main window's expandable behavior.
              ...(event.data.summary ? { summary: event.data.summary } : {}),
              ...(event.data.autoCompaction ? { auto: true } : {}),
            });
          }
          break;
        case 'replay-complete':
          // End of a transcript replay — reap tool cards the history left
          // 'running'. The buddy feeds its OWN chatReducer instance (separate
          // BrowserWindow), so App.tsx handling this does nothing for us and the
          // orphaned card kept spinning here (found reviewing PR #287).
          // sessionIdle false means main could not affirm the session is idle
          // (live re-dock, or a CC session) and the reducer leaves it alone.
          batchDispatch({
            type: 'TRANSCRIPT_REPLAY_COMPLETE',
            sessionId: event.sessionId,
            sessionIdle: event.data?.sessionIdle === true,
          });
          break;
      }
    });

    // Request the most recent PAGE of history AFTER the listener is wired so no
    // live event can race past us. Perf cycle 2: this used to be
    // requestTranscriptReplay, which streamed the WHOLE transcript into the
    // buddy's own reducer — the same cost the main window just stopped paying,
    // duplicated in a second BrowserWindow.
    //
    // The buddy has no scroll-up sentinel this cycle: it is a glanceable recent
    // view, not a place to read back through a conversation.
    void (async () => {
      dispatch({ type: 'HISTORY_PAGE_REQUESTED', sessionId });
      try {
        const page = await (window as any).claude?.detach?.requestTranscriptPage?.({ sessionId, beforeCursor: null });
        if (cancelled) return;
        if (page) {
          dispatch({ type: 'HISTORY_PAGE_LOADED', sessionId, events: page.events, cursor: page.cursor, hasMore: page.hasMore });
        } else {
          dispatch({ type: 'HISTORY_PAGE_FAILED', sessionId });
        }
      } catch {
        if (!cancelled) dispatch({ type: 'HISTORY_PAGE_FAILED', sessionId });
      }
    })();

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      // Unregister: preload returns the raw handler for removeListener
      window.claude.off('transcript:event', unsubTranscript);
    };
  }, [sessionId, dispatch]);

  // ── Hook event subscription (permissions only) ────────────────────────────
  // Permission requests from hook:event transitions tool cards to approval
  // state. hookEventToAction maps PermissionRequest → PERMISSION_REQUEST and
  // PermissionExpired → PERMISSION_EXPIRED; all other hook types return null.
  useEffect(() => {
    if (!sessionId) return;

    const unsubHook = window.claude.on.hookEvent((event: any) => {
      if (event?.sessionId !== sessionId) return;
      const action = hookEventToAction(event);
      if (action) dispatch(action);
    });
    // Specialists 1c: delegation feed — MUST mirror App.tsx. Task 10: typed
    // bridge — on.specialistEvent returns the unsubscribe function directly,
    // and there is no separate 'note' event kind (a note rides on the run
    // record; SPECIALIST_RUN_CHANGED's reducer case derives the Activity row).
    const unsubSpecialist = window.claude.on.specialistEvent((event) => {
      if (event.sessionId !== sessionId) return;
      if (event.kind === 'run') {
        dispatch({ type: 'SPECIALIST_RUN_CHANGED', sessionId, run: event.run });
      }
    });

    // G-1: background command records — MUST mirror App.tsx.
    const unsubShell = window.claude.on.shellEvent((event) => {
      if (event.sessionId !== sessionId) return;
      dispatch({ type: 'SHELL_RUN_CHANGED', sessionId, run: event.run });
    });

    return () => {
      window.claude.off('hook:event', unsubHook);
      // Task 10 fix: unsubSpecialist IS the unsubscribe function, not a
      // listener for `.off()` — see the matching fix in App.tsx.
      unsubSpecialist();
      unsubShell();
    };
  }, [sessionId, dispatch]);

  // ── Auto-scroll ───────────────────────────────────────────────────────────
  const scrollToBottom = useCallback(() => {
    const c = scrollContainerRef.current;
    if (c) c.scrollTop = c.scrollHeight;
  }, []);

  // Track whether user has manually scrolled up
  useEffect(() => {
    const sentinel = bottomRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => { atBottomRef.current = entry.isIntersecting; },
      { threshold: 0.1, rootMargin: '0px 0px 80px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  // Auto-scroll when new content arrives and user is pinned to bottom
  useEffect(() => {
    if (atBottomRef.current) scrollToBottom();
  }, [state.timeline.length, state.lastActivityAt, state.isThinking, scrollToBottom]);

  // ── Memoize tool status for the current turn ──────────────────────────────
  const { hasAwaitingApproval, hasRunningTools, awaitingTools } = useMemo(() => {
    let hasAwaiting = false;
    let hasRunning = false;
    const awaiting: any[] = [];
    for (const id of state.activeTurnToolIds) {
      const t = state.toolCalls.get(id);
      if (!t) continue;
      if (t.status === 'awaiting-approval') { hasAwaiting = true; awaiting.push(t); }
      else if (t.status === 'running') hasRunning = true;
    }
    return { hasAwaitingApproval: hasAwaiting, hasRunningTools: hasRunning, awaitingTools: awaiting };
  }, [state.toolCalls, state.activeTurnToolIds]);

  // ── No sessionId guard ────────────────────────────────────────────────────
  if (!sessionId) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>No session selected</span>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div ref={scrollContainerRef} className="buddy-bubble-feed" style={{ overflowY: 'auto', height: '100%' }}>
      {state.timeline.length === 0 && !state.isThinking ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
          <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>No messages yet</span>
        </div>
      ) : (
        <>
          {(() => {
            // Fade entries above the most recent compaction marker — Claude's
            // context no longer includes them, consistent with main ChatView.
            let lastCompactIdx = -1;
            for (let i = state.timeline.length - 1; i >= 0; i--) {
              const e = state.timeline[i];
              if (e.kind === 'system-marker' && e.marker.variant === 'compact') {
                lastCompactIdx = i;
                break;
              }
            }
            return state.timeline.map((entry, idx) => {
              const isPreCompaction = lastCompactIdx >= 0 && idx < lastCompactIdx;
              let key: string;
              let content: React.ReactNode;

              switch (entry.kind) {
                case 'user':
                  key = entry.message.id;
                  // sessionId ?? '' — the buddy window has no ArtifactProvider, so
                  // FilepathToken pills render but their click is a documented no-op.
                  // Host-injected turn → compact report card, MUST mirror ChatView.tsx.
                  content = entry.injected
                    ? <SpecialistReportCard message={entry.message} injected={entry.injected} meta={entry.injectedMeta} sessionId={sessionId ?? ''} showTimestamps={showTimestamps} />
                    : <UserMessage message={entry.message} sessionId={sessionId ?? ''} showTimestamps={showTimestamps} />;
                  break;
                case 'assistant-turn': {
                  const turn = state.assistantTurns.get(entry.turnId);
                  // Shared gate (chat-types.ts) — one function keeps this
                  // mirrored with ChatView.tsx by construction.
                  if (!shouldRenderAssistantTurn(turn)) return null;
                  key = entry.turnId;
                  content = (
                    <AssistantTurnBubble
                      turn={turn}
                      toolGroups={state.toolGroups}
                      toolCalls={state.toolCalls}
                      sessionId={sessionId}
                      showTimestamps={showTimestamps}
                    />
                  );
                  break;
                }
                case 'prompt':
                  key = entry.prompt.promptId;
                  content = (
                    <PromptCard
                      prompt={entry.prompt}
                      sessionId={sessionId}
                      onSelect={(button) => sendPromptInput(sessionId, button)}
                      keyboardShortcuts={false}
                    />
                  );
                  break;
                case 'usage-card':
                  key = entry.snapshot.entryId;
                  content = <UsageCard snapshot={entry.snapshot} />;
                  break;
                case 'system-marker':
                  key = entry.marker.id;
                  content = <SystemMarker marker={entry.marker} />;
                  break;
                case 'compacting':
                  key = entry.id;
                  content = <CompactingCard startedAt={entry.startedAt} />;
                  break;
                case 'copy-picker':
                  // Copy picker is a transient command UI — skip in buddy (read-only viewer)
                  return null;
                default:
                  return null;
              }

              return (
                <div
                  key={key!}
                  className={`timeline-entry${isPreCompaction ? ' opacity-60 transition-opacity' : ''}`}
                  title={isPreCompaction ? "Archived by compaction — not in Claude's active context" : undefined}
                >
                  {content}
                </div>
              );
            });
          })()}

          {/* Awaiting-approval tools rendered as a compact strip — buddy-specific.
              CompactToolStrip shows a slim pill when idle and auto-expands with
              inline Allow/Deny/Always buttons when approval is needed. Uses the
              same IPC + reducer dispatch path as main's <ToolCard> so there is
              no divergence between the two permission-response code paths. */}
          {awaitingTools.length > 0 && (
            <div style={{ padding: '4px 16px' }}>
              <CompactToolStrip
                tools={awaitingTools}
                sessionId={sessionId}
              />
            </div>
          )}

          {/* Thinking indicator — only shown when no tool is pending.
              Buddy is a passive viewer so we only show 'ok' state (no attention
              banners — the buddy floater's AttentionStrip in E5 owns that UX). */}
          {/* `!compactionPending` mirrors ChatView: CompactingCard is already
              the status for a compaction, so don't stack a second spinner
              under it. (Destin, 2026-08-16) */}
          {state.isThinking && !hasAwaitingApproval && !hasRunningTools && !state.compactionPending && (
            <ThinkingIndicator />
          )}
        </>
      )}
      <div ref={bottomRef} className="h-1" />
    </div>
  );
}
