import React, { useEffect, useRef, useCallback, useMemo } from 'react';
import { useChatState, useChatDispatch } from '../../state/chat-context';
import { hookEventToAction } from '../../state/hook-dispatcher';
import UserMessage from '../UserMessage';
import AssistantTurnBubble from '../AssistantTurnBubble';
import { CompactToolStrip } from './CompactToolStrip';
import PromptCard from '../PromptCard';
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
          });
          break;
        case 'assistant-text':
          batchDispatch({
            type: 'TRANSCRIPT_ASSISTANT_TEXT',
            sessionId: event.sessionId,
            uuid: event.uuid,
            text: event.data.text,
            timestamp: event.timestamp,
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
            structuredPatch: event.data.structuredPatch,
          });
          break;
        case 'turn-complete':
          batchDispatch({
            type: 'TRANSCRIPT_TURN_COMPLETE',
            sessionId: event.sessionId,
            uuid: event.uuid,
            timestamp: event.timestamp,
          });
          break;
        case 'assistant-thinking':
          batchDispatch({
            type: 'TRANSCRIPT_THINKING_HEARTBEAT',
            sessionId: event.sessionId,
          });
          break;
        // compact-summary: buddy doesn't drive compaction UI (no /compact command),
        // but we still need to close any pending compaction spinner if it was opened
        // because the owner session triggered compaction.
        case 'compact-summary':
          if (stateRef.current.compactionPending) {
            batchDispatch({
              type: 'COMPACTION_COMPLETE',
              sessionId: event.sessionId,
              markerId: `compact-done-${Date.now()}`,
              afterContextTokens: null,
            });
          }
          break;
      }
    });

    // Request replay AFTER the listener is wired so no historical events can
    // race past us. The callers in SessionPill/BuddyChat used to call this —
    // they no longer do (removed in the same commit) so this is the sole
    // request-replay site for the buddy window.
    window.claude.detach.requestTranscriptReplay(sessionId);

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

    return () => {
      window.claude.off('hook:event', unsubHook);
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
                  content = <UserMessage message={entry.message} showTimestamps={showTimestamps} />;
                  break;
                case 'assistant-turn': {
                  const turn = state.assistantTurns.get(entry.turnId);
                  if (!turn || turn.segments.length === 0) return null;
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
                      onSelect={(input) => window.claude.session.sendInput(sessionId, input)}
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
          {state.isThinking && !hasAwaitingApproval && !hasRunningTools && (
            <ThinkingIndicator />
          )}
        </>
      )}
      <div ref={bottomRef} className="h-1" />
    </div>
  );
}
