import { useEffect, useRef } from 'react';
import { useChatStateMap } from '../state/chat-context';
import { serializeChatState } from '../state/chat-types';

/**
 * Mount-only component. Holds a ref to the latest ChatState, listens for
 * `chat:export-snapshot` from the main process, and sends the serialized
 * snapshot back. Used by the remote-access server to hand a freshly-connected
 * browser client the full chat history in a single message.
 *
 * Only active in Electron (window.claude.onChatExportSnapshot is undefined
 * in the WebSocket remote shim).
 */
export function RemoteSnapshotExporter() {
  const chatState = useChatStateMap();
  const chatStateRef = useRef(chatState);

  useEffect(() => {
    chatStateRef.current = chatState;
  }, [chatState]);

  useEffect(() => {
    const api = (window as any).claude;
    if (typeof api?.onChatExportSnapshot !== 'function') return;

    const unsubscribe = api.onChatExportSnapshot((requestId: string) => {
      try {
        const snapshot = serializeChatState(chatStateRef.current);
        api.sendChatSnapshotResponse({ requestId, snapshot });
      } catch (err) {
        console.error('[RemoteSnapshotExporter] serialize failed:', err);
        api.sendChatSnapshotResponse({ requestId, snapshot: { sessions: [] } });
      }
    });

    return unsubscribe;
  }, []);

  return null;
}
