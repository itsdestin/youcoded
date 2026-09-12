import { useEffect, useRef } from 'react';

/**
 * Subscribe to `pty:reset:<sessionId>` — the host's "clear the terminal, a
 * full redraw follows" (remote access batch 2, design §7). Only the remote
 * shim ever fires it; preload declares a no-op subscriber for shape parity,
 * and a bridge without the method at all is treated the same way.
 *
 * Same cbRef pattern as usePtyOutput so the subscription does not churn when
 * the caller's closure changes.
 */
export function usePtyReset(sessionId: string | null, onReset: () => void): void {
  const cbRef = useRef(onReset);
  cbRef.current = onReset;

  useEffect(() => {
    if (!sessionId) return;
    const subscribe = (window.claude as any)?.on?.ptyResetForSession as
      | ((sid: string, cb: () => void) => () => void)
      | undefined;
    if (typeof subscribe !== 'function') return;
    return subscribe(sessionId, () => cbRef.current());
  }, [sessionId]);
}
