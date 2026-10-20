import { useCallback, useSyncExternalStore } from 'react';
import { getNativeStartup, subscribeNativeStartup } from '../state/native-startup-store';

/** A status-only subscription: streamed text does not redraw the startup notice/composer. */
export function useNativeStartup(sessionId: string | null | undefined) {
  const subscribe = useCallback((listener: () => void) => subscribeNativeStartup(sessionId, listener), [sessionId]);
  const snapshot = useCallback(() => getNativeStartup(sessionId), [sessionId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
