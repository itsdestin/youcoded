import { useEffect, useState } from 'react';

export interface ArtifactBytesState {
  bytes: Uint8Array | null;
  loading: boolean;
  error: string | null;
  /** The file's real size when the host refused with `too-large` — a phone
   *  shows it on the card that offers Download instead of a preview. */
  sizeBytes?: number;
}

// Decode a base64 string to bytes in the renderer. atob is available in both
// Electron and the remote browser; it yields a binary string we copy byte-wise.
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Load a file's raw bytes through the artifacts:read-binary IPC. Binary viewers
// (xlsx/docx/pdf/image) use this instead of fetch('file://…'), which the renderer
// can't do from the http(dev)/app(prod)/asset(Android) origin. Works on desktop,
// remote (routed to the host over WS), and Android (Kotlin base64 read).
export function useArtifactBytes(absolutePath: string): ArtifactBytesState {
  const [state, setState] = useState<ArtifactBytesState>({ bytes: null, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ bytes: null, loading: true, error: null });
    const readBinary = (window.claude as any)?.artifacts?.readBinary;
    if (typeof readBinary !== 'function') {
      setState({ bytes: null, loading: false, error: 'unavailable' });
      return;
    }
    readBinary(absolutePath)
      .then((res: any) => {
        if (cancelled) return;
        if (res?.ok && typeof res.base64 === 'string') {
          setState({ bytes: base64ToBytes(res.base64), loading: false, error: null });
        } else {
          setState({ bytes: null, loading: false, error: res?.error ?? 'read-failed', sizeBytes: res?.sizeBytes });
        }
      })
      .catch((e: any) => {
        if (!cancelled) setState({ bytes: null, loading: false, error: String(e?.message ?? e) });
      });
    return () => { cancelled = true; };
  }, [absolutePath]);

  return state;
}
