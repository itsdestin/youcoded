// "Open it" in the refused-quit prompt (Task 6 fix round 11): opens the file of a parked draft
// in this window's file viewer, where the editor restores the draft (draft-store). The app
// registers how (it owns the session switch and the drawer); the stash only asks.
import { useEffect, useRef } from 'react';
import type { Dispatch } from 'react';
import type { ArtifactRecord } from '../../shared/artifacts/types';
import type { ArtifactAction } from './artifact-actions';

export interface ParkedDraftTarget { sessionId: string; artifact: ArtifactRecord }
let opener: ((t: ParkedDraftTarget) => void) | null = null;

export function openParkedDraft(t: ParkedDraftTarget): void {
  opener?.(t);
}

/** App: open a parked draft's file in its session's drawer (switching to that session). A draft
 *  parked in Project View (no session of its own) opens in the session on screen; if that
 *  session's folder differs, the draft simply stays parked (settleDraft never drops it). */
export function useParkedDraftOpener(dispatch: Dispatch<ArtifactAction>, select: (id: string) => void, current: string | null): void {
  const latest = useRef({ dispatch, select, current });
  latest.current = { dispatch, select, current };
  useEffect(() => {
    opener = ({ sessionId, artifact }) => {
      const l = latest.current;
      const sid = sessionId === 'project-view' ? l.current : sessionId;
      if (!sid) return;
      if (sid !== l.current) l.select(sid);
      l.dispatch({ type: 'DRAWER_OPENED', sessionId: sid });
      l.dispatch({ type: 'SESSION_ARTIFACT_UPSERTED', sessionId: sid, artifact });
      l.dispatch({ type: 'ACTIVE_ARTIFACT_SET', sessionId: sid, artifactId: artifact.id });
    };
    return () => { opener = null; };
  }, []);
}
