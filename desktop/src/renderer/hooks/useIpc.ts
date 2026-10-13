import { useEffect, useRef } from 'react';
// WHY (2026-09-29 one-core R2): the `declare global` that described window.claude lived here
// (~540 lines, a second copy of the bridge types). It now lives in shared/backend-contract.ts,
// which declares Window['claude'] from the one contract preload, remote-shim and the workbench's
// mock-shim are all checked against (tsconfig includes src/**, so it is always in the program).

export function usePtyOutput(
  sessionId: string | null,
  onData: (data: string) => void,
) {
  const cbRef = useRef(onData);
  cbRef.current = onData;

  useEffect(() => {
    if (!sessionId) return;

    // Use per-session channel if available (avoids N+1 callback amplification)
    const claude = window.claude as any;
    if (claude?.on?.ptyOutputForSession) {
      return claude.on.ptyOutputForSession(sessionId, (data: string) => cbRef.current(data));
    }

    // Fallback: global channel with client-side filter
    const handler = window.claude.on.ptyOutput((sid, data) => {
      if (sid === sessionId) {
        cbRef.current(data);
      }
    });

    return () => {
      window.claude.off('pty:output', handler);
    };
  }, [sessionId]);
}
