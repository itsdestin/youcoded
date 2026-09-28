// Live count of a session's still-present artifacts.
//
// Extracted from ArtifactDrawerButton so the narrow-viewport overflow menu can
// show the same number on its "Session Files" row. Two ways a file stops
// being present:
//   1. status === 'deleted' — an explicit Delete tool version (rare; CC has no
//      Delete tool, so this mostly never happens).
//   2. "orphan" — the file was removed via `bash rm` (which produces NO
//      artifact event), so the record stays status:'active' but the file is
//      gone from disk.
//
// Orphan detection is NOT done here: it lives in the shared, project-scoped
// useMissingArtifacts cache so this badge and the Session Drawer's list can
// never disagree, and so the badge (mounted for the whole session) warms that
// cache before the drawer is ever opened — see useMissingArtifacts.ts for why
// that ordering is what removes the drawer's deleted-row flash.

import { useArtifactSelector } from '../state/ArtifactContext';
import { useMissingArtifacts } from './useMissingArtifacts';

export function useArtifactCount(activeSessionId: string | null, projectRoot?: string): number {
  // WHY a narrow selector (perf, 2026-09-23): the badge redraws only when the
  // active session's file list changes. The `?? []` stays OUTSIDE the selector —
  // a fresh array inside it would read as a change on every dispatch.
  const selected = useArtifactSelector((s) => (activeSessionId ? s.sessionArtifacts?.[activeSessionId] : undefined));
  const sessionArtifacts = selected ?? [];

  const liveIds = sessionArtifacts.filter((a) => a.status !== 'deleted').map((a) => a.id);
  // Re-checking when the drawer OPENS used to live here; it now lives in the
  // drawer itself (one refreshMissingArtifacts call), so this badge no longer
  // needs to know the drawer's state at all.
  const { missingIds } = useMissingArtifacts(projectRoot ?? null, liveIds);

  return sessionArtifacts.filter((a) => a.status !== 'deleted' && !missingIds.has(a.id)).length;
}
