import React, { useEffect, useRef, useCallback, useMemo } from 'react';
import { useChatState, useChatDispatch } from '../../state/chat-context';
import { hookEventToAction } from '../../state/hook-dispatcher';
import { decideFirstPage, FIRST_PAGE_RETRY_MS } from '../../state/first-page-retry';
import UserMessage from '../UserMessage';
import SpecialistReportCard from '../SpecialistReportCard';
import AssistantTurnBubble from '../AssistantTurnBubble';
import { shouldRenderAssistantTurn } from '../../state/chat-types';
import { CompactToolStrip } from './CompactToolStrip';
import { helperAsksOf } from '../../utils/specialist-cards';
import PromptCard from '../PromptCard';
import { sendPromptInput } from '../../state/prompt-input';
import UsageCard from '../UsageCard';
import SystemMarker from '../SystemMarker';
import CompactingCard from '../CompactingCard';
import ThinkingIndicator from '../ThinkingIndicator';
import { useTheme } from '../../state/theme-context';
import { useEntryFolding } from '../../hooks/use-entry-folding';
import { findArchiveBoundary, archivedTooltip } from '../../state/archive-boundary';
import { eventToAction } from '../../state/transcript-event-actions';
import { BUDDY_LIVE } from './buddy-live-events';
import type { TranscriptEventType } from '../../../shared/types';

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
  // Perf: wraps everything the feed renders so a ResizeObserver can watch the
  // content GROW (the scroll container itself is height:100% and never resizes).
  // Mirrors ChatView.tsx's contentRef — see the observer effect below.
  const contentRef = useRef<HTMLDivElement>(null);

  // Perf cycle 3, extended to the buddy floater (Task 7): a distant entry
  // renders as a same-height spacer instead of its full body
  // (use-entry-folding.ts) — the buddy feed renders the SAME long-running
  // conversation the main chat does, so it pays the identical per-node cost
  // as a session grows without this.
  // WHY always enabled (unlike ChatView's `!findOpen`): nothing opens a find
  // bar over the buddy feed — `ContentFindBar` only hosts in ChatView and the
  // drawer's own artifact branch, and BubbleFeed has neither — so there is no
  // DOM-walking search this could ever need to suspend for.
  const folding = useEntryFolding(true, scrollContainerRef);

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
      // The buddy's three known live gaps (see the ledger). An unknown type has no
      // ledger row; eventToAction ignores it.
      const rule = BUDDY_LIVE[event.type as TranscriptEventType];
      if (rule && rule !== 'same') return;

      // WHY one translator: this feed shares `eventToAction` with the main window
      // instead of keeping its own copy of every case. The buddy has no CC statusline,
      // so there is no fallback figure for a compaction marker's "after" number.
      for (const action of eventToAction(event, {
        live: true,
        compactionPending: !!stateRef.current.compactionPending,
        fallbackContextTokens: null,
      })) batchDispatch(action);
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
      // Retried, and on the same terms as the main window's first page
      // (first-page-retry.ts). The floater has no scroll-up sentinel, so a
      // single attempt that main could not resolve — a just-resumed session
      // whose transcript path CC has not reported yet — silently showed a feed
      // starting mid-conversation, with nothing to nudge it.
      for (let attempt = 0; ; attempt++) {
        try {
          const page = await (window as any).claude?.detach?.requestTranscriptPage?.({ sessionId, beforeCursor: null });
          if (cancelled) return;
          if (!page) { dispatch({ type: 'HISTORY_PAGE_FAILED', sessionId }); return; }
          const decision = decideFirstPage(page, attempt);
          if (decision === 'accept') {
            // WHY: the buddy has its own reducer, so it must apply the same recovery verdict as App.
            dispatch({ type: 'HISTORY_PAGE_LOADED', sessionId, events: page.events, cursor: page.cursor, hasMore: page.hasMore,
              reconcileInterrupted: page.reconcileInterrupted === true, reconcileInterruptedToolIds: page.reconcileInterruptedToolIds });
            return;
          }
          if (decision === 'give-up') { dispatch({ type: 'HISTORY_PAGE_FAILED', sessionId }); return; }
        } catch {
          if (!cancelled) dispatch({ type: 'HISTORY_PAGE_FAILED', sessionId });
          return;
        }
        await new Promise((r) => setTimeout(r, FIRST_PAGE_RETRY_MS));
        if (cancelled) return;
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
  // Is the feed showing the timeline (rather than the "No messages yet" state)?
  // Kept next to the render branch it mirrors, one screen down, and used as the
  // ResizeObserver's re-attach trigger.
  const hasContent = state.timeline.length > 0 || state.isThinking;

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

  // Auto-scroll when new content arrives and user is pinned to bottom.
  //
  // Perf: state.lastActivityAt used to be a dep here. The reducer re-stamps that
  // timestamp on EVERY streamed delta (and on tool events, heartbeats, …), and
  // scrollToBottom reads scrollHeight — which, right after a commit that dirtied
  // the DOM, is a forced synchronous layout of the whole document. So a streaming
  // buddy window paid one forced reflow per token. The growth those deltas cause
  // is now re-pinned by the ResizeObserver on contentRef below, which runs AFTER
  // layout, where the same read is free. This is the exact twin of the ChatView
  // fix (perf cycle 1, N2). Pinned by tests/bubblefeed-scroll-pin-deps.test.tsx.
  useEffect(() => {
    if (atBottomRef.current) scrollToBottom();
  }, [state.timeline.length, state.isThinking, scrollToBottom]);

  // Perf: the observer that took over per-token re-pinning from the timestamp
  // dep above. It fires after layout, so reading scrollHeight in the callback
  // costs nothing, and it also catches growth the reducer cannot see at all —
  // a tool card expanding, an image or code block laying out a frame late.
  // Ported from ChatView.tsx's "Watch the content wrapper's size" effect; the
  // only changes are the pinned-to-bottom test (atBottomRef here, stickRef there)
  // and the hasContent dep explained below.
  //
  // atBottomRef (not React state) for the same reason ChatView reads stickRef: a
  // native session dispatches one delta per streamed token, so a state value is
  // always a render behind and would undo a scroll the user just made.
  //
  // hasContent is a dep because — unlike ChatView, which always renders its
  // wrapper -- this feed swaps the wrapper out for a height:100% empty state, so
  // contentRef.current is null until the first entry arrives and the effect has
  // to re-run to attach then.
  useEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    let lastHeight = node.scrollHeight;
    const observer = new ResizeObserver(() => {
      const next = node.scrollHeight;
      if (next > lastHeight && atBottomRef.current) {
        scrollToBottom();
      }
      lastHeight = next;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasContent, scrollToBottom]);

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
    // Helper (specialist) requests too, from any turn — same reason as the
    // main chat's bottom cards (helperAsksOf).
    const helper = helperAsksOf(state.toolCalls);
    // hasAwaitingApproval stays about THIS turn (it only hides the thinking
    // indicator), matching ChatView: a background helper's request doesn't
    // mean the main assistant has stopped thinking.
    return { hasAwaitingApproval: hasAwaiting, hasRunningTools: hasRunning, awaitingTools: [...awaiting, ...helper] };
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
      {!hasContent ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
          <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>No messages yet</span>
        </div>
      ) : (
        // Perf: a real element rather than a fragment so the ResizeObserver above
        // has something to observe. A plain auto-height block, and no CSS selects
        // .buddy-bubble-feed or its children, so the entries lay out as before.
        <div ref={contentRef}>
          {(() => {
            // Fade entries above the most recent compaction marker — Claude's
            // context no longer includes them, consistent with main ChatView.
            // WHY the shared helper: a native compaction keeps a recent tail
            // above its marker, and only archive-boundary.ts knows to stop the
            // fade there. Compact-only, as before: the buddy never faded /clear.
            const lastCompactIdx = findArchiveBoundary(state.timeline, ['compact']).index;
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

              // Folded: render the wrapper at exactly the height its body last
              // occupied and omit the body — same shape as ChatView.tsx's
              // fold wrapper (this feed MUST mirror it).
              const folded = folding.isFolded(key!);
              const foldHeight = folded ? folding.heightOf(key!) : undefined;
              return (
                <div
                  key={key!}
                  ref={folding.registerEntry}
                  data-entry-key={key!}
                  className={`timeline-entry${isPreCompaction ? ' opacity-60 transition-opacity' : ''}`}
                  title={isPreCompaction ? archivedTooltip('compact') : undefined}
                  style={folded && foldHeight ? { height: foldHeight } : undefined}
                >
                  {folded && foldHeight ? null : content}
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
        </div>
      )}
      <div ref={bottomRef} className="h-1" />
    </div>
  );
}
