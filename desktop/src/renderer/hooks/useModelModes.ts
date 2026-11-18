import { useEffect, useState } from 'react';

/**
 * Saved Fast + Effort values for the status-bar chips. `read` stays false until a real answer has arrived,
 * so the chips can stay hidden instead of showing "auto / off" as if the user had chosen that
 * (card #134 round 4, Destin Q-1). A failed or non-object answer (including a phone's "not available here")
 * leaves `read` as it was: hidden if never read, last real values if read before. No error is shown.
 * Re-reads whenever `reloadKey` changes (the model picker closing).
 */
export function useModelModes(reloadKey: unknown) {
  const [fast, setFast] = useState(false);
  const [effort, setEffort] = useState('auto');
  const [read, setRead] = useState(false);
  useEffect(() => {
    const api = (window.claude as any)?.modes;
    if (!api) return;
    let cancelled = false;
    Promise.resolve(api.get()).then((m: { fast?: boolean; effort?: string }) => {
      if (cancelled || !m || typeof m !== 'object') return;
      setFast(!!m.fast);
      if (m.effort) setEffort(m.effort);
      setRead(true);
    }).catch(() => { /* stay hidden / keep last values — silence over a false notice */ });
    return () => { cancelled = true; };
  }, [reloadKey]);
  return { fast, effort, read };
}
