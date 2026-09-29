// "Open it" in the refused-quit prompt (Task 6 fix rounds 11–12): opens the file of a parked
// draft where its editor restores the draft (draft-store; both hosts use the same draft key).
//
// Two routes, chosen by where the draft can come back:
//   · its chat session is live in THIS window and works in the draft's folder → that session's
//     file drawer (switching to the session);
//   · otherwise — a draft parked in Project View, a session that has ended or lives in another
//     window, or one whose folder is not the draft's → Project View → Files for the draft's own
//     folder. A dead session id is never selected.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Dispatch } from 'react';
import type { ArtifactRecord } from '../../shared/artifacts/types';
import { canonicalize } from '../../shared/artifacts/canonicalize';
import type { ArtifactAction } from './artifact-actions';

export interface ParkedDraftTarget { sessionId: string; artifact: ArtifactRecord; projectRoot: string }
let opener: ((t: ParkedDraftTarget) => void) | null = null;

export function openParkedDraft(t: ParkedDraftTarget): void {
  opener?.(t);
}

// ── Project View route: which folder to open on, and which file (read once) ──
let projectRequest: { projectPath: string; artifact: ArtifactRecord } | null = null;
const requestListeners = new Set<() => void>();
function setProjectRequest(r: typeof projectRequest): void { projectRequest = r; requestListeners.forEach((l) => l()); }
/** ProjectView / FilesTab: the pending "open this draft's file" request, if any. */
export function useProjectViewRequest(): typeof projectRequest {
  return useSyncExternalStore((l) => { requestListeners.add(l); return () => { requestListeners.delete(l); }; }, () => projectRequest, () => projectRequest);
}
/** The Files tab showed the file: the request is done. */
export function clearProjectViewRequest(): void { setProjectRequest(null); }

/** Pure routing (tested): the live session to open the draft in, or null for Project View. */
export function routeParkedDraft(t: ParkedDraftTarget, live: ReadonlyArray<{ id: string; cwd?: string }>): string | null {
  if (t.sessionId === 'project-view') return null;
  const s = live.find((x) => x.id === t.sessionId);
  if (!s?.cwd) return null;
  return canonicalize(s.cwd, null) === canonicalize(t.projectRoot, null) ? s.id : null;
}

/** App: registers how "Open it" opens a file (session drawer or Project View). */
export function useParkedDraftOpener(dispatch: Dispatch<ArtifactAction>, select: (id: string) => void, current: string | null, live: ReadonlyArray<{ id: string; cwd?: string }>): void {
  const latest = useRef({ dispatch, select, current, live });
  latest.current = { dispatch, select, current, live };
  useEffect(() => {
    opener = (t) => {
      const l = latest.current;
      const sid = routeParkedDraft(t, l.live);
      if (sid === null) {
        setProjectRequest({ projectPath: t.projectRoot, artifact: t.artifact });
        l.dispatch({ type: 'PROJECT_VIEW_OPENED' });
        return;
      }
      if (sid !== l.current) l.select(sid);
      l.dispatch({ type: 'DRAWER_OPENED', sessionId: sid });
      l.dispatch({ type: 'SESSION_ARTIFACT_UPSERTED', sessionId: sid, artifact: t.artifact });
      l.dispatch({ type: 'ACTIVE_ARTIFACT_SET', sessionId: sid, artifactId: t.artifact.id });
    };
    return () => { opener = null; };
  }, []);
}
