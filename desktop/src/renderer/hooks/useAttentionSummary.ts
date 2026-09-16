import { useEffect, useRef, useState } from 'react';
import type { AttentionSummary } from '../../shared/types';

const EMPTY: AttentionSummary = { anyNeedsAttention: false, perSession: {} };

/**
 * Main's cross-window attention aggregate: every window reports the FINISHED
 * dot colour of each session it owns (App's attention-reporter effect), main
 * merges the reports and pushes the merged map back to every window ~100ms
 * after any change.
 *
 * WHY the switcher needs this and not status:data's attentionMap: attentionMap
 * carries "needs attention" STATES only (stalled / error / awaiting-input), so
 * it can colour a peer session red or amber but can never say green — a peer
 * window's session that is happily working looks identical to an idle one. The
 * merged summary carries the colour itself, green included. The buddy's
 * SessionPill has drawn peer dots from this feed since it shipped; nothing but
 * the main switcher was missing.
 *
 * Pull first, then subscribe: the push fires on CHANGE only, so a window opened
 * while a peer session is mid-turn would otherwise show it grey until that turn
 * ended. Same race — and the same fix — as detach.getDirectory.
 */
export function useAttentionSummary(): AttentionSummary {
  const [summary, setSummary] = useState<AttentionSummary>(EMPTY);
  // Last accepted summary, reduced to the facts this window renders. WHY: main
  // pushes a fresh object on every reported change anywhere in the app, so a
  // peer window working away would re-render this window's whole tree several
  // times a second — including a window sitting idle with the switcher shut.
  // Only a change to a colour (or to "does anything need you") is worth a render.
  const signatureRef = useRef<string>('');
  useEffect(() => {
    let cancelled = false;
    // Shape guard, not just a try/catch: the workbench mock-shim answers every
    // channel it doesn't implement by hand with `[]`, which is truthy and has
    // no perSession — reading through it would throw on the first peer row.
    const accept = (s: unknown) => {
      if (cancelled || !s || typeof s !== 'object') return;
      const perSession = (s as AttentionSummary).perSession;
      if (!perSession || typeof perSession !== 'object') return;
      const signature = `${(s as AttentionSummary).anyNeedsAttention}|${Object.keys(perSession).sort()
        .map((id) => `${id}:${perSession[id]?.status ?? ''}`).join(',')}`;
      if (signature === signatureRef.current) return;
      signatureRef.current = signature;
      setSummary(s as AttentionSummary);
    };
    try {
      Promise.resolve(window.claude?.attention?.getSummary?.()).then(accept).catch(() => {});
    } catch { /* bridge not exposed yet — the push below still lands */ }
    // Defensive guard mirrors useAnyAttentionNeeded: buddy windows render in a
    // separate BrowserWindow where preload-init order is less predictable.
    if (!window.claude?.buddy?.onAttentionSummary) return () => { cancelled = true; };
    const unsub = window.claude.buddy.onAttentionSummary(accept as (s: AttentionSummary) => void);
    return () => { cancelled = true; unsub?.(); };
  }, []);
  return summary;
}
