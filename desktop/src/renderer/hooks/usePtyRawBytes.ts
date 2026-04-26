import { useEffect, useRef } from 'react';

// Pull in the augmented Window.claude declaration so the optional
// ptyRawBytesForSession field is typed without an `as any` cast below.
import './useIpc';

/**
 * Subscribe to the per-session pty:raw-bytes push event (Tier 2 of
 * android-terminal-data-parity). Payload is base64-encoded raw PTY bytes
 * emitted by Android's RawByteListener; this hook decodes to Uint8Array.
 *
 * On desktop (Electron preload), the underlying ptyRawBytesForSession is a
 * no-op stub that returns a no-op unsubscriber — the hook still mounts
 * safely but its callback will never fire because Electron PTY emits
 * pty:output strings instead.
 *
 * Malformed base64 is silently ignored to avoid crashing the renderer if
 * the bridge ever emits a corrupt frame; the byte stream resumes on the
 * next valid frame.
 */
export function usePtyRawBytes(
  sessionId: string | null,
  onData: (data: Uint8Array) => void,
): void {
  // cbRef pattern matches usePtyOutput — keeps the effect from re-running
  // every render just because the consumer's callback closure changed.
  const cbRef = useRef(onData);
  cbRef.current = onData;

  useEffect(() => {
    if (!sessionId) return;

    // Optional-chain through the typed shape so TS catches a future rename
    // and avoids leaking `any` into this scope.
    const subscribe = window.claude?.on?.ptyRawBytesForSession;
    if (!subscribe) return;

    return subscribe(sessionId, (base64: string) => {
      try {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        cbRef.current(bytes);
      } catch {
        // Malformed base64 — drop this frame; PTY recovers on next valid frame.
      }
    });
  }, [sessionId]);
}
