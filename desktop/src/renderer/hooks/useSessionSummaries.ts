import { useEffect, useState } from 'react';
import type { SessionSummary } from '../../shared/session-summary-types';

/**
 * The computer's per-session summaries (`session:summary`), for a PHONE (one-core R5-3). Null until the first one arrives, and always
 * null when `enabled` is false: the computer's own windows keep deriving their dots from the events they receive, so this changes
 * nothing there.
 *
 * WHY it exists: a phone watches only the conversation on its screen and a few it looked at lately, so for every other conversation the
 * summary is the ONLY thing it hears. The dots, the attention sound and the "finished" chime for those conversations read it.
 *
 * Re-renders only when a summary actually changed: the computer pushes the whole map on any change anywhere and every 10 s, and a
 * phone sitting idle must not redraw its whole tree for an identical one (same reason as useAttentionSummary).
 */
export function useSessionSummaries(enabled: boolean): Record<string, SessionSummary> | null {
  const [summaries, setSummaries] = useState<Record<string, SessionSummary> | null>(null);
  useEffect(() => {
    if (!enabled) { setSummaries(null); return; }
    const subscribe = (window.claude?.on as { sessionSummary?: (cb: (p: unknown) => void) => () => void } | undefined)?.sessionSummary;
    if (typeof subscribe !== 'function') return;
    let last = '';
    const unsub = subscribe((payload) => {
      const next = (payload as { summaries?: Record<string, SessionSummary> } | null)?.summaries;
      // Shape guard: the workbench's mock answers channels it does not implement with `[]`, which has no summaries.
      if (!next || typeof next !== 'object' || Array.isArray(next)) return;
      const signature = JSON.stringify(next);
      if (signature === last) return;
      last = signature;
      setSummaries(next);
    });
    return () => { unsub?.(); };
  }, [enabled]);
  return enabled ? summaries : null;
}
