// useOpenFilepath — the ONE resolve-and-open path for "a file mentioned in
// chat". Extracted from FilepathToken (2026-08-25) so the SendUserFile card
// opens files by exactly the same rules as a filepath pill: session list →
// whole project → artifactify. Two copies of this logic would drift; the pill
// and the card must never disagree about whether a click opens something.
// `openFilepath` is the pure core so App.tsx's auto-open (deliverable-auto-open.ts)
// takes the same path without a hook.
//
// Contract: clicking a file in chat ALWAYS opens the artifact viewer, NEVER
// Project View (artifacts rule → UI invariants).
import { useCallback } from 'react';
import { useArtifactOptional } from '../state/ArtifactContext';
import type { ArtifactState } from '../state/artifact-tracker';
import type { ArtifactAction } from '../state/artifact-actions';
import type { ArtifactRecord } from '../../shared/artifacts/types';
import { findBestMatch, buildArtifactifyArgs } from '../components/filepath-match';

export interface OpenFilepathCtx {
  state: ArtifactState;
  dispatch: (action: ArtifactAction) => void;
}

export interface OpenFilepathOptions {
  // Default true = today's exact click behaviour: open the drawer up front so
  // a CLICK gets instant feedback while the lookup runs. Pass false for an
  // auto-open nobody clicked — opening early there buys nothing (nobody is
  // staring at the empty panel waiting) and guarantees a visible window where
  // the viewer is open with nothing selected (SessionDrawer force-opens the
  // file LIST when there's no active selection, so the user sees a list
  // instead of their file). In that mode the drawer opens only once a match
  // is found, right before it's shown; a total miss dispatches nothing at
  // all — the user didn't ask for this, so a silent no-op beats a panel
  // popping open onto an error about a file they never clicked.
  drawerOpensImmediately?: boolean;
}

export async function openFilepath(
  ctx: OpenFilepathCtx,
  sessionId: string,
  path: string,
  options?: OpenFilepathOptions
): Promise<void> {
  const { state, dispatch } = ctx;
  const drawerOpensImmediately = options?.drawerOpensImmediately ?? true;
  const name = path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path;

  // Open the drawer first so there's an immediate response regardless of how
  // the lookup below resolves. If resolution fails, set a pill-error note —
  // otherwise the drawer's generic "no files yet" empty state would directly
  // contradict the file the user just clicked. Skipped entirely in deferred
  // mode — see OpenFilepathOptions above.
  if (drawerOpensImmediately) {
    dispatch({ type: 'DRAWER_OPENED', sessionId });
    dispatch({ type: 'PILL_ERROR_CLEARED', sessionId });
  }
  const failed = () => {
    if (!drawerOpensImmediately) return; // deferred mode: silent no-op, nothing was ever shown
    dispatch({
      type: 'PILL_RESOLVE_FAILED',
      sessionId,
      message: `Couldn’t open ${name} — the file wasn’t found in this project.`,
    });
  };

  // 1. Already in this session's live list? Select it. findBestMatch prefers
  //    an exact path match over the suffix-tolerant fallback so a same-named
  //    file elsewhere can't shadow it.
  //    WHY cwd is passed to every findBestMatch below: with the session's
  //    folder known, an absolute tapped path is matched only as a full
  //    absolute path, so a same-named file in another folder can never be
  //    opened in its place (the wrong-CLAUDE.md bug, 2026-09-11).
  const cwd = state.sessionCwd?.[sessionId];
  const sessMatch = findBestMatch(state.sessionArtifacts[sessionId] ?? [], path, cwd);
  if (sessMatch) {
    if (!drawerOpensImmediately) dispatch({ type: 'DRAWER_OPENED', sessionId });
    dispatch({ type: 'ACTIVE_ARTIFACT_SET', sessionId, artifactId: sessMatch.id });
    return;
  }

  // 2. Not in this session — resolve against the WHOLE project: every tracked
  //    artifact (any session, including deleted) plus on-disk files, and
  //    inject the match into the session list so the drawer can show it.
  if (!cwd) { failed(); return; } // nothing to resolve without a root — say so
  try {
    // Ask the cheap question first: listProject reads the sidecar (already in
    // memory / a fast IPC round trip) and is checked BEFORE the expensive
    // listAllFiles disk walk. findBestMatch always PREFERS the tracked match
    // over the on-disk one, so firing both in parallel (the old code) paid
    // for a full-project scan on every open even when the sidecar already had
    // the answer — measured at ~4s on a large workspace. Sequential costs one
    // extra round trip only on a miss, which is the uncommon case.
    const projRes = await (window.claude as any).artifacts.listProject(cwd);
    const trackedList: ArtifactRecord[] = projRes?.ok ? (projRes.artifacts ?? []) : [];
    let projMatch: ArtifactRecord | undefined = findBestMatch(trackedList, path, cwd);
    // WHY (deferred mode only): an auto-open must never select an EPHEMERAL
    // record. listAllFiles (project-file-discovery.ts) returns a DISCOVERED
    // record whose `id` is a relative path, not a persisted sidecar ULID. In
    // deferred/auto-open mode, LIST_PROJECT racing a queued APPEND_VERSION
    // means the file can be real but not yet in the sidecar — so a discovered
    // match here is exactly the case where a concurrent whole-session refresh
    // (artifact-tool-use-tracker's debounced listSession -> replaces the
    // session artifact list wholesale) wipes that id out from under the
    // selection a moment later, leaving nothing for ACTIVE_ARTIFACT_SET to
    // find and force-opening the file list instead of the file
    // (SessionDrawer.tsx: `showList = !active`). A synchronous click never
    // races that refresh, so only click mode may still fall back to the disk
    // scan; deferred mode instead falls through to artifactify below, which
    // PERSISTS a real sidecar record before selecting it.
    // This narrows what deferred mode can open: a path buildArtifactifyArgs
    // can't turn into artifactify args — notably a `~/` path, which it
    // returns null for (see the `!args` check below) — used to be resolvable
    // via the listAllFiles suffix match this branch now skips, and silently
    // opens nothing instead. That's the right trade (a silent no-op is
    // deferred mode's documented contract above; restoring the disk-scan
    // fallback here reintroduces the force-open-list race this comment
    // exists to prevent) but it is a real behavior loss, not a free one —
    // don't "restore" the fallback without re-solving the race it reopens.
    if (!projMatch && drawerOpensImmediately) {
      const filesRes = await (window.claude as any).artifacts.listAllFiles(cwd);
      const filesList: ArtifactRecord[] = filesRes?.ok ? (filesRes.files ?? []) : [];
      projMatch = findBestMatch(filesList, path, cwd);
    }
    if (projMatch) {
      if (!drawerOpensImmediately) dispatch({ type: 'DRAWER_OPENED', sessionId });
      dispatch({ type: 'SESSION_ARTIFACT_UPSERTED', sessionId, artifact: projMatch });
      dispatch({ type: 'ACTIVE_ARTIFACT_SET', sessionId, artifactId: projMatch.id });
      return;
    }

    // 3. Nothing matched anywhere — ARTIFACTIFY the path. A file visible in
    //    chat must open no matter how it was created or where it lives.
    //    appendVersion records it (author 'user', type 'read'); this is the
    //    only path that PERSISTS a brand-new artifact.
    const args = buildArtifactifyArgs(path, cwd);
    if (!args) { failed(); return; } // e.g. a ~/ path the renderer can't expand
    await (window.claude as any).artifacts.appendVersion(cwd, sessionId, args);
    const refreshed = await (window.claude as any).artifacts.listSession(sessionId, cwd);
    let selected = false;
    if (refreshed?.ok && Array.isArray(refreshed.artifacts)) {
      const added = findBestMatch(refreshed.artifacts as ArtifactRecord[], path, cwd);
      if (added) {
        // Deferred mode: hold SESSION_ARTIFACTS_LOADED back too — dispatching
        // it without a match still reveals the panel via the drawer's list
        // state, the exact half-open window this option exists to avoid.
        if (!drawerOpensImmediately) dispatch({ type: 'DRAWER_OPENED', sessionId });
        dispatch({ type: 'SESSION_ARTIFACTS_LOADED', sessionId, artifacts: refreshed.artifacts });
        dispatch({ type: 'ACTIVE_ARTIFACT_SET', sessionId, artifactId: added.id });
        selected = true;
      } else if (drawerOpensImmediately) {
        dispatch({ type: 'SESSION_ARTIFACTS_LOADED', sessionId, artifacts: refreshed.artifacts });
      }
    }
    if (!selected) failed();
  } catch { failed(); }
}

export function useOpenFilepath(sessionId: string): (path: string) => Promise<void> {
  // Optional: the buddy window / sandbox render without ArtifactProvider. The
  // caller still renders its pill/card; the click is a no-op there.
  const artifactCtx = useArtifactOptional();
  return useCallback(async (path: string) => {
    if (!artifactCtx) return;
    await openFilepath(artifactCtx, sessionId, path);
  }, [artifactCtx, sessionId]);
}
