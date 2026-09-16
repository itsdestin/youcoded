import { useEffect } from 'react';
import { useChatStore } from '../state/chat-context';
import { serializeChatState } from '../state/chat-types';
import { flushTranscriptActions } from '../state/transcript-batch';

/**
 * Mount-only component. Listens for `chat:export-snapshot` from the main
 * process, flushes the pending transcript batch, and sends the serialized
 * store back. Used by the remote-access server to hand a freshly-connected
 * browser client the full chat history in a single message.
 *
 * WHY the flush and the synchronous store (remote access batch 2, design §1,
 * "the cut line"): the export request travels the same ordered channel as the
 * transcript events, so every event the host has already queued for the phone
 * has reached this window — but sat in the animation-frame batch, and the old
 * exporter read a ref that lagged a render behind. The phone then received a
 * snapshot missing the last frame's deltas and had those deltas applied on top
 * of it. Flushing first and reading `store.getState()` right after makes the
 * snapshot contain exactly what arrived before the request — by construction.
 * Pinned by tests/remote-snapshot-cut-line.test.tsx.
 *
 * Only active in Electron (window.claude.onChatExportSnapshot is undefined
 * in the WebSocket remote shim).
 */
export function RemoteSnapshotExporter() {
  // Effect-only reader: the store is read inside the export callback, never
  // during render, so this cannot tear (see chat-context.ts).
  const store = useChatStore();

  useEffect(() => {
    const api = (window as any).claude;
    if (typeof api?.onChatExportSnapshot !== 'function') return;

    const unsubscribe = api.onChatExportSnapshot((requestId: string) => {
      try {
        flushTranscriptActions();
        const state = store.getState();
        // Batch 2 (§2): sessions whose history page is still arriving. Read HERE,
        // because serializeChatState normalises `loading` to false for the wire —
        // main omits these from the merged snapshot rather than hand a phone half.
        const loadingSessionIds = [...state].filter(([, s]) => s.history?.loading).map(([id]) => id);
        const snapshot = serializeChatState(state);
        api.sendChatSnapshotResponse({ requestId, snapshot, loadingSessionIds });
      } catch (err) {
        // Fix: flag the fallback as degraded so the connecting client can tell
        // a serialization failure apart from a host with no sessions, instead
        // of applying the empty payload over its live state.
        console.error('[RemoteSnapshotExporter] serialize failed:', err);
        api.sendChatSnapshotResponse({ requestId, snapshot: { sessions: [], degraded: true } });
      }
    });

    return unsubscribe;
  }, [store]);

  return null;
}
