import { useCallback, useMemo } from 'react';
import type React from 'react';
import { dispatchSlashCommand, type DispatcherCallbacks, type DispatcherResult, type ViewMode } from '../state/slash-command-dispatcher';
import type { ChatAction } from '../state/chat-types';
import type { SyncWarning } from '../../main/sync-state';

// What App hands the StatusBar, made stable across renders.
//
// WHY (2026-09-16 audit W21): App built the bar's `statusData` object and its
// handlers inline in JSX, so every one of the shell's ~60 state changes — a
// toast, a popup, a drawer — re-rendered the 1,700-line bar whether or not
// anything it shows had changed, and React.memo on the bar could never hit.
// The projection is memoised on the seven values the bar actually reads; the
// slash dispatcher keeps reading the chat-state MAP through its ref (never in
// the dependency list — chat state must not re-create the handler per token).

/** The slice of App's status feed the bar's projection reads. */
export interface StatusFeed<S> {
  usage: any;
  chatgptUsage: any;
  updateStatus: any;
  announcement: any;
  contextMap: Record<string, number>;
  gitBranchMap: Record<string, string>;
  sessionStatsMap: Record<string, S>;
  syncWarnings: SyncWarning[] | null;
}

export function useStatusBarData<S>(feed: StatusFeed<S>, sessionId: string | null, onChatGptPlan: boolean) {
  const usage = onChatGptPlan ? feed.chatgptUsage : feed.usage;
  const contextPercent = sessionId ? (feed.contextMap[sessionId] ?? null) : null;
  const gitBranch = sessionId ? (feed.gitBranchMap[sessionId] ?? null) : null;
  const sessionStats: S | null = sessionId ? (feed.sessionStatsMap[sessionId] ?? null) : null;
  const { updateStatus, announcement, syncWarnings } = feed;
  return useMemo(
    () => ({ usage, updateStatus, announcement, contextPercent, gitBranch, sessionStats, syncWarnings }),
    [usage, updateStatus, announcement, contextPercent, gitBranch, sessionStats, syncWarnings],
  );
}

/** The bar's popup-dispatched slash commands (/usage, /config …). */
export function useStatusBarDispatch(a: {
  sessionId: string | null;
  view: ViewMode;
  /** The active session's provider; a native session defers UI effects to the runtime. */
  provider: string | undefined;
  dispatch: React.Dispatch<ChatAction>;
  /** Read at dispatch time, never a dependency — see the header. */
  chatStateMapRef: { current: Map<string, { timeline: any[] }> };
  runSlashResult: (sid: string, result: DispatcherResult) => boolean;
  callbacks: DispatcherCallbacks;
}): (input: string) => void {
  const { sessionId, view, provider, dispatch, chatStateMapRef, runSlashResult, callbacks } = a;
  return useCallback((input: string) => {
    if (!sessionId) return;
    // Pass live timeline (drawer paths pass []) so future popup-dispatched commands
    // that inspect history can read it without rewiring this wrapper.
    const timeline = chatStateMapRef.current.get(sessionId)?.timeline ?? [];
    const result = dispatchSlashCommand({
      raw: input,
      sessionId,
      view,
      files: [],
      dispatch,
      timeline,
      callbacks,
      deferUiEffectsToRuntime: provider === 'native',
    });
    // Forward alsoSendToPty so Claude Code itself runs the command. We deliberately skip the
    // USER_PROMPT optimistic bubble that InputBar dispatches — for /compact and /clear, the
    // COMPACTION_PENDING / CLEAR_TIMELINE reducer actions already update the timeline, so a
    // USER_PROMPT bubble would render redundantly alongside them.
    runSlashResult(sessionId, result);
  }, [sessionId, view, provider, dispatch, chatStateMapRef, runSlashResult, callbacks]);
}
