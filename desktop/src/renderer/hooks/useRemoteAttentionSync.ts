import { useEffect, useRef } from 'react';
import { useChatStateMap } from '../state/chat-context';
import type { AttentionState } from '../state/chat-types';

/**
 * Fires `remote:attention-changed` over IPC when any session's attentionState
 * diffs from the previous tick. Lets the main process maintain a per-session
 * cache for the remote-access status:data broadcast, so browser clients see
 * StatusDot colors that match the desktop in near-real-time (rather than
 * running their own PTY classifier and risking drift).
 */
export function useRemoteAttentionSync() {
  const chatState = useChatStateMap();
  const lastByIdRef = useRef<Map<string, AttentionState>>(new Map());

  useEffect(() => {
    const api = (window as any).claude;
    if (typeof api?.fireRemoteAttentionChanged !== 'function') return;

    const last = lastByIdRef.current;
    for (const [sessionId, session] of chatState) {
      const prev = last.get(sessionId);
      if (prev !== session.attentionState) {
        last.set(sessionId, session.attentionState);
        api.fireRemoteAttentionChanged({ sessionId, state: session.attentionState });
      }
    }
    // Clean up removed sessions so we don't keep stale entries in the ref.
    for (const sessionId of Array.from(last.keys())) {
      if (!chatState.has(sessionId)) last.delete(sessionId);
    }
  }, [chatState]);
}
