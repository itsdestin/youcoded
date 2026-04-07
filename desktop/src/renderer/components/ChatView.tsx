import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useChatState, useChatDispatch } from '../state/chat-context';
import { onBufferReady } from '../hooks/terminal-registry';
import UserMessage from './UserMessage';
import AssistantTurnBubble from './AssistantTurnBubble';
import ToolCard from './ToolCard';
import PromptCard from './PromptCard';
import ThinkingIndicator from './ThinkingIndicator';

interface Props {
  sessionId: string;
  visible: boolean;
  resumeInfo?: Map<string, { claudeSessionId: string; projectSlug: string }>;
}

function HistoryExpandButton({ sessionId, resumeInfo }: {
  sessionId: string;
  resumeInfo?: Map<string, { claudeSessionId: string; projectSlug: string }>;
}) {
  const dispatch = useChatDispatch();
  const [loading, setLoading] = useState(false);

  const handleExpand = async () => {
    const info = resumeInfo?.get(sessionId);
    if (!info) return;
    setLoading(true);
    try {
      const allMessages = await (window as any).claude.session.loadHistory(
        info.claudeSessionId, info.projectSlug, 0, true
      );
      if (allMessages.length > 0) {
        dispatch({
          type: 'HISTORY_LOADED',
          sessionId,
          messages: allMessages,
          hasMore: false,
        });
      }
    } catch {
      // Ignore
    }
    setLoading(false);
  };

  return (
    <div className="flex justify-center py-3">
      <button
        onClick={handleExpand}
        disabled={loading}
        className="text-xs text-fg-muted hover:text-fg-2 transition-colors disabled:opacity-50"
      >
        {loading ? 'Loading...' : '\u2191 See previous messages'}
      </button>
    </div>
  );
}

export default function ChatView({ sessionId, visible, resumeInfo }: Props) {
  const state = useChatState(sessionId);
  const dispatch = useChatDispatch();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const thinkingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Thinking timeout — if isThinking stays true with no activity for 60s, auto-clear.
  // lastActivityAt resets the clock whenever hook events or streaming updates arrive,
  // so the warning only fires after 60s of complete silence from Claude.
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  // Single pass — compute all tool status flags at once (avoids 3 separate array spreads)
  let hasAwaitingApproval = false;
  let hasRunningTools = false;
  const awaitingTools: any[] = [];
  for (const t of state.toolCalls.values()) {
    if (t.status === 'awaiting-approval') {
      hasAwaitingApproval = true;
      awaitingTools.push(t);
    } else if (t.status === 'running') {
      hasRunningTools = true;
    }
  }

  useEffect(() => {
    // Don't start the timeout when a tool is awaiting permission approval —
    // Claude is waiting for the user, not the other way around.
    if (state.isThinking && !hasAwaitingApproval) {
      thinkingTimerRef.current = setTimeout(() => {
        if (mountedRef.current) {
          dispatch({ type: 'THINKING_TIMEOUT', sessionId });
        }
      }, 30000);
    } else {
      if (thinkingTimerRef.current) {
        clearTimeout(thinkingTimerRef.current);
        thinkingTimerRef.current = null;
      }
    }
    return () => {
      if (thinkingTimerRef.current) clearTimeout(thinkingTimerRef.current);
    };
  }, [state.isThinking, state.lastActivityAt, hasAwaitingApproval, sessionId, dispatch]);

  // Reset the thinking timer when the terminal buffer receives output.
  // During extended thinking, Claude's CLI renders a spinner/timer in the PTY
  // but fires no hook events, so lastActivityAt goes stale.  Listening to
  // buffer writes keeps the timeout from triggering prematurely.
  const isThinkingRef = useRef(state.isThinking);
  isThinkingRef.current = state.isThinking;

  // Throttle TERMINAL_ACTIVITY dispatches — the thinking timeout only needs
  // a heartbeat every few seconds, not a dispatch on every PTY write.
  const lastActivityDispatchRef = useRef(0);
  useEffect(() => {
    return onBufferReady((sid) => {
      if (sid === sessionId && isThinkingRef.current) {
        const now = Date.now();
        if (now - lastActivityDispatchRef.current > 5000) {
          lastActivityDispatchRef.current = now;
          dispatch({ type: 'TERMINAL_ACTIVITY', sessionId });
        }
      }
    });
  }, [sessionId, dispatch]);

  // Scroll to bottom when switching sessions
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [sessionId]);

  // Track whether user is scrolled to bottom
  useEffect(() => {
    const sentinel = bottomRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      ([entry]) => setAtBottom(entry.isIntersecting),
      { threshold: 0.1, rootMargin: '0px 0px 150px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  // Auto-scroll when new content arrives and user is at bottom.
  // assistantTurns and toolCalls are new Map references on every reducer update,
  // so they trigger scroll for text appends, tool results, etc. — not just timeline growth.
  useEffect(() => {
    if (atBottom && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'auto' });
    }
  }, [state.timeline.length, state.assistantTurns, state.toolCalls, state.isThinking, atBottom]);

  const jumpToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Arrow key scrolling with acceleration when not typing
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollSpeed = useRef(0);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;

      e.preventDefault();
      const container = scrollContainerRef.current;
      if (!container) return;

      // Accelerate: start at 40px, increase by 20px per repeat, cap at 300px
      scrollSpeed.current = Math.min(scrollSpeed.current + 20, 300);
      const direction = e.key === 'ArrowUp' ? -1 : 1;
      container.scrollBy({ top: direction * scrollSpeed.current, behavior: 'auto' });
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        scrollSpeed.current = 0;
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, []);

  const handlePromptSelect = useCallback(
    (promptId: string, input: string, label: string) => {
      // Send keystrokes to PTY to navigate the Ink menu
      window.claude.session.sendInput(sessionId, input);
      // Mark the prompt as completed in the UI
      dispatch({
        type: 'COMPLETE_PROMPT',
        sessionId,
        promptId,
        selection: label,
      });
    },
    [sessionId, dispatch],
  );

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: visible ? 'flex' : 'none',
        flexDirection: 'column',
      }}
    >
      <div ref={scrollContainerRef} className="chat-scroll flex-1 overflow-y-auto pt-4 pb-1">
        {state.timeline.length === 0 && !state.isThinking ? (
          <div className="flex items-center justify-center h-full text-fg-muted text-sm">
            Start a conversation with Claude
          </div>
        ) : (
          <>
            {state.timeline.map((entry) => {
              switch (entry.kind) {
                case 'user':
                  return <UserMessage key={entry.message.id} message={entry.message} />;
                case 'assistant-turn': {
                  const turn = state.assistantTurns.get(entry.turnId);
                  if (!turn || turn.segments.length === 0) return null;
                  return (
                    <AssistantTurnBubble
                      key={entry.turnId}
                      turn={turn}
                      toolGroups={state.toolGroups}
                      toolCalls={state.toolCalls}
                      sessionId={sessionId}
                    />
                  );
                }
                case 'prompt':
                  if (entry.prompt.promptId === '_history_expand' && !entry.prompt.completed) {
                    return (
                      <HistoryExpandButton
                        key={entry.prompt.promptId}
                        sessionId={sessionId}
                        resumeInfo={resumeInfo}
                      />
                    );
                  }
                  return (
                    <PromptCard
                      key={entry.prompt.promptId}
                      prompt={entry.prompt}
                      sessionId={sessionId}
                      onSelect={(input, label) => handlePromptSelect(entry.prompt.promptId, input, label)}
                    />
                  );
              }
            })}
            {/* Awaiting-approval tools pop out as standalone bubbles at the bottom */}
            {awaitingTools.map((tool) => (
                <div key={tool.toolUseId} className="flex justify-start px-4 py-0.5">
                  <div className="assistant-bubble max-w-[85%] rounded-2xl rounded-bl-sm bg-inset px-5 py-3">
                    <ToolCard tool={tool} sessionId={sessionId} />
                  </div>
                </div>
              ))}
            {/* Only show thinking when Claude is between tool completion and next text —
                not when tools are still running or awaiting approval */}
            {state.isThinking
              && !hasAwaitingApproval
              && !hasRunningTools
              && <ThinkingIndicator />}
          </>
        )}
        <div ref={bottomRef} className="h-1" />
      </div>

      {/* Jump to bottom button */}
      {!atBottom && (
        <button
          onClick={jumpToBottom}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 text-xs bg-inset hover:bg-edge text-fg-2 rounded-full shadow-lg transition-colors"
        >
          Jump to bottom
        </button>
      )}
    </div>
  );
}
