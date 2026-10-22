import { useCallback, useSyncExternalStore } from 'react';
import { useChatStore } from '../state/chat-context';
import { backgroundCommandList, type BackgroundCommand } from '../state/background-commands';

const NONE: BackgroundCommand[] = [];

/**
 * The session's background commands and watchers, oldest launch first — what the
 * "Background" status-bar chip reads (2026-10-22 status audit). Native shells and
 * Claude Code Bash / Monitor, including a helper's own (`ownerHelper`); helpers
 * themselves are the Subagents chip's (useSpecialistSummary).
 *
 * Perf (rule 3): a cached-selector hook over the chat store, like useSpecialists —
 * the array is the SAME object until a command launches or ends (the reducer
 * replaces the underlying record only then, never for streamed text or a shell's
 * tail), so the chip re-renders on those events and on nothing else.
 */
export function useBackgroundCommands(sessionId: string | undefined): BackgroundCommand[] {
  const store = useChatStore();
  const subscribe = useCallback(
    (cb: () => void) => (sessionId ? store.subscribeSession(sessionId, cb) : () => {}),
    [store, sessionId],
  );
  const getSnapshot = useCallback(
    () => (sessionId ? backgroundCommandList(store.getSession(sessionId)) : NONE),
    [store, sessionId],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}
