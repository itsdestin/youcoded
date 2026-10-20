import { useEffect, useRef } from 'react';

// Pull in the augmented Window.claude declaration so the optional
// ptyRawBytesForSession field is typed without an `as any` cast below.
import './useIpc';

/**
 * Decode the retained legacy per-session pty:raw-bytes event to Uint8Array.
 * WHY retain the capability gate: current desktop and rebuilt Android hosts
 * advertise text transport and emit pty:output, so TerminalView passes null
 * and this hook does not subscribe. Do not infer raw transport from Android.
 * Electron preload also retains a no-op ptyRawBytesForSession stub.
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
