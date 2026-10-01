import { useEffect, useRef, useState } from 'react';
import { playSound } from '../utils/sounds';
import { viewedAfterSummaries } from './useSessionAttention';
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
export function useSessionSummaries(
  enabled: boolean,
  /** The screen's "viewed conversations" setter: a conversation that starts working is no longer viewed (so it turns blue when it finishes elsewhere). */
  setViewed?: (update: (prev: Set<string>) => Set<string>) => void,
): Record<string, SessionSummary> | null {
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

  // The "a turn finished" chime for a phone, from the summaries: a conversation it is not watching still finishes, and the person wants
  // to hear it (one-core R5-3). Only true -> false chimes; a conversation appearing already idle does not.
  const prevWorking = useRef<Map<string, boolean>>(new Map());
  useEffect(() => {
    if (!enabled || !summaries) { prevWorking.current = new Map(); return; }
    const next = new Map<string, boolean>();
    for (const [id, summary] of Object.entries(summaries)) {
      next.set(id, summary.working);
      if (prevWorking.current.get(id) === true && !summary.working) playSound('ready');
    }
    prevWorking.current = next;
  }, [enabled, summaries]);
  useEffect(() => {
    if (enabled && summaries && setViewed) setViewed((prev) => viewedAfterSummaries(prev, summaries) as Set<string>);
  }, [enabled, summaries, setViewed]);
  return enabled ? summaries : null;
}
