import { useEffect, useState } from 'react';
import type { AttentionSummary } from '../../shared/types';

/**
 * Subscribes to the main process's aggregated session attention summary.
 * Returns true iff ANY running session currently needs the user's attention
 * (awaiting-input, awaiting-approval, stuck, shell-idle, error). Backed by
 * the SESSION_ATTENTION_SUMMARY push channel (renderer reports via
 * ATTENTION_REPORT, main aggregates, main broadcasts).
 *
 * The <BuddyMascot> component uses this to swap its variant between
 * 'idle' and 'shocked' — a single ambient signal for "something wants you."
 */
export function useAnyAttentionNeeded(): boolean {
  const [needs, setNeeds] = useState(false);
  useEffect(() => {
    const unsub = window.claude.buddy.onAttentionSummary((summary: AttentionSummary) => {
      setNeeds(summary.anyNeedsAttention);
    });
    return unsub;
  }, []);
  return needs;
}
