import { useEffect, useMemo, useState } from 'react';
import { namingApi } from './naming-api';

/**
 * Apply names renamed in THIS window to a session list the parent already
 * fetched. Renaming a saved session touches no live session, so there is no
 * SESSION_RENAMED broadcast to ride — the rename call dispatches this event
 * instead, and the row updates without a refetch.
 *
 * WHY project before render rather than patching the visible title slot: the
 * name also feeds layout, aria labels, tooltips and the search filter, and a
 * row whose label and title disagree is worse than one that lags.
 */
export function useRenamedSessions(sources: Record<string, string>) {
  const [names, setNames] = useState<Record<string, { title: string; source: string }>>({});
  useEffect(() => {
    if (!namingApi()) return;
    const update = (event: Event) => {
      const { id, title } = (event as CustomEvent<{ id: string; title: string }>).detail;
      setNames((old) => ({ ...old, [id]: { title, source: sources[id] } }));
    };
    window.addEventListener('youcoded:session-renamed', update);
    return () => window.removeEventListener('youcoded:session-renamed', update);
  }, [sources]);
  // WHY: the event bridges a stale parent snapshot; it is not a title
  // authority. Once that snapshot advances, its own name wins — including
  // after Use automatic name puts the generated name back.
  return useMemo(() => Object.fromEntries(Object.entries(names)
    .filter(([id, value]) => value.source === sources[id])
    .map(([id, value]) => [id, value.title])), [names, sources]);
}
