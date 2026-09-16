// Run a callback after a remote access reconnect. The event never fires on the desktop, so this
// is inert there.
//
// WHY (Destin, 2026-09-11 phone pass: the new-session project list was empty, then "randomly
// popped back in"): screens that load once on mount kept whatever a request lost during a drop
// left them, usually nothing, until something remounted them. The shim tells the page when a
// reconnect's sign-in is done (REMOTE_RECONNECTED_EVENT); a screen that loads data asks again.
// The callback is read through a ref, so a fresh closure never re-subscribes.
import { useEffect, useRef } from 'react';
import { REMOTE_RECONNECTED_EVENT } from '../remote-events';

export function useOnRemoteReconnect(callback: () => void): void {
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    const onReconnect = () => ref.current();
    window.addEventListener(REMOTE_RECONNECTED_EVENT, onReconnect);
    return () => window.removeEventListener(REMOTE_RECONNECTED_EVENT, onReconnect);
  }, []);
}
